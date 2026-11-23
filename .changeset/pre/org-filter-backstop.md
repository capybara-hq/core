---
"@capybara-hq/kernel": patch
---

Kernel queries on tables with an `org_id` column now filter by it wherever the org is known (about
270 queries), and a schedule approval card no longer shows the name of another org's channel
connection when the tool input names its id (#115).
