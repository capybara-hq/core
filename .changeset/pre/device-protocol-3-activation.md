---
"@capybara-hq/plugin-sdk": minor
---

The device protocol's scope-bearing operations move into `device-protocol.ts` under their
canonical names (`DeviceHello`, `parseDeviceFrame`, `parseOperationResult`, `DeviceOwnerCeiling`,
`KernelRequest`, `DeviceResponse`, `BindInstanceRequest`, ...; the `V3` suffixes and
`device-protocol-v3` are gone). Protocol 2's frames that a protocol 3 name replaced keep a `Legacy`
prefix (`LegacyDeviceHello`, `parseLegacyDeviceFrame`, `LegacyDevicePolicyArgs`, ...).
