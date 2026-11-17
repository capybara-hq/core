---
"@capybara-hq/kernel": patch
---

The kernel config is strict: an unknown key anywhere in the file, Nacos or `CAPYBARA_*`
environment variables fails startup with `unknown config key <path>` instead of being dropped.
