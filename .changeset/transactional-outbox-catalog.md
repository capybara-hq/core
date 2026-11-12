---
"@capybara-hq/kernel": minor
---

Plugin scope syncs follow the transactional outbox: a scope change, a deployment-level disable or
enable, a 可共享 switch-off that narrows a plugin, an approved access request, an ownership
transfer, a platform plugin update and a new org owe their `scope-item` / `scope-org` job in the
transaction that makes the change, and a confirmed import or org upload owes it right after its
extension is deployed. The removal of an org-owned plugin owes its `owned-plugin-cleanup` job with
the removal. A crash or a Redis outage after the commit no longer loses the sync, so the worker no
longer re-enqueues every plugin's sync at start and the daily owned-plugin cleanup sweep is gone. A
migration that changes a scope inserts the outbox rows itself.
