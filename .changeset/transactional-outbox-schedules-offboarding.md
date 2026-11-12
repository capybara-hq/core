---
"@capybara-hq/kernel": minor
---

Scheduled task fires follow the transactional outbox: the transaction that writes a pending task
run (the scan's tick, a person's "Run now") owes its `sched-fire-<taskRunId>` job in the outbox, so
a crash or a Redis outage after the commit no longer loses a tick. The scan's repair is gone (no
re-enqueue after 10 minutes, no give-up after an hour, no recheck of started runs) and with it the
`scheduled_task_runs.rechecked_at` column (migration 0122). A tick whose fire job runs more than 10
minutes past the org's catch-up window (workers down for long) is still skipped as `missed`, now by
the fire job itself; a "Run now" still runs. The fire job's claim owes a settle check 10 minutes on
(`sched-settle`): a run claimed but never started (its start failed for good) is linked, settled or
released as the scan's recheck did, so a once task's last run never stays pending. The tick and "Run
now" also owe an unfired check: a run whose fire job failed for good before claiming it is skipped
(`missed`, or `removed` for a "Run now") instead of blocking every later tick as an overlap.
