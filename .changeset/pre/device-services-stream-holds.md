---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Device services and stream holds in the kernel's SandboxService: `DeviceServices` starts, requests
and stops a device's named service process through its provider, and `holdForStream` keeps a
running device from idle suspension while a stream to it is open. The idle sweep is refused the device's lease while a stream hold is live (a viewer that opened
after its first look is seen under the lease). Every `ifRunning` ensure sends the provider the
name-only spec, and a service spec may not set `OPENSSL_CONF` or `OPENSSL_ENGINES` either.
