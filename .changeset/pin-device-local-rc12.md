---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Pin the device-local bootstrap plugin to 0.1.0-rc.12 (reports the running service's files digest, so an
extension upgrade restarts its device service; core#874) and the plugins marketplace commit with the
compose sandbox image build context to a48ecd8.
