---
"@capybara-hq/capybara": patch
---

Bootstrap pins sandbox-docker 0.1.0-rc.20 (the R3 instance boundary: support v2, no `limits.mode`,
the egress proxy's closed address classes and fake-IP DNS-over-HTTPS, host addresses denied) and moves
the marketplace and the compose sandbox image builds to plugins ae438ab. sandbox-docker rc.20 needs
kernel 0.1.0-rc.55 or later.
