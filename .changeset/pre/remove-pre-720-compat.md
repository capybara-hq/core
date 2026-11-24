---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
---

Remove the transition compatibility for plugins packed before core#720. The deprecated no-op
`orgAccess` / `OrgAccess` exports are gone. `defineExtension` now throws on `config.org`, the
plugin.json reader refuses `extension.manifest.config.org` and `extension.configSchemas.org`, and
the kernel no longer drops `config.org` from a stored reviewed section. Repack a plugin built before
core#720 (or install its current release) before upgrading.
