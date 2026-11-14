---
"@capybara-hq/capybara": minor
"@capybara-hq/kernel": minor
---

Agent-created git commits and pull requests now carry a configurable attribution line. The
deployment defaults live in the startup config `attribution` (commit, pr, sessionUrl) and in the
admin console's settings; an agent's definition may follow them, use its own values or turn
attribution off. The effective values are recorded at run start in the conversation's run context,
so replay reproduces the instruction exactly; the kernel instructs the model and never rewrites git
history.
