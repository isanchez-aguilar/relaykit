# Profiles

`relayrace init --profile <name>` installs a starter set into a repo. Files land in `.claude/agents`, `.claude/skills`, `.ai/` and `scripts/`.

| Profile | Installs |
|---|---|
| `generic` | The six generic roles (planner, implementer, reviewer, tester, writer, designer), the `work`, `bugfix` and `cross-review` skills, the review prompt, an `AGENTS.md` template, and `CLAUDE.md`/`GEMINI.md` pointers. Prints the proposed OpenCode guardrails. |
| `web-app` | The six-role pipeline (program-manager, architect, ui-designer, developer, qa, docs-writer), the `feature`, `fix`, `qwen`, `redesign-module`, `release-local` and `cross-review` skills, `scripts/qwen.mjs` with its `scripts/lib/` helpers, the review prompt, and an `AGENTS.md` whose **Project rules** section the repo fills in. Prints the proposed OpenCode guardrails. |
| `notes` | The writer role only, for an Obsidian or Markdown folder. |

## What is and is not baked in

No project names or business rules are baked in. The roles name risk categories (money, inventory, permissions, state changes) and leave the specifics (tenancy, styling, concurrency contracts) to the repo's own **Project rules** section of `AGENTS.md`.

The roles and skills under `.claude/` run inside a Claude Code session. Which CLI the relay and `relayrace providers pick` choose across tools is governed by the order in [Providers](providers.md).

## After installing

- Fill in the TODOs in `AGENTS.md`.
- Updating later: [Update a repo](getting-started.md#update-a-repo).
- The skills are short, agent-facing versions of the [playbooks](playbooks/README.md).
