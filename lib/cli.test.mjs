import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS, DELEGATES, KIT_DIR, USAGE, main, parseCli } from './cli.mjs';

const config = (extra = {}) => ({ file: 'f', found: false, notes: [], values: { qwenHealthUrl: 'http://x/health', qwenLockName: 'relaykit-qwen', ...extra }, sources: {} });

function run(argv, deps = {}) {
  const out = [];
  const err = [];
  return main(argv, { out: l => out.push(l), err: l => err.push(l), config: config(), ...deps }).then(code => ({ code, out, err }));
}

test('parseCli splits the subcommand from its arguments and knows the help and version spellings', () => {
  assert.deepEqual(parseCli(['init', '.', '--profile', 'web-app']), { command: 'init', args: ['.', '--profile', 'web-app'] });
  assert.deepEqual(parseCli(['sync', '--check']), { command: 'sync', args: ['--check'] });
  for (const word of [[], ['--help'], ['-h'], ['help']]) assert.equal(parseCli(word).command, 'help');
  for (const word of [['--version'], ['-v'], ['version']]) assert.equal(parseCli(word).command, 'version');
  assert.throws(() => parseCli(['deploy']), /unknown command "deploy"/);
  assert.deepEqual(COMMANDS, ['doctor', 'init', 'sync', 'update', 'providers', 'ci-local', 'relay', 'jules', 'qwen']);
});

test('help lists every command, and version is the package version', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  for (const command of COMMANDS) assert.match(USAGE, new RegExp(`^  ${command}`, 'm'));
  assert.match(USAGE, /RELAYKIT_\*/);
  const version = await run(['--version']);
  assert.equal(version.out[0], JSON.parse(readFileSync(join(KIT_DIR, 'package.json'), 'utf8')).version);
});

test('an unknown command is a usage error', async () => {
  const result = await run(['nope']);
  assert.equal(result.code, 2);
  assert.match(result.err[0], /unknown command "nope"/);
});

test('init parses its options, defaults to the current folder, and passes the configured Agent Desk', async () => {
  const calls = [];
  const installer = (opts, deps) => { calls.push([opts, deps]); };
  const first = await run(['init', '--profile', 'web-app', '--check', 'pnpm test'], { installer, config: config({ agentDesk: '/desk.json' }) });
  assert.equal(first.code, 0);
  assert.equal(calls[0][0].repo, '.');
  assert.equal(calls[0][0].profile, 'web-app');
  assert.deepEqual(calls[0][0].checks, ['pnpm test']);
  assert.equal(calls[0][1].agentDeskConfig, '/desk.json');
  await run(['init', '/some/repo', '--dry-run'], { installer });
  assert.equal(calls[1][0].repo, '/some/repo');
  assert.equal(calls[1][0].dryRun, true);
  assert.equal(calls[1][1].agentDeskConfig, undefined);
  const bad = await run(['init', '--profile', 'nope'], { installer });
  assert.equal(bad.code, 2);
  assert.match(bad.err[0], /relaykit init: unknown profile "nope"/);
});

test('sync passes its arguments and returns the drift exit code', async () => {
  const seen = [];
  const syncer = (args, options) => { seen.push([args, options.config.values.agentDesk]); return args.includes('--check') ? 1 : 0; };
  assert.equal((await run(['sync', '--check'], { syncer, config: config({ agentDesk: '/d.json' }) })).code, 1);
  assert.equal((await run(['sync'], { syncer })).code, 0);
  assert.deepEqual(seen, [[['--check'], '/d.json'], [[], undefined]]);
});

test('CLI catches asynchronous sync errors and dispatches update to its checkout', async () => {
  const failed = await run(['sync'], { syncer: async () => { throw new Error('preview failed'); } });
  assert.equal(failed.code, 2);
  assert.deepEqual(failed.err, ['relaykit sync: preview failed']);
  let seen;
  assert.equal((await run(['update'], { kitDir: '/kit', cwd: '/elsewhere', updater: (args, options) => { seen = [args, options.kitDir]; return 0; } })).code, 0);
  assert.deepEqual(seen, [[], '/kit']);
  const help = await run([]);
  assert.ok(help.out[0].indexOf('  doctor') < help.out[0].indexOf('  init'));
  for (const command of ['doctor', 'init', 'sync']) assert.ok(help.out[0].includes(`Example: relaykit ${command}`));
});

