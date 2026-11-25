---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
"@capybara-hq/device": patch
---

Refused network hosts carry the layer that refused them end to end.

- SDK: `ctx.deviceAccess.reportBlockedHosts(call, hosts)` takes `ServiceBlockedHost[]`
  (`{ host, layer }`) instead of host names, and `sandboxProxyRefusalLayer(reason)` reads the layer
  from the device sandbox proxy's refusal reason (a closed address is `address`, a host off the
  allowlist `device`).
- Kernel: a device service's refused host gets the note of its layer: a host refused for its
  private or local address gets the address note, never a network ask or the "an organization
  admin adds it" note. A host reported twice keeps its most restrictive layer, and an IP literal is
  always `address`, so a report never makes a host grantable.
- capybara-device: a restricted command on macOS reports the hosts its operation proxy refused
  (`network.blocked`, which the protocol 2 removal had left unwired), so a sandboxed `curl` to a
  name resolving to a private address gets the address note instead of nothing.
