---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
"@capybara-hq/device": patch
"@capybara-hq/testing": minor
---

Rename the `sandbox@2` extension point to `device-provider@1`, a multi-provider point: several
device providers can be loaded side by side. `SANDBOX_EXTENSION_POINT` becomes
`DEVICE_PROVIDER_EXTENSION_POINT` and `SandboxProvider` becomes `DeviceProvider`. The
`sandbox-docker` bootstrap pin is removed.
