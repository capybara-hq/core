---
"@capybara-hq/device": patch
---

Every follow-up command a message names now carries `-c <device id>` (service install / start /
restart / stop, ceiling set, policy add, login output), so it can be copied on a machine with more
than one connection.
