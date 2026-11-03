import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, parseArgs } from '../install.mjs';
import { LOCK_FILE, applyUpdate, hashContent, planUpdate, readLock, replaceIfUnchanged, summarize } from './update.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { log: () => {} };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'relaykit-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  return { root, repo };
}

/** A copy of the kit whose prompt changes, to stand for "a newer Relayrace". */
function newerKit(t, root) {
  const kit = join(root, 'kit');
  cpSync(KIT, kit, { recursive: true, filter: source => !/node_modules|[\\/]\.git([\\/]|$)/.test(source) });
  const prompt = join(kit, 'prompts', 'review.md');
  writeFileSync(prompt, `${readFileSync(prompt, 'utf8')}\nA new rule added by a newer Relayrace.\n`);
  return kit;
}

test('init records a baseline for the files it wrote, and not for the rules files', t => {
  const { repo } = fixture(t);
  install({ repo, profile: 'generic', checks: [] }, quiet);
  const lock = readLock(repo);
  assert.ok(lock.files['.ai/prompts/review.md']);
  assert.equal(lock.files['AGENTS.md'], undefined);
  assert.equal(lock.files['CLAUDE.md'], undefined);
  assert.equal(lock.files['.ai/project.json'], undefined);
  assert.equal(lock.files['.ai/prompts/review.md'], hashContent(readFileSync(join(repo, '.ai/prompts/review.md'), 'utf8')));
});

test('an unedited file is safe to update, and --apply replaces only that', t => {
  const { root, repo } = fixture(t);
  install({ repo, profile: 'generic', checks: [] }, quiet);
  const kit = newerKit(t, root);
  const before = planUpdate(repo, { kitDir: kit, profile: 'generic' });
  assert.deepEqual(before.entries.filter(e => e.state === 'updatable').map(e => e.path), ['.ai/prompts/review.md']);
  const lines = [];
  const result = install({ repo, update: true, apply: true, profileGiven: undefined }, { log: line => lines.push(line), kitDir: kit });
  assert.deepEqual(result.applied.map(a => a.path), ['.ai/prompts/review.md']);
  assert.match(readFileSync(join(repo, '.ai/prompts/review.md'), 'utf8'), /newer Relayrace/);
  assert.equal(summarize(planUpdate(repo, { kitDir: kit, profile: 'generic' })).updatable, 0);
  assert.match(lines.join('\n'), /wrote \.ai\/prompts\/review\.md \(updatable\)/);
});

test('without --apply nothing is written, and a dry run never writes either', t => {
  const { root, repo } = fixture(t);
  install({ repo, profile: 'generic', checks: [] }, quiet);
  const kit = newerKit(t, root);
  const original = readFileSync(join(repo, '.ai/prompts/review.md'), 'utf8');
  install({ repo, update: true }, { ...quiet, kitDir: kit });
  install({ repo, update: true, apply: true, dryRun: true }, { ...quiet, kitDir: kit });
  assert.equal(readFileSync(join(repo, '.ai/prompts/review.md'), 'utf8'), original);
});

test('a file the owner edited is never replaced, and the report says so', t => {
  const { root, repo } = fixture(t);
  install({ repo, profile: 'generic', checks: [] }, quiet);
  const prompt = join(repo, '.ai/prompts/review.md');
  writeFileSync(prompt, `${readFileSync(prompt, 'utf8')}\nMy own review rule.\n`);
  const kit = newerKit(t, root);
  const lines = [];
  const result = install({ repo, update: true, apply: true }, { log: line => lines.push(line), kitDir: kit });
  assert.deepEqual(result.applied, []);
  assert.match(readFileSync(prompt, 'utf8'), /My own review rule/);
  assert.doesNotMatch(readFileSync(prompt, 'utf8'), /newer Relayrace/);
  assert.match(lines.join('\n'), /modified .*review\.md.*edited since install/);
});

test('a repo installed before baselines existed is reported, not rewritten', t => {
  const { root, repo } = fixture(t);
  install({ repo, profile: 'generic', checks: [] }, quiet);
  rmSync(join(repo, LOCK_FILE));
  const kit = newerKit(t, root);
  const plan = planUpdate(repo, { kitDir: kit, profile: 'generic' });
  assert.equal(plan.tracked, false);
  assert.equal(plan.entries.find(e => e.path === '.ai/prompts/review.md').state, 'modified');
  const result = install({ repo, update: true, apply: true }, { ...quiet, kitDir: kit });
  assert.deepEqual(result.applied, []);
  assert.doesNotMatch(readFileSync(join(repo, '.ai/prompts/review.md'), 'utf8'), /newer Relayrace/);
});

