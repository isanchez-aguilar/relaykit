import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendInside, assertInside, writeNewInside, writeTextAtomic } from './lib/safe-fs.mjs';
import { install } from './install.mjs';
import { defaultPriority, relayPriority, runRelay } from './relay.mjs';
import { hashContent, replaceIfUnchanged } from './lib/update.mjs';
import { splitCommand } from './lib/ci-local.mjs';
import { BLOCK_END, BLOCK_START, GENERATED, extractContract, upsertBlock } from './sync.mjs';
import { taskPath } from './lib/guardrails.mjs';
import { saveProviders } from './lib/providers.mjs';

const folder = t => { const dir = mkdtempSync(join(tmpdir(), 'relayrace-hard-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
const fileLinks = { skip: process.platform === 'win32' && 'file symlinks need privileges on Windows' };

/** A git-looking repo where `name` is a link to a folder OUTSIDE it. */
function repoWithEscapingLink(t, name) {
  const root = folder(t);
  const repo = join(root, 'repo');
  const outside = join(root, 'outside');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(repo, name), linkType);
  return { repo, outside };
}

test('a write through a link that leaves the repository is refused and creates nothing outside', t => {
  const { repo, outside } = repoWithEscapingLink(t, 'linked');
  assert.throws(() => writeNewInside(repo, join(repo, 'linked', 'a.txt'), 'x'), /outside the repository|through a link/);
  assert.deepEqual(readdirSync(outside), []);
  writeNewInside(repo, join(repo, 'ok', 'a.txt'), 'x');
  assert.equal(readFileSync(join(repo, 'ok', 'a.txt'), 'utf8'), 'x');
  assert.throws(() => writeNewInside(repo, join(repo, 'ok', 'a.txt'), 'y'), /EEXIST/, 'an existing file is never replaced');
  assert.doesNotThrow(() => assertInside(repo, join(repo, 'ok', 'new', 'deeper.txt')));
});

test('appending refuses a linked file, and an atomic write replaces a planted link without writing through it', fileLinks, t => {
  const dir = folder(t);
  const precious = join(dir, 'precious.txt');
  writeFileSync(precious, 'keep');
  const planted = join(dir, 'state.json');
  symlinkSync(precious, planted);
  assert.throws(() => appendInside(dir, planted, 'x'), /through a link/);
  writeTextAtomic(planted, 'new');
  assert.equal(readFileSync(precious, 'utf8'), 'keep');
  assert.equal(readFileSync(planted, 'utf8'), 'new');
});

test('appending refuses a file with a second hard link', t => {
  const dir = folder(t);
  const outside = join(dir, 'outside.txt');
  writeFileSync(outside, 'keep');
  const inside = join(dir, 'repo', '.gitignore');
  mkdirSync(join(dir, 'repo'));
  try { linkSync(outside, inside); } catch (error) { t.skip(`hard links are not available here: ${error.code}`); return; }
  assert.throws(() => appendInside(join(dir, 'repo'), inside, 'x'), /several hard links/);
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
  // A plain file still appends.
  const plain = join(dir, 'repo', 'plain.txt');
  writeFileSync(plain, 'a');
  appendInside(join(dir, 'repo'), plain, 'b');
  assert.equal(readFileSync(plain, 'utf8'), 'ab');
});

test('saving providers never writes through a file or link planted at the old predictable temporary name', t => {
  const dir = folder(t);
  const file = join(dir, 'providers.json');
  const precious = join(dir, 'precious.txt');
  writeFileSync(precious, 'keep');
  const planted = `${file}.${process.pid}.tmp`;
  let linked = true;
  try { symlinkSync(precious, planted); } catch { linked = false; writeFileSync(planted, 'planted'); }
  saveProviders(file, [{ id: 'solo', kind: 'codex', family: 'openai' }]);
  assert.equal(readFileSync(precious, 'utf8'), 'keep');
  if (!linked) assert.equal(readFileSync(planted, 'utf8'), 'planted');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).providers[0].id, 'solo');
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp') && name !== `providers.json.${process.pid}.tmp`), [], 'no temporary file is left behind');
});

test('init refuses to write through a linked folder and writes nothing outside the repository', t => {
  const { repo, outside } = repoWithEscapingLink(t, '.claude');
  assert.throws(() => install({ repo, profile: 'generic', checks: [] }, { log: () => {} }), /outside the repository|through a link/);
  assert.deepEqual(readdirSync(outside), []);
});

test('the relay will not use a run folder that is a link out of the repository', t => {
  const { repo, outside } = repoWithEscapingLink(t, '.ai');
  const task = join(repo, 'task.json');
  writeFileSync(task, JSON.stringify({ id: 't1', objective: 'x', acceptance: ['y'] }));
  assert.throws(() => runRelay(task, { cwd: repo, invoke: () => ({ status: 1 }) }), /outside the repository|through a link/);
  assert.deepEqual(readdirSync(outside), []);
});

