---
"@capybara-hq/kernel": patch
---

A default-device lookup that raced a provider switch-back could answer with the default just demoted,
so two concurrent callers got different default devices. The unlocked fast path now checks the live
default is unchanged after reading the former defaults, and otherwise lets the locked path decide.
