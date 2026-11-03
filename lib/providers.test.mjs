import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROVIDERS, cheapestModel, loadProviders, loadUserProviders, normalizeProvider, normalizeProviders, pick, providersFilePath, saveProviders } from './providers.mjs';
import { createProvidersUi } from './providers-ui.mjs';
import { parseProvidersArgs, runProviders } from './providers-cli.mjs';

const tmp = t => { const dir = mkdtempSync(join(tmpdir(), 'relayrace-providers-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const defaults = () => normalizeProviders(DEFAULT_PROVIDERS);
const environment = dir => ({ RELAYKIT_CONFIG: join(dir, 'cfg', 'config.json') });

test('the built-in order is qwen, jules, gemini, claude via agy, codex, claude', () => {
  assert.deepEqual(defaults().map(p => p.id), ['qwen', 'jules', 'gemini', 'agy-claude', 'codex', 'claude']);
});

test('pick takes the first enabled provider that can do the task', () => {
  const list = defaults();
  assert.equal(pick(list, { capability: 'mechanical' }).provider.id, 'qwen');
  assert.equal(pick(list, { capability: 'implement' }).provider.id, 'jules');
  assert.equal(pick(list, { capability: 'review' }).provider.id, 'gemini');
  assert.equal(pick(list, { capability: 'edit' }).provider.id, 'agy-claude');
  assert.equal(pick(list, { capability: 'test' }).provider.id, 'codex');
  assert.equal(pick(list, { capability: 'critical' }).provider.id, 'codex');
});

test('a disabled provider is skipped and reported, and no capable provider gives null', () => {
  const list = defaults().map(p => (p.id === 'qwen' ? { ...p, enabled: false } : p));
  const result = pick(list, { capability: 'mechanical' });
  assert.equal(result.provider.id, 'jules');
  assert.deepEqual(result.skipped, [{ id: 'qwen', reason: 'disabled' }]);
  assert.equal(pick(list.map(p => ({ ...p, enabled: false })), { capability: 'review' }), null);
});

test('independence is by model family: a reviewer excludes the implementer family', () => {
  const list = defaults();
  assert.equal(pick(list, { capability: 'edit', excludeFamilies: ['anthropic'] }).provider.id, 'codex');
  assert.equal(pick(list, { capability: 'review', excludeFamilies: ['google'] }).provider.id, 'codex');
});

test('the cheapest model wins and a restricted one needs the extreme flag', () => {
  const claude = defaults().find(p => p.id === 'claude');
  assert.equal(cheapestModel(claude).id, 'haiku');
  const onlyOpus = { ...claude, models: claude.models.filter(m => m.id === 'opus') };
  assert.equal(cheapestModel(onlyOpus), null);
  assert.equal(cheapestModel(onlyOpus, { extreme: true }).id, 'opus');
});

test('validation rejects bad ids, duplicates, unknown values, secrets and Fable', () => {
  const ok = { id: 'x', kind: 'codex', family: 'openai', can: ['review'] };
  assert.equal(normalizeProvider(ok).label, 'x');
  assert.throws(() => normalizeProvider({ ...ok, id: 'Bad Id' }), /lowercase/);
  assert.throws(() => normalizeProvider({ ...ok, kind: 'nope' }), /kind must be one of/);
  assert.throws(() => normalizeProvider({ ...ok, can: ['deploy'] }), /can must be one of/);
  assert.throws(() => normalizeProvider({ ...ok, enabled: 'yes' }), /enabled/);
  assert.throws(() => normalizeProvider({ ...ok, plan: 'key sk-abcdefghijklmnop1234' }), /secrets/);
  assert.throws(() => normalizeProvider({ ...ok, models: [{ id: 'claude-fable-5-1' }] }), /Fable/);
  assert.throws(() => normalizeProviders([ok, ok]), /duplicate provider id/);
  assert.throws(() => normalizeProviders({ providers: [] }), /nonempty/);
});

test('the repo file beats the user file, which beats the default; an invalid file throws', t => {
  const dir = tmp(t), repo = join(dir, 'repo'), env = environment(dir);
  mkdirSync(join(repo, '.ai'), { recursive: true });
  assert.equal(loadProviders({ cwd: repo, env }).source, 'default');
  const userFile = providersFilePath({ env });
  assert.equal(userFile, join(dir, 'cfg', 'providers.json'));
  saveProviders(userFile, [{ id: 'solo', kind: 'codex', family: 'openai', can: ['review'] }]);
  assert.deepEqual(loadProviders({ cwd: repo, env }).providers.map(p => p.id), ['solo']);
  writeFileSync(join(repo, '.ai', 'providers.json'), JSON.stringify({ providers: [{ id: 'repo-only', kind: 'claude', family: 'anthropic' }] }));
  const loaded = loadProviders({ cwd: repo, env });
  assert.equal(loaded.source, 'repo');
  assert.deepEqual(loaded.providers.map(p => p.id), ['repo-only']);
  writeFileSync(join(repo, '.ai', 'providers.json'), '{ nope');
  assert.throws(() => loadProviders({ cwd: repo, env }), /not valid JSON/);
});

test('RELAYKIT_PROVIDERS points at another file', t => {
  const dir = tmp(t);
  assert.equal(providersFilePath({ env: { RELAYKIT_PROVIDERS: join(dir, 'mine.json') } }), join(dir, 'mine.json'));
});

test('save is atomic, keeps the first version as a backup and refuses an invalid list', t => {
  const file = join(tmp(t), 'providers.json');
  saveProviders(file, DEFAULT_PROVIDERS);
  saveProviders(file, [{ id: 'a', kind: 'codex', family: 'openai' }]);
  saveProviders(file, [{ id: 'b', kind: 'codex', family: 'openai' }]);
  assert.equal(JSON.parse(readFileSync(`${file}.bak-relaykit`, 'utf8')).providers[0].id, 'qwen');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).providers[0].id, 'b');
  assert.throws(() => saveProviders(file, [{ id: 'BAD' }]), /lowercase/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).providers[0].id, 'b');
});

