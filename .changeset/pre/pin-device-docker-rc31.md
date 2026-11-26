---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Pin the device-docker bootstrap plugin to 0.1.0-rc.31 (rebuilds a missing or stale egress proxy before use,
reports and rolls its device services on new files, an empty /run no longer reads as an outdated image) and
the plugins marketplace commit with the compose sandbox image build context to 2b69fe6 (sandbox images
0.1.0-rc.31: ripgrep in the sandbox image, egress proxy refusals reported with their reasons).
