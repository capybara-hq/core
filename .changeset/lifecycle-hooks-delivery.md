---
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
---

Deliver the lifecycle hooks `org.member_removed`, `agent.deleted` and `org.deleted` durably: one
delivery per subscribing plugin is recorded in the deleting transaction and delivered through the
`cap-kernel-lifecycle` queue, with retries and a sweeper. Add the fake extension `fake-lifecycle`.
