---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/plugin-tools": patch
"@capybara-hq/capybara": patch
---

Remove the deprecated UI `place` key, `PLACE_SLOTS`, `UiPlace`, `slotRefOf` and `aliasOf` from the
plugin SDK: a UI contribution names its `slot`, which is now required. `resolveUiSlots` no longer
returns `deprecatedPlace`, and `capybara-plugin check` drops the `ui-place-deprecated` rule.
