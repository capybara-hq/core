---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

Plugin installs drop the unused `upgrading` status: migration 0138 turns any such row into
`installed` and tightens the status check; the kernel reads one set of live install statuses.
