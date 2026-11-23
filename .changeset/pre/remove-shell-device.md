---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-tools": patch
"@capybara-hq/web": patch
---

Desktop and native shells no longer manage local devices (maintainer decision 2026-11-23): local
devices are connected only with `capybara-device`. The SDK drops the shell capability `device@2`
(`SHELL_CAPABILITY_KEYS.device`, `DeviceCapabilityV2`, `ThisMachineConnection`, `DeviceRunningOp`,
`DeviceCeilingRequest`, `KeepAwakeMode`, `DeviceConnection`) and the setup-guide directive
`::shell-action` (`SetupGuideShellAction`, `SetupGuideShellActionLine`, the `shell-action` block,
`SetupGuidePlaceInfo.shellActions`, `SETUP_GUIDE_LIMITS.shellActions`); a leftover
`::shell-action` line is now plain text. `GET /api/v1/meta` no longer reports
`features.localDevices` (`protocols.device` stays). The web drops the 本机 block on the device
page, the 本机 mark in the device list and picker, and the 连接本机 button in 新建设备.
