// `relayrace init`: set a repository up for the kit. It only ADDS what is
// missing and never overwrites a file that exists; for one that does exist it
// prints what it would have added, so the owner can merge the useful parts.
//
//   .ai/project.json        what relay.mjs / jules-relay.mjs need to know (+ the profile)
//   .ai/prompts/review.md   the independent-review prompt every reviewer reads
//   AGENTS.md               a starting point when the repo has none (review it!)
//   CLAUDE.md, GEMINI.md    one-line pointers to AGENTS.md
//   .claude/agents, .claude/skills, scripts/   the profile's roles, skills and runner
//   opencode.json           PRINTED ONLY: rules qwen.mjs requires before --auto:
//                           only read-only git and the exact --check commands
//   .gitignore              .ai/runs/ and .ai/qwen-tasks/ (local relay state)
//
// and, when the machine has an Agent Desk configured, registers the repo there.
// It prints the Antigravity read rule a headless review needs instead of
// writing it: that is a permission change the owner makes.
//
//   relayrace init [repo] [--profile generic|web-app|notes] [--name N] [--dry-run] [--verbose]
//        [--check "pnpm test"]... [--jules owner/name:branch] [--claude-model sonnet]
//        [--desk-path <main checkout>]   (when <repo> is a worktree)
//        [--qwen-allow "npx tsc --noEmit -p ."]...   (extra exact command for Qwen)
//   relayrace init --update [repo] [--apply]   compare an installed repo with the kit;
//        --apply writes only missing files and ones never edited since install
//
// Dependency-free: Node 18+ built-ins only.

import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describeAdditions, renderAdditions } from './lib/additions.mjs';
import { loadConfig } from './lib/config.mjs';
import { PROFILE_NAMES, PROFILES, profileFiles, renderAgents } from './lib/profiles.mjs';
import { loadProject, validateProject } from './relay.mjs';
import { appendInside, writeNewInside } from './lib/safe-fs.mjs';
import { opencodeConfig, validateCommands } from './lib/guardrails.mjs';
import { applyUpdate, formatPlan, kitVersion, planUpdate, recordInstalled } from './lib/update.mjs';
import { isMain } from './lib/is-main.mjs';
export { opencodeConfig, QWEN_GIT_READS } from './lib/guardrails.mjs';

const KIT_DIR = dirname(fileURLToPath(import.meta.url));
const IGNORED = ['.ai/runs/', '.ai/qwen-tasks/'];
// Files whose content an agent must never read; the agy deny list is built from them.
const SECRET_PATTERNS = [/^\.env(\..+)?$/, /^\.dev\.vars(\..+)?$/, /\.(pem|key)$/, /secrets?.*[.]env$/i];

export function parseArgs(argv) {
  const opts = { repo: undefined, profile: 'generic', name: undefined, checks: [], qwenAllow: [], jules: undefined,
    claudeModel: undefined, deskPath: undefined, dryRun: false, verbose: false, update: false, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--name') opts.name = value();
    else if (arg === '--profile') {
      opts.profile = value();
      if (!PROFILE_NAMES.includes(opts.profile)) throw new Error(`unknown profile "${opts.profile}" (choose ${PROFILE_NAMES.join(', ')})`);
      opts.profileGiven = opts.profile;
    } else if (arg === '--check') opts.checks.push(value());
    // An extra exact command only the local model may run (e.g. its tsc check).
    else if (arg === '--qwen-allow') opts.qwenAllow.push(value());
    else if (arg === '--claude-model') opts.claudeModel = value();
    // Installing from a worktree: Agent Desk should still list the main checkout.
    else if (arg === '--desk-path') opts.deskPath = value();
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--update') opts.update = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--jules') {
      const match = value().match(/^([\w.-]+\/[\w.-]+):([\w./-]+)$/);
      if (!match) throw new Error('--jules takes owner/name:branch');
      opts.jules = { repo: match[1], branch: match[2] };
    } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else if (opts.repo) throw new Error('only one repository per run');
    else opts.repo = arg;
  }
  if (opts.apply && !opts.update) throw new Error('--apply only goes with --update');
  opts.repo ||= '.';
  return opts;
}

/** A first AGENTS.md: the repo's own scripts, and the gaps its owner must fill. Pure given the kit. */
export function agentsTemplate(name, scripts, profile = 'generic', kitDir = KIT_DIR) {
  return renderAgents(kitDir, PROFILES[profile].template, name, scripts);
}

// Folders that hold generated or third-party files, never the repository's own secrets.
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.astro', '.wrangler', '.turbo', 'coverage', '.cache']);

