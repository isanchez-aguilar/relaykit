import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VERSIONS, matrixVersions, parseCiArgs, parseSummary, runCiLocal } from './ci-local.mjs';

const tap = (pass, fail = 0, skipped = 0) => `# tests ${pass + fail + skipped}\n# pass ${pass}\n# fail ${fail}\n# cancelled 0\n# skipped ${skipped}\n`;

function harness({ docker = true, results = {} } = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'docker' && args[0] === 'version') return docker ? { status: 0, stdout: '27.0' } : { status: 1, stdout: '', error: new Error('spawn docker ENOENT') };
    if (command === 'docker') return results[args.find(arg => arg.startsWith('node:'))] ?? { status: 0, stdout: tap(10) };
    return results.local ?? { status: 0, stdout: tap(10) };
  };
  const lines = [];
  return { calls, lines, run, log: line => lines.push(line) };
}

test('the TAP summary is read for pass, fail and skipped', () => {
  assert.deepEqual(parseSummary(tap(7, 2, 1)), { tests: 10, pass: 7, fail: 2, skipped: 1 });
  assert.deepEqual(parseSummary('nothing here'), { tests: null, pass: null, fail: null, skipped: null });
});

test('versions come from the workflow matrix, else the defaults', () => {
  assert.deepEqual(matrixVersions('/r', { read: () => '        node: [20, 22]\n' }), [20, 22]);
  assert.deepEqual(matrixVersions('/r', { read: () => '' }), DEFAULT_VERSIONS);
  assert.deepEqual(matrixVersions('/r', { read: () => 'node: [latest]' }), DEFAULT_VERSIONS);
});

test('without a workflow matrix the package engines decide, so a Node 22 package is not run on 18', () => {
  const files = { '.github/workflows/test.yml': '', 'package.json': '{ "engines": { "node": ">=22" } }' };
  const read = file => Object.entries(files).find(([name]) => file.replaceAll(String.fromCharCode(92), '/').endsWith(name))?.[1] ?? '';
  assert.deepEqual(matrixVersions('/r', { read }), [22]);
  files['package.json'] = '{ "engines": { "node": ">=18" } }';
  assert.deepEqual(matrixVersions('/r', { read }), [18, 22]);
  files['package.json'] = '{}';
  assert.deepEqual(matrixVersions('/r', { read }), DEFAULT_VERSIONS);
});

test('arguments are checked', () => {
  assert.deepEqual(parseCiArgs([]), { docker: undefined, versions: undefined, json: false, hook: undefined, checks: true });
  assert.deepEqual(parseCiArgs(['--no-docker', '--node', '18,22']), { docker: false, versions: [18, 22], json: false, hook: undefined, checks: true });
  assert.equal(parseCiArgs(['--docker']).docker, true);
  assert.equal(parseCiArgs(['--no-checks']).checks, false);
  assert.throws(() => parseCiArgs(['--node', 'abc']), /major versions/);
  assert.throws(() => parseCiArgs(['--node', '4']), /major versions/);
  assert.throws(() => parseCiArgs(['--deploy']), /unknown argument --deploy/);
});

test('it runs here and then once per Node version in a read-only container', () => {
  const h = harness();
  const outcome = runCiLocal({ docker: true, versions: [18, 22] }, { cwd: '/repo', run: h.run, log: h.log, node: 'node-bin' });
  assert.equal(outcome.code, 0);
  assert.deepEqual(h.calls[0].slice(0, 2), ['node-bin', '--test']);
  const containers = h.calls.filter(call => call[0] === 'docker' && call[1] === 'run');
  assert.equal(containers.length, 2);
  for (const call of containers) {
    assert.ok(call.includes('--rm'));
    assert.ok(call.some(arg => /:\/src:ro$/.test(arg)), 'the repo is mounted read-only');
  }
  assert.deepEqual(containers.map(call => call.find(arg => arg.startsWith('node:'))), ['node:18', 'node:22']);
  assert.match(h.lines.join('\n'), /All 3 runs passed/);
});

test('a failing run makes the exit code 1 and is named', () => {
  const h = harness({ results: { 'node:18': { status: 1, stdout: tap(5, 2) } } });
  const outcome = runCiLocal({ docker: true, versions: [18, 22] }, { cwd: '/repo', run: h.run, log: h.log, node: 'n' });
  assert.equal(outcome.code, 1);
  assert.match(h.lines.join('\n'), /FAIL linux node 18/);
  assert.match(h.lines.join('\n'), /1 of 3 runs failed/);
});

test('without Docker only the local run happens and the summary says so; macOS is never claimed', () => {
  const h = harness({ docker: false });
  const outcome = runCiLocal({ docker: true, versions: [18, 22] }, { cwd: '/repo', run: h.run, log: h.log, node: 'n' });
  assert.equal(outcome.code, 0);
  assert.equal(h.calls.filter(call => call[1] === 'run').length, 0);
  const text = h.lines.join('\n');
  assert.match(text, /Docker is not running or not installed/);
  assert.match(text, /macOS: cannot run on this machine; not verified/);
});

