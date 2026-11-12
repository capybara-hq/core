---
"@capybara-hq/kernel": patch
---

Conversations record where they come from (`conversations.source`: `web`, `channel_dm`,
`channel_group` or `subagent`), set at creation and never changed. Migration 0120 adds the column
and backfills existing conversations from their kind, their channel thread rows (archived ones
included) and, for a group run whose thread is not bound yet, their delivery target.
