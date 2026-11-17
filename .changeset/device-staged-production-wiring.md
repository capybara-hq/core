---
"@capybara-hq/device": patch
---

Prepares the device side of protocol 3 (dormant: protocol 2 still runs until the protocol constant
changes). `start` builds the instance binder with one operation backend per bound generation
(macOS, Linux or the device's container), attested to the binding's runtime hash and verified with
the runtime staged in the state directory; one session state per machine credential with the
credential's reconnect grace; a drain that waits for the owned work; a stop and a machine stop that
exact-stop the owned operations. A bind or create of a new instance exact-stops the older
generation's background tasks. macOS reports restricted support only after a real worker on the
verified runtime passes a self-check at bind.
