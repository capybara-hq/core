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

The web renders full plugin pages: an `org.page` component with `frame: "page"` draws its page on
`/p/<plugin>/<id>` without the host's DetailPage and must render exactly one forwarded template
(dev and tests throw, production logs once); its params come from the query string (2 048 bytes),
`useNavigate` changes them or opens another page of the plugin or a conversation, and
`usePluginQuery` reads through the query cache, refetched on `ctx.ui.invalidate` and an action's
`invalidate`. The host drops links in forwarded components other than same-origin paths and
http(s) URLs. The contributions list names a component page's `frame`. The `/testing` DataTable
stand-in draws `empty` / `noResults` and its `state`.
