---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A person's stop of a conversation now stops every running sub-agent below it too, and the
conversation stays stopped: no sub-agent finish or report starts it again until the next message,
whose run sees what they delivered. The conversation's own background Bash tasks keep running.
