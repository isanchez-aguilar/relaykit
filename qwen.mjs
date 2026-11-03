// Delegate a mechanical task to the local model (Qwen3-Coder-Next via opencode),
// from ANY repository. Generalized from a project-specific runner; the project
// root is the git top level of the directory you run it from, and a run refuses
// a project without valid opencode.json guardrails (manually applied by the owner).
//
// Every rule in here was learned the hard way:
//   - the server is checked FIRST (`/health`) and the run refused when it is down,
//     so a missing server costs seconds, not a 12-minute hang;
//   - the task goes in as a FILE (`--file`), never as a quoted shell argument —
//     a prompt with quotes or newlines dies in cmd.exe;
//   - `--auto` is on, because a permission prompt nobody answers looks like a hang;
//   - the run is pinned to the repo (`--dir`), so the model writes INSIDE the
//     worktree and never into a scratchpad it cannot reach;
//   - a wall-clock timeout kills a run that loops (default 20 min — opencode
//     writes its files at the END, so an empty log for 10 minutes is normal);
//   - the files the task promised are checked for afterwards — the log is not
//     the evidence, the file on disk is;
//   - runs QUEUE behind a lock file: the llama.cpp server has ONE slot, so a
//     second run started in parallel would sit waiting inside opencode while its
//     timeout ticks. It now waits for the lock first, and its clock starts when
//     it actually gets the model;
//   - a `--tsc <package>` run is appended to the task, because vitest does not
//     typecheck and «50/50 green» has shipped a test that imported a type that
//     did not exist.
//
// Usage:
//   relayrace qwen --health            (or: node scripts/qwen.mjs --health in a repo that carries a copy)
//   relayrace qwen --optional --task .ai/qwen-tasks/foo.md [--expect path ...]
//                         [--optional] [--tsc apps/web] [--timeout-min 20] [--queue-max-min 60] [--dry-run]
//
// Settings (all optional): the local model's health URL and the name of the
// temp folder that holds the single-slot lock come from RELAYRACE_QWEN_URL /
// RELAYRACE_QWEN_LOCK (the old RELAYKIT_* and AI_KIT_* names still work), else from the Relayrace config file (`qwen.healthUrl`,
// `qwen.lockName`), else the defaults below. A repo can add its own standing
// rules for the model as `qwenRules` (a list of strings) in .ai/project.json.
//
// `relayrace init --profile web-app` copies this runner and its lib helpers into
// scripts/, where cloud sessions and other machines have no kit installed.
// Dependency-free: Node 18+ built-ins only. The pure helpers are
// exported so they can be unit-tested without spawning anything.

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { launch } from './lib/exe.mjs';
import { taskPath, validGuardrails, validateCommands } from './lib/guardrails.mjs';

/** The repository a run belongs to: the git top level of `cwd`, else `cwd`. */
export function projectRoot(cwd = process.cwd(), run = launch) {
  if (process.env.QWEN_ROOT) return resolve(process.env.QWEN_ROOT);
  const r = run("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true, timeout: 5000 });
  return r.status === 0 && r.stdout.trim() ? resolve(r.stdout.trim()) : resolve(cwd);
}

const REPO_ROOT = projectRoot();

export const DEFAULT_HEALTH_URL = "http://127.0.0.1:8080/health";
// Deliberately NOT renamed: qwen.mjs copies installed in other repos (older or newer)
// must keep sharing one single-slot lock folder, so the default stays "relaykit-qwen".
export const DEFAULT_LOCK_NAME = "relaykit-qwen";

/**
 * The same file lib/config.mjs resolves (a test keeps the two equal): this
 * script has to work alone, so it reads the two qwen keys itself.
 */
export function userConfigFile({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const explicit = setting(env, "RELAYRACE_CONFIG");
  if (explicit) return resolve(explicit);
  return configIn("relayrace", { env, platform, home });
}

/** A RELAYRACE_* variable under its current name, else the RELAYKIT_* or AI_KIT_* spelling (first nonblank wins). */
function setting(env, variable) {
  for (const prefix of ["RELAYRACE_", "RELAYKIT_", "AI_KIT_"]) {
    const value = env[variable.replace(/^RELAYRACE_/, prefix)];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function configIn(folder, { env, platform, home }) {
  if (platform === "win32") return win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), folder, "config.json");
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, ".config"), folder, "config.json");
}

