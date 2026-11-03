import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeAdditions, missingKeys, missingLines, missingSections, renderAdditions, sections } from './additions.mjs';

const wanted = '# AGENTS.md — X\n\nintro\n\n## Commands\n\n- a\n\n## Delegation\n\n1. Codex\n\n```md\n## Not a heading\n```\n\n## Before delivery\n\nRun checks.\n';

test('sections ignore headings inside code fences', () => {
  assert.deepEqual(sections(wanted).map(s => s.title), ['AGENTS.md — X', 'Commands', 'Delegation', 'Before delivery']);
});

test('only sections the file lacks are missing, matched case- and punctuation-insensitively', () => {
  const existing = '# Mine\n\n## commands:\n\nmy own\n';
  const found = missingSections(existing, wanted);
  assert.deepEqual(found.map(s => s.title), ['Delegation', 'Before delivery']);
  assert.match(found[0].lines.join('\n'), /## Not a heading/);
  assert.equal(found[1].lines.at(-1), 'Run checks.');
  assert.deepEqual(missingSections(wanted, wanted), []);
});

test('pointer files compare by line', () => {
  assert.deepEqual(missingLines('see AGENTS.md\n', '@AGENTS.md\n'), ['@AGENTS.md']);
  assert.deepEqual(missingLines('@AGENTS.md\r\n', '@AGENTS.md\n'), []);
  assert.deepEqual(describeAdditions('CLAUDE.md', 'custom\n', '@AGENTS.md\n'), { status: 'additions', lines: ['@AGENTS.md'] });
  assert.deepEqual(describeAdditions('CLAUDE.md', '@AGENTS.md', '@AGENTS.md\n'), { status: 'identical' });
});

test('json files report the keys that are absent, down the tree', () => {
  const found = missingKeys({ a: 1, permission: { bash: { '*': 'deny' } } }, { a: 2, b: 3, permission: { bash: { '*': 'deny', 'git status': 'allow' }, webfetch: 'deny' } });
  assert.deepEqual(found, ['b: 3', 'permission["bash"]["git status"]: "allow"', 'permission["webfetch"]: "deny"']);
  assert.deepEqual(describeAdditions('x.json', '{"a":1}', '{"a":2}'), { status: 'identical' });
  assert.equal(describeAdditions('x.json', '{broken', '{"a":2}').status, 'differs');
});

test('a script that differs is reported, not diffed; an identical file is identical', () => {
  assert.deepEqual(describeAdditions('scripts/qwen.mjs', 'old', 'new'), { status: 'differs' });
  assert.deepEqual(describeAdditions('scripts/qwen.mjs', 'same\r\n', 'same\n'), { status: 'identical' });
  assert.equal(describeAdditions('AGENTS.md', wanted, wanted).status, 'identical');
});

test('the printed additions are + lines, capped unless verbose', () => {
  const description = describeAdditions('AGENTS.md', '# Mine\n', wanted);
  const lines = renderAdditions(description, { verbose: true });
  assert.equal(lines[0], '+ ## Commands');
  assert.ok(lines.every(l => l.startsWith('+')));
  assert.notEqual(lines.at(-1), '+');
  const capped = renderAdditions(description, { cap: 3 });
  assert.equal(capped.length, 4);
  assert.match(capped[3], /more lines \(rerun with --verbose/);
});
