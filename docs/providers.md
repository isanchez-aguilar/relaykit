# Providers

Everyone has different subscriptions, so the order agents delegate in is data, not prose. One file lists your providers; **the list order is the priority**, and a task goes to the first enabled provider that can do it. If that provider cannot, or its result fails verification (tests, typecheck, a reviewer), it moves to the next, until the task is done: always the cheapest that works. It goes down the list once per task; when no eligible provider is left, or the attempt or time budget the owner set is spent, it stops and reports what blocked it instead of retrying.

The default order is: local Qwen, Jules, Gemini via Antigravity, Antigravity's Claude models, Codex, then Claude Code on the cheapest model that solves the task (Opus only in extreme cases).

## Commands

```bash
relayrace providers init                 # write the default order to your file (never overwrites)
relayrace providers                      # the order, with plan, models and what each can do
relayrace providers pick review --exclude-family anthropic   # who reviews work Claude wrote
relayrace providers ui                   # edit plans, models and order in a local page
```

## Where the file lives

First found wins:

1. `<repo>/.ai/providers.json` (edited by hand).
2. `providers.json` next to your [config file](configuration.md) (`RELAYRACE_PROVIDERS` overrides the path). This is the one `providers ui` edits and `init` creates. It is also looked up in the old `relaykit` and `ai-kit` config folders, with a note.
3. The built-in default.

## Format

```json
{
  "version": 1,
  "providers": [
    { "id": "qwen", "label": "Qwen (local)", "kind": "qwen", "family": "local", "enabled": true,
      "plan": "local model, no quota", "models": [{ "id": "qwen-local", "cost": "free" }], "can": ["mechanical"] },
    { "id": "claude", "label": "Claude Code", "kind": "claude", "family": "anthropic", "enabled": true,
      "plan": "Max 5x", "can": ["mechanical", "edit", "implement", "review", "test", "critical"],
      "models": [{ "id": "haiku", "cost": "low" }, { "id": "sonnet", "cost": "mid" }, { "id": "opus", "cost": "high", "restricted": true }] }
  ]
}
```

| Field | Values |
|---|---|
| `kind` | `qwen`, `jules`, `antigravity`, `codex`, `claude`, `other` |
| `family` | `anthropic`, `google`, `openai`, `local`, `other`. Independence in a review counts by family, not by tool: Antigravity running a Claude model is still `anthropic`. |
| `can` | `mechanical`, `edit`, `implement`, `review`, `visual`, `test`, `critical`. `critical` is money, permissions, schema and architecture; a provider without it never receives them. |
| `models[].cost` | `free`, `low`, `mid`, `high`. The cheapest model wins. `restricted: true` means extreme cases only (`pick --extreme`). |
| `plan`, `notes` | Free text for you: the subscription or tier, and any limit worth remembering. |

## Rules the file enforces

- Never put keys or tokens in it: a value that looks like one is refused.
- Fable is never listed there: it needs the owner's yes for each use.
- `critical` is refused for Qwen, Jules and any Flash model, in the file and in `pick`.
- A provider whose models are all `restricted` is not offered for ordinary work.
- Quota is not read from this file; use `relayrace doctor` and your dashboard for that.
- The editor works on your personal file and only shows a repo override as a notice.

How the relay uses this order, phase by phase: [Relay](relay.md). The reasoning behind the default order: [Model selection](playbooks/model-selection.md).
