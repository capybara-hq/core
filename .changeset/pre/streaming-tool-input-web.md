---
"@capybara-hq/capybara": patch
---

The conversation page shows a tool call while the model writes it (spec 2026-11-26): a streaming
row (「生成中」 with lines and size) appears as soon as the call starts, `Write` streams as a live
diff against the file's current content (or a numbered preview for a new or unread file), `Edit` as a
live diff, `Bash` as its growing command, and the logged row replaces it in place.
