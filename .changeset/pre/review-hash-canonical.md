---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Importing a plugin whose connector template has an auth or endpoint object no longer fails with
`plugin.review_stale`: the review hash is computed over canonical JSON, so the jsonb round trip of
the stored review no longer changes it.
