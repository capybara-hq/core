---
"@capybara-hq/device": patch
---

The program runs named device services and bridges dial-in streams to them (browser use). The
relay's `service.ensure`, `service.stop`, `service.status` and `service.request` bodies start a
service under the local sandbox on macOS host devices (Node is the program's own runtime; its code
runs from the read-only code directory `<device dir>/svc-files/<name>`; writes only in its state
directory `<device dir>/svc/<name>` and `<workspace>/downloads`; the device's network intersected
with the owner's ceiling; restarted when ensured with another network; never restarted on its own),
stop it, report it and send it one request. An `ifRunning` ensure reads only the service's name,
starts nothing, and restarts a running service whose network changed from the spec it was launched
with and its stored code, never the request's. A service whose owner ceiling changed (network or
revision) is stopped at the next owner reconcile, and a new instance generation stops every
service. Agent operations can neither read nor write the services' state and code directories.
Files are written without following links a service planted. A `stream-open` naming a service opens
a stream connection to its socket, carried as `stream-data` frames with per-stream credit. Linux
host and docker-mode devices answer that services are unsupported for now.
