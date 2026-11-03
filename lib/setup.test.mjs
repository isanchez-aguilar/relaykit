import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { launcherFiles, pathContains, pathPlan, powershell, setup, userBin } from './setup.mjs';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'relayrace-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function windowsEnvironment(path) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'psmodulepath'].includes(key.toLowerCase())));
  return { ...env, PATH: path };
}

function powershellHosts() {
  return [join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    join(process.env.ProgramFiles || '', 'PowerShell/7/pwsh.exe')].filter(existsSync);
}

test('launcher generation quotes each platform and keeps PowerShell companion off PATH', () => {
  const windows = launcherFiles({ platform: 'win32', node: 'C:\\Node Space!%\\node.exe', kitDir: "C:\\Kit O'Brien" });
  assert.match(windows['relayrace.cmd'], /DisableDelayedExpansion/);
  assert.match(windows['relayrace.cmd'], /"C:\\Node Space!%%\\node.exe" "C:\\Kit O'Brien\\bin\\relayrace.mjs" %\*/);
  assert.match(windows['powershell/relayrace.ps1'], /Kit O''Brien/);
  assert.equal(windows['relayrace.ps1'], undefined);
  const unix = launcherFiles({ platform: 'linux', node: '/a b/node', kitDir: "/kit'quote" });
  assert.ok(unix.relayrace.includes("'/kit'\\''quote/bin/relayrace.mjs'"));
  assert.match(unix.relayrace, /"\$@"/);
  assert.throws(() => launcherFiles({ platform: 'linux', node: '/node\n', kitDir: '/kit' }), /newlines/);
});

test('Windows PATH planning uses injected user PATH, compares case-insensitively and preserves entries', () => {
  const settings = { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Fake\\Local', PATH: 'machine-path' }, home: 'C:\\Fake', read: () => '' };
  const bin = userBin(settings);
  const edits = pathPlan({ ...settings, userPath: 'C:\\Existing;' });
  assert.equal(edits[0].value, `C:\\Existing;${bin}`);
  assert.equal(edits[0].value.includes('machine-path'), false);
  assert.deepEqual(pathPlan({ ...settings, userPath: `C:\\existing;${bin.toUpperCase()}\\` }), []);
  assert.equal(pathContains(`${bin}-other`, bin, 'win32'), false);
});

test('PATH prompts default to no, --yes skips prompt, reruns are idempotent without real settings', async () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const files = new Map(), outputs = [];
    let userPath = 'existing', prompts = 0, answer = false;
    const options = { platform, home: platform === 'win32' ? 'C:\\Fake' : '/fake', node: platform === 'win32' ? 'C:\\node.exe' : '/node', kitDir: platform === 'win32' ? 'C:\\kit' : '/kit', env: { SHELL: '/bin/bash' },
      read: path => files.get(path) || '', exists: path => files.has(path), write: (path, text) => files.set(path, text), chmod: () => {},
      getUserPath: () => userPath, setUserPath: value => { userPath = value; }, log: line => outputs.push(line), interactive: true,
      prompt: async () => { prompts++; assert.ok(outputs.some(line => line.startsWith('Append to '))); return answer; } };
    await setup(options);
    assert.equal(prompts, 1);
    assert.equal(files.size, platform === 'win32' ? 2 : 1);
    await setup({ ...options, interactive: false });
    assert.equal(prompts, 1);
    await setup({ ...options, yes: true });
    const after = [...files];
    await setup(options);
    assert.deepEqual([...files], after);
    assert.equal(prompts, 1);
    assert.ok(outputs.includes('User PATH is already configured.'));
    assert.match(outputs.at(-1), /relayrace doctor/);
  }
});

test('shell startup planning preserves Bash login selection and respects ZDOTDIR', () => {
  for (const login of ['.bash_profile', '.bash_login', '.profile']) {
    const edits = pathPlan({ platform: 'linux', home: '/h', env: { SHELL: '/bin/bash' }, exists: file => file === `/h/${login}`, read: () => '# keep\n' });
    assert.deepEqual(edits.map(edit => edit.target), [`/h/${login}`, '/h/.bashrc']);
    assert.ok(edits.every(edit => edit.value.startsWith('# keep\n')));
  }
  assert.deepEqual(pathPlan({ platform: 'darwin', home: '/h', env: { SHELL: '/bin/zsh', ZDOTDIR: '/z' }, read: () => '' }).map(edit => edit.target), ['/z/.zprofile', '/z/.zshrc']);
});

test('POSIX setup writes an executable launcher in a fake home only', { skip: process.platform === 'win32' }, async t => {
  const home = scratch(t);
  await setup({ home, env: { SHELL: '/bin/bash' }, yes: true, log: () => {} });
  const file = join(home, '.local/bin/relayrace');
  assert.equal(statSync(file).mode & 0o111, 0o111);
  const result = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 45000, env: { PATH: '/nonexistent' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+\.\d+/);
});

