import { readSetting } from './lib/config.mjs';
import { launch } from './lib/exe.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultPriority, loadProject, loadTask, runRelay } from './relay.mjs';
import { assertInside, writeJsonAtomic, writeTextAtomic } from './lib/safe-fs.mjs';
import { isMain } from './lib/is-main.mjs';

// Portable Jules bridge: the repository and branch
// come from .ai/project.json (`jules: { repo: "owner/name", branch: "dev" }`),
// and the task must name the same pair, so a task file cannot redirect a
// cloud session to another repository.

// CLI tables can contain ANSI color escapes; remove only those sequences.
// eslint-disable-next-line no-control-regex
const strip = text => String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
const save = (path, value) => {
  writeJsonAtomic(path, value);
};

export function sessionStatus(output, id) {
  const row = strip(output).split('\n').find(line => line.trim().split(/\s+/)[0] === id);
  if (!row) throw new Error('Session missing from CLI listing; inspect its URL before resuming.');
  const cells = row.trim().split(/\s{2,}/);
  const status = cells.at(-1).trim().toLowerCase();
  if (status === 'completed') return 'completed';
  if (['queued', 'planning', 'in progress', 'running'].includes(status)) return 'waiting';
  throw new Error(`Jules requires attention: ${status}. Inspect the session; never bypass approval.`);
}

