---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

The org extension tools list answers an empty list for an extension that runs but registers no
tools (a channel, a model provider) instead of 404, so its settings no longer show 「无法读取工具」.
