---
"@capybara-hq/device": patch
---

Prepares the device side of protocol 3 (dormant: protocol 2 still runs until the protocol constant
changes). `start` builds the instance binder with one operation backend per bound generation
(macOS, Linux or the device's container), attested to the binding's runtime hash and verified with
the runtime staged in the state directory; one session state per machine credential with the
credential's reconnect grace; a drain that waits for the owned work and the held answers; every
end of the program (stop, machine stop, revoked, replaced, outdated) exact-stops the owned
operations and names any stop still pending. A bind that passed its other checks, or a create,
exact-stops the older generation's background tasks. macOS reports restricted support only after a
real worker on the verified runtime passes a write, read and network self-check, retried after a
transient failure; a docker-mode device attests its container's image id.
