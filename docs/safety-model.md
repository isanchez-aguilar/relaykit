# Safety model

The rules the tool follows, so you know what it will never do. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Files

- `init` never overwrites a file. `sync` only replaces owned files or owned contract blocks, and refuses measured instruction loads above the Codex budget.
- Writes by `init`, `init --update`, the relay and the Jules bridge never go through a symlink or junction that leaves the repository, create new files exclusively, replace files through unpredictable temporary names, and refuse a file that has a second hard link (appends to `.gitignore` included). The providers file and the local model's log and task files follow the same rules, and launchers, git hooks and shell profiles count as generated only when the mark is a line of its own, so a hand-written file that merely mentions it is never overwritten or removed.
- Permission proposals for OpenCode and Antigravity are printed for you to apply manually. `init` never writes permission rules.

## Known limits

Checks and writes resolve paths separately, so a process that swaps a parent directory for a link between the check and the write can still redirect a write. Node has no `openat`, so this cannot be closed from here; exploiting it needs a hostile local process running at the same time as the same user.

## Secrets

- The tool's own code does not read, print or store secrets.
- Qwen rejects task paths outside the repo and secret names (`.env*`, `.dev.vars*`, `*.pem`, `*.key`, `*secrets*.env`) before reading, including resolved symlinks, junctions and Windows alternate streams. `--dry-run` writes no task copy, log or lock.
- API keys in the environment make the relay refuse to run, so a subscription cannot silently turn into a paid API call.
- The programs Relayrace starts are another matter: a read-only review such as `codex exec --sandbox read-only` can read every file in the checkout, `.env` included. Keep secrets outside the checkout, or deny them with the tool's own permission rules (`init` prints a starting point).

## The local model (Qwen)

- Qwen requires default-deny shell permissions and only exact Git reads and checks from the effective `.ai/project.json` (`checks` and `qwenAllow`). Agent and plugin overrides are refused.
- Its child environment drops inherited `OPENCODE_*` variables (case-insensitively), including `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`, `OPENCODE_TUI_CONFIG` and permission overrides, then sets only `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`. See [OpenCode configuration precedence](https://opencode.ai/docs/config/#precedence-order).

## Processes and network

- No dependencies. Relayrace's own network use is the local model's health check and, in `relayrace update`, `git pull --ff-only`.
- The programs it starts do use the network: Claude Code, Codex, Antigravity and Jules talk to their providers, `jules` to a remote Git repository, and `ci-local --docker` pulls container images and runs `pnpm` or `npm` installs.
- All runners share the same executable launcher. Windows `.cmd`/`.bat` shims use explicit `cmd.exe` quoting; prompts travel through stdin or task files.

## Models

- Fable, the most expensive tier, is never used without the owner's yes for that use. See [Model selection](playbooks/model-selection.md).
- A change is reviewed by a different model family than the one that wrote it.
