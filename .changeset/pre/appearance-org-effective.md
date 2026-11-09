---
"@capybara-hq/kernel": patch
"@capybara-hq/plugin-sdk": patch
---

Applying a suggested appearance at org level reports `from` as the value in effect (the org's own
entry, else the platform's) with `followsPlatform`, and pins nothing when the org follows a
platform that already uses the suggestion. Replacements are listed and applied in plugin.json
order (recorded at import in `catalog_item_versions.appearance_order`, since the jsonb manifest
does not keep key order; the item detail and the org extension list show them in that order). A
second ref to one slot is skipped as `not-eligible`, and `parsePluginManifest` refuses it
(`shell.brand` and `shell.brand@1` in one `suggestedAppearance.replacements`).