/** The files read before the renames (relaykit, then ai-kit); none when a file was chosen explicitly. */
export function legacyConfigFiles({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  return setting(env, "RELAYRACE_CONFIG") ? [] : ["relaykit", "ai-kit"].map((folder) => configIn(folder, { env, platform, home }));
}

/** Health URL and lock folder: environment, then the config file, then the defaults. */
export function qwenSettings({ env = process.env, platform = process.platform, home = homedir(), read = (p) => readFileSync(p, "utf8") } = {}) {
  let qwen = {};
  for (const file of [userConfigFile({ env, platform, home }), ...legacyConfigFiles({ env, platform, home })]) {
    try {
      qwen = JSON.parse(read(file).replace(/^\uFEFF/, "")).qwen ?? {};
      break;
    } catch {
      // No file here, or one the CLI will complain about; try the old places, then the defaults.
    }
  }
  const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const lockName = text(setting(env, "RELAYRACE_QWEN_LOCK")) ?? text(qwen.lockName) ?? DEFAULT_LOCK_NAME;
  return {
    healthUrl: text(setting(env, "RELAYRACE_QWEN_URL")) ?? text(qwen.healthUrl) ?? DEFAULT_HEALTH_URL,
    lockName: /^[\w.-]+$/.test(lockName) ? lockName : DEFAULT_LOCK_NAME,
  };
}

export const HEALTH_URL = qwenSettings().healthUrl;
export const MODEL = "local/qwen3-coder-next";
export const DEFAULT_TIMEOUT_MIN = 20;
export const DEFAULT_QUEUE_MAX_MIN = 60;
const QUEUE_POLL_MS = 10_000;

/**
 * Parse argv (without `node` and the script path). Pure.
 *
 * `--expect` may repeat; `--tsc` names a workspace package DIRECTORY
 * (`apps/web`), whose `tsconfig.json` the appended check targets.
 */
export function parseArgs(argv) {
  const opts = {
    health: false,
    optional: false,
    dryRun: false,
    task: undefined,
    prompt: undefined,
    expect: [],
    tsc: undefined,
    timeoutMin: DEFAULT_TIMEOUT_MIN,
    queueMaxMin: DEFAULT_QUEUE_MAX_MIN,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      i++;
      return value;
    };
    switch (arg) {
      case "--optional":
        opts.optional = true;
        break;
      case "--health":
        opts.health = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--task":
        opts.task = next();
        break;
      case "--prompt":
        opts.prompt = next();
        break;
      case "--expect":
        opts.expect.push(next());
        break;
      case "--tsc":
        opts.tsc = next();
        break;
      case "--timeout-min": {
        const n = Number(next());
        if (!Number.isFinite(n) || n <= 0) throw new Error("--timeout-min must be a positive number");
        opts.timeoutMin = n;
        break;
      }
      case "--queue-max-min": {
        const n = Number(next());
        if (!Number.isFinite(n) || n < 0) throw new Error("--queue-max-min must be zero or more");
        opts.queueMaxMin = n;
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!opts.health && !opts.task && !opts.prompt) {
    throw new Error("give --task <file> or --prompt <text> (or --health)");
  }
  if (opts.task && opts.prompt) throw new Error("--task and --prompt are exclusive");
  return opts;
}

/** Is this the body `/health` answers when the server is up? Pure. */
export function healthOk(body) {
  try {
    return JSON.parse(body)?.status === "ok";
  } catch {
    return false;
  }
}

/**
 * The standing footer every delegated task carries. The model is weaker than
 * the caller: it gets the conventions that bite most, told once, at the end
 * where they are read last.
 */
export function buildPrompt(task, { expect = [], tsc, rules = [] } = {}) {
  const lines = [task.trimEnd(), "", "---", "Standing rules for this task:"];
  lines.push(
    "- Work only inside this repository. Write files at the exact paths given; never ask where.",
    "- Do not ask questions. If something is ambiguous, pick the reading that matches the closest existing file and note it in a comment.",
    "- Follow the repository's AGENTS.md for language, styling, imports and naming; copy the sibling file you were pointed to.",
    ...rules.map((rule) => `- ${rule}`)
  );
  if (expect.length > 0) {
    lines.push(`- When done, these files must exist: ${expect.join(", ")}.`);
  }
  if (tsc) {
    lines.push(
      `- Before finishing, run \`npx tsc --noEmit -p ${tsc}\` and fix every error in the files you wrote. A test that is green under vitest but fails tsc is not done.`
    );
  }
  lines.push("- Finish by printing the line `DONE` followed by the list of files you wrote.");
  return lines.join("\n");
}

/** Which of the promised files are missing, given an `existsSync`-shaped probe. Pure. */
export function missingExpected(paths, exists, root = REPO_ROOT) {
  return paths.filter((p) => !exists(resolve(root, p)));
}

/**
 * The opencode argv for a run. Pure.
 *
 * `--title` is given so opencode does not spend a model call generating one —
 * the server has a single slot, and that call queues in front of the task.
 */
export function opencodeArgs({ taskFile, root = REPO_ROOT, title = `${basename(root)}-qwen` }) {
  return [
    "run",
    // The message goes FIRST: `--file` is an array option and would swallow it.
    "Do the task described in the attached file.",
    "-m",
    MODEL,
    "--auto",
    "--title",
    title,
    "--dir",
    root,
    "--file",
    taskFile,
  ];
}

/**
 * The environment for a run. Pure. opencode scans `.claude/skills/` and would
 * offer the local model this repo's Claude skills (`/feature`, `/qwen`…) — an
 * orchestration recipe it cannot follow, and a way to call itself.
 */
export function opencodeEnv(base) {
  // Config files, directories, inline content and permission overrides can all
  // change the guardrails validated on disk. Do not inherit OpenCode controls,
  // including future config sources; match Windows environment names too.
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.toUpperCase().startsWith('OPENCODE_')) env[key] = value;
  }
  env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1";
  return env;
}

