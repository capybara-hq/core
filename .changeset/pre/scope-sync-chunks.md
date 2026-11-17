---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

Owe a plugin's scope sync from its extension's deploy (enable, upgrade, approval) and the import
commit instead of a post-deploy add, a delayed backstop and an in-process reconcile wait; fan an
item's sync out to one job per chunk of orgs, all scope jobs sharing one BullMQ retry policy.