test('a missing file is written on --apply and AGENTS.md is never replaced', t => {
  const { repo } = fixture(t);
  install({ repo, profile: 'generic', checks: [] }, quiet);
  rmSync(join(repo, '.ai/prompts/review.md'));
  writeFileSync(join(repo, 'AGENTS.md'), '# Mine\n');
  const result = install({ repo, update: true, apply: true }, { ...quiet, kitDir: KIT });
  assert.deepEqual(result.applied.map(a => a.state), ['missing']);
  assert.ok(existsSync(join(repo, '.ai/prompts/review.md')));
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), '# Mine\n');
});

test('update needs a profile it can find, and --apply only goes with --update', t => {
  const { repo } = fixture(t);
  assert.throws(() => install({ repo, update: true }, quiet), /does not say which profile/);
  assert.throws(() => parseArgs(['--apply']), /--apply only goes with --update/);
  assert.equal(parseArgs(['--update', '--apply', '--profile', 'web-app']).profileGiven, 'web-app');
});

test('doctor reports the update state of an installed repo', async t => {
  const { repo } = fixture(t);
  install({ repo, profile: 'generic', checks: [] }, quiet);
  const { repoState } = await import('./doctor.mjs');
  const state = repoState(repo, { kitDir: KIT });
  assert.equal(state.update.updatable, 0);
  assert.equal(state.update.tracked, true);
  assert.ok(state.update.current > 0);
});

test('apply refuses a path that leaves the repository through a link or a junction', t => {
  const { root, repo } = fixture(t);
  install({ repo, profile: 'generic', checks: [] }, quiet);
  const outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  rmSync(join(repo, '.claude'), { recursive: true, force: true });
  symlinkSync(outside, join(repo, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = install({ repo, update: true, apply: true }, { ...quiet, kitDir: KIT });
  assert.equal(readdirSync(outside).length, 0, 'nothing written through the link');
  assert.ok(result.plan.skipped.length > 0);
  assert.match(result.plan.skipped[0].reason, /outside the repository|through a link/);
});

test('a file edited between the comparison and --apply is skipped, not overwritten', t => {
  const { root, repo } = fixture(t);
  install({ repo, profile: 'generic', checks: [] }, quiet);
  const kit = newerKit(t, root);
  const plan = planUpdate(repo, { kitDir: kit, profile: 'generic' });
  const prompt = join(repo, '.ai/prompts/review.md');
  writeFileSync(prompt, 'edited after the comparison\n');
  const written = applyUpdate(plan, { kit: '9.9.9' });
  assert.deepEqual(written, []);
  assert.equal(readFileSync(prompt, 'utf8'), 'edited after the comparison\n');
  assert.match(plan.skipped[0].reason, /changed since the comparison/);
});

test('a file that appeared after the comparison is never replaced by a missing-file write', t => {
  const { repo } = fixture(t);
  install({ repo, profile: 'generic', checks: [] }, quiet);
  const prompt = join(repo, '.ai/prompts/review.md');
  rmSync(prompt);
  const plan = planUpdate(repo, { kitDir: KIT, profile: 'generic' });
  writeFileSync(prompt, 'created by the owner meanwhile\n');
  assert.deepEqual(applyUpdate(plan), []);
  assert.equal(readFileSync(prompt, 'utf8'), 'created by the owner meanwhile\n');
});

test('replaceIfUnchanged writes through the checked file only when its hash still matches', t => {
  const { repo } = fixture(t);
  const file = join(repo, 'a.txt');
  writeFileSync(file, 'one\n');
  assert.throws(() => replaceIfUnchanged(file, hashContent('other\n'), 'new\n'), /changed since the comparison/);
  assert.equal(readFileSync(file, 'utf8'), 'one\n');
  replaceIfUnchanged(file, hashContent('one\n'), 'new content\n');
  assert.equal(readFileSync(file, 'utf8'), 'new content\n');
  assert.throws(() => replaceIfUnchanged(join(repo, 'missing.txt'), hashContent('x'), 'y'), /ENOENT/);
});
