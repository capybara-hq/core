---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Device sandbox settings (approval-only profiles, R3 T2). The platform's `devices.fullAccess` becomes
`devices.outsideSandbox` (`CAPYBARA_DEVICES__OUTSIDE_SANDBOX`, admin `devicesOutsideSandbox`), and new
hot keys `devices.network.default` / `devices.network.ceiling` (`open` or `allowlist`, admin
`devicesNetwork`) set the device sandbox network; both are covered by the permission configuration
fingerprint (projection version 3). The org settings `fullAccess` and `cloudNetwork` become
`outsideSandbox` and `deviceNetwork { default, ceiling, base, extraHosts, excludedHosts }`; a default or
ceiling above the platform's ceiling is refused with `org.network_not_allowed`, and the refusal codes
are renamed `org.outside_sandbox_not_allowed` / `deployment.outside_sandbox_not_allowed` (new:
`deployment.network_not_allowed`, `device.network_not_allowed`, `device.outside_sandbox_not_allowed`).
The old config keys and environment variables are refused with a conversion message, and
`capybara config migrate-permissions` converts a config file (an old `off` also sets
`devices.network.ceiling: allowlist`, so nothing widens). Stored old keys are read narrower and kept in
step until the permission configuration publication converts them. Migration `0163` adds a cloud
device's `network_mode` and `network_hosts`, copied from an allowlist outer network snapshot.
