---
"@capybara-hq/plugin-sdk": patch
---

`defineExtension` refuses any `config` key other than `deployment`; a leftover `config.org` gets
"config.org was removed: move org fields into config.deployment".

Until the official plugins are republished, `parsePluginManifest` still reads plugin.json files
packed before this change: a legacy `extension.manifest.config.org` list is accepted and dropped
(the parsed manifest has no `org`). Nothing else reads it.
