---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
"@capybara-hq/device": patch
"@capybara-hq/testing": patch
---

The device protocol frames (`parseDeviceFrame`, `DeviceFrame`, `DeviceHello`, ...) move from the
package root to the subpath `@capybara-hq/plugin-sdk/device-protocol`. The `list` / `scan` bounds
of the `device-provider@1` contract stay at the root: `MAX_DEVICE_LIST_ENTRIES` now lives with the
scan bounds in the device-provider module (one definition, which the protocol subpath imports), so
providers built against the previous SDK still load.
