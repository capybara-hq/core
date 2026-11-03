---
"@capybara-hq/plugin-tools": minor
---

The packer writes an extension's config schemas into `plugin.json` as `extension.configSchemas`
(`configJsonSchema`, with the `x-ui` hints) and refuses invalid hints, including `options` /
`presets` on a secret. `capybara-plugin check` gains "Config forms" (`plugin-config-ui`,
`plugin-config-labels`: a published plugin labels every rendered config field in zh and en) and
`release-display-name` (a published plugin's `plugin.json` needs `displayName`).
`importPluginExtension`, `extensionConfigSchemas` and `missingConfigLabels` are exported.
