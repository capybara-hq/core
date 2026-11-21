---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
---

`device-provider@1` providers now declare `networkAllowlist: true` and implement
`report(device, signal)`, which answers a `DeviceReport` (revision, description, home, limits,
reset; checked by `parseDeviceReport`). A provider can refuse a project directory with
`ProjectPathRefusedError`. The kernel refuses to load a provider that lacks any required member.
