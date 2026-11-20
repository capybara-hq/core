---
"@capybara-hq/kernel": patch
---

The kernel logs (warn) why a device could not be asked for projects and why binding a device's
instance failed, so a device's own refusal is visible in the logs behind the generic 503.
