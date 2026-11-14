---
"@capybara-hq/kernel": patch
---

A person's default device is now the same for every concurrent caller right after the sandbox
provider switches back: a new conversation or a devices page read racing the restore of the
former default could be handed the default that was just demoted, so that conversation's files
landed on a device that was no longer the person's default. The fast path now confirms the live
default before answering and otherwise decides under the locks.
