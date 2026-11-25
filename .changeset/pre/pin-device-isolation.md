---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Pin the bootstrap device providers to the releases that take namespaced device service ids (core#840):
device-docker 0.1.0-rc.30 (services as their own user, pinned read-only Chromium in the sandbox image)
and device-local 0.1.0-rc.11 (sealed service install directory, gone at once after a machine restart),
plus the plugins marketplace commit and the compose sandbox image build context at 44fa9a1. The kernel
and these providers move together: deploy them in one step, together with device-e2b 0.1.0-rc.30 and
browser 0.1.0-rc.5 where installed, and capybara-device 0.1.0-rc.37 on machines.
