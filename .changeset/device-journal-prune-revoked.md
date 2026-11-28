---
"@capybara-hq/device": patch
---

The operation journal now drops a revoked operation once it is settled and an hour past its
retention, like any other settled operation, and removes its control file after that commit. A
revoked operation that never launched owes no stop; a revoked lost process stays until it is
proven gone. A late delivery of a pruned operation is still refused as expired. Before, every
revocation stayed in the journal for good and every commit rewrote all of them.
