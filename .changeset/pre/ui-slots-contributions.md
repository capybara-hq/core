---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
---

UI contributions name a slot (`slot: "conversation.panel"`, optionally `@<n>`, plus `after` for
slots with anchors); `place` stays accepted as a deprecated input. `validateUiContributions` now
covers only structural problems, and the new `resolveUiSlots` drops a contribution to an unknown
slot or version instead of failing the extension. `normalizePlace` is removed.
