// The sequential Claude → Antigravity → Codex relay, for ANY repository.
// Generalized from a project-specific relay script. What differs per repo — which rule
// files the agents read and
// which check commands Claude may run unattended — comes from .ai/project.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSetting } from './lib/config.mjs';
import { findExecutable, launch } from './lib/exe.mjs';
import { validateCommands } from './lib/guardrails.mjs';
import { cheapestModel, loadProviders } from './lib/providers.mjs';
import { assertInside, writeJsonAtomic, writeTextAtomic } from './lib/safe-fs.mjs';
import { isMain } from './lib/is-main.mjs';

/**
 * What the relay needs to know about the repository it runs in, read from
 * <repo>/.ai/project.json (install.mjs writes it). Without the file the agents
 * read AGENTS.md and no command is preapproved.
 */
export function loadProject(cwd, env = process.env) {
  const path = join(cwd, '.ai/project.json');
  const project = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return validateProject(project, cwd, env);
}

export function validateProject(project, cwd = '.', env = process.env) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('.ai/project.json must be an object.');
  const rules = project.rules ?? ['AGENTS.md'];
  const checks = project.checks ?? [];
  if (!Array.isArray(rules) || !rules.length || rules.some(r => typeof r !== 'string' || !r.trim())) {
    throw new Error('.ai/project.json: rules must be a nonempty list of files the agents read first.');
  }
  // A preapproved check is ONE plain command: chaining, pipes, redirection or
  // substitution would turn a narrow grant into arbitrary shell.
  validateCommands(checks, '.ai/project.json: checks');
  validateCommands(project.qwenAllow ?? [], '.ai/project.json: qwenAllow');
  if (project.name !== undefined && (typeof project.name !== 'string' || !project.name.trim())) throw new Error('name must be a nonempty string.');
  if (project.jules != null && (!/^[\w.-]+\/[\w.-]+$/.test(project.jules.repo || '') || !/^[\w./-]+$/.test(project.jules.branch || ''))) throw new Error('jules takes owner/name:branch.');
  // Claude runs on a pinned model, never the CLI default: a default of Fable
  // would otherwise spend the most expensive model on every relay turn. The
  // pin is the cheapest model that solves most steps (sonnet); a project that
  // needs more says so in claudeModel, and Opus is for extreme cases only.
  // The owner approves each Fable use, so it also needs RELAYRACE_ALLOW_FABLE=1
  // (RELAYKIT_ALLOW_FABLE, AI_KIT_ALLOW_FABLE and KIT_ALLOW_FABLE still count).
  const claudeModel = project.claudeModel ?? 'sonnet';
  if (typeof claudeModel !== 'string' || !/^[a-z0-9.[\]-]+$/i.test(claudeModel)) throw new Error('.ai/project.json: claudeModel must be a model alias or id.');
  if (/fable/i.test(claudeModel) && readSetting(env, 'RELAYRACE_ALLOW_FABLE')?.value !== '1' && env.KIT_ALLOW_FABLE !== '1') {
    throw new Error('Fable needs the owner\'s approval for this run: set RELAYRACE_ALLOW_FABLE=1 only after the owner says yes.');
  }
  return { name: project.name || basename(resolve(cwd)), rules, checks, claudeModel, jules: project.jules ?? null,
    ...(project.qwenAllow ? { qwenAllow: project.qwenAllow } : {}) };
}

/** Claude's --allowedTools for a project's checks, in both shells. */
export function allowedTools(checks) {
  return checks.flatMap(c => [`Bash(${c})`, `PowerShell(${c})`]);
}

export function nextState(state, provider, report) {
  if (!['continue', 'review', 'done', 'blocked'].includes(report.status) ||
      typeof report.summary !== 'string' || !report.summary.trim() ||
      typeof report.next !== 'string' || typeof report.evidence !== 'string') {
    throw new Error('Invalid handoff; paused without assuming completion.');
  }
  const next = { ...state, handoff: report, turns: state.turns + 1 };
  if (report.status === 'blocked') return { ...next, status: 'blocked' };
  if (state.phase === 'review' && report.status === 'done' && provider !== state.implementer && report.evidence.trim()) {
    return { ...next, status: 'done' };
  }
  if (report.status === 'review' || report.status === 'done') {
    return { ...next, phase: 'review', implementer: state.phase === 'implement' ? provider : state.implementer };
  }
  // A reviewer returning findings has not implemented those fixes.
  return { ...next, phase: 'implement', implementer: state.phase === 'review' ? state.implementer : provider };
}

