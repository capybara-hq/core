---
"@capybara-hq/kernel": minor
---

Usage reports follow the transactional outbox: a `usage.report` delivery is owed in the transaction
that writes the usage it reports (a model call's, compaction's, title's or `WebFetch` extraction's
`usage` event, an embed call's `model_usage` row), while the deployment has at least one enabled
extension that declares the hook. That is read from the database (cached 30 s per replica, cleared
when plugins change), so a replica without the handler still owes the report another replica
delivers. Usage written while no extension subscribed is not reported later. The usage sweep, its
watermark table (migration 0120) and `hooks.usageReportKeepHours` are gone: finished delivery jobs
are kept 24 hours.

IM delivery is owed too: an event append to a conversation with a channel target (a reply, an
approval decision, a question answer, a wait stop) adds the conversation's deliver job to the outbox
in its own transaction, and binding a conversation to its IM target owes the first one with it, so a
crash or a Redis outage after the commit no longer loses the reply or the card update. A
conversation without a channel target writes nothing more. The in-process
`conversation.event-appended` and `run.wait-stopped` events are gone; `run.started` stays a hint
that starts streaming drafts at once.
