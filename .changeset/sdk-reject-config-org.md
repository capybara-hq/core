---
"@capybara-hq/plugin-sdk": patch
---

`defineExtension` refuses any `config` key other than `deployment`; a leftover `config.org` gets
"config.org was removed: move org fields into config.deployment".
