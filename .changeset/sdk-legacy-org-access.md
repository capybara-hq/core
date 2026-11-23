---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/plugin-tools": patch
---

Plugin modules packed before core#720 load again on a kernel from main. `orgAccess(schema, access)`
and the `OrgAccess` type are back as deprecated no-ops (the schema is returned unchanged, both
levels are ignored: the field stays overridable unless marked `platformOnly`), and
`defineExtension` drops a `config.org` key instead of refusing it (the manifest keeps only
`config.deployment`; other unknown `config` keys still throw). `capybara-plugin pack` and the
checks that import the module still refuse `config.org`. Temporary: removed in core#720 plan
Task 17 once the official plugins are republished.
