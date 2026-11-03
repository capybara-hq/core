---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
---

Config UI hints: `ui(schema, hints)` attaches presentation hints (labels, help, widgets, options,
sections, array items, presets, secrets drawn per item) to an extension config schema;
`configJsonSchema` turns a config schema into the JSON Schema for forms (`x-ui`, `x-secret`,
`x-hot`, titles from labels, no values under secrets) and `validateConfigUi` checks the hints.
`secret()` now merges with existing meta. `plugin.json` accepts `extension.configSchemas`. The
kernel's config JSON Schema now comes from the SDK (`hot` is emitted as `x-hot`).
