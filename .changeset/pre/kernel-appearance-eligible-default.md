---
"@capybara-hq/kernel": patch
"@capybara-hq/plugin-sdk": patch
---

At org level, applying a suggested appearance judges the followed platform default theme by its
eligibility: a stored default that is no longer eligible renders the built-in, so applying the
plugin's theme is reported as a change. `permissions.client: true` without a client section is
reported as "permissions.client is true but extension.client is missing".
