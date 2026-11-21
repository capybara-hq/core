---
"@capybara-hq/design": patch
"@capybara-hq/web": patch
---

The shell no longer schedules a React update from inside Next's history insertion effect
("useInsertionEffect must not schedule updates" in development) when it counts in-app history.
