import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJules, sessionStatus } from './jules-relay.mjs';

test('CLI table parsing isolates the exact session and pauses for approval or unknown state', () => {
  assert.equal(sessionStatus(' 1234  other task  project  now  Failed\n 123  task  project  now  In Progress', '123'), 'waiting');
  assert.equal(sessionStatus(' 123  task  project  now  Completed', '123'), 'completed');
  assert.throws(() => sessionStatus(' 123  task  project  now  Awaiting Plan Approval', '123'), /requires attention/);
  assert.throws(() => sessionStatus(' 123  task  project  now  Unexpected', '123'), /requires attention/);
  assert.throws(() => sessionStatus(' 1234  task  project  now  Completed', '123'), /missing/);
});

function fixture(t, changes = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'kit-jules-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const base = 'a'.repeat(40);
  const repo = changes.repo || 'octo/project';
  const branch = changes.branch || 'dev';
  if (changes.project !== null) {
    mkdirSync(join(cwd, '.ai'));
    writeFileSync(join(cwd, '.ai/project.json'), JSON.stringify(changes.project || { jules: { repo, branch } }));
  }
  const task = join(cwd, 'task.json');
  writeFileSync(task, JSON.stringify({ id: 'fixture', objective: 'Bounded task', acceptance: ['Verified behavior'], jules: changes.taskJules || { repo, branch } }));
  const calls = [];
  const inputs = [];
  let status = changes.status || 'Completed';
  const invoke = (exe, args, options) => {
    calls.push(args);
    if (options.input) inputs.push(options.input);
    let stdout = '';
    if (exe === 'git') {
      if (args[0] === 'status') stdout = changes.dirty || (changes.changedDuringPoll && calls.some(call => call[1] === 'new') ? ' M fixture.txt' : '');
      if (args[0] === 'remote') stdout = `git@github.com:${changes.origin || repo}.git`;
      if (args[0] === 'rev-parse') stdout = base;
      if (args[0] === 'ls-remote') stdout = `ref: refs/heads/${changes.remoteDefault || branch}\tHEAD\n${changes.remoteBase || base}\tHEAD`;
    } else if (args[0] === 'version' && changes.missingCLI) return { status: null, error: new Error('spawn ENOENT') };
    else if (args[1] === 'new') {
      if (changes.creationError) return { status: 1, stderr: 'Connection lost after sending task' };
      stdout = 'Session is created.\nID: 123\nURL: https://jules.google.com/session/123\n';
    } else if (args[1] === 'list') stdout = ` 123  Fixture  octo/project  now  ${status}`;
    else if (args[1] === 'pull') stdout = 'diff --git a/fixture.txt b/fixture.txt\n';
    return { status: 0, stdout };
  };
  let localCalls = 0;
  const relayOptions = [];
  const localRelay = (_taskFile, options) => {
    localCalls++;
    relayOptions.push(options);
    const state = JSON.parse(readFileSync(join(cwd, '.ai/runs/fixture/state.json'), 'utf8'));
    assert.equal(state.phase, 'implement');
    assert.equal(state.implementer, 'jules');
    assert.match(state.handoff.next, /inspect the patch/);
    return { status: 'done' };
  };
  return { cwd, task, invoke, localRelay, calls, inputs, wait: async () => {}, maxPolls: 1,
    setStatus: value => { status = value; }, localCalls: () => localCalls, relayOptions };
}

test('cloud result is downloaded once without applying and local integration can resume', async t => {
  const f = fixture(t);
  assert.equal((await runJules(f.task, f)).status, 'done');
  assert.equal(existsSync(join(f.cwd, '.ai/runs/fixture/jules-result.txt')), true);
  assert.equal(existsSync(join(f.cwd, '.ai/runs/relay.lock')), false);
  await runJules(f.task, f);
  assert.equal(f.calls.filter(args => args[1] === 'new').length, 1);
  assert.equal(f.calls.filter(args => args[1] === 'pull').length, 1);
  assert.equal(f.calls.some(args => args.includes('--apply')), false);
  // The hand-off to the local relay carries the owner's providers file, not the old rotation.
  assert.ok(f.relayOptions.length >= 1);
  for (const options of f.relayOptions) assert.ok(options.priority && Array.isArray(options.priority.review), 'priority passed to the local relay');
});

test('waiting resumes the existing session without duplicate creation', async t => {
  const f = fixture(t, { status: 'Planning' });
  assert.equal((await runJules(f.task, f)).status, 'waiting');
  assert.equal(f.localCalls(), 0);
  f.setStatus('Completed');
  assert.equal((await runJules(f.task, f)).status, 'done');
  assert.equal(f.calls.filter(args => args[1] === 'new').length, 1);
});

