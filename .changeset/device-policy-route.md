---
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": minor
---

The device owner edits a connected device's network policy from the web:
`POST /api/v1/orgs/:orgId/devices/:id/policy` (`add`, wildcards allowed; `remove`; `network`
`allowlist` or `open`), web session only, delivered with the `policy` device operation. Widening
needs the device's local `remoteGrants: "owner"` (else 409 `device.policy_refused` with the command
to run on the machine). The device view lists the last ten policy changes (`network.recent`).
