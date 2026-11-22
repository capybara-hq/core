---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
---

Dial-in channel contract: `permissions.dialIn = { protocol }` for a `device-provider@1` extension,
`DialInHandler` (`DeviceProvider.dialIn`), `ctx.dialIn` (`DialInChannel`), `ctx.devices`
(`DevicesCtx`), the frame envelope (`DialInMachineFrame`, `DialInKernelFrame`,
`parseDialInMachineFrame`, `DIAL_IN_PROTOCOL_RE`), `DeviceOfflineError`, and
`DeviceRequestNotSentError` moved from the kernel into the SDK.
