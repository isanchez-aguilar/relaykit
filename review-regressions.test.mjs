import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install } from './install.mjs';
import { hasGuardrails } from './qwen.mjs';
import { checkLocalModel, checkTool, TOOLS } from './lib/doctor.mjs';
import { BLOCK_START, BLOCK_END, GENERATED, isGenerated, upsertBlock } from './sync.mjs';

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'relayrace-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.git'));
  return root;
}

test('init proposes permissions by default, without writing opencode.json', t => {
  const root = repo(t), lines = [];
  install({ repo: root, checks: [] }, { log: line => lines.push(line) });
  assert.ok(!readdirSync(root).includes('opencode.json'));
  assert.match(lines.join('\n'), /apply.*manually/i);
  assert.ok(lines.join('\n').includes(join(root, 'opencode.json')));
  assert.match(lines.join('\n'), /"bash"/);
});

test('all invalid init options are refused before creating any file', t => {
  for (const option of [{ checks: ['npm test && echo rejected'] }, { claudeModel: 'bad model' },
    { checks: ['npm test *'] }, { checks: ['npm test\necho rejected'] }, { jules: { repo: 'invalid', branch: 'main' } }]) {
    const root = repo(t);
    assert.throws(() => install({ repo: root, checks: [], ...option }, { log: () => {} }));
    assert.deepEqual(readdirSync(root), ['.git']);
  }
});

test('invalid existing effective project config leaves the checkout untouched', t => {
  const root = repo(t);
  mkdirSync(join(root, '.ai'));
  const before = '{"checks":["npm test && echo rejected"]}';
  writeFileSync(join(root, '.ai/project.json'), before);
  assert.throws(() => install({ repo: root, checks: [] }, { log: () => {} }));
  assert.deepEqual(readdirSync(root).sort(), ['.ai', '.git']);
  assert.equal(readFileSync(join(root, '.ai/project.json'), 'utf8'), before);
});

test('empty opencode config is insufficient and remains untouched', t => {
  const root = repo(t);
  writeFileSync(join(root, 'opencode.json'), '{}');
  assert.equal(hasGuardrails(root), false);
  assert.equal(readFileSync(join(root, 'opencode.json'), 'utf8'), '{}');
});

test('doctor strips URL credentials and version identities on success and failure', async () => {
  const url = 'https://fake-user:FAKE_REVIEW_TOKEN@example.test/health?token=FAKE_REVIEW_TOKEN#fake@example.test';
  for (const fetch of [async () => new Response('{"status":"ok"}'), async () => { throw Error('offline'); }]) {
    const result = await checkLocalModel(url, fetch);
    assert.equal(result.url, 'https://example.test/health');
  }
  const result = checkTool(TOOLS[0], { platform: 'linux', env: {}, exists: () => false,
    run: () => ({ status: 0, stdout: 'v2.1.3 fake@example.test FAKE_REVIEW_TOKEN' }) });
  assert.equal(result.version, 'v2.1.3');
});

test('ownership requires a header and a unique ordered pair of owned markers', () => {
  assert.equal(isGenerated(`Manual citation: ${GENERATED}`), false);
  const block = upsertBlock('', 'original');
  for (const text of [block + block, `${BLOCK_END}\n${BLOCK_START}`, `${BLOCK_START}\nmanual\n${BLOCK_END}`]) {
    assert.throws(() => upsertBlock(text, 'replacement'));
  }
});

test('init rejects malformed Agent Desk config before writing repo files', t => {
  for (const invalid of ['{', 'null', '{"projects":[{}]}', '{"projects":{}}']) {
    const root = repo(t), desk = join(root, 'desk.json');
    writeFileSync(desk, invalid);
    assert.throws(() => install({ repo: root, checks: [] }, { agentDeskConfig: desk, log: () => {} }));
    assert.deepEqual(readdirSync(root).sort(), ['.git', 'desk.json']);
    assert.equal(readFileSync(desk, 'utf8'), invalid);
  }
});

test('OpenCode proposals respect effective config and never write or replace permissions', t => {
  const root = repo(t);
  install({ repo: root, checks: ['npm test'], qwenAllow: ['npm run typecheck'] }, { log: () => {} });
  const lines = [];
  install({ repo: root, checks: ['npm run build'], opencode: true }, { log: line => lines.push(line) });
  assert.ok(!readdirSync(root).includes('opencode.json'));
  const path = join(root, 'opencode.json'), before = lines.find(line => line.startsWith('{'));
  const config = JSON.parse(before);
  assert.equal(config.permission.bash['npm test'], 'allow');
  assert.equal(config.permission.bash['npm run typecheck'], 'allow');
  assert.equal(config.permission.bash['npm run build'], undefined);
  assert.equal(hasGuardrails(root), false);
  writeFileSync(path, '{}');
  install({ repo: root, checks: [], opencode: true }, { log: () => {} });
  assert.equal(readFileSync(path, 'utf8'), '{}');
});
