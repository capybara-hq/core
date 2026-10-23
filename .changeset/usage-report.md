---
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-sdk": patch
---

Deliver `usage.report` metering reliably through queue `cap-kernel-usage-report`: one job per logged
`usage` event (chat runs and full-run eval replays), payload read from the event log at execution time,
per-plugin retries (up to 5, 2 s doubling) on the worker role, only to plugins the organization enabled.
Delivery is at least once; handlers must be idempotent by `eventId`. New config
`hooks.usageReportConcurrency` (default 4).
