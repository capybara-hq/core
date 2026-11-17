---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

An org's new plugin version applied at once, and the platform's import-and-update, no longer owe
a scope sync from the import's commit: the update that follows owes it with its own commit. The
early sync ran while the update moved the extension, installed the old version in the owner org
mid-update and made the update refuse its own preview (`plugin.upgrade_stale`).
