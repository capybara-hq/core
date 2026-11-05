---
"@capybara-hq/web": patch
---

A sub-agent that waits for a person shows no spinner and no running clock, in the thread and in
the properties panel's background section: its row says what it waits for, and a sub-agent group
whose every active child waits says so in its header instead of "N subagents running".
