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

Compatibility (pre-1.0 ruling): a plugin packed by the new plugin-tools that declares config
carries `extension.configSchemas`, which an older kernel's strict section parser refuses
("unrecognized key") rather than through the SDK range. Kernel and plugins move together before
1.0, so upgrade the kernel before importing such plugins.
