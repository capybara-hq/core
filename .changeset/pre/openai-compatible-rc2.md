---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Bootstrap plugin `openai-compatible` moves to 0.1.0-rc.2: the DeepSeek dialect sends
mid-conversation system notices (sub-agent reports, background notices, tool-change reminders) as
in-place `[system]` user turns, so DeepSeek no longer moves them ahead of the conversation.
