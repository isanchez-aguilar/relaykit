import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MAX_TURNS, allowedTools, loadProject, loadTask, nextState, parseEnvelope, relayPriority, runRelay } from './relay.mjs';

test('the documented task fixture passes the production relay and Jules loader', () => {
  const fixture = new URL('./tests/fixtures/task.example.json', import.meta.url);
  const relay = loadTask(fixture);
  assert.equal(relay.id, 'document-health-check');
  assert.deepEqual(loadTask(fixture, { repo: 'example/project', branch: 'main' }), relay);
  assert.throws(() => loadTask(fixture, { repo: 'other/project', branch: 'main' }), /jules:/);
  assert.throws(() => loadTask(fixture, { repo: 'example/project', branch: 'dev' }), /jules:/);
});

test('task loader rejects malformed required fields before either runner can invoke a CLI', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'relayrace-task-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const file = join(cwd, 'task.json');
  const valid = { id: 'valid-1', objective: 'Document behavior', acceptance: ['Observable result'] };
  for (const value of [null, [], {}, { ...valid, id: 123 }, { ...valid, id: '../escape' },
    { ...valid, id: 'a'.repeat(62) }, { ...valid, objective: ' ' }, { ...valid, acceptance: [] },
    { ...valid, acceptance: [' '] }, { ...valid, acceptance: [1] }]) {
    writeFileSync(file, JSON.stringify(value));
    for (const cloud of [undefined, { repo: 'example/project', branch: 'main' }]) {
      assert.throws(() => loadTask(file, cloud), /Task needs/);
    }
    assert.throws(() => runRelay(file, { cwd, invoke: () => assert.fail('must not invoke CLI') }), /Task needs/);
    assert.equal(existsSync(join(cwd, '.ai/runs')), false);
  }
});

test('task loader accepts the minimum and maximum id lengths without changing task content', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'relayrace-task-boundary-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const file = join(cwd, 'task.json');
  for (const id of ['0', 'a'.repeat(61)]) {
    const task = { id, objective: '  Document behavior  ', acceptance: [' Observable result '], jules: { repo: 'example/project', branch: 'main' } };
    writeFileSync(file, JSON.stringify(task));
    assert.deepEqual(loadTask(file), task);
    assert.deepEqual(loadTask(file, task.jules), task);
  }
  writeFileSync(file, '{');
  assert.throws(() => loadTask(file), SyntaxError);
});

test('a repo without .ai/project.json reads AGENTS.md and preapproves nothing', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'kit-project-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const project = loadProject(cwd);
  assert.deepEqual(project.rules, ['AGENTS.md']);
  assert.deepEqual(project.checks, []);
  assert.equal(project.jules, null);
});

test('project checks are plain commands; chaining or substitution is refused', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'kit-project-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.ai'));
  const write = value => writeFileSync(join(cwd, '.ai/project.json'), JSON.stringify(value));
  write({ name: 'Portfolio', rules: ['AGENTS.md'], checks: ['pnpm test', 'pnpm build'] });
  assert.equal(loadProject(cwd).name, 'Portfolio');
  assert.deepEqual(allowedTools(loadProject(cwd).checks), ['Bash(pnpm test)', 'PowerShell(pnpm test)', 'Bash(pnpm build)', 'PowerShell(pnpm build)']);
  for (const bad of ['pnpm test && rm -rf .', 'pnpm test; curl x', 'pnpm test | tee', 'echo $(whoami)', 'cat > f', '']) {
    write({ checks: [bad] });
    assert.throws(() => loadProject(cwd), /plain commands/, bad);
  }
  write({ rules: [] });
  assert.throws(() => loadProject(cwd), /rules/);
});

