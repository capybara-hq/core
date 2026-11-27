---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/plugin-client": minor
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Full plugin pages contract: `ctx.ui.query`, the `usePluginQuery`, `usePageParams` and
`useNavigate` hooks, `frame` / `nav` on `org.page` components, the `params` prop of `org.page`,
new `UI_LIMITS` for queries and page params, and fake-host support in `/testing`.

`@capybara-hq/plugin-client` forwards the page templates (`ListPage`, `DetailPage`, `FormPage`,
`FormSection`, `SettingsPage`, `ActionRow`), data components (`DataTable`, `CellTitle`, `ItemList`,
`ItemListItem`, `Markdown`, `EmptyState`, `Avatar`, `PersonName`, `FilterChip`), inputs (`Input`,
`Textarea`, `Field`, `Tabs`, `Segmented`, `PrincipalPicker`), overlays (`Dialog`, `DangerConfirm`,
`Sheet`, `Menu`, `Popover`) and `Board`, with behaving stand-ins in `/testing`; the web host
prepends its scope crumbs to a forwarded template's `header.path`. The density of `Select`,
`Input`, `Segmented` and `FilterChip` is typed as the design's own steps.
