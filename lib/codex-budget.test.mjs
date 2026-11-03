import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredDocBudget, measureProjects } from './codex-budget.mjs';
import { loadConfig } from './config.mjs';
import { checkSyncDrift } from './doctor.mjs';
import { sync, KIT_DIR } from '../sync.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'relaykit-budget-'));
  t.after(() => rmSync(base, { force: true, recursive: true }));
  const repo = join(base, 'repo'), cwd = join(repo, 'src/feature'), codexHome = join(base, 'codex');
  mkdirSync(cwd, { recursive: true }); mkdirSync(codexHome);
  mkdirSync(join(repo, '.git'));
  const desk = join(base, 'desk.json');
  writeFileSync(desk, JSON.stringify({ projects: [{ path: repo, cwd }] }));
  return { base, repo, cwd, codexHome, desk };
}

test('budget measures effective overrides and nested instruction files through cwd', t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'AGENTS.md'), 'short');
  writeFileSync(join(f.repo, 'AGENTS.override.md'), 'x'.repeat(40000));
  writeFileSync(join(f.repo, 'src/AGENTS.md'), 'nested');
  writeFileSync(join(f.cwd, 'AGENTS.md'), 'unused');
  writeFileSync(join(f.cwd, 'AGENTS.override.md'), 'leaf');
  const result = measureProjects(f.desk);
  assert.deepEqual(result.sizes, [40010]);
  assert.equal(result.files.length, 3);
  assert.deepEqual(result.incomplete, []);
  assert.throws(() => sync({ home: f.base, codexHome: f.codexHome, agentDeskConfig: f.desk, check: true, log: () => {} }), /shorten/);
});

test('global override and configured byte limit affect the budget', t => {
  const f = fixture(t);
  writeFileSync(join(f.codexHome, 'AGENTS.override.md'), 'x'.repeat(40000));
  assert.throws(() => sync({ home: f.base, codexHome: f.codexHome, agentDeskConfig: f.desk, check: true, log: () => {} }), /shorten/);
  writeFileSync(join(f.codexHome, 'config.toml'), 'project_doc_max_bytes = 65_536 # fixture\n[other]\nvalue = 1\n');
  assert.deepEqual(configuredDocBudget(f.codexHome), { limit: 65536, incomplete: [] });
  const lines = [];
  sync({ home: f.base, codexHome: f.codexHome, agentDeskConfig: f.desk, check: true, log: l => lines.push(l) });
  assert.ok(lines.some(l => /40000\/63488/.test(l)));
});

test('a registered subdirectory includes instructions back to the nearest Git root', t => {
  const f = fixture(t), sub = join(f.repo, 'sub');
  mkdirSync(sub);
  writeFileSync(join(f.repo, 'AGENTS.md'), 'x'.repeat(40000));
  writeFileSync(join(sub, 'AGENTS.md'), 'small');
  for (const project of [{ path: sub, cwd: sub }, { path: sub }]) {
    writeFileSync(f.desk, JSON.stringify({ projects: [project] }));
    const result = measureProjects(f.desk, { cwd: sub });
    assert.deepEqual(result.sizes, [40005]);
    assert.deepEqual(result.incomplete, []);
    assert.throws(() => sync({ home: f.base, codexHome: f.codexHome, agentDeskConfig: f.desk, cwd: sub, check: true, log: () => {} }), /shorten/);
  }
});

test('missing Git roots report incomplete coverage', t => {
  const f = fixture(t);
  rmSync(join(f.repo, '.git'), { recursive: true });
  assert.ok(measureProjects(f.desk).incomplete.some(m => /project root.*unknown/.test(m)));
});

