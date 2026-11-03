---
name: qwen
description: Hand a mechanical task (fixtures, repetitive test cases, copy, a doc draft, boilerplate copied from a sibling) to the free local Qwen model through scripts/qwen.mjs, in the background, and review what comes back. Use whenever the local server is up and the work is on AGENTS.md's «Delegate» list; never for money writes, permissions, schema, status logic or architecture.
argument-hint: <what to produce, which files, which existing file to copy>
---

Delegate `$ARGUMENTS` to the local model. The wrapper encodes every lesson the
delegation ledger paid for; do not call `opencode run` by hand. Qwen is
optional: if it is down or absent, do the task yourself and say nothing more.

## 1. Is it allowed, and is it up?

- The task is on the **Delegate** list in `AGENTS.md → Delegation` and NOT on
  the **Never delegate** list. Anything touching money, locks, permissions,
  authentication, schema or architecture: do it yourself now and stop reading.
- Once per session: `node scripts/qwen.mjs --health`. Down → do it yourself;
  never start or stop the server.
- The repo's full gate or a coverage run is NOT running. It saturates the
  machine and the model times out under it.
- The repo has valid deny-by-default `opencode.json` permissions. `init` only
  prints the proposal and its destination; the owner reviews and applies it manually.
  The runner parses and refuses missing or insufficient rules without changing
  the config. Never widen permissions to get a refused run through.

## 2. Write the task file

`.ai/qwen-tasks/<slug>.md` (gitignored). The model is weaker than you and starts
from zero: it has not seen this conversation. The file must carry:

- **The exact output**: the path of every file to write, and for a test table
  the exact assertion per case, not the scenario. «Test the parser» produced a
  row that contradicted itself.
- **The template**: the path of the sibling file to copy the shape from, and
  the first case you wrote yourself, pasted in.
- **The imports it may use**, with the real export names (it has invented
  types a module did not export).
- **The spec's edge cases listed**, so it does not add behaviour the component
  lacks.

Keep one task medium-sized — a whole fixtures file, a full case table. Each run
spends ~30 s reading opencode's own prompt; one-liners waste it.

## 3. Run it in the background and keep working

```bash
node scripts/qwen.mjs --optional --task .ai/qwen-tasks/<slug>.md --expect <file> [--expect <file>] [--tsc <package dir>]
```

Run it in the background with a timeout of at least 20 minutes. Pass
`--tsc <package dir>` for anything TypeScript: a green test runner does not
typecheck. Then do the judgement work; do not poll. opencode writes its files
at the END of the run, so an empty log for ten minutes is normal.

## 4. Own the result

1. Read every line it wrote. Check it against `AGENTS.md`: conventions, naming,
   language, no behaviour the spec did not ask for, no self-contradicting case.
2. Run the repo's typecheck and the test file.
3. Fix what is wrong. If fixing takes longer than writing it would have, stop
   delegating that task type for the session and say so.
4. Record one line in the delegation ledger the repo or the session keeps:
   date · task type · accepted / small fixes / rewritten · why.

If the runner reports SKIPPED, do the task yourself; nothing was produced. The
optional flag covers an unavailable runtime/CLI or an exhausted queue only, not
invalid arguments or failed generation. Never make Qwen a gate.
