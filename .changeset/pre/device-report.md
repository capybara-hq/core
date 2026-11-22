---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": patch
---

`device-provider@1` providers now declare `networkAllowlist: true` and implement
`report(device, signal)`, which answers a `DeviceReport` (revision, description, home, limits,
reset; checked by `parseDeviceReport`). A provider can refuse a project directory with
`ProjectPathRefusedError`. The kernel refuses to load a provider that lacks any required member.
The kernel stores each device's report (`devices.report`, migration 0175), refreshed after its
instance is created or resumed; request paths read the stored copy.
