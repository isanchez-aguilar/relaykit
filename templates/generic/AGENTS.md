# AGENTS.md — {{name}}

Rules for any coding agent in this repository. The owner's global working
contract (language, models, independent review, git) applies on top of this
file; what is specific to this project lives here and wins.

## Project in one sentence

TODO: what this project is and who it is for.

## Commands

{{commands}}

## Conventions

TODO: language of code and UI, styling, test layout, anything an agent must
not do here.

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

## Before delivery

Run `relaykit ci-local` (the suite here and in Linux containers; `relaykit ci-local --install-hook` does it on every push) and report what it could not run, such as macOS, as not verified.

Run the checks listed in `.ai/project.json` and report their results. A change
is reviewed by a different provider with `.ai/prompts/review.md`.
