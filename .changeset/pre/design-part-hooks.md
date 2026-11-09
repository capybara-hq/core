---
"@capybara-hq/design": minor
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/web": patch
---

Built-in elements carry the public `data-cap-part` hooks of the `UI_PARTS` catalog (`owner` is now a
list of files, since one part can be drawn by several components); the design package adds
`DecorationLayer`, `ReplaceableFrame` and `SafeModeBanner`, the `decoration` layering token,
`Sidebar` `brand` and `AppShell` `capState` (`data-cap-state`). `check:ui-parts` enforces the hooks.
