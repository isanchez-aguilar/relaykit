// `relayrace doctor`: what is installed on this machine and in this repo, and
// what looks logged in. It only runs cheap, read-only commands (`--version`,
// `auth status`, a model listing) and never anything that spends model quota
// or sends a prompt. Only a parsed version token is reported, never the raw
// output line, identity, token or session title.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32, posix } from 'node:path';
import { readSetting } from './config.mjs';
import { findExecutable, runTool } from './exe.mjs';
import { PROFILE_NAMES, PROFILES, profileFiles } from './profiles.mjs';
import { sync } from '../sync.mjs';
import { loadProviders } from './providers.mjs';
import { planUpdate, summarize } from './update.mjs';

export const API_KEY_VARIABLES = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

/** Report command discovery and the executable running this invocation. */
export function launcherState({ platform = process.platform, env = process.env, exists = existsSync, node = process.execPath } = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  const names = platform === 'win32' ? ['relayrace.cmd', 'relayrace.exe', 'relayrace.ps1', 'relaykit.cmd', 'relaykit.exe', 'relaykit.ps1'] : ['relayrace', 'relaykit'];
  for (const directory of path.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const name of names) {
      const file = paths.join(directory.replace(/^"|"$/g, ''), name);
      if (exists(file)) return { found: true, path: file, node };
    }
  }
  return { found: false, path: null, node };
}

export const versionToken = text => String(text).match(/(?:^|\s)(v?\d+\.\d+(?:\.\d+)?)(?=\s|$|[-+])/m)?.[1] ?? '';

export function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '[invalid URL]';
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href;
  } catch { return '[invalid URL]'; }
}

export const sanitizeUrls = text => String(text).replace(/https?:\/\/[^\s<>"']+/gi, safeUrl);
function sanitized(value) {
  if (typeof value === 'string') return sanitizeUrls(value);
  if (Array.isArray(value)) return value.map(sanitized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitized(item)]));
  return value;
}

/**
 * Each tool: how to read its version, and the cheapest read-only way to tell
 * whether it is logged in (`login` returns 'yes' | 'no' | 'unknown').
 */
export const TOOLS = [
  { name: 'claude', login: { args: ['auth', 'status'], judge: r => {
    try { return JSON.parse(r.stdout).loggedIn === true ? 'yes' : 'no'; } catch { return 'unknown'; }
  } } },
  { name: 'codex', login: { args: ['login', 'status'], judge: r => (r.status === 0 ? 'yes' : 'no') } },
  // agy has no auth-status command; its model listing needs a session, and costs no quota.
  { name: 'agy', login: { args: ['models'], note: 'inferred from the model list', judge: r => (r.status === 0 && r.stdout.trim() ? 'yes' : 'no') } },
  { name: 'jules', login: { args: ['remote', 'list', '--session'], judge: r => (r.status === 0 ? 'yes' : 'no') } },
  { name: 'opencode', login: null, noLogin: 'no login needed, local provider' },
  { name: 'gh', login: { args: ['auth', 'status'], judge: r => (r.status === 0 ? 'yes' : 'no') } },
  { name: 'git', login: null, noLogin: 'no login needed' },
  { name: 'node', login: null, noLogin: 'no login needed' },
];

const OVERRIDES = { claude: 'CLAUDE', agy: 'AGY', codex: 'CODEX' };

/** One tool's state: on PATH (or its installer location), version, and login. */
export function checkTool(tool, { run, platform = process.platform, env = process.env, home = homedir(), exists } = {}) {
  const variable = OVERRIDES[tool.name];
  const override = variable ? readSetting(env, `RELAYRACE_${variable}_EXE`)?.value : undefined;
  const exe = findExecutable(tool.name, override, { env, platform, home, ...(exists ? { exists } : {}) });
  const options = { run, platform, env };
  const version = runTool(exe, ['--version'], options);
  if (version.status !== 0) return { name: tool.name, found: false, version: '', login: 'n/a', detail: 'not found on PATH' };
  const result = { name: tool.name, found: true, version: versionToken(version.stdout), login: 'n/a', detail: tool.noLogin ?? '' };
  if (tool.login) {
    const probe = runTool(exe, tool.login.args, options);
    result.login = probe.timedOut ? 'unknown' : tool.login.judge(probe);
    result.detail = probe.timedOut ? 'login check timed out'
      : result.login === 'yes' ? (tool.login.note ?? 'looks logged in')
        : result.login === 'no' ? 'not logged in (or offline)' : 'could not tell';
  }
  return result;
}

/** Git identity is configured (the values are never read out). */
export function gitIdentity({ run, platform = process.platform } = {}) {
  const has = key => runTool('git', ['config', '--get', key], { run, platform }).stdout.trim().length > 0;
  return has('user.name') && has('user.email');
}

