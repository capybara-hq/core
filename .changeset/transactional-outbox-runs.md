---
"@capybara-hq/kernel": minor
"@capybara-hq/testing": minor
"@capybara-hq/web": patch
---

Runs follow the transactional outbox: a run's job, its ensure-run backstop, resumes, wait timeouts,
sub-agent dispatches, deliveries and tree stops are owed in the transactions that cause them. A run
nobody runs any more is repaired by one `run-orphan-check` (worker role, every minute): a running
run whose replica died is failed `run.orphaned` and reported to its parent; a queued run whose job
the queue lost is queued again and shown in the admin overview (队列丢失了后台任务). Reading a
conversation (events, SSE) no longer changes run state, the wait sweep is gone, and a finished run
cancels its pending approvals and questions in its terminal transaction. The dual-replica harness
fails `stop()` when the replicas left a queued run without its job.
