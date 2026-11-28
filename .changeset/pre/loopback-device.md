---
"@capybara-hq/device": minor
---

Apply granted loopback ports to device services on macOS: `service.ensure` takes
`network.loopbackPorts`, a changed set restarts the service, the owner ceiling bounds them, and the
hello announces `loopbackPorts`.
