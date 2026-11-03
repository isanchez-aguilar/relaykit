import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runUpdate } from './self-update.mjs';
import { cleanGitEnv } from './git-env.mjs';

function harness({ dirty = '', changed = false, root = resolve('kit'), fail } = {}) {
  const calls = [], lines = [];
  let heads = 0;
  return { calls, lines, options: { kitDir: resolve('kit'), exists: () => true, realpath: value => value, log: line => lines.push(line), run: (exe, args) => {
    calls.push([exe, args]);
    assert.equal(args[1], resolve('kit'));
    const command = args.slice(2).join(' ');
    if (fail === command) return { status: 1, stdout: 'never print raw git output' };
    return { status: 0, stdout: command === 'rev-parse --show-toplevel' ? root : command.startsWith('status') ? dirty : command === 'rev-parse HEAD' ? (changed && heads++ ? 'new' : 'old') : '' };
  } } };
}

test('update refuses non-checkouts, nested checkouts and tracked or untracked local changes', () => {
  assert.throws(() => runUpdate([], { kitDir: '/kit', exists: () => false }), /not a git checkout/);
  for (const settings of [{ root: resolve('parent') }, { dirty: ' M README.md' }, { dirty: '?? new.mjs' }]) {
    const h = harness(settings);
    assert.throws(() => runUpdate([], h.options), /not the root|local changes/);
    assert.equal(h.calls.some(([, args]) => args.includes('pull')), false);
  }
});

test('update uses ff-only in its own checkout and reports changed or unchanged HEAD', () => {
  for (const changed of [true, false]) {
    const h = harness({ changed });
    assert.equal(runUpdate([], h.options), 0);
    assert.ok(h.calls.some(([, args]) => args.slice(2).join(' ') === 'pull --ff-only'));
    assert.match(h.lines[0], changed ? /updated.*relayrace sync/ : /already up to date/);
  }
  const failed = harness({ fail: 'pull --ff-only' });
  assert.throws(() => runUpdate([], failed.options), /git pull failed/);
  assert.throws(() => runUpdate(['--force'], failed.options), /usage/);
});

test('update refuses actual untracked and staged files before attempting a pull', t => {
  const kitDir = mkdtempSync(join(tmpdir(), 'relaykit-update-'));
  t.after(() => rmSync(kitDir, { recursive: true, force: true }));
  const env = { ...cleanGitEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(kitDir, 'absent.config') };
  const init = spawnSync('git', ['init', '--quiet', kitDir], { env, encoding: 'utf8', timeout: 45000 });
  if (init.error?.code === 'ENOENT') { t.skip('Git is unavailable'); return; }
  assert.equal(init.status, 0, init.stderr);
  const run = (exe, args, options) => {
    assert.equal(args.includes('pull'), false, 'a dirty checkout must never attempt a pull');
    return spawnSync(exe, args, { ...options, env, timeout: 45000 });
  };
  writeFileSync(join(kitDir, 'local.txt'), 'Uncommitted local work.\n');
  assert.throws(() => runUpdate([], { kitDir, run }), /local changes/);
  const stage = spawnSync('git', ['-C', kitDir, 'add', 'local.txt'], { env, encoding: 'utf8', timeout: 45000 });
  assert.equal(stage.status, 0, stage.stderr);
  assert.throws(() => runUpdate([], { kitDir, run }), /local changes/);
});

test('update refuses a detached HEAD instead of pulling', () => {
  const calls = [];
  const options = { kitDir: resolve('kit'), exists: () => true, realpath: value => value, log: () => {}, run: (exe, args) => {
    calls.push(args.slice(2).join(' '));
    const verb = args[2];
    if (verb === 'rev-parse' && args[3] === '--show-toplevel') return { status: 0, stdout: resolve('kit') };
    if (verb === 'status') return { status: 0, stdout: '' };
    if (verb === 'symbolic-ref') return { status: 1, stdout: '' };
    return { status: 0, stdout: 'abc' };
  } };
  assert.throws(() => runUpdate([], options), /detached HEAD/);
  assert.equal(calls.some(call => call.startsWith('pull')), false);
});

test('update never lets git ask for credentials and bounds how long it waits', () => {
  const seen = [];
  const options = { kitDir: resolve('kit'), exists: () => true, realpath: value => value, log: () => {}, run: (exe, args, opts) => {
    seen.push(opts);
    const verb = args[2];
    if (verb === 'rev-parse' && args[3] === '--show-toplevel') return { status: 0, stdout: resolve('kit') };
    return { status: 0, stdout: verb === 'status' ? '' : 'abc' };
  } };
  runUpdate([], options);
  assert.ok(seen.length > 3);
  for (const opts of seen) {
    assert.equal(opts.env.GIT_TERMINAL_PROMPT, '0');
    assert.ok(opts.timeout > 0);
  }
});
