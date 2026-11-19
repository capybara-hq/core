---
"@capybara-hq/plugin-sdk": patch
---

Interface stubs for approval-only permission profiles (unused until the protocol 4 cutover):
the `open-public` operation network scope, `SandboxBoundary` and `SandboxPermissionSupportV2`,
`DeviceNetworkMode`, `DeviceOwnerCeilingV3` and `DeviceOwnerCeilingNarrowingV3`, and the
address-class table (`AddressClass`, `OPEN_PUBLIC_DENIED_CLASSES`, `classifyAddress`).

The SDK contract of approval-only profiles:

- `parseSandboxOperationScope` accepts the `open-public` network and refuses the `environment`
  network unless the filesystem is `device` (that pair is the escalated call).
- `classifyAddress` and the data table `ADDRESS_CLASS_RANGES` (`AddressClassRange`): the IPv4 and
  IPv6 address classes of the open sandbox network, longest prefix first; v4-mapped, SIIT,
  v4-compatible and 6to4 forms classify as their IPv4 address, the NAT64 prefixes and IPv6 space
  outside `2000::/3` are closed.
- Strict parsers next to the protocol 3 ones: `parseSandboxPermissionSupportV2`,
  `parseOwnerCeilingReportV3` and `parseOwnerCeilingNarrowingV3` (a narrowing can only narrow).
- `SANDBOX_MANDATORY_WRITE_DENIES` adds the OS persistence directories: `Library/LaunchAgents`,
  `Library/LaunchDaemons`, `.config/systemd/user`, `.config/autostart` and the crontab spools
  (`at/tabs`, `spool/cron`). New runtime digests: `linux-sandbox.py`
  cbc9f1d5b5b723d969acd82541a10e730e0ab0ac62b9076bfb5f246be3f4965a, `native-files.py`
  67cefecbe6c5687fa8e779ce6492965bda000a7905285deec6be3c724ec4fa1f.
