---
name: fix
description: Run a bug or hotfix through the short pipeline — reproduce with a failing test first, developer fixes, qa breaks it again, architect checks corrections if money, isolation or permissions are involved, one gate, draft PR. Use for bugs, regressions and production hotfixes; use /feature for new work.
argument-hint: <bug description, error text or issue id>
---

You are the orchestrator of a fix. Short pipeline, same gate.

Bug: `$ARGUMENTS`

Say in one line which route you took ("I am treating this as a bug").

## Clarify first — the user's standing rule

If the expected behaviour is unclear (is this a bug or the intended rule?
which screen? which role sees it?), ask with AskUserQuestion before step 1,
options with a recommended one first. An agent that returns
`## Blocking questions` gets them asked the same way, all at once, and is
resumed with SendMessage carrying the answers — never answered by your guess.

## 0. Branch

`fix/<slug>` off the integration branch (or off the release branch for a
production hotfix — then it is back-merged after the release).

## 1. Reproduce before touching anything

Locate the code (the repo's code index, one query). Then launch ONE
`developer` lane whose first deliverable is a **failing test that reproduces
the bug** — unit, integration or component, next to the file. No fix until the
test is red. If it cannot be reproduced in a test, the lane says why and
proposes the repo check that would.

If the bug is in money, inventory, status, isolation or authentication, launch
`architect` in corrections mode **in parallel** on the suspect area, with the
bug description: it finds the sibling bugs the fix should cover.

## 2. Fix — the same developer lane (resume it with SendMessage)

The fix makes the test green and touches nothing else. For high-risk writes the
lane re-reads the repo's contract for them before the edit, not after.
Mechanical copies of the new test case (the other role, the other method, the
cancelled state) are a `qwen` task the lane hands over while it fixes.

## 3. Break it again — `qa`

Hand `qa` the diff, the reproduction and the architect findings, if any. It
runs the touched suite, the matching repo check, and tries the edges (retry,
second tenant, local day against UTC, cancelled). Findings go back to the
developer lane; `qa` re-checks only those.

## 4. Gate and ship

Run the repo's gate once, with no agent running. Commit (`fix(<scope>): …`),
push, open a **draft** PR whose body has: symptom, cause, fix, the test that
proves it, the checks that ran. A DIFFERENT provider reviews it read-only
with `.ai/prompts/review.md`. If the diagnosis took more than ~30 minutes or
the cause was not obvious from the error, `docs-writer` adds the entry to the
troubleshooting doc (symptom · cause · fix · PR).

Report to the user in the language specified by AGENTS.md, under 150 words: cause, fix, proof, PR link.
