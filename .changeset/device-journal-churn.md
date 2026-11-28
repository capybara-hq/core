---
"@capybara-hq/device": patch
---

A revoked operation that never launched (or already completed) now stops for good instead of
staying owed: the owner ceiling check, every two seconds, used to rewrite and fully sync the
operation journal for each such entry, which queued every other operation behind it (minutes per
call on a Mac with a few dozen of them). A lost process's owed stop is no longer rewritten at every
check, checks no longer stack when one runs long, and an admission that lapses while the device is
busy is reported as "nothing ran, retry" instead of a scope refusal that sent agents outside the
sandbox.