/**
 * Quote one argument for cmd.exe, which `spawnSync(…, { shell: true })` hands
 * the joined command line to on Windows: a path or title with a space would
 * otherwise split in two. Pure.
 */
export function quoteForCmd(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * Where the run log lands: the OS temp dir, never the repo. The folder name is
 * the lock's too, and every runner that talks to the same server must use the
 * SAME one (set `qwen.lockName` in the config), or two of them would race for
 * its one slot.
 */
export function logPath(now = new Date(), base = tmpdir(), name = qwenSettings().lockName) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(base, name, `${stamp}.log`);
}

/**
 * Create the run's log and task files, each exclusively ("wx": it fails if ANY entry
 * already has the name, a symlink or hard link included), so nothing planted in the
 * shared temp folder is ever written through. On a name collision a new unique name
 * is tried; after `attempts` the run fails with a clear error. The empty log is
 * created BEFORE the model starts (its path is printed first) and stays open as a
 * file descriptor: the output is written to that descriptor, never by path.
 * Returns { log, taskFile, logFd }.
 */
// Anything at the path, even a link to nowhere. 'wx' alone is not enough: on Windows it follows a broken link and creates its target.
const lexists = (path) => { try { lstatSync(path); return true; } catch { return false; } };

export function createRunFiles(log, prompt, attempts = 5) {
  const stem = log.replace(/\.log$/, "");
  for (let attempt = 0; attempt < attempts; attempt++) {
    const base = attempt === 0 ? stem : `${stem}-${randomBytes(3).toString("hex")}`;
    const logFile = `${base}.log`;
    const taskFile = `${base}.task.md`;
    if (lexists(logFile) || lexists(taskFile)) continue;
    let logFd;
    try {
      logFd = openSync(logFile, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }
    try {
      writeFileSync(taskFile, prompt, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      closeSync(logFd);
      rmSync(logFile, { force: true }); // the empty file this attempt just created
      if (error.code === "EEXIST") continue;
      throw error;
    }
    return { log: logFile, taskFile, logFd };
  }
  throw new Error(`could not create a fresh log file next to ${log}: the names are taken; clear the folder and retry`);
}

/**
 * The repo's own standing rules for the model: `qwenRules` in .ai/project.json,
 * a list of short strings (money as strings, styles through tokens...). Anything
 * else is ignored rather than trusted into a prompt.
 */
export function projectRules(root, read = (p) => readFileSync(p, "utf8")) {
  try {
    const rules = JSON.parse(read(join(root, ".ai", "project.json"))).qwenRules;
    return Array.isArray(rules) ? rules.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim()) : [];
  } catch {
    return [];
  }
}

/** Whether `root` carries the opencode.json deny rules `--auto` relies on. */
export function hasGuardrails(root, read = p => readFileSync(p, 'utf8')) {
  try {
    let project = {};
    try { project = JSON.parse(read(join(root, '.ai/project.json'))); } catch (error) { if (error.code !== 'ENOENT') return false; }
    validateCommands(project.checks ?? []);
    validateCommands(project.qwenAllow ?? []);
    return validGuardrails(JSON.parse(read(join(root, 'opencode.json'))), [...(project.checks ?? []), ...(project.qwenAllow ?? [])]);
  } catch { return false; }
}

/** The lock every run takes before it talks to the single-slot server. */
export function lockPath(base = tmpdir(), name = qwenSettings().lockName) {
  return join(base, name, "run.lock");
}

/**
 * Is the lock left by a run that is gone? Pure: `isAlive(pid)` is injected.
 * An unreadable lock (empty, garbage) counts as stale — a crash mid-write
 * must not block the queue forever.
 */
export function lockIsStale(content, isAlive) {
  const pid = Number.parseInt(String(content).trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  return !isAlive(pid);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else — alive.
    return err.code === "EPERM";
  }
}

/**
 * Take the lock, waiting while another live run holds it. Resolves to a
 * release function, or to `undefined` when `maxWaitMs` passed first.
 * Creation is atomic (`wx`), so two runs racing for a free lock cannot both win.
 */
export async function acquireLock(
  file,
  {
    pid = process.pid,
    isAlive = pidAlive,
    maxWaitMs = DEFAULT_QUEUE_MAX_MIN * 60_000,
    pollMs = QUEUE_POLL_MS,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    onWait = () => {},
  } = {}
) {
  mkdirSync(dirname(file), { recursive: true });
  let waited = 0;
  for (;;) {
    try {
      const fd = openSync(file, "wx");
      writeFileSync(fd, String(pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    let content = "";
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue; // released between our open and our read — try again at once
    }
    if (lockIsStale(content, isAlive)) {
      rmSync(file, { force: true });
      continue;
    }
    if (waited >= maxWaitMs) return undefined;
    onWait(content.trim(), waited);
    await sleep(pollMs);
    waited += pollMs;
  }
}

export function checkHealth(fetchImpl = globalThis.fetch, url = HEALTH_URL) {
  return fetchImpl(url, { signal: AbortSignal.timeout(3000), redirect: "error" })
    .then((r) => r.ok ? r.text() : "")
    .then(healthOk)
    .catch(() => false);
}

function opencodeOnPath() {
  const r = launch("opencode", ["--version"], { timeout: 3000 });
  return r.status === 0;
}

export async function main(argv, { healthCheck = checkHealth, cliAvailable = opencodeOnPath, root = REPO_ROOT, tempBase = tmpdir() } = {}) {
  const opts = parseArgs(argv);

  const healthy = await healthCheck();
  if (opts.health) {
    const cli = cliAvailable();
    console.log(`server: ${healthy ? "ok" : "DOWN"} (${HEALTH_URL})`);
    console.log(`opencode: ${cli ? "on PATH" : "MISSING"}`);
    return healthy && cli ? 0 : 1;
  }
  const skip = (reason) => {
    console.log(`qwen: ${opts.optional ? "SKIPPED" : "UNAVAILABLE"} — ${reason}; continue with the primary agent.`);
    return opts.optional ? 0 : 2;
  };
  if (!healthy) {
    return skip("local server unavailable");
  }
  if (!cliAvailable()) {
    return skip("opencode is not on PATH");
  }
  // Not an availability problem, so --optional does not hide it: without the
  // repo's deny rules, --auto would approve anything the model asks for.
  if (!hasGuardrails(root)) {
    throw new Error(`${root} has insufficient opencode.json guardrails; review the "relayrace init" proposal and apply it manually.`);
  }
  const task = opts.task ? readFileSync(taskPath(root, opts.task), "utf8") : opts.prompt;
  const prompt = buildPrompt(task, { expect: opts.expect, tsc: opts.tsc, rules: projectRules(root) });

  const plannedLog = logPath(new Date(), tempBase);
  const argsFor = (taskFile, log) => opencodeArgs({ taskFile, root, title: `${basename(root)}-qwen-${basename(log, ".log")}` });
  if (opts.dryRun) {
    const planned = plannedLog.replace(/\.log$/, ".task.md");
    console.log(`opencode ${argsFor(planned, plannedLog).map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
    console.log(`task: ${planned}`);
    return 0;
  }
  mkdirSync(dirname(plannedLog), { recursive: true });
  const { log, taskFile, logFd } = createRunFiles(plannedLog, prompt);
  const args = argsFor(taskFile, log);

  const release = await acquireLock(lockPath(), {
    maxWaitMs: opts.queueMaxMin * 60_000,
    onWait: (holder, waitedMs) => {
      if (waitedMs % 60_000 === 0) {
        console.log(`qwen: the model is busy (run ${holder}); queued ${waitedMs / 60_000} min`);
      }
    },
  });
  if (!release) {
    closeSync(logFd);
    return skip(`model still busy after ${opts.queueMaxMin} min`);
  }
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.once(sig, () => {
      release();
      process.exit(130);
    });
  }

  const started = Date.now();
  console.log(`qwen: running (timeout ${opts.timeoutMin} min) — log at ${log}`);
  const r = launch("opencode", args, {
    cwd: root,
    env: opencodeEnv(process.env),
    encoding: "utf8",
    timeout: opts.timeoutMin * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const elapsedMin = ((Date.now() - started) / 60_000).toFixed(1);
  release();
  try {
    writeSync(logFd, `${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}`);
  } finally {
    closeSync(logFd);
  }

  const timedOut = r.error?.code === "ETIMEDOUT";
  const missing = missingExpected(opts.expect, existsSync);
  const tail = (r.stdout ?? "").trim().split("\n").slice(-12).join("\n");

  console.log(tail);
  console.log("");
  console.log(`qwen: ${timedOut ? "TIMED OUT" : `exit ${r.status}`} after ${elapsedMin} min`);
  for (const p of opts.expect) {
    console.log(`  ${missing.includes(p) ? "✗ missing" : "✓ written"}  ${p}`);
  }
  console.log("");
  console.log("Now: read every line it wrote, run the project's typecheck and relevant tests,");
  console.log("and add one line to the delegation ledger (task type · outcome · why).");

  return timedOut || missing.length > 0 || r.status !== 0 ? 1 : 0;
}

// Not shared with lib/: this file is copied alone into other repositories. argv[1] is resolved the way
// node resolved the module, so a path with a link in it (macOS /var, a junction) still runs.
const isMain = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`qwen: ${err.message}`);
      process.exit(2);
    }
  );
}
