# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private
reporting: **Security → Report a vulnerability** on the repository page. You will
get an answer within a few days, and a fix or a mitigation plan before details
are made public.

## Supported versions

Only the latest release (`0.x`) receives fixes.

## What the tool does and does not do

Relaykit starts other programs (Claude Code, Codex, Antigravity, Jules, a local
model) on your machine with your own logins. It is built to keep that bounded:

- No dependencies, and no network access of its own except the local model's
  health check and, in `relaykit update`, `git pull --ff-only`. The programs it
  starts do use the network: Claude Code, Codex, Antigravity and Jules talk to their
  providers, `jules` to a remote Git repository, and `ci-local --docker` pulls
  container images and runs `pnpm` or `npm` installs.
- Its own code does not read, print or store secrets. API keys in the environment
  make the relay refuse to run, so a subscription cannot silently turn into a paid
  API call. The programs it starts are another matter: a read-only review such as
  `codex exec --sandbox read-only` can read every file in the checkout, `.env`
  included. Keep secrets outside the checkout, or deny them with the tool's own
  permission rules (`init` prints a starting point).
- It never writes another tool's permission rules: `init` prints them for you to
  apply. `init` never overwrites a file; `sync` only replaces files it generated
  and shows a preview first.
- `relaykit providers ui` listens on 127.0.0.1 only, checks the Host and Origin of
  every request, and needs a per-process token to write.
- A pre-push hook (`ci-local --install-hook`) only runs the repository's own checks.

Report anything that makes it do more than that.
