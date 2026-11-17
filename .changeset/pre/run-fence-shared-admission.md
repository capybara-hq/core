---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

The runs of one org append in parallel: the run loop's own writes (event appends, model output and
usage, checkpoints, the suspend) are admitted under a shared transaction-scoped advisory lock per
org instead of the org row lock. Every other fenced write, and every write inside a tool step,
still takes the org row first, so tool steps stay serialized per org. Org deletion and offboarding
take the advisory lock exclusively first, so they wait for the admitted writes and are not starved
by them.
