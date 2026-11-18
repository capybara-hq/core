---
"@capybara-hq/kernel": minor
"@capybara-hq/device": minor
"@capybara-hq/testing": patch
---

Permission profiles are active: the kernel and `capybara-device` speak device protocol 3 only,
every builtin enters a device through the managed operation route, and each run records its
permission context. A restricted profile also reads the instance's staged skills root
(read-only); the working root comes from the held instance's committed roots; an instance gone
after a dispatched operation keeps the outcome unknown and is rebuilt for the next call; a run
another member triggers in an owner's conversation runs without the owner's device. A
`GenerateImage` call with `file_path` takes the same permission review as `Write`: an outside
directory is asked about (or reviewed) and granted for that call only. The testing helpers run on
the activated kernel.

The kernel never kills device work broadly any more: a crashed holder's operations are revoked
exactly (owed in the outbox before its record is forgotten, so a failed revoke is retried), and a
resumed, failed-update or quarantined instance revokes its started-or-unknown operations instead of
`killAll`; no stored background session id is signalled after a resume or a rebuild.