test('the prompt names the project rules and Claude only gets the project checks', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'kit-relay-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.ai'));
  writeFileSync(join(cwd, '.ai/project.json'), JSON.stringify({ name: 'Portfolio', rules: ['AGENTS.md', 'docs/STYLE.md'], checks: ['pnpm test'] }));
  const task = join(cwd, 'task.json');
  writeFileSync(task, JSON.stringify({ id: 'prompt', objective: 'Fixture', acceptance: ['Fixture works'] }));
  const seen = [];
  const invoke = (exe, args, options) => {
    if (args[0] === '--version') return { status: 0 };
    if (args[0] === 'auth') return { status: 0, stdout: JSON.stringify({ loggedIn: true }) };
    seen.push({ args, input: options.input });
    return { status: 0, stdout: JSON.stringify({ status: 'SUCCESS', response: JSON.stringify(report('blocked')) }) };
  };
  assert.equal(runRelay(task, { cwd, invoke }).status, 'blocked');
  const { args, input: prompt } = seen[0];
  assert.ok(!args.includes(prompt));
  assert.match(prompt, /Read AGENTS\.md, docs\/STYLE\.md first/);
  assert.match(prompt, /checkout of Portfolio/);
  assert.doesNotMatch(prompt, /AI_RELAY/);
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--output-format')), ['Bash(pnpm test)', 'PowerShell(pnpm test)']);
});

test('Claude is pinned to sonnet by default, and Fable needs an explicit approval', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'kit-project-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(loadProject(cwd).claudeModel, 'sonnet');
  mkdirSync(join(cwd, '.ai'));
  writeFileSync(join(cwd, '.ai/project.json'), JSON.stringify({ claudeModel: 'opus' }));
  assert.equal(loadProject(cwd).claudeModel, 'opus', 'a project can still choose opus on purpose');
  rmSync(join(cwd, '.ai/project.json'));
  const write = value => writeFileSync(join(cwd, '.ai/project.json'), JSON.stringify(value));
  write({ claudeModel: 'sonnet' });
  assert.equal(loadProject(cwd).claudeModel, 'sonnet');
  const saved = process.env.KIT_ALLOW_FABLE;
  delete process.env.KIT_ALLOW_FABLE;
  try {
    for (const fable of ['fable', 'claude-fable-5-1']) {
      write({ claudeModel: fable });
      assert.throws(() => loadProject(cwd), /approval/);
    }
    process.env.KIT_ALLOW_FABLE = '1';
    assert.equal(loadProject(cwd).claudeModel, 'claude-fable-5-1');
  } finally {
    if (saved === undefined) delete process.env.KIT_ALLOW_FABLE;
    else process.env.KIT_ALLOW_FABLE = saved;
  }
  write({ claudeModel: 'opus; rm -rf .' });
  assert.throws(() => loadProject(cwd), /alias or id/);
});

test('no checks means no --allowedTools flag at all, not an empty one', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'kit-relay-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const task = join(cwd, 'task.json');
  writeFileSync(task, JSON.stringify({ id: 'bare', objective: 'Fixture', acceptance: ['Fixture works'] }));
  const seen = [];
  const invoke = (exe, args) => {
    if (args[0] === '--version') return { status: 0 };
    if (args[0] === 'auth') return { status: 0, stdout: JSON.stringify({ loggedIn: true }) };
    seen.push(args);
    return { status: 0, stdout: JSON.stringify({ status: 'SUCCESS', response: JSON.stringify(report('blocked')) }) };
  };
  runRelay(task, { cwd, invoke });
  assert.equal(seen[0].includes('--allowedTools'), false);
  assert.equal(seen[0][seen[0].indexOf('--model') + 1], 'sonnet');
});

const report = status => ({ status, summary: 'Verified step', next: '', evidence: 'typecheck and affected tests passed' });
const initial = { status: 'running', phase: 'implement', turns: 0, implementer: null };

test('completion requires a different reviewer and evidence', () => {
  const review = nextState(initial, 'agy', report('done'));
  assert.equal(review.status, 'running');
  assert.equal(nextState(review, 'agy', report('done')).status, 'running');
  assert.equal(nextState(review, 'codex', { ...report('done'), evidence: '' }).status, 'running');
  assert.equal(nextState(review, 'codex', report('done')).status, 'done');
});

test('last implementer owns review exclusion and blocking never means success', () => {
  const changed = nextState({ ...initial, implementer: 'claude' }, 'agy', report('review'));
  assert.equal(changed.implementer, 'agy');
  assert.equal(nextState(changed, 'codex', report('blocked')).status, 'blocked');
  assert.throws(() => nextState(initial, 'agy', {}), /Invalid handoff/);
});

