// `relayrace ci-local`: the repo's test suite the way CI runs it, on this machine.
//
// GitHub Actions may be unavailable (billing, an outage, a private repo
// without minutes), and nothing else tells you a change still passes on Linux
// or on the oldest supported Node. This runs `node --test`
//   1. here, with the Node that is running this command, and
//   2. in a throwaway Linux container per Node version (Docker, when it is up),
//      on a copy of the working tree without .git, so it cannot touch the repo.
//
// It never publishes, installs or writes inside the repo. macOS cannot be run
// here; the summary says so instead of implying it passed.
//
// Dependency-free: Node 18+ built-ins only.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { launch } from './exe.mjs';
import { cleanGitEnv, REPOSITORY_VARIABLES } from './git-env.mjs';
import { validateCommands } from './guardrails.mjs';

export const DEFAULT_VERSIONS = [18, 22];

/** `# pass 12` style counters from the TAP summary of `node --test`. Pure. */
export function parseSummary(output) {
  const grab = name => {
    const match = String(output).match(new RegExp(`^# ${name} (\\d+)`, 'm'));
    return match ? Number(match[1]) : null;
  };
  return { tests: grab('tests'), pass: grab('pass'), fail: grab('fail'), skipped: grab('skipped') };
}

/**
 * The Node versions to test: the workflow matrix when there is one, else what the
 * package's engines.node asks for (>=22 means 22 and up, so only 22), else the
 * defaults. Pure given `read`.
 */
export function matrixVersions(cwd, { read = file => (existsSync(file) ? readFileSync(file, 'utf8') : '') } = {}) {
  const text = read(join(cwd, '.github', 'workflows', 'test.yml'));
  const match = text.match(/^\s*node:\s*\[([^\]]+)\]/m);
  const versions = match ? match[1].split(',').map(item => Number(item.trim())).filter(Number.isInteger) : [];
  if (versions.length) return versions;
  const engines = read(join(cwd, 'package.json')).match(/"node"\s*:\s*"[^"\d]*(\d+)/);
  if (engines) {
    const major = Number(engines[1]);
    return [...new Set([major, ...DEFAULT_VERSIONS.filter(version => version > major)])];
  }
  return DEFAULT_VERSIONS;
}

export function parseCiArgs(args) {
  // docker: undefined = the mode decides (on for node --test, off for repo checks), true/false = explicit.
  const options = { docker: undefined, versions: undefined, json: false, hook: undefined, checks: true };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--no-docker') options.docker = false;
    else if (arg === '--docker') options.docker = true;
    else if (arg === '--no-checks') options.checks = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--install-hook') options.hook = 'install';
    else if (arg === '--remove-hook') options.hook = 'remove';
    else if (arg === '--node') {
      const value = args[++index];
      const versions = String(value ?? '').split(',').map(item => Number(item.trim()));
      if (!versions.length || versions.some(item => !Number.isInteger(item) || item < 16 || item > 99)) throw new Error('--node takes a list of major versions, for example 18,22');
      options.versions = versions;
    } else throw new Error(`unknown argument ${arg} (usage: ci-local [--docker | --no-docker] [--no-checks] [--node 18,22] [--install-hook | --remove-hook])`);
  }
  return options;
}

/** The checks .ai/project.json asks CI to run (plain commands only), or []. Pure given `read`. */
export function loadChecks(cwd, { read = file => (existsSync(file) ? readFileSync(file, 'utf8') : '') } = {}) {
  const text = read(join(cwd, '.ai', 'project.json'));
  if (!text) return [];
  let project;
  try { project = JSON.parse(text); } catch { throw new Error('.ai/project.json is not valid JSON'); }
  const checks = Array.isArray(project?.checks) ? project.checks : [];
  validateCommands(checks, '.ai/project.json: checks');
  return checks;
}

/** pnpm or npm when the repo has that lockfile (a container has no node_modules), else null. */
export function detectPackageManager(cwd, { exists = existsSync } = {}) {
  if (exists(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(join(cwd, 'package-lock.json'))) return 'npm';
  return null;
}

/** The sh script a throwaway container runs on a read-only copy of the repo, without .git and node_modules. Pure. */
export function containerScript(commands, { packageManager = null } = {}) {
  const copy = '(cd /src && tar cf - --exclude=./.git --exclude=./node_modules .) | (mkdir /work && cd /work && tar xf -)';
  const prepare = packageManager === 'pnpm' ? 'corepack enable && pnpm install --frozen-lockfile' : packageManager === 'npm' ? 'npm ci' : '';
  return [copy, 'cd /work', 'git init -q .', prepare, ...commands].filter(Boolean).join(' && ');
}

/** Split a check into program and arguments, honouring single and double quotes (no escapes). Pure. */
export function splitCommand(command) {
  const words = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) quote = null; else current += character;
    } else if (character === '"' || character === "'") { quote = character; started = true; }
    else if (character === ' ') {
      if (started) { words.push(current); current = ''; started = false; }
    } else { current += character; started = true; }
  }
  if (quote) throw new Error('unbalanced quote in check: ' + command);
  if (started) words.push(current);
  return words;
}

