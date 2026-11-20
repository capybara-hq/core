---
"@capybara-hq/kernel": patch
---

`Bash` recognises curl 8's wording of a sandbox proxy refusal ("CONNECT tunnel failed, response
403") as a sandbox signal, so the result offers the per-call escalation where it is available.
