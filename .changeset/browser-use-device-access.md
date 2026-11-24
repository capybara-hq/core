---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

`ctx.deviceAccess` works (browser use spec §7): an extension starts its declared device services in
the conversation's device (the launch passes the command review, fail closed, once per start),
sends them requests, reports hosts the device's allowlist refused (an always-only network ask in
the call's conversation, with the page's URL), mints single-use 60-second viewer tickets, adds hosts
to the device allowlist and answers a call's handoff question. Every call is limited to the
conversation's owner on their own personal device and to the services the extension declares. A
`DeviceAccessError` an extension tool lets through reaches the model with its own message.
