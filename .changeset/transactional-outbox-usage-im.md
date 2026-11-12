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
