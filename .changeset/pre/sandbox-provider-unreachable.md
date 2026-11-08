---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A sandbox provider that can't be reached (connection refused, unknown host, a dropped connection)
now gives the sandbox tools an actionable error instead of a generic failure: a connection that
never opened says nothing ran and an admin must check the sandbox extension; one that broke
mid-call says to check the sandbox before retrying. The raw error stays in the kernel log.