test('--no-docker never touches Docker', () => {
  const h = harness();
  runCiLocal({ docker: false, versions: [18] }, { cwd: '/repo', run: h.run, log: h.log, node: 'n' });
  assert.equal(h.calls.some(call => call[0] === 'docker'), false);
});

test('a suite that exits 0 but reports failures still fails', () => {
  const h = harness({ results: { local: { status: 0, stdout: tap(3, 1) } } });
  assert.equal(runCiLocal({ docker: false, versions: [18] }, { cwd: '/repo', run: h.run, log: h.log, node: 'n' }).code, 1);
});

import { resolve } from 'node:path';
import { cleanGitEnv, REPOSITORY_VARIABLES } from './git-env.mjs';
import { HOOK_MARKER, containerScript, detectPackageManager, hookScript, loadChecks, manageHook } from './ci-local.mjs';

const HOOK = resolve('/repo/.git/hooks/pre-push');

function hookHarness({ existing } = {}) {
  const files = new Map(existing === undefined ? [] : [[HOOK, existing]]);
  const lines = [];
  return {
    files, lines,
    options: {
      cwd: '/repo', node: 'C:\Program Files\nodejs\node.exe', cli: 'C:\Users\ana\ai-kit\bin\relayrace.mjs',
      run: () => ({ status: 0, stdout: HOOK + '\n' }),
      exists: file => files.has(file),
      read: file => files.get(file),
      write: (file, text) => files.set(file, text),
      remove: file => files.delete(file),
      chmod: () => {},
      log: line => lines.push(line),
    },
  };
}

test('the hook script is a plain sh exec with forward slashes and quoted paths', () => {
  const bs = String.fromCharCode(92);
  const node = ['C:', 'Program Files', 'nodejs', 'node.exe'].join(bs);
  const cli = ['C:', 'Users', "O'Neil", 'ai-kit', 'bin', 'relayrace.mjs'].join(bs);
  const script = hookScript({ node, cli });
  assert.ok(script.startsWith('#!' + '/bin/sh' + String.fromCharCode(10)));
  assert.ok(script.includes(HOOK_MARKER));
  const quoted = "'C:/Users/O'" + bs + "''Neil/ai-kit/bin/relayrace.mjs'";
  assert.ok(script.includes("exec 'C:/Program Files/nodejs/node.exe' " + quoted + ' ci-local'));
});

test('installing writes the hook, and doing it again just updates our own', () => {
  const h = hookHarness();
  assert.equal(manageHook('install', h.options), 0);
  assert.ok(h.files.get(HOOK).includes(HOOK_MARKER));
  assert.match(h.lines[0], /^installed /);
  manageHook('install', h.options);
  assert.match(h.lines.at(-2), /^updated /);
});

test('a hook the owner wrote is never overwritten or removed', () => {
  const h = hookHarness({ existing: '#!/bin/sh\necho mine\n' });
  assert.throws(() => manageHook('install', h.options), /not generated by Relayrace/);
  assert.throws(() => manageHook('remove', h.options), /not generated by Relayrace/);
  assert.equal(h.files.get(HOOK), '#!/bin/sh\necho mine\n');
});

test('remove deletes our hook and is quiet when there is none', () => {
  const h = hookHarness({ existing: `#!/bin/sh\n${HOOK_MARKER}\nexec x\n` });
  assert.equal(manageHook('remove', h.options), 0);
  assert.equal(h.files.has(HOOK), false);
  assert.equal(manageHook('remove', h.options), 0);
  assert.match(h.lines.at(-1), /no pre-push hook/);
});

test('outside a git checkout the hook is refused', () => {
  const h = hookHarness();
  h.options.run = () => ({ status: 128, stdout: '' });
  assert.throws(() => manageHook('install', h.options), /not a git checkout/);
});

test('hook flags parse', () => {
  assert.equal(parseCiArgs(['--install-hook']).hook, 'install');
  assert.equal(parseCiArgs(['--remove-hook']).hook, 'remove');
});

test('the repository variables git exports to hooks are stripped before anything runs git', () => {
  const env = { PATH: '/bin', GIT_TERMINAL_PROMPT: '0', ...Object.fromEntries(REPOSITORY_VARIABLES.map(name => [name, 'x'])) };
  const clean = cleanGitEnv(env);
  for (const name of REPOSITORY_VARIABLES) assert.equal(name in clean, false, name);
  assert.equal(clean.PATH, '/bin');
  assert.equal(clean.GIT_TERMINAL_PROMPT, '0', 'unrelated GIT_ variables are kept');
  assert.equal('GIT_DIR' in env, true, 'the input is not modified');
});

