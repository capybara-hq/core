# Plugin full pages (L2)

Status: draft for review (2026-11-25). Companion to
`2026-11-25-collaboration-design.md`: the `collab` plugin's project list, board, item detail and
settings are L2 client components built only from design components re-exported by
`@capybara-hq/plugin-client` (*decided*: no iframe embeds). Calls marked *my call* are open to
review.

## 0. Why

Client extensions (spec `2026-11-09-client-extensions-design.md`) were built for decoration and
small panels. A plugin cannot build a real page with them today:

1. `plugin-client` forwards 14 basic design components (Badge, Button, Icon, Kbd, KeyValue, Logo,
   PropertySection, Select, Spinner, Stack, Switch, Text, Tooltip, ViewBlocks); no page template,
   table, tabs, dialog, empty state, avatar or picker.
2. The only read path is `useView()`: one server-rendered view of at most 32 KB
   (`UI_LIMITS.componentDataBytes`). A board of 200 items does not fit, and there is no per-request
   parameter. Extension HTTP routes accept personal API tokens only, never the browser session.
3. A component cannot read or set page parameters or navigate: `org.page` takes no args and the
   route `/p/<plugin>/<id>` has no query, so an item has no link.
4. There is no board component and no drag-and-drop library.
5. `/p/` wraps the component in `DetailPage`, so a plugin rendering a template nests two heads.
6. Plugin pages only appear under the sidebar's "More".
7. A plugin cannot show who a person is: no way to read names and avatars of accounts.

## 1. Goals and non-goals

Goals:

- A plugin page renders one design page template (list, detail, form, settings) itself, with the
  host's breadcrumbs.
- Components read plugin data by named queries with parameters, cached and invalidated like web
  pages, and write through actions with room for a form.
- Pages have query parameters and same-plugin links; components link to conversations.
- The design system gains `Board` (columns, cards, drag, keyboard, compact menu) and
  `PrincipalPicker` (people and agents), both forwarded.
- An org admin may put a plugin page in the primary navigation.
- Extensions read people's display data (`ctx.people`).

Non-goals:

- A rich Markdown editor (`Textarea` plus `Markdown` preview in `Tabs` is enough for now).
- Arbitrary routes or sub-paths under `/p/`; arbitrary URLs from `navigate`.
- Opening extension HTTP routes to the session cookie.

## 2. Page frame

An `org.page` contribution gains `frame: "host" | "page"` (default `host`, today's behavior).

- `host`: the web wraps the component in `DetailPage` as today.
- `page`: the web renders the component directly in the content area. The component must render
  exactly one forwarded page template (`ListPage`, `DetailPage`, `FormPage`, `SettingsPage`); the
  forwarded templates prepend the host's scope breadcrumbs (org, the plugin page's path label) to
  the `header.path` the plugin passes, so a plugin never builds them. In dev and tests the host
  throws when a `page` component renders no template or two (the same mechanism as
  `assertSectionGroups`).

## 3. Forwarded design components

Added to `plugin-client` (additive: `CLIENT_API_VERSION` stays 1; each gets a frozen minimal props
copy in `src/design.ts`, a fake-host stand-in, a `compat.tsx` fixture entry, and the web's
`host-api.ts` entry). The compat fixture also gains the missing `Select`.

| Kind | Names |
|---|---|
| Templates | `ListPage`, `DetailPage`, `FormPage`, `FormSection`, `SettingsPage`, `ActionRow` |
| Data display | `DataTable`, `CellTitle`, `ItemList`, `ItemListItem`, `Markdown`, `EmptyState`, `Avatar`, `PersonName`, `FilterChip` |
| Input | `Input`, `Textarea`, `Field`, `Tabs`, `Segmented`, `PrincipalPicker` (new) |
| Overlays | `Dialog`, `DangerConfirm`, `Sheet`, `Menu`, `Popover` |
| Board | `Board` (new) |

Props are the subset a plugin needs, not the design component's full props: no `className`,
`style`, or render props that reach host internals; callbacks receive plain data.

## 4. Data: queries and actions

### 4.1 Queries

Server, `ctx.ui.query(componentId, handler)` (component ids already declared in
`permissions.ui.components`):

```ts
interface UiQueryArgs extends OrgRenderArgs { query: string; params: JsonValue; signal: AbortSignal }
ctx.ui.query(id: string, handler: (a: UiQueryArgs) => Promise<JsonValue>): void;
```

Client:

```ts
function usePluginQuery<T = unknown>(query: string, params?: JsonValue, opts?: { staleMs?: number }):
  { data: T | undefined; status: "loading" | "ready" | "error"; error?: string; refetch(): void };
```

- Transport: `POST /api/v1/orgs/:orgId/ui/query/:plugin/:id` with the session (same guard as the
  existing UI action route: `@OrgAction("ui.use")`, a person, the contribution offered to them).
- Limits: params ≤ 16 KB, result ≤ 1 MB (`UI_LIMITS.componentQueryBytes` = 1 048 576), 10 s
  timeout, `signal` honored. Larger lists page through params.
- The web runs it as a TanStack query keyed `["plugin-query", plugin, id, query, params]`.
- `ctx.ui.invalidate({ orgId, contribution })` now also invalidates that contribution's queries
  (the same bus message), and an action result may name `invalidate: string[]` query names.

