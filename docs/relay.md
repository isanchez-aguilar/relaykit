# Relay and `task.json`

`relayrace relay` hands one task between provider CLIs, in the order of your [providers file](providers.md), until the work is done and independently reviewed. `relayrace jules` does the same starting from a Jules cloud task.

## The task file

Both runners load the same fields:

| Field | Validation |
|---|---|
| `id` | A string matching `^[a-z0-9][a-z0-9-]{0,60}$` (1–61 characters). Use a new ID when changing a task. |
| `objective` | A nonempty string after trimming whitespace. |
| `acceptance` | A nonempty array of nonempty strings describing observable acceptance. |
| `jules` | Required only for Jules: `repo` and `branch` must exactly match `.ai/project.json`. |

A minimal task:

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

The complete [task.example.json](../tests/fixtures/task.example.json) is tested with the production loader used by both runners.

## How the relay chooses

- Providers are tried in the order of your providers file, **per phase**: a CLI implements only through an enabled entry that can `implement` or `edit`, and reviews only through one that can `review`.
- A review never comes from the CLI or the model family that implemented.
- When a quota runs out, the next eligible provider continues. When none is left, or the attempt or time budget is spent, it stops and reports what blocked it instead of retrying.
- The relay needs at least two available provider CLIs among Claude Code, Antigravity and Codex.
- `--rotate` uses the legacy alternation between CLIs instead of the priority order; it checks CLI identity only, so choose different model families yourself.
- The relay starts `agy` with `--model` set to the cheapest model its entry lists, so the family you declare is the family that runs. Check the ids with `agy models`; a wrong id makes that turn fail.
- With an API key in the environment, the relay refuses to run, so a subscription never silently becomes a paid API call.
- It refuses the Fable model unless you set `RELAYRACE_ALLOW_FABLE=1` for that run. See [Configuration](configuration.md).

Resume an interrupted run with the same command and an unchanged task; do not reuse an ID for different work.

## Jules (cloud bridge)

Add `"jules": { "repo": "example/project", "branch": "main" }` to the task JSON and put the same pair in `.ai/project.json`. Then:

```bash
relayrace jules .ai/runs/task.json
```

Jules needs:

- a repository connected to Jules;
- a clean, dedicated checkout whose origin matches that repository;
- HEAD at the remote **default branch** commit, and `branch` naming that default branch.

Jules works on its own branch in the cloud and the bridge downloads a patch. The patch goes through local integration and the same independent review: cloud completion does not finish acceptance. The hand-off to the local relay needs at least two available provider CLIs.
