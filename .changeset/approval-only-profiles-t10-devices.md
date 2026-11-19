---
"@capybara-hq/kernel": patch
---

The device API speaks the device sandbox. The device view drops the old `mode` block and gains
`sandbox` (the network in effect and its ceiling, the allowlist hosts, the device's own network and
host list, whether a call may run outside the sandbox, which layer set each ceiling, the pending
change and the recent setting changes); a local device's `ownerCeiling` reports `outsideSandbox`,
`network` and `allowedDomains`, and a cloud device has none. `PATCH /devices/:id` takes a cloud
device's `network` (`open`, `allowlist` with optional hosts that only narrow its org's, `none`, or
`null` to follow the org) within the org's and the platform's ceilings (`device.network_not_allowed`
above them); an API token and the new Platform operation `devices.set-network` may only narrow it,
in the stored setting as well as in effect (following the org again counts as a widening), and a
token's change is recorded `via: "token"`. A narrowing revokes open-network work through the outbox
and keeps Full consent; a widening resets it.
The cloud `mode` switch and Full ceiling are gone, with `device.mode_on_device`,
`device.mode_requires_session`, `device.full_access_not_allowed`,
`device.owner_ceiling_confirmation_required` and `device.permission_not_migrated`; a local device's
network is answered with `device.ceiling_on_machine`. `POST /devices/:id/policy` only narrows: `add`
and `mode` are gone, and `ownerCeiling` takes `outsideSandbox: false`, `network: "allowlist"` and
`restrictedProjectReach: "workspace"`. A network ask is no longer made for a host no per-call grant
could allow: the reply names who adds it (the device owner on the machine, an organization admin or a
super admin), and a private address under the open network answers with the escalation hint.