test('Windows launchers preserve cwd and arguments through cmd and PowerShell 5.1', { skip: process.platform !== 'win32' }, t => {
  const root = scratch(t), kitDir = join(root, "kit space & O'Brien!% Jos\u00e9-\u4e2d"), bin = join(root, 'bin');
  mkdirSync(join(kitDir, 'bin'), { recursive: true });
  mkdirSync(join(bin, 'powershell'), { recursive: true });
  writeFileSync(join(kitDir, 'bin/relayrace.mjs'), 'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));');
  for (const [name, text] of Object.entries(launcherFiles({ platform: 'win32', node: process.execPath, kitDir }))) writeFileSync(join(bin, name), text);
  const args = ['a b', 'amp & bang!', 'simple'];
  const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
  for (const launcher of ['relayrace.cmd', 'powershell/relayrace.ps1']) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& ${psQuote(join(bin, launcher))} ${args.map(psQuote).join(' ')}`], { cwd: root, encoding: 'utf8', timeout: 45000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args, cwd: realpathSync.native(root) });
  }
});

test('Windows cmd launcher supports Unicode checkout paths and restores its codepage and exit status', { skip: process.platform !== 'win32' }, t => {
  const root = scratch(t), kitDir = join(root, 'Jos\u00e9-\u4e2d'), bin = join(root, 'bin');
  mkdirSync(join(kitDir, 'bin'), { recursive: true }); mkdirSync(bin);
  writeFileSync(join(kitDir, 'bin/relayrace.mjs'), 'console.log("UNICODE_OK"); process.exitCode = 7;');
  writeFileSync(join(bin, 'relayrace.cmd'), launcherFiles({ platform: 'win32', node: process.execPath, kitDir })['relayrace.cmd']);
  const batch = join(root, 'test.cmd');
  writeFileSync(batch, '@echo off\r\nchcp 850 >nul\r\ncall relayrace\r\necho RESULT=%errorlevel%\r\nchcp\r\n');
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', batch], { encoding: 'utf8', timeout: 45000, env: { ...process.env, PATH: `${bin};${process.env.SystemRoot}\\System32` } });
  assert.match(result.stdout, /UNICODE_OK/);
  assert.match(result.stdout, /RESULT=7/);
  assert.match(result.stdout, /850/);
});

test('bare relayrace resolves under Restricted PowerShell with no Node on PATH', { skip: process.platform !== 'win32' }, t => {
  const root = scratch(t), kitDir = join(root, 'checkout'), bin = join(root, 'bin');
  mkdirSync(join(kitDir, 'bin'), { recursive: true });
  mkdirSync(join(bin, 'powershell'), { recursive: true });
  writeFileSync(join(kitDir, 'bin/relayrace.mjs'), 'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); process.exitCode = 9;');
  for (const [name, text] of Object.entries(launcherFiles({ platform: 'win32', node: process.execPath, kitDir }))) writeFileSync(join(bin, name), text);
  for (const host of powershellHosts()) {
    const result = spawnSync(host, ['-NoProfile', '-ExecutionPolicy', 'Restricted', '-Command', "relayrace 'two words' --check; exit $LASTEXITCODE"], {
      cwd: root, encoding: 'utf8', timeout: 45000, env: windowsEnvironment(bin),
    });
    assert.equal(result.status, 9, `${host}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { args: ['two words', '--check'], cwd: realpathSync.native(root) });
  }
});

test('PowerShell bootstrap discovers Node with a stripped PATH without running real setup', { skip: process.platform !== 'win32' }, t => {
  const root = scratch(t);
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'lib'));
  writeFileSync(join(root, 'scripts/setup.ps1'), readFileSync(new URL('../scripts/setup.ps1', import.meta.url)));
  writeFileSync(join(root, 'lib/setup.mjs'), 'console.log("BOOTSTRAP " + JSON.stringify(process.argv.slice(2)));');
  for (const host of powershellHosts()) {
    const result = spawnSync(host, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/setup.ps1'), '-Yes'], {
      encoding: 'utf8', timeout: 45000, env: { ...windowsEnvironment(`${process.env.SystemRoot}\\System32`), NVM_SYMLINK: resolve(process.execPath, '..') },
    });
    assert.equal(result.status, 0, `${host}: ${result.stderr}`);
    assert.match(result.stdout, /BOOTSTRAP \["--yes"\]/);
  }
});

