import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../install.mjs';
import { TOOLS, checkLocalModel, checkSyncDrift, checkTool, formatDoctor, gitIdentity, launcherState, repoState, runDoctor } from './doctor.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('doctor finds the launcher on injected Windows or POSIX PATH and reports its running Node', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const file = platform === 'win32' ? 'C:\\bin\\relaykit.cmd' : '/bin/relaykit';
    const env = { Path: platform === 'win32' ? 'C:\\missing;C:\\bin' : '/missing:/bin' };
    assert.deepEqual(launcherState({ platform, env, node: '/absolute/node', exists: candidate => candidate === file }), { found: true, path: file, node: '/absolute/node' });
    assert.equal(launcherState({ platform, env, exists: () => false }).found, false);
  }
});

/** A fake spawnSync: `table` maps "exe args" prefixes to results; anything else is "not found". */
function fakeRun(table, calls = []) {
  return (exe, args) => {
    const line = `${exe} ${args.join(' ')}`.trim();
    calls.push(line);
    const hit = Object.entries(table).find(([prefix]) => line.startsWith(prefix));
    return hit ? { status: 0, stdout: '', ...hit[1] } : { status: null, stdout: '', error: { code: 'ENOENT' } };
  };
}

const allTools = {
  'claude --version': { stdout: '2.1.0 (Claude Code)\n' },
  'claude auth status': { stdout: JSON.stringify({ loggedIn: true, email: 'secret@example.com' }) },
  'codex --version': { stdout: 'codex-cli 0.1\n' },
  'codex login status': { stdout: 'Logged in using ChatGPT\n' },
  'agy --version': { stdout: '1.0\n' },
  'agy models': { stdout: 'gemini-x\tGemini X\n' },
  'jules --version': { stdout: 'jules 1\n' },
  'jules remote list --session': { stdout: 'a private session title' },
  'opencode --version': { stdout: '1.18\n' },
  'gh --version': { stdout: 'gh version 2\n' },
  'gh auth status': { stdout: 'Token: gho_SECRETSECRET' },
  'git --version': { stdout: 'git version 2\n' },
  'git config --get user.name': { stdout: 'Someone\n' },
  'git config --get user.email': { stdout: 'someone@example.com\n' },
  'node --version': { stdout: 'v22\n' },
};

const opts = run => ({ run, platform: 'linux', env: {}, home: '/h', exists: () => false });

test('a tool is found by its --version and judged logged in by one cheap status command', () => {
  const calls = [];
  const run = fakeRun(allTools, calls);
  const claude = checkTool(TOOLS.find(t => t.name === 'claude'), opts(run));
  assert.deepEqual([claude.found, claude.version, claude.login], [true, '2.1.0', 'yes']);
  assert.equal(checkTool(TOOLS.find(t => t.name === 'codex'), opts(run)).login, 'yes');
  assert.equal(checkTool(TOOLS.find(t => t.name === 'agy'), opts(run)).detail, 'inferred from the model list');
  assert.equal(checkTool(TOOLS.find(t => t.name === 'opencode'), opts(run)).login, 'n/a');
  // Only status/listing commands ever ran: nothing that sends a prompt.
  for (const call of calls) assert.doesNotMatch(call, /\s(-p|--print|exec|run|review)(\s|$)/, call);
});

test('missing tools, logged-out tools and slow checks are reported without throwing', () => {
  const run = fakeRun({ 'codex --version': { stdout: 'c\n' }, 'codex login status': { status: 1 }, 'jules --version': { stdout: 'j\n' }, 'jules remote': { status: null, error: { code: 'ETIMEDOUT' } },
    'claude --version': { stdout: 'v\n' }, 'claude auth status': { stdout: 'not json' } });
  assert.deepEqual(checkTool(TOOLS.find(t => t.name === 'agy'), opts(run)), { name: 'agy', found: false, version: '', login: 'n/a', detail: 'not found on PATH' });
  const codex = checkTool(TOOLS.find(t => t.name === 'codex'), opts(run));
  assert.deepEqual([codex.login, codex.detail], ['no', 'not logged in (or offline)']);
  assert.equal(checkTool(TOOLS.find(t => t.name === 'jules'), opts(run)).login, 'unknown');
  assert.equal(checkTool(TOOLS.find(t => t.name === 'claude'), opts(run)).login, 'unknown');
});

