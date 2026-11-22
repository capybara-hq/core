---
"@capybara-hq/device": minor
---

Per-connection state layout: each connection to a deployment lives in
`<stateDir>/connections/<deviceId>/` (credential, policy, `pid`), `machine.json` records the
layout version, and the control socket of a connection is `<stateDir>/run/<hash>.sock` (a short,
fixed-length name in a 0700 directory). New exports `listConnections`, `resolveConnection`
(device id, device name or host), `connectionDir`, `connectionsDir`, `DEVICE_ID_PATTERN` and
`ConnectionInfo`; a credential may carry `deviceName` and `orgName`.
