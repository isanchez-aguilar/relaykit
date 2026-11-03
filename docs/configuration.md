# Configuration

Every setting is optional. A missing one only switches a feature off (with no dashboard configured, repo registration is skipped with a note).

Precedence, lowest to highest: built-in defaults, then the config file, then environment variables.

## The config file

| System | Path |
|---|---|
| macOS, Linux | `~/.config/relayrace/config.json` (or `$XDG_CONFIG_HOME/relayrace/config.json`) |
| Windows | `%APPDATA%\relayrace\config.json` |

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
| `agentDesk` | `RELAYRACE_AGENT_DESK` | Agent Desk `config.json` that `init` registers repos in; also used by `sync` to measure Codex's 32 KiB budget. |
| `notes` | `RELAYRACE_NOTES` | Your notes folder (shown by `doctor`). |
| `contract` | `RELAYRACE_CONTRACT` | A contract file for `sync` to use instead of `docs/contract.md`. |
| `qwen.healthUrl` | `RELAYRACE_QWEN_URL` | Local model health URL. Default `http://127.0.0.1:8080/health`. |
| `qwen.lockName` | `RELAYRACE_QWEN_LOCK` | Temp folder holding the single-slot lock. Every runner that talks to the same server must use the same name. |

Other variables:

| Variable | Meaning |
|---|---|
| `RELAYRACE_CONFIG` | Use this file instead of the default config file (the old-folder fallback is then off). |
| `RELAYRACE_PROVIDERS` | Use this providers file. See [Providers](providers.md). |
| `RELAYRACE_CLAUDE_EXE`, `RELAYRACE_AGY_EXE`, `RELAYRACE_CODEX_EXE`, `RELAYRACE_JULES_EXE` | Where the relay finds each CLI. |
| `RELAYRACE_ALLOW_FABLE=1` | Lets the relay use Fable, the most expensive model tier, for one run. Set it only when the owner has said yes to that use. Without it the relay refuses. The old `RELAYKIT_ALLOW_FABLE`, `AI_KIT_ALLOW_FABLE` and `KIT_ALLOW_FABLE` no longer count here: this is a per-use approval, not a standing setting. |
| `CODEX_HOME` | Codex's config directory for `sync` and `doctor` (default `~/.codex`). |

## Old names are still read

The project was called Relaykit (and before that ai-kit). Nothing breaks on a machine configured under an old name:

- The config folder is looked up as `relayrace`, then `relaykit`, then `ai-kit`. Reading an old one prints a one-line note telling you to move it. Relayrace never moves or copies your files by itself.
- Every `RELAYRACE_X` variable is also read as `RELAYKIT_X`, then `AI_KIT_X`. The newest spelling that is set wins.
- `.ai/relaykit.lock.json` in a repo is read when `.ai/relayrace.lock.json` is absent, and is replaced when you apply an update.
- Generated global files carrying the old header or old block markers are rewritten as ordinary updates by the next `relayrace sync`, not treated as conflicts.
- The default Qwen lock folder stays `relaykit-qwen`, so older copies of `scripts/qwen.mjs` in other repos keep sharing one single-slot lock.
- On Windows the launcher folder keeps the name `%LOCALAPPDATA%\Relaykit\bin`, because it may already be on your PATH.

## Optional: a project dashboard

If you keep a dashboard that lists your projects in a `config.json` with a `projects` array of `{ "name", "path" }`, set `agentDesk` (or `RELAYRACE_AGENT_DESK`) to that file. `init` then registers each repo there, backing the file up once as `config.json.bak-relayrace`, and `sync` reads the paths to measure Codex's 32 KiB budget. Relayrace never starts or bundles a dashboard; the key is named after Agent Desk, a companion dashboard published separately, whose format this is. A `.bak-relaykit` from before the rename counts as that first backup.

## How `sync` writes files

`sync` preflights every conflict, stages replacements beside their targets, and renames them atomically.

- Every changed existing file gets a per-run `.bak-relayrace-<ISO>` backup (colons replaced with hyphens for Windows).
- A failed write or replacement restores earlier files and removes newly created files. If restoration itself fails, it reports that and keeps the backups for recovery.
- Exact generated headers are required to treat a file as ours; legacy headers are supported explicitly.

## The Codex size budget

Codex reads a limited amount of instructions. `sync` and `doctor` measure that load and refuse to write a configuration over the budget.

- The check finds the nearest `.git` file or directory above each working directory and measures effective `AGENTS.override.md` files before `AGENTS.md` from that root through the working directory, including ancestors of a registered subdirectory.
- Agent Desk entries may include `cwd` (absolute or relative to `path`).
- It reads a top-level integer `project_doc_max_bytes` from Codex's `config.toml`, including single- and double-quoted keys, and keeps a 2 KiB margin (32 KiB default).
- Missing project paths, unknown Git roots or nested working directories, unreadable config, or unsupported discovery/profile settings (including quoted, dotted and table forms) produce **incomplete coverage**, never a budget guarantee.

See the [official instruction discovery documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
