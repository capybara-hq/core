---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

The composer's options sheet shows the model as one row that drills into a model page inside the
sheet (spec §6.59 "In-sheet drill-in"): above eight models a search field (model and provider
names), the current and the agent's default model first, a pick goes back to the options. The wide
model menu gets the same search and pinned group. `BottomSheetContent` takes `page` and `back`,
`SheetGroup` a visible `heading`, `SheetOption` a `tag` and a badge, `PickerItem` `pinned`.
