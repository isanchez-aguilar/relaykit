# Commands

Run `relayrace --help` for the short version.

| Command | What it does |
|---|---|
| `relayrace doctor [--json]` | CLIs on PATH, whether each looks logged in (read-only commands, no model quota), local model health, `sync --check` drift, and this repo's install state. See [Reading doctor](doctor.md). |
| `relayrace sync [--check\|--yes]` | Preview the **global** contract, roles and skills, then ask to apply. `--check` is read-only (exit 1 on drift); `--yes` applies without asking. Non-interactive plain sync is read-only. |
| `relayrace init [repo] [--profile generic\|web-app\|notes]` | Set a repo up. Never overwrites; validates options and the effective project config before writing. |
| `relayrace init --update [repo] [--apply]` | Compare an installed repo with the kit; `--apply` writes the missing files and the ones you never edited. |
| `relayrace update` | Fast-forward this clean Git checkout, then report whether to sync again. |
| `relayrace providers [list\|init\|pick\|ui]` | Your providers, plans, models and the order to try them in. `pick <capability>` says who takes a task; `ui` opens a local editor. See [Providers](providers.md). |
| `relayrace relay <task.json> [--max-turns N] [--rotate]` | Sequential hand-off in configured priority order by phase; the next eligible provider continues when a quota runs out. `--rotate` uses the legacy CLI alternation. See [Relay](relay.md). |
| `relayrace jules <task.json>` | One bounded Jules cloud task on its own branch, then local integration and review. |
| `relayrace qwen [options]` | Delegate mechanical work to the local model safely. |
| `relayrace ci-local [options]` | Run the repo's checks the way CI does. |

## `init` options

`--profile generic|web-app|notes`, `--name N`, `--check "cmd"` (repeat), `--jules owner/name:branch`, `--claude-model M`, `--desk-path P`, `--qwen-allow "cmd"`, `--dry-run`, `--verbose`, and with `--update`: `--apply`.

The former `--with-opencode` and `--no-opencode` flags are removed: `init` prints a proposed `opencode.json` and never writes permission rules.

## `qwen` options

`--task <file>` or `--prompt <text>`, `--expect <file>` (a file the run must produce), `--tsc <dir>` (typecheck after), `--optional` (skip, do not fail, when the model is down), `--health`, `--dry-run`, `--timeout-min N`.

## `ci-local`

```bash
relayrace ci-local [--docker|--no-docker] [--no-checks] [--node 18,22]
relayrace ci-local --install-hook      # run it before every `git push`
relayrace ci-local --remove-hook
```

- If `.ai/project.json` lists `checks` (plain commands such as `pnpm check`, `pnpm test`), each runs on this machine. With `--docker`, they repeat in a throwaway Linux container per Node version, installing with pnpm or npm from the lockfile first.
- Without `checks` it runs `node --test` here and in a container per Node version, on a read-only copy without `.git`.
- Node versions come from `.github/workflows/test.yml`, else `engines.node`.
- It says what it could not run (no Docker, macOS) instead of implying it passed. Exit 1 on any failure.

Use it before pushing, and whenever GitHub Actions is unavailable.
