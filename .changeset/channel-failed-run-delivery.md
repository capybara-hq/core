---
"@capybara-hq/kernel": patch
---

A channel delivery no longer advances `last_seq` past a run's end event before the failure message
(or the closing of a draft) that event owes has been sent: a replica that took over after a crash
in between used to skip the message.
