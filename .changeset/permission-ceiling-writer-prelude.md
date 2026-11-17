---
"@capybara-hq/kernel": patch
---

Ceiling writers a Platform operation reaches from a tool step (device deletion, device project add
and remove, org settings narrowing Full or the cloud network, account status changes, the platform
Full switch) take their permission authority write lock in the run's ordered prelude, after the org
row and before the conversation rows, so they no longer deadlock with a prelude-first reader of the
same tree. Inside a fenced transaction every new permission authority lock, read or write, taken
after the fence's rows now fails with a typed internal error (`PermissionLockOrderError`).

A network ask's device change settlement (the always decision and the `device-op-resolve` job)
takes the machine's device lock before the ask's conversation; the cloud permission snapshot
locks the device row before the device lock; an admin network allowance add locks the target org's
row before the super admin lock.
