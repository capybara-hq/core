# @capybara-hq/design

## 0.2.0-rc.56

### Patch Changes

- 9bb13fa: The composer's agents chip reads 「N 个智能体」 / "N agents" alone, as Claude Code's "● 3 agents": the
  running count is no longer drawn, and the leading dot carries the state (the running accent while a
  sub-agent runs, warn while one waits, faint once all have finished). Its accessible name and
  tooltip keep the counts.
  
  The agent map follows one colour rule for every status dot (tree, level 2 head, legend, Agent call
  block, chip): running accent, waiting and limit warn, completed faint, stopped a hollow faint ring,
  failed fail. Its count line drops the running count (「N 个智能体 · 点击查看详情」), and a node names
  its model only on the root or where it differs from the root's.
- 84fb1df: Desktop shell: the band search field opens the command palette again. It now renders after the
  content column, so the paper gutter and head drag fillers no longer cover it (#1120).
- 7b6565d: Cap square agent avatar border-radius at 25% (`min(var(--cb-radius-sm), 25%)` / `min(var(--cb-radius-md), 25%)`) so compact/touch radius scaling keeps agents distinct from circular person avatars at small sizes.
- f93197e: Composer: a Lexical-based `ComposerEditor` with inline tokens (connectors, resources, files,
  project files, conversations, skills) and the presentational `InlineToken`, standalone for now;
  the composer box moves onto it in a later change.
- af0ec96: Composer frame: one even `space.2` inset (the field is the box; ＋, send, the attachment strip and
  the text no longer pulled into its padding), and from 600 with a fine pointer the place (device and
  project) moves out of the input into a `hover` tray above it, which the field overlaps; the pickers
  lose the "/" separator and get a pill ground only on hover. On touch, send is concentric with the
  pill's round end. The UI part `composer` (and its `aria-busy`) is now the field, the box: the place
  tray and the open menu sit outside it, in the frame.
- 12a20da: Web: an extension embed (such as the browser panel) no longer flashes white when it opens in the
  dark theme. The frame stays hidden until its document has loaded and no longer inherits the dark
  color scheme, so the browser keeps the embed's canvas transparent instead of painting it light.
- 4894752: The composer switches to inline tokens: everything picked through `/` or `@` (a skill, a
  connector, a connector resource, a library file, a conversation) and ＋ 项目文件 picks stand in the
  sentence as tokens, while uploads stay cards. `@` lists the agent's connectors first (→ opens a
  connector's resources), then files and conversations; ＋ loses 连接器资源 and its connector rows
  insert a token. At most one skill per message. A message goes out as `text` with one U+FFFC per
  token and its `tokens`; a refusal marks the token and offers 移除. Bubbles draw a message's tokens
  from `payload.inline`, the skill chip first. The design adds `openTrigger` / `setTriggerQuery` to
  the editor's handle and a `@capybara-hq/design/testing` entry with the editor's test drivers;
  `FileDrop` leaves a paste a child already took alone.
  A sent bubble's conversation token links to its conversation and a library file token opens the
  file; a connector prompt picked mid-sentence goes where its `/` stood.
- a0e1dfd: Page heads: a head whose tabs are routes stands at its first tab's level on every tab, so a tab's
  own route (such as the admin 模板, 市场 or 待确认 tabs) no longer shows a path row its sibling tabs
  do not (`headPath`). Path segments are now place names (管理后台 / 连接器 / 模板) instead of URL
  slugs. In the desktop shell the strip above a first-level page's title drags the window too.

## 0.2.0-rc.55

### Patch Changes

- a38800d: Desktop shell: with window controls on the end side, a first-level page's head (the large title,
  its actions and the tabs) stays in the paper below the top-row band instead of sitting in the band
  beside the caption buttons; the band holds only a path row and the panel toggles, as on macOS. Any
  ground band (the macOS rail-form band and the end controls' band) now holds a search field at the
  window's centre that opens the command palette; the sidebar's search button gives way while it
  shows. Not on a conversation, and hidden where it does not fit.

## 0.2.0-rc.54

### Patch Changes

- 854f600: Desktop shell: window controls reported on the end side (the Windows / Linux caption overlay) now
  get a top-row band of ground in every sidebar form from 600 up. The paper's first row sits in it
  beside the caption buttons, and the papers start below it with one top edge, so the buttons no
  longer lie over the paper's corner and the paper does not jump when the right panel opens. In both
  bands (this one and the macOS rail-form band) the paper now starts at the controls' bottom edge, so
  the row's icons sit as far above the paper as below the window's top.

## 0.2.0-rc.53

### Patch Changes

- 87d22ce: Light cards step toward the middle (layered shell rule 3): `panel` `#F9F8F5`, `panel-2` `#FBFAF8`,
  light `fail` `#C42E28`; menus, dialogs, sheets, the palette, tooltips and toasts sit on `raised`; a
  new `field` token (white in light, clear in dark) grounds inputs, selects, textareas, steppers, the
  segmented track and checkbox / radio boxes. The theme token report gains `field` and the new
  contrast and separation pairs. A theme scheme that recolours `panel` without naming `field` keeps
  clear fields (`themeSchemeFallbacks`, used by `mergeThemeSchemes` and the kernel's theme stylesheet).
- 476dfaa: Desktop shell: in the rail form the paper's colour now starts below the top-row band, so the macOS
  traffic lights and the band's sidebar toggle sit on the ground instead of overlapping the paper's
  corner; the conversation title bar or a deeper page's path row stays in the band after the toggle.

## 0.2.0-rc.52

### Patch Changes

- b43b201: A client component in `conversation.properties.section` that renders nothing (returns `null`)
  no longer leaves an empty titled section: the host draws the section only while the component
  renders a node, checked after every commit before paint. A component panel whose component
  renders nothing shows the panel's empty state instead of a blank pane. Design: `PropertySection`
  takes `hideWhenEmpty`, `RightPanel` takes `emptyText`.

## 0.2.0-rc.51

### Patch Changes

- 34d7dab: Composer menus phase B: the composer's top strip holds the device and project pickers (one
  「device / project」 sheet on phones, the project picker disabled while its projects load), the
  control row carries ＋, the mode menu, the model with its effort and send, and the @ menu lists
  library files (最近文件 / 匹配的文件) with 文件库 in the ＋ menu.

## 0.2.0-rc.50

### Patch Changes

- 6cb1d98: Board: a kanban board of columns and cards (spec §6.69): pointer drag between and within columns,
  a keyboard model by position (Space picks up, arrows move, Space drops, Escape cancels) spoken in
  a live region, locked columns that still take a drop and show their hint, refused drops, a
  rejected move snapping back, and the compact form with a Move to… menu per card
- 24a4312: PrincipalPicker: a combobox that picks people and agents, one or many (spec §6.70): search by name
  with an `onSearch` callback, People / Agents groups, avatars and hint lines, disabled options,
  empty and loading lines, and a bottom sheet on the compact class
- 19b28a9: Org admins put plugin pages in the primary navigation: the sidebar and the compact drawer take
  `primaryExtensions` (after the built-in entries), the web places each page by the admin's saved
  choice, else the plugin's `nav` suggestion (at most 3 primary), and the organization settings get a
  Navigation page (导航) to choose. Component queries show their own error messages
  (`errors.ui.query_*`).

## 0.2.0-rc.49

### Patch Changes

- 92469e2: Adds `ComposerMenu` (anchored above the composer, a bottom sheet on compact) and `ProjectFilePicker`;
  checkboxes stay square at every size and `Input` takes its line height from the control.

## 0.2.0-rc.48

### Patch Changes

- 7238964: Watched input waits (plugins#207, browser long waits spec): an extension tool's `InputRequired`
  may carry `watch: { deadlineMs }` and its registration a watcher (`ctx.tools.register(spec,
  handler, { watch })`, `ToolWatcher`). The kernel parks the run as a question (no model turns, no
  worker held) and polls the watcher every 10 s on the new `cap-kernel-tool-watch` queue; a settle
  wakes the question (new status and card state `woken`), and `ctx.resume.outcome` tells the handler
  how the round ended (`answered` / `woken` / `expired`). `ctx.deviceAccess.request` gains
  `ifRunning` (`DeviceAccessError` `not_running`), forced for watchers, which never resume or start
  anything. New config `tools.watchConcurrency` and `tools.maxWatchedWaitsPerAccount`; a watched
  wait skipped by a message reads `WAIT_SKIPPED_TEXT`; the web draws a wait card with one end button.
  The testing package gains the `fake-watch` fixture.

## 0.2.0-rc.47

### Patch Changes

- aa535be: Images in tool results reach the agent and the person. The pipeline stores every image block a
  tool returns (a browser screenshot, an MCP image) as a copy of the conversation and names it in the
  result (`file_id`); a model with vision sees it after the step's results, a model without vision is
  told it was not shown and how to read it, and an image that cannot be stored says why. The web
  shows the images as thumbnails on the call's row (opening the image viewer), and `Deliver` takes a
  `file_id` to hand such an image (or any attachment or artifact of the conversation) to the person
  without a device.

## 0.2.0-rc.46

### Patch Changes

- a66a83a: Network asks for extension service calls (browser use spec §7.1): hosts a device service reports
  refused during a tool call (the call scope) raise a network ask in the call's conversation, offering
  only "add to this device's list"; approving widens the device allowlist and runs the call again. The
  ask is recorded under the call's tool key; the web and IM cards name the agent's browser and say
  that open network mode stops the asks.
- 6034178: Adds the `globe` icon.

## 0.2.0-rc.45

### Patch Changes

- 76f58f0: A background Bash start the kernel sent but could not confirm (a transport loss) no longer shows as
  failed in the thread while the kernel reconciles it. Its result keeps the same error text for the
  model and adds the display-only `launch_unconfirmed` view; the background tasks list gains
  `starting`, and reconciling a start announces `changed: background`. The row reads "正在确认是否已启动"
  / "Confirming whether it started" until the task is confirmed running or ends, and becomes a
  failed row only when the launch is given up, revoked or refused (#790).

## 0.2.0-rc.44

### Patch Changes

- ab71de9: The plugin enable wizard opens on a 选择连接器 / "Choose connectors" step when the plugin has more
  than one connector template or a default-off one: every template with its icon, name, description
  and a mark saying what its step needs (nothing, an OAuth client, an address, a credential). Default-on
  templates start checked, default-off ones unchecked, one the org already has a connector for is kept
  (locked on); only checked templates get a step and a connector. The org install body
  (`PUT …/catalog/:itemId/switch` inputs, `POST …/catalog/:itemId/install`) takes `templatesOn`: the
  template ids to switch on with the install; the plugin's other templates are switched off in the org
  (audited `component.org_switched`) and stay available on /connectors. Unknown, disabled or not offered
  ids are refused (`validation_failed` at `templatesOn`); absent keeps the templates on in the org now.
  The Platform operation `plugins.install` takes `templatesOn` too. The design `CheckList` row takes an
  optional `mark` (a 24 px mark tile before the name).

## 0.2.0-rc.43

### Patch Changes

- 855e6d9: The conversation's properties panel reads more calmly: the Context section lays out labeled rows
  (model, device with its mark under it, connectors, last run, total with sub-agents) instead of
  dot-joined lines, and the last run no longer repeats the model when it is the current one. A
  property section can carry a hint behind an info button with a tooltip (Background tasks' note on
  the permissions running work keeps moves there). The right panel can be narrowed to 360 (was 520).
  The client API forwards the design system's `Switch` (`checked`, `onChange`, `label`, `disabled`),
  with a `role="switch"` stand-in in `@capybara-hq/plugin-client/testing`.

## 0.2.0-rc.42

### Patch Changes

- 4323bd1: Form sections stand in two columns only when the page has three or more; one or two stack (the
  template decides from its section count). The device page merges its network tab into the
  overview (about, network, recent changes and files as sections, then the danger zone); projects
  stays its own tab, stacked.

## 0.2.0-rc.41

### Patch Changes

- 479c8a2: The composer's options sheet shows the model as one row that drills into a model page inside the
  sheet (spec §6.59 "In-sheet drill-in"): above eight models a search field (model and provider
  names), the current and the agent's default model first, a pick goes back to the options. The wide
  model menu gets the same search and pinned group. `BottomSheetContent` takes `page` and `back`,
  `SheetGroup` a visible `heading`, `SheetOption` a `tag` and a badge, `PickerItem` `pinned`.

## 0.2.0-rc.40

### Patch Changes

- e44ecab: Toasts: a touch swipe up dismisses on compact, a swipe down from 600 wide as before.

## 0.2.0-rc.39

### Patch Changes

- 5bbe04b: Back on compact no longer traps the person on a section's first page. Without an in-app history
  entry behind the page, back went to the last linked path segment, which on `/account/profile`
  (and `/settings/organization`) is the page itself: a link to the same address replaces the entry
  and changes nothing, so back never left. Back now skips a segment that links to the current page.
  
  Settings sub-nav items and link tabs are sibling views of one page: switching between them now
  replaces the history entry instead of pushing one, so back leaves the page rather than retracing
  every switch. `LinkComponent` takes an optional `replace`.
- 6a50bf4: Compact: the quick-return bar (and the settings sub-nav) docks right under the top row again
  instead of leaving a row-high gap the list shows through; a toast no longer stops the desktop top
  row from dragging the window; toasts on compact sit at the top under the top row, slide down and
  are dismissed by a swipe up (maintainer decision 2026-11-23).

## 0.2.0-rc.38

### Patch Changes

- bda4e7b: The super admin pages follow the responsive system. The admin views' choices (the owner filter of
  the template lists and the like) are scopes, and the super admin lists page through their list
  (`onLoadMore`) instead of loading everything at once.
  
  `ItemList` pages: `onLoadMore`, `hasMore`, `loadingMore` and `loadMoreError` draw the Load more row
  at its end.
  
  The `SCOPE_PENDING` and `LOAD_MORE_PENDING` allowlists of the guards are gone: `check:web-ui` now
  fails a `Segmented` / `Tabs` inside `ListPage.filters` and a Load more row drawn by a page.
  
  Sizing audit: three super admin pages (a list, a detail and a form) join the responsive visual
  matrix, with the 44 px hit-size and no-horizontal-scroll checks at 390.

## 0.2.0-rc.37

### Patch Changes

- 14978b9: The new conversation's composer in the mobile form sits at the window bottom (space.3 over the
  safe-area inset, as the conversation's), no longer over an empty ~128 px band: the thread's reserve
  for the floating composer applied to the new conversation's scroll too, whose composer is inside it.
- a938c37: The composer exposes its pieces as UI parts: `composer.box` (the text with ＋ and send; the
  floating pill in the mobile form, `:focus-within` while one of them has focus, never for the control
  row), `composer.options` (the mobile settings chip) and `composer.send` (send, and stop in its
  place). The pill is now that real element instead of the frame's `::before`, so a theme's frame,
  corners and run effects can follow it without enclosing the chip row; the control row sits outside
  it (the DOM order is the text, ＋, send, then the row). In the mobile form send keeps its place at
  the pill's end when the agent picker above it is wider. `Button` and `IconButton` let a caller's
  `data-cap-part` name the control too.
- 5f10f47: The org admin pages (settings members, tokens, schedules and audit, extensions, trajectories, evals)
  use the responsive compact rows, and join the responsive visual matrix.
  
  The conversation list counts its matches only when asked (`withTotal=true`, first page), so the
  compact drawer's 30 s poll no longer pays for the count.
  
  DataTable columns can be `compactOnly`: drawn only in the compact grouped rows, never in the wide
  table.

## 0.2.0-rc.36

### Patch Changes

- b8588c5: Responsive system, phase 1: the member pages (schedules, the account tables, skill detail) draw
  compact grouped rows below 600, and every action a row offers is reachable on its detail page.
  Conversation rows carry their agent and the list an exact total (kernel API and web). Dialogs keep
  their state across the 600 boundary, and every compact CSS block uses the ClassForms query.

## 0.2.0-rc.35

### Patch Changes

- c6935ea: Mobile interaction model (#606): on compact, dialogs and danger confirmations are bottom sheets
  (close or 取消 focused first, a fixed footer, typed names kept) and a Select opens a picker sheet
  (searchable over ten options); toasts sit at the bottom, one at a time, and a queued toast's timer
  starts when it is shown; a focused field scrolls above the keyboard and bottom sheets rise with it;
  compact lists load the next page as their end comes into view (`onLoadMore`, `hasMore`,
  `loadingMore`), with a retry row on error; a long press that opens an action sheet plays a light
  haptic; pull to refresh on the inbox, the conversations page and the drawer's recents in the mobile
  app only. On the iPhone Duo the strip pill carries the page's primary (else 新会话), 对话 opens the
  conversations page, the avatar opens the account sheet (with 技能、连接器、设备…), sheets stay
  inside the strip's inset and the drawer drops the pill's entries. New checks keep overlays and sheet
  rows design primitives, `useNative` out of pages, Dialog footers flat and Load more rows out of
  pages.

## 0.2.0-rc.34

### Patch Changes

- 6d54a3a: The templates take their compact forms (responsive system phase 0, second part). Below 600 every
  `ObjectList` is one grouped list of rows: a row that opens something shows no buttons, ends in a
  chevron and opens its actions in an action sheet on a long press or right click, and a row that
  opens nothing keeps its one button and a labelled ⋯. The page head is the compact head (no path
  row, a large title with its count, the primary as a block or head button, the secondaries in the
  shell's "…", full-width search and a segmented first-level tab row). Every pushed template is one
  scroller with a title that scrolls away and a quick-return search bar, and the compact ListPage
  draws a scope chip row, a floating primary and restores its scroll position. The workspace
  agents page uses the typed list scope instead of a segmented control in its filters.

## 0.2.0-rc.33

### Patch Changes

- 6a0c32f: Responsive system, system pieces (#605): `ClassForms` / `useClassForm` render a structure per size
  class (both on the server, CSS shows one, only the matching one stays mounted after hydration);
  the `ActionSheet` uses the native `menu@1` sheet on compact when it holds no links; card grids are
  one grouped list of rows below 600 (no buttons, long press or right click opens the card's actions);
  DataTable columns may declare `compact` roles (title, subtitle, meta, trailing, hidden) and are
  then drawn as grouped rows below 600; `Tabs look="segmented-compact"`; `ShellPage.actions` and
  `titleAway` with the centred scrolled title, and `useCompactScroll` for one-scroller pages. New
  checks keep size-class reads out of pages, view choices out of `ListPage.filters`, template-only
  props in templates and dual renders in `ClassForms`.

## 0.2.0-rc.32

### Patch Changes

- db8935e: The compact drawer follows the approved mockup: a search field and a 新会话 button at the top, the
  navigation as one grouped card (收件箱 with its count, 智能体, 定时任务, 更多), 最近会话 with 全部
  over the newest conversations by time (not grouped by agent, each with its agent, state and time;
  a long press or right click opens rename / archive / delete), and the account as one row at the
  foot. The conversations page lists conversations by time in day sections (今天 / 昨天 / 本周 /
  更早) with a search and a chip per agent, reads the next page as the end nears (no Load more rows)
  and offers each row's actions in an action sheet; on compact the page's primary is a floating
  action button (the head's primary restyled by CSS). New design pieces: `ConversationList`,
  `ActionSheet` with `useLongPress`, `ScopeChips`, `ListPage.scope`, `formatListTime` / `dayBucket`.
- a0e48a2: Pages outside the theme (#451): the kernel-starting frame, the root error pages and the root 404
  draw the theme this browser last drew (the `cb-brand` cookie, else the platform default); app
  icons and the manifest colours follow the platform default theme; the browser's theme colour
  follows the scheme shown (design `useThemeColorMeta`).
- 599ed63: One bottom sheet look (spec §6.59, maintainer decision 2026-11-22): a 52 high head with no
  hairline, the title centred and a 30 px round close on a fixed ground at the body's 14 px inset,
  its 44 px hit area an invisible ring, so nothing paints on open; shared body parts (`SheetGroup`,
  `SheetRow`, `SheetFootnote`). The account sheet is regrouped: a profile row that opens Personal
  settings, 组织 with the current org (a menu with several), 语言 and 外观, sign out alone, the
  status line as a footnote. `AccountSheetData` takes `orgMenu`, `language: { value, label, items }`
  and the theme switch's data instead of slots.
- 2c28141: An org's default theme can now shape the agent avatar choices: it may hide built-in presets and add presets of its own. The kernel lists them in `GET /orgs/:orgId/themes` (`avatars`), accepts a theme preset key on create and update (stored pinned to the theme version, `agent.avatar_unavailable` when the org does not offer it), and draws the random default from the visible choices. `AvatarPicker` gains `hidden` and `extra`, and the web create form, template flow and basics section follow the org's choices.
- 7a8e816: Theme brand graphics (#451): the empty state, the greeting and the working line draw the theme's
  mark or illustration (the empty-state art as a mask in the faint colour), a theme can turn the
  sign-in decoration off, and a theme mark that fails to load falls back to the pixel capybara.

## 0.2.0-rc.31

### Minor Changes

- 19d5e1a: The product name people see follows `platform.name` (unset: Capybara) everywhere, not only in the
  document title and the web app manifest (issue #452).
  
  - Kernel: the IM bot's bind and web-hint phrases, the OAuth dynamic client registration name, the
    session user agent of desktop and mobile sign-ins, the `<name>:` prefix on git gateway messages,
    the platform overview the model reads, and the attribution defaults
    (`Co-Authored-By: <name> <noreply@capybarahq.com>`; the pull-request line links the upstream
    project only under the default name). The official marketplace is now named "Official
    marketplace", and messages that named the software in passing say "the platform".
  - Web: every message that named the product takes the platform name from the public meta,
    including the sign-in, binding, invitation and app consent pages. Pages that cannot
    read the kernel (the root error page, a starting kernel) say the built-in name. `check:i18n`
    rejects the literal "Capybara" in web messages (`i18n-product-name`).
  - Design: `Brand` gains `productName`, the `alt` of a theme's logo mark (else the wordmark, else
    "Logo"). The built-in `CAPYBARA` wordmark stays beside the pixel capybara whatever the name.

### Patch Changes

- fabb3e7: Markdown is parsed with the CommonMark CJK-friendly emphasis amendment
  (`micromark-extension-cjk-friendly`): `按**「框架」**来`, `**（注意）**这里` and `~~「旧」~~` render as
  strong and strikethrough instead of literal asterisks, in conversations, file previews, skill docs and
  other rendered Markdown.
- 4bb6105: Compact: the floating back button no longer pauses about half a second before its transition. The
  back settles as soon as the shell commits the route it landed on (or on the task after its
  `popstate` when no route changed) instead of waiting for a frame the browser does not render while
  a view transition's update is pending.
- 071db76: Compact: the floating back button no longer slides the page in twice. A pop the back button
  animates with a view transition sets no CSS slide on the shell's main region, so the slide does not
  run again once the transition ends.
- 582c029: Controls take the mobile sizes at the compact size class whatever the pointer, and on a touch
  device at any width (`MOBILE_SIZE_QUERY`, exported beside `TOUCH_QUERY`): a narrowed desktop window
  gets 44 px buttons, tabs and text fields with 16 px field text, as a phone does, instead of the
  28 px desktop controls. A control with text pads wider than it is tall (buttons and chips 16 at the
  sides, tabs 16, segments 16 filling a 44 high group with the selected ground drawn inset, field
  text 12 from the border); icon buttons stay square. The touch component forms (large list rows,
  the bottom sheet's touch form, drawer rows, floating buttons) follow the width too. The settings sub-nav on a phone fades at the edge it scrolls past and keeps the current item
  in view. The system font stays touch only.
- a6348e1: The compact drawer and the bottom sheets no longer scroll sideways: the drawer's conversation
  section and the account sheet's rows kept the sidebar's and an older negative margin (8 px too wide
  each), and the drawer is now a vertical-only scroller with the thin scrollbar. The account sheet's
  rows share one text column, its labels never wrap and the status line wraps inside its column. A
  bottom sheet's close button sits on the rows' edge; the options sheet's notice is styled for every
  pointer on the rows' text column. The focus an overlay moves on open draws no ring unless it was
  opened from the keyboard.
- f74b0f9: Compact (below 600) inside the desktop shell with window controls: the floating row is a flat
  title bar like the rail's band (one row as high as the controls, a hairline under it, ghost
  desktop-size menu and "…" buttons); the conversation title is plain text that drags the window and
  the title menu's items move into "…". Everywhere on compact: the floating "…" is the same size as
  the menu button and the title pill, and the page head draws no path row.
- 581c6c7: Inside the desktop shell the page path in the top row follows what precedes it (the content column's
  start padding beside the full sidebar, right after the band's sidebar toggle past a rail) instead of
  the centred content frame, and a path of the org slug alone is not shown there. The medium rail gets
  a sidebar toggle (in the desktop band after the window controls, in the browser where the expand
  button sits) that opens the full sidebar as a drawer over the content; ⌘\\ / Ctrl+\\ opens and
  closes it on medium.

## 0.2.0-rc.30

### Patch Changes

- 8f70749: Every unsupported permission availability carries its cause (a runtime report and a missing preview had none, which crashed the new conversation's mode menu into a 503 page); the desktop band's hairline is drawn only while the rail is shown.

## 0.2.0-rc.29

### Minor Changes

- 4697ec6: Secure input variant of the approval block (Submit and Cancel, values saved directly) and an
  "approved automatically" or "approved by the review model" line on tool rows.

### Patch Changes

- 7a5468b: Desktop shell: where the window controls reach past the sidebar rail, the top row is one band across
  the whole window on the page ground and the rail (its surface and divider) starts below it; the
  collapsed rail's expand button moves into the band right after the controls. Below 600 the floating
  row's empty room drags the window wherever the shell reports controls, the home included.
- 04172b9: The conversation panel's resize line covers the panel's left hairline instead of sitting 4 px beside it.
- 3ede700: Inside the desktop shell, where the rail starts below the top row, a hairline under the row runs across the window so the rail's divider meets it instead of stopping short.

## 0.2.0-rc.28

### Patch Changes

- 8c0ca79: Desktop app: the web runs to the window's top edge. The traffic lights sit in the sidebar's brand
  row, centred on it, and the conversation title bar shares that row; no empty band above the page.

## 0.2.0-rc.27

### Patch Changes

- 0ecdba4: The author circle beside a user message is 40 px, as tall as a one-line bubble (was 24).
- 783f457: The shell no longer schedules a React update from inside Next's history insertion effect
  ("useInsertionEffect must not schedule updates" in development) when it counts in-app history.

## 0.2.0-rc.26

### Patch Changes

- 072362d: Desktop onboarding: `GET /api/v1/meta` lists `appRedirectUris` (`auth.appRedirectUris` while app
  sign-in is available, else empty), so the desktop app can say before opening the browser that the
  platform does not allow it; the app token exchange answers `auth.account_disabled` (403) for an
  account that is not active instead of `app_auth.code_invalid`. `chrome@1.setAppearance` also
  carries the page's seven main color tokens (only when all are plain colors) and `singleScheme`
  under a single-scheme UI theme; the SDK gains `ChromeCapabilityV1`, `ShellChromeTokens` and
  `SHELL_CAPABILITY_KEYS.chrome`.
- 4ae3971: The Platform tool takes conversation files where the web takes an upload: an agent avatar from a
  generated image, skill and plugin packages, extension packages and skill versions, passed as
  `file: { fileId }` (a device file is delivered with Deliver first). The card shows the file's name,
  size, sha256 prefix and a thumbnail, and the bytes that run are the bytes the person confirmed.
  Imports, uploads and anything else a person reviews on a web page pop up a link card to that page.
  Two new platform-ops rules keep it that way: an exclusion may not cite an upload, and an operation
  that sends the person to a web page links it or says why not (`noHandoff`).

## 0.2.0-rc.25

### Patch Changes

- e788a1a: Person fields: a Platform write that needs a secret takes its field name in `askPerson`, and the
  person types the value on the approval card on the web; it is sealed, read once by the resumed call
  and never reaches the conversation, the audit or a log. Agents can now read and set extension
  deployment config, org config and the org's config copy through the Platform tool.

## 0.2.0-rc.24

### Patch Changes

- 68fb86e: `ModeMenu` (spec §6.16.3a): the composer's mode button and menu with described profile rows, a
  key hint in the head and the effort as segments; `ComposerBox` takes `mode`, draws the model
  picker as "model · effort" and moves to the next mode on Shift+Tab. Menu entries gain `segments`
  and a label `hint`. `ToolRow` shows a crossing approved automatically.

## 0.2.0-rc.23

### Patch Changes

- 1835433: The web is an installable PWA: `/manifest.webmanifest` carries the deployment's name
  (`platform.name`, "Capybara" unset) and platform icon (the app and maskable icons, else the
  Capybara set the web ships), and the page title, the iOS web app title, the favicon and the
  apple-touch-icon follow them. A signed-out browser may read the manifest and the two default PNG
  icons (the sign-in proxy skips exactly those names). The super admin's deployment settings gain
  应用图标 / App icon: upload the app icon, its maskable variant and the SVG favicon, or restore the
  default; the `/api` proxy admits 2 MiB for the icon upload.
  
  The design system exports `PAGE_BACKGROUND` (the page background per theme) for what cannot read a
  CSS variable.

## 0.2.0-rc.22

### Patch Changes

- d91ad92: Agent map: every node (root and sub-agents) is the same bordered compact card, siblings `space.2`
  apart; the status legend moves into a tooltip on the count line; line 2 shows the model's display
  name alone, so it no longer collapses into an ellipsis behind the provider prefix.

## 0.2.0-rc.21

### Patch Changes

- d3d88bb: The agent map is compact: every agent is a 44 px row (was a 62 px bordered card) 336 wide, siblings
  4 px apart (was 8), no box per row (hover and the open agent get a ground), the root a quiet card
  level with its first child instead of centred on a long column, and the connectors meet each row's
  centre. On a row's meta line only the model name gives way; time and tokens always stay whole.
  The count line, legend and background task rows are tighter, and the agent's summary dialog has two
  meta lines (spawner, time and tokens on one) and tighter body and footer padding.

## 0.2.0-rc.20

### Patch Changes

- 3cb0cf5: Kernel: the `device.auto_mode_not_allowed` refusal is gone with the protocol 2 machine-mode check
  (a protocol 3 device's owner ceiling refuses with `device.full_access_not_allowed`). A device held
  by the legacy retirement (`device.unavailable`, `device.restart_required`,
  `device.recreate_required`, `device.replace_required`) now tells the model what clears it instead
  of the inactive-provider text. Messages that named the removed `capybara-device mode` command name
  `capybara-device ceiling set` instead.
  
  `capybara-device`: unused protocol 2 helpers (the sandbox-runtime config, the network violation
  parser, host file access) are removed. Design: the `KeycapCommand` example names
  `capybara-device ceiling set`.
  
  The device sign-in token response names its field `fullAccess` (was `autoMode`; same values
  `allowed` / `off`), and `capybara-device login` reads it to say that the org does not allow Full
  access. A kernel and a device program upgrade together.
- 32dd711: The sandbox escalation approval card (conversation and inbox) says when approving starts a
  background process: it keeps running outside the sandbox until it exits or is stopped, at most
  its deadline in minutes. A command the command review admitted outside the OS sandbox now shows
  " · Ran outside the sandbox" / " · 在沙箱外运行" on its tool row (design `ToolRowData.outsideSandbox`,
  part `sandbox-word`), on done and failed rows.

## 0.2.0-rc.19

### Patch Changes

- b999b66: ComposerBox gains `suggestion` (a prompt suggestion as the placeholder; Tab fills it, Esc and
  typing dismiss it, a "Use suggestion" button on touch devices), the `corner-down-left` icon and
  `SUGGESTION_FIXTURE`.

## 0.2.0-rc.18

### Patch Changes

- d3fe7c3: TaskOutput and TaskList calls get their own tool kind: a group waiting on a background task says
  "Waiting on a background task" instead of "Reading file", and done ones count as background task
  checks, not file reads.
- 45ff51f: New UI part `image-placeholder` (`aria-busy`): the placeholder the conversation draws while an
  image is being generated. The design package adds `ImagePlaceholder` and an `ImageOutput.ratio`
  pre-load hint.

## 0.2.0-rc.17

### Patch Changes

- b0e2cda: List sibling agents in the agent map newest first, so the agent dispatched last is on top.

## 0.2.0-rc.16

### Patch Changes

- 909442f: Add the pieces for file sharing: `HtmlDocumentFrame` (an HTML file as a sandboxed document,
  `HTML_DOCUMENT_SANDBOX`), `CopyField` (a value to copy again, with the manual-copy fallback), a
  Share action with a shared marker in the file preview header (`onShare`, `shared`), and the
  `SharedFilePage` template (T14) for a shared file's public page.

## 0.2.0-rc.15

### Patch Changes

- 0364c94: A file previewer embed (`file.preview`, such as the file-preview plugin's sheet, PDF and archive
  viewers) fills the right panel below its header, frameless like the built-in previews, instead of
  a 360 px framed iframe. `EmbedFrame` gains `fill`.

## 0.2.0-rc.14

### Patch Changes

- 09272da: Support an optional permission picker in the composer toolbar and phone options sheet, with
  localized group titles, selection checkmarks and disabled capability reasons.
- f058454: Show the three conversation permission profiles (Request approval, Approve for me, Full access)
  in one neutral look: picker rows may carry an icon, a description and a picker action, in the
  menu and the phone options sheet. The web shows the profile read-only for now: the new
  conversation's default and an owner's recorded or inherited profile.

## 0.2.0-rc.13

### Patch Changes

- 11ec986: Checklist items with an open target read as the list's text again: start-aligned when they wrap,
  in the item's status color and weight, underlined only on hover and keyboard focus.
- ecc843e: Keep a code block's or a markdown table's classic scrollbar inside the block in Safari: WebKit did
  not lay out flex ancestors again when the scrollbar appeared, so it hung over the next row (the
  command approval card's buttons).
- a6e5062: Keep a DataTable's classic sideways scrollbar inside the table in Safari, as for code blocks.

## 0.2.0-rc.12

### Patch Changes

- d1f558b: Keep the conversation thread aligned with the composer in Safari when the thread scrolls with a
  classic scrollbar.

## 0.2.0-rc.11

### Patch Changes

- 6f7f0dc: The image zoom says so when the image cannot be loaded, with a retry (a session refresh, then the
  attachment URL with its retry token); a new source clears the failure, and the retry disappears once
  the one reload has been used.

## 0.2.0-rc.10

### Patch Changes

- 31b5355: Clicking an image attachment zooms in the page with a download action instead of opening a tab.
- 9d98a0e: Keep a running tool row's elapsed time on one line (§6.16.9): beside a long description, such as a
  command review's reason, the label now yields with its ellipsis and 「6 秒」 is no longer squeezed
  into one character per line. The live timer is a status like the waiting word beside it: `flex:
  none`, `nowrap`.

## 0.2.0-rc.9

### Patch Changes

- 62d792f: Unify project-context warnings with expandable run details and mark unavailable projects in the composer. Provide device and new free-conversation links without changing the existing project binding.
  
  Keep tool approval status on one line when a long command description competes for space.
  
  Keep long project paths within phone widths and scroll to project details after their layout settles.

## 0.2.0-rc.8

### Patch Changes

- ba36733: Field `action`: a control that acts on the field's value (an 「添加」 button) sits on the control's
  line, the help and error below both; the device page's 「添加域名」 row uses it.
- e76028b: ScheduleCalendar: the scheduled task runs of a week or a month (time grid with a now line, three blocks side by side then +N, a dense lane, 6 × 7 month cells, the phone agenda, roving keyboard focus, loading, empty and load-failed states); the layout.calendar-* sizes and the ink / fail on hover and selected contrast pairs (also in the SDK's theme readability check)
- 8f08231: ScheduleCalendar: at most two overlapping blocks side by side in the week view (three left about
  51 px each, an icon and a clipped time); a larger cluster keeps one block and puts the rest in +N

## 0.2.0-rc.7

### Minor Changes

- e964b57: Network asks: when a command on a connected device is refused a domain by the device's local
  policy, the device owner is asked in the conversation or on the IM card (「这次允许 / 这台设备一直允许 /
  拒绝」). "This time" allows the domain for the rest of the run tree; "always" adds it to the device's
  local policy through the new `policy` device operation. Org-layer and address-layer refusals are
  explained to the model and shown under the command. Migration 0114 adds approval kinds and device
  policy summaries.
- 239555e: The device page gains a network section for the owner of a local device: the machine's allowed
  domains with remove, an add field that takes `*.` wildcards and whether the machine accepts changes
  from the platform (`remoteGrants`, set only on the machine). Opening the network is the sandbox
  level's 开放 (see the sandbox levels changeset). The device picker and the properties panel can mark
  a device (`PickerItem.badge`, `ContextSection.sandboxBadge`).

### Patch Changes

- 0f8f5bb: The agent page's 组织技能 and the agent template's 技能 group the skills by where they come from
  (each plugin, the org's own, the built-in ones), each group with a select-all box (checked/total,
  mixed) and a filter for long lists; each row is the name and its badges on one line and the
  description cut to one muted line with the full text on hover (new design `CheckList`). A badge
  never shrinks or wraps, and a checked disabled checkbox keeps its check visible.
- bfb35e3: Tool rows no longer read a Bash command's non-zero exit as a failure (only a timeout or a stopped
  command fails; the summary names the exit code), and an `Edit` / `Write` refused by the
  read-before-write check carries the display-only `tool_result.view.kind: "guard"`, shown as
  "Blocked: read the file (again) first" and counted apart from failures; the model still gets the
  same error result

## 0.2.0-rc.6

### Patch Changes

- 0dea20f: OverviewSection: one section of an overview page with its own loading, error and ready state
- 1c8fd12: TrendChart: a time series as stacked panels on one shared x-axis (crosshair, tooltip, keyboard, hidden table), and formatCompact for large numbers (en 3.4M, zh 340万)

## 0.2.0-rc.5

### Patch Changes

- 6ca55be: Browser review polish: plain links in tables draw in ink instead of the browser's link colour;
  a disabled ghost or icon button no longer gains a border; page header actions sit on the title
  line on every page; the status bar keeps 「第 N 轮 · 已用 …」 whole and shrinks the prompt first;
  the thread fades at its scroll edges; context lines never break inside a word; tab rows that do
  not fit fade where tabs are hidden; Markdown code blocks get a copy button and Markdown tables row
  lines and room; the extension tables' state, switch and 副本 columns fit their content (the 副本
  cells drop the repeated word). One localized duration format, `formatDuration` (replacing
  `runDuration`, `subagentDuration` and `elapsed`), so the status bar and the run row agree.
- 6a4ffff: New UI parts for theme plugins: `message.user.bubble`, `code-block`, `menu`, `segmented`,
  `stat-card`, `switch` (`aria-checked`) with `switch.knob`, `org-avatar` and `agent-chip`
  (`aria-pressed`); `message.assistant` promises `aria-busy` while its text streams, and the web sets
  it on the live reply. `UiPartState` gains `aria-checked` and `aria-pressed`.

## 0.2.0-rc.4

### Patch Changes

- d7476f2: While a run waits on your question, the composer says a message skips it (else that the message
  waits for the item above); a question skipped by a message reads 已跳过：直接回复了消息, a cancelled one
  已取消 (no longer 已跳过), and the trajectory viewer shows a skipped question with its message's seq.

## 0.2.0-rc.3

### Minor Changes

- 363a2d3: The design stylesheet declares the cascade layer order `@layer design, theme, extensions;` and
  puts every file in the `design` layer, so theme and plugin CSS win by layer, not by specificity
  or source order; the design's `!important` rules still beat theirs.
- f172ba6: Built-in elements carry the public `data-cap-part` hooks of the `UI_PARTS` catalog (`owner` is now a
  list of files, since one part can be drawn by several components); the design package adds
  `DecorationLayer`, `ReplaceableFrame` and `SafeModeBanner`, the `decoration` layering token,
  `Sidebar` `brand` and `AppShell` `capState` (`data-cap-state`). `check:ui-parts` enforces the hooks.
- 90e6e18: `AppShell` (and `SetupPage`) take a `banner`: a shell-wide row (safe mode's `SafeModeBanner`) drawn
  as the shell's first grid row across the sidebar and the content column, which share the rest of
  the window. In safe mode the web draws its banner there instead of above the 100dvh shell, so the
  status bar and the bottom of the page are no longer clipped.

### Patch Changes

- f437001: `Sidebar` takes `brand` as a function of the panel it is drawn in (`{ collapsed, panel: "full" |
  "rail" | "drawer" }`), called once per drawn panel. `ReplaceableFrame` takes a `ref`, and a pending
  frame is revealed by CSS alone after 1 500 ms (no `inert` / `aria-hidden`: `visibility` already takes
  hidden content out of focus and the accessibility tree), so a pending frame the server drew never
  stays hidden.
- 08b3e72: `ComposerBox` takes `frame={false}`: the composer's inputs without the frame's box
  (`ComposerFrame bare`, `data-frame="bare"`, the same `composer` part), for a plugin's frame drawn
  around the composer.
- 60a8d66: `DecorationLayer` no longer puts `aria-hidden` on the whole layer: it hides each decoration element
  from assistive tech and leaves interactive ones (marked `data-cap-interactive`, or focusable) and
  their ancestors exposed, keeping up with the plugins' later DOM changes, so an interactive element
  never sits under `aria-hidden`.
- 99a970a: `IconButton` carries the `button` UI part (`button button.primary` for the primary variant) like
  `Button`, so plugin CSS on `[data-cap-part~="button"]` reaches every button, the composer's send and
  stop among them.
- 9d72577: The sidebar's breakpoints are exported once (`SIDEBAR_RAIL_QUERY`, `SIDEBAR_DRAWER_QUERY`), and the
  App Shell's `sidebar=` state token reads them through the sidebar instead of repeating the widths.
- e531e6d: The SDK exports `UI_PARTS`, the catalog of built-in elements (`data-cap-part`) plugin CSS may
  select; `capybara-plugin check` reports `ui-part-unknown` against it.
- 8c49d09: The shell element publishes `run=`, `theme=<plugin>/<file id>`, `motion=` and `sidebar=rail|full` in
  `data-cap-state`; the open conversation's log is turned into client events on the client (history
  loaded on open emits nothing). `ThemeRef` gains `key`.

## 0.2.0-rc.2

### Patch Changes

- 098c38c: One name: devices. The 环境 / Environments page is now 设备 / Devices at `/devices` and
  `/devices/[id]`; 新建设备 offers 云端 / 本地 (cloud and local devices). The sign-in confirmation
  page moves from `/device` to `/devices/link`; `/device` and `/environments` are the app's 404. The
  composer's picker, the properties panel and all copy say 设备 / device. The design system's
  composer picker prop `pickers.environment` is now `pickers.device` (reference blocks
  `composer-device` and `composer-device-locked`).

## 0.2.0-rc.1

### Minor Changes

- 789068d: The composer takes an `environment` picker between the agent and the model (locked after the first
  message), and `PickerItem.disabled` marks a choice that cannot be picked.

### Patch Changes

- 3c45446: Agents gain the `Platform` builtin tool, on for new agents: an agent browses, searches and describes
  the platform's operations, calls them as the person who started the run, and reads the agent docs.
  Operations cover skills, agents, agent templates, plugins, marketplaces, requests, connectors and
  extensions (`skills.*`, `agents.*`, `plugins.*`, ...); results never carry secrets, and a super admin
  sees other orgs as counts only. Reads run; writes ask the person to confirm, and org and platform
  writes are confirmed every time and never remembered (`approval.scope_not_allowed` for any other
  scope). Tool policies can be keyed per call (`Platform:<operation>`); an approval stores its
  kernel-rendered summary (zh and en) and runs only with the exact input it showed. Confirmations show
  the operation and the summary on the web and in IM cards, and offer only the scopes the approval
  allows. Orgs gain the `platformTool` setting (`on` / `read-only` / `off`, default on) on the
  organization settings page; writes are unavailable when no person is present. Audit events of writes
  made through the tool carry `{ via: "agent", conversationId, runId, operation }`. `describe` lists an
  operation's notable errors and paged lists take `params.cursor`. `check:platform-ops` fails a kernel
  HTTP route that has neither an operation nor a reasoned exclusion.

## 0.1.1-rc.0

### Patch Changes

- 15af7fd: Server-rendered times no longer break hydration. Until a page has hydrated it writes relative ages
  ("现在", "1 分钟前"), running durations and local dates with the clock and time zone of the server
  render, then switches to the browser's: an age that crossed a minute between the server render
  and the hydration, or a viewer in another time zone, used to fail hydration (Next's error overlay
  in development) or keep the server's times. The browser's time zone is saved in the `cb-tz`
  cookie, so later server renders write dates in the viewer's zone.
