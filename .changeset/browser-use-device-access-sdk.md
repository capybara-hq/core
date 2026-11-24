---
"@capybara-hq/plugin-sdk": patch
---

Device providers may implement `serviceStatus(h, name, signal)`: a device service's state without
starting it. `ensureService` takes `opts.ifRunning`: it never starts a stopped service, keeps a
running one with the device's current limits applied again, and answers the stopped status
(the kernel reviews a launch only then, race-free). `DeviceServiceStatus` carries `stateDir`, the
service's state directory, which the command review sees the launch in. `DeviceServiceSpec`
documents the entry, file and env rules the kernel enforces (no `NODE_*`, `PATH`,
`SSL_CERT_FILE`, `SSL_CERT_DIR`, `LD_*`, `DYLD_*`, `CAPYBARA_*` or proxy variables). `DeviceAccessScope` gains `orgId`.
`ctx.deviceAccess.reportBlockedHosts` takes an optional `{ url }`, the page the refused requests
came from. `ToolCallContext.idempotencyKey` documents that a re-run after an approved network ask
keeps the key.
