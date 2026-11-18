---
"@capybara-hq/device": patch
---

`commands.log` records an approved per-call sandbox escalation as `isolation: "full"` with
`grantSource: "call approval"` (decided by the operation's reach, never the command text).