test('approval pauses and saves the session without invoking another agent', async t => {
  const f = fixture(t, { status: 'Awaiting Plan Approval' });
  await assert.rejects(runJules(f.task, f), /requires attention/);
  const state = JSON.parse(readFileSync(join(f.cwd, '.ai/runs/fixture/jules.json'), 'utf8'));
  assert.equal(state.id, '123');
  assert.equal(state.status, 'blocked');
  assert.equal(f.localCalls(), 0);
});

test('uncertain creation cannot create a duplicate on retry', async t => {
  const f = fixture(t, { creationError: true });
  await assert.rejects(runJules(f.task, f), /Connection lost/);
  await assert.rejects(runJules(f.task, f), /uncertain/);
  assert.equal(f.calls.filter(args => args[1] === 'new').length, 1);
});

test('dirty checkout cannot silently transfer local files', async t => {
  const f = fixture(t, { dirty: ' M private.txt' });
  await assert.rejects(runJules(f.task, f), /clean dedicated checkout/);
  assert.equal(f.calls.some(args => args[1] === 'new'), false);
});

test('different remote base cannot upload or claim a synchronized handoff', async t => {
  const f = fixture(t, { remoteBase: 'b'.repeat(40) });
  await assert.rejects(runJules(f.task, f), /differs from remote dev/);
  assert.equal(f.calls.some(args => args[1] === 'new'), false);
});

test('changed scope cannot reuse an existing cloud session', async t => {
  const f = fixture(t, { status: 'Planning' });
  await runJules(f.task, f);
  const task = JSON.parse(readFileSync(f.task, 'utf8'));
  task.acceptance.push('New scope');
  writeFileSync(f.task, JSON.stringify(task));
  await assert.rejects(runJules(f.task, f), /Task changed/);
});

test('missing executable fails before uncertain creation is persisted', async t => {
  const f = fixture(t, { missingCLI: true });
  await assert.rejects(runJules(f.task, f), /ENOENT/);
  assert.equal(existsSync(join(f.cwd, '.ai/runs/fixture/jules.json')), false);
  assert.equal(f.calls.some(args => args[1] === 'new'), false);
});

test('checkout changes during cloud work block download and local integration', async t => {
  const f = fixture(t, { changedDuringPoll: true });
  await assert.rejects(runJules(f.task, f), /Checkout changed/);
  assert.equal(f.calls.some(args => args[1] === 'pull'), false);
  assert.equal(f.localCalls(), 0);
});

test('any connected repo works: repo and default branch come from .ai/project.json', async t => {
  const f = fixture(t, { repo: 'octo/site', branch: 'main' });
  assert.equal((await runJules(f.task, f)).status, 'done');
  const created = f.calls.find(args => args[1] === 'new');
  assert.equal(created[created.indexOf('--repo') + 1], 'octo/site');
  assert.match(f.inputs[0], /bounded task on main/);
  assert.ok(!created.includes(f.inputs[0]));
});

test('without a jules block in .ai/project.json nothing reaches the cloud', async t => {
  for (const project of [null, { name: 'No cloud' }]) {
    const f = fixture(t, { project });
    await assert.rejects(runJules(f.task, f), /needs jules/);
    assert.equal(f.calls.some(args => args[1] === 'new'), false);
  }
});

test('a task cannot point Jules at another repo or branch than the project names', async t => {
  for (const taskJules of [{ repo: 'someone/else', branch: 'dev' }, { repo: 'octo/project', branch: 'main' }]) {
    const f = fixture(t, { taskJules });
    await assert.rejects(runJules(f.task, f), /Provide id/);
    assert.equal(f.calls.some(args => args[1] === 'new'), false);
  }
});

test('shared task validation rejects malformed Jules input without creating run state', async t => {
  for (const value of [null, [], {}, { id: 123 }, { id: '../escape' },
    { objective: ' ' }, { acceptance: [] }, { acceptance: ['valid', null] }, { jules: null }]) {
    const f = fixture(t);
    const valid = JSON.parse(readFileSync(f.task, 'utf8'));
    const task = value && !Array.isArray(value) ? { ...valid, ...value } : value;
    // An empty object is independently invalid; the other objects change one field.
    writeFileSync(f.task, JSON.stringify(value && Object.keys(value).length === 0 ? value : task));
    await assert.rejects(runJules(f.task, { ...f, invoke: () => assert.fail('must not invoke any CLI') }), /Task needs|Provide id/);
    assert.equal(existsSync(join(f.cwd, '.ai/runs')), false);
  }
});

test('origin or remote default branch that differ from the project are refused', async t => {
  const wrongOrigin = fixture(t, { origin: 'someone/project' });
  await assert.rejects(runJules(wrongOrigin.task, wrongOrigin), /Origin must be octo\/project/);
  const wrongDefault = fixture(t, { remoteDefault: 'main' });
  await assert.rejects(runJules(wrongDefault.task, wrongDefault), /expected remote default dev/);
});
