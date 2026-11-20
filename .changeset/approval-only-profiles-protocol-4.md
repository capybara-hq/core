---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
---

Device protocol 4 (approval-only profiles), a paired kernel and device release with no fallback.

- SDK (breaking): `SandboxPermissionSupport` is version 2 (`boundary`, `network`, `outsideSandbox`
  instead of `fullAccess`), `DeviceOwnerCeiling` is version 3 (`outsideSandbox`, `network`,
  `allowedDomains`), `DeviceOwnerCeilingNarrowing` narrows each of them, and the strict parsers are
  `parseSandboxPermissionSupport`, `parseOwnerCeilingReport` and `parseOwnerCeilingNarrowing` (the
  interim `…V2` / `…V3` names are gone). `SandboxLimits.mode` is removed: lifecycle create and update
  carry resources and the outer network only, and `list` / `scan` take no `limits`. The policy
  summary has no `mode`, the `mode` feature is gone, and a `policy` op that adds hosts or carries a
  `mode` is refused (`POLICY_ADD_REFUSED`: widening happens only on the machine).
  `DEVICE_PROTOCOL_VERSION` is 4 and `LEGACY_DEVICE_PROTOCOL_VERSION` 3.
- Device: the hello, `policy` frames and answers carry the version 3 owner report and the version 2
  support report; the `policy` op refuses `add` and `mode` and writes nothing; `status` shows the
  sandbox network and the outside-sandbox setting; the login token field is `outsideSandbox`. A
  protocol 4 program facing an older deployment says the deployment must be upgraded.
- Kernel: refuses protocol 3 programs with 426 and an update instruction; reads the new owner and
  support reports (a machine without a protocol 4 report fails closed); never sends `add` to a
  local device: the device page's add is refused with the machine command, and an approval's
  "always allow" for a host becomes a grant for the run. The facts field `fullAccessCeiling` is
  `outsideSandboxCeiling`.
- Testing: the conformance suite reads `outsideSandbox` and accepts the scope contract's refusal of
  a restricted environment-network operation.
