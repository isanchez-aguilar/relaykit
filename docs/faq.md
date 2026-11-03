# FAQ and troubleshooting

- [I only have one or two providers installed](#i-only-have-one-or-two-providers-installed)
- [What does `sync` touch?](#what-does-sync-touch)
- [The Codex 32 KiB budget is exceeded](#the-codex-32-kib-budget-is-exceeded)
- [An Antigravity headless review is empty](#an-antigravity-headless-review-is-empty)
- [Qwen is down](#qwen-is-down)
- [A stale Qwen lock](#a-stale-qwen-lock)
- [`doctor` says a tool is MISSING but it is installed](#doctor-says-a-tool-is-missing-but-it-is-installed)
- [The command is not found after installing](#the-command-is-not-found-after-installing)

## I only have one or two providers installed

`init`, `sync` and `doctor` work without all providers. You can use one provider directly. `relay` requires at least two available CLIs among Claude Code, Antigravity and Codex, and Jules also hands off to that local relay. In priority mode the providers must also be eligible for their phase, and the reviewer must use a different CLI and model family. The legacy `--rotate` and the Jules hand-off check CLI identity only, so choose different model families for independent review yourself.

## What does `sync` touch?

- The global contract blocks in `~/.claude/CLAUDE.md` and `$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`).
- Claude agents and skills, and Codex agent TOML files.
- `~/.gemini/antigravity-cli/rules/relayrace-contract.md`.

Text outside owned blocks is retained, and unowned target files stop the run. It writes the new Antigravity rule before retiring an older rule file (`relaykit-contract.md`), and only when the old file has an exact supported generated header. An unowned old file stays untouched and remains drift until you review and remove it manually. Run `sync --check` first; it writes nothing. Backups and recovery: [Configuration](configuration.md#how-sync-writes-files).

## The Codex 32 KiB budget is exceeded

Shorten the global contract or the effective project instructions, and move background detail into linked docs. `sync` measures the configured `project_doc_max_bytes` limit (32 KiB by default) with a 2 KiB margin. Resolve missing paths or configuration when coverage is incomplete: that warning is not a guarantee that every working directory fits. How it is measured: [Configuration](configuration.md#the-codex-size-budget).

## An Antigravity headless review is empty

Inspect `denied_actions` and the saved denial report under `.ai/runs/<id>/`. Even `SUCCESS` with an empty response may mean a command was denied. Use file-read tools and list every needed path; the owner must review any required permission change. Do not hop providers to bypass a denial. See the [cross-provider review playbook](playbooks/cross-provider-review.md).

## Qwen is down

It is optional. The default `127.0.0.1:8080` endpoint expects a local llama.cpp model server with `/health` returning `{"status":"ok"}`. The runner uses OpenCode's configured `local/qwen3-coder-next` model; install and configure that provider separately. Changing `qwen.healthUrl` changes the health probe, not OpenCode's provider endpoint. If unused, leave Qwen down.

## A stale Qwen lock

The lock is `<OS temp>/<qwen.lockName>/run.lock` (default `relaykit-qwen`, kept under that name for compatibility). The runner removes locks with dead PIDs or malformed contents automatically and waits for live holders. Before manually removing a stuck lock, confirm no runner still owns it. All runners sharing one server must share the same lock name.

## `doctor` says a tool is MISSING but it is installed

This happens with Jules, `npx`, `pnpm` and other tools installed through `npm install -g`. `doctor` looks on the PATH of the terminal it runs in, and a terminal copies its PATH when the program that hosts it starts. A folder added to the user PATH afterwards (for example Node's folder under nvm) is not seen by terminals that were already open.

Check with `($env:Path -split ';') -contains '<folder>'` in PowerShell:

- `False` means the terminal is stale. Close the program that hosts it (Windows Terminal, the editor or the agent app, not just the tab) and open it again.
- `True` with the tool still missing means it lives in another folder (`Get-Command <tool>`).

`relayrace` itself keeps working because the launcher stores the Node path.

## The command is not found after installing

Open a **new terminal**: PATH changes only reach terminals started afterwards. With `npm install -g relayrace-ai`, the commands are `relayrace` and `relayrace-ai`. `npx relayrace-ai doctor` works without installing. If an install fails with `ENOENT` on a cache file, run `npm cache clean --force` and install again.
