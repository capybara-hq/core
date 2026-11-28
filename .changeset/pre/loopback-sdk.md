---
"@capybara-hq/plugin-sdk": minor
---

ctx.deviceAccess loopback port grants: `grantLoopbackPort` / `revokeLoopbackPort` /
`loopbackPorts` with `LoopbackGrantView`, `permissions.deviceAccess.loopbackPorts`, the
`loopbackPorts` hello feature and support claim (`limitedBy.loopbackPorts: "device-update"`),
`ensureService` `loopbackPorts`, `DeviceServiceNetwork` and `parseLoopbackPorts`, the loopback
grant hosts and limits (`LOOPBACK_GRANT_HOSTS`, `isLoopbackGrantHost`, `LOOPBACK_DATABASE_PORTS`,
`LOOPBACK_MAX_PORTS_PER_SERVICE`), and `ServiceBlockedHost` with `port` and `class`.
