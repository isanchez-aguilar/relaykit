---
name: feature
description: Run a feature or issue through the agent pipeline — program-manager scopes it, architect and ui-designer plan in parallel, developer lanes implement in parallel, qa and docs-writer close it, then one serialized gate and a draft PR. Use for anything bigger than a one-file fix; use /fix for bugs.
argument-hint: <feature description or issue id>
---

You are the orchestrator. The agents do the work; you route, merge and gate.
Your own context stays small: you read reports, not files. Load the `qwen`
skill only when you delegate yourself; the developer, qa and docs-writer
agents already carry it.

Request: `$ARGUMENTS`

Say in one line which route you took ("I am treating this as a size-M feature").

## Clarify first — the user's standing rule

The user wants to be asked BEFORE anything is designed or implemented when
something is unclear. Two places this happens:

- **You, before step 1.** If the request itself can be read two ways that lead
  to different work (who it is for, what «done» looks like, which app), ask
  with AskUserQuestion now — options with a recommended one first. Do not ask
  what the code, the docs or the issue already answer.
- **Any agent, at any step.** An agent cannot ask the user; it returns a
  `## Blocking questions` report instead of its deliverable. When one does,
  stop launching new work, gather the questions of every agent running in that
  step, ask them ALL in one AskUserQuestion call (at most four), then resume
  each agent with SendMessage carrying the answers. Never answer an agent's
  question by guessing.

## 0. Branch

Create `feat/<slug>` off the integration branch first. Never work on it directly.

## 1. Scope — `program-manager` (foreground, you need its answer)

Hand it the request verbatim plus any issue id. Get back the work breakdown
with its **Size**, and apply it without arguing:

| Size | Plan stage | Approval |
|---|---|---|
| S | none — go to step 3 with one developer lane | none |
| M | architect; ui-designer if a screen changes — **both in parallel** | none |
| L | architect + ui-designer in parallel | show the user the plan and wait before step 3 |

## 2. Plan — `architect` and `ui-designer` in parallel

One Agent call each, in the same message, in the background. Hand each the
breakdown and the request. Paste the architect's **Contracts** section into
every developer lane prompt — it is what lets the lanes run in parallel.

## 3. Build — `developer` lanes in parallel

One lane per area or screen, as the breakdown lists them, all launched in one
message. Each prompt carries: the goal, the lane's file list, the contracts,
the designer spec if it is UI, and the acceptance criteria that lane owns. Two
lanes never edit the same file; if the breakdown says they would, merge them.
Pass `model` explicitly on every Agent call (`sonnet` or `haiku` by default).
A lane that another provider should take goes through `relayrace relay` per
`AGENTS.md → Delegation`.

While they run: do not read source and do not «help». Wait for the reports. A
lane report with an **Open** item that blocks another lane is resumed with
SendMessage (same agent, context intact), not replaced by a new one.

## 4. Close — `qa` and `docs-writer` in parallel

Launch both in one message once every developer lane has reported. `qa` gets
the acceptance criteria and the lane reports; `docs-writer` gets the diff
scope and the lane reports. Findings go back to the developer lane that owns
the file, then `qa` re-checks only those findings. For size L, also run
`architect` in corrections mode on the final diff.

## 5. Gate — you, once, serialized

Run the repo's gate command (`AGENTS.md → Commands`) once, with no agent
running. If it fails, the failing area's developer lane fixes it; you do not.
Then the visual baselines, if the repo keeps them.

## 6. Independent review and ship

Commit in logical pieces (in the language specified by AGENTS.md, with the attribution lines the session
gives you), push, open a **draft** PR whose body lists the acceptance criteria
as checkboxes and the checks that ran. Then a DIFFERENT provider reviews it
read-only with `.ai/prompts/review.md` (see the `cross-review` skill if the
repo has it). Merge only when the owner says so.

Report to the user, in the language specified by AGENTS.md, under 200 words: what shipped, what each agent
found, what is open, the PR link.

## Token discipline

- An agent report is the deliverable; never re-read the files it touched to
  «double check» unless a later agent disagrees with it.
- Explore with the code index or an Explore agent, never a grep/read loop here.
- The pipeline costs more tokens than doing it alone and takes less wall time.
  Do not run it for an S-size task.
