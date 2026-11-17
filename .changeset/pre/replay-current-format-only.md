---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

Replay guarantees zero drift only for logs written by the current format: the frozen
release-candidate texts and the drift reasons `legacy_event` and `text_inline_threshold` (a log
recorded before the 8 000-character text inline threshold) are gone. The line
restored after a compaction now reads "Skills invoked earlier in this conversation", since it also
names the template skills the kernel writes at a sub-agent's start.