// Jules runs first on an explicitly selected remote task. Local work is never
// silently uploaded, and cloud completion is never accepted as local review.
export async function runJules(taskFile, {
  cwd = process.cwd(), invoke = launch, wait = delay, localRelay = runRelay,
  maxPolls = 120,
} = {}) {
  const cloud = loadProject(cwd).jules;
  if (!cloud || !/^[\w.-]+\/[\w.-]+$/.test(cloud.repo || '') || !/^[\w./-]+$/.test(cloud.branch || '')) {
    throw new Error('.ai/project.json needs jules: {repo: "owner/name", branch: "<default branch>"} for a repo connected to Jules.');
  }
  const task = loadTask(taskFile, cloud);
  const directory = resolve(cwd, '.ai/runs', task.id);
  assertInside(cwd, directory);
  mkdirSync(directory, { recursive: true });
  assertInside(cwd, directory);
  const lockPath = resolve(cwd, '.ai/runs/relay.lock');
  const lock = openSync(lockPath, 'wx');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, task: task.id, provider: 'jules' }));
  let released = false;
  const release = () => { closeSync(lock); unlinkSync(lockPath); released = true; };
  const statePath = join(directory, 'jules.json');
  let state;
  const options = { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 };
  const cached = join(tmpdir(), 'jules_tmp', 'jules.exe');
  const exe = readSetting(process.env, 'RELAYRACE_JULES_EXE')?.value || (process.platform === 'win32' && existsSync(cached) ? cached : 'jules');
  const call = (program, args, input) => {
    const result = invoke(program, args, { ...options, ...(input === undefined ? {} : { input }) });
    if (result.status !== 0) throw new Error(String(result.stderr || result.error || 'Command failed'));
    return strip(result.stdout);
  };
  const git = args => call('git', args).trim();
  try {
    state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
    const snapshot = join(directory, 'task.json');
    if (existsSync(snapshot) && readFileSync(snapshot, 'utf8') !== JSON.stringify(task)) {
      throw new Error('Task changed: use a new id.');
    }
    writeTextAtomic(snapshot, JSON.stringify(task));
    const localState = join(directory, 'state.json');
    if (state?.stage === 'handed-off') {
      release();
      return localRelay(taskFile, { cwd, invoke, priority: defaultPriority(cwd) });
    }
    if (existsSync(localState)) throw new Error('Local relay already started; do not transfer its uncommitted work to Jules.');
    if (!state) {
      if (git(['status', '--porcelain'])) throw new Error(`Jules needs a clean dedicated checkout at the remote ${cloud.branch} commit. Keep task JSON under ignored .ai/runs/.`);
      const remote = git(['remote', 'get-url', 'origin']);
      const escaped = cloud.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`github\\.com[:/]${escaped}(?:\\.git)?$`, 'i').test(remote)) throw new Error(`Origin must be ${cloud.repo}, the repository named in .ai/project.json.`);
      const remoteHead = git(['ls-remote', '--symref', 'origin', 'HEAD']);
      if (!remoteHead.includes(`ref: refs/heads/${cloud.branch}\tHEAD`)) throw new Error(`The Jules CLI uses the default branch; expected remote default ${cloud.branch}.`);
      const base = git(['rev-parse', 'HEAD']);
      const head = remoteHead.split('\n').find(line => /^[a-f0-9]{40}\s+HEAD$/.test(line))?.split(/\s+/)[0];
      if (head !== base) throw new Error(`Local HEAD differs from remote ${cloud.branch}; no automatic commit or push.`);
      // Fail before recording an uncertain remote operation if the CLI is missing.
      call(exe, ['version']);
      state = { stage: 'creating', base, status: 'waiting' };
      // Persist before the network call: an ambiguous failure cannot create duplicates.
      save(statePath, state);
      const prompt = [
        `Read AGENTS.md. Perform only this authorized bounded task on ${cloud.branch}.`,
        JSON.stringify({ objective: task.objective, acceptance: task.acceptance }),
        `Expected base commit: ${base}. Stop if the checkout differs.`,
        'Do not create a pull request, merge, deploy, change credentials, buy credits or expand scope.',
        'No local Qwen or production secrets. Run typecheck before relevant tests.',
        'Return changes and validation evidence for a subsequent independent local review. Cloud completion is not final task acceptance.',
      ].join('\n\n');
      const output = call(exe, ['remote', 'new', '--repo', task.jules.repo], prompt);
      writeTextAtomic(join(directory, 'jules-create.txt'), output);
      const id = output.match(/^ID:\s*(\d+)\s*$/m)?.[1];
      if (!id) throw new Error('Creation result did not include a session ID; inspect Jules before retrying.');
      state = { ...state, stage: 'remote', id, url: `https://jules.google.com/session/${id}` };
      save(statePath, state);
      console.log(`Jules: ${state.url}`);
    }
    if (state.stage === 'creating') throw new Error('Creation outcome is uncertain. Recover its ID from Jules into jules.json (stage remote, id, url); do not create a duplicate.');
    for (let poll = 0; poll < maxPolls; poll++) {
      if (git(['rev-parse', 'HEAD']) !== state.base || git(['status', '--porcelain'])) {
        throw new Error('Checkout changed while Jules was working; isolate and review before resuming.');
      }
      const listing = call(exe, ['remote', 'list', '--session']);
      writeTextAtomic(join(directory, 'jules-status.txt'), listing);
      if (sessionStatus(listing, state.id) === 'completed') {
        const artifact = join(directory, 'jules-result.txt');
        // Pull without --apply. The next local agent must inspect this untrusted patch.
        writeTextAtomic(artifact, call(exe, ['remote', 'pull', '--session', state.id]));
        save(localState, {
          status: 'running', phase: 'implement', turns: 0, implementer: 'jules',
          handoff: {
            status: 'continue', summary: `Jules session ${state.id} completed on remote base ${state.base}; local acceptance remains unverified.`,
            next: `Read ${artifact} and inspect the patch before integrating. Reject out-of-scope changes, verify the base, run typecheck and relevant tests, then request independent review. If no patch/evidence is available, report blocked; never assume completion. Session: ${state.url}`,
            evidence: 'CLI reports Completed; returned artifact saved. No patch applied and no local tests claimed.',
          },
        });
        state = { ...state, stage: 'handed-off', status: 'ready', reason: undefined };
        save(statePath, state);
        release();
        return localRelay(taskFile, { cwd, invoke, priority: defaultPriority(cwd) });
      }
      state = { ...state, status: 'waiting', reason: undefined };
      save(statePath, state);
      await wait(30000);
    }
    state = { ...state, status: 'waiting', reason: 'Polling window ended; resume the same command and session.' };
    save(statePath, state);
    return state;
  } catch (error) {
    if (state) save(statePath, { ...state, status: 'blocked', reason: error.message });
    throw error;
  } finally {
    if (!released) release();
  }
}

if (isMain(import.meta.url)) {
  if (!process.argv[2] || process.argv[2] === '--help') {
    console.log('Usage: relayrace jules <task.json>  (run from the repository root)\nJules first, then local integration and independent review. See the Relayrace README.');
  } else {
    try {
      const state = await runJules(resolve(process.argv[2]));
      console.log(`Jules relay: ${state.status}`);
      process.exitCode = state.status === 'done' ? 0 : 2;
    } catch (error) {
      console.error(`Jules relay paused: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
