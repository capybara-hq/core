---
"@capybara-hq/device": patch
---

The program runs named device services and bridges dial-in streams to them (browser use). The
relay's `service.ensure`, `service.stop`, `service.status` and `service.request` bodies start a
service under the local sandbox on macOS host devices (Node is the program's own runtime; writes
only in `<device dir>/svc/<name>` and `<workspace>/downloads`; the device's network intersected
with the owner's ceiling; never restarted automatically), stop it, report it and send it one
request. A `stream-open` naming a service opens a stream connection to its socket, carried as
`stream-data` frames with per-stream credit. Linux host and docker-mode devices answer that
services are unsupported for now.