test('quoted TOML budget keys are recognized and unsupported discovery forms warn', t => {
  const f = fixture(t);
  for (const quote of ['"', "'"]) {
    writeFileSync(join(f.codexHome, 'config.toml'), `${quote}project_doc_max_bytes${quote} = 65_536`);
    assert.deepEqual(configuredDocBudget(f.codexHome), { limit: 65536, incomplete: [] });
    for (const key of ['project_doc_fallback_filenames', 'project_root_markers', 'profile', 'model_instructions_file']) {
      writeFileSync(join(f.codexHome, 'config.toml'), `${quote}${key}${quote} = ["RULES.md"]`);
      assert.ok(configuredDocBudget(f.codexHome).incomplete.length, key);
    }
  }
  for (const text of ['profiles.small.project_doc_fallback_filenames = ["RULES.md"]',
    '[profiles.small]\n"project_doc_fallback_filenames" = ["RULES.md"]',
    '[project_doc_fallback_filenames]\nfiles = ["RULES.md"]',
    'profiles.small.project_doc_max_bytes = 1024']) {
    writeFileSync(join(f.codexHome, 'config.toml'), text);
    assert.ok(configuredDocBudget(f.codexHome).incomplete.length, text);
  }
});

test('quoted keys written with escape sequences are reported, not skipped', t => {
  const f = fixture(t);
  for (const text of ['"\\u0070roject_doc_fallback_filenames" = ["RULES.md"]', '"\\u0070roject_doc_max_bytes" = 1024']) {
    writeFileSync(join(f.codexHome, 'config.toml'), text);
    const result = configuredDocBudget(f.codexHome);
    assert.ok(result.incomplete.some(m => /escape sequence/.test(m)), text);
  }
});

test('the current cwd is measured even when the registry also records a different cwd', t => {
  const f = fixture(t);
  writeFileSync(f.desk, JSON.stringify({ projects: [{ path: f.repo, cwd: f.repo }] }));
  writeFileSync(join(f.cwd, 'AGENTS.md'), 'x'.repeat(40000));
  assert.deepEqual(measureProjects(f.desk, { cwd: f.cwd }).sizes, [0, 40000]);
});

test('unknown paths, missing cwd and unreadable or unsupported config report incomplete coverage', t => {
  const f = fixture(t);
  writeFileSync(f.desk, JSON.stringify({ projects: [{ path: f.repo }, { path: join(f.base, 'gone') }] }));
  const result = measureProjects(f.desk);
  assert.ok(result.incomplete.some(m => /nested working directory unknown/.test(m)));
  assert.ok(result.incomplete.some(m => /could not be evaluated/.test(m)));
  mkdirSync(join(f.codexHome, 'config.toml'));
  assert.match(configuredDocBudget(f.codexHome).incomplete[0], /unreadable/);
  rmSync(join(f.codexHome, 'config.toml'), { recursive: true });
  for (const text of ['project_doc_max_bytes = "wrong"', '[profiles.small]\nproject_doc_max_bytes = 1024', 'project_doc_fallback_filenames = ["RULES.md"]']) {
    writeFileSync(join(f.codexHome, 'config.toml'), text);
    assert.ok(configuredDocBudget(f.codexHome).incomplete.length);
  }
  writeFileSync(f.desk, '{"projects":[null]}');
  assert.ok(measureProjects(f.desk, { cwd: f.cwd }).incomplete.length);
});

test('a broken instruction symlink reports incomplete coverage', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  symlinkSync(join(f.base, 'missing'), join(f.repo, 'AGENTS.override.md'));
  assert.ok(measureProjects(f.desk).incomplete.length);
});

test('CODEX_HOME is resolved once and doctor checks that directory', t => {
  const f = fixture(t);
  const config = loadConfig({ env: { CODEX_HOME: f.codexHome }, home: f.base, exists: () => false });
  assert.equal(config.values.codexHome, f.codexHome);
  assert.equal(config.sources.codexHome, 'env');
  const state = checkSyncDrift({ home: f.base, codexHome: config.values.codexHome, kitDir: KIT_DIR, agentDeskConfig: f.desk });
  assert.ok(state.drift.includes(join(f.codexHome, 'AGENTS.md')));
  assert.ok(!state.drift.includes(join(f.base, '.codex/AGENTS.md')));
});