test('an override variable (new or old spelling) points at the executable', () => {
  const calls = [];
  const run = fakeRun({ '/custom/codex --version': { stdout: 'x\n' } }, calls);
  const codex = TOOLS.find(t => t.name === 'codex');
  assert.equal(checkTool(codex, { ...opts(run), env: { RELAYKIT_CODEX_EXE: '/custom/codex' } }).found, true);
  assert.equal(checkTool(codex, { ...opts(run), env: { AI_KIT_CODEX_EXE: '/custom/codex' } }).found, true);
});

test('git identity only says whether it is set, never what it is', () => {
  assert.equal(gitIdentity({ run: fakeRun(allTools), platform: 'linux' }), true);
  assert.equal(gitIdentity({ run: fakeRun({ 'git config --get user.name': { stdout: 'x\n' } }), platform: 'linux' }), false);
});

test('the local model is healthy only when it answers {"status":"ok"}', async () => {
  const answer = (body, status = 200) => async () => new Response(body, { status });
  assert.equal((await checkLocalModel('http://m/health', answer('{"status":"ok"}'))).ok, true);
  assert.match((await checkLocalModel('http://m/health', answer('{"status":"loading"}'))).detail, /not ready \(HTTP 200\)/);
  assert.match((await checkLocalModel('http://m/health', answer('', 503))).detail, /HTTP 503/);
  const down = await checkLocalModel('http://m/health', async () => { throw new Error('refused'); });
  assert.deepEqual([down.ok, down.detail], [false, 'not reachable (optional: Qwen is never required)']);
});

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'relaykit-doctor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('sync drift is read-only: a fresh home is out of date, and nothing is written', t => {
  const root = scratch(t);
  const home = join(root, 'home');
  const drift = checkSyncDrift({ home, kitDir: KIT });
  assert.equal(drift.ok, false);
  assert.ok(drift.drift.some(p => p.endsWith('CLAUDE.md')));
  assert.equal(checkSyncDrift({ home, kitDir: KIT, contractFile: join(root, 'missing.md') }).ok, false);
  assert.match(checkSyncDrift({ home, kitDir: KIT, contractFile: join(root, 'missing.md') }).error, /ENOENT/);
  assert.throws(() => mkdirSync(join(home, '.claude'), { recursive: false }), /ENOENT/);
});

test('repo state: not a repo, not installed, and a half-installed profile', t => {
  const root = scratch(t);
  assert.equal(repoState(root, { kitDir: KIT }).isRepo, false);
  mkdirSync(join(root, '.git'));
  const empty = repoState(root, { kitDir: KIT });
  assert.equal(empty.installed, false);
  install({ repo: root, profile: 'web-app', checks: [] }, { log: () => {} });
  const full = repoState(root, { kitDir: KIT });
  assert.deepEqual([full.declared, full.closest, full.complete], ['web-app', 'web-app', true]);
  rmSync(join(root, '.claude/agents/qa.md'));
  const partial = repoState(root, { kitDir: KIT });
  assert.deepEqual(partial.profiles['web-app'].missing, ['.claude/agents/qa.md']);
  assert.equal(partial.complete, false);
});

const config = (extra = {}) => ({
  file: '/h/.config/relaykit/config.json', found: false, notes: [],
  values: { qwenHealthUrl: 'http://127.0.0.1:8080/health', ...extra },
  sources: { agentDesk: 'unset', notes: 'unset' },
});

