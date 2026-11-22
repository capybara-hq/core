---
"@capybara-hq/kernel": patch
---

The device sign-in token response now names the device (`deviceName`, null when it has none) and
the organization (`orgName`), so `capybara-device status` can show them.
