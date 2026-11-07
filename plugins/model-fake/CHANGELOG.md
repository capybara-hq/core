# @capybara-hq/plugin-model-fake

## 0.1.0-rc.3

### Patch Changes

- 12fd552: Marketplaces list one entry per plugin. `plugin.json` `description` accepts `{ en, zh? }` as well as a string (English; read it with the SDK's `pluginDescription`), and marketplace entries accept an optional `displayName: { zh, en }`. `capybara-plugin marketplace --write` keeps one entry per public plugin at its current version, with `summary` from the localized description and `displayName` from `plugin.json`, replacing a plugin's entry when its version moves; `--check --base` replaces `marketplace-append-only` with `marketplace-version-decrease` (an entry's version only increases) and `marketplace-integrity` (a published version keeps its integrity). `capybara-plugin check` warns, without failing, when a public plugin's description has no `zh` (`release-description-zh`; findings may now be warnings). The kernel returns an entry's `displayName` (null without one) and searches it, and a single-plugin git marketplace takes the summary and display name from `plugin.json`; a catalog item keeps the English description. The market lists show the display name, else the name. model-fake gets a Chinese description.
  
  `--write` also refreshes a listed entry's `summary` and `displayName` from `plugin.json` (`marketplace-display-stale` in `--check`), and `marketplace-version-decrease` also fires when a plugin moves back to an older version a base in the older form lists. Catalog item views (admin and org) and the import review carry `descriptionZh` (the latest version's Chinese description, or null), and the plugin pages show the description in the UI language.
  
  Release order: release core and upgrade the deployed kernels before `capybara-hq/plugins` publishes
  plugins whose `description` is an object (older kernels reject it) and before the official
  marketplace drops older versions.
- Updated dependencies [f222ff8]
- Updated dependencies [2a12327]
- Updated dependencies [12fd552]
  - @capybara-hq/plugin-sdk@0.1.0-rc.3

## 0.1.0-rc.2

### Patch Changes

- 517ca1e: The deployment config fields carry zh and en form labels.
- 0f1507e: model-fake has a display name: 模拟模型 / Fake model.
- Updated dependencies [0ec51d1]
- Updated dependencies [8892d50]
  - @capybara-hq/plugin-sdk@0.1.0-rc.2

## 0.1.0-rc.1

### Patch Changes

- 72bada5: The scripted model provider accepts `tools:[{"name":…,"input":…},…]` to call several tools in one assistant message.
- Updated dependencies [8bf0b04]
- Updated dependencies [32580d3]
  - @capybara-hq/plugin-sdk@0.1.0-rc.1
