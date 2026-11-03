import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  main,
  checkHealth,
  hasGuardrails,
  projectRoot,
  DEFAULT_QUEUE_MAX_MIN,
  DEFAULT_TIMEOUT_MIN,
  acquireLock,
  lockIsStale,
  lockPath,
  MODEL,
  buildPrompt,
  DEFAULT_HEALTH_URL,
  DEFAULT_LOCK_NAME,
  legacyConfigFiles,
  projectRules,
  qwenSettings,
  userConfigFile,
  healthOk,
  logPath,
  missingExpected,
  opencodeEnv,
  quoteForCmd,
  opencodeArgs,
  parseArgs,
} from "./qwen.mjs";

test("parseArgs: a task file with repeated --expect, a --tsc package and a timeout", () => {
  const o = parseArgs([
    "--task", "t.md",
    "--expect", "a.ts",
    "--expect", "b.ts",
    "--tsc", "apps/web",
    "--timeout-min", "7",
  ]);
  assert.equal(o.task, "t.md");
  assert.deepEqual(o.expect, ["a.ts", "b.ts"]);
  assert.equal(o.tsc, "apps/web");
  assert.equal(o.timeoutMin, 7);
  assert.equal(o.health, false);
  assert.equal(o.dryRun, false);
});

test("parseArgs: defaults — the timeout is 20 minutes and --health needs nothing else", () => {
  assert.equal(parseArgs(["--prompt", "hi"]).timeoutMin, DEFAULT_TIMEOUT_MIN);
  assert.equal(DEFAULT_TIMEOUT_MIN, 20);
  assert.equal(parseArgs(["--health"]).health, true);
  assert.equal(parseArgs(["--task", "t.md", "--dry-run"]).dryRun, true);
});

test("parseArgs: refuses no task, both task and prompt, a bad timeout, a missing value, an unknown flag", () => {
  assert.throws(() => parseArgs([]), /--task/);
  assert.throws(() => parseArgs(["--task", "a", "--prompt", "b"]), /exclusive/);
  assert.throws(() => parseArgs(["--task", "a", "--timeout-min", "0"]), /positive/);
  assert.throws(() => parseArgs(["--task", "a", "--timeout-min", "x"]), /positive/);
  assert.throws(() => parseArgs(["--task"]), /needs a value/);
  assert.throws(() => parseArgs(["--task", "--expect"]), /needs a value/);
  assert.throws(() => parseArgs(["--task", "a", "--wat"]), /unknown argument/);
});

test("healthOk: only the exact llama.cpp body counts", () => {
  assert.equal(healthOk('{"status":"ok"}'), true);
  assert.equal(healthOk('{"status":"loading model"}'), false);
  assert.equal(healthOk(""), false);
  assert.equal(healthOk("<html>502</html>"), false);
});