/** The local model's health endpoint. */
export async function checkLocalModel(url, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    const body = response.ok ? await response.text() : '';
    const ok = (() => { try { return JSON.parse(body)?.status === 'ok'; } catch { return false; } })();
    return { url: safeUrl(url), ok, detail: ok ? 'healthy' : `answered but not ready (HTTP ${response.status})` };
  } catch {
    return { url: safeUrl(url), ok: false, detail: 'not reachable (optional: Qwen is never required)' };
  }
}

/** Drift of the global files `sync` owns; never writes. */
export function checkSyncDrift({ home = homedir(), codexHome, kitDir, contractFile, agentDeskConfig, cwd } = {}) {
  try {
    const coverage = [];
    const drift = sync({ check: true, home, codexHome, kitDir, contractFile, agentDeskConfig, cwd, log: line => { if (/coverage|Codex/.test(line)) coverage.push(line); } });
    return { ok: drift.length === 0, drift, coverage, error: undefined };
  } catch (error) {
    return { ok: false, drift: [], error: error.message };
  }
}

/** What `init --update` would do here, as counts; undefined when the repo is not installed. */
function updateState(root, { kitDir, declared }) {
  if (!declared) return undefined;
  try {
    let scripts = {};
    try { scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {}; } catch { /* no package.json */ }
    return summarize(planUpdate(root, { kitDir, profile: declared, scripts }));
  } catch { return undefined; }
}

/** How much of each profile the repo at `root` has, judged by which files exist. */
export function repoState(root, { kitDir, exists = existsSync, read = path => readFileSync(path, 'utf8') } = {}) {
  if (!exists(join(root, '.git'))) return { isRepo: false, root };
  let declared;
  try { declared = JSON.parse(read(join(root, '.ai/project.json'))).profile; } catch { declared = undefined; }
  const profiles = {};
  for (const name of PROFILE_NAMES) {
    const wanted = ['.ai/project.json', ...profileFiles(name, { kitDir, name: 'x', scripts: {} }).map(f => f.path)];
    const missing = wanted.filter(path => !exists(join(root, path)));
    profiles[name] = { total: wanted.length, missing };
  }
  const score = name => (profiles[name].total - profiles[name].missing.length) / profiles[name].total;
  const ranked = [...PROFILE_NAMES].sort((a, b) => score(b) - score(a));
  const closest = PROFILES[declared] ? declared : ranked[0];
  return {
    isRepo: true, root, declared: PROFILES[declared] ? declared : undefined, closest, profiles,
    installed: exists(join(root, '.ai/project.json')),
    // The Qwen guardrails are applied manually, reported rather than required.
    opencode: exists(join(root, 'opencode.json')),
    complete: profiles[closest].missing.length === 0,
    update: updateState(root, { kitDir, declared: PROFILES[declared] ? declared : undefined }),
  };
}

/** Everything doctor looks at. Pure given its injected effects, so tests stub the commands. */
export async function runDoctor({ cwd = process.cwd(), config, kitDir, home = homedir(), env = process.env, platform = process.platform,
  run, fetchImpl, exists } = {}) {
  const tools = TOOLS.map(tool => checkTool(tool, { run, platform, env, home, exists }));
  const git = tools.find(t => t.name === 'git');
  if (git.found) git.detail = gitIdentity({ run, platform }) ? 'identity configured' : 'no user.name/user.email configured';
  const node = tools.find(t => t.name === 'node');
  const major = Number.parseInt(String(process.version).slice(1), 10);
  node.version = process.version;
  node.found = true;
  node.detail = major >= 18 ? 'ok, 18+ required' : 'too old: Relayrace needs Node 18+';
  const warnings = [];
  const keys = API_KEY_VARIABLES.filter(name => env[name]);
  if (keys.length) warnings.push(`${keys.join(', ')} set: the relay refuses to run with API keys; use subscription logins`);
  for (const note of config.notes ?? []) warnings.push(note);
  let providers;
  try {
    const loaded = loadProviders({ cwd, env, platform, home });
    if (loaded.note) warnings.push(loaded.note);
    providers = { source: loaded.source, file: loaded.file, order: loaded.providers.map(p => ({ id: p.id, enabled: p.enabled, family: p.family })) };
  } catch (error) { providers = { error: error.message }; warnings.push(`providers file: ${error.message}`); }
  return sanitized({
    providers,
    config: { file: config.file, found: config.found, sources: config.sources, agentDesk: config.values.agentDesk, notes: config.values.notes },
    tools,
    launcher: launcherState({ env, platform, ...(exists ? { exists } : {}) }),
    localModel: await checkLocalModel(config.values.qwenHealthUrl, fetchImpl),
    sync: checkSyncDrift({ home, codexHome: config.values.codexHome, kitDir, contractFile: config.values.contract, agentDeskConfig: config.values.agentDesk, cwd }),
    repo: repoState(cwd, { kitDir, ...(exists ? { exists } : {}) }),
    warnings,
    critical: !git.found || major < 18,
  });
}

