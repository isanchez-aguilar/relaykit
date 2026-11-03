# Getting started

You need Git and Node 18+. Relayrace coordinates the AI coding CLIs you already use and does not install them: have the ones you want (Claude Code, Codex, Antigravity's `agy`, Jules, OpenCode for a local model) and use at least two of Claude Code, Codex and Antigravity for the relay's independent review.

- [Install](#install)
- [Set up a machine](#set-up-a-machine)
- [Set up a repo](#set-up-a-repo)
- [Update a repo](#update-a-repo)
- [Update Relayrace itself](#update-relayrace-itself)

## Install

### From npm (most people)

```bash
npm install -g relayrace-ai
relayrace doctor
```

You get two commands, `relayrace` and `relayrace-ai`, which are the same program. Without installing, `npx relayrace-ai doctor` works too.

### From a checkout (updates with `relayrace update`)

```bash
git clone https://github.com/isanchez-aguilar/relayrace-ai.git && cd relayrace-ai
./scripts/setup.sh        # Windows: .\scripts\setup.ps1
relayrace doctor
```

Setup shows the Node executable and checkout it found, installs a launcher in your user bin folder, and asks before adding that folder to your user PATH. Answer `Y`, then **open a new terminal**. No administrator rights are needed. Re-run setup after moving the checkout or removing the Node version it uses. `-Yes` (PowerShell) or `--yes` (shell) accepts the PATH change without prompting.

If PowerShell blocks the setup script, run this once from the checkout (it only changes policy for that process):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

Where the launcher lives:

- **Windows:** `%LOCALAPPDATA%\Relaykit\bin\relayrace.cmd`. The folder keeps its old name on purpose, because it may already be on your PATH. The optional PowerShell companion lives under `bin\powershell\relayrace.ps1` so a restrictive execution policy does not block the ordinary command.
- **macOS and Linux:** `~/.local/bin/relayrace`. Setup appends its PATH block to your shell's startup files (Bash/sh, Zsh or Fish). If `./scripts/setup.sh` is not executable, use `sh scripts/setup.sh`. If a new tab still has the old PATH, restart the terminal app.

Without a launcher you can always run `node bin/relayrace.mjs doctor` from the checkout.

## Set up a machine

1. Run `relayrace doctor` and log in to the providers you use.
2. Run `relayrace sync`.

`sync` installs the default contract ([`docs/contract.md`](contract.md), a short set of neutral working rules) and the shared roles and skills into the global configuration of Claude Code, Codex and Antigravity. It previews the changes and asks `Apply these N changes? [y/N]`. `--check` stays read-only (exit 1 on drift); `--yes` applies without asking. Without an interactive terminal, plain `sync` behaves like `--check` and says so.

To use your own contract, copy `docs/contract.md`, edit it and set `contract` in your [config](configuration.md). Keep its `contract:start` / `contract:end` markers (the Spanish `contrato:inicio` / `contrato:fin` are still read).

## Set up a repo

```bash
cd my-repo
git init                                       # if the folder is new
relayrace init --profile web-app --dry-run     # what it would add
relayrace init --profile web-app               # add it
```

Pick a profile from [Profiles](profiles.md). `init` never overwrites an existing file; it adds what is missing and prints what it left alone.

Then:

1. Open `AGENTS.md` and fill in its TODOs: what the project is, its commands, its conventions and its **Project rules**.
2. In Claude Code run `/work <a small task>` (or `/bugfix <a bug>`). The skills split the work across the roles and ask another provider to review it.
3. To hand a task between CLIs when one runs out of quota, write a `task.json` ([format](relay.md)) and run `relayrace relay task.json`.

Two things `init` prints for you to apply yourself, because it never writes permission rules:

- A proposed `opencode.json` for the local Qwen model, and where to save it. Review it, merge it with an existing file if needed, and save it. Qwen refuses missing or insufficient guardrails without changing them.
- Proposed Antigravity read/deny rules and their settings path.

## Update a repo

Relayrace copies files into your repos, so a newer kit does not reach them by itself. `init` records a hash of each file it writes in `.ai/relayrace.lock.json` (an older `.ai/relaykit.lock.json` is still read and is replaced when you apply an update). Then:

```bash
relayrace init --update            # compare this repo with the kit (read-only)
relayrace init --update --apply    # write the missing files and the ones you never edited
```

Each file is one of:

| State | Meaning |
|---|---|
| **current** | Matches the kit. |
| **missing** | The kit has it and the repo does not. |
| **updatable** | Unchanged since install, so replacing it loses nothing. |
| **modified** | You edited it, or the repo was installed before baselines existed. |

`--apply` only touches the first three kinds. Modified files and the rules files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) are never replaced, only listed. `relayrace doctor` shows the same state in one line. Commit the lock file with the repo. Global files are separate: `relayrace sync --check` and `relayrace sync`.

## Update Relayrace itself

- **Installed from npm:** `npm update -g relayrace-ai`, then `relayrace sync` again.
- **From a checkout:** `relayrace update` pulls fast-forward updates into the checkout the launcher uses. It refuses local changes, including untracked files, and installations without their own Git checkout. Afterwards it tells you to run `relayrace sync` again. Your current folder does not change which checkout gets updated.
