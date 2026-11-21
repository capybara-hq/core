---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/device": patch
---

The device protocol gains the error kind `unsettled`: a device reports earlier work that has not
settled (a new instance or a supervisor close refused) as `SandboxWorkUnsettledError`, a subclass of
`SandboxPermissionUnsupportedError`, so every existing definite-refusal check still applies.
`isSandboxPermissionUnsupportedError` now matches any subclass by its inherited tag. Upgrade the
kernel before devices: a kernel that predates this kind answers a protocol error to that request.