test('a reviewer sending findings back stays the reviewer, not the implementer', () => {
  const review = nextState({ ...initial, implementer: 'claude' }, 'claude', report('review'));
  const findings = nextState(review, 'codex', report('continue'));
  assert.equal(findings.phase, 'implement');
  assert.equal(findings.implementer, 'claude');
  // Whoever then fixes it becomes the implementer the next review must exclude.
  const fixed = nextState(findings, 'codex', report('review'));
  assert.equal(fixed.implementer, 'codex');
  assert.equal(nextState(fixed, 'codex', report('done')).status, 'running');
});

function scenario(t, responses) {
  const cwd = mkdtempSync(join(tmpdir(), 'project-relay-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const task = join(cwd, 'task.json');
  writeFileSync(task, JSON.stringify({ id: 'test', objective: 'Fixture', acceptance: ['Fixture works'] }));
  const calls = [];
  const invoke = (exe, args) => {
    const id = /codex/i.test(exe) ? 'codex' : /agy/i.test(exe) ? 'agy' : 'claude';
    if (args[0] === '--version') return { status: id === 'claude' ? 1 : 0 };
    calls.push(id);
    const response = responses.shift();
    assert.ok(response, 'unexpected extra model invocation');
    if (response.error) return { status: 1, stderr: response.error };
    if (response.raw) return { status: 0, stdout: response.raw };
    if (id === 'codex') writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(response));
    return { status: 0, stdout: JSON.stringify({ status: 'SUCCESS', response: JSON.stringify(response) }) };
  };
  return { cwd, task, invoke, calls };
}

test('relay transfers handoff, completes review and resumes without spending again', t => {
  const s = scenario(t, [report('review'), report('done')]);
  assert.equal(runRelay(s.task, s).status, 'done');
  assert.deepEqual(s.calls, ['agy', 'codex']);
  assert.equal(runRelay(s.task, s).status, 'done');
  assert.equal(s.calls.length, 2);
  assert.equal(existsSync(join(s.cwd, '.ai/runs/relay.lock')), false);
});

test('exhausted providers stop without claiming tasks done', t => {
  const s = scenario(t, [{ error: 'quota exhausted' }, { error: 'usage limit reached' }]);
  assert.equal(runRelay(s.task, s).status, 'unavailable');
  assert.equal(s.calls.length, 2);
});

test('approval denial stops immediately instead of hopping to bypass it', t => {
  const s = scenario(t, [{ error: 'permission denied' }]);
  assert.equal(runRelay(s.task, s).status, 'blocked');
  assert.equal(s.calls.length, 1);
});

test('resume preserves files and clears a resolved blocker from completion', t => {
  const s = scenario(t, [{ error: 'permission denied' }, report('review'), report('done')]);
  assert.equal(runRelay(s.task, s).status, 'blocked');
  const done = runRelay(s.task, s);
  assert.equal(done.status, 'done');
  assert.equal(done.reason, undefined);
});

test('envelope parsing skips a notice line ahead of the JSON', () => {
  assert.deepEqual(parseEnvelope('{"status":"SUCCESS"}'), { status: 'SUCCESS' });
  assert.deepEqual(parseEnvelope('jetski: no output produced\n{"status":"SUCCESS"}'), { status: 'SUCCESS' });
  assert.deepEqual(parseEnvelope('{\n  "status": "SUCCESS"\n}'), { status: 'SUCCESS' });
  assert.deepEqual(parseEnvelope('not json at all'), {});
  assert.deepEqual(parseEnvelope(''), {});
});

// Measured 2026-10-05: a headless read without a permissions.allow rule.
test('an Antigravity tool denial stops as a permission, not as a bad handoff', t => {
  const denied = JSON.stringify({ status: 'SUCCESS', response: '', denied_actions: [{ action: 'read_file', display_name: 'ViewFile' }] });
  for (const raw of [denied, `jetski: no output produced — a tool required the "read_file" permission\n${denied}`]) {
    const s = scenario(t, [{ raw }]);
    const blocked = runRelay(s.task, s);
    assert.equal(blocked.status, 'blocked');
    assert.match(blocked.reason, /Permission required by agy/);
    assert.equal(s.calls.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(s.cwd, '.ai/runs/test/denials-1.json'), 'utf8')), [{ action: 'read_file', display_name: 'ViewFile' }]);
  }
});

