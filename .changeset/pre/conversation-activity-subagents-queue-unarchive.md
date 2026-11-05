---
"@capybara-hq/kernel": patch
---

A run waiting on its sub-agents reports `activity: "running"` (only a wait for a person is
`waiting`, also for `state=waiting`), and a queued message sent to an archived conversation brings
it back to the default lists, as a direct message does.
