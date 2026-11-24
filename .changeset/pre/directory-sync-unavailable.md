---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

A manual directory sync that cannot read the extension's state for the org (a transient failure
such as a database error) now answers 503 `directory.unavailable` instead of 400
`extension.config_invalid`; real configuration problems keep their 4xx (`extension.needs_config`,
`directory.not_configured`). The skip reason of a scheduled sync is renamed from `config_invalid`
to `state_unreadable`.
