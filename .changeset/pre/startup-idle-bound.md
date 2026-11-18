---
"@capybara-hq/kernel": patch
---

The permission configuration startup transaction's idle-in-transaction bound is 5 s (statement and
lock bounds stay 500 ms): a client pause of half a second (OS scheduling, GC, CPU throttling) no
longer fails the kernel start, while a stalled process still cannot hold the platform permission
lock for long.
