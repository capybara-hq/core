---
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

A transactional outbox: work that must follow a commit is a row in `capybara.outbox` written in the
same transaction (`OutboxService.add`), delivered right after the commit by a fast path and, when
that fails, by a relay on the worker role every 2 s; failures back off and after 20 attempts the
row is a dead letter the super admin sees in the overview (无法排入队列的后台任务) and can retry or
discard (`/api/v1/admin/outbox/dead`, Platform operations). New checks `kc-enqueue-via-outbox`,
`kc-after-commit-hint` and `check:outbox-registry` (migration 0119).
