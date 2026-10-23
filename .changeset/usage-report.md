---
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-sdk": patch
---

Deliver `usage.report` metering reliably through queue `cap-kernel-usage-report`: one job per logged
`usage` event (chat runs and full-run eval replays), payload read from the event log at execution time.
Targets are the deployment's subscribers (approved manifests declaring the hook) that the organization
enabled, recorded per job; plugins run concurrently and only failed ones are retried (up to 5, 2 s
doubling) on the worker role; a replica shutdown does not use up an attempt. A maintenance sweep
(migration `0040_usage_report_sweep.sql`: partial index and watermark) re-enqueues recent usage events
every minute, so a lost fast-path enqueue is caught up; job ids dedupe. Delivery is at least once;
handlers must be idempotent by `eventId`. New config `hooks.usageReportConcurrency` (default 16) and
`hooks.usageReportKeepHours` (default 24).
