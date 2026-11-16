---
"@capybara-hq/capybara": patch
---

Plugin installs drop the unused `upgrading` status: migration 0137 turns any such row into
`installed` and tightens the status check; the kernel reads one set of live install statuses.
