# Relayrace AI

[![test](https://github.com/isanchez-aguilar/relayrace-ai/actions/workflows/test.yml/badge.svg)](https://github.com/isanchez-aguilar/relayrace-ai/actions/workflows/test.yml) [![npm](https://img.shields.io/npm/v/relayrace-ai)](https://www.npmjs.com/package/relayrace-ai) [![license](https://img.shields.io/badge/license-Apache--2.0%20%2B%20MIT-blue)](LICENSE)

**Run Claude Code, Codex, Gemini and Jules as one team.** One shared contract, automatic hand-offs when a quota runs out, and independent code review across model families. Zero dependencies.

Relayrace (package `relayrace-ai`, command `relayrace`) connects Claude Code, Codex, Antigravity (Gemini), Jules and a local Qwen. They share one work contract, they hand work to each other when one runs out of quota, and they review each other's changes. It has no dependencies: Node 18+ built-ins only, on Windows, macOS and Linux.

## Quick start (5 minutes)

You need Git and Node 18+. Relayrace coordinates the AI coding CLIs you already use and does not install them: have the ones you want (Claude Code, Codex, Antigravity's `agy`, Jules, OpenCode for a local model) and use at least two of Claude Code, Codex and Antigravity for the relay's independent review. Install from npm and see which it finds:

```bash
npm install -g relayrace-ai
relayrace doctor
relayrace sync        # shows the changes and asks before writing; --check only compares
```

`relayrace sync` installs the default contract (`docs/contract.md`, a short set of neutral working rules) and the shared roles and skills into the global configuration of Claude Code, Codex and Antigravity. To use your own contract, copy that file, edit it and set `contract` in your [config](#configuration); keep its `contract:start` / `contract:end` (the Spanish `contrato:inicio` / `contrato:fin` are still read) markers.

### From a checkout (updates with `relayrace update`)

```bash
git clone https://github.com/isanchez-aguilar/relayrace-ai.git && cd relayrace-ai
./scripts/setup.sh        # Windows: .\scripts\setup.ps1
relayrace doctor
relayrace sync
```

Setup shows the Node executable and checkout it found, installs a launcher in your user bin folder, and asks before adding that folder to your user PATH. Answer `Y`, then open a new terminal before running `relayrace doctor` and `relayrace sync`. These commands then work from any folder. No administrator rights are needed. Re-run setup after moving the checkout or removing the Node version it uses. `-Yes` (PowerShell) or `--yes` (shell) accepts the PATH change without prompting.

If PowerShell blocks the setup script, run this once from the checkout:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

This only changes policy for that process. A script blocked before execution cannot print its own workaround. The Windows launcher is `%LOCALAPPDATA%\Relaykit\bin\relayrace.cmd`; the optional PowerShell companion lives under `bin\powershell\relayrace.ps1` so a restrictive execution policy does not block the ordinary `relayrace` command. On macOS/Linux, the launcher is `~/.local/bin/relayrace`; setup appends its PATH block to your shell's startup files (Bash/sh, Zsh or Fish). If `./scripts/setup.sh` is not executable, use `sh scripts/setup.sh`. If a new tab still has the old PATH, restart the terminal app.

### A new machine

Run `relayrace doctor`, log in to the providers you use, then run `relayrace sync`. Sync previews changes and asks `Apply these N changes? [y/N]`. `--check` stays read-only; `--yes` applies without asking. Without an interactive terminal, plain `sync` behaves like `--check` and says so (exit 1 on drift or a declined change).

If you installed from npm, update with `npm update -g relayrace` and run `relayrace sync` again. From a checkout, use `relayrace update` to pull fast-forward updates into the checkout used by the launcher. It refuses local changes, including untracked files, and installations without their own Git checkout. After an update it tells you to run `relayrace sync` again. Your current folder does not change which checkout gets updated.

<details>
<summary>Manual install</summary>

With Node and npm already on PATH, the long forms remain available:

```bash
npx relayrace-ai doctor
npx relayrace-ai sync --check
npx relayrace-ai sync
npm install -g relayrace-ai
```

From a local checkout, use `node bin/relayrace.mjs doctor` or `node bin/relayrace.mjs sync --check`. If Node is absent from PATH, use its full executable path. The setup scripts save that path for you.

</details>

### A new repo

```bash
cd my-repo
git init                                                            # if the folder is new
relayrace init --profile web-app --dry-run                             # what it would add
relayrace init --profile web-app                                       # add it
```

$1
Then try it: in Claude Code run `/work <a small task>` (or `/bugfix <a bug>`); the skills split the work across the roles and ask another provider to review it. To hand a task between CLIs when one runs out of quota, write a `task.json` ([format](#taskjson)) and run `relayrace relay task.json`.

For Qwen, `init` prints a proposed `opencode.json` and the path where the user can save it. Review and apply it manually, merging with an existing file if needed. `init` never writes permission rules; the former `--with-opencode` and `--no-opencode` flags are removed. Qwen refuses missing or insufficient guardrails without changing them.

`init` also prints proposed Antigravity read/deny rules and their settings path;
the owner reviews and applies those manually.

## Updating a repo

Relayrace copies files into your repos, so a newer kit does not reach them by itself. `init` records a hash of each file it writes in `.ai/relaykit.lock.json`. Then:

```bash
relayrace init --update            # compare this repo with the kit (read-only)
relayrace init --update --apply    # write the missing files and the ones you never edited
```

Each file is one of: **current**, **missing**, **updatable** (unchanged since install, so replacing it loses nothing) or **modified** (you edited it, or the repo was installed before baselines existed). `--apply` only touches the first three kinds; modified files and the rules files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) are never replaced, only listed. `relayrace doctor` shows the same state in one line. Commit the lock file with the repo. Global files are separate: `relayrace sync --check` and `relayrace sync`.

## Commands

| Command | What it does |
|---|---|
| `relayrace init [repo] [--profile generic\|web-app\|notes]` | Set a repo up. Never overwrites; validates options and the effective project config before writing. Options: `--update` (compare installed files), `--apply` (with `--update`), `--dry-run`, `--verbose`, `--name`, `--check "cmd"` (repeat), `--jules owner/name:branch`, `--claude-model`, `--desk-path`, `--qwen-allow "cmd"`. |
| `relayrace sync [--check\|--yes]` | Preview the **global** contract, roles and skills, then ask to apply. `--check` is read-only (exit 1 on drift); `--yes` applies without asking. Non-interactive plain sync is read-only. |
| `relayrace update` | Fast-forward this clean Git checkout, then report whether to sync again. |
| `relayrace ci-local [--docker\|--no-docker] [--no-checks] [--node 18,22]` | Run the repo's checks the way CI does. If `.ai/project.json` lists `checks` (plain commands such as `pnpm check`, `pnpm test`), each runs on this machine, and `--docker` repeats them in a throwaway Linux container per Node version (installing with pnpm or npm from the lockfile first). Without `checks` it runs `node --test` here and in a container per Node version, on a read-only copy without `.git`. Node versions come from `.github/workflows/test.yml`, else `engines.node`. Says what it could not run (no Docker, macOS) instead of implying it passed; exit 1 on any failure. `--install-hook` runs it before every `git push`. Use it when GitHub Actions is unavailable. |
| `relayrace doctor [--json]` | CLIs on PATH, whether each looks logged in (read-only commands, no model quota), local model health, `sync --check` drift, and this repo's install state. |
| `relayrace providers [list\|init\|pick\|ui]` | Your providers, plans, models and the order to try them in. `pick <capability>` says who takes a task; `ui` opens a local editor. See **Providers** below. |
| `relayrace relay <task.json> [--max-turns N] [--rotate]` | Sequential hand-off in configured priority order by phase; the next eligible provider continues when a quota runs out. `--rotate` uses the legacy CLI alternation. |
| `relayrace jules <task.json>` | One bounded Jules cloud task on its own branch, then local integration and review. |
| `relayrace qwen [options]` | Delegate mechanical work to the local model safely (task file, timeout, files checked on disk). Options: `--task <file>` or `--prompt <text>`, `--expect <file>` (a file the run must produce), `--tsc <dir>` (typecheck after), `--optional` (skip, do not fail, when the model is down), `--health`, `--dry-run`, `--timeout-min N`. |

## task.json

Both runners load the same required fields:

| Field | Validation |
|---|---|
| `id` | A string matching `^[a-z0-9][a-z0-9-]{0,60}$` (1–61 characters). Use a new ID when changing a task. |
| `objective` | A nonempty string after trimming whitespace. |
| `acceptance` | A nonempty array of nonempty strings describing observable acceptance. |
| `jules` | Required only for Jules: `repo` and `branch` must exactly match `.ai/project.json`. |

A minimal relay task:

```json
{
  "id": "document-health-check",
  "objective": "Document the existing health-check command.",
  "acceptance": ["README names the command and its expected output."]
}
```

Save it under the ignored `.ai/runs/task.json`, then run from the repository root:

```bash
relayrace relay .ai/runs/task.json
```

For Jules, add `"jules": { "repo": "example/project", "branch": "main" }` to
that JSON and put the same pair in `.ai/project.json`. The complete
[task.example.json](tests/fixtures/task.example.json) is tested with the production
loader used by both runners. Then run:

```bash
relayrace jules .ai/runs/task.json
```

Jules needs a repository connected to Jules, a clean dedicated checkout whose
origin matches that repository, and HEAD at the remote **default branch** commit.
Its `branch` must name that default branch. It downloads a patch for local
integration and independent review; cloud completion does not finish acceptance.
The local relay needs at least two available provider CLIs. Resume an interrupted
run with the same command and unchanged task; do not reuse an ID for different work.

## Profiles

| Profile | Installs |
|---|---|
| `generic` | The six generic roles (planner, implementer, reviewer, tester, writer, designer), the `work`, `bugfix` and `cross-review` skills, the review prompt, an `AGENTS.md` template, and `CLAUDE.md`/`GEMINI.md` pointers. Prints the proposed OpenCode guardrails. |
| `web-app` | The six-role pipeline (program-manager, architect, ui-designer, developer, qa, docs-writer), the `feature`, `fix`, `qwen`, `redesign-module`, `release-local` and `cross-review` skills, `scripts/qwen.mjs` with its `scripts/lib/` helpers, the review prompt, and an `AGENTS.md` whose **Project rules** section the repo fills in. Prints the proposed OpenCode guardrails. |
| `notes` | The writer role only, for an Obsidian or Markdown folder. |

Files land in `.claude/agents`, `.claude/skills`, `.ai/` and `scripts/`. No project names or business rules are baked in: the roles name risk categories (money, inventory, permissions, state changes) and leave the specifics (tenancy, styling, concurrency contracts) to the repo's own **Project rules**. The roles and skills under `.claude/` run inside a Claude Code session; the delegation order in [Providers](#providers) governs which CLI the relay and `relayrace providers pick` choose across tools.

## Configuration

Every path is optional. With no dashboard configured, repo registration is skipped with a note.

Precedence, lowest to highest: defaults, then `~/.config/relaykit/config.json` (Windows: `%APPDATA%\relaykit\config.json`), then environment variables.

```json
{
  "agentDesk": "~/agent-desk/data/config.json",
  "notes": "~/notes",
  "contract": "~/my-contract.md",
  "qwen": { "healthUrl": "http://127.0.0.1:8080/health", "lockName": "relaykit-qwen" }
}
```

| Key | Variable | Meaning |
|---|---|---|
| `agentDesk` | `RELAYKIT_AGENT_DESK` | Agent Desk `config.json` that `init` registers repos in; also used by `sync` to measure Codex's 32 KiB budget. |
| `notes` | `RELAYKIT_NOTES` | Your notes folder (shown by `doctor`). |
| `contract` | `RELAYKIT_CONTRACT` | A contract file for `sync` to use instead of `docs/contract.md`. |
| `qwen.healthUrl` | `RELAYKIT_QWEN_URL` | Local model health URL. Default `http://127.0.0.1:8080/health`. |
| `qwen.lockName` | `RELAYKIT_QWEN_LOCK` | Temp folder holding the single-slot lock. Every runner that talks to the same server must use the same name. |

`RELAYKIT_CONFIG` points at another config file. `RELAYKIT_CLAUDE_EXE`, `RELAYKIT_AGY_EXE` and `RELAYKIT_CODEX_EXE` override where the relay finds a CLI. `RELAYKIT_ALLOW_FABLE=1` lets the relay use Fable, the most expensive model tier, for one run; set it only when the owner has said yes to that use. Without it the relay refuses.

`CODEX_HOME` selects Codex's config directory for both `sync` and `doctor` (default `~/.codex`). The budget check finds the nearest `.git` file or directory above each cwd and measures effective `AGENTS.override.md` files before `AGENTS.md` from that root through cwd, including ancestors of a registered subdirectory. Agent Desk entries may include `cwd` (absolute or relative to `path`). It reads a top-level integer `project_doc_max_bytes` from Codex's `config.toml`, including single- and double-quoted keys, retaining a 2 KiB margin. Missing project paths, unknown Git roots or nested working directories, unreadable config, or unsupported discovery/profile settings (including quoted, dotted and table forms) produce **incomplete coverage**, never a budget guarantee. See the [official instruction discovery documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

`sync` preflights every conflict, stages replacements beside their targets, and renames them atomically. Every changed existing file gets a per-run `.bak-relaykit-<ISO>` backup (colons replaced with hyphens for Windows). A failed write or replacement restores earlier files and removes newly created files. If restoration itself fails, it reports that and keeps the backups for recovery. Exact generated headers are required; legacy headers remain supported explicitly.

### Optional: a project dashboard

If you keep a dashboard that lists your projects in a `config.json` with a `projects` array of `{ "name", "path" }`, set `agentDesk` (or `RELAYKIT_AGENT_DESK`) to that file. `init` then registers each repo there, backing the file up once as `config.json.bak-relaykit`, and `sync` reads the paths to measure Codex's 32 KiB budget. Relayrace never starts or bundles a dashboard; the key is named after Agent Desk, a companion dashboard published separately, whose format this is.

## Providers

Everyone has different subscriptions, so the order agents delegate in is data, not prose. One file lists your providers; **the list order is the priority**, and a task goes to the first enabled provider that can do it. If that provider cannot, or its result fails verification (tests, typecheck, a reviewer), it moves to the next, until the task is done: always the cheapest that works. Go down the list once per task; when no eligible provider is left, or the attempt or time budget the owner set is spent, stop and report what blocked it instead of retrying.

```bash
relayrace providers init                 # write the default order to your file (never overwrites)
relayrace providers                      # the order, with plan, models and what each can do
relayrace providers pick review --exclude-family anthropic   # who reviews work Claude wrote
relayrace providers ui                   # edit plans, models and order in a local page
```

The default priority order is configurable in the providers file described below. The default order is: local Qwen, Jules, Gemini via Antigravity, Antigravity's Claude models, Codex, then Claude Code on the cheapest model that solves the task (Opus only in extreme cases).

File lookup, first found wins: `<repo>/.ai/providers.json`, then `providers.json` next to the config file (`RELAYKIT_PROVIDERS` overrides the path), then the built-in default. The user file is the one `providers ui` edits and `init` creates; the repo file is edited by hand.

```json
{
  "version": 1,
  "providers": [
    { "id": "qwen", "label": "Qwen (local)", "kind": "qwen", "family": "local", "enabled": true,
      "plan": "local model, no quota", "models": [{ "id": "qwen-local", "cost": "free" }], "can": ["mechanical"] },
    { "id": "claude", "label": "Claude Code", "kind": "claude", "family": "anthropic", "enabled": true,
      "plan": "Max 5x", "can": ["mechanical", "edit", "implement", "review", "test", "critical"],
      "models": [{ "id": "haiku", "cost": "low" }, { "id": "sonnet", "cost": "mid" }, { "id": "opus", "cost": "high", "restricted": true }] }
  ]
}
```

| Field | Values |
|---|---|
| `kind` | `qwen`, `jules`, `antigravity`, `codex`, `claude`, `other` |
| `family` | `anthropic`, `google`, `openai`, `local`, `other`. Independence in a review counts by family, not by tool: Antigravity running a Claude model is still `anthropic`. |
| `can` | `mechanical`, `edit`, `implement`, `review`, `visual`, `test`, `critical`. `critical` is money, permissions, schema and architecture; a provider without it never receives them. |
| `models[].cost` | `free`, `low`, `mid`, `high`. The cheapest model wins. `restricted: true` means extreme cases only (`pick --extreme`). |
| `plan`, `notes` | Free text for you: the subscription or tier, and any limit worth remembering. |

Never put keys or tokens in this file (a value that looks like one is refused), and Fable is never listed there: it needs the owner's yes for each use. Quota is not read from this file; use `relayrace doctor` and your dashboard for that. `relayrace relay` follows this order too, per phase: a CLI implements only through an enabled entry that can `implement` or `edit`, reviews only through one that can `review`, and a review never comes from the CLI or the model family that implemented (`--rotate` keeps the old alternation). The relay starts `agy` with `--model` set to the cheapest model its entry lists, so the family you declare is the family that runs. Check the ids with `agy models`; a wrong id makes that turn fail. `critical` is refused for Qwen, Jules and any Flash model, in the file and in `pick`; the editor works on your personal file and only shows a repo override as a notice.

## Reading doctor

Fictional, anonymized excerpt (some tool rows omitted; versions are examples):

```text
Relayrace doctor

Config
  file          /home/user/.config/relaykit/config.json (found)
  Agent Desk    not configured (repo registration is skipped)
  notes         not configured

Tools
  ok      codex     1.0.0                               login: yes  (looks logged in)
  MISSING agy       -                                    (not found on PATH)

Local model
  down    http://127.0.0.1:8080/health  (not reachable (optional: Qwen is never required))

Global files (relayrace sync --check)
  drift   1 file out of date; run `relayrace sync` to write them
            /home/user/.gemini/antigravity-cli/rules/relaykit-contract.md

This repository
  not installed; run `relayrace init --profile <generic|web-app|notes>`
```

**Launcher** reports whether `relayrace` is on PATH and the absolute Node executable running this invocation. **Config** identifies the config file and optional integrations. **Tools** separates
installation from login (`yes`, `no`, `unknown`, or no login needed); these probes
do not spend model quota. **Local model** is optional health, **Global files** is
read-only drift, and **This repository** reports profile file presence and update status, not test
success. **Warnings**, when present, explain configuration or authentication
issues. Missing optional tools, model health and drift are informational; doctor
exits 1 for missing Git or unsupported Node, not every warning.

## FAQ and Troubleshooting

- **Only one or two providers installed?** `init`, `sync` and `doctor` work without
  all providers. Use one provider directly, but `relay` requires at least two
  available CLIs among Claude Code, Antigravity and Codex; Jules also hands off to
  that local relay. In configured priority mode, the providers must also be eligible
  for their phase, and the reviewer must use a different CLI and model family.
  Legacy `--rotate` and the Jules hand-off check CLI identity only; choose different
  model families for independent review.
- **What does sync touch?** Global contract blocks in `~/.claude/CLAUDE.md` and
  `$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`), Claude agents/skills, Codex
  agent TOML files, and `~/.gemini/antigravity-cli/rules/relaykit-contract.md`.
  Text outside owned blocks is retained; unowned target files stop the run. It
  writes the new Antigravity rule before retiring an older rule file, only when
  the old file has an exact supported generated header. An unowned old file stays
  untouched and remains drift until you review and remove it manually. Run
  `sync --check` first; it writes nothing. Sync backups use the timestamped suffix
  described above. Separately, init keeps one Agent Desk `.bak-relaykit` backup
  before registration changes and never replaces that backup.
- **Codex 32 KiB budget exceeded?** Shorten the global contract or the effective
  project instructions; move background detail into linked docs. Sync measures the
  configured `project_doc_max_bytes` limit (32 KiB by default) with a 2 KiB margin.
  Resolve missing paths/configuration when coverage is incomplete; that warning
  is not a guarantee that every working directory fits.
- **Antigravity headless review is empty?** Inspect `denied_actions` and the saved
  denial report under `.ai/runs/<id>/`. Even `SUCCESS` with an empty response may
  mean a command was denied. Use file-read tools and list every needed path; the
  owner must review any required permission change. Do not hop providers to bypass
  a denial. See the [cross-provider review playbook](docs/playbooks/cross-provider-review.md).
- **Qwen is down?** It is optional. The default `127.0.0.1:8080` endpoint expects
  a local llama.cpp model server with `/health` returning `{"status":"ok"}`.
  The runner uses OpenCode's configured `local/qwen3-coder-next` model;
  install/configure that provider separately. Changing `qwen.healthUrl` changes
  the health probe, not OpenCode's provider endpoint. If unused, leave Qwen down.
- **A stale Qwen .lock?** The lock is `<OS temp>/<qwen.lockName>/run.lock`
  (default `relaykit-qwen`). The runner removes locks with dead PIDs or malformed
  contents automatically and waits for live holders. Before manually removing a
  stuck lock, confirm no runner still owns it. All runners sharing one server
  must share the same lock name.
- **`doctor` says a tool is MISSING but it is installed (Jules, `npx`, `pnpm`)?**
  `doctor` looks on the PATH of the terminal it runs in, and a terminal copies
  its PATH when the program that hosts it starts. A folder added to the user
  PATH afterwards (for example Node's folder under nvm, where `npm install -g`
  tools such as `jules` live) is not seen by terminals that were already open.
  Check with `($env:Path -split ';') -contains '<folder>'`: `False` means the
  terminal is stale, so close the program that hosts it (Windows Terminal, the
  editor or the agent app, not just the tab) and open it again. `True` with the
  tool still missing means it lives in another folder (`Get-Command <tool>`).
  `relayrace` itself keeps working because the launcher stores the Node path.

## Playbooks

The processes that worked, in [docs/playbooks](docs/playbooks):

- [Redesign a module](docs/playbooks/redesign-module.md): inventory the features, build the screens and render PNGs, owner approval, tests, a Gemini review per lane, one Codex money/permissions review, gate, visual baselines, PR, release.
- [Cross-provider review](docs/playbooks/cross-provider-review.md): probe each sandbox, headless Antigravity with file-read tools only and every path listed, verify the cited lines, Codex once per module.
- [Model selection](docs/playbooks/model-selection.md): the order to delegate in, and when Opus or Fable may be used.
- [Release from a local machine](docs/playbooks/release-local.md): when CI is down, with secrets from a password manager and never printed.

The `cross-review` skill (all profiles that carry skills), `redesign-module` and `release-local` (web-app) are the short, agent-facing versions.

## Rules the kit follows

- Qwen rejects task paths outside the repo and secret names (`.env*`, `.dev.vars*`, `*.pem`, `*.key`, `*secrets*.env`) before reading, including resolved symlinks, junctions and Windows alternate streams. `--dry-run` writes no task copy, log or lock.
- `doctor` prints only a parsed version token per tool; reported URLs omit credentials, query strings and fragments.
- Permission proposals for OpenCode and Antigravity are printed for the user to apply manually; `init` never writes them. Qwen requires default-deny shell permissions and only exact Git reads and checks from the effective `.ai/project.json` (`checks` and `qwenAllow`). Agent/plugin overrides are refused. Its child environment drops inherited `OPENCODE_*` variables (case-insensitively), including `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`, `OPENCODE_TUI_CONFIG` and permission overrides, then sets only `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`. See [OpenCode configuration precedence](https://opencode.ai/docs/config/#precedence-order).
- `init` never overwrites a file. `sync` only replaces owned files or owned contract blocks and refuses measured instruction loads above the budget.
- All runners share the same executable launcher. Windows `.cmd`/`.bat` shims use explicit `cmd.exe` quoting; prompts travel through stdin or task files.
- No dependencies. `update` fetches the Git upstream; doctor uses the local model's health check and read-only status commands of the CLIs you already use.

## Development

```bash
node --test          # the whole suite; CI runs it on Windows, macOS and Linux with Node 18 and 22
relayrace ci-local    # the same checks here, plus Linux containers when Docker is running
```

[CONTRIBUTING.md](CONTRIBUTING.md) explains the DCO sign-off (`git commit -s`).

## Licensing

| Paths | License |
|---|---|
| The code: `bin/`, `lib/`, `install.mjs`, `sync.mjs`, `relay.mjs`, `jules-relay.mjs`, the tests, the workflow | [Apache-2.0](LICENSE), with the [NOTICE](NOTICE) |
| The templates the tool copies into other repos: `agents/`, `skills/`, `templates/`, `prompts/`, `docs/playbooks/`, and `qwen.mjs` (installed as `scripts/qwen.mjs`) with the copies of `lib/exe.mjs` and `lib/guardrails.mjs` installed as `scripts/lib/*` (the same two files are Apache-2.0 inside this repository) | [MIT](LICENSE-TEMPLATES), Copyright (c) 2026 Isaac Sanchez Aguilar |
| `docs/contract.md` | A neutral starter contract, Apache-2.0 like the code. Write your own and point `contract` at it. |
| The name | "Relayrace" is reserved; see [TRADEMARKS.md](TRADEMARKS.md). A fork must use another name. |

Files installed into your repo carry no license header; the notice for them is `LICENSE-TEMPLATES` in this repo, so keep it with any copy you redistribute.
