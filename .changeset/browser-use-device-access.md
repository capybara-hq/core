---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

`ctx.deviceAccess` works (browser use spec §7): an extension starts its declared device services in
the conversation's device (a stopped service is launched only after the command review allowed the
command as it runs, `env K=V … node <codeDir ?? stateDir>/<entry> …`: the entry in the service's
code directory where the provider keeps code apart, the state directory as the working directory;
the verdict is recorded with the tool call and a start is audited `device.service_started`; specs whose files or
environment would escape the code directory or change what runs are refused), sends them requests,
reports hosts the device's allowlist refused (an always-only network ask in the call's conversation,
with the page's URL), mints single-use 60-second viewer tickets, adds hosts to the device allowlist
(running services get the new limits) and answers its own tool call's handoff question. Every call
is limited to the conversation's owner on their own personal device and to the services the
extension declares. A `DeviceAccessError` an extension tool lets through reaches the model with its
own message.
`addNetworkHosts` takes exact host names only, as an approved network ask grants. A launch reviewed
in a tool call round that then asks for input keeps its review record (and the hosts its service
reported refused) for the call's result, which the resumed round writes.
