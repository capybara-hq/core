---
"@capybara-hq/kernel": patch
---

A deployment config secret whose only value is its schema default (for example openai-compatible's
`apiKeys`, which defaults to `{}`) now reads as not set in the admin console instead of "set".
