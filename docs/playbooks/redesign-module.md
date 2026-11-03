# Playbook: redesign a module, one module at a time

How to redesign a screen-heavy module (a list, a form flow, a settings area)
without losing a feature, without shipping a layout nobody approved, and
without spending the scarce reviews early. Worked in a real redesign; the
order matters. The `redesign-module` skill is the short version.

Pipeline:

1. inventory the features
2. build the screens and render PNGs
3. owner approval
4. tests
5. one Gemini review per lane, with the PNGs
6. one Codex money/permissions review for the module
7. gate
8. visual baselines (VRT)
9. PR
10. release

## 1. Inventory the features first

Before drawing anything, list **every feature the module has today**, read from
the code and the running app, not from memory: each action, each filter, each
state, each permission check, each empty and error state, each export or
integration. One row per feature, with where it lives in the code.

This is the step that is skipped and regretted: a redesign that looks better and
quietly drops «duplicate», «bulk select» or an offline state. The inventory is
the acceptance checklist for step 3 and for the PR: every row is **kept**,
**moved** (say where) or **removed on purpose** (the owner said so).

## 2. Build the screens and render PNGs

- Build the screens from the design system first, using real components and
  real tokens, on fixture data. No new visual language: gaps are filled from the
  closest existing screen and listed as assumptions.
- Render every screen to a **PNG**: both themes, a phone width and a desktop
  width, and every state (empty, loading, error, long content, no permission).
  The PNGs are the review material for steps 3 and 5; a description of a screen
  is not evidence.
- Keep the build deterministic (fixed dates, fixed data) so step 8 can compare.

## 3. Owner approval — before any test is written

Show the owner the PNGs next to the inventory: which rows each screen covers
and which are still uncovered. Ask once, with options, and wait. Tests written
before approval get rewritten when the layout changes, and a baseline proves a
screen did not change, never that it is right. Prove the boards cover every
inventory row before asking.

## 4. Tests

Now write them: component and flow tests for the kept features, the edge cases
from the inventory, and permission checks per role. The first test of a table
is written by the implementer; the repetitive copies may go to the local model.
Typecheck and the touched suites green, per lane.

## 5. One Gemini review per lane, with the PNGs

Each lane (a screen, a flow) is reviewed once by Gemini through Antigravity,
with the PNGs attached, the inventory and the diff. Ask it for visual and
interaction deviations from the approved screens, accessibility, and missing
states. Headless runs read files only and need every path listed; see
[cross-provider-review](cross-provider-review.md). Verify each cited line before
acting on it.

## 6. One Codex review for money and permissions

Once per module, scoped to the risky diff: anything that moves money, inventory or
status, and every permission check. Codex reads it read-only with the repo's
money/permissions contract. Skip it only for a module with neither, and say so
in the PR. Fix confirmed findings, re-review those only.

## 7. Gate

Run the repo's full gate once, serialized, with no agent running (parallel
gates starve the machine and fail unrelated tests for memory).

## 8. Visual baselines

Generate the baselines in the same environment CI uses (the pinned browser
image), never the host browser: fonts and anti-aliasing differ. Review the new
baselines against the approved PNGs; a baseline of the wrong thing passes
forever.

## 9. PR

Draft PR with: the inventory table and its outcome, the approved PNGs, the
checks that ran with results, the reviews (who, what was confirmed, fixed or
rejected), what was not tested and the risks. Merge only when the owner says so.

## 10. Release

Follow [release-local](release-local.md) or the repo's own release process.
Ask the owner once before starting; do not release modules in a batch you
cannot roll back one by one.

## Ownership while it runs

One writer per file. Lanes are screens or flows that do not share files; two
lanes on one file are one lane. Reviews are read-only. Delegate with
[model-selection](model-selection.md): mechanical copies to Qwen first,
visual checks to Gemini, implementation and tests to Codex.