export function runCiLocal(options, { cwd = process.cwd(), run = spawnSync, exec = launch, log = console.log, node = process.execPath, platform = process.platform, read, exists } = {}) {
  const root = resolve(cwd);
  const checks = options.checks === false ? [] : loadChecks(root, read ? { read } : undefined);
  const checksMode = checks.length > 0;
  const wantDocker = options.docker === undefined ? !checksMode : options.docker;
  const versions = options.versions ?? matrixVersions(root, read ? { read } : undefined);
  const rows = [];

  const record = (label, result) => {
    const summary = parseSummary(`${result.stdout || ''}\n${result.stderr || ''}`);
    const ran = result.status !== null && result.status !== undefined && !result.error;
    const ok = ran && result.status === 0 && (summary.fail === 0 || summary.fail === null);
    rows.push({ label, ok, ran, status: result.status ?? null, ...summary, note: result.error ? String(result.error.message || result.error) : undefined });
  };

  log(`ci-local in ${root}`);
  log(`  local: node ${process.version} on ${platform}`);
  const localEnv = { cwd: root, env: cleanGitEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true };
  if (checksMode) {
    log(`  checks from .ai/project.json: ${checks.join(', ')}`);
    for (const check of checks) {
      const [program, ...args] = splitCommand(check);
      record(`check: ${check} (this machine)`, exec(program, args, localEnv));
    }
  } else record(`${platform} node ${String(process.version).replace(/^v/, '')} (this machine)`, run(node, ['--test'], localEnv));

  let dockerNote;
  if (!wantDocker) dockerNote = options.docker === false ? 'skipped (--no-docker)' : 'skipped (checks run on this machine; add --docker for Linux containers)';
  else {
    const probe = run('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (probe.error || probe.status !== 0) dockerNote = 'skipped (Docker is not running or not installed)';
  }
  if (!dockerNote) {
    for (const version of versions) {
      log(`  linux: node ${version} in a container`);
      const script = containerScript(checksMode ? checks : ['node --test'], { packageManager: checksMode ? detectPackageManager(root, exists ? { exists } : undefined) : null });
      record(`linux node ${version} (Docker${checksMode ? ', checks' : ''})`, run('docker', ['run', '--rm', '-v', `${root}:/src:ro`, `node:${version}`, 'sh', '-c', script],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }));
    }
  }

  const failed = rows.filter(row => !row.ok);
  const lines = ['', 'Result'];
  for (const row of rows) {
    const counts = row.pass === null ? (row.ran ? `exit ${row.status}` : 'did not run') : `${row.pass} pass, ${row.fail} fail, ${row.skipped ?? 0} skipped`;
    lines.push(`  ${row.ok ? 'ok  ' : 'FAIL'} ${row.label.padEnd(40)} ${counts}${row.note ? `  (${row.note})` : ''}`);
  }
  if (dockerNote) lines.push(`  --   Linux containers: ${dockerNote}`);
  lines.push('  --   macOS: cannot run on this machine; not verified');
  lines.push(failed.length ? `\n${failed.length} of ${rows.length} runs failed.` : `\nAll ${rows.length} runs passed.`);
  for (const line of lines) log(line);
  return { code: failed.length ? 1 : 0, rows, dockerNote };
}

// ---- the pre-push hook: run this on every push without anyone asking ----------

export const HOOK_MARKER = '# Generated by Relaykit ci-local';

const shQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const forward = value => String(value).replaceAll('\\', '/');

/** The hook body. Git for Windows runs hooks with sh, so paths use forward slashes. Pure. */
export function hookScript({ node, cli }) {
  return [
    '#!/bin/sh',
    HOOK_MARKER,
    '# Runs the suite like CI (this machine, then Linux containers) before a push.',
    '# Remove with: relayrace ci-local --remove-hook',
    '# Git exports GIT_DIR and friends to hooks; a suite that runs git elsewhere must not inherit them.',
    `unset ${REPOSITORY_VARIABLES.join(' ')}`,
    `exec ${shQuote(forward(node))} ${shQuote(forward(cli))} ci-local`,
    '',
  ].join('\n');
}

function hookPath(cwd, run) {
  const result = run('git', ['rev-parse', '--git-path', 'hooks/pre-push'], { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('this folder is not a git checkout');
  return resolve(cwd, String(result.stdout).trim());
}

/**
 * Install (or remove) the pre-push hook. Never overwrites a hook that was not
 * generated here, and never installs where git has no hooks directory.
 */
export function manageHook(action, { cwd = process.cwd(), node = process.execPath, cli, run = spawnSync, log = console.log,
  exists = existsSync, read = file => readFileSync(file, 'utf8'), write = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); },
  remove = unlinkSync, chmod = chmodSync } = {}) {
  const path = hookPath(cwd, run);
  const present = exists(path);
  const ours = present && read(path).includes(HOOK_MARKER);
  if (action === 'remove') {
    if (!present) { log(`no pre-push hook at ${path}`); return 0; }
    if (!ours) throw new Error(`${path} was not generated by Relayrace; not removing it`);
    remove(path);
    log(`removed ${path}`);
    return 0;
  }
  if (present && !ours) throw new Error(`${path} already exists and was not generated by Relayrace; add 'relayrace ci-local' to it by hand`);
  write(path, hookScript({ node, cli }));
  try { chmod(path, 0o755); } catch { /* not meaningful on Windows */ }
  log(`${ours ? 'updated' : 'installed'} ${path}`);
  log('Every git push in this repo now runs relayrace ci-local first and stops if it fails.');
  return 0;
}
