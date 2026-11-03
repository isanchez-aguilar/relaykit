import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasGuardrails, main } from '../qwen.mjs';
import { opencodeConfig, taskPath, validGuardrails } from './guardrails.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'relaykit-guard-'));
  t.after(() => rmSync(base, { force: true, recursive: true }));
  const root = join(base, 'repo'); mkdirSync(root);
  writeFileSync(join(root, 'opencode.json'), JSON.stringify(opencodeConfig(['npm test'])));
  mkdirSync(join(root, '.ai'));
  writeFileSync(join(root, '.ai/project.json'), JSON.stringify({ checks: ['npm test'] }));
  return { base, root };
}

test('guardrails require default deny, exact trusted commands and denied external tools', t => {
  const { root } = fixture(t);
  assert.equal(hasGuardrails(root), true);
  for (const mutate of [c => c.permission.bash['*'] = 'allow', c => c.permission.bash['npm test *'] = 'allow',
    c => c.permission.bash['git push'] = 'allow', c => c.permission.webfetch = 'allow', c => delete c.permission.task,
    c => c.permission.external_directory = { '*': 'allow' }, c => c.permission.other = 'allow',
    c => c.agent = { build: { permission: { bash: 'allow' } } }, c => c.mode = { build: { tools: { bash: true } } },
    c => c.plugin = ['untrusted'], c => c.mcp = { unsafe: {} }]) {
    const config = opencodeConfig(['npm test']); mutate(config);
    assert.equal(validGuardrails(config, ['npm test']), false);
    const text = JSON.stringify(config); writeFileSync(join(root, 'opencode.json'), text);
    assert.equal(hasGuardrails(root), false);
    assert.equal(readFileSync(join(root, 'opencode.json'), 'utf8'), text);
  }
  for (const malformed of ['{', 'null', '[]', '{}']) {
    writeFileSync(join(root, 'opencode.json'), malformed);
    assert.equal(hasGuardrails(root), false);
  }
});

test('secret names and outside task paths are refused before any file read', t => {
  const { base, root } = fixture(t);
  for (const name of ['.env', '.environment', '.env.local', '.dev.vars', '.dev.varsBackup', 'fake.pem', 'FAKE.KEY', 'rotate-secrets-fixture.env']) {
    writeFileSync(join(root, name), 'FAKE_SECRET_ONLY');
    assert.throws(() => taskPath(root, name), /secret/);
  }
  writeFileSync(join(base, 'outside.md'), 'FAKE_OUTSIDE_ONLY');
  assert.throws(() => taskPath(root, '../outside.md'), /outside/);
  assert.throws(() => taskPath(root, join(base, 'outside.md')), /outside/);
  writeFileSync(join(root, 'task.md'), 'safe task');
  assert.equal(taskPath(root, 'task.md'), realpathSync(join(root, 'task.md')));
});

test('task realpaths reject junction escapes and secret directories', t => {
  const { base, root } = fixture(t);
  const outside = join(base, 'outside'), secret = join(root, '.env-hidden');
  for (const directory of [outside, secret]) { mkdirSync(directory); writeFileSync(join(directory, 'task.md'), 'FAKE_ONLY'); }
  symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(secret, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => taskPath(root, 'escape/task.md'), /outside/);
  assert.throws(() => taskPath(root, 'alias/task.md'), /secret/);
});

test('file symlinks cannot disguise secrets', { skip: process.platform === 'win32' }, t => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'fake.key'), 'FAKE_ONLY');
  symlinkSync(join(root, 'fake.key'), join(root, 'task.md'));
  assert.throws(() => taskPath(root, 'task.md'), /secret/);
});

test('Windows alternate streams cannot disguise secret extensions', { skip: process.platform !== 'win32' }, t => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'fake.key'), 'FAKE_ONLY');
  assert.throws(() => taskPath(root, 'fake.key::$DATA'), /secret/);
});

test('Qwen dry-run writes neither task copies, logs nor locks, including rejected tasks', async t => {
  const { base, root } = fixture(t);
  writeFileSync(join(root, 'task.md'), 'safe task');
  const options = { root, tempBase: join(base, 'logs'), healthCheck: async () => true, cliAvailable: () => true };
  const before = readdirSync(base);
  assert.equal(await main(['--dry-run', '--task', 'task.md'], options), 0);
  assert.deepEqual(readdirSync(base), before);
  writeFileSync(join(root, '.env'), 'FAKE_ONLY');
  await assert.rejects(main(['--dry-run', '--task', '.env'], options), /secret/);
  assert.deepEqual(readdirSync(base), before);
  writeFileSync(join(root, 'opencode.json'), '{}');
  await assert.rejects(main(['--optional', '--prompt', 'safe task'], options), /insufficient/);
});
