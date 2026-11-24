---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

`ctx.deviceAccess` works (browser use spec §7): an extension starts its declared device services in
the conversation's device (a stopped service is launched only after the command review allowed the
command as it runs, `env K=V … node <stateDir>/<entry> …` in the state directory; the verdict is
recorded with the tool call and a start is audited `device.service_started`; specs whose files or
environment would escape the state directory or change what runs are refused), sends them requests,
reports hosts the device's allowlist refused (an always-only network ask in the call's conversation,
with the page's URL), mints single-use 60-second viewer tickets, adds hosts to the device allowlist
(running services get the new limits) and answers its own tool call's handoff question. Every call
is limited to the conversation's owner on their own personal device and to the services the
extension declares. A `DeviceAccessError` an extension tool lets through reaches the model with its
own message.
