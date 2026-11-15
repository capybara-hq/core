---
"@capybara-hq/kernel": patch
---

Creating a scheduled task with a yearly or rarer cron (`0 3 1 1 *`, `0 3 29 2 *`) no longer fails
with an internal error: the gap sample stops where the cron library stops looking ahead (8 years)
instead of throwing.
