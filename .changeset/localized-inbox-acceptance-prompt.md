---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

`ctx.inbox.post` takes `title` and `body` as a single string or as `{ zh, en }` (like action
labels); a bilingual text is stored as given (migration 0197) and the inbox, the push preview and
the Platform tool's dismiss confirmation show it in the reader's language. The acceptance
automation's prompt now states the mechanism for any directed event instead of "this work was
assigned to you"; migration 0198 updates unedited acceptance prompts.
