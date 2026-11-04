---
"@capybara-hq/plugin-tools": patch
---

`capybara-plugin check` reports `plugin-tool-key-length`: the key `plugin__<extension>__<tool>` of
every `ctx.tools.register` must fit in 64 characters (a name that is not a literal cannot be
confirmed, like `perm-tools`).
