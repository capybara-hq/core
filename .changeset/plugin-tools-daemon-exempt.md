---
"@capybara-hq/plugin-tools": patch
---

`capybara-plugin check` skips the timer and module-state rules for the plugin-root `daemon/`
directory (device service code), unless the server bundle reaches those files.
