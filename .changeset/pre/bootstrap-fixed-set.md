---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

`openai-compatible` is an optional bootstrap preinstall, no longer required: only `object-store-s3`,
`skills-core` and `file-preview` are fixed in every org. On an existing deployment the
demoted plugin keeps scope `all`: the bootstrap owes its scope sync, which installs it in every org
that has not switched it off, so it stays on there.