test('the full report, with every command stubbed, prints no secret and no identity', async t => {
  const root = scratch(t);
  mkdirSync(join(root, '.git'));
  const report = await runDoctor({
    cwd: root, config: config({ agentDesk: '/desk/config.json' }), kitDir: KIT, home: join(root, 'home'),
    env: { OPENAI_API_KEY: 'sk-secret-value' }, platform: 'linux', run: fakeRun(allTools),
    fetchImpl: async () => new Response('{"status":"ok"}'), exists: p => p.endsWith('.git'),
  });
  assert.equal(report.critical, false);
  assert.deepEqual(report.tools.map(x => x.name), ['claude', 'codex', 'agy', 'jules', 'opencode', 'gh', 'git', 'node']);
  assert.ok(report.tools.every(x => x.found));
  assert.equal(report.localModel.ok, true);
  assert.match(report.warnings[0], /^OPENAI_API_KEY set/);
  const text = formatDoctor(report).join('\n');
  assert.match(text, /^Relaykit doctor/);
  assert.match(text, /Launcher\n.*not on PATH/);
  assert.ok(text.includes(`Node in use   ${process.execPath}`));
  assert.match(text, /ok\s+claude\s+2\.1\.0\s+login: yes/);
  assert.match(text, /This repository\n {2}not installed/);
  for (const secret of ['secret@example.com', 'gho_SECRETSECRET', 'a private session title', 'sk-secret-value', 'someone@example.com']) {
    assert.equal(text.includes(secret) || JSON.stringify(report).includes(secret), false, secret);
  }
});

test('doctor is critical only when git is missing', async t => {
  const root = scratch(t);
  const report = await runDoctor({ cwd: root, config: config(), kitDir: KIT, home: root, env: {}, platform: 'linux',
    run: fakeRun({}), fetchImpl: async () => { throw new Error('down'); }, exists: () => false });
  assert.equal(report.critical, true);
  const text = formatDoctor(report).join('\n');
  assert.match(text, /MISSING claude/);
  assert.match(text, /down {4}http:\/\/127\.0\.0\.1:8080\/health/);
  assert.match(text, /is not a git checkout/);
  assert.match(text, /not found; defaults and environment only/);
});

test('legacy-name notes from the config show up as warnings', async t => {
  const root = scratch(t);
  const report = await runDoctor({ cwd: root, config: { ...config(), notes: ['AI_KIT_NOTES still works; rename it to RELAYKIT_*'] }, kitDir: KIT, home: root, env: {},
    platform: 'linux', run: fakeRun(allTools), fetchImpl: async () => new Response('{}'), exists: () => false });
  assert.ok(report.warnings.includes('AI_KIT_NOTES still works; rename it to RELAYKIT_*'));
  writeFileSync(join(root, 'x'), '');
});

test('opencode.json is optional: reported, never counted as missing', t => {
  const root = scratch(t);
  mkdirSync(join(root, '.git'));
  install({ repo: root, profile: 'generic', checks: [], opencode: false }, { log: () => {} });
  const state = repoState(root, { kitDir: KIT });
  assert.deepEqual([state.complete, state.opencode], [true, false]);
  const text = formatDoctor({ config: { file: 'f', found: false, sources: {} }, tools: [], localModel: { ok: false, url: 'u', detail: 'd' },
    sync: { ok: true, drift: [] }, repo: state, warnings: [] }).join('\n');
  assert.match(text, /opencode\.json \(local model guardrails, optional\): absent/);
  assert.match(text, /generic: 14\/14 files present/);
});

test('text and JSON reports omit fake URL secrets and raw version identities everywhere', async t => {
  const root = scratch(t);
  const url = 'https://fake:FAKE_TOKEN@example.test/health?token=FAKE_TOKEN#fake@example.test';
  const report = await runDoctor({ cwd: root, config: { ...config({ qwenHealthUrl: url }), notes: [`endpoint ${url}`] },
    kitDir: KIT, home: root, env: {}, platform: 'linux', exists: () => false,
    run: fakeRun({ ...allTools, 'claude --version': { stdout: 'v2.1.3 fake@example.test FAKE_TOKEN\n' } }),
    fetchImpl: async () => { throw Error('FAKE_TOKEN'); } });
  for (const text of [JSON.stringify(report), formatDoctor(report).join('\n')]) {
    assert.doesNotMatch(text, /FAKE_TOKEN|fake@example\.test|https:\/\/fake:/);
    assert.match(text, /https:\/\/example.test\/health/);
    assert.match(text, /v2\.1\.3/);
  }
});
