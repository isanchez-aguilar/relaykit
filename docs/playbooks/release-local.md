# Playbook: release from a local machine when CI is down

Use this only when the repo's CI or deploy workflow is unavailable (disabled,
out of minutes, broken) and a release is approved. Everything the pipeline
would have done is done by hand, in the same order, and the secrets it would
have injected come from a password manager and are never printed.

## Ground rules

- **The owner approves the release, once, in words.** Ask before starting
  ("Proceed with the release automatically?"). After a yes you may run the
  whole sequence without a question per step. Never start on your own
  initiative, and never for a different sha than the approved one.
- **No secret is ever printed, logged, echoed, committed or pasted into a
  prompt.** Do not read `.env` or `.dev.vars` to «check» a value. Do not put a
  secret on a command line (it lands in process listings and shell history).
- **Never mix accounts.** Before any cloud operation, run the provider's
  whoami command and confirm the account is the repo's. A token from the wrong
  account deploys a worker, bucket or database in the wrong place without an error.
- **Nothing is skipped silently.** Each check that did not run is reported as
  not run.

## Secrets from a password manager

1. Unlock the manager yourself or ask the owner to; never ask them to paste a
   secret into the chat.
2. Read each secret straight into the **environment of the one command** that
   needs it, in the same shell invocation, so it is never written to a file. The
   session transcript records whatever a command prints, so keep its output quiet
   (step 3), or run the command in your own terminal when it might print the
   value. Example shape (names are placeholders, adapt to the manager's CLI):

   ```sh
   export DATABASE_URL="$(pw-cli get <item> <field>)"   # never echo it
   run-migration                                        # reads DATABASE_URL
   unset DATABASE_URL
   ```
3. Turn command tracing off (`set +x`), and make sure the command's own error
   output cannot echo the value (a connection string in an error is a leak).
4. When a command fails, report the error with the secret redacted, not the full line.
   If the value was printed anyway, the transcript has it: rotate that secret.
5. At the end, unset the variables and close the manager session.

## The sequence

1. **Freeze the sha.** Record the exact commit the owner approved. Everything
   below ships that sha and nothing newer.
2. **Re-read the remote.** `git fetch --tags`, then confirm the branch tip is
   the approved sha and the next tag name is still free. Other sessions tag on
   the same day: re-read remote tags immediately before tagging, not at the start.
3. **Run the checks locally** that CI would have run (typecheck, tests, build,
   the gate). Report each with its result. Clean worktree, correct Node and
   package-manager versions, frozen lockfile.
4. **Migrate first, if there is a migration.** Dry-run or inspect it, take or
   confirm the backup/restore point, apply it with the secret read as described above,
   and verify the result. A destructive migration needs the owner's explicit yes.
5. **Merge by hand if auto-merge is off:** squash-merge the approved PR into the
   release branch. No force pushes.
6. **Tag** the approved sha (annotated), push the tag.
7. **Deploy** with the repo's deploy script, after the whoami check, one target at
   a time (database, API, web, store...) in the order the repo's release doc names.
8. **Smoke-check** the deployed version with read-only requests only. No
   production writes, no synthetic payments, without the owner's yes.
9. **Back-merge** the release branch into the integration branch if the flow needs it.
10. **Report:** sha, tag, what ran with results, what did not run and why, the
    rollback command. Then unset the secrets.

## If something fails mid-way

Stop. Do not retry a deploy in a loop and do not «fix forward» with an unreviewed
change. Report the state (what is deployed, what is migrated, what is tagged),
the error with secrets redacted, and the rollback options. The owner decides.

## Known local traps

- A shared temp directory that two tools lock (test runners in parallel with
  the gate) fails unrelated checks; run them serialized.
- Shell differences on Windows (Git Bash vs PowerShell) change quoting and
  line endings in scripts; run release scripts in the shell the repo documents.
- Concurrent sessions: another agent or person may be releasing the same day.
  Re-read the remote right before every irreversible step.
