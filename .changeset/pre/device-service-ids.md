---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
"@capybara-hq/device": patch
"@capybara-hq/capybara": patch
---

Device services are namespaced per extension (core#817): a device provider now receives every service
by its id `<extension>.<name>` (`DEVICE_SERVICE_ID_RE`, `deviceServiceId`) in `ensureService`,
`stopService`, `serviceStatus`, `serviceRequest` and `openStream`, never by the extension's bare name,
so two extensions declaring the same service name never start, stop or reach each other's process.
`ctx.deviceAccess` keeps the extension's own names and maps statuses back. `capybara-device` accepts
service ids only (a machine on an older version refuses them: update it with the deployment), and the
device service conformance starts `conformance.echo`.