test("buildPrompt: the task comes first, the standing rules last, and the extras only when asked", () => {
  const plain = buildPrompt("Write the fixtures.\n");
  assert.ok(plain.startsWith("Write the fixtures.\n\n---\nStanding rules"));
  assert.match(plain, /Follow the repository's AGENTS\.md/);
  // Nothing project-specific leaks into the generic runner.
  assert.doesNotMatch(plain, /Money is a|var\(--/i);
  assert.match(plain, /printing the line `DONE`/);
  assert.doesNotMatch(plain, /must exist/);
  assert.doesNotMatch(plain, /tsc --noEmit/);

  const full = buildPrompt("Task", { expect: ["x.test.ts", "y.ts"], tsc: "apps/api" });
  assert.match(full, /these files must exist: x\.test\.ts, y\.ts/);
  assert.match(full, /npx tsc --noEmit -p apps\/api/);
  // The tsc rule explains WHY, so the model does not skip it as optional.
  assert.match(full, /green under vitest but fails tsc is not done/);

  // A repo's own rules come before the file list, one bullet each.
  const ruled = buildPrompt("Task", { rules: ["Money is a `string`.", "Styles only through tokens."], expect: ["a.ts"] });
  assert.ok(ruled.indexOf("- Money is a `string`.") < ruled.indexOf("these files must exist"));
  assert.match(ruled, /- Styles only through tokens\./);
});

test("projectRules: qwenRules from .ai/project.json, strings only, never an error", () => {
  const read = (text) => () => text;
  assert.deepEqual(projectRules("/r", read('{"qwenRules": [" a ", "", 3, "b"]}')), ["a", "b"]);
  assert.deepEqual(projectRules("/r", read("{}")), []);
  assert.deepEqual(projectRules("/r", read('{"qwenRules": "x"}')), []);
  assert.deepEqual(projectRules("/r", read("not json")), []);
  assert.deepEqual(projectRules("/r", () => { throw new Error("ENOENT"); }), []);
});

test("qwenSettings: environment, then the config file, then the defaults", () => {
  const home = "/home/me";
  const file = JSON.stringify({ qwen: { healthUrl: "http://10.0.0.5:8080/health", lockName: "shared-slot" } });
  const base = { platform: "linux", home };
  assert.deepEqual(qwenSettings({ ...base, env: {}, read: () => { throw new Error("none"); } }),
    { healthUrl: DEFAULT_HEALTH_URL, lockName: DEFAULT_LOCK_NAME });
  assert.deepEqual(qwenSettings({ ...base, env: {}, read: () => file }), { healthUrl: "http://10.0.0.5:8080/health", lockName: "shared-slot" });
  assert.deepEqual(qwenSettings({ ...base, env: { RELAYRACE_QWEN_URL: "http://127.0.0.1:9/health", RELAYRACE_QWEN_LOCK: "mine" }, read: () => file }),
    { healthUrl: "http://127.0.0.1:9/health", lockName: "mine" });
  // A lock name is a folder name: anything that could climb out of the temp dir is dropped.
  assert.equal(qwenSettings({ ...base, env: { RELAYRACE_QWEN_LOCK: "../x" }, read: () => "{}" }).lockName, DEFAULT_LOCK_NAME);
  // The old variable names still work, and the newest spelling wins.
  assert.equal(qwenSettings({ ...base, env: { AI_KIT_QWEN_URL: "http://old/health" }, read: () => "{}" }).healthUrl, "http://old/health");
  assert.equal(qwenSettings({ ...base, env: { RELAYKIT_QWEN_URL: "http://mid/health", AI_KIT_QWEN_URL: "http://old/health" }, read: () => "{}" }).healthUrl, "http://mid/health");
  assert.equal(qwenSettings({ ...base, env: { RELAYRACE_QWEN_URL: "http://new/health", RELAYKIT_QWEN_URL: "http://mid/health" }, read: () => "{}" }).healthUrl, "http://new/health");
  assert.equal(qwenSettings({ ...base, env: { RELAYKIT_QWEN_LOCK: "mid-lock", AI_KIT_QWEN_LOCK: "old-lock" }, read: () => "{}" }).lockName, "mid-lock");
  assert.equal(qwenSettings({ ...base, env: { AI_KIT_QWEN_LOCK: "old-lock" }, read: () => "{}" }).lockName, "old-lock");
  assert.equal(qwenSettings({ ...base, env: { RELAYRACE_QWEN_LOCK: "new-lock", RELAYKIT_QWEN_LOCK: "mid-lock" }, read: () => "{}" }).lockName, "new-lock");
  // The old config folders still work: relayrace, then relaykit, then ai-kit.
  const seen = [];
  const legacyOnly = qwenSettings({ ...base, env: {}, read: (p) => { seen.push(p); if (!p.includes("ai-kit")) throw new Error("none"); return file; } });
  assert.equal(legacyOnly.lockName, "shared-slot");
  assert.equal(seen.length, 3);
  assert.match(seen[0], /relayrace/);
  assert.match(seen[1], /relaykit/);
  const relaykitFolder = qwenSettings({ ...base, env: {}, read: (p) => { if (!p.includes("relaykit")) throw new Error("none"); return file; } });
  assert.equal(relaykitFolder.healthUrl, "http://10.0.0.5:8080/health");
  const newestFolder = qwenSettings({ ...base, env: {}, read: (p) => (p.includes("relayrace") ? JSON.stringify({ qwen: { lockName: "new-folder" } }) : file) });
  assert.equal(newestFolder.lockName, "new-folder");
  // A file chosen with any spelling of the variable disables the folder fallback.
  const chosen = [];
  qwenSettings({ ...base, env: { RELAYKIT_CONFIG: "/x/c.json" }, read: (p) => { chosen.push(p); throw new Error("none"); } });
  assert.equal(chosen.length, 1);
});

test("the default lock folder name stays relaykit-qwen so old and new copies of qwen.mjs share one lock", () => {
  assert.equal(DEFAULT_LOCK_NAME, "relaykit-qwen");
});

test("userConfigFile: the standalone runner and the CLI agree on where the config lives", async () => {
  const { configFilePath, legacyConfigFilePaths } = await import("./lib/config.mjs");
  const cases = [
    { env: { APPDATA: "A" }, platform: "win32", home: "H" },
    { env: {}, platform: "win32", home: "H" },
    { env: {}, platform: "darwin", home: "/Users/me" },
    { env: { XDG_CONFIG_HOME: "/cfg" }, platform: "linux", home: "/home/me" },
    { env: { RELAYRACE_CONFIG: "c.json" }, platform: "linux", home: "/home/me" },
    { env: { RELAYKIT_CONFIG: "mid.json" }, platform: "linux", home: "/home/me" },
    { env: { AI_KIT_CONFIG: "old.json" }, platform: "linux", home: "/home/me" },
    { env: { RELAYRACE_CONFIG: "c.json", RELAYKIT_CONFIG: "mid.json", AI_KIT_CONFIG: "old.json" }, platform: "linux", home: "/home/me" },
  ];
  for (const c of cases) {
    assert.equal(userConfigFile(c), configFilePath(c));
    assert.deepEqual(legacyConfigFiles(c), legacyConfigFilePaths(c));
  }
});

test("missingExpected: resolves against the root and reports only the absent ones", () => {
  const seen = [];
  const exists = (p) => {
    seen.push(p.replace(/\\/g, "/"));
    return p.endsWith("present.ts");
  };
  const missing = missingExpected(["present.ts", "absent.ts"], exists, "/repo");
  assert.deepEqual(missing, ["absent.ts"]);
  // `path.resolve` prefixes the drive letter on Windows, so compare the tail.
  assert.ok(seen[0].endsWith("/repo/present.ts"), seen[0]);
  assert.ok(seen[1].endsWith("/repo/absent.ts"), seen[1]);
  assert.deepEqual(missingExpected([], exists, "/repo"), []);
});

test("opencodeArgs: the task travels as a file, the run is auto-approved and pinned to the repo", () => {
  const args = opencodeArgs({ taskFile: "/tmp/t.md", root: "/repo" });
  assert.equal(args[0], "run");
  assert.ok(args.includes("-m") && args[args.indexOf("-m") + 1] === MODEL);
  assert.ok(args.includes("--auto"), "a permission prompt nobody answers looks like a hang");
  assert.deepEqual(args.slice(args.indexOf("--dir"), args.indexOf("--dir") + 2), ["--dir", "/repo"]);
  assert.deepEqual(args.slice(args.indexOf("--file"), args.indexOf("--file") + 2), ["--file", "/tmp/t.md"]);
  // The message is a constant (the quoting problem lives in the file) and comes
  // right after `run`: `--file` is an array option that would swallow it.
  assert.equal(args[1], "Do the task described in the attached file.");
});

test("logPath: lands in the temp dir, under the lock's folder, with a filesystem-safe stamp", () => {
  const p = logPath(new Date("2026-10-04T20:15:30.123Z"), "/tmp", "relaykit-qwen").replace(/\\/g, "/");
  assert.equal(p, "/tmp/relaykit-qwen/2026-10-04T20-15-30-123Z.log");
});

test("parseArgs: --queue-max-min defaults to an hour, accepts 0, refuses a negative", () => {
  assert.equal(parseArgs(["--prompt", "x"]).queueMaxMin, DEFAULT_QUEUE_MAX_MIN);
  assert.equal(DEFAULT_QUEUE_MAX_MIN, 60);
  assert.equal(parseArgs(["--prompt", "x", "--queue-max-min", "0"]).queueMaxMin, 0);
  assert.throws(() => parseArgs(["--prompt", "x", "--queue-max-min", "-1"]), /zero or more/);
});

test("lockPath: one lock for every run, in the temp dir", () => {
  assert.equal(lockPath("/tmp", "relaykit-qwen").replace(/\\/g, "/"), "/tmp/relaykit-qwen/run.lock");
  assert.equal(lockPath("/tmp", "project-qwen").replace(/\\/g, "/"), "/tmp/project-qwen/run.lock");
});

test("lockIsStale: a dead or unreadable holder is stale, a live one is not", () => {
  const alive = (pid) => pid === 42;
  assert.equal(lockIsStale("42", alive), false);
  assert.equal(lockIsStale("42\n", alive), false);
  assert.equal(lockIsStale("43", alive), true);
  assert.equal(lockIsStale("", alive), true);
  assert.equal(lockIsStale("garbage", alive), true);
  assert.equal(lockIsStale("-5", alive), true);
});

function tempLock() {
  return join(mkdtempSync(join(tmpdir(), "qwen-lock-test-")), "q", "run.lock");
}

test("acquireLock: takes a free lock, writes its pid, and release removes it", async () => {
  const file = tempLock();
  const release = await acquireLock(file, { pid: 7, isAlive: () => true, sleep: async () => {} });
  assert.equal(typeof release, "function");
  assert.equal(readFileSync(file, "utf8"), "7");
  release();
  assert.equal(existsSync(file), false);
});

test("acquireLock: waits while a live run holds it, then takes it once released", async () => {
  const file = tempLock();
  const first = await acquireLock(file, { pid: 1, isAlive: () => true, sleep: async () => {} });
  const waits = [];
  const second = await acquireLock(file, {
    pid: 2,
    isAlive: () => true,
    pollMs: 10,
    onWait: (holder, waited) => waits.push([holder, waited]),
    // The first run finishes while the second sleeps.
    sleep: async () => first(),
  });
  assert.deepEqual(waits, [["1", 0]]);
  assert.equal(readFileSync(file, "utf8"), "2");
  second();
});

test("acquireLock: gives up after maxWaitMs and leaves the holder's lock alone", async () => {
  const file = tempLock();
  await acquireLock(file, { pid: 1, isAlive: () => true, sleep: async () => {} });
  const got = await acquireLock(file, {
    pid: 2,
    isAlive: () => true,
    maxWaitMs: 30,
    pollMs: 10,
    sleep: async () => {},
  });
  assert.equal(got, undefined);
  assert.equal(readFileSync(file, "utf8"), "1");
});

test("acquireLock: steals a lock whose holder died", async () => {
  const file = tempLock();
  await acquireLock(file, { pid: 1, isAlive: () => true, sleep: async () => {} });
  writeFileSync(file, "999");
  const release = await acquireLock(file, {
    pid: 3,
    isAlive: (pid) => pid !== 999,
    sleep: async () => {
      throw new Error("must not wait on a dead holder");
    },
  });
  assert.equal(readFileSync(file, "utf8"), "3");
  release();
});

test("opencodeArgs: a title is always passed, so opencode spends no model call naming the session", () => {
  const args = opencodeArgs({ taskFile: "/t.md", root: "/r", title: "project-qwen-x" });
  assert.deepEqual(args.slice(args.indexOf("--title"), args.indexOf("--title") + 2), ["--title", "project-qwen-x"]);
  const dflt = opencodeArgs({ taskFile: "/t.md", root: "/r" });
  // The default title names the project, so a run from any repo is identifiable.
  assert.equal(dflt[dflt.indexOf("--title") + 1], "r-qwen");
});

test('opencodeEnv: removes inherited config and permission overrides without mutating the parent', () => {
  const base = { PATH: '/bin', HOME: '/h', OPENCODE_CONFIG_CONTENT: '{"permission":{"bash":"allow"}}',
    OPENCODE_CONFIG: '/unsafe.json', OPENCODE_CONFIG_DIR: '/unsafe', OPENCODE_TUI_CONFIG: '/tui.json',
    OPENCODE_PERMISSION: '{"bash":"allow"}', opencode_config_content: '{"permission":{"bash":"allow"}}',
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '0' };
  const original = { ...base };
  assert.deepEqual(opencodeEnv(base), { PATH: '/bin', HOME: '/h', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1' });
  assert.deepEqual(base, original);
});

test("opencodeEnv: hides this repo's Claude skills from the local model, keeps the rest", () => {
  const env = opencodeEnv({ PATH: "/bin", HOME: "/h" });
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS, "1");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/h");
});

test("quoteForCmd: quotes what cmd.exe would split or interpret, leaves plain tokens alone", () => {
  assert.equal(quoteForCmd("--auto"), "--auto");
  assert.equal(quoteForCmd(String.raw`C:\Users\Ana\project`), String.raw`C:\Users\Ana\project`);
  assert.equal(quoteForCmd("Do the task"), '"Do the task"');
  assert.equal(quoteForCmd(String.raw`C:\Users\Ana María\t.md`), String.raw`"C:\Users\Ana María\t.md"`);
  assert.equal(quoteForCmd("a&b"), '"a&b"');
  assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""');
});

test("optional task skips an absent server before reading input or invoking a CLI", async () => {
  const code = await main(["--optional", "--task", "does-not-exist.md"], {
    healthCheck: async () => false,
    cliAvailable: () => { throw new Error("must not invoke CLI"); },
  });
  assert.equal(code, 0);
});

test("optional task skips a missing CLI; strict task and health remain diagnostic", async () => {
  const absentCli = { healthCheck: async () => true, cliAvailable: () => false };
  assert.equal(await main(["--optional", "--prompt", "fixture"], absentCli), 0);
  assert.equal(await main(["--prompt", "fixture"], absentCli), 2);
  assert.equal(await main(["--optional", "--health"], absentCli), 1);
  assert.equal(await main(["--health"], { healthCheck: async () => true, cliAvailable: () => true }), 0);
});

test("optional does not hide invalid arguments", async () => {
  await assert.rejects(main(["--optional", "--task"]), /needs a value/);
  await assert.rejects(main(["--optional", "--prompt", "x", "--timeout-min", "0"]), /positive/);
});

test("health requires HTTP success, rejects redirects and handles an offline runtime", async () => {
  assert.equal(await checkHealth(async (url, options) => {
    assert.equal(url, "http://127.0.0.1:8080/health");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return new Response('{"status":"ok"}');
  }), true);
  assert.equal(await checkHealth(async () => new Response('{"status":"ok"}', { status: 503 })), false);
  assert.equal(await checkHealth(async () => { throw new Error("offline"); }), false);
});

test("the project root is the git top level of cwd, QWEN_ROOT wins, cwd is the fallback", () => {
  const git = (stdout, status = 0) => () => ({ status, stdout });
  const posix = (p) => p.replaceAll("\\", "/").replace(/^[A-Z]:/, "");
  const saved = process.env.QWEN_ROOT;
  delete process.env.QWEN_ROOT;
  try {
    assert.equal(posix(projectRoot("/repo/src", git("/repo\n"))), "/repo");
    assert.equal(posix(projectRoot("/loose", git("", 128))), "/loose");
    process.env.QWEN_ROOT = "/pinned";
    assert.equal(posix(projectRoot("/repo", git("/repo\n"))), "/pinned");
  } finally {
    if (saved === undefined) delete process.env.QWEN_ROOT;
    else process.env.QWEN_ROOT = saved;
  }
});

test("a repo without opencode.json guardrails is refused, even with --optional", () => {
  assert.equal(hasGuardrails("/r", () => "{}"), false);
  assert.equal(hasGuardrails("/r", () => false), false);
});
