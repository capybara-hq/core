---
"@capybara-hq/kernel": patch
---

Revocation lifecycle fixes: a background start revoked (or given up) before its reference was
known, whose reference arrives later, is stopped by that exact reference before its revocation
is acknowledged; a `lost` task record is no proof the process ended.
Owed revocation jobs (a crashed holder's, each revoked operation's and their retries) carry the
device's org, so deleting the org removes them with its other owed jobs.
A revoked exec, read or write on an incarnation that no longer runs is acknowledged once that
incarnation provably ended (its confirmed destruction recorded, or the operation past its
admission deadline plus `sandbox.limits.maxCommandSeconds`), instead of being retried hourly for
ever and keeping its local instance binding from being pruned.
