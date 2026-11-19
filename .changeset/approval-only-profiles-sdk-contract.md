---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
---

The SDK contract of approval-only permission profiles. The scope parser, the address classes and
the write policy below are live now; the new parsers wait for the protocol 4 cutover.

- `parseSandboxOperationScope` accepts the `open-public` network. The `device` filesystem and the
  `environment` network are accepted only together (the escalated call).
- `classifyAddress`, the data table `ADDRESS_CLASS_RANGES` (`AddressClassRange`) and
  `OPEN_PUBLIC_DENIED_CIDRS`, the closed set as CIDRs: longest prefix first; v4-mapped, SIIT,
  v4-compatible and 6to4 forms classify as their IPv4 address; Azure WireServer `168.63.129.16`
  is metadata; the well-known NAT64 prefixes, `2001::/23`, `3fff::/20` and IPv6 space outside
  `2000::/3` are closed. Operator-specific NAT64 prefixes are not covered.
- Strict parsers `parseSandboxPermissionSupportV2`, `parseOwnerCeilingReportV3` and
  `parseOwnerCeilingNarrowingV3` (a narrowing can only narrow).
- The restricted write policy denies the OS persistence locations: `Library/LaunchAgents` and
  `LaunchDaemons`, `.config/systemd`, `.local/share/systemd`, `.config/environment.d`,
  `.config/autostart`, KDE `autostart-scripts` and `plasma-workspace/env`, `.xprofile`,
  `.xsessionrc`, the remaining shell startup and logout files, `.config/git/config`, fish's
  `config.fish` and `conf.d`, and the absolute spools `SANDBOX_SYSTEM_WRITE_DENIES`. Protected move
  names come only from single-component entries; a multi-component entry refuses a move whose
  destination ends in its prefix when the moved directory holds the next component
  (`isSandboxMoveDenied` takes the directory's entries). New runtime digests: `linux-sandbox.py`
  c77731022868b92b67be3643b54c6260fcfbdc65e283cd9b8f7be03f4b6b0b9e, `native-files.py`
  029f47a8663ce7a40674657f856d07cc58cb5b9374c85d3edf69f3979b380a48.

Kernel: the public-address checks refuse the Azure WireServer (`168.63.129.16`) whatever the
exemptions, like the other cloud metadata endpoints.