test('the providers subcommand parses its flags strictly', () => {
  assert.equal(parseProvidersArgs([]).action, 'list');
  assert.equal(parseProvidersArgs(['--json']).json, true);
  const picked = parseProvidersArgs(['pick', 'review', '--exclude-family', 'anthropic', '--extreme']);
  assert.deepEqual([picked.capability, picked.excludeFamilies, picked.extreme], ['review', ['anthropic'], true]);
  assert.throws(() => parseProvidersArgs(['pick']), /needs a capability/);
  assert.throws(() => parseProvidersArgs(['pick', 'deploy']), /needs a capability/);
  assert.throws(() => parseProvidersArgs(['pick', 'review', '--exclude-family', 'x']), /one of/);
  assert.throws(() => parseProvidersArgs(['ui', '--port', '80']), /1024/);
  assert.throws(() => parseProvidersArgs(['wat']), /unknown action/);
});

test('init writes the default file once and never overwrites it; list and pick read it', async t => {
  const dir = tmp(t), env = environment(dir), out = [];
  const run = args => runProviders(args, { cwd: dir, env, out: line => out.push(line) });
  assert.equal(await run(['init']), 0);
  assert.ok(existsSync(join(dir, 'cfg', 'providers.json')));
  assert.equal(await run(['init']), 0);
  assert.match(out.at(-1), /^kept/);
  assert.equal(await run(['pick', 'review', '--exclude-family', 'google']), 0);
  assert.equal(out.at(-1).split(' ')[0], 'codex');
  assert.equal(await run(['list', '--json']), 0);
  assert.equal(JSON.parse(out.at(-1)).providers.length, 6);
});

