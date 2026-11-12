---
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": minor
---

A character budget for the skills catalog: `skills.catalogBudgetChars` (hot, default 16000). At run
start the catalog's entries are ranked (the agent's own and the ones it shared, builtin, the organization's own, then
plugin skills) and those past the budget are recorded in the snapshot as name-only and listed
after the others under "More skills (names only; …)". Old snapshots render as before.
