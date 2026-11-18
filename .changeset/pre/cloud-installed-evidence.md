---
"@capybara-hq/kernel": patch
---

Cloud devices record installed permission evidence: after creating an instance (in the same
transaction as its handle), after a resume and whenever the recorded report went stale, the kernel
reads the cloud provider's `permissionSupport` under the lifecycle lease and records it with a
kernel-built identity (provider plugin and version, handle, generation, applied limits). The
recorded permission context and operation admission now read a cloud device the same way as a
local one: supported with its applied outer network once the evidence is current, unprobed while
it is missing, stale or waiting for a desired limits change. A cloud device without an instance
stays provisionable: its first managed call creates it and is then admitted.
