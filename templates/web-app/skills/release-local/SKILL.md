---
name: release-local
description: Release from a local machine when CI is down — freeze the owner-approved sha, re-read remote tags right before tagging, run the checks CI would have run, migrate, tag, deploy and smoke-check, with every secret read from a password manager into one command's environment and never printed. Use only when the owner approved a release and the pipeline is unavailable.
argument-hint: <approved sha or tag>
---

# /release-local — manual release, secrets never printed

Release: `$ARGUMENTS`. The full text is the release-local [playbook](https://github.com/isanchez-aguilar/relaykit/blob/main/docs/playbooks/release-local.md) in the Relaykit repo. **Ask the owner once** ("Proceed with the release automatically?"). After a yes, run the sequence without a question per step;
without a yes, do nothing. Ship only the approved sha.

## Rules that do not bend

- Never print, log, echo, commit or paste a secret. Never read `.env` or
  `.dev.vars` to «check». Never put a secret on a command line.
- Secrets come from the password manager straight into the environment of the
  one command that needs them, then are unset. Tracing off (`set +x`); redact
  secrets from any error you report.
- Before any cloud operation run the provider's whoami and confirm the account
  is the repo's. Accounts are never mixed.
- Anything that did not run is reported as not run.

## Sequence

1. Freeze the approved sha.
2. `git fetch --tags`; confirm the branch tip is that sha and the tag name is
   still free. **Re-read remote tags again right before tagging**: other
   sessions release the same day.
3. Run the checks CI would have run (typecheck, tests, build, gate), clean
   worktree, frozen lockfile, report each result.
4. Migration, if any: inspect it, confirm a restore point, apply with the
   secret from the password manager, verify. A destructive migration needs an
   explicit yes.
5. Squash-merge the approved PR by hand if auto-merge is off. No force pushes.
6. Annotated tag on the approved sha; push it.
7. Deploy with the repo's script, one target at a time in the order its release
   doc names, after the whoami check.
8. Smoke-check with read-only requests only.
9. Back-merge into the integration branch if the flow needs it.
10. Report: sha, tag, checks, what did not run, the rollback command. Unset the
    secrets.

## If it fails

Stop. No retry loops, no unreviewed fix-forward. Report what is deployed,
migrated and tagged, the error with secrets redacted, and the rollback options;
the owner decides.