const mark = ok => (ok ? 'ok     ' : 'MISSING');

/** The report as plain lines. */
export function formatDoctor(report) {
  const lines = ['Relayrace doctor', ''];
  lines.push('Config');
  lines.push(`  file          ${report.config.file} (${report.config.found ? 'found' : 'not found; defaults and environment only'})`);
  lines.push(`  Agent Desk    ${report.config.agentDesk ? `${report.config.agentDesk} [${report.config.sources.agentDesk}]` : 'not configured (repo registration is skipped)'}`);
  lines.push(`  notes         ${report.config.notes ? `${report.config.notes} [${report.config.sources.notes}]` : 'not configured'}`);
  if (report.launcher) {
    lines.push('', 'Launcher');
    lines.push(`  ${mark(report.launcher.found)} ${report.launcher.path || 'relayrace is not on PATH; run the setup script'}`);
    lines.push(`  Node in use   ${report.launcher.node}`);
  }
  lines.push('', 'Providers (relayrace providers)');
  if (report.providers?.error) lines.push(`  invalid  ${report.providers.error}`);
  else if (report.providers) {
    lines.push(`  source        ${report.providers.source === 'default' ? 'built-in default order' : `${report.providers.source}: ${report.providers.file}`}`);
    lines.push(`  order         ${report.providers.order.map(p => (p.enabled ? p.id : `(${p.id})`)).join(' > ')}`);
  }
  lines.push('', 'Tools');
  for (const tool of report.tools) {
    const login = tool.login === 'n/a' ? '' : `  login: ${tool.login}`;
    lines.push(`  ${mark(tool.found)} ${tool.name.padEnd(9)} ${(tool.version || '-').padEnd(34)}${login}${tool.detail ? `  (${tool.detail})` : ''}`);
  }
  lines.push('', 'Local model');
  lines.push(`  ${report.localModel.ok ? 'ok     ' : 'down   '} ${report.localModel.url}  (${report.localModel.detail})`);
  lines.push('', 'Global files (relayrace sync --check)');
  if (report.sync.error) lines.push(`  cannot check: ${report.sync.error}`);
  else if (report.sync.ok) lines.push('  ok      up to date');
  else {
    lines.push(`  drift   ${report.sync.drift.length} file${report.sync.drift.length === 1 ? '' : 's'} out of date; run \`relayrace sync\` to write them`);
    for (const path of report.sync.drift.slice(0, 5)) lines.push(`            ${path}`);
    if (report.sync.drift.length > 5) lines.push(`            … and ${report.sync.drift.length - 5} more`);
  }
  for (const message of report.sync.coverage ?? []) lines.push(`  ${message}`);
  lines.push('', 'This repository');
  const repo = report.repo;
  if (!repo.isRepo) lines.push(`  ${repo.root} is not a git checkout`);
  else if (!repo.installed && repo.profiles[repo.closest].missing.length === repo.profiles[repo.closest].total) {
    lines.push('  not installed; run `relayrace init --profile <generic|web-app|notes>`');
  } else {
    const profile = repo.profiles[repo.closest];
    lines.push(`  profile ${repo.declared ? repo.declared : `${repo.closest} (guessed; .ai/project.json names none)`}: ${profile.total - profile.missing.length}/${profile.total} files present`);
    if (profile.missing.length) {
      for (const path of profile.missing.slice(0, 8)) lines.push(`    missing  ${path}`);
      if (profile.missing.length > 8) lines.push(`    … and ${profile.missing.length - 8} more`);
      lines.push('  run `relayrace init --dry-run` to see what it would add (it never overwrites)');
    }
  }
  const update = report.repo.update;
  if (update) {
    if (!update.tracked && update.modified) lines.push(`  updates: ${update.modified} file${update.modified === 1 ? '' : 's'} differ from the kit and there is no install baseline; \`relayrace init --update\` lists them`);
    else if (update.updatable || update.missing) lines.push(`  updates: ${update.updatable} safe to update, ${update.missing} missing; run \`relayrace init --update --apply\``);
    else if (update.modified) lines.push(`  updates: ${update.modified} edited by you; \`relayrace init --update\` shows how they differ`);
    else lines.push('  updates: up to date with the kit');
  }
  if (report.repo.isRepo && report.repo.installed) {
    lines.push(`  opencode.json (local model guardrails, optional): ${report.repo.opencode ? 'present; Qwen validates it before running' : 'absent; review the `relayrace init` proposal and apply it manually to enable Qwen'}`);
  }
  if (report.warnings.length) {
    lines.push('', 'Warnings');
    for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  }
  return lines.map(sanitizeUrls);
}