test('ci-local runs the suite without the hook repository variables and the hook unsets them', () => {
  let seen;
  const run = (command, args, options) => { if (!seen) seen = options; return { status: 0, stdout: tap(1) }; };
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = '/decoy/.git';
  try { runCiLocal({ docker: false, versions: [18] }, { cwd: '/repo', run, log: () => {}, node: 'n' }); } finally {
    if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous;
  }
  assert.equal('GIT_DIR' in seen.env, false);
  const script = hookScript({ node: 'n', cli: 'c' });
  assert.ok(script.includes('unset GIT_DIR GIT_WORK_TREE'));
  assert.ok(script.indexOf('unset ') < script.indexOf('exec '));
});

test('checks come from .ai/project.json and must be plain commands', () => {
  const read = text => () => text;
  assert.deepEqual(loadChecks('/r', { read: read('{"checks":["pnpm check","pnpm test"]}') }), ['pnpm check', 'pnpm test']);
  assert.deepEqual(loadChecks('/r', { read: read('') }), []);
  assert.deepEqual(loadChecks('/r', { read: read('{}') }), []);
  assert.throws(() => loadChecks('/r', { read: read('{"checks":["pnpm test && curl x"]}') }), /plain commands/);
  assert.throws(() => loadChecks('/r', { read: read('{ nope') }), /not valid JSON/);
});

test('the package manager comes from the lockfile', () => {
  const has = name => ({ exists: file => file.endsWith(name) });
  assert.equal(detectPackageManager('/r', has('pnpm-lock.yaml')), 'pnpm');
  assert.equal(detectPackageManager('/r', has('package-lock.json')), 'npm');
  assert.equal(detectPackageManager('/r', has('nothing')), null);
});

test('the container script copies without .git and node_modules, installs, then runs the commands', () => {
  const script = containerScript(['pnpm check', 'pnpm test'], { packageManager: 'pnpm' });
  assert.ok(script.includes('--exclude=./.git --exclude=./node_modules'));
  assert.ok(script.includes('corepack enable && pnpm install --frozen-lockfile && pnpm check && pnpm test'));
  assert.ok(containerScript(['node --test']).endsWith('git init -q . && node --test'));
  assert.ok(containerScript(['x'], { packageManager: 'npm' }).includes('npm ci && x'));
});

function checksHarness({ failing } = {}) {
  const execCalls = [], runCalls = [], lines = [];
  const files = { 'project.json': '{"checks":["pnpm check","pnpm test"]}' };
  return {
    execCalls, runCalls, lines,
    deps: {
      cwd: '/repo', node: 'n', log: line => lines.push(line),
      read: file => (file.includes('project.json') ? files['project.json'] : ''),
      exists: file => file.endsWith('pnpm-lock.yaml'),
      exec: (program, args) => { execCalls.push([program, ...args]); return { status: failing === args.join(' ') ? 1 : 0, stdout: '' }; },
      run: (command, args) => { runCalls.push([command, ...args]); return command === 'docker' && args[0] === 'version' ? { status: 0, stdout: '27' } : { status: 0, stdout: tap(1) }; },
    },
  };
}

test('with checks in project.json each one runs here and Docker stays off unless asked', () => {
  const h = checksHarness();
  const outcome = runCiLocal(parseCiArgs([]), h.deps);
  assert.equal(outcome.code, 0);
  assert.deepEqual(h.execCalls, [['pnpm', 'check'], ['pnpm', 'test']]);
  assert.equal(h.runCalls.some(call => call[0] === 'docker'), false);
  assert.ok(h.lines.join('\n').includes('checks run on this machine'));
});

test('a failing check fails the run and is named', () => {
  const h = checksHarness({ failing: 'test' });
  const outcome = runCiLocal(parseCiArgs([]), h.deps);
  assert.equal(outcome.code, 1);
  assert.ok(h.lines.join('\n').includes('FAIL check: pnpm test'));
});

test('--docker runs the checks in a container that installs with the repo package manager', () => {
  const h = checksHarness();
  const outcome = runCiLocal({ ...parseCiArgs(['--docker']), versions: [22] }, h.deps);
  assert.equal(outcome.code, 0);
  const container = h.runCalls.find(call => call[0] === 'docker' && call[1] === 'run');
  assert.ok(container.includes('node:22'));
  assert.ok(container.at(-1).includes('corepack enable && pnpm install --frozen-lockfile && pnpm check && pnpm test'));
});

test('--no-checks ignores project.json and runs node --test as before', () => {
  const h = checksHarness();
  runCiLocal(parseCiArgs(['--no-checks', '--no-docker']), h.deps);
  assert.equal(h.execCalls.length, 0);
  assert.deepEqual(h.runCalls[0].slice(0, 2), ['n', '--test']);
});
