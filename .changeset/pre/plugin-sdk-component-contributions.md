---
"@capybara-hq/plugin-sdk": minor
---

Component contributions: `kind: "component"` in the manifest `ui`, listed in the new
`permissions.ui.components`, which needs the new `permissions.client: true`.
`validateUiContributions` checks both directions, refuses an id in more than one of
`views` / `embeds` / `components` and a component with a `path`. `UiView` gains `data` (a
`JsonValue`), accepted only by `validateUiView(view, { component: true })`, at most
`UI_LIMITS.componentDataBytes` (32768) bytes of JSON.
