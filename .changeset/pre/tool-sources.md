---
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
---

Offer an extension tool only in the conversation sources its `spec.sources` lists (hidden with the
reason elsewhere, a resumed call refused), and give plugin tool handlers the conversation's
`source`, its owner (`ownerAccountId`) and the trigger account's `role`. `fake-tools-ui` gains the
tool `web-only`.
