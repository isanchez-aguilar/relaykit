---
name: redesign-module
description: Redesign one module end to end without losing a feature or shipping an unapproved layout — inventory every existing feature, build the screens and render PNGs, get the owner's approval, then tests, a Gemini review per lane with the PNGs, one Codex money/permissions review, the gate, visual baselines, PR and release. Use for a module-by-module redesign; one module per run.
argument-hint: <module to redesign>
---

# /redesign-module — one module, in this order

Module: `$ARGUMENTS`. Say in one line that you are taking this route ("Redesigning module X"). The reasoning is the redesign-module [playbook](https://github.com/isanchez-aguilar/relaykit/blob/main/docs/playbooks/redesign-module.md) in the Relaykit repo. Follow the repo's design system, never a new visual language.

## 1. Inventory the features

List every feature the module has TODAY from the code and the running app:
actions, filters, states, permission checks, empty and error states, exports,
integrations. One row each, with where it lives. This table is the acceptance
checklist: every row ends **kept**, **moved** (where) or **removed on purpose**
(the owner said so). Do not draw anything before it exists.

## 2. Build the screens and render PNGs

Use the `ui-designer` for the spec and `developer` lanes for the build, on
fixture data. Render every screen to PNG: both themes, phone and desktop width,
every state. Gaps are filled from the closest existing screen and listed as
assumptions.

## 3. Owner approval

Show the PNGs next to the inventory, with the rows each screen covers and the
rows still uncovered. Ask once, with options and your recommendation, and wait.
**No tests before this yes.**

## 4. Tests

Component and flow tests for the kept features, the inventory's edge cases and
permission checks per role. Typecheck and the touched suites green per lane.

## 5. Gemini review, one per lane, with the PNGs

Through Antigravity (see the `cross-review` skill): the approved PNGs, the
inventory and the diff; ask for visual and interaction deviations,
accessibility and missing states. List every path; verify every cited line.

## 6. Codex review, once for the module

Scoped to the risky diff: anything moving money, inventory or status, and every
permission check. Skip only if the module has neither, and say so in the PR.

## 7. Gate, then visual baselines

The repo's full gate once, serialized, with no agent running. Then the visual
baselines, generated in the pinned browser image CI uses, and compared with the
approved PNGs.

## 8. PR and release

Draft PR: the inventory outcome, the approved PNGs, the checks with results,
the reviews (confirmed / fixed / rejected), what was not tested. Merge only when
the owner says so; release with the `release-local` skill or the repo's own
process, after asking once.

One writer per file; reviews are read-only; delegate in the order of the
model-selection playbook.
