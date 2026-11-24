---
"@capybara-hq/kernel": patch
---

`ctx.deviceAccess.addNetworkHosts` (the browser panel's allow) applies the device's new limits to
its running instance at once, under the exclusive lease as a tool call does, instead of leaving
them for the next tool call.
