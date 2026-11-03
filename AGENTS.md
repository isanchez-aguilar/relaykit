# AGENTS.md — Relaykit

Rules for any coding agent, or person, working in this repository.

- Node built-ins only (no dependencies). Tests use `node --test`; the suite must pass on Windows, macOS and Linux (CI runs all three). Every change ships with its tests.
- Code, comments, docs and commits in English.
- Never read, print or store secrets: `.env`, `.dev.vars`, keys, tokens.
- Never write permission allow-rules for any tool. Print them for the owner to apply.
- `init` never overwrites existing files. `sync` only replaces files it generated; never run it without `--check` unless the owner asked.
- No machine paths in code: everything optional comes from `lib/config.mjs` (config file, then `RELAYKIT_*` variables, with the old `AI_KIT_*` still read).
- Files that `init` copies into other repos (`agents/`, `skills/`, `templates/`, `prompts/`, `qwen.mjs`) get no license header; the notice is `LICENSE-TEMPLATES`. `qwen.mjs` is installed with only `lib/exe.mjs` and `lib/guardrails.mjs` beside it (as `scripts/lib/`), so it may import nothing else from `lib/`.
- One branch per change; never commit straight to `main`; sign commits off with `git commit -s` (DCO). No merge without the maintainer's OK.
- Never use the Fable model without the owner's explicit approval for that use.
- Before pushing, run `relaykit ci-local` (or `node --test`); `relaykit ci-local --install-hook` does it on every push.
