---
"@capybara-hq/plugin-tools": minor
---

The packer writes an extension's config schemas into `plugin.json` as `extension.configSchemas`
(`configJsonSchema`, with the `x-ui` hints) and refuses invalid hints, including `options` /
`presets` on a secret. `capybara-plugin check` gains "Config forms" (`plugin-config-ui`,
`plugin-config-labels`: a published plugin labels every rendered config field in zh and en) and
`release-display-name` (a published plugin's `plugin.json` needs `displayName`).
`importPluginExtension`, `extensionConfigSchemas` and `missingConfigLabels` are exported.

Compatibility (pre-1.0 ruling): a plugin packed by this version that declares config carries
`extension.configSchemas`, which an older kernel refuses ("unrecognized key" from its strict
section parser) rather than through the SDK range. Kernel and plugins move together before 1.0,
so upgrade the kernel before importing plugins packed by this version.
