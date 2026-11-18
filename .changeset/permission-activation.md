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
another member triggers in an owner's conversation runs without the owner's device. The testing
helpers run on the activated kernel.
