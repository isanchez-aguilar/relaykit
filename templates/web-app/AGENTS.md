# AGENTS.md — {{name}}

The working contract for any coding agent in this repository. The owner's
global contract (language, models, independent review, git) applies on top of
this file; what is specific to this project lives here and wins. Every line
here is loaded into every session, so every line is an instruction: put the
reasoning and the long tables in `docs/` and link them from the rule.

## Project in one sentence

TODO: what this product is, who uses it, which phase is active.

## Commands

{{commands}}

TODO: name the ONE gate command to run before a PR, the fast loop while
writing code, and any check that proves a high-risk write (concurrency,
integration, end-to-end). If the gate is still unspecified, agents must ask
the owner for the command before proceeding to the gate or a PR; never guess.

## Architecture

TODO: the layers and which way dependencies point (for example
`routes → services → domain`), where business logic may and may not live, and
the folder layout of each app. Agents design inside this and never swap a
stack choice without a discussion.

## Project rules

Fill in the rules that apply to this project. The commented examples below
are prompts for the owner, not active rules for agents.

<!-- Example: Language: code and commits in English; product copy in the language chosen by the repo. -->
<!-- Example: Styling: reuse the tokens and components named in docs/design.md. -->
<!-- Example: Users: describe their devices and the tasks they need to finish. -->
<!-- Example: Isolation: scope queries to the authenticated tenant using the project's authorization helper. -->
<!-- Example: High-risk writes: name the concurrency and idempotency contract and its checks. -->
<!-- Example: Data model: name the schema directory, migration command and schema documentation. -->
<!-- Example: Logging and secrets: name the logger, redaction rules and files agents must not read. -->

## Testing

TODO: where tests live next to what they test, the coverage threshold if any,
how visual baselines are rendered (use the pinned browser image, never the host
browser) and which new screens need one.

## Documentation

TODO: a map from change type to the doc that owns it (schema, API reference,
commands, module docs, troubleshooting), so the `docs-writer` agent puts each
thing in one place.

## Delegation

Try providers in this order, top to bottom (the playbook is
[model-selection](https://github.com/isanchez-aguilar/relaykit/blob/main/docs/playbooks/model-selection.md) in the Relaykit repo):

1. Local Qwen (optional): mechanical work with an exact expected output.
2. Jules: bounded cloud tasks on their own branch.
3. Gemini through Antigravity: reviews, visual checks and drafts; Flash for
   mechanical work.
4. Antigravity's Claude models: edit-only tasks with every path listed; a
   headless run dies on the first denied command.
5. Codex: implementation, reviews and tests.
6. Claude Code subagents last, on the cheapest model that solves the task
   (`haiku`, then `sonnet`).

Use the first provider on the list that CAN do the task. If it cannot, or its
result fails verification (tests, typecheck, a reviewer), move to the next, until
it is done: always the cheapest that works. Go down the list once per task; when no eligible provider is left, or the attempt or time budget the owner set is spent, stop and report what blocked it instead of retrying. Money, permissions, schema and
architecture never go below Codex or Claude. A person's own order and models
are in their providers file (`relaykit providers`).

Opus only in extreme cases: a money or security judgement no other provider
can cover. Never Fable without the owner's yes for that specific use. Whoever
implements is never the only reviewer, and independence counts by model
family: the Claude models in Antigravity are not independent of Claude Code.

**Local model (Qwen), optional.** Run `node scripts/qwen.mjs --health` once per
session; if it is down, do the work yourself and say nothing more.

- *Delegate:* test fixtures and mock factories; boilerplate that copies a
  sibling file; copy and strings; repetitive test cases once the first is
  written; first drafts of docs.
- *Never delegate:* money, inventory or status writes; permissions, authentication
  and isolation; schema changes and migrations; architecture decisions; anything
  spanning more than two packages.

After delegating you own the result: read every line, run the typecheck and the
tests, and record whether it was accepted, fixed or rewritten.

## Before delivery

Run `relaykit ci-local` (the suite here and in Linux containers; `relaykit ci-local --install-hook` does it on every push) and report what it could not run, such as macOS, as not verified.

Run the applicable checks and the gate, and report each result; a check you did
not run did not pass. A change is reviewed by a different provider with
`.ai/prompts/review.md`. Merge only when the owner says so.
