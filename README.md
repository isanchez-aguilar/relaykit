# Relayrace AI

[![test](https://github.com/isanchez-aguilar/relayrace-ai/actions/workflows/test.yml/badge.svg)](https://github.com/isanchez-aguilar/relayrace-ai/actions/workflows/test.yml) [![npm](https://img.shields.io/npm/v/relayrace-ai)](https://www.npmjs.com/package/relayrace-ai) [![license](https://img.shields.io/badge/license-Apache--2.0%20%2B%20MIT-blue)](LICENSE)

**Run Claude Code, Codex, Gemini and Jules as one team.** One shared contract, automatic hand-offs when a quota runs out, and independent code review across model families. Zero dependencies.

![relayrace doctor: which AI coding CLIs are ready, in which order they are tried, and whether the global files are in sync](https://raw.githubusercontent.com/isanchez-aguilar/relayrace-ai/main/docs/assets/doctor.png)

*Abridged example output of `relayrace doctor`.*

## Why

You probably pay for more than one AI coding tool, and each one has its own rules file, its own quota and its own blind spots. Relayrace is the layer that sits between them:

- **One contract.** `relayrace sync` writes the same working rules, roles and skills into Claude Code, Codex and Antigravity, so every agent follows the same playbook.
- **Hand-offs.** When a provider runs out of quota or fails verification, the task moves to the next one in *your* priority order (cheapest first), instead of stopping.
- **Independent review.** A change is never reviewed by the model family that wrote it. Independence counts by family (Anthropic, Google, OpenAI, local), not by tool.
- **Subscriptions first.** It refuses to run when an API key is in the environment, so a flat-rate subscription cannot silently turn into a paid API call.

It coordinates the CLIs you already have and does not install them. Node 18+ built-ins only, on Windows, macOS and Linux.

## Quick start (5 minutes)

You need Git, Node 18+ and at least two of Claude Code, Codex and Antigravity (`agy`) if you want the relay's cross-family review. Jules and a local Qwen model are optional.

```bash
npm install -g relayrace-ai
relayrace doctor          # what is installed and logged in (read-only)
relayrace sync            # preview the global changes, then ask before writing
```

Then set up a repository:

```bash
cd my-repo
relayrace init --profile generic --dry-run    # what it would add
relayrace init --profile generic              # add it (never overwrites)
```

Open the `AGENTS.md` that `init` created and fill in its TODOs. Then, in Claude Code, run `/work <a small task>` (or `/bugfix <a bug>`): the skills split the work across roles and ask another provider to review it.

Full walkthrough, including installing from a checkout: [Getting started](docs/getting-started.md).

## How the order is decided

Your providers live in one file; **the list order is the priority.** The default is: local Qwen, Jules, Gemini via Antigravity, Antigravity's Claude models, Codex, then Claude Code on the cheapest model that solves the task (Opus only in extreme cases). A task goes to the first provider that can do it; if it cannot, or its result fails verification, it moves to the next. Edit the order with `relayrace providers ui`. Details: [Providers](docs/providers.md).

## Works with Quota Desk

[Quota Desk](https://github.com/isanchez-aguilar/quota-desk) (formerly Agent Desk) is a companion local dashboard for your AI coding agents: quotas, sessions, tokens and a work log, read on your own machine. It is optional and separate. Relayrace can register each repo in its `config.json` and use its project list to measure Codex's size budget; see [Configuration](docs/configuration.md#optional-a-project-dashboard).

## Commands

| Command | What it does |
|---|---|
| `relayrace doctor` | Which CLIs are installed and logged in, local model health, global drift, this repo's state. Read-only. |
| `relayrace sync` | Install the shared contract, roles and skills into Claude Code, Codex and Antigravity. Previews first. |
| `relayrace init` | Set a repo up with a profile. Never overwrites. |
| `relayrace init --update` | Compare an installed repo with the kit and update only files you never edited. |
| `relayrace providers` | Your providers, plans, models and priority order. |
| `relayrace relay <task.json>` | Hand a task between providers, in order, with cross-family review. |
| `relayrace jules <task.json>` | One bounded Jules cloud task on its own branch. |
| `relayrace qwen` | Delegate mechanical work to the local model, safely. |
| `relayrace ci-local` | Run the repo's checks the way CI does, on this machine. |
| `relayrace update` | Fast-forward a checkout install. |

Every option: [Commands](docs/commands.md).

## Documentation

| Read this | When |
|---|---|
| [Getting started](docs/getting-started.md) | Installing, a new machine, a new repo, updating repos. |
| [Commands](docs/commands.md) | Every command and option. |
| [Providers](docs/providers.md) | Your subscriptions, models and the priority order. |
| [Relay and `task.json`](docs/relay.md) | Handing work between providers, and the Jules cloud bridge. |
| [Profiles](docs/profiles.md) | What `generic`, `web-app` and `notes` install. |
| [Configuration](docs/configuration.md) | Config file, `RELAYRACE_*` variables, backups, the Codex size budget. |
| [Reading `doctor`](docs/doctor.md) | What each section of the report means. |
| [FAQ and troubleshooting](docs/faq.md) | Something is missing, empty, stuck or too big. |
| [Safety model](docs/safety-model.md) | What the tool will never do, and why. |
| [Playbooks](docs/playbooks/README.md) | Processes that worked: cross-provider review, model selection, redesigns, releases. |

## Development

```bash
node --test          # the whole suite; CI runs it on Windows, macOS and Linux with Node 18 and 22
relayrace ci-local   # the same checks here, plus Linux containers when Docker is running
```

[CONTRIBUTING.md](CONTRIBUTING.md) explains the DCO sign-off (`git commit -s`). Security reports: [SECURITY.md](SECURITY.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## Licensing

| Paths | License |
|---|---|
| The code: `bin/`, `lib/`, `install.mjs`, `sync.mjs`, `relay.mjs`, `jules-relay.mjs`, the tests, the workflow | [Apache-2.0](LICENSE), with the [NOTICE](NOTICE) |
| The templates the tool copies into other repos: `agents/`, `skills/`, `templates/`, `prompts/`, `docs/playbooks/`, and `qwen.mjs` (installed as `scripts/qwen.mjs`) with the copies of `lib/exe.mjs` and `lib/guardrails.mjs` installed as `scripts/lib/*` (the same two files are Apache-2.0 inside this repository) | [MIT](LICENSE-TEMPLATES), Copyright (c) 2026 Isaac Sanchez Aguilar |
| `docs/contract.md` | A neutral starter contract, Apache-2.0 like the code. Write your own and point `contract` at it. |
| The name | "Relayrace" is reserved; see [TRADEMARKS.md](TRADEMARKS.md). A fork must use another name. |

Files installed into your repo carry no license header; the notice for them is `LICENSE-TEMPLATES` in this repo, so keep it with any copy you redistribute.
