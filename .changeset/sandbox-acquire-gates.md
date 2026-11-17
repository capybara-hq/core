---
"@capybara-hq/kernel": patch
---

The sandbox service refuses every acquire of a device that carries the permission reconcile marker
(raw use, managed operations, trusted preparation and owner browsing) under its lease and before
any provider call. On the staged v3 path the exclusive lifecycle holder binds the committed
instance generation before it downgrades: shared use waits for an installed binding, a lost reply
is resent with the same binding id by the next use, an open legacy obligation means no bind, and
two replicas send one binding. Protocol 2 registers no binder and never binds.