test('a provider whose models are all restricted is not offered to the relay, as pick() does', () => {
  const entry = { kind: 'antigravity', enabled: true, family: 'google', can: ['review'], models: [{ id: 'big', cost: 'high', restricted: true }] };
  assert.deepEqual(relayPriority([entry]).review, []);
  assert.deepEqual(relayPriority([{ ...entry, models: [] }]).review, [{ id: 'agy', family: 'google' }]);
});

test('defaultPriority reads the repository providers file', t => {
  const dir = folder(t);
  mkdirSync(join(dir, '.ai'));
  writeFileSync(join(dir, '.ai', 'providers.json'), JSON.stringify({ providers: [{ id: 'codex', kind: 'codex', family: 'openai', can: ['review', 'implement'] }] }));
  const priority = defaultPriority(dir);
  assert.deepEqual(priority.review.map(entry => entry.id), ['codex']);
  assert.deepEqual(priority.implement.map(entry => entry.id), ['codex']);
});

test('update refuses to rewrite a file that has another name (hard link), which may live outside the repo', t => {
  const dir = folder(t);
  const file = join(dir, 'managed.md');
  writeFileSync(file, 'old\n');
  linkSync(file, join(dir, 'elsewhere.md'));
  assert.throws(() => replaceIfUnchanged(file, hashContent('old\n'), 'new\n'), /hard links/);
  assert.equal(readFileSync(join(dir, 'elsewhere.md'), 'utf8'), 'old\n');
});

test('a check keeps its quoted arguments together', () => {
  assert.deepEqual(splitCommand('pnpm test'), ['pnpm', 'test']);
  assert.deepEqual(splitCommand('node scripts/check.mjs "two words" --flag'), ['node', 'scripts/check.mjs', 'two words', '--flag']);
  assert.deepEqual(splitCommand("run 'a b' ''"), ['run', 'a b', '']);
  assert.deepEqual(splitCommand('  spaced   out  '), ['spaced', 'out']);
  assert.throws(() => splitCommand('say "oops'), /unbalanced quote/);
});

test('the contract markers are English, the Spanish ones are still read, and an old global block is migrated', () => {
  assert.equal(extractContract('<!-- contract:start -->\nRule.\n<!-- contract:end -->'), 'Rule.');
  assert.equal(extractContract('<!-- contrato:inicio -->\nRegla.\n<!-- contrato:fin -->'), 'Regla.');
  const legacy = '# Mine\n\n<!-- ISAAC_CONTRACT_START -->\n<!-- ' + GENERATED + ' -->\nold body\n<!-- ISAAC_CONTRACT_END -->\n\n## After\n';
  const migrated = upsertBlock(legacy, 'new body');
  assert.ok(migrated.includes(BLOCK_START));
  assert.equal(migrated.includes('ISAAC_CONTRACT'), false);
  assert.ok(migrated.includes('new body') && !migrated.includes('old body'));
  assert.ok(migrated.includes('# Mine') && migrated.includes('## After'));
  assert.throws(() => upsertBlock('<!-- ISAAC_CONTRACT_START -->\nhand written\n<!-- ISAAC_CONTRACT_END -->', 'x'), /not generated by relayrace sync/);
});

test('a global block written under the relaykit markers and header is recognised and migrated to the relayrace ones', () => {
  assert.equal(BLOCK_START, '<!-- RELAYRACE_CONTRACT_START -->');
  assert.equal(BLOCK_END, '<!-- RELAYRACE_CONTRACT_END -->');
  const header = 'GENERATED by relaykit sync — edit the source in the Relaykit repo (docs/contract.md, agents/, skills/), not this copy';
  const old = '# Mine\n\n<!-- RELAYKIT_CONTRACT_START -->\n<!-- ' + header + ' -->\nold body\n<!-- RELAYKIT_CONTRACT_END -->\n\n## After\n';
  const migrated = upsertBlock(old, 'new body');
  assert.ok(migrated.includes(BLOCK_START) && migrated.includes(BLOCK_END));
  assert.equal(migrated.includes('RELAYKIT_CONTRACT'), false);
  assert.equal(migrated.includes('relaykit sync'), false);
  assert.ok(migrated.includes('new body') && !migrated.includes('old body'));
  assert.ok(migrated.includes('# Mine') && migrated.includes('## After'));
  // Once migrated, a second pass is a no-op.
  assert.equal(upsertBlock(migrated, 'new body'), migrated);
  // A hand-written block between the old markers is still refused.
  assert.throws(() => upsertBlock('<!-- RELAYKIT_CONTRACT_START -->\nhand written\n<!-- RELAYKIT_CONTRACT_END -->', 'x'), /not generated by relayrace sync/);
  assert.throws(() => upsertBlock('<!-- RELAYKIT_CONTRACT_START -->\n<!-- ' + header + ' -->\nx', 'y'), /only one contract marker/);
});

test('a file whose name ends in secrets.env is treated as a secret by the task guard', t => {
  const root = folder(t);
  writeFileSync(join(root, 'my-secrets.env'), 'FAKE');
  assert.throws(() => taskPath(root, 'my-secrets.env'), /secret/);
});