test('invalid provider output persists a blocker without continuing', t => {
  const s = scenario(t, [{ status: 'done' }]);
  const blocked = runRelay(s.task, s);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reason, /Invalid handoff/);
  assert.equal(s.calls.length, 1);
  assert.equal(JSON.parse(readFileSync(join(s.cwd, '.ai/runs/test/state.json'), 'utf8')).status, 'blocked');
});

// Reworded handoffs never trip the identical-handoff check; the cap does.
test('a run stops at its turn limit and the same command resumes it', t => {
  const stalled = n => ({ ...report('continue'), summary: `Still investigating, attempt ${n}` });
  const s = scenario(t, [stalled(1), stalled(2), stalled(3), report('review'), report('done')]);
  const capped = runRelay(s.task, { ...s, maxTurns: 3 });
  assert.equal(capped.status, 'blocked');
  assert.match(capped.reason, /Turn limit of 3 reached/);
  assert.equal(s.calls.length, 3);
  assert.equal(existsSync(join(s.cwd, '.ai/runs/relay.lock')), false);
  assert.equal(runRelay(s.task, { ...s, maxTurns: 3 }).status, 'done');
  assert.equal(s.calls.length, 5);
});

test('the turn limit is a positive integer and defaults to 20', t => {
  assert.equal(DEFAULT_MAX_TURNS, 20);
  const s = scenario(t, []);
  for (const maxTurns of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => runRelay(s.task, { ...s, maxTurns }), /positive integer/);
  }
  assert.equal(s.calls.length, 0);
});

test('changing acceptance criteria cannot reuse a completed task', t => {
  const s = scenario(t, [report('review'), report('done')]);
  runRelay(s.task, s);
  const task = JSON.parse(readFileSync(s.task, 'utf8'));
  task.acceptance.push('New requirement');
  writeFileSync(s.task, JSON.stringify(task));
  assert.throws(() => runRelay(s.task, s), /Task changed/);
});

const entry = (kind, can, { enabled = true, family = 'other' } = {}) => ({ kind, can, enabled, family });

test('relayPriority lists, per phase, the CLIs whose enabled entries declare the capability', () => {
  const list = [
    entry('qwen', ['mechanical']), entry('jules', ['implement']),
    entry('antigravity', ['mechanical', 'review', 'visual'], { family: 'google' }),
    entry('antigravity', ['edit'], { family: 'anthropic' }),
    entry('codex', ['implement', 'review'], { family: 'openai' }),
    entry('claude', ['implement', 'review'], { family: 'anthropic' }),
  ];
  assert.deepEqual(relayPriority(list), {
    implement: [{ id: 'agy', family: 'anthropic' }, { id: 'codex', family: 'openai' }, { id: 'claude', family: 'anthropic' }],
    review: [{ id: 'agy', family: 'google' }, { id: 'codex', family: 'openai' }, { id: 'claude', family: 'anthropic' }],
  });
  assert.deepEqual(relayPriority([entry('codex', ['review']), entry('claude', ['review'], { enabled: false })]),
    { implement: [], review: [{ id: 'codex', family: 'other' }] });
  assert.deepEqual(relayPriority([]), { implement: [], review: [] });
});

test('with a priority the top CLI for the phase implements and the best other one reviews', t => {
  const s = scenario(t, [report('review'), report('done')]);
  const priority = { implement: [{ id: 'codex', family: 'openai' }, { id: 'agy', family: 'google' }], review: [{ id: 'agy', family: 'google' }, { id: 'codex', family: 'openai' }] };
  assert.equal(runRelay(s.task, { ...s, priority }).status, 'done');
  assert.deepEqual(s.calls, ['codex', 'agy']);
});

