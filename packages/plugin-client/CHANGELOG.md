# @capybara-hq/plugin-client

## 0.1.0-rc.11

### Patch Changes

- b43b201: The packages ship their public API reports: `api/plugin-client.api.md` and
  `api/plugin-sdk.api.md` are now in the published files.

## 0.1.0-rc.10

### Minor Changes

- 6332845: Full plugin pages contract: `ctx.ui.query`, the `usePluginQuery`, `usePageParams` and
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

## 0.1.0-rc.9

### Patch Changes

- 855e6d9: The conversation's properties panel reads more calmly: the Context section lays out labeled rows
  (model, device with its mark under it, connectors, last run, total with sub-agents) instead of
  dot-joined lines, and the last run no longer repeats the model when it is the current one. A
  property section can carry a hint behind an info button with a tooltip (Background tasks' note on
  the permissions running work keeps moves there). The right panel can be narrowed to 360 (was 520).
  The client API forwards the design system's `Switch` (`checked`, `onChange`, `label`, `disabled`),
  with a `role="switch"` stand-in in `@capybara-hq/plugin-client/testing`.

## 0.1.0-rc.8

### Patch Changes

- a938c37: The composer exposes its pieces as UI parts: `composer.box` (the text with ＋ and send; the
  floating pill in the mobile form, `:focus-within` while one of them has focus, never for the control
  row), `composer.options` (the mobile settings chip) and `composer.send` (send, and stop in its
  place). The pill is now that real element instead of the frame's `::before`, so a theme's frame,
  corners and run effects can follow it without enclosing the chip row; the control row sits outside
  it (the DOM order is the text, ＋, send, then the row). In the mobile form send keeps its place at
  the pill's end when the agent picker above it is wider. `Button` and `IconButton` let a caller's
  `data-cap-part` name the control too.

## 0.1.0-rc.7

### Minor Changes

- e39c372: Add `useSizeClass` and `useViewportSegments` to the plugin client (the window's size class and the
  two segments of a folded display, read from the host). The kernel lists each contribution's compact
  form (the slot's, narrowed by the contribution's), and the web does not draw a `hidden`
  contribution on a compact screen.

### Patch Changes

- b6339e3: The `shell.brand` host's `panel` is `"full" | "rail"`: the sidebar has no drawer form any more.

## 0.1.0-rc.6

### Patch Changes

- 45ff51f: New UI part `image-placeholder` (`aria-busy`): the placeholder the conversation draws while an
  image is being generated. The design package adds `ImagePlaceholder` and an `ImageOutput.ratio`
  pre-load hint.

## 0.1.0-rc.5

### Patch Changes

- 188af9d: A confirmed plugin import stops reading the staging it consumed (the error card that flashed before
  the navigation landed); an extension component asks for its view after mount, not from its render;
  extension pages draw no single-tab bar; the client API forwards the design system's `Select`, so a
  client component offers a plugin's choices in the product's own dropdown rather than the browser's;
  switching a plugin back on takes back the connector an earlier switch-off kept for agents instead
  of creating a second one (which failed on the slug); a connector slug may equal an installed
  extension's name (their tool keys stay apart, `mcp__` against `plugin__`), so a template whose
  default slug is its plugin's name (slack, github) configures as it is; a default-off connector
  template an admin switched on in the org asks for its input at install, as the install is what
  creates its connector (before, the wizard hid the fields and the install refused).

## 0.1.0-rc.4

### Minor Changes

- 6a4ffff: New UI parts for theme plugins: `message.user.bubble`, `code-block`, `menu`, `segmented`,
  `stat-card`, `switch` (`aria-checked`) with `switch.knob`, `org-avatar` and `agent-chip`
  (`aria-pressed`); `message.assistant` promises `aria-busy` while its text streams, and the web sets
  it on the live reply. `UiPartState` gains `aria-checked` and `aria-pressed`.

## 0.1.0-rc.3

### Minor Changes

- a49c72e: Client code can do something once per sign-in: `useSignIn()` and `ClientApi.signIn` carry an
  opaque id that stays the same for one sign-in and changes on the next one (a different string per
  plugin, not a secret between plugins).
  The kernel's client shell reads return it per item (`signInId`, a keyed hash of the session, never
  the session id) and the web host hands it to plugins; the fake host takes `signInId`.

## 0.1.0-rc.2

### Patch Changes

- abab378: `ClientComponent` without a type argument is now the union of the single-slot bindings, so a
  `defineClientExtension({ components })` map of components bound to different slots type-checks
  under `strict` without a wrapper. The `shell.brand` props gain `panel` (`"full" | "rail" |
  "drawer"`), the sidebar panel the brand is drawn in.

## 0.1.0-rc.1

### Minor Changes

- e6bff6e: New package: the client SDK for plugin UI components (`defineClientExtension`, `defineComponent`,
  the hooks, the design re-exports and `@capybara-hq/plugin-client/testing`).
- e531e6d: The SDK exports `UI_PARTS`, the catalog of built-in elements (`data-cap-part`) plugin CSS may
  select; `capybara-plugin check` reports `ui-part-unknown` against it.

### Patch Changes

- a4df9fd: `ClientExtension.apiVersion` documents what it holds in a browser (the host's version, stamped by
  the host's `defineClientExtension`) and that the kernel's delivery gate is the real check.
