import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { install } from '../install.mjs';
import { parseSource } from '../sync.mjs';
import { PROFILE_NAMES, PROFILES, profileFiles } from './profiles.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = () => {};

function repo(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'relayrace-profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.git'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const listed = (root, dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).sort() : []);
const read = (root, path) => readFileSync(join(root, path), 'utf8');

test('generic installs the six roles, three skills, the review prompt and the pointers', t => {
  const root = repo(t);
  const result = install({ repo: root, profile: 'generic', checks: [] }, { log: quiet });
  assert.deepEqual(listed(root, '.claude/agents'), ['designer.md', 'implementer.md', 'planner.md', 'reviewer.md', 'tester.md', 'writer.md']);
  assert.deepEqual(listed(root, '.claude/skills'), ['bugfix', 'cross-review', 'work']);
  assert.equal(read(root, 'CLAUDE.md'), '@AGENTS.md\n');
  assert.match(read(root, 'GEMINI.md'), /Read AGENTS\.md/);
  assert.match(read(root, 'AGENTS.md'), /^# AGENTS\.md — relayrace-profile-/);
  assert.equal(existsSync(join(root, 'opencode.json')), false);
  assert.equal(existsSync(join(root, 'scripts/qwen.mjs')), false);
  assert.equal(JSON.parse(read(root, '.ai/project.json')).profile, 'generic');
  assert.equal(result.dryRun, false);
});

test('web-app installs the six-role pipeline, its skills, the Qwen runner and a Project rules section', t => {
  const root = repo(t, { 'package.json': JSON.stringify({ scripts: { gate: 'run-all' } }) });
  install({ repo: root, profile: 'web-app', name: 'Shop', checks: [] }, { log: quiet });
  assert.deepEqual(listed(root, '.claude/agents'), ['architect.md', 'developer.md', 'docs-writer.md', 'program-manager.md', 'qa.md', 'ui-designer.md']);
  assert.deepEqual(listed(root, '.claude/skills'), ['cross-review', 'feature', 'fix', 'qwen', 'redesign-module', 'release-local']);
  const agents = read(root, 'AGENTS.md');
  assert.match(agents, /^# AGENTS\.md — Shop/);
  assert.match(agents, /`gate` — `run-all`/);
  assert.match(agents, /^## Project rules$/m);
  assert.match(agents, /5\. Codex: implementation, reviews and tests\./);
  assert.equal(read(root, 'scripts/qwen.mjs'), readFileSync(join(KIT, 'qwen.mjs'), 'utf8').replace(/\r\n/g, '\n'));
  assert.equal(JSON.parse(read(root, '.ai/project.json')).profile, 'web-app');
  const runner = spawnSync(process.execPath, [join(root, 'scripts/qwen.mjs'), '--task'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, QWEN_ROOT: root, RELAYRACE_CONFIG: join(root, 'missing-config.json') },
  });
  assert.equal(runner.status, 2);
  assert.match(runner.stderr, /--task needs a value/);
  assert.doesNotMatch(runner.stderr, /ERR_MODULE_NOT_FOUND/);
});

test('notes installs the writer role only: no Qwen files, no gitignore lines', t => {
  const root = repo(t);
  install({ repo: root, profile: 'notes', checks: [] }, { log: quiet });
  assert.deepEqual(listed(root, '.claude/agents'), ['writer.md']);
  assert.deepEqual(listed(root, '.claude/skills'), []);
  assert.equal(existsSync(join(root, 'opencode.json')), false);
  assert.equal(existsSync(join(root, '.gitignore')), false);
  assert.match(read(root, 'AGENTS.md'), /Never store secrets/);
});

test('all profiles leave permissions unwritten, even with the removed programmatic option', t => {
  for (const profile of PROFILE_NAMES) {
    const root = repo(t), lines = [];
    install({ repo: root, profile, checks: [], opencode: true }, { log: line => lines.push(line) });
    assert.equal(existsSync(join(root, 'opencode.json')), false);
    assert.equal(lines.some(line => line.startsWith('Proposed opencode.json')), profile !== 'notes');
  }
});

test('every profile is a no-op the second time', t => {
  for (const profile of PROFILE_NAMES) {
    const root = repo(t);
    install({ repo: root, profile, checks: [] }, { log: quiet });
    const again = install({ repo: root, profile, checks: [] }, { log: quiet });
    assert.deepEqual(again.added, [], profile);
    assert.ok(again.kept.every(k => k.status === 'identical'), profile);
  }
});

test('a dry run reports what it would add and writes nothing', t => {
  const root = repo(t);
  const lines = [];
  const result = install({ repo: root, profile: 'web-app', checks: [], dryRun: true }, { log: l => lines.push(l) });
  assert.equal(result.dryRun, true);
  assert.ok(result.added.includes('.claude/agents/qa.md'));
  assert.deepEqual(readdirSync(root), ['.git']);
  assert.ok(lines.some(l => /would add\s+scripts\/qwen\.mjs/.test(l)));
  assert.ok(lines.includes('\nDry run: nothing was written.'));
});

test('existing files are never overwritten; the missing sections are printed', t => {
  const root = repo(t, {
    'AGENTS.md': '# AGENTS.md — Mine\n\n## Commands\n\n- `go` — `go test`\n\n- **Language:** English.\n',
    'CLAUDE.md': '@AGENTS.md\n',
    '.claude/agents/qa.md': 'my own qa\n',
  });
  const lines = [];
  const result = install({ repo: root, profile: 'web-app', checks: [] }, { log: l => lines.push(l) });
  assert.match(read(root, 'AGENTS.md'), /^# AGENTS\.md — Mine/);
  assert.equal(read(root, '.claude/agents/qa.md'), 'my own qa\n');
  const agents = result.kept.find(k => k.path === 'AGENTS.md');
  assert.equal(agents.status, 'additions');
  assert.deepEqual(agents.sections.map(s => s.title), ['Project in one sentence', 'Architecture', 'Project rules', 'Testing', 'Documentation', 'Delegation', 'Before delivery']);
  assert.ok(lines.includes('           + ## Project rules'));
  assert.equal(result.kept.find(k => k.path === 'CLAUDE.md').status, 'identical');
  assert.equal(result.kept.find(k => k.path === '.claude/agents/qa.md').status, 'additions');
  assert.equal(result.added.includes('AGENTS.md'), false);
});

test('Agent Desk registration is skipped with a note when it is not configured', t => {
  const root = repo(t);
  const lines = [];
  install({ repo: root, profile: 'generic', checks: [] }, { log: l => lines.push(l) });
  assert.ok(lines.some(l => /^skipped\s+Agent Desk registration \(not configured/.test(l)));
  const missing = [];
  install({ repo: root, profile: 'generic', checks: [], agentDeskConfig: undefined }, { log: l => missing.push(l), agentDeskConfig: join(root, 'nope.json') });
  assert.ok(missing.some(l => /nope\.json not found/.test(l)));
});

test('an unknown profile is refused', t => {
  const root = repo(t);
  assert.throws(() => install({ repo: root, profile: 'nope', checks: [] }, { log: quiet }), /unknown profile "nope"/);
  assert.throws(() => profileFiles('nope', { kitDir: KIT, name: 'x' }), /unknown profile/);
});

// What the profiles ship has to hold up on its own: valid roles, no project names,
// no machine paths, no per-file license header.
test('installed roles and skills have valid frontmatter, a pinned model and nothing project-specific', t => {
  const names = new Map();
  for (const profile of PROFILE_NAMES) {
    for (const file of profileFiles(profile, { kitDir: KIT, name: 'Demo', scripts: {} })) {
      const where = `${profile}:${file.path}`;
      assert.doesNotMatch(file.content, /C:[\\/]Users|\/Users\/[A-Za-z]|notes[\\/]IA local/, `${where} has a machine path`);
      if (file.path !== 'scripts/qwen.mjs') assert.doesNotMatch(file.content, /StyleX|Hono|Drizzle/i, `${where} names a project`);
      assert.doesNotMatch(file.content, /Copyright|SPDX-License|Licensed under/i, `${where} carries a license header`);
      if (file.kind === 'agent') {
        const { fields } = parseSource(file.content, where);
        assert.equal(`${fields.name}.md`, file.path.split('/').at(-1), where);
        assert.ok(fields.model && fields.model !== 'inherit' && !/fable/i.test(fields.model), `${where} must pin a real model`);
        assert.ok(['haiku', 'sonnet', 'opus'].includes(fields.model), where);
        names.set(`${profile}:${fields.name}`, fields.model);
      }
      if (file.kind === 'skill') {
        const { fields } = parseSource(file.content, where);
        assert.equal(fields.name, file.path.split('/').at(-2), where);
      }
    }
  }
  // Opus is reserved for the rare money/security judgement: the web-app pipeline defaults to sonnet.
  for (const [key, model] of names) if (key.startsWith('web-app:')) assert.equal(model, 'sonnet', key);
  assert.ok(Object.keys(PROFILES).every(p => PROFILES[p].about.length > 10));
});

test('the delegation order is written in plain terms in every AGENTS.md template', () => {
  for (const profile of ['generic', 'web-app']) {
    const text = profileFiles(profile, { kitDir: KIT, name: 'Demo', scripts: {} }).find(f => f.path === 'AGENTS.md').content;
    const order = ['Qwen', 'Jules', 'Gemini', "Antigravity's Claude", 'Codex', 'Claude Code subagents'].map(w => text.indexOf(w, text.indexOf('## Delegation')));
    assert.ok(order.every(i => i > 0), profile);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${profile}: providers listed out of order`);
    assert.match(text, /Never Fable without the owner's yes/);
  }
});

test('all installable source trees are free of personal names', () => {
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else assert.doesNotMatch(readFileSync(file, 'utf8'), /Isaac/i, file);
    }
  };
  for (const dir of ['agents', 'skills', 'templates', 'prompts']) walk(join(KIT, dir));
});

test('installed web-app rules keep examples inactive and require a gate decision', () => {
  const text = profileFiles('web-app', { kitDir: KIT, name: 'Demo', scripts: {} }).find(f => f.path === 'AGENTS.md').content;
  const rules = text.split('## Project rules')[1].split('## Testing')[0];
  assert.match(rules, /<!-- Example: Isolation:/);
  assert.doesNotMatch(rules.replace(/<!--[\s\S]*?-->/g, ''), /Language:|Isolation:|every query|…/);
  assert.match(text, /gate is still unspecified, agents must ask\nthe owner/);
  for (const profile of ['generic', 'web-app']) {
    assert.match(read(KIT, `templates/${profile}/AGENTS.md`), /https:\/\/github\.com\/isanchez-aguilar\/relayrace-ai\/blob\/main\/docs\/playbooks\/model-selection\.md/);
  }
});
