---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Device services and stream holds in the kernel's SandboxService: `DeviceServices` starts, requests
and stops a device's named service process through its provider, and `holdForStream` keeps a
running device from idle suspension while a stream to it is open.