export const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['continue', 'review', 'done', 'blocked'] },
    summary: { type: 'string' }, next: { type: 'string' }, evidence: { type: 'string' },
  }, required: ['status', 'summary', 'next', 'evidence'],
};

// Antigravity prints a "jetski: …" notice ahead of its JSON when it denied a
// tool in headless mode; the envelope is the last line that parses.
export function parseEnvelope(stdout) {
  const lines = String(stdout || '').trim().split('\n');
  for (let i = 0; i < lines.length; i++) {
    try { return JSON.parse(lines.slice(i).join('\n') || '{}'); } catch { /* try the next line */ }
  }
  return {};
}

const save = writeJsonAtomic;

// Model calls one invocation may make before a human looks at the handoffs.
// The identical-handoff check misses two models that keep rewording the same
// stalled state; a cap per run stops that, and the same command resumes.
export const DEFAULT_MAX_TURNS = 20;

// The relay's three CLIs, by the provider kind that names them in providers.json.
const CLI_FOR_KIND = { claude: 'claude', antigravity: 'agy', codex: 'codex' };

/**
 * Which relay CLI may take each phase, in the owner's priority order, from the
 * providers list. A CLI appears in a phase only through an enabled entry that
 * declares the capability (implement or edit for `implement`, review for
 * `review`); the first such entry sets its place and its model family. Pure.
 */
export function relayPriority(providers) {
  const phases = { implement: [], review: [] };
  const wanted = { implement: ['implement', 'edit'], review: ['review'] };
  for (const provider of providers) {
    const id = CLI_FOR_KIND[provider.kind];
    if (!provider.enabled || !id) continue;
    // Models are listed but none may be used here (all restricted): skip it, as pick() does.
    if (Array.isArray(provider.models) && provider.models.length && !cheapestModel(provider)) continue;
    for (const phase of Object.keys(phases)) {
      if (provider.can.some(capability => wanted[phase].includes(capability)) && !phases[phase].some(entry => entry.id === id)) {
        // The cheapest usable model of that entry; the relay passes it to agy so the family declared here is the family that runs.
        const model = Array.isArray(provider.models) ? cheapestModel(provider)?.id : undefined;
        phases[phase].push({ id, family: provider.family, ...(model ? { model } : {}) });
      }
    }
  }
  return phases;
}

/** The owner's providers file as relay priority, for every way into the relay. */
export const defaultPriority = cwd => relayPriority(loadProviders({ cwd }).providers);

/** Shared task-file validation for the local relay and the Jules bridge. */
export function loadTask(taskFile, cloud) {
  const task = JSON.parse(readFileSync(taskFile, 'utf8'));
  if (!task || typeof task.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(task.id) ||
      typeof task.objective !== 'string' || !task.objective.trim() ||
      !Array.isArray(task.acceptance) || !task.acceptance.length ||
      task.acceptance.some(x => typeof x !== 'string' || !x.trim())) {
    throw new Error('Task needs an id, objective and nonempty acceptance criteria.');
  }
  if (cloud && (task.jules?.repo !== cloud.repo || task.jules?.branch !== cloud.branch)) {
    throw new Error(`Provide id, objective, acceptance and jules: {repo: "${cloud.repo}", branch: "${cloud.branch}"}.`);
  }
  return task;
}

/**
 * `priority` is what relayPriority returns: per phase, the CLIs allowed, most
 * preferred first, each with its model family. Without it the relay alternates
 * between the available CLIs, as before. With it, each turn goes to the
 * highest-priority CLI allowed for the phase that is available, and a review
 * is never by the CLI that implemented nor by the same model family.
 * agy is started with --model <the entry's cheapest model> when the entry
 * lists one, so the model family used for independence is the one that runs.
 */
