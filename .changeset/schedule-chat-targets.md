---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Scheduled-task tools can deliver to an IM chat: `ScheduleCreate` / `ScheduleUpdate` take
`mode: "chat"` with the chat and the connection's agent, and the new `ScheduleTargets` tool lists
the chats the caller can deliver to (the same data as `schedules.chat-targets`). A chat whose
channel extension is disabled in the org is no longer offered or accepted at create or update, and
a run skipped for it records `plugin_disabled` instead of `target_gone`.
