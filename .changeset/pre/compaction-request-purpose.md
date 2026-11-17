---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/plugin-model-fake": patch
---

`ModelRequest` gains an optional `purpose` (`"compaction"` on a conversation summary call). The
compaction request is identified by it instead of a `CAPYBARA_COMPACTION` marker in the system
prompt, so real providers no longer receive the marker; model-fake keys its summary reply on it.