test('doctor prints the report (or JSON) and exits 1 only when critical', async () => {
  const report = { critical: false, warnings: [], tools: [], localModel: { ok: false, url: 'u', detail: 'd' }, sync: { ok: true, drift: [] },
    repo: { isRepo: false, root: '/r' }, config: { file: 'f', found: false, sources: {} } };
  const doctor = async () => report;
  const text = await run(['doctor'], { doctor });
  assert.equal(text.code, 0);
  assert.equal(text.out[0], 'Relaykit doctor');
  const json = await run(['doctor', '--json'], { doctor });
  assert.deepEqual(JSON.parse(json.out[0]).localModel, report.localModel);
  assert.equal((await run(['doctor'], { doctor: async () => ({ ...report, critical: true }) })).code, 1);
  assert.equal((await run(['doctor', '--bad'], { doctor })).code, 2);
});

test('relay, jules and qwen run the kit script in the caller folder with the resolved environment', async () => {
  for (const [command, script] of Object.entries(DELEGATES)) {
    const calls = [];
    const spawn = (exe, args, options) => { calls.push([exe, args, options]); return { status: 3 }; };
    const result = await run([command, 'one', '--flag'], { spawn, cwd: '/work', env: { PATH: 'p' }, config: config() });
    assert.equal(result.code, 3);
    const [exe, args, options] = calls[0];
    assert.equal(exe, process.execPath);
    assert.deepEqual(args, [join(KIT_DIR, script), 'one', '--flag']);
    assert.equal(options.cwd, '/work');
    assert.equal(options.stdio, 'inherit');
    assert.equal(options.env.RELAYKIT_QWEN_URL, 'http://x/health');
    assert.equal(options.env.PATH, 'p');
  }
  const failed = await run(['qwen'], { spawn: () => ({ error: new Error('spawn failed') }) });
  assert.equal(failed.code, 2);
  assert.match(failed.err[0], /relaykit qwen: spawn failed/);
});

test('notes about legacy configuration are printed once, except by doctor which lists them itself', async () => {
  const withNotes = { ...config(), notes: ['reading the old config x'] };
  const installer = () => {};
  const result = await run(['init'], { installer, config: withNotes });
  assert.deepEqual(result.err, ['relaykit: note: reading the old config x']);
  const doctor = await run(['doctor'], { doctor: async () => ({ critical: false, warnings: [], tools: [], localModel: { ok: true, url: 'u', detail: 'd' }, sync: { ok: true, drift: [] }, repo: { isRepo: false, root: '/r' }, config: { file: 'f', found: false, sources: {} } }), config: withNotes });
  assert.deepEqual(doctor.err, []);
});

test('a broken config file stops the command with the file named', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'relaykit-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  writeFileSync(file, '{nope');
  const err = [];
  const code = await main(['sync', '--check'], { out: () => {}, err: l => err.push(l), env: { RELAYKIT_CONFIG: file } });
  assert.equal(code, 2);
  assert.match(err[0], /relaykit sync: .*config\.json is not valid JSON/);
});

test('the real binary runs: --version, and init --dry-run in a scratch repo writes nothing', t => {
  const dir = mkdtempSync(join(tmpdir(), 'relaykit-bin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.git'));
  const env = { ...process.env, RELAYKIT_CONFIG: join(dir, 'none.json'), RELAYKIT_AGENT_DESK: '', AI_KIT_AGENT_DESK: '' };
  const bin = join(KIT_DIR, 'bin', 'relaykit.mjs');
  const version = spawnSync(process.execPath, [bin, '--version'], { env, encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);
  const init = spawnSync(process.execPath, [bin, 'init', dir, '--profile', 'notes', '--dry-run'], { env, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /would add\s+\.claude\/agents\/writer\.md/);
  assert.match(init.stdout, /skipped\s+Agent Desk registration/);
  assert.deepEqual(readdirSync(dir).sort(), ['.git']);
});

test('init outside a checkout reports one actionable line without a stack or writes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'relaykit-not-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await run(['init', dir]);
  assert.equal(result.code, 2);
  assert.equal(result.err.length, 1);
  assert.match(result.err[0], /^relaykit init: .*not a git checkout\. Run git init/);
  assert.doesNotMatch(result.err[0], /\n|\bat .*\.mjs:/);
  assert.deepEqual(readdirSync(dir), []);
  const direct = spawnSync(process.execPath, [join(KIT_DIR, 'install.mjs'), dir], {
    encoding: 'utf8', env: { ...process.env, RELAYKIT_CONFIG: join(dir, 'none.json') },
  });
  assert.equal(direct.status, 2);
  assert.match(direct.stderr.trim(), /^init: .*not a git checkout\. Run git init[^\n]+$/);
  assert.deepEqual(readdirSync(dir), []);
});
