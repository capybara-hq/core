---
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
---

Deliver the lifecycle hooks `org.member_removed`, `agent.deleted` and `org.deleted` durably: one
job per subscribing plugin is owed through the transactional outbox in the deleting transaction and
delivered through the `cap-kernel-lifecycle` queue, with retries (shown in the admin overview's
queues). Add the fake extension `fake-lifecycle`.
