# Playbook: model selection

Spend the cheapest thing that can do the step well, and spend the quota that
resets before the quota that does not. This is the order to delegate in.

## The order

**Use the first provider on the list that CAN do the task.** If it cannot, or
its result fails verification (tests, typecheck, a reviewer), move to the next,
until the task is done: always the cheapest that works. A provider that returns
something unverified has not done the task. Go down the list once per task; when no eligible provider is left, or the attempt or time budget the owner set is spent, stop and report what blocked it instead of retrying. (See *What never goes down the
list* for what «can» excludes.) This is the default; each person's own order, models and plans
live in their providers file (`relaykit providers`, edited by hand or in
`relaykit providers ui`), and a repo may override it in `.ai/providers.json`.
`relaykit providers pick <capability>` tells you who takes a task.

1. **Local Qwen** — mechanical work with an exact expected output (fixtures,
   copies of a test you wrote, strings). Optional: if the server is down, the
   next provider does the work.
2. **Jules** — bounded cloud tasks, each on its own branch. It sees the remote
   branch only, never local uncommitted files. Never a reviewer.
3. **Gemini via Antigravity** — reviews, visual checks and drafts. Use a Flash
   model for mechanical work.
4. **Antigravity's Claude models** — edit-only tasks where every path is listed
   in the prompt. A headless run cannot ask for a permission: it dies on the
   first denied command, so give it files to edit, never commands to run.
5. **Codex** — implementation, reviews and tests. It has a weekly reset, so
   spending it is fine. This is where work that needs judgement lands.
6. **Claude Code subagents** — last, on the cheapest model that solves the
   task (`haiku` for searches and mechanical edits, `sonnet` for
   implementation and docs).

## Opus and Fable

- **Opus only when it is truly necessary:** a money or security judgement that
  no other provider on this list can cover. If Codex can review it, Codex
  reviews it.
- **Never Fable (the most expensive Claude tier) without the owner's yes**, for that specific use: not as a subagent
  model, not in an agent's frontmatter, not with `--model`, not by switching
  the session. The relay refuses it unless `RELAYKIT_ALLOW_FABLE=1` is set after
  the owner says yes.
- Always pass an explicit model to a subagent. `inherit` lets a session on an
  expensive model spend it on every subagent.

## What never goes down the list

Skipping a provider is allowed only when it cannot do the task. Anything below
stays with a provider that can reason about it, whatever the cost: money and
inventory writes, permissions and authentication, schema changes and migrations,
architecture decisions. Money, permissions, schema and architecture never go
below Codex or Claude; Qwen, Jules and Flash never decide these (the
`critical` capability in the providers file).

## Checking the choice

- A reviewer is never the provider that implemented, and independence counts
  by **model family** (Anthropic, Google, OpenAI, local), not by CLI.
  Antigravity running a Claude model is still Claude. Implemented by Codex,
  then Claude or Antigravity with a Gemini model reviews; implemented by
  Claude, then Codex or Antigravity with Gemini or gpt-oss reviews.
- If fixing a delegate's output takes longer than doing the step yourself, stop
  delegating that kind of step for the session and say so in the report.
- Record what you delegated and whether it paid off (accepted, fixed,
  rewritten). A delegation that keeps being rewritten is the wrong delegation.

## Limits to remember

- Codex and Claude share nothing; each has its own quota and reset. Run
  `relaykit doctor` to see which CLIs are installed and logged in before planning
  a run around one of them.
- Antigravity quota groups can be shared by several models; they are not
  independent credit pools.
- Never buy credits or switch to a paid API key to get past a quota. Hand the
  work to the next provider on the list, or stop and report.
