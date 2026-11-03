import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExecutable, knownLocation, runTool } from './exe.mjs';
import { commandInterpreter, envValue, launch } from './exe.mjs';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const w = (...parts) => parts.join(String.fromCharCode(92));

test('installer locations are only used on Windows and only when the file exists', () => {
  const env = { LOCALAPPDATA: w('C:','L') };
  assert.match(knownLocation('claude', { env, platform: 'win32', home: w('C:','H') }), /claude\.exe$/);
  assert.equal(knownLocation('claude', { env, platform: 'darwin', home: '/h' }), null);
  assert.equal(knownLocation('gh', { env, platform: 'win32', home: w('C:','H') }), null);
  assert.equal(findExecutable('codex', undefined, { env, platform: 'win32', home: w('C:','H'), exists: () => false }), 'codex');
  assert.match(findExecutable('codex', undefined, { env, platform: 'win32', home: w('C:','H'), exists: () => true }), /codex\.exe$/);
  assert.equal(findExecutable('codex', '/custom/codex', { exists: () => false }), '/custom/codex');
});

test('native executables and unresolved bare names never use shell:true', () => {
  const seen = [];
  const run = (exe, args, options) => { seen.push(options.shell); return { status: 0, stdout: 'v1\n' }; };
  assert.equal(runTool('opencode', ['--version'], { run, platform: 'win32' }).stdout, 'v1\n');
  runTool(w('C:','x','agy.exe'), ['--version'], { run, platform: 'win32' });
  runTool('codex', ['--version'], { run, platform: 'linux' });
  assert.deepEqual(seen, [false, false, false]);
});

test('cmd and bat shims use cmd.exe explicitly and quote every argument', () => {
  for (const suffix of ['cmd', 'bat']) {
    let call;
    launch(`C:\\fixture\\tool.${suffix}`, ['a b', 'a&b'], { platform: 'win32', env: {}, run: (...args) => { call = args; return {}; } });
    assert.equal(call[0], commandInterpreter({}));
    assert.match(call[0], /cmd[.]exe$/);
    assert.deepEqual(call[1].slice(0, 4), ['/d', '/s', '/v:off', '/c']);
    assert.equal(call[2].shell, false);
    assert.equal(call[2].windowsVerbatimArguments, true);
  }
});

test('Windows shims preserve hostile arguments and stdin without executing text', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'relaykit shim & space %PATH% !PATH! ^ ()-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'echo.cjs'), "let input=''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => console.log(JSON.stringify({args:process.argv.slice(2),input})));\n");
  const args = ['plain', '', 'space here', 'a&b', 'a|b', '(a)', 'say "hello"', '%PATH%', '!PATH!', '^caret', 'trailing\\', 'a\\"b', 'a>b'];
  const input = 'prompt " & echo compromised > owned.txt\n%PATH% !PATH!';
  for (const suffix of ['cmd', 'bat']) {
    const shim = join(root, `fixture.${suffix}`);
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0echo.cjs" %*\r\n`);
    const result = launch(shim, args, { cwd: root, input });
    assert.equal(result.status, 0, `${result.stderr} | error: ${result.error} | signal: ${result.signal}`);
    assert.deepEqual(JSON.parse(result.stdout), { args, input });
    // Windows keeps the capitalisation it was given (the runner has `Path`): drop every spelling first, or two keys race.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
    env.PATH = root;
    const found = launch('fixture', ['from path'], { cwd: root, input: '', env });
    assert.equal(found.status, 0, `${found.stderr} | error: ${found.error}`);
    assert.deepEqual(JSON.parse(found.stdout).args, ['from path']);
  }
  assert.equal(existsSync(join(root, 'owned.txt')), false);
});

test('a missing program and a timeout are reported, not thrown', () => {
  const missing = runTool('nope', [], { run: () => ({ status: null, error: { code: 'ENOENT' } }), platform: 'linux' });
  assert.deepEqual([missing.missing, missing.status], [true, 127]);
  const slow = runTool('slow', [], { run: () => ({ status: null, error: { code: 'ETIMEDOUT' } }), platform: 'linux' });
  assert.equal(slow.timedOut, true);
});

test('the shim interpreter is found whatever the capitalisation, and never by a bare name', () => {
  assert.equal(envValue({ COMSPEC: 'x' }, 'ComSpec'), 'x');
  assert.equal(envValue({ comspec: 'y' }, 'ComSpec'), 'y');
  assert.equal(envValue({}, 'ComSpec'), undefined);
  assert.equal(commandInterpreter({ COMSPEC: 'C:/custom/cmd.exe' }), 'C:/custom/cmd.exe');
  assert.equal(commandInterpreter({ SystemRoot: 'D:/Win' }), 'D:/Win/System32/cmd.exe');
  assert.equal(commandInterpreter({}), 'C:/Windows/System32/cmd.exe');
});
