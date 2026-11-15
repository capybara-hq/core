---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Auto mode correctness (auto mode hardening spec §3, §5). Approving a network request adds its
hosts without turning an open cloud network into an allowlist. `platform.me` reports a new
device's mode and network from `effectiveDevicePolicy`. `sandbox.tiers`,
`sandbox.limits.devHosts` and `sandbox.limits.egress: "open"` in the loaded config now fail
startup with an error naming `devices.autoMode` and `cloudNetwork`; the startup warning fires when
the sandbox provider sets `refuseOpenNetwork` while an org can be on the open network. A cloud
device's owner may send it back to auto (`PATCH /devices/:id { mode: null }`, web session only;
an API token gets `device.mode_requires_session`), and the device view names the network sandbox
mode gives it (`mode.sandboxNetwork`). The device page confirms a cloud device's mode switch in
a dialog naming the network it will reach, and a card that cannot be chosen says why. The
open-network refusal text is provider-neutral.
