---
"@capybara-hq/plugin-sdk": patch
---

Device providers may implement `serviceStatus(h, name, signal)`: a device service's state without
starting it. `ensureService` takes `opts.ifRunning`: it reads only the name (the kernel sends a
name-only spec), never starts a stopped service, keeps a running one with the device's current
limits applied again (a restart runs the spec it was launched with), and answers the stopped status
(the kernel reviews a launch only then, race-free). `DeviceServiceStatus` carries `stateDir`, the
service's state directory, which the command review sees the launch in. `DeviceServiceSpec`
documents the entry, file and env rules the kernel enforces (no `NODE_*`, `PATH`, `SSL_CERT_FILE`,
`SSL_CERT_DIR`, `OPENSSL_CONF`, `OPENSSL_ENGINES`, `LD_*`, `DYLD_*`, `CAPYBARA_*` or proxy
variables) and that the entry runs from `codeDir ?? stateDir`. `DeviceAccessScope` gains `orgId`;
`ctx.deviceAccess.addNetworkHosts` takes exact host names only.
`ctx.deviceAccess.reportBlockedHosts` takes an optional `{ url }`, the page the refused requests
came from. `ToolCallContext` documents that a call whose device service reported refused hosts runs
again after an approved network ask, with the same `idempotencyKey`.
