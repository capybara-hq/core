---
"@capybara-hq/device": minor
---

A new connection's owner ceiling allows running outside the sandbox (aligned with Claude Code):
commands still run in the sandbox, and a call that asks to run outside it runs only as the
conversation's permission profile decides. Existing connections keep their stored ceiling; `login`
prints how to turn it off (`capybara-device ceiling set -c <device id> --outside-sandbox off`).
