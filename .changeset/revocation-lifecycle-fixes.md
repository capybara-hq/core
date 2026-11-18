---
"@capybara-hq/kernel": patch
---

Revocation lifecycle fixes: a background start revoked (or given up) before its reference was
known, whose reference arrives later, is stopped by that exact reference before its revocation
is acknowledged; a `lost` task record is no proof the process ended.
Owed revocation jobs (a crashed holder's, each revoked operation's and their retries) carry the
device's org, so deleting the org removes them with its other owed jobs.
