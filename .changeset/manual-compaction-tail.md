---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A manual compaction (`/compact`) now summarizes every turn before the latest one, whatever
`keepRecentTurns` says, and inside the latest turn keeps verbatim only the most recent tool pairs
that fit about a fifth of the model's context window. It records `compaction_skipped` (reason
`nothing_to_summarize`) only when nothing precedes the kept tail; the web divider reads "Nothing to
compact · the conversation is still short". Automatic and reactive compaction are unchanged.
