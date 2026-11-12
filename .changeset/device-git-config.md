---
"@capybara-hq/device": patch
---

At tiers `dev` and `open`, sandboxed commands may write `.git/config`, so `git init`, `clone`,
`config` and `remote add` work in OS mode. `.git/hooks` stays unwritable at every tier (now also
when the program runs from a directory that does not contain the device's roots), init and clone
use an empty template, and `strict` keeps `.git/config` unwritable.