test('the editor serves a page, refuses foreign origins and bad tokens, and saves a valid list', async t => {
  const dir = tmp(t), file = join(dir, 'providers.json');
  // Reserve a free port first: the editor allows exactly 127.0.0.1:<its port>.
  const probe = createProvidersUi({ load: () => ({}), file, port: 1 });
  await new Promise(resolve => probe.server.listen(0, '127.0.0.1', resolve));
  const port = probe.server.address().port;
  await new Promise(resolve => probe.server.close(resolve));
  const ui = createProvidersUi({ load: () => ({ source: 'default', file, providers: defaults() }), file, port });
  await new Promise(resolve => ui.server.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { ui.server.close(resolve); ui.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${port}`;
  assert.match(await (await fetch(base)).text(), /Relayrace providers/);
  const api = await (await fetch(`${base}/api/providers`)).json();
  assert.equal(api.providers.length, 6);
  assert.equal(api.meta.token, ui.token);
  const put = (headers, body) => fetch(`${base}/api/providers`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await put({}, { providers: api.providers })).status, 403);
  assert.equal((await put({ 'X-Relaykit-Token': 'wrong', Origin: base }, { providers: api.providers })).status, 403);
  assert.equal((await put({ 'X-Relaykit-Token': ui.token, Origin: 'http://evil.example' }, { providers: api.providers })).status, 403);
  assert.equal((await put({ 'X-Relaykit-Token': ui.token, Origin: base }, { providers: [{ id: 'Bad' }] })).status, 400);
  const reordered = [api.providers[1], api.providers[0], ...api.providers.slice(2)];
  assert.equal((await put({ 'X-Relaykit-Token': ui.token, Origin: base }, { providers: reordered })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).providers.slice(0, 2).map(p => p.id), ['jules', 'qwen']);
});

test('critical work is refused for Qwen, Jules and Flash both when validating and when picking', () => {
  const base = { id: 'c', kind: 'codex', family: 'openai', can: ['critical'] };
  assert.equal(normalizeProvider(base).can[0], 'critical');
  assert.throws(() => normalizeProvider({ id: 'q', kind: 'qwen', family: 'local', can: ['critical'] }), /cannot go to the local model/);
  assert.throws(() => normalizeProvider({ id: 'j', kind: 'jules', family: 'google', can: ['critical'] }), /cannot go to the local model/);
  assert.throws(() => normalizeProvider({ id: 'g', kind: 'antigravity', family: 'google', can: ['critical'], models: [{ id: 'gemini-3.6-flash-low' }] }), /Flash/);
  // A list built by hand (not normalized) is still guarded at pick time.
  const forged = [{ id: 'q', kind: 'qwen', family: 'local', enabled: true, can: ['critical'], models: [] }, ...defaults()];
  assert.equal(pick(forged, { capability: 'critical' }).provider.id, 'codex');
});

test('a provider whose only models are extreme-case ones is skipped, not picked without a model', () => {
  const claudeOnlyOpus = { id: 'c', kind: 'claude', family: 'anthropic', enabled: true, can: ['review'], models: [{ id: 'opus', cost: 'high', restricted: true }] };
  const codex = defaults().find(p => p.id === 'codex');
  const normal = pick([claudeOnlyOpus, codex], { capability: 'review' });
  assert.equal(normal.provider.id, 'codex');
  assert.deepEqual(normal.skipped, [{ id: 'c', reason: 'only extreme-case models (use --extreme)' }]);
  assert.equal(pick([claudeOnlyOpus, codex], { capability: 'review', extreme: true }).provider.id, 'c');
  assert.equal(pick([{ ...claudeOnlyOpus, models: [] }, codex], { capability: 'review' }).provider.id, 'c');
});

test('oversized lists and files are refused', t => {
  assert.throws(() => normalizeProvider({ id: 'x', kind: 'codex', family: 'openai', can: Array(500).fill('review') }), /short list/);
  const dir = tmp(t), file = join(dir, 'providers.json');
  writeFileSync(file, JSON.stringify({ providers: [{ id: 'x', kind: 'codex', family: 'openai', notes: 'n'.repeat(300) }], pad: 'x'.repeat(300000) }));
  assert.throws(() => loadProviders({ cwd: dir, env: { RELAYKIT_PROVIDERS: file } }), /larger than/);
});

test('the editor source is the personal file even when the repo has an override', t => {
  const dir = tmp(t), env = environment(dir), repo = join(dir, 'repo');
  mkdirSync(join(repo, '.ai'), { recursive: true });
  saveProviders(providersFilePath({ env }), [{ id: 'personal', kind: 'codex', family: 'openai' }]);
  writeFileSync(join(repo, '.ai', 'providers.json'), JSON.stringify({ providers: [{ id: 'repo-only', kind: 'claude', family: 'anthropic' }] }));
  const user = loadUserProviders({ env });
  assert.equal(user.source, 'user');
  assert.deepEqual(user.providers.map(p => p.id), ['personal']);
  assert.equal(loadProviders({ cwd: repo, env }).source, 'repo');
});

test('the file size limit counts bytes, not characters', t => {
  const dir = tmp(t), file = join(dir, 'providers.json');
  // 140k two-byte characters: under the limit as characters, over it as bytes.
  writeFileSync(file, JSON.stringify({ providers: [{ id: 'x', kind: 'codex', family: 'openai' }], pad: 'é'.repeat(140000) }));
  assert.throws(() => loadProviders({ cwd: dir, env: { RELAYKIT_PROVIDERS: file } }), /larger than/);
});

test('the editor API reports a repo override so the page can warn about it', async t => {
  const dir = tmp(t), file = join(dir, 'providers.json');
  const probe = createProvidersUi({ load: () => ({}), file, port: 1 });
  await new Promise(resolve => probe.server.listen(0, '127.0.0.1', resolve));
  const port = probe.server.address().port;
  await new Promise(resolve => probe.server.close(resolve));
  const ui = createProvidersUi({ load: () => ({ source: 'user', file, providers: defaults(), repoOverride: '/repo/.ai/providers.json' }), file, port });
  await new Promise(resolve => ui.server.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { ui.server.close(resolve); ui.server.closeAllConnections(); }));
  const api = await (await fetch(`http://127.0.0.1:${port}/api/providers`)).json();
  assert.equal(api.repoOverride, '/repo/.ai/providers.json');
});
