---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
---

`DialInHandler` callbacks name the machine and the connection: `onHello`, `onFrame` and `onClose`
get a last argument `DialInConnectionInfo` (`{ machineId, connectionId }`): the authenticated
machine's id and the connection id the kernel sends in `ready`. A `replaced` close carries the old
machine's id, so a provider can tell a replaced machine from its successor.
