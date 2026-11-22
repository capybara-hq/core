---
"@capybara-hq/kernel": patch
---

The device projects routes answer `device.offline` (503) again when a dial-in device's machine
is not connected, instead of `device.projects_unavailable`.
