---
"@capybara-hq/device": patch
---

`capybara-device` removes the bare-name service entries from before service ids once per device directory (a `svc/.ids-v1`
record), so a later change of the id rule never wipes what services keep.
