---
"@capybara-hq/kernel": patch
---

The Redis-free CLI commands (`capybara admin create`, `admin grant`) and contexts over a borrowed pool
start again: accounts depend only on the permission revocation writers, the event log skips its
bus hint where there is no bus, and a borrowed-pool context has the outbox.