test('a reviewer from the implementer family is not accepted, even through another CLI', t => {
  const s = scenario(t, [report('review')]);
  const priority = { implement: [{ id: 'agy', family: 'anthropic' }], review: [{ id: 'codex', family: 'anthropic' }, { id: 'agy', family: 'anthropic' }] };
  const state = runRelay(s.task, { ...s, priority });
  assert.equal(state.status, 'unavailable');
  assert.equal(state.implementerFamily, 'anthropic');
  assert.deepEqual(s.calls, ['agy']);
});

test('a CLI a phase does not list never takes that phase', t => {
  const s = scenario(t, [report('review')]);
  // agy has no implement entry, so codex must implement even though agy is installed.
  const priority = { implement: [{ id: 'codex', family: 'openai' }], review: [{ id: 'agy', family: 'google' }, { id: 'codex', family: 'openai' }] };
  runRelay(s.task, { ...s, priority, maxTurns: 1 });
  assert.deepEqual(s.calls, ['codex']);
});

test('a priority that leaves a CLI out never calls it, and one left means no review', t => {
  const s = scenario(t, [report('review')]);
  const only = { implement: [{ id: 'codex', family: 'openai' }], review: [{ id: 'codex', family: 'openai' }] };
  assert.throws(() => runRelay(s.task, { ...s, priority: only }), /At least two available CLIs/);
  assert.equal(s.calls.length, 0);
});

test('a priority skips an exhausted CLI and moves to the next one in order', t => {
  const s = scenario(t, [{ error: 'quota exhausted' }, report('review')]);
  const priority = { implement: [{ id: 'codex', family: 'openai' }, { id: 'agy', family: 'google' }], review: [{ id: 'agy', family: 'google' }, { id: 'codex', family: 'openai' }] };
  const state = runRelay(s.task, { ...s, priority });
  // codex ran out, agy implemented, and nobody else is left to review it.
  assert.equal(state.status, 'unavailable');
  assert.deepEqual(s.calls, ['codex', 'agy']);
});

test('a saved review-phase run without a family is blocked under a priority, not guessed', t => {
  const s = scenario(t, []);
  const directory = join(s.cwd, '.ai/runs/test');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'task.json'), JSON.stringify({ id: 'test', objective: 'Fixture', acceptance: ['Fixture works'] }));
  writeFileSync(join(directory, 'state.json'), JSON.stringify({ status: 'running', phase: 'review', turns: 1, implementer: 'agy', handoff: null }));
  const priority = { implement: [{ id: 'agy', family: 'anthropic' }], review: [{ id: 'codex', family: 'openai' }] };
  const state = runRelay(s.task, { ...s, priority });
  assert.equal(state.status, 'blocked');
  assert.match(state.reason, /model family/);
  assert.equal(s.calls.length, 0);
});

test('relayPriority carries the cheapest non-restricted model of the entry', () => {
  const entry = { kind: 'antigravity', enabled: true, family: 'google', can: ['review'], models: [
    { id: 'big', cost: 'high', restricted: true }, { id: 'mid', cost: 'mid' }, { id: 'small', cost: 'low' }] };
  assert.deepEqual(relayPriority([entry]).review, [{ id: 'agy', family: 'google', model: 'small' }]);
  assert.deepEqual(relayPriority([{ ...entry, models: [] }]).review, [{ id: 'agy', family: 'google' }]);
});

test('agy is started with the model its entry names, and with none when the entry names none', t => {
  const run = (model) => {
    const s = scenario(t, [report('review'), report('done')]);
    const seen = [];
    const invoke = (exe, args, options) => { if (/agy/i.test(exe) && args[0] === '-p') seen.push(args); return s.invoke(exe, args, options); };
    const priority = {
      implement: [{ id: 'agy', family: 'google', ...(model ? { model } : {}) }],
      review: [{ id: 'codex', family: 'openai' }],
    };
    runRelay(s.task, { ...s, invoke, priority });
    return seen[0];
  };
  const pinned = run('gemini-3.8-flash-low');
  assert.equal(pinned[pinned.indexOf('--model') + 1], 'gemini-3.8-flash-low');
  assert.equal(run(undefined).includes('--model'), false);
});
