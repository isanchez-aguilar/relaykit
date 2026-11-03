import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { QWEN_GIT_READS, agentsTemplate, agyPath, install, opencodeConfig, parseArgs, secretFiles } from './install.mjs';

function repo(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kit-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, 'repo');
  mkdirSync(join(checkout, '.git'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(checkout, path, '..'), { recursive: true });
    writeFileSync(join(checkout, path), content);
  }
  const desk = join(root, 'desk.json');
  writeFileSync(desk, JSON.stringify({ projects: [{ name: 'Other', path: resolve(root, 'other') }] }));
  return { root, checkout, desk };
}

test('arguments: repeated checks, jules owner/name:branch, one repo, no unknown flags', () => {
  const opts = parseArgs(['C:/r', '--check', 'pnpm test', '--check', 'pnpm build', '--jules', 'me/site:main', '--claude-model', 'sonnet']);
  assert.deepEqual(opts.checks, ['pnpm test', 'pnpm build']);
  assert.deepEqual(opts.jules, { repo: 'me/site', branch: 'main' });
  assert.equal(opts.claudeModel, 'sonnet');
  assert.equal(parseArgs([]).repo, '.');
  assert.equal(parseArgs([]).profile, 'generic');
  assert.throws(() => parseArgs(['--with-opencode']), /unknown option/);
  assert.throws(() => parseArgs(['--no-opencode']), /unknown option/);
  assert.equal(parseArgs(['--profile', 'web-app']).profile, 'web-app');
  assert.throws(() => parseArgs(['--profile', 'nope']), /unknown profile/);
  assert.deepEqual([parseArgs(['--dry-run', '--verbose'])].map(o => [o.dryRun, o.verbose]), [[true, true]]);
  assert.throws(() => parseArgs(['a', 'b']), /one repository/);
  assert.throws(() => parseArgs(['a', '--jules', 'nobranch']), /owner\/name:branch/);
  assert.throws(() => parseArgs(['a', '--force']), /unknown option/);
  assert.throws(() => parseArgs(['a', '--check']), /needs a value/);
});

