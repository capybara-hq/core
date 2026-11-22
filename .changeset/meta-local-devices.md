---
"@capybara-hq/kernel": patch
---

`GET /api/v1/meta` reports `features.localDevices` only while a dial-in provider speaking
`capybara-device/<major>` (device-local) is loaded, and takes `protocols.device` from that
provider's declared `permissions.dialIn.protocol`.