/**
 * Secret files under the repo, for the agy deny rules. Links are not followed. The scan stops after
 * `maxEntries` entries and says so (`result.truncated`), because a deny list that silently misses
 * a deep .env is worse than one that admits it is incomplete.
 */
export function secretFiles(root, { maxDepth = 8, maxEntries = 50000 } = {}) {
  const found = [];
  let seen = 0;
  let truncated = false;
  const scan = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      if (++seen > maxEntries) { truncated = true; return; }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (depth > 0) scan(path, depth - 1); }
      else if (entry.isFile() && SECRET_PATTERNS.some(p => p.test(entry.name)) && !/\.example$/.test(entry.name)) found.push(path);
    }
  };
  scan(root, maxDepth);
  const result = found.sort();
  result.truncated = truncated;
  return result;
}

/** The agy settings rule for a path: no drive letter, forward slashes. Pure. */
export function agyPath(path) {
  return resolve(path).replace(/^[A-Za-z]:/, '').replaceAll('\\', '/');
}

export function install(opts, { log = console.log, agentDeskConfig, kitDir = KIT_DIR } = {}) {
  const root = resolve(opts.repo || '.');
  if (!existsSync(join(root, '.git'))) throw new Error(`${root} is not a git checkout. Run git init there if the folder is new, then retry relayrace init.`);
  const profileName = opts.profile || 'generic';
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`unknown profile "${profileName}" (choose ${PROFILE_NAMES.join(', ')})`);
  opts = { checks: [], qwenAllow: [], ...opts };
  for (const key of ['repo', 'name', 'deskPath', 'claudeModel']) {
    if (opts[key] !== undefined && (typeof opts[key] !== 'string' || !opts[key].trim() || /[\x00-\x1f]/.test(opts[key]))) throw new Error(`${key} must be a nonempty string without control characters.`);
  }
  for (const key of ['dryRun', 'verbose']) {
    if (opts[key] !== undefined && typeof opts[key] !== 'boolean') throw new Error(`${key} must be boolean.`);
  }
  validateCommands(opts.qwenAllow, '--qwen-allow');
  const dryRun = Boolean(opts.dryRun);
  const name = opts.name || basename(root);
  const pkg = existsSync(join(root, 'package.json')) ? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) : {};
  if (opts.update) {
    // Compare with the kit; replace only what was never edited since install.
    const declared = existsSync(join(root, '.ai/project.json')) ? JSON.parse(readFileSync(join(root, '.ai/project.json'), 'utf8')) : {};
    const plan = planUpdate(root, { kitDir, profile: declared.profile || opts.profileGiven, name: declared.name || name, scripts: pkg.scripts });
    const apply = Boolean(opts.apply) && !dryRun;
    const applied = apply ? applyUpdate(plan, { kit: kitVersion(kitDir) }) : [];
    for (const line of formatPlan(plan, { applied })) log(line);
    if (dryRun) log('\nDry run: nothing was written.');
    return { root, profile: plan.profile, update: true, plan, applied, dryRun };
  }
  const project = { name, profile: profileName, rules: ['AGENTS.md'], checks: opts.checks,
    ...(opts.qwenAllow.length ? { qwenAllow: opts.qwenAllow } : {}),
    ...(opts.claudeModel !== undefined ? { claudeModel: opts.claudeModel } : {}), ...(opts.jules !== undefined ? { jules: opts.jules } : {}) };
  validateProject(project, root);
  const effective = existsSync(join(root, '.ai/project.json')) ? loadProject(root) : project;
  const proposed = `${JSON.stringify(opencodeConfig([...effective.checks, ...(effective.qwenAllow ?? [])]), null, 2)}\n`;
  const files = profileFiles(profileName, { kitDir, name, scripts: pkg.scripts });
  const deskConfig = agentDeskConfig && existsSync(agentDeskConfig) ? JSON.parse(readFileSync(agentDeskConfig, 'utf8')) : undefined;
  if (deskConfig !== undefined && (!deskConfig || typeof deskConfig !== 'object' || Array.isArray(deskConfig) ||
      (deskConfig.projects !== undefined && (!Array.isArray(deskConfig.projects) || deskConfig.projects.some(p => !p || typeof p.path !== 'string' || !p.path.trim()))))) {
    throw new Error('Agent Desk config needs a projects array with nonempty paths.');
  }
  const added = [];
  const kept = [];
  const baseline = {};
  const kindOf = new Map(files.map(file => [file.path, file.kind]));
  const mode = (path, status) => log(`${status.padEnd(8)} ${path}`);

  const add = (relative, content) => {
    const path = join(root, relative);
    if (existsSync(path)) {
      const description = describeAdditions(relative, readFileSync(path, 'utf8'), content);
      kept.push({ path: relative, ...description });
      if (description.status === 'identical' && ['prompt', 'agent', 'skill', 'script'].includes(kindOf.get(relative))) baseline[relative] = content;
      if (description.status === 'identical') return mode(`${relative} (already as the ${profileName} profile has it)`, 'kept');
      if (description.status === 'differs') return mode(`${relative} (exists and differs; not touched)`, 'kept');
      const count = (description.sections?.length ?? 0) + (description.lines?.length ?? 0);
      mode(`${relative} (exists; would add ${description.sections ? `${count} section${count === 1 ? '' : 's'}` : `${count} line${count === 1 ? '' : 's'}`})`, 'kept');
      for (const line of renderAdditions(description, { verbose: opts.verbose })) log(`           ${line}`);
      return undefined;
    }
    added.push(relative);
    if (['prompt', 'agent', 'skill', 'script'].includes(kindOf.get(relative))) baseline[relative] = content;
    // Inside the repository only, never through a link, and never over a file that appeared meanwhile.
    if (!dryRun) writeNewInside(root, path, content);
    return mode(relative, dryRun ? 'would add' : 'added');
  };

  add('.ai/project.json', `${JSON.stringify(project, null, 2)}\n`);
  for (const file of files) add(file.path, file.content);
  if (profile.opencode) {
    log(`Proposed opencode.json for ${join(root, 'opencode.json')}: review and apply it manually. The user saves or merges it; init never writes permission rules.`);
    log(proposed);
  }

  if (profile.opencode) {
    const gitignore = join(root, '.gitignore');
    const ignored = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
    const missing = IGNORED.filter(line => !ignored.split(/\r?\n/).includes(line));
    if (missing.length) {
      if (!dryRun) appendInside(root, gitignore, `${ignored && !ignored.endsWith('\n') ? '\n' : ''}\n# Local relay state and Qwen tasks (Relayrace)\n${missing.join('\n')}\n`);
      added.push('.gitignore');
      mode(`.gitignore (+ ${missing.join(', ')})`, dryRun ? 'would add' : 'updated');
    }
  }

  if (!agentDeskConfig) {
    log('skipped  Agent Desk registration (not configured; set RELAYKIT_AGENT_DESK or "agentDesk" in the Relayrace config file)');
  } else if (!existsSync(agentDeskConfig)) {
    log(`skipped  Agent Desk registration (${agentDeskConfig} not found)`);
  } else {
    const config = deskConfig;
    config.projects ||= [];
    const deskPath = resolve(opts.deskPath || root);
    if (!config.projects.some(p => resolve(p.path).toLowerCase() === deskPath.toLowerCase())) {
      if (!dryRun) {
        if (!existsSync(`${agentDeskConfig}.bak-relaykit`)) copyFileSync(agentDeskConfig, `${agentDeskConfig}.bak-relaykit`);
        config.projects.push({ name, path: deskPath });
        writeFileSync(agentDeskConfig, `${JSON.stringify(config, null, 2)}\n`);
      }
      mode(`${name} in Agent Desk${dryRun ? '' : ' (restart it to show)'}`, dryRun ? 'would add' : 'added');
    } else log('kept     Agent Desk entry (exists)');
  }

  const secrets = secretFiles(root);
  log('\nFor a headless Antigravity review of a checkout, add to ~/.gemini/antigravity-cli/settings.json:');
  log(`  allow: "read_file(${agyPath(root)})"`);
  if (secrets.length) for (const s of secrets) log(`  deny:  "read_file(${agyPath(s)})"`);
  else log('  (no secret files found; re-check before allowing a checkout that gets one)');
  if (secrets.truncated) log('  ! The scan stopped early on a very large checkout: look for secret files yourself before allowing it.');
  if (!dryRun && Object.keys(baseline).length) recordInstalled(root, baseline, kitVersion(kitDir));
  if (opts.jules) log(`\nJules: connect ${opts.jules.repo} at https://jules.google.com and set its environment (Node, install, checks) before the first task.`);
  if (dryRun) log('\nDry run: nothing was written.');
  return { root, profile: profileName, added, kept, secrets, dryRun };
}

if (isMain(import.meta.url)) {
  try {
    install(parseArgs(process.argv.slice(2)), { agentDeskConfig: loadConfig().values.agentDesk });
  } catch (error) {
    console.error(`init: ${error.message}`);
    process.exitCode = 2;
  }
}