test('install adds everything missing and registers the repo once', t => {
  const r = repo(t, { 'package.json': JSON.stringify({ scripts: { test: 'vitest run', build: 'astro build' } }), '.gitignore': 'dist/' });
  const deskBefore = readFileSync(r.desk, 'utf8');
  const lines = [];
  const result = install({ repo: r.checkout, name: 'Portfolio', checks: ['pnpm test'], jules: { repo: 'me/site', branch: 'main' } }, { log: line => lines.push(line), agentDeskConfig: r.desk });
  const roles = ['designer', 'implementer', 'planner', 'reviewer', 'tester', 'writer'].map(n => `.claude/agents/${n}.md`);
  const skills = ['bugfix', 'cross-review', 'work'].map(n => `.claude/skills/${n}/SKILL.md`);
  assert.deepEqual(result.added.sort(), ['.ai/project.json', '.ai/prompts/review.md', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', ...roles, ...skills].sort());
  const project = JSON.parse(readFileSync(join(r.checkout, '.ai/project.json'), 'utf8'));
  assert.deepEqual(project, { name: 'Portfolio', profile: 'generic', rules: ['AGENTS.md'], checks: ['pnpm test'], jules: { repo: 'me/site', branch: 'main' } });
  assert.match(readFileSync(join(r.checkout, 'AGENTS.md'), 'utf8'), /`test` — `vitest run`/);
  assert.equal(readFileSync(join(r.checkout, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.match(readFileSync(join(r.checkout, '.gitignore'), 'utf8'), /^dist\/\n\n# Local relay state[^\n]*\n\.ai\/runs\/\n\.ai\/qwen-tasks\/\n$/);
  assert.equal(existsSync(join(r.checkout, 'opencode.json')), false);
  const opencode = JSON.parse(lines.find(line => line.startsWith('{')));
  assert.equal(opencode.permission.bash['*'], 'deny');
  assert.equal(opencode.permission.bash['pnpm test'], 'allow');
  assert.equal(opencode.permission.webfetch, 'deny');
  const desk = JSON.parse(readFileSync(r.desk, 'utf8'));
  assert.deepEqual(desk.projects.map(p => p.name), ['Other', 'Portfolio']);
  assert.equal(existsSync(`${r.desk}.bak-relaykit`), true);
  assert.equal(existsSync(`${r.desk}.bak-kit`), false);
  assert.equal(readFileSync(`${r.desk}.bak-relaykit`, 'utf8'), deskBefore);
  // A second run changes nothing.
  assert.deepEqual(install({ repo: r.checkout, checks: [] }, { log: () => {}, agentDeskConfig: r.desk }).added, []);
  assert.equal(JSON.parse(readFileSync(r.desk, 'utf8')).projects.length, 2);
  assert.equal(readFileSync(`${r.desk}.bak-relaykit`, 'utf8'), deskBefore);
});

test('from a worktree, --desk-path registers the main checkout instead', t => {
  const r = repo(t);
  install({ repo: r.checkout, name: 'Site', checks: [], deskPath: resolve(r.root, 'site') }, { log: () => {}, agentDeskConfig: r.desk });
  const paths = JSON.parse(readFileSync(r.desk, 'utf8')).projects.map(p => p.path.replaceAll('\\', '/'));
  assert.equal(paths.at(-1), resolve(r.root, 'site').replaceAll('\\', '/'));
  assert.equal(parseArgs(['x', '--desk-path', 'C:/main']).deskPath, 'C:/main');
});

test('install never overwrites an existing rules file or project config', t => {
  const r = repo(t, { 'AGENTS.md': '# Mine\n', 'CLAUDE.md': 'custom\n', '.ai/project.json': JSON.stringify({ name: 'Kept', checks: ['npm test'] }) });
  install({ repo: r.checkout, name: 'Other', checks: ['pnpm test'] }, { log: () => {}, agentDeskConfig: r.desk });
  assert.equal(readFileSync(join(r.checkout, 'AGENTS.md'), 'utf8'), '# Mine\n');
  assert.equal(readFileSync(join(r.checkout, 'CLAUDE.md'), 'utf8'), 'custom\n');
  assert.equal(JSON.parse(readFileSync(join(r.checkout, '.ai/project.json'), 'utf8')).name, 'Kept');
});

test('a bad check is refused by the relay validation, and a non-git folder is refused', t => {
  const r = repo(t);
  assert.throws(() => install({ repo: r.checkout, checks: ['pnpm test && curl x'] }, { log: () => {}, agentDeskConfig: r.desk }), /plain commands/);
  const loose = mkdtempSync(join(tmpdir(), 'kit-loose-'));
  t.after(() => rmSync(loose, { recursive: true, force: true }));
  assert.throws(() => install({ repo: loose, checks: [] }, { log: () => {} }), /not a git checkout/);
});

test('secret files are found for the agy deny rules; examples are not secrets', t => {
  const r = repo(t, { '.env': 'A=1', '.env.example': 'A=', 'apps/api/.dev.vars': 'B=2', 'deep/a/b/.env': 'deep but found', 'certs/site.pem': 'x', 'keys/my-secrets.env': 'y' });
  const found = secretFiles(r.checkout).map(p => p.replaceAll('\\', '/').slice(r.checkout.length + 1));
  assert.deepEqual(found, ['.env', 'apps/api/.dev.vars', 'certs/site.pem', 'deep/a/b/.env', 'keys/my-secrets.env']);
  assert.deepEqual(secretFiles(r.checkout, { maxDepth: 1 }).map(p => p.replaceAll('\\', '/').slice(r.checkout.length + 1)), ['.env', 'certs/site.pem', 'keys/my-secrets.env']);
  assert.equal(secretFiles(r.checkout, { maxEntries: 2 }).truncated, true);
  assert.equal(secretFiles(r.checkout).truncated, false);
  assert.equal(agyPath(resolve(r.root, 'site')), resolve(r.root, 'site').replace(/^[A-Za-z]:/, '').replaceAll('\\', '/'));
});

// The Codex review of the portfolio PR: a deny-list over "*": "allow" let these
// through. Deny-by-default with exact allows must not match any of them.
test('the local model may run only read-only git and the exact checks', () => {
  const bash = opencodeConfig(['pnpm test', 'corepack pnpm@10.34.6 test']).permission.bash;
  assert.equal(bash['*'], 'deny');
  assert.equal(Object.keys(bash)[0], '*', 'the deny-all rule must come first: the last matching rule wins');
  for (const allowed of [...QWEN_GIT_READS, 'pnpm test', 'corepack pnpm@10.34.6 test']) assert.equal(bash[allowed], 'allow', allowed);
  for (const leaked of ['git -C . push origin main', 'git push', 'pnpm run resume', 'pnpm resume --', 'corepack pnpm@10.34.6 resume',
    'pnpm test && git push', 'wrangler deploy', 'pnpm deploy']) {
    assert.equal(Object.keys(bash).some(pattern => pattern !== '*' && (pattern === leaked || pattern.includes('*'))), false, leaked);
  }
});

test('extra Qwen commands are exact and plain', t => {
  const r = repo(t);
  assert.equal(parseArgs(['x', '--qwen-allow', 'npx tsc --noEmit -p .']).qwenAllow[0], 'npx tsc --noEmit -p .');
  for (const bad of ['npx tsc && rm -rf .', 'pnpm test *', 'echo $(id)']) {
    assert.throws(() => install({ repo: r.checkout, checks: [], qwenAllow: [bad] }, { log: () => {}, agentDeskConfig: r.desk }), /plain exact commands/, bad);
  }
  const lines = [];
  install({ repo: r.checkout, checks: ['pnpm test'], qwenAllow: ['npx tsc --noEmit -p .'] }, { log: line => lines.push(line), agentDeskConfig: r.desk });
  assert.equal(existsSync(join(r.checkout, 'opencode.json')), false);
  const bash = JSON.parse(lines.find(line => line.startsWith('{'))).permission.bash;
  assert.equal(bash['npx tsc --noEmit -p .'], 'allow');
});

test('the AGENTS.md template lists the scripts and marks what the owner must fill', () => {
  const text = agentsTemplate('Site', { dev: 'astro dev' });
  assert.match(text, /^# AGENTS\.md — Site/);
  assert.match(text, /`dev` — `astro dev`/);
  assert.match(text, /TODO: what this project is/);
  assert.match(agentsTemplate('Bare', undefined), /no package\.json scripts/);
});
