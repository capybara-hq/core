---
"@capybara-hq/plugin-sdk": patch
---

Interface stubs for approval-only permission profiles (unused until the protocol 4 cutover):
the `open-public` operation network scope (not yet accepted by the parser), `SandboxBoundary` and
`SandboxPermissionSupportV2`, `DeviceNetworkMode`, `DeviceOwnerCeilingV3` and
`DeviceOwnerCeilingNarrowingV3`, and the address-class table (`AddressClass`,
`OPEN_PUBLIC_DENIED_CLASSES`, `classifyAddress`, which throws until it is implemented).