test('shell bootstrap skips an unsupported Node on PATH and discovers nvm without running setup', t => {
  const shell = process.platform === 'win32' ? join(process.env.ProgramFiles || '', 'Git/bin/sh.exe') : '/bin/sh';
  if (!existsSync(shell)) { t.skip('A POSIX shell is unavailable'); return; }
  const root = scratch(t), home = join(root, 'home'), kit = join(root, "kit space ' quote"), oldBin = join(root, 'old');
  const nodeDir = join(home, '.nvm/versions/node/v18/bin');
  for (const directory of [nodeDir, kit, oldBin]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(oldBin, 'node'), '#!/bin/sh\nexit 1\n');
  writeFileSync(join(nodeDir, 'node'), '#!/bin/sh\nif [ "$1" = -e ]; then exit 0; fi\nprintf "BOOTSTRAP:%s:%s\\n" "$1" "$2"\n');
  for (const directory of [oldBin, nodeDir]) chmodSync(join(directory, 'node'), 0o755);
  writeFileSync(join(kit, 'setup.sh'), readFileSync(new URL('../scripts/setup.sh', import.meta.url)));
  const shellPath = value => process.platform === 'win32' ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : value;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'home', 'nvm_dir', 'fnm_dir', 'volta_home'].includes(key.toLowerCase())));
  Object.assign(env, { HOME: shellPath(home), NVM_DIR: shellPath(join(home, '.nvm')), PATH: `${shellPath(oldBin)}:/usr/bin:/bin` });
  const result = spawnSync(shell, [shellPath(join(kit, 'setup.sh')), '--yes'], { env, encoding: 'utf8', timeout: 45000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `BOOTSTRAP:${shellPath(kit)}/../lib/setup.mjs:--yes`);
});

test('launchers use relayrace_* cmd variables and the Relayrace mark; the Windows folder keeps its old name', () => {
  const windows = launcherFiles({ platform: 'win32', node: 'C:\\n\\node.exe', kitDir: 'C:\\Kit' });
  assert.match(windows['relayrace.cmd'], /rem Generated by Relayrace setup/);
  assert.match(windows['relayrace.cmd'], /relayrace_codepage/);
  assert.doesNotMatch(windows['relayrace.cmd'], /relaykit/i);
  assert.match(launcherFiles({ platform: 'linux', node: '/n', kitDir: '/k' }).relayrace, /# Generated by Relayrace setup/);
  // %LOCALAPPDATA%\Relaykit\bin is already on users' PATH: it must not move.
  assert.equal(userBin({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, home: 'C:\\H' }), 'C:\\L\\Relaykit\\bin');
});

test('launchers and shell blocks written under the old Relaykit mark are still ours', async () => {
  const written = [];
  const old = '#!/bin/sh\n# Generated by Relaykit setup\nexec node x\n';
  await setup({ platform: 'linux', home: '/fake', env: { SHELL: '/bin/bash' }, yes: true, interactive: false, node: '/n', kitDir: '/k',
    read: () => old, exists: () => false, write: (file, text) => written.push([file, text]), chmod: () => {}, log: () => {} });
  assert.equal(written.some(([file, text]) => file.endsWith('/relayrace') && text.includes('Generated by Relayrace setup')), true);
  // A profile that already has the PATH block under the old mark is not given a second copy.
  const first = pathPlan({ platform: 'linux', home: '/h', env: { SHELL: '/bin/bash' }, exists: () => false, read: () => '' });
  const oldProfile = first[0].value.replace('Generated by Relayrace setup', 'Generated by Relaykit setup');
  const again = pathPlan({ platform: 'linux', home: '/h', env: { SHELL: '/bin/bash' }, exists: () => false, read: file => (file.endsWith('.profile') ? oldProfile : '') });
  assert.equal(again.some(edit => edit.target.endsWith('.profile')), false);
});

test('setup refuses unrelated launchers before overwriting anything', async () => {
  await assert.rejects(setup({ platform: 'linux', home: '/fake', env: {}, read: () => 'custom command', write: () => assert.fail('must not write'), log: () => {} }), /unrelated launcher/);
});

test('PowerShell user PATH transport preserves Unicode without registry access', { skip: process.platform !== 'win32' }, () => {
  const value = 'C:\\Users\\Jos\u00e9\\bin;C:\\User \u65e5\u672c';
  assert.equal(JSON.parse(powershell('ConvertTo-Json -Compress -InputObject ([Console]::In.ReadToEnd())', { input: value })), value);
});

test('a shell profile with Windows line endings is recognised as already set up', () => {
  const first = pathPlan({ platform: 'linux', home: '/h', env: { SHELL: '/bin/bash' }, exists: () => false, read: () => '' });
  const withCrlf = first[0].value.replace(/\n/g, '\r\n');
  const again = pathPlan({ platform: 'linux', home: '/h', env: { SHELL: '/bin/bash' }, exists: () => false, read: file => (file.endsWith('.profile') ? withCrlf : '') });
  assert.equal(again.some(edit => edit.target.endsWith('.profile')), false);
});

test('PowerShell is called by its absolute system path, never by a bare name', () => {
  let exe;
  powershell('1', { run: command => { exe = command; return { status: 0, stdout: '' }; } });
  assert.match(exe, /System32.WindowsPowerShell.v1.0.powershell.exe$/i);
});
