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

A plugin import writes its platform components (skills, agent templates, connector templates,
themes) in the import's transaction, and so does the super admin's confirmation of an org upload's
first version: their files are copied before it under a key made from their content, so a failed
import leaves no item and a retry copies nothing again. The worker job
`platform-components-migrate` and its retry after a failed post-import sync are gone. Removing an
org upload still awaiting confirmation owes its cleanup too.
