---
"@capybara-hq/capybara": patch
---

The kernel never proposes a sandbox approval for the new device deny entries (mise's config
directory and home config files, Maven and Gradle credential files): it reads them from
`DEVICE_DENIED_SECRET_PATHS` in the plugin SDK.
