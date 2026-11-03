# Reading `doctor`

`relayrace doctor` is read-only and spends no model quota. A fictional, anonymized excerpt (some tool rows omitted; versions are examples):

```text
Relayrace doctor

Config
  file          /home/user/.config/relayrace/config.json (found)
  Agent Desk    not configured (repo registration is skipped)
  notes         not configured

Tools
  ok      codex     1.0.0                               login: yes  (looks logged in)
  MISSING agy       -                                    (not found on PATH)

Local model
  down    http://127.0.0.1:8080/health  (not reachable (optional: Qwen is never required))

Global files (relayrace sync --check)
  drift   1 file out of date; run `relayrace sync` to write them
            /home/user/.gemini/antigravity-cli/rules/relayrace-contract.md

This repository
  not installed; run `relayrace init --profile <generic|web-app|notes>`
```

## Sections

| Section | What it tells you |
|---|---|
| **Launcher** | Whether `relayrace` is on PATH, and the absolute Node executable running this invocation. |
| **Config** | The config file in use and the optional integrations. |
| **Providers** | Where your providers file comes from and the priority order. |
| **Tools** | Installation and login are separate: login is `yes`, `no`, `unknown`, or no login needed. The probes are read-only status commands. |
| **Local model** | Optional health of the Qwen server. |
| **Global files** | Read-only drift between your global files and the kit (`sync --check`). |
| **This repository** | Which profile files are present and the update status. It reports presence, not test success. |
| **Warnings** | Configuration or authentication issues, when present. |

## Exit code

Missing optional tools, model health and drift are informational. `doctor` exits 1 for a missing Git or an unsupported Node, not for every warning.

## Privacy

`doctor` prints only a parsed version token per tool, and reported URLs omit credentials, query strings and fragments.

If a tool shows MISSING but you know it is installed, see the [FAQ](faq.md#doctor-says-a-tool-is-missing-but-it-is-installed).