Why not open extension routes to the cookie (*my call*): routes are the plugin's own HTTP surface
for apps and tokens; a cookie there is a CSRF surface per plugin. The UI path keeps one kernel
door with one guard, the offered-contribution check, limits and timeouts.

### 4.2 Actions

`useAction` stays the write path. For components, the payload limit rises from 2 000 bytes to
64 KB (`UI_LIMITS.componentActionPayloadBytes` = 65 536) so a form (an item description) fits;
view block payloads keep 2 000.

## 5. Page parameters and navigation

- The route `/p/<plugin>/<id>` reads its query string; `org.page` props gain `params:
  Record<string, string>` and `usePageParams()` returns them (≤ 2 KB in total; longer is dropped
  with a console warning).
- `useNavigate()` returns
  `navigate(to: { params: Record<string, string | null>; replace?: boolean } | { page: { id: string; params?: Record<string, string> } } | { conversation: string })`:
  same page with new params, another page of the same plugin, or a conversation the viewer can
  open. No other targets.
- Inbox items (collaboration spec §4.9) a plugin posts may only link to `/p/<that plugin>/…`;
  the kernel refuses other links.

## 6. Board

A design component (spec entry in `docs/design/spec.md` §6, tokens, reference blocks, catalog
page, accepted visual), forwarded:

```ts
interface BoardColumn { id: string; title: string; count?: number; locked?: boolean; hint?: string }
interface BoardCard { id: string; columnId: string }
interface BoardProps<C extends BoardCard> {
  columns: BoardColumn[]; cards: C[]; renderCard(card: C): ReactNode;
  onMove(cardId: string, toColumnId: string, index: number): void | Promise<void>;
  canMove?(card: C, toColumnId: string): boolean; onOpen?(cardId: string): void;
  empty?: ReactNode; loading?: boolean;
}
```

- Pointer drag between and within columns; keyboard: focus a card, Space picks up, arrows move,
  Space drops, Escape cancels, with live-region announcements.
- A `locked` column (a gate) still accepts a drop; the plugin turns it into a request. The card
  shows the column's `hint` while hovering.
- Compact: columns scroll horizontally with snap; drag is off; each card has a "Move to…" menu.
- `onMove` returning a rejected promise snaps the card back.
- Library (*my call*): `@dnd-kit/core` + `@dnd-kit/sortable` as dependencies of
  `@capybara-hq/design` only (accessible, pointer and keyboard sensors, maintained); the native
  HTML5 drag in `Repeater` stays as is.

## 7. PrincipalPicker

A combobox that picks people and agents (one or many), with search, avatars, groups and a hint
line:

```ts
interface PrincipalOption { kind: "person" | "agent"; id: string; name: string; avatar?: AvatarValue; hint?: string; disabled?: boolean }
interface PrincipalPickerProps {
  options: PrincipalOption[]; value: string[]; onChange(ids: string[]): void;
  multiple?: boolean; placeholder?: string; groups?: boolean; onSearch?(q: string): void; loading?: boolean;
}
```

Built from `Popover` + the composer picker's list pieces; compact opens a bottom sheet.

## 8. People data: `ctx.people`

```ts
interface PeopleCtx {
  get(args: { orgId: string; accountIds: string[] }): Promise<{ id: string; name: string; avatar: AvatarValue | null; active: boolean }[]>;
  search(args: { orgId: string; query: string; limit?: number }): Promise<{ id: string; name: string; avatar: AvatarValue | null }[]>;
}
```

Permission `permissions.people: { read: true }`; members of the org only; no email or other
profile fields. (Added to the kernel plan's task C3.)

## 9. Navigation placement

- An `org.page` contribution may suggest `nav: "primary"` (default `more`).
- Org admins decide: org setting `navigation.pluginPages: { contribution: string; section: "primary" | "more" }[]`,
  edited on the org settings' navigation section; a suggestion applies until an admin saves a
  choice. At most 3 plugin pages in primary (*my call*), after the built-in entries.

## 10. Tests (outline)

- plugin-client: hooks contract tests with the fake host (`usePluginQuery`, `usePageParams`,
  `useNavigate`), compat fixture for every forwarded component, red twins for a drifted prop.
- Kernel: query route guard (non-offered contribution 404, service token refused, oversized
  params 413, timeout), invalidation reaching queries, inbox link refusal.
- Design: Board pointer and keyboard moves, locked column, compact menu, rejected move snaps back;
  PrincipalPicker search and multi-select; catalog pages and accepted visuals.
- Web: `frame: "page"` renders without `DetailPage` and asserts one template; params round-trip;
  navigate refuses foreign targets; nav pins.
- Fixture `fake-client-page` in `@capybara-hq/testing` exercising all of the above.

## AGENTS.md rules touched

- **Extension UI:** components gain a query path (`ctx.ui.query`, `usePluginQuery`), page params
  and navigation, and the `frame: "page"` mode; embed tokens are still never valid for `/api`.
- **Web UI:** a plugin page renders exactly one forwarded template; one box rule applies to plugin
  pages as to web pages.
- **Public API reports:** `plugin-client` and `plugin-sdk` reports change; changesets on both.
- **Platform tool:** the query route is a transport exclusion (the web's channel for plugin
  components; agents use the plugin's tools).
- **Extensions:** new `ctx.people` and permission key `people`.
