---
"@capybara-hq/kernel": patch
"@capybara-hq/plugin-sdk": patch
---

Upgrade notes for approval-only profiles (device protocol 4).

- Full access consent resets once on upgrade. A stored owner report from a protocol 3 device
  (owner report version 2) is unparseable for the new kernel, so its machine fails closed until the
  upgraded device program reports again, and every conversation on Full access falls back to
  Approve for me. People choose Full access again once their device is upgraded.
- Sandbox providers must report `permissionSupport` version 2 (`boundary`, `restricted`,
  `network { openPublic, allowlist, perOperationHosts }`, `outsideSandbox`, `background`); a
  provider without it is unprobed and admits no operation. Providers must not require or read
  `limits.mode`: lifecycle `create` and `update` carry resources and the outer network only, and a
  device's `exec` / `create` limits refuse any other key.
