---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
---

`run.lifecycle` `offer_declined` payloads name the declined event: `eventId` (the kernel's id) and
`dedupeKey` (the key the plugin passed to `ctx.triggers.emit`), for every reason, so a plugin can
tell a stale decline from one for its latest event of the subject.
