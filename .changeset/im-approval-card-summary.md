---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

IM approval cards show what the web shows, never the raw call input: the approval card's
`inputPreview` now carries one line, the tool's confirmation summary in the card language (a
Platform operation's `summary`), else the tool's title and key argument (`Title: arg`), redacted
and at most 300 characters; the full input stays behind the card's web link. `renderCardAsText`
labels the line Summary / 摘要 and leaves it out when it is empty.
