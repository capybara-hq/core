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
step until the permission configuration publication converts them. Migration `0165` adds a cloud
device's `network_mode` and `network_hosts`, copied from an allowlist outer network snapshot.

The stored-key conversion runs at every permission configuration publication and stores exactly what
readers saw. An old `off` (platform, org, file, Nacos, environment or an invalid value) converts to
`outsideSandbox: off` plus the allowlist network ceiling: cloud devices of such a platform or org that
ran on the open network now get the allowlist (the conversion logs a warning naming each, with how to
reopen it). At the version conversion, cloud devices whose old effective network was the allowlist
(for example sandbox-mode devices under `sandbox.limits.orgHosts: within`) keep it
(`network_mode: allowlist`).

Release note: once a new replica has converted the permission configuration publication to version 3,
rolling back to an older image is blocked (its replicas fail the publication barrier), as with B1.
