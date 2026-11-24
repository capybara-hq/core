---
"@capybara-hq/plugin-sdk": patch
---

Device providers may implement `serviceStatus(h, name, signal)`: a device service's state without
starting it (the kernel reviews a service launch only when it is stopped).
`ctx.deviceAccess.reportBlockedHosts` takes an optional `{ url }`, the page the refused requests
came from. `ToolCallContext.idempotencyKey` documents that a re-run after an approved network ask
keeps the key.
