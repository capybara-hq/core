---
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-tools": minor
---

The UI routes serve component contributions: the contributions list carries `kind: "component"`
(listed with or without a server view), `ctx.ui.view` / `ctx.ui.action` accept ids in
`permissions.ui.components` and such a view is served like a view of its slot (the slot's role and
scope rule decide access). Only a component's view may carry `data` (a plain view's or action's
`data` is 502 `ui.invalid_view`). A tool's `ToolResult.card` may name a component card. The UI
arrangement gains `{ use }` for single slots (`shell.brand`, `conversation.empty`,
`conversation.composer.frame`): the org's entry, else the platform's, picks the winner; `use: null`,
no entry or a `use` naming a contribution not available in the org is the built-in. The
contributions list shows at most the winner of a single slot, and `GET …/ui/arrangement` lists a
single slot as `{ slot, candidates, use, followsPlatform }`. `use` on a list slot and `hidden` /
`order` on a single slot are 400 `validation_failed`. `capybara-plugin check` (`perm-ui`) accepts
component ids for `ctx.ui.view` / `ctx.ui.action`.
