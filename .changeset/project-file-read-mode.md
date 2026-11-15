---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/device": patch
"@capybara-hq/capybara": patch
---

Carry current mode ceilings on local stat and readFile requests so project context loads before
any command and reads cannot inherit a stale wider command decision. Device protocol v2 requires
a matching kernel and device upgrade; existing credentials and device files remain valid.