export function runRelay(taskFile, { cwd = process.cwd(), invoke = launch, maxTurns = DEFAULT_MAX_TURNS, priority } = {}) {
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error('maxTurns must be a positive integer.');
  const task = loadTask(taskFile);
  if (['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'].some(k => process.env[k])) {
    throw new Error('API key environment detected. Run with subscription authentication; no automatic paid API fallback.');
  }
  const project = loadProject(cwd);
  const directory = resolve(cwd, '.ai/runs', task.id);
  assertInside(cwd, directory);
  mkdirSync(directory, { recursive: true });
  assertInside(cwd, directory);
  const lockPath = resolve(cwd, '.ai/runs/relay.lock');
  const lock = openSync(lockPath, 'wx');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, task: task.id }));
  try {
    const statePath = join(directory, 'state.json');
    let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) :
      { status: 'running', phase: 'implement', turns: 0, implementer: null, handoff: null };
    const snapshot = join(directory, 'task.json');
    if (existsSync(snapshot) && readFileSync(snapshot, 'utf8') !== JSON.stringify(task)) {
      throw new Error('Task changed: use a new id to avoid reusing old acceptance evidence.');
    }
    writeTextAtomic(snapshot, JSON.stringify(task));
    if (state.status === 'done') return state;
    const providers = [
      { id: 'claude', exe: findExecutable('claude', readSetting(process.env, 'RELAYRACE_CLAUDE_EXE')?.value) },
      { id: 'agy', exe: findExecutable('agy', readSetting(process.env, 'RELAYRACE_AGY_EXE')?.value) },
      { id: 'codex', exe: findExecutable('codex', readSetting(process.env, 'RELAYRACE_CODEX_EXE')?.value) },
    ];
    const env = { ...process.env };
    // Prefer the installed Git Bash to Windows' WSL launcher for repository checks.
    const gitBin = process.platform === 'win32' && env.ProgramFiles ? join(env.ProgramFiles, 'Git/bin') : null;
    if (gitBin && existsSync(join(gitBin, 'bash.exe'))) env.PATH = `${gitBin};${env.PATH || env.Path || ''}`;
    const options = { cwd, env, encoding: 'utf8', windowsHide: true };
    const allowed = priority ? new Set([...priority.implement, ...priority.review].map(entry => entry.id)) : null;
    const available = providers.filter(p => !allowed || allowed.has(p.id)).filter(p => {
      if (invoke(p.exe, ['--version'], { ...options, timeout: 15000 }).status !== 0) return false;
      if (p.id === 'claude') {
        const auth = invoke(p.exe, ['auth', 'status'], { ...options, timeout: 15000 });
        try { return JSON.parse(auth.stdout || '{}').loggedIn === true; } catch { return false; }
      }
      return true;
    });
    if (available.length < 2) throw new Error('At least two available CLIs are required for independent review.');
    const unavailable = new Set();
    state = { ...state, status: 'running', reason: undefined };
    save(statePath, state);
    const schemaPath = join(directory, 'schema.json');
    save(schemaPath, schema);
    let cursor = state.turns;
    let unchanged = 0;
    let calls = 0;
    while (state.status === 'running') {
      if (calls >= maxTurns) {
        state = { ...state, status: 'blocked', reason: `Turn limit of ${maxTurns} reached in this run; read the handoffs in .ai/runs/${task.id}/, then run the same command to continue.` };
        break;
      }
      const phaseList = priority ? priority[state.phase === 'review' ? 'review' : 'implement'] : null;
      const entryFor = id => phaseList?.find(entry => entry.id === id);
      // A run saved before family tracking cannot prove who implemented it: do not guess from today's config.
      if (phaseList && state.phase === 'review' && state.implementer && !state.implementerFamily) {
        state = { ...state, status: 'blocked', reason: 'This run was saved without the implementer\'s model family, so a review cannot be shown independent. Resume it with --rotate, or start a new task id.' };
        break;
      }
      const eligible = available.filter(p => !unavailable.has(p.id) &&
        (!phaseList || entryFor(p.id)) &&
        !(state.phase === 'review' && p.id === state.implementer) &&
        !(phaseList && state.phase === 'review' && state.implementerFamily && entryFor(p.id).family === state.implementerFamily));
      if (!eligible.length) {
        state = { ...state, status: 'unavailable', reason: 'No eligible authenticated provider with quota remains; review cannot be self-approved.' };
        break;
      }
      const turn = cursor++;
      const provider = phaseList
        ? [...eligible].sort((a, b) => phaseList.findIndex(e => e.id === a.id) - phaseList.findIndex(e => e.id === b.id))[0]
        : eligible[turn % eligible.length];
      const prompt = [
        `Read ${project.rules.join(', ')} first: they are this repository's rules. You are the only relay writer in this checkout of ${project.name}.`,
        'Handoff statuses: continue = implementation steps remain; review = ready for a DIFFERENT provider to verify; done = only that reviewer, after verifying every acceptance criterion with evidence; blocked = a human decision, permission or ambiguity is needed.',
        `Authorized task: ${JSON.stringify(task)}`,
        `Phase: ${state.phase}. Previous handoff (verify against actual files): ${JSON.stringify(state.handoff)}`,
        state.phase === 'review' ? 'Review independently; do not change source. Verify acceptance and test evidence. Return continue with actionable findings if unfinished.' :
          'Continue implementation from actual Git status/diff. Complete one coherent step, validate it, then hand off.',
        'Do not commit, push, merge, deploy, buy credits, change credentials, bypass permissions or expand scope.',
        'An approval requirement is blocked, not permission to try another provider. Never modify .ai/runs controller state.',
        'Use built-in file tools to read instructions and inspect files. Do not combine shell commands, add git safe.directory overrides, or request broad shell access. Run individual local checks directly from the current working directory.',
        'Return JSON matching this schema. evidence must name checks and results; next must identify remaining work. done requires all acceptance criteria verified.',
        JSON.stringify(schema),
      ].join('\n\n');
      const outputPath = join(directory, `turn-${state.turns}-${cursor}.json`);
      let args;
      if (provider.id === 'agy') {
        args = ['-p', 'Perform the task supplied on stdin.', '--sandbox', '--mode', state.phase === 'review' ? 'plan' : 'accept-edits', '--output-format', 'json', '--print-timeout', '20m'];
        const pinned = entryFor(provider.id)?.model;
        if (pinned) args.push('--model', pinned);
      }
      else if (provider.id === 'codex') args = ['exec', '--json', '-s', state.phase === 'review' ? 'read-only' : 'workspace-write', '--output-schema', schemaPath, '-o', outputPath, '-'];
      else {
        const tools = allowedTools(project.checks);
        args = ['-p', '--model', project.claudeModel, '--permission-mode', state.phase === 'review' ? 'plan' : 'acceptEdits',
          ...(tools.length ? ['--allowedTools', ...tools] : []), '--output-format', 'json', '--json-schema', JSON.stringify(schema)];
      }
      console.log(`Relay: ${provider.id} / ${state.phase} / ${task.id}`);
      const startedAt = new Date().toISOString();
      calls++;
      const result = invoke(provider.exe, args, { ...options, input: prompt, maxBuffer: 16 * 1024 * 1024 });
      let envelope;
      if (provider.id !== 'codex') envelope = parseEnvelope(result.stdout);
      const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
      let tokens = null, model = null, sessionId = envelope?.session_id || envelope?.conversation_id || null;
      if (provider.id === 'codex') {
        for (const line of String(result.stdout || '').split('\n')) {
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (event.type === 'thread.started') sessionId = event.thread_id || null;
          if (event.type === 'turn.completed' && finite(event.usage?.input_tokens) !== null && finite(event.usage?.output_tokens) !== null) {
            // Cached input is a subset of input_tokens, not an extra token charge.
            tokens = event.usage.input_tokens + event.usage.output_tokens;
          }
        }
      } else if (provider.id === 'agy') tokens = finite(envelope?.usage?.total_tokens);
      else if (envelope?.modelUsage && Object.keys(envelope.modelUsage).length) {
        model = Object.keys(envelope.modelUsage).join(', ');
        const values = Object.values(envelope.modelUsage);
        if (values.every(usage => ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'].every(key => finite(usage[key]) !== null))) {
          tokens = values.reduce((sum, usage) => sum + usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens, 0);
        }
      }
      save(outputPath.replace('.json', '.meta.json'), { provider: provider.id, phase: state.phase, startedAt, finishedAt: new Date().toISOString(), sessionId, tokens, model, exitCode: result.status });
      if (result.status !== 0 || envelope?.is_error || (envelope?.status && envelope.status !== 'SUCCESS')) {
        const error = String(envelope?.error || envelope?.result || result.stderr || result.error || 'CLI failed');
        save(join(directory, `error-${cursor}.json`), { provider: provider.id, exit: result.status, error });
        if (!/permission.denied|approval.required/i.test(error) && /quota|rate.limit|usage.limit|credit.*exhaust|not.authenticated|not.logged.in|authentication.required|sign.in.required/i.test(error)) {
          unavailable.add(provider.id);
          continue;
        }
        state = { ...state, status: 'blocked', reason: `CLI error or permission required: ${provider.id}. See error-${cursor}.json.` };
        break;
      }
      // Claude reports permission_denials; Antigravity reports denied_actions with
      // an empty response and status SUCCESS, which is not a handoff either.
      const denials = envelope?.permission_denials?.length ? envelope.permission_denials : envelope?.denied_actions;
      if (denials?.length) {
        state = { ...state, status: 'blocked', reason: `Permission required by ${provider.id}; no provider hopping to evade it.` };
        save(join(directory, `denials-${cursor}.json`), denials);
        break;
      }
      let report;
      const prior = state;
      try {
        report = provider.id === 'codex' ? JSON.parse(readFileSync(outputPath, 'utf8')) :
          envelope.structured_output || JSON.parse(envelope.response || envelope.result || '{}');
        state = nextState(state, provider.id, report);
        // Remember whose model family implemented, so the review comes from another family.
        if (phaseList && prior.phase === 'implement' && state.phase === 'review') {
          state = { ...state, implementerFamily: entryFor(provider.id).family };
        }
      } catch (error) {
        state = { ...state, status: 'blocked', reason: `Invalid handoff from ${provider.id}: ${error.message}` };
        break;
      }
      save(outputPath, report);
      unchanged = JSON.stringify(report) === JSON.stringify(prior.handoff) ? unchanged + 1 : 0;
      if (unchanged >= 2) state = { ...state, status: 'blocked', reason: 'Repeated identical handoff; human diagnosis required.' };
      save(statePath, state);
    }
    save(statePath, state);
    return state;
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

if (isMain(import.meta.url)) {
  if (!process.argv[2] || process.argv[2] === '--help') {
    console.log(`Usage: relayrace relay <task.json> [--max-turns N] [--rotate]  (run from the repository root)\nProviders are tried in the order of your providers file (relayrace providers); --rotate alternates between the installed CLIs instead.\nModel calls per run default to ${DEFAULT_MAX_TURNS}. Run in an idle, dedicated checkout. See the Relayrace README.`);
  } else {
    try {
      const flag = process.argv.indexOf('--max-turns');
      const maxTurns = flag === -1 ? DEFAULT_MAX_TURNS : Number(process.argv[flag + 1]);
      // The owner's order from providers.json; --rotate keeps the old alternation.
      const priority = process.argv.includes('--rotate') ? undefined : relayPriority(loadProviders({ cwd: process.cwd() }).providers);
      if (priority) console.log(`Relay order: implement ${priority.implement.map(e => e.id).join(' > ') || '-'}; review ${priority.review.map(e => e.id).join(' > ') || '-'}`);
      const state = runRelay(resolve(process.argv[2]), { maxTurns, priority });
      console.log(`Relay: ${state.status}${state.reason ? ': ' + state.reason : ''}`);
      process.exitCode = state.status === 'done' ? 0 : 2;
    } catch (error) {
      console.error(`Relay paused: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
