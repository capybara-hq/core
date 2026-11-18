---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

TaskOutput and TaskList calls get their own tool kind: a group waiting on a background task says
"Waiting on a background task" instead of "Reading file", and done ones count as background task
checks, not file reads.
