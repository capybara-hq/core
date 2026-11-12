---
"@capybara-hq/kernel": patch
---

The last direct job adds follow the transactional outbox or say why they need not. An eval run's
start owes one case job per case in the transaction that writes the run, so a crash after the
start no longer leaves a run waiting for jobs that were never added (the "enqueue failed" path
that marked such a run failed is gone). A background task finish or delivery inside a
conversation's wake window owes the delayed `bg-wake` job in the transaction that found it, so the
wake is no longer lost when the process dies or Redis is down. The eval queue's jobs are named
`eval-case`.
