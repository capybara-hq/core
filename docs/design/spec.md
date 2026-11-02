# Capybara Design System Spec (E · Terminal, refined)

> Status: implemented (`packages/design` + `/dev/ui`) · 2026-10-18; refined E rules, sidebar shell, size tables and states from UI refresh A, implemented and accepted against the reference set (all 14 components and templates) · 2026-10-26; conversation page rules, states and size tables from UI refresh B (reference set B signed off 2026-10-27), implemented and accepted against the reference set (all 37 components and templates) · 2026-10-27
> Visual reference: the **reference set** in `docs/design/reference/` (one PNG per component state, dark and light, rendered from `docs/design/reference/src/` with the real fonts, the generated tokens and the shared fixtures). The maintainer signed it off on 2026-10-26 (A) and 2026-10-27 (B, the conversation page); it replaces the design canvas as the visual source.
> Visual regression: the `/dev/ui` catalog page and the screenshot baselines checked into the repo (`apps/web/visual/`, Linux version) guard against breakage once a change has been accepted against the reference set (§9).

This document is the **only specification** for the web UI. The reference set and the screenshots illustrate this document; when they disagree, this document wins and the reference set is corrected (§10).
The implementation lives in `packages/design` (package name `@capybara-hq/design`); `apps/web` only consumes it. Rules that can be checked automatically are enforced by `pnpm check`, the measuring and state-coverage tests and the screenshot tests (see §9).

Wording: **must** / **must not** are mandatory; **should** is the default practice, and deviations need a reason stated in review.

---

## 1. Design principles

1. **Two fonts, one skeleton**: the monospace font (Sarasa Mono SC, one Chinese character is exactly two English cells) is the UI skeleton: navigation, labels, buttons, tables, tool rows, keys, paths, numbers, the status bar. Prose (descriptions in page headers and forms, conversation text, rendered Markdown) uses the proportional font (§2.2).
2. **Spacing before lines**: if spacing or a background tint can separate two things, no line is drawn. Lines remain only between columns, between table rows, and around things that float over content (inputs, inline cards, overlays).
3. **Color only for what needs attention**: mostly grayscale. Color marks failure, things needing a person, things happening and the primary action; success, done and connected are not colored. The accent takes only the five roles of §2.3.
4. **Compact and refined**: every size is a step of a named scale (§2.5); a container chooses the density step, pages never pick sizes. Numbers are monospaced and right-aligned; status always has text, never color alone.
5. **Structure before style**: a page is composed of the App Shell (§4) and page templates (§5); pages never lay out the shell themselves.
6. **Dark first, dark and light from one source**: the two themes share the same token names and only change the values; both ship together.

---

## 2. Tokens

`docs/design/tokens.json` is the **source of truth** for colors, shadows, the size scales, layout widths, motion, fonts, layering and the contrast pairs. `pnpm gen:tokens` writes `packages/design/src/styles/tokens.css` (the CSS variables `--cb-<token>`, dark under `:root` / `:root[data-theme="dark"]`, light under `:root[data-theme="light"]`) and `packages/design/src/tokens.ts` (`TOKEN_NAMES`, `SIZES`) from it; both files are generated and never edited by hand. `pnpm check:tokens` (part of `pnpm check`) fails when either file is stale, when `tokens.json` is malformed, or when a pair in `contrast` misses its ratio.

All colors, sizes and shadows may only be used through tokens. Color literals are allowed only in the generated `tokens.css`. Tailwind is not used.

### 2.1 Colors

| Token | Dark | Light | Purpose |
|---|---|---|---|
| `bg` | `#0A0A0A` | `#F7F6F2` | Page background |
| `panel` | `#111110` | `#FFFFFF` | Cards, table container, stat cards, form field cards, overlays |
| `panel-2` | `#0E0E0D` | `#FBFAF7` | Action row, right-panel ground |
| `sidebar` | `#111110` | `#EFEEE9` | Sidebar ground |
| `sidebar-active` | `#1A1A18` | `#E2E1DB` | Current nav item or conversation in the sidebar |
| `raised` | `#141413` | `#FFFFFF` | Floating inline cards, the composer |
| `selected` | `#1F1F1D` | `#ECEBE6` | Selection ground: selected segment, filter chip, option card, the palette's current row, the waterfall's selected row; avatar, skeleton bars |
| `hover` | `#171716` | `#F4F3EF` | Hover ground, disabled input ground |
| `line-soft` | `#1C1C1A` | `#E6E5E0` | Column dividers, table row dividers, the status bar's and action row's top line, disabled borders |
| `line` | `#2A2A28` | `#D6D5CF` | Input and button border |
| `line-strong` | `#3A3A37` | `#B5B5AE` | Overlay border, the border of a selected option card or palette row |
| `line-card` | `rgba(255,255,255,0.08)` | `rgba(26,26,24,0.06)` | The 1px hairline of cards and sections |
| `scroll-thumb` | `rgba(255,255,255,0.15)` | `rgba(26,26,24,0.20)` | Scrollbar thumb (on a transparent track) |
| `ink` | `#E6E6E3` | `#1A1A18` | Text |
| `muted` | `#8E8E89` | `#5E5E5A` | Secondary text, table headers, sidebar group labels |
| `faint` | `#5A5A56` | `#9A9A94` | Placeholders, separators and decorative strokes only (**must not** carry essential information, a path segment or a label; contrast is below 3:1) |
| `disabled` | `#6E6E69` | `#82827C` | Disabled text and icons (at least 3:1 on `bg`, `panel`, `hover` and `selected`); a disabled control keeps a `line` border |
| `accent` | `#FF6A13` | `#CC4609` | Primary action, focus, current navigation (§2.3) |
| `accent-hover` | `#FF8240` | `#B83F08` | Accent hover |
| `accent-press` | `#E85A08` | `#A33707` | Accent pressed |
| `on-accent` | `#0A0A0A` | `#FFFFFF` | Text and icons on a solid accent ground |
| `accent-tint` | accent @ 12% | accent @ 12% | Tinted accent ground (selected row) |
| `focus-ring` | `rgba(255,106,19,.25)` | `rgba(204,70,9,.18)` | 3px input focus halo (§2.5) |
| `ok` | `#3FD483` | `#16803F` | Success (rarely shown: success is not colored, §1) |
| `fail` | `#FF5C52` | `#C8302A` | Failure, error, danger |
| `warn` | `#F2C14B` | `#8F6500` | Needs a person: pending approval, unsaved, needs authorization |
| `scrim` | `rgba(0,0,0,.60)` | `rgba(10,10,10,.25)` | Behind dialogs, sheets and the sidebar drawer |
| `diff-add` | `rgba(63,212,131,.08)` | `rgba(22,128,63,.10)` | Added lines in a diff (ground only; the text stays `ink`) |
| `diff-del` | `rgba(255,92,82,.08)` | `rgba(207,34,46,.08)` | Removed lines in a diff (ground only) |

The light accent is `#CC4609`: white text on it has a contrast of 4.72:1 (WCAG AA). The original `#FF6A13` with white text is only 2.87:1 and must not be used in the light theme. The text pairs that must meet AA are listed in `tokens.json` `contrast` and checked by `check:tokens`; a translucent token (`diff-add`, `diff-del`) is composited over `bg` before its pair is checked. `muted` must reach 4.5:1 on every ground secondary text sits on (`bg`, `panel`, `panel-2`, `sidebar`, `raised`, `selected`, `hover`; dark: 6.02:1 on `bg`, 5.02:1 on `selected`) and `disabled` 3:1 on the grounds a control sits on (dark: 3.86:1 on `bg`, 3.22:1 on `selected`; light: 3.57:1 on `bg`, 3.24:1 on `selected`).

### 2.2 Fonts and type

Two fonts, each with a job:

| Font | Token | Used for |
|---|---|---|
| **Sarasa Mono SC** (OFL-1.1) | `--cb-font` | The UI skeleton: navigation, labels, buttons, tables, tool rows, key names, paths, numbers, the status bar |
| **Inter + Source Han Sans SC** (both OFL-1.1) | `--cb-font-prose` | Prose: descriptions in page headers and form sections, conversation prose, rendered Markdown, table description lines |

- Weights 400 / 500 / 600, never above 600: hierarchy comes from size and color, not weight. The page title (`h1`) and emphasis (the primary button, the current nav or tab item, object names, `strong`) are 600; section, card, dialog and group titles are 500; everything else is 400. Each font ships a 400 and a 700 face: 500 draws with the regular face and 600 with the bold face (CSS font matching), so a 500 title is set apart by its size and `ink` color alone.
- Delivery: subsetted to woff2 at build time (`packages/design/scripts/subset-font.py`: ASCII, the 3,755 level-1 common Chinese characters, the characters the UI uses and a symbol table), self-hosted under `packages/design/src/fonts` with their licenses, `font-display: swap`, declared only in `styles/fonts.css`.
- Fallbacks: `'Sarasa Mono SC', ui-monospace, monospace`; `'Inter', 'Source Han Sans SC', system-ui, sans-serif`.

| Name | Size / line height | Weight | Font | Purpose |
|---|---|---|---|---|
| `h1` | 20 / 28 | 600 | mono | PageHeader title |
| `h2` | 16 / 24 | 500 | mono | Section title, card title, Dialog title |
| `body` | 13 / 20 | 400 | mono | Default text, tables, controls, nav items |
| `small` | 12 / 16 | 400 | mono | Table header, help text, error messages, group labels, stat labels |
| `micro` | 11 / 14 | 400 | mono | Status bar, nav counts |
| `metric` | 18 / 24 | 400 | mono | Stat card values |
| `prose` | 15 / 26 | 400 | prose | Conversation prose, rendered Markdown |
| `prose-small` | 13 / 20 | 400 | prose | Page-header and form-section descriptions |

- Numbers always use `font-variant-numeric: tabular-nums`.
- No italics and no letter-spacing adjustment.
- `micro` (11) is the smallest size anywhere, at every window width (mono meta lines included); no stylesheet sets a smaller one.

### 2.3 The five roles of the accent color (only these five)

| Form | Used for |
|---|---|
| Solid (`accent` ground + `on-accent` text) | The **only** primary action in a view |
| Outline (1px `accent` border + `accent` text) | Secondary actions that need emphasis; a conversation card waiting for a person gets only an outline (`Card tone="accent"`) |
| Tinted ground (`sidebar-active` ground + `ink` text in the sidebar; underline `inset 0 -2px 0 accent` for PageTabs) | The current top-level navigation item (the sidebar is vertical, so it is a tinted ground, not an underline), the current PageTab |
| Text (`accent` text / the `spinner` icon) | Something is happening: running, live, auto-refresh countdown, cursor |
| Ground + left marker (`accent-tint` ground + `inset 2px 0 0 accent`) | The selected row / item |

The accent color must not be used anywhere else. Selected segments and selected filter chips use the `selected` ground, not the accent. A **selection inside a control** is neutral too: a checked option card, the command palette's current row and the trace waterfall's selected row use the `selected` ground with a 1px `line-strong` border (the waterfall row, a row of a tree, a 2px `ink` marker on its left instead); the accent stays on the radio dot and the focus ring. Badges and marks never use the accent: a role ("企业管理员") is plain text, and attention is `warn` (§2.4).

### 2.4 Status encoding

| Status | Icon | Color | Text |
|---|---|---|---|
| Running | `spinner` | accent | Running |
| Succeeded | `check` | muted (uncolored) | Succeeded |
| Failed | `circle-x` | fail | Failed |
| Pending approval / paused | `pause` | warn | Pending approval |
| Queued | `circle` | muted | Queued |
| Cancelled | `ban` | muted | Cancelled |
| Limit reached | `diamond` | warn | Limit reached (stopped after a quota such as the token limit ran out; distinguished from a manual cancel) |

- A status must have both an icon and text; it must not rely on color alone.
- **Queued messages** (§6.16.14) are the exception that proves the rule: the dashed, translucent bubble is the mark and the word "排队中" / "Queued" follows it in `faint`, as the signed reference draws it; there is no `circle` icon there.
- **Streaming cursor**: an `accent` block `space.2` wide and `space.4` high at the end of streaming text, blinking every `motion.cursor` in steps (steady under reduced motion); it is the "cursor" of §2.3's text role.
- **Attention marks** ("敏感" / "Sensitive", "有新版本"): the word in `warn`, no box, no fill (`Badge tone="warn"`, an ObjectRow chip with `tone: "warn"`); one style on every page. A group that holds sensitive items is an ordinary card (the `line-card` hairline) with the mark in its title, never an accent or warn frame; only the mark is yellow (the reasons are `muted` secondary text, the items the plain `muted` list). Plain metadata (必装 / Required) is `muted` text and a state that needs attention (不可用 / Unavailable) `warn` text, never a badge.
- **High-frequency lists** (tool rows, todo items, connector lists, table status columns): success is shown by **no mark** (plain `muted` text such as "Connected"), failure by the word "Failed" (or the specific error) in `fail` with `circle-x`. Everything that needs a person keeps `warn`.

### 2.5 Sizes, density, lines, radius, shadow, layering, motion, focus

Every size a component uses is a step of one of these scales, stored in `tokens.json` (`size.*`) and listed in the component's size table (§6). Pages never pick sizes.

| Scale | Steps | Values | Variables |
|---|---|---|---|
| Control height | `dense` / `default` / `prominent` | 24 / 28 / 32 | `--cb-control-<step>` |
| Row height (lists, tables, sidebar, menus) | `dense` / `default` / `roomy` (rows with a thumbnail or two lines) | 28 / 32 / 44 | `--cb-row-<step>` |
| Spacing | `1`–`8` | 4, 8, 12, 16, 20, 24, 32, 40 | `--cb-space-<n>` |
| Inner padding (inside a component, vertical / horizontal) | `dense` / `default` | 4/8 · 6/12 | `--cb-pad-<step>-y`, `--cb-pad-<step>-x` |
| Type | §2.2 | | `--cb-type-<name>-size`, `--cb-type-<name>-line` |
| Radius | `sm` / `md` / `bubble` | 4 / 8 / 10 | `--cb-radius-<step>` |
| Layout | `sidebar` / `sidebar-rail` / `content` / `content-pad` / `chat` / `status-bar` / `action-row` / `gutter` | 256 / 48 / 1120 / 32 / 720 / 24 / 40 / 20 | `--cb-layout-<name>` |
| Layout, conversation page | `title-bar` / `properties` / `panel-min` / `panel` / `chat-min` / `tool-output` / `file-card` / `thumb` / `inline-image` | 48 / 300 / 520 / 560 / 480 / 120 / 240 / 56 / 360 | `--cb-layout-<name>` |

**Density steps.** Controls and rows come in three steps, chosen by context, never by taste:

| Step | Used for | Not used for |
|---|---|---|
| `dense` | Inside table rows (row menus, inline controls) and table pagination, tool groups and tool rows, inline cards, property sections, the status bar, tag-like chips | Anything a person is expected to read at length or aim at often outside a dense container, including a table's toolbar, bulk action bar and empty-state actions (those are `default`, as the signed reference draws them) |
| `default` | Everything else: buttons, inputs, selects, segmented controls, filter chips, table toolbars, bulk action bars and empty-state actions, the composer's controls, sidebar items, menu items, form fields | — |
| `prominent` | At most one per view, where the action *is* the page: the auth pages' submit, an empty state's first action, the onboarding checklist's next step | Ordinary page-header primaries, form submits in the action row, dialogs |

- A container sets the step for what it holds (a DataTable's rows and pagination are `dense`, its toolbar, bulk action bar and empty-state actions `default`; a form is `default` throughout); mixing steps inside one row is not allowed. In code the step is the `density` prop (`"dense" | "default" | "prominent"`) of `Button`, `IconButton`, `Input`, `Select`, `Segmented` and `FilterChip`; a container provides it through `DensityContext` and an explicit prop wins.
- Icon buttons are square at the same step's height.
- The page-header primary action and the action-row actions are `default`.
- Spacing usage: inside components steps 1–3; between components 2–3; between sections 4–6; page gutters `layout.gutter`. **If spacing can separate it, don't draw a line.**

**Lines**: 1px. Column dividers, table row dividers and the status bar / action row top lines use `line-soft`. Borders (`line`) only on things that float over content or take input: inputs, buttons, chips, inline cards, overlays (`line-strong`). Cards, sections, stat cards, form field cards and object lists use the `panel` ground with a 1px `line-card` hairline (`rgba(255,255,255,.08)` in dark, where the ground alone barely separates them; drawn as an inset shadow where a border would change the box); the table container has no border.

- **Input borders are a signed-off contrast exception.** An input's 1px `line` border on the page ground is about 1.38:1 (dark, `#2A2A28` on `#0A0A0A`) / 1.36:1 (light, `#D6D5CF` on `#F7F6F2`), below the 3:1 WCAG asks of UI component boundaries. The maintainer signed this off with the reference set (2026-10-26): the soft line is the refined E look, and an input is never identified by its border alone. It always carries a visible label (Field, `body` `ink`) or a placeholder/prefix inside it, it shows a `line-strong` border on hover, and focus draws an `accent` border plus the 3px `focus-ring` halo. `tokens.json` keeps no contrast pair for `line` for this reason; a new component that relies on a `line` border as its only boundary needs its own sign-off.

**Radius**: `sm` for inputs, buttons, chips, nav items and conversation rows; `md` for inline cards, property sections, stat cards, form field cards and overlays; `bubble` for message bubbles and the switch track; **0** for tables and page structure (sidebar, header, status bar, action row).

**Shadows** are used only for things that float:

| Token | Dark | Light | Used for |
|---|---|---|---|
| `shadow-1` | `0 8px 24px rgba(0,0,0,.40)` | `0 2px 8px rgba(10,10,10,.08)` | Menu, Popover, Toast, Tooltip, inline menu |
| `shadow-2` | `0 16px 48px rgba(0,0,0,.50)` | `0 8px 24px rgba(10,10,10,.12)` | Dialog, command palette |
| `shadow-sheet` | `-16px 0 40px rgba(0,0,0,.40)` | `-4px 0 16px rgba(10,10,10,.08)` | Sheet |
| `shadow-float` | `0 8px 24px rgba(0,0,0,.45)` | `0 8px 24px rgba(26,26,24,.08)` | The composer, the sidebar drawer |

- Layering: Sheet 40 · Dialog 50 · Popover/Menu 60 · Toast 70 (`--cb-z-*`).
- Motion: hover background transitions `motion.hover` (120ms); expand / collapse height transitions `motion.expand` (160ms); overlays fade in with a 4px offset over `motion.overlay` (120ms), `ease-out`, no bounce; the spinner turns once per `motion.spin` (800ms), the streaming cursor blinks every `motion.cursor` (1000ms). `prefers-reduced-motion: reduce` makes all of them instant, the spinner static and the cursor steady (§6.11).
- Focus: inputs, selects and textareas get an `accent` border plus a 3px `focus-ring` halo (`box-shadow: 0 0 0 3px focus-ring`); other controls use `outline: 2px solid accent; outline-offset: 2px`; table rows, list items, nav items and conversation rows use `outline: 1px solid accent; outline-offset: -1px`. `:focus-visible` only.

### 2.6 Icons

- One line-icon set site-wide: Lucide (ISC, vendored as paths in `packages/design/src/icons/paths.ts` by `pnpm --filter @capybara-hq/design gen:icons`, license next to it), 24 grid, stroke 1.5, sizes 16 / 14 / 12. The component is `Icon({ name, size, label? })` (§6.12).
- **Characters are not icons**: no `▾ ✓ ◐ › ● ⠿ ▤` and siblings. `apps/web` never imports an icon library (`web-ui-import`); it uses `Icon` from the design package.
- Icons are decorative (`aria-hidden`) unless they carry a `label`; an icon-only button always has an `aria-label`.

---

## 3. Brand elements

- **Logo**: a pixel capybara, a 14×10 bitmap drawn with a pixel unit of 2px (sidebar and rail, 28 × 20; the rail shows it without the wordmark) / 3px (empty state) / 6px (auth pages), `shape-rendering: crispEdges`, filled with the accent color. The bitmap (`X` is solid, `O` is the eye cut-out):

```
..........X...
.........XXX..
...XXXXXXXXXXX
..XXXXXXXXXOXX
.XXXXXXXXXXXXX
.XXXXXXXXXXXXX
.XXXXXXXXXXXX.
..XXXXXXXXXX..
..XX..X..XX...
..XX..X..XX...
```

- Wordmark: `CAPYBARA`, 600, 8 away from the Logo.
- **Dither dot matrix**: used only for the backgrounds on both sides of auth pages and (optionally) the PageHeader corner of the overview page; 4px squares in `line`, density decreasing from one side to the other, greyscale only (no accent squares). No other page may use it.
- No illustrations, gradients, frosted glass or emoji.

---

## 4. App Shell (system layout)

Every page (except auth pages, §5 T10) is **Sidebar | content area**. The content area holds, top to bottom, in a fixed order:

| Layer | Height | Required | Content |
|---|---|---|---|
| Drawer menu bar | `row.roomy` | Only below 960 | Menu button that opens the sidebar drawer, page title; below 640 its buttons are 40 px tap targets and it is padded 0 `space.1`, so their icons sit on the 16 px content edge |
| PageHeader | content | Required | Row 1 the path; row 2 title + one-line description, actions on the right; optional tabs row (§4.2) |
| PageTabs | 36 | Optional (detail pages only) | In-page tabs, current item underlined |
| Body | flexible | Required | One of the layouts in §4.3 |
| ActionRow | `layout.action-row` | Optional | Appears when the page has actions to submit, stacked above the StatusBar |
| StatusBar | `layout.status-bar` | Required | Read-only: context · page status ｜ system status · version · time zone |

- The sidebar spans the full window height; the ActionRow and StatusBar sit **only in the content area**, fixed at its bottom; they never span the sidebar.
- There is no TopBar.

### 4.1 Sidebar

See §6.13 for the component. Width `layout.sidebar`; below 1280 an icon rail of `layout.sidebar-rail`; below 960 a drawer opened from the drawer menu bar.

### 4.2 PageHeader

- Four rows. Row 1: the **path** `scope / page [/ object]` (mono, `small`; the segments in `muted`, the `/` separators in `faint`, the last segment, the current page, in `ink` with `aria-current="page"`; the conversation title bar's path the same), inside a `nav` labelled "Path"; earlier segments with a link are links. The scope is the org slug for workspace pages (links to `/`), `~` for the home page, `/admin` for admin pages. Row 2: title (`h1`, single line with an ellipsis, full text in `title`) + count / status, actions on the right (at most one primary, rightmost). Row 3 (optional): a one-line description (`prose-small` `muted`, single line with an ellipsis). Row 4 (optional): **tabs** with counts (`全部 6 · 我的 3`) for pages with views, with the **search** field at the right end of the same row; a tab changes the view (`onSelect`) or links (`href`). The tab row has one height with or without the search (`control.default` + `space.1` above and below) and a 1 px `line-soft` bottom border; the tabs sit at its bottom and overlap the border by 1 px, so the selected tab's underline lies **on** the border; the search is centered vertically. While a ListPage loads, the tabs and the search keep their place and a tab's count is a `faint` "–" (§5.1). Tabs never wrap: a tab row too narrow for its tabs scrolls sideways (§6.4). **Below 640** the search takes its own full-width line above the tabs (`space.2` between the lines), the tabs are 40 high (tap targets), and so are the header's actions.
- No bottom line and no background; spacing separates it from the body.
- Actions: at most 1 solid primary action + 2 secondary + a `more-horizontal` menu; the primary action is rightmost; all `default` density; an action may lead with a 14 icon (`plus` on a create action). The submit action of form pages **must not** go here; it goes in the ActionRow.
- List-page key metrics are **not** in the header: the template renders them below the header as StatCards (§6.14), at most 4–5. List and overview pages draw them at the top of the body; detail, trace, inbox, onboarding and status templates draw them in the fixed header area under the PageHeader.
- Content width: the header shares the body's one content width (`layout.content`, 1120, centered; §4.3). It sits `space.6` below the top of the content area and `space.3` above the body (StatCards or the table).

<!-- states: page-header -->
States: `title`, `path`, `description-actions`, `long-title`, `narrow`

<!-- size-table: page-header -->
| Part | State | Property | Value |
|---|---|---|---|
| page-header-title | title | font-size | type.h1 |
| page-header-title | title | line-height | type.h1.line |
| page-header-title | title | color | color.ink |
| path | path | font-size | type.small |
| path | path | color | color.faint |
| page-header-description | description-actions | font-size | type.prose-small |
| page-header-description | description-actions | line-height | type.prose-small.line |
| page-header-description | description-actions | color | color.muted |
| button[data-variant=primary] | description-actions | height | control.default |
| page-header-title | long-title | height | type.h1.line |
| page-header | long-title | width | 608 |
| page-header-tabs | narrow | row-gap | space.2 |
| page-header-search | narrow | width | 358 |
| tab | narrow | height | 40 |
| button[data-variant=primary] | narrow | height | 40 |

### 4.3 Body layouts and content widths

| Layout | Structure | Used for |
|---|---|---|
| Single | Content | Overview, trace viewer, system status, first use |
| Rail + Content | 240 + flexible | Lists with facet filters |
| Content + Inspector | flexible + 400 | Details |
| Rail + Content + Inspector | 240 + flexible + 400 | Inbox |
| Centered | content max `layout.content` (1120), centered | Forms, settings, wizards |

- Content width: **one** width for every page template (list, overview, form, settings, wizard, detail, trace, inbox, onboarding, status), `layout.content` (1120), centered (100% wide below that), with `layout.content-pad` (32) of side padding (16 below 640) and `space.5` (20) above the header; the page head and the body (also a detail page's tabs, beside its inspector) share that container. The head and the scrolling body both reserve the scrollbar gutter (`scrollbar-gutter: stable`), so a classic (non-overlay) scrollbar never shifts the body's column against the head. The head therefore sits at the same x and y on every page and on every tab of one page. The inbox's rail + content + inspector split is capped at that width inside the same padding; the trace viewer's waterfall and detail share its one left edge (§5 T8). A form keeps its label column inside it (forms put `space.6` between sections, lists `space.3`); the conversation page has its own columns (§5.4). The Centered layout has **no anchor navigation**; a form's error count lives in the ActionRow.
- Content has a minimum width of 560. The Rail is collapsible; the Inspector is closable.
- Scrolling: the sidebar, PageHeader / PageTabs / ActionRow / StatusBar are fixed; the sidebar's conversation section, Rail, Content and Inspector scroll independently; the page must not show a horizontal scrollbar (wide tables scroll inside their own container).
- Responsive: < 1280 the sidebar becomes the rail and the Inspector a right-side Sheet; < 960 the sidebar becomes a drawer and the Rail a toolbar "Filter" button + Sheet; < 640 (phones, checked at 390 × 844) the header actions beyond the primary fold into `more-horizontal`, and:
  - nothing scrolls sideways: the side padding is 16 on every template and on the conversation page (§5.4), and nothing keeps a minimum width wider than the window;
  - tab rows scroll instead of wrapping (§6.4), and the page head's search takes its own line (§4.2);
  - every DataTable is stacked rows (§6.6) and StatCards are two columns (§6.14);
  - tap targets are at least 40 px: the page head's actions and tabs, row actions (ObjectRow, §6.17; the DataTable row menu), the drawer menu bar's and the conversation title bar's buttons (§6.16.1); the sidebar drawer's rows are 40 high (§6.13);
  - type keeps its sizes: `micro` (11) stays the smallest (§2.2).

### 4.4 ActionRow and StatusBar

- **StatusBar**: one form only. Height `layout.status-bar`, **no background**, a `line-soft` top line, `micro` type, `muted`, padding `layout.gutter`. Left: the prompt `<login>@<org slug>:~/<path>` in the workspace and `<login>@<org slug>:/admin/<path>` in the admin console (the login in lowercase and the org's slug; the same on the conversation page, `~/chat/<id>`, which also shows the time zone) and the page status (such as "Filtered 18 / 24", "Auto-refresh 15s"), `space.3` apart; right: system status, version and time zone, separated by spacing only (`space.3`, as the signed reference). No `>` prefix, no status dot (success is not colored); a failed run's status ("失败" / "Failed", the conversation page) is drawn in `fail` (`systemTone`, `ConversationStatus.tone`). **Read-only**: it never holds a clickable control and never grows into an action bar. When space runs out the left part truncates first (ellipsis), the right part stays.
- **ActionRow**: when the page has actions to submit (forms, bulk edits, approval decisions, wizards) it appears **above** the StatusBar; both stay fixed at the bottom of the content area. Height `layout.action-row`, `panel-2` ground, `line-soft` top line, padding `layout.gutter`. Left: an accent dot + "N unsaved changes" (`muted`) `·` "N errors" (`fail` text, no icon, as the signed reference; the words carry the state), or a muted "No unsaved changes" ("没有未保存的修改", when the page passes `unsaved: 0`; never on a create form, §5.3); right: Cancel / Discard (default) · secondary action (default) · primary action (primary, rightmost), all `default` density. With no changes the primary is disabled.
- A page must not create its own floating / fixed bottom button bar.
- A page writes the "page status" text through `useStatusBar(...)` (rendered by the AppShell's StatusBar); StatusBar and ActionRow are design components, and a page does not render the StatusBar directly.

<!-- states: status-bar -->
States: `default`, `truncated`

<!-- size-table: status-bar -->
| Part | State | Property | Value |
|---|---|---|---|
| status-bar | default | height | layout.status-bar |
| status-bar | default | font-size | type.micro |
| status-bar | default | color | color.muted |
| status-bar | default | border-top-color | color.line-soft |
| status-bar | default | padding-left | layout.gutter |
| status-bar-right | default | column-gap | space.3 |
| status-bar | truncated | width | 480 |
| status-bar | truncated | height | layout.status-bar |

<!-- states: action-row -->
States: `unsaved-errors`, `clean`

<!-- size-table: action-row -->
| Part | State | Property | Value |
|---|---|---|---|
| action-row | unsaved-errors | height | layout.action-row |
| action-row | unsaved-errors | background-color | color.panel-2 |
| action-row | unsaved-errors | border-top-color | color.line-soft |
| action-row | unsaved-errors | padding-left | layout.gutter |
| action-row-errors | unsaved-errors | color | color.fail |
| button[data-variant=primary] | unsaved-errors | height | control.default |
| button[data-variant=primary] | clean | color | color.disabled |

---

## 5. Page templates

A new page **must** pick one of the following templates; a new template requires extending this section first and going through review. Every template takes the PageHeader of §4.2 and the content widths of §4.3.

| # | Template | Body | PageTabs | ActionRow | Width | Typical pages |
|---|---|---|---|---|---|---|
| T1 | Overview | Single | — | — | content | Org home, Agent summary |
| T2 | List | Rail + Content | — | During bulk edits | content | Agents, connectors, extensions |
| T3 | Detail | Content + Inspector | Yes | — | content | Agent, connector, extension details |
| T4 | Form | Centered | — | Always (submit actions) | content | Create / edit Agent |
| T5 | Settings | The PageHeader across the full content width, then below it a 200 px sub-nav (named "Settings navigation"; groups with a mono `faint` label, 30 px items, the current item on `sidebar-active`, optional mono counts) beside the content column (below 960 the nav stacks above the content); the header's `description` opens the content column instead of the head, so the head keeps one height and the sub-nav's top, aligned with the content's, has the same y on every settings page | — | When there are changes | content | Org, members, environment, security |
| T6 | Inbox | Rail + Content (+ Inspector) | — | During decisions | content | Human approval, alert handling |
| T7 | Conversation | Title bar + thread + composer, with the properties panel or one right panel (§5.4) | — | — | own columns | The conversation page (`/chat`, `/chat/<id>`) |
| T8 | Trace | Single: the span waterfall, then the selected span's detail right after it (no stretched waterfall, no gap); from 1280 the detail is a 400 px right panel inside the width, both columns scrolling on their own; stats, waterfall and detail share one left edge | — | — | content | Single run detail |
| T9 | Wizard | Centered + step bar | — | Always (Previous / Next) | content | First-time model, connector and extension setup |
| T10 | Auth | No Shell, centered card + dither dot matrix on both sides | — | — | — | Sign in, password recovery, accept invitation, initialization |
| T11 | System status | Single centered | — | — | content | 404, 403, under maintenance, not enabled, no access (`kind="no-access"`: a 16 px `lock` in `faint` instead of the code, the title, what the page is, `need` as a mono chip "需要：组织管理员" / "Requires: Org admin" (1px `line`, radius `sm`, `small`), `ask` in `muted` (who to ask); never an action or a retry; the web app's one role gate draws it, web-order spec §9) |
| T12 | Onboarding | Single centered checklist | — | — | content | New org, empty environment |
| T13 | Setup | The Shell's geometry with the setup sidebar (§6.13 `context.kind: "setup"`: the setup home and the steps as navigation), the content area, the status bar (§5.5) | — | — | the page's own (content) | The workspace while the org has no model or no agent (web-order spec §3.8, web-SSR spec §4) |

### 5.5 Setup (T13)

`SetupPage({ sidebar, status, title?, children })` is the layout the app frame draws while the current org cannot run yet (web-SSR spec `docs/superpowers/specs/2026-11-01-web-ssr-design.md` §4). It has the Shell's geometry and is built on `AppShell` (§4): the Sidebar on the left, the content area (the drawer menu bar below 960, the page, the StatusBar) on the right, the same rail below 1280 and drawer below 960. The sidebar is the setup context (§6.13): `sidebar` carries the org (the switcher, as in the workspace), `home` (the setup home's link), `steps`, `activeNav` (a step id or `home`), the account, the theme and `adminHref` (enterprise admins). There is no command palette: ⌘K opens nothing and the drawer menu bar has no search button. The page brings its own template and page head in the content width: the setup home (`/`, `/chat`) is an `OverviewPage` with the path `<slug> / 开始之前`, the h1 开始之前, the progress 已完成 n / 2 as the page head's `count` beside the h1, the checklist card (no head band of its own) and 可以稍后再做 (an `h2` over an `ObjectList` of the optional steps, each an `ObjectRow` with the step's icon, its label as the linked name and one sentence saying what it is for); a step page is its own template exactly as in the shell. There is no back link (the sidebar is the way back) and no top bar.

### 5.1 List (T2)
- Order in the content column: PageHeader → StatCards (when the header has `metrics`) → the DataTable (its toolbar above the table, pagination below), separated by `space.3`.
- Rail: faceted filters; each group has a title (muted) + checkbox items + counts.
- Content = one DataTable (§6.6) on the `panel` ground (framed, as the signed reference; `framed={false}` is only for a table inside a Card), whose toolbar, bulk bar and pagination all belong to the DataTable.
- Subordinate section (optional, at most one): below the main table with a `space.6` gap, an `h2` title + one DataTable listing secondary objects closely related to the main object and few in number (such as "Invitations" on the members page, a settings page that follows the same rule); it has no filters or metrics of its own, and the create entry stays in the PageHeader. When the secondary objects need their own filters or are numerous, make a separate list page.
- PageHeader: title + total, description, secondary actions on the right + Create (primary); metrics ≤ 5 as StatCards.
- **One primary per screen**: while `empty` is drawn with a `primary` action, the template leaves the head's primary out and the empty state carries it (the head's other actions stay); with rows, while loading, or when the empty state has no primary action, the head keeps it. Pages pass the same action to both and never draw two.
- StatusBar page status: the number of filter results.
- **Variants** (`variant`): `records` (default) holds a DataTable; `objects` wraps its ObjectRows (§6.17) in one ObjectList panel (things people own and configure: agents, skills, connectors, plugins, extensions). The `callout` prop draws a Callout (§6.19) in the header between the title row and the tabs; `empty` draws an EmptyState (§6.18) instead of the content. `loading` draws skeleton rows (§6.17) instead of the content or `empty` until the first answer; the head keeps its real layout meanwhile (title, actions, tabs with counts shown as a `faint` "–", search), so nothing moves when the answer arrives. Exception: a tab that exists only when the data holds something different from 全部 cannot be known before the answer and appears after it. An object list has no rail: tabs with counts in the header replace the filters.

<!-- states: template-list -->
States: `page`

<!-- size-table: template-list -->
| Part | State | Property | Value |
|---|---|---|---|
| sidebar | page | width | layout.sidebar |
| content | page | max-width | layout.content |
| status-bar | page | height | layout.status-bar |

### 5.2 Detail (T3)
- PageHeader: path ending with the object's name; name + version (faint) + status; actions: Edit (default), Trial run (secondary), `more-horizontal`.
- PageTabs: Summary · Runs · Config · Versions · Permissions · Audit (pick per object type), with counts following in faint.
- Content: sections on the `panel` ground with radius `md` (no border), section header h2 + actions on the right, `space.4` between sections.
- Inspector: grouped properties, group title small muted, key 8ch wide muted, value single line with ellipsis.

### 5.3 Form (T4)
- PageHeader: path ending with the object's name (`new` for a new one); title "Create X" + draft badge; only auxiliary actions on the right (such as "Import from YAML").
- No anchor navigation (the Centered body has none, §4.3).
- Sections: a two-column grid, the left column 240 wide with the section title (`h2`) and a description (`prose-small` `muted`), the right column the fields on a `panel` card with radius `md`, padding `space.4`, `space.3` between fields. Sections are separated by `space.6` of spacing, **not by lines**; rows inside a list of switches are divided by `line-soft`.
- Fields: label on top (`body` `ink`; required marked with an accent `*`, optional marked "Optional" in faint); controls `default` density; help text and error message below (`small`); on error the border is `fail` and the message starts with the `circle-alert` icon and gives an actionable suggestion.
- The ActionRow is always present: Cancel · Save draft (⌘S) · Publish.
- **Create forms** (`FormPage create`, a new object): focus starts on the first field; the ActionRow never says "No unsaved changes" (nothing exists yet to be unchanged; typed fields still count as unsaved and guard leaving); the primary is disabled until the form is valid (the required fields filled), as in a create dialog. A create form whose prerequisite is missing (no channel extension enabled for 新建渠道) draws only the `EmptyState` with the next step, never the form.

<!-- states: template-form -->
States: `page`

<!-- size-table: template-form -->
| Part | State | Property | Value |
|---|---|---|---|
| sidebar | page | width | layout.sidebar |
| content | page | max-width | layout.content |
| action-row | page | height | layout.action-row |
| status-bar | page | height | layout.status-bar |

### 5.4 Conversation (T7)

`ConversationPage` (it replaced `PlaygroundPage`, which only the conversation page used; removed with UI refresh B). Signed off with reference set B on 2026-10-27; UI refresh spec §5.

- **Columns**: the sidebar (§4.1) | the middle column | the right area.
  - The **middle column** holds, top to bottom: the title bar (§6.16.1), the thread (centered, at most `layout.chat` wide, gutters `layout.gutter`, padding `space.4` on top, items `space.3` apart, following the bottom while the reader is at the bottom), the composer (§6.16.2, at most `layout.chat` plus the gutters wide, centered, `space.3` from the status bar) and the status bar (§4.4). It is never narrower than `layout.chat-min`, except **below 640**, where it fills the window and the title bar, the thread and the composer use `space.4` (16) gutters, so the composer, its send button and the user bubbles never run past the right edge.
  - The **right area** holds one thing at a time: either the **properties panel** (§6.16.17), which sits *inside* the middle column under its title bar so the title bar spans thread and properties, or **one right panel** (§6.16.18), full height beside the middle column, whose title bar then narrows with it. Opening one closes the other; "none" is the default.
- **Narrow windows**: below 1280 (where the sidebar becomes the rail, §4.3) the right area is a right-side Sheet over the page (`layout.panel` wide, `shadow-sheet`, a `scrim` behind it), closed by Esc, its close button or a click on the scrim; the server render and hydration cannot know the window, so below 1280 a CSS media query hides the inline right area until the first client render makes it the Sheet (the page never scrolls sideways, no flash). At 1280 and above it sits beside the thread; with the full sidebar at exactly 1280 the panel narrows to 544 so the thread keeps `layout.chat-min` (maintainer ruling 2026-10-27).
- **New conversation**: nothing is created until the first send. The title bar shows "新会话" / "New conversation"; the thread is replaced by a centered column (`layout.chat` wide): the agent's name (`h2`), its description (`prose-small` `muted`) and the composer with the agent picker open for choice; the status bar shows only the context and the version.
- **Status bar** (read-only, §4.4): left `user@org:/chat/<id>` and "第 N 轮 · 已用 <elapsed>" / "Turn N · <elapsed>"; right the run status ("空闲" / "Idle", "运行中" / "Running", "等待批准" / "Waiting for approval"), "上下文 N%" / "Context N%" and the version.
- Extension slots, files and sub-agents: §6.16.16–§6.16.18, §6.16.15.

<!-- states: template-conversation -->
States: `properties`, `file-panel`, `subagent-panel`, `new`, `sheet`

The two `right-panel` widths of 544 hold only at the width the `template-conversation` blocks render (a 1280 window with the full sidebar): 1280 − `layout.sidebar` (256) − `layout.chat-min` (480). At other widths the panel follows the clamp in §6.16 (right panel).

<!-- size-table: template-conversation -->
| Part | State | Property | Value |
|---|---|---|---|
| sidebar | properties | width | layout.sidebar |
| title-bar | properties | height | layout.title-bar |
| thread | properties | max-width | layout.chat |
| properties | properties | width | layout.properties |
| status-bar | properties | height | layout.status-bar |
| right-panel | file-panel | width | 544 |
| title-bar | file-panel | height | layout.title-bar |
| thread | file-panel | max-width | layout.chat |
| right-panel | subagent-panel | width | 544 |
| title-bar | new | height | layout.title-bar |
| new-conversation-body | new | max-width | layout.chat |
| sidebar | sheet | width | layout.sidebar-rail |
| right-panel | sheet | width | layout.panel |
| status-bar | sheet | height | layout.status-bar |

---

## 6. Components

All components provide these states where applicable: default, hover, pressed, focus, disabled and loading, in both dark and light. A component that is part of the reference set has a **state list** and a **size table** in the machine-readable formats of §9.2; `/dev/ui` renders one block per listed state with the same id.

Every glyph in this section is an `Icon` of §2.6 (rule `design-char-icon`).

### 6.1 Button

| Variant | Default | Hover | Pressed | Purpose |
|---|---|---|---|---|
| primary | `accent` ground, `on-accent` text, 600 | `accent-hover` ground | `accent-press` ground | The only primary action of a view |
| secondary | transparent, 1px `accent` border and text | `accent-tint` ground | accent @ 20% ground | Secondary actions that need emphasis |
| default | transparent, 1px `line` border, `ink` text | `hover` ground | `selected` ground | Ordinary actions |
| ghost | no border, `muted` text | `hover` ground + `ink` text | `selected` ground | Cancel, low priority |
| danger | transparent, 1px `line` border, `fail` text | `hover` ground, `fail` text | fail @ 20% ground | Entry point of a dangerous action |
| danger-solid | `fail` ground, `on-accent` text | — | — | Only in a dangerous-confirmation dialog, once the confirmation condition is met |

- Density steps: `dense` height 24, padding `pad.dense.x`, gap `space.1`; `default` 28, padding `pad.default.x`, gap `space.2`; `prominent` 32, padding `space.4`. Radius `sm`. Icon buttons are square at the step's height (`IconButton`, icon 16 at default / prominent, 14 at dense); their icon is `muted` in every variant and turns `ink` on hover.
- Hover transitions background, border and color over `motion.hover`.
- Disabled: `faint` text, `line-soft` border (a disabled ghost button too), transparent ground; a disabled primary gets the `selected` ground and weight 400; `cursor: not-allowed`.
- Loading: the `spinner` icon (14) before the label, in flow (the button grows by the icon and its gap), the variant's colors kept, no repeated clicks (`aria-busy`).
- A shortcut hint follows the label in the form `⌘S` (`faint`).
- A button that navigates is a link drawn as the button: `LinkButton({ href, variant, density })` (`primary` / `secondary` / `default`), the same steps, colors and states, through the DesignProvider's `link`; never the browser's link colors (the extension detail's 升级).

<!-- states: button -->
States: `default-step`, `dense-step`, `prominent-step`, `hover`, `focus`, `disabled`, `loading`

<!-- size-table: button -->
| Part | State | Property | Value |
|---|---|---|---|
| button[data-variant=primary] | default-step | height | control.default |
| button[data-variant=primary] | default-step | padding-left | pad.default.x |
| button[data-variant=primary] | default-step | border-radius | radius.sm |
| button[data-variant=primary] | default-step | font-size | type.body |
| button[data-variant=primary] | default-step | background-color | color.accent |
| button[data-variant=primary] | default-step | color | color.on-accent |
| button[data-variant=secondary] | default-step | border-top-color | color.accent |
| button[data-variant=default] | default-step | border-top-color | color.line |
| button[data-variant=default] | default-step | color | color.ink |
| button[data-variant=ghost] | default-step | color | color.muted |
| button[data-variant=danger] | default-step | color | color.fail |
| icon-button | default-step | width | control.default |
| icon-button | default-step | height | control.default |
| icon-button | default-step | color | color.muted |
| button[data-variant=primary] | dense-step | height | control.dense |
| button[data-variant=primary] | dense-step | padding-left | pad.dense.x |
| icon-button | dense-step | width | control.dense |
| button[data-variant=primary] | prominent-step | height | control.prominent |
| button[data-variant=primary] | prominent-step | padding-left | space.4 |
| icon-button | prominent-step | width | control.prominent |
| button[data-variant=primary] | hover | background-color | color.accent-hover |
| button[data-variant=default] | hover | background-color | color.hover |
| button[data-variant=ghost] | hover | color | color.ink |
| button[data-variant=primary] | focus | outline-color | color.accent |
| button[data-variant=primary] | focus | outline-width | 2 |
| button[data-variant=primary] | disabled | background-color | color.selected |
| button[data-variant=primary] | disabled | color | color.disabled |
| button[data-variant=default] | disabled | border-top-color | color.line |
| button[data-variant=ghost] | disabled | border-top-color | color.line |
| button[data-variant=primary] | loading | height | control.default |

### 6.2 Input / Select / Textarea / Stepper
- Height `control.<step>` (28 by default), inner padding `space.2`, 1px `line` border, radius `sm`, transparent ground, `body` type.
- Focus: `accent` border + 3px `focus-ring` halo (§2.5); error: `fail` border; disabled: `line` border, `hover` ground, `disabled` text. Hover and focus transition border and halo over `motion.hover`.
- Prefix / suffix use `faint` / `muted` icons (such as `search`, `chevron-down`, `⌘K`).
- Field: label on top (`body` `ink`), help and error below (`small`; error `fail` with `circle-alert` 12), `space.1` between them.
- A Textarea is two lines high unless `rows` asks for more. A Textarea with a character count shows `n / max` (muted) at the bottom right. Prose textareas (descriptions) use `prose-small`; prompts and code use the mono font.
- Textareas are plain, as the signed reference: no line-number gutter and no resize grip (`resize: none`). Code-like input (prompts, JSON) keeps lines unwrapped in the mono font (`code`); read-only code is shown by CodeBlock (§6.9).
- Stepper: `− value +`, with square buttons at the step's height on both sides.
- Slider: a discrete block track (20 cells by default, cell width adaptive, 2 between cells, 8 high); the selected part is `accent` and the rest `line`; the thumb is a 4×16 `ink` vertical bar; keyboard ←→ by step, PageUp/PageDown by 10 steps; can be linked with a value input box on the right (8ch wide). When no value is set, the thumb is centered and the track is all `line`, so it doesn't pretend to be some value.
- Reset to default: when a field has been set by the user, a ghost small link "Reset to default" with the `refresh` icon appears on the right of the label row; clicking clears the value and returns to the default display.

<!-- states: input -->
States: `default`, `focus`, `error`, `disabled`

<!-- size-table: input -->
| Part | State | Property | Value |
|---|---|---|---|
| input | default | height | control.default |
| input | default | width | 320 |
| input | default | border-radius | radius.sm |
| input | default | border-top-color | color.line |
| input-control | default | padding-left | space.2 |
| input-control | default | font-size | type.body |
| input-control | default | color | color.ink |
| field-label | default | color | color.ink |
| field-label | default | font-size | type.body |
| input | focus | border-top-color | color.accent |
| input | error | border-top-color | color.fail |
| field-error | error | color | color.fail |
| field-error | error | font-size | type.small |
| input | disabled | background-color | color.hover |
| input | disabled | border-top-color | color.line |
| input-control | disabled | color | color.disabled |

### 6.3 Checkbox / Radio / Switch / option card
- Checkbox and radio are 14×14 with radius `sm` (radio round). Checkbox checked: `accent` ground + `on-accent` `check` icon; indeterminate `minus`. Radio checked: `accent` border + a 6×6 `accent` inner dot.
- Switch: a `space.7` × `space.5` (32 × 20) track with radius `bubble` and 2px padding, a `space.4` (16) round knob; off: `line` track + `muted` knob; on: `accent` track + `on-accent` knob moved right by `space.3`; the knob moves over `motion.hover`. Where a switch stands alone its label and current state ("On" / "Off", muted) are shown as text next to it, so the state never relies on color: `SwitchField` draws that row, `control.default` high with `space.2` gaps (clicking the label toggles too).
- Switch list (`SwitchList`, a form's tools and similar lists): one `row.roomy` row per item with the name and a `small` prose `muted` description (each one line with an ellipsis), `muted` `small` meta text (such as the policy) and the switch; padding `space.4`, rows divided by `line-soft`; it sits in a `flush` FormSection card.
- Option card (rich option of a single choice): 1px `line` border, radius `md`; selected: `line-strong` border + `selected` ground (neutral, §2.3), the radio dot in `accent`.

<!-- states: switch -->
States: `default`, `selected`, `focus`

<!-- size-table: switch -->
| Part | State | Property | Value |
|---|---|---|---|
| switch-field | default | height | control.default |
| switch | default | width | space.7 |
| switch | default | height | space.5 |
| switch | default | border-radius | radius.bubble |
| switch | default | background-color | color.line |
| switch-knob | default | width | space.4 |
| switch-knob | default | height | space.4 |
| switch-knob | default | background-color | color.muted |
| switch | selected | background-color | color.accent |
| switch-knob | selected | background-color | color.on-accent |
| switch | focus | outline-color | color.accent |
| switch | focus | outline-width | 2 |

### 6.4 Tabs / Segmented / Pagination
- Tabs: text + underline when selected (§2.3); hover `hover` ground; disabled `disabled`. In the page head's tab row the underline sits on the row's bottom border (§4.2). Tabs stay on one line at every width (a tab never wraps its label); a row of tabs that does not fit scrolls sideways without a drawn scrollbar, and since the row clips, a tab's focus ring is drawn inside it.
- Segmented in a form field takes the field's width with equal segments (`fill`).
  - Count `count`: a small `muted` number after the name.
  - Badge `badge` (such as Inspector "Tasks 2/4"): 1px `line` border, small `muted`, radius `sm`; when selected `ink` text.
  - Alert `alert` (such as "Runs" having something to approve): a small accent dot after the name, with screen-reader text "needs attention", so it doesn't rely on color alone.
- Segmented: one `line` border around the group, radius `sm`, height `control.<step>`, 2px inner padding and gap; each segment has radius `sm` and padding `space.2`, `muted` text; the selected segment gets the `selected` ground + `ink` text (no accent).
- Pagination (the signed reference): on the left "共 N 个 · 第 x / y 页" / "N total · page x / y" (`small`, `muted`, tabular figures), then the optional per-page select, then the icon-only previous / next buttons (`chevron-left` / `chevron-right`, `default` variant, `dense`) at the right edge, `space.2` apart. No page-number buttons.

<!-- states: segmented -->
States: `default`, `selected`, `focus`

<!-- size-table: segmented -->
| Part | State | Property | Value |
|---|---|---|---|
| segmented | default | height | control.default |
| segmented | default | border-radius | radius.sm |
| segmented | default | border-top-color | color.line |
| segment[aria-checked=false] | default | color | color.muted |
| segment[aria-checked=false] | default | padding-left | space.2 |
| segment[aria-checked=false] | default | border-radius | radius.sm |
| segment[aria-checked=true] | selected | background-color | color.selected |
| segment[aria-checked=true] | selected | color | color.ink |
| segment[aria-checked=true] | focus | outline-color | color.accent |
| segment[aria-checked=true] | focus | outline-width | 2 |

### 6.5 Badge / Kbd / Tooltip / metrics
- Badge: 1px `line` border, small, radius `sm`, 6 left and right; the emphasis version is outlined in the accent color; the count version is `selected` ground with `ink` text.
- Kbd: 1px `line` border + 2px bottom edge, radius `sm`.
- Tooltip: `panel` ground + `line-strong` border + `shadow-1`, radius `sm`, small, padding `pad.dense`, 400ms delay.
- Up / down: `trending-up` 8.2% (ok) / `trending-down` 1.1s (fail) — up and down are the one place `ok` is shown.
- KeyValue: a key-value list (Inspector property groups, detail sections); key muted with a fixed 8ch width, value single line with ellipsis.
- Disclosure: an expandable block (a skill body, a license text). The summary line is the toggle button (`aria-expanded`, `aria-controls`, a `faint` `chevron-right` / `chevron-down` icon (12) on the right, `hover` ground, same row style as ThinkingRow); closed by default (`defaultOpen` opens it); once open, the body follows `space.1` below under a 1px `line` guide on the left, indented `space.2`. The body is rendered only while open. Not in the reference set: no state list or size table yet (like KeyValue).
- Metrics on list pages are StatCards (§6.14).
- TextLink: an in-site text link drawn through the DesignProvider's `link` (§6.7 Links): `ink` text, a `line-strong` underline offset 3px that turns `ink` on hover, the accent focus ring; visited links keep `ink`. Pages never show the browser's link colors.
- LinkCard: a card that leads to another page (not used by the admin overview any more: its numbers link to their pages, §6.14, and the sidebar leads to the rest): `panel` ground, radius `md`, padding `space.4`, `space.2` apart: the title (`body`, 500), a `prose-small` `muted` description, and one TextLink with a `faint` `chevron-right` (12). Not in the reference set (like KeyValue).

### 6.6 DataTable
Structure, top to bottom: toolbar / bulk action bar → the table (header and rows on the `panel` ground, **square, no border**) → pagination. The toolbar and pagination sit on the page ground outside the panel.

- **Density**: the rows (row menus, inline controls) and the pagination are `dense` (`DensityContext` around the body); the toolbar, the bulk action bar and the empty-state actions are `default`, as the signed reference draws them, so the toolbar has the height of the page's other controls.
- Toolbar: search (240 wide, `search` icon prefix, `/` focuses), filter chips (§6.15), clear all; at the right end (`toolbarEnd`, right-aligned as the signed reference) sort, view switch, column settings. It has the same height as the bulk action bar so nothing jumps when one replaces the other in place.
- Bulk action bar: when ≥1 row is checked it **replaces the toolbar in place**, `panel` ground, radius `sm`, left "N selected" (600) + bulk actions, right "Deselect Esc". An accent border or ground must not be used.
- Header: `row.dense` high, padding `space.2`, `small` `muted`, weight 400; the column being sorted is `ink` + `arrow-down` / `arrow-up`; a sortable column shows `arrow-up-down` and a `hover` ground on hover.
- Name cell of a roomy row: `CellTitle` (an optional initial tile, `control.dense` square on `selected` with radius `sm`, then the name and a `small` prose `muted` description, each one line with an ellipsis). A row is named by its first cell (the row checkbox reads "Select {name}"): a plain-text cell, or the `title` of a `CellTitle`; `rowLabel` overrides it.
- Rows: height by `rowHeight`: `dense` 28, `default` 32, `roomy` 44 (two lines: name + a `small` prose description, or a thumbnail). Cell padding `space.2` horizontally, the first and last columns `space.3` toward the edge. Row dividers are 1px `line-soft` above each row; no outer border. Success in a status column has no mark (§2.4).
- Alignment: numbers, durations and amounts are right-aligned; IDs and times are left-aligned; IDs and times use `muted`. An overlong single line is truncated with an ellipsis and the full text is shown on hover with a native `title`. A column marked `wrap` (a short list that must stay readable, such as a model's capabilities 「工具 · 图片 · 推理」) wraps onto more lines instead, never an ellipsis: the row grows, the extra lines get `space.1` above and below; names and ids never wrap. A wrap cell given a list of strings draws them joined by 「 · 」, each item with its separator as one no-break unit, so lines break only between items (never inside 「缓存」, never before a 「·」).
- Row states (priority from high to low when they occur together): focus ring > selected > checked > hover > default. They paint the row ground, transitioning over `motion.hover`.
  - Hover: `hover` ground; the checkbox border turns `ink`.
  - Selected (opens the detail / Inspector): `accent-tint` ground + a 2px accent bar on the left (§2.3).
  - Checked: only the checkbox turns accent; the row ground is unchanged.
  - Focus: 1px inner outline in the accent color.
  - Disabled / archived: the whole row is `faint` and cannot be checked.
- Inline menu `more-horizontal` (a dense icon button, right-aligned in a 48-wide last column: `control.dense` + `space.3` on both sides): ≤5 items, the dangerous item at the bottom and separated by a divider; while open, the button ground is `selected`. When a row has no available actions (none, or only disabled items) it shows no button (the cell stays, so column alignment doesn't change).
- Expanded row: `panel-2` ground, indentation and a `└` leader, showing a summary (such as the first few steps of an execution trace).
- Empty states (inside the panel, under the header):
  - Loading: skeleton rows (`row.dense` high, `space.3` bars in `selected` with radius `sm`), no spinner; the bars are hidden from assistive tech and a `status` region reads "Loading".
  - Empty (first time): the compact EmptyState (§6.18) centered horizontally in the area: the line capybara, one `ink` sentence (+ an optional `muted` hint) and the next action (`default`), `space.8` padding above and below (the page rhythm, not pinned to the top-left corner).
  - The empty states and the skeleton rows keep a row cell's horizontal padding: `space.3` at the first-column edge (left) and `space.2` on the right, as the signed reference draws its full-width cell, so their centered content sits 2px right of the panel's middle.
  - No results (caused by filters): the compact EmptyState, centered the same way, with the `search-x` icon, "No matching results", a description of the current filters and "Clear filters".
  - Error: `circle-x` + "Failed to load" in `fail`, the error code · request ID (muted) + "Retry" (`refresh`).
- **Narrow (below 640): stacked rows.** Every table becomes stacked rows; it is the table's own behaviour, no page opts in. The header row is hidden (also above an empty state). Each row is a card, `space.2` padding above and below, a `line-soft` line between rows: the first column's cell is its title line (500, at least `row.dense` high), with the row checkbox before it and the row menu after it on the same line; every other cell is one `label value` line, the label being the column header (`small` `muted`, 10ch, one line with an ellipsis; a column without a header has no label) and the value one line with an ellipsis (the full text in `title`). Cells keep the `space.3` edge padding. Nothing sticks; the selected row keeps its 2px accent bar on the card's left; the row-menu button is a 40 px square (tap target). The toolbar wraps and its search takes the full width.
- Keyboard: ↑↓ move focus, Space checks, ↵ opens, Esc deselects.
- The header is sticky; when scrolling horizontally the first column sticks to the left.

<!-- states: table -->
States: `default`, `row-hover`, `row-selected`, `loading`, `empty`, `narrow`

<!-- size-table: table -->
| Part | State | Property | Value |
|---|---|---|---|
| table | default | background-color | color.panel |
| table | default | border-radius | 0 |
| header-cell | default | height | row.dense |
| header-cell | default | font-size | type.small |
| header-cell | default | color | color.muted |
| cell | default | height | row.roomy |
| cell | default | padding-left | space.3 |
| cell | default | border-top-color | color.line-soft |
| row[data-ref-forced=true] | row-hover | background-color | color.hover |
| row[aria-current=true] | row-selected | background-color | color.accent-tint |
| skeleton-bar | loading | height | space.3 |
| skeleton-bar | loading | background-color | color.selected |
| table-empty | empty | padding-top | space.8 |
| table-empty empty-state-text | empty | color | color.ink |
| table-empty button | empty | height | control.default |
| menu-cell | default | width | 48 |
| menu-cell icon-button | default | height | control.dense |
| row | narrow | padding-top | space.2 |
| row | narrow | border-top-color | color.line-soft |
| cell[data-lead=true] | narrow | padding-left | space.3 |
| menu-cell icon-button | narrow | width | 40 |
| menu-cell icon-button | narrow | height | 40 |

### 6.7 Overlays

Selection rules: the user needs to decide → Dialog; view / edit one object without leaving the list → Sheet; in-place options / filters → Popover / Menu; feedback on an operation result → Toast (a Dialog must not be used); creating something with more than 6 fields → a form page (T4).

- **Dialog**: width 480 / 640, `panel` background + `line-strong` border + radius `md` + `shadow-2` + `scrim`. Header (h2 title + close `x`) / body (padding 16) / footer (right-aligned: ghost Cancel + primary action, the primary action carries `↵`), with 1px `line` separating header and footer. Esc closes; focus is trapped and returned after closing. Default focus: on the first field for a dialog that asks for input (新建组织, 新建令牌), else on the primary action (a `LinkButton` primary too); on Cancel for a dangerous dialog. A create dialog's primary is disabled until it is valid. A dialog that only explains why something cannot be done (退出组织 as the only owner) is not dangerous: plain title, one default button "知道了" / "Got it", and a link to where it can be fixed. A dialog whose next step lives elsewhere (加入评测集 with no eval set) says so and offers that step as its primary (`LinkButton`), never a disabled dead end.
- **Dangerous confirmation**: the ordinary frame and title (`line-strong`, `ink`): the red is only on the destructive button; explains the consequences and recoverability; the object name must be typed, the confirm button is disabled until it matches, and is danger-solid once it matches.
- **Sheet**: slides out from the right, width 480 / 720, `panel` background + `line-strong` left line + `shadow-sheet`; no scrim by default (the list is still operable). Header: name + version + open in a new page `external-link` + close `x`; may contain Tabs; footer: actions. Closing with unsaved changes needs a second confirmation.
- **Links**: the design package is framework-agnostic; links in the sidebar navigation, the PageHeader path, Tabs, Sheet, TextLink and LinkCard are rendered through the `link` component of `DesignProvider` (default `<a>`); `apps/web` passes next-intl's `Link` to get client-side navigation and the locale prefix. Pages should not build `<a href>` themselves for in-site navigation.
- **Popover / Menu**: `panel` background + `line-strong` border + radius `md` + `shadow-1`; menu items are `row.default` high with padding `pad.default.x`; a filter Popover has a search `>` at the top and "Clear / Apply ↵" at the bottom; a hovered item gets a `hover` background. The trigger button is outlined in the accent color when open and holding a value.
- **No menu of one**: an overflow menu (`more-horizontal` in a page head or an object row, More on the conversation title bar) is drawn only when it holds two or more actions a person can take, or one destructive one (separators and disabled items don't count). With none it is not drawn; with one safe action, that action is drawn directly in its place (a button or link). A destructive (`danger`) action is never promoted out of its menu: a menu whose only action is dangerous stays a `more-horizontal` menu with that one item. A table's row menu keeps its column, so a row with one action keeps `⋯`, and a row with none shows no button (§6.6). Never list an action twice on one screen (a menu item that repeats a visible button, the name link or a sidebar entry).
- **Command palette (⌘K)**: width 560, input with a `>` prefix; group titles small faint; the current item has the `selected` background + a 1px `line-strong` outline (neutral, §2.3); key hints at the bottom.
  - **Items** are one `row.dense` line, gap `space.2`: the label (`ink`), then an optional hint (`faint`, a skill's argument hint "[issue-number]"), then optional tags (`micro` `muted` on the `selected` ground, radius `sm`, padding 0 `space.1`, the picker-menu tag), then an optional description (`muted`, filling the rest of the line with an ellipsis), then an optional source, a secondary label (`small` `faint`, at the end of the line: the plugin a skill comes from, "superpowers"), then an optional shortcut (`Kbd`, at the end).
  - **Filtering and ranking**: the query (a leading `/` ignored, case-insensitive) matches the label, an item's extra search text (not shown; e.g. a skill's qualified name "superpowers:brainstorming") and the description. Order: label prefix, then search-text prefix (also after a `<plugin>:`), then label substring, then search-text substring, then description substring; anything else is hidden. Groups follow their best item.
  - The composer's `/` menu is this palette (phase D): the "Skills" group first (sorted by name, tags "manual" / "sub-agent", the argument hint, the plugin as the source), then the connector prompt groups.

<!-- states: command-palette -->
States: `skills`, `filtered`

<!-- size-table: command-palette -->
| Part | State | Property | Value |
|---|---|---|---|
| palette | skills | background-color | color.panel |
| palette | skills | border-top-color | color.line-strong |
| palette | skills | border-radius | radius.md |
| palette-input | skills | height | control.prominent |
| palette-item | skills | height | row.dense |
| palette-item[data-selected=true] | skills | background-color | color.selected |
| palette-hint | skills | color | color.faint |
| palette-tag | skills | font-size | type.micro |
| palette-tag | skills | background-color | color.selected |
| palette-tag | skills | color | color.muted |
| palette-desc | skills | color | color.muted |
| palette-source | skills | color | color.faint |
| palette-source | skills | font-size | type.small |
| palette-item | filtered | height | row.dense |
| palette-item[data-selected=true] | filtered | background-color | color.selected |
- **Toast**: stacked at the bottom right, `panel` background + `line-strong` border + radius `md` + `shadow-1`, a 2px status-color bar on the left (ok / accent / fail); success auto-dismisses after 4s; an error must be dismissed manually and may carry "View →"; a progress type carries a segmented progress bar.

### 6.8 Charts
- Bar charts stack discrete blocks (pixel style), `line-strong` for normal values, `fail` marks the failure count, and the current period uses the accent color.
- Mini trend Sparkline (inside tables): 12 square bars 4px wide, `muted`.
- The `fail` in a bar chart is a subset of `value` (the total): the bar height = the total, and the failure count is drawn as blocks at the top of the bar.
- Axis labels small faint; no grid lines.

### 6.9 Conversation timeline and plugin view building blocks

Components shared by the conversation stream (modeled on the Claude Code VS Code extension) and plugin views (rendered from a schema, see `docs/superpowers/specs/2026-10-21-chat-panel-plugin-ui-design.md` §3–§4). The components take only plain props and do not depend on SDK types; text can be overridden through `labels`, and defaults to the design package's own i18n.

- **Timeline / TimelineItem**: an ordered list; each step has a 7×7 square marker on the left, and a 1px `line-strong` vertical line strings the steps together (the first item starts at the marker, the last ends at the marker). Markers: `dot` (`muted` solid, completed), `hollow` (`faint` border, hollow, thinking / secondary), `running` (accent solid, blinking, static under reduced motion), `error` (`fail` solid).
- **ThinkingRow**: one `muted` line "Thought for N seconds" (seconds rounded); when there is body text the whole row is an expand button (`aria-expanded`, `chevron-right` / `chevron-down` `faint` on the right), and once expanded the body is `muted`, with a 1px `line` guide on the left, preserving line breaks.
- **ToolCallRow** (superseded by the tool group and tool row of §6.16.8–§6.16.10, together with IoBlock, Timeline and the Inspector-only Checklist; kept until the conversation page moves over, then deleted): by default only one line: tool name (600) + a one-sentence description (`muted`, single line with ellipsis) + a `StatusMark` for non-completed states (running / failed / cancelled) + `▸` on the right. The whole row is an expand button, with a `hover` background on hover. On error the tool name is `fail`; when cancelled it is `muted`. Once expanded, inside a 1px `line` frame come two `IoBlock`s, IN and OUT (no OUT while running); when the output is truncated, the bottom shows small `faint` "Output too long, truncated" + a "View full output" text button (leaving it to the caller to fetch the full text from the archive).
- **IoBlock**: `panel` background; a 5ch label column on the left (`IN` / `OUT`, 11px 600 `faint`, right line `line`), and monospace raw text on the right (line breaks preserved, long words broken); IN is `ink`, OUT is `muted` (`fail` when the tool errored). Beyond `collapsedLines` (default 12) lines only the first N lines are shown, with an "Expand all (M lines)" / "Collapse" text button below (`aria-expanded`).
- **Checklist**: each item is `icon + text`. `pending` `square` `faint`; `in_progress` `spinner` accent, the whole row gets an `accent-tint` background + a 2px accent bar on the left + 600, `aria-current="step"`; `completed` `check` `muted` (success is not colored, §2.4), text `faint` and struck through with `<s>`. Each item carries screen-reader status text (To do / In progress / Done). An item with an id carries it as `data-ui-item` (a right panel scrolls to it); an item with an open target (§5.3 linkage) renders its text as a link button.
- **CodeBlock**: 1px `line` frame, `panel` background; when there is a language, an 11px `faint` language label at the top + a bottom line; body monospace, no wrapping, horizontal scrolling inside the frame; no syntax highlighting.
- **EmbedFrame**: the **only** component in the UI that renders an iframe (`apps/web` must not write an iframe itself). `sandbox` is fixed to `allow-scripts allow-forms` (never containing `allow-same-origin`), `referrerpolicy="no-referrer"`, `title` is required; width fills, height comes from props (default 360); 1px `line` border, `panel` background. Only `message` events whose `event.source` is this iframe are passed to `onMessage` (the caller parses and validates the content), and the iframe is exposed through `frameRef` for `postMessage`.
- **ImageBlock**: an image in a plugin view; block-level, width not exceeding the container, scaled proportionally, 1px `line` border; `loading="lazy"`, `referrerpolicy="no-referrer"`. It takes only an address and alt; it renders only absolute http(s) addresses, and anything else (`javascript:`, `data:`, relative paths) renders nothing.
- **AttachmentChip** (its looks are superseded by the attachment strip of §6.16.21; the behavior below stays): an uploaded file waiting to be sent in the input box. A line with a 1px `line` border and `panel` background: file name (single line with ellipsis, at most 24ch) + size (small `muted`, `B` / `KB` / `MB`) + a remove button on the right (an `x` icon button, `aria-label` "Remove <file name>"). Three states (`data-status`): `uploading` shows a 4px segmented progress bar under the name (`role="progressbar"`, `aria-valuenow` 0–100, completed segments accent, the rest `line-strong`, consistent with the Toast progress); `ready` has no progress bar; `error` has a `fail` border and small `fail` error text under the name (`role="alert"`), and can still be removed; when the caller supplies a retry, an extra `refresh` icon button appears to the left of the remove button ("Retry <file name>").
- **FileDrop**: a drag-and-drop / paste area wrapping the input area. When content carrying files is dragged in (only `Files` is recognized; dragging text does not respond) an overlay covers the area: `accent-tint` background + 1px dashed `accent` border, with one centered line of hint text (passed in by the caller); dropping hands the files to `onFiles`. Pasting a clipboard containing files inside the area also hands them to `onFiles`; when the clipboard has no text, the default paste is prevented, while if it also has text (such as copied from a document) the text is pasted as usual; a paste without files is unaffected. The overlay is always dismissed on drop and dragend. When `disabled` neither responds. `dragging` can force the overlay to show (for the catalog page and screenshots).
- **FileButton**: a file-picking button. It looks like `IconButton` (default `+`, `aria-label` passed in by the caller); clicking opens the system file picker (a hidden `input type=file`, with `accept` / `multiple` settable), and after selection the files are handed to `onFiles` and the input is cleared so the same file can be chosen again.
- **AttachmentPreview**: an attachment in a message. `kind="image"` is a thumbnail: at most 240×160, cropped proportionally to fill (`object-fit: cover`), 1px `line` border, `loading="lazy"`, `referrerpolicy="no-referrer"`; `kind="file"` is a file card: 1px `line` border, `panel` background, `file` `muted` on the left, file name (single line with ellipsis) + small `muted` description below (such as the type). Both are links that open in a new tab (`target="_blank"`, `rel="noopener noreferrer"`), with a `line-strong` border on hover. Addresses accept only absolute http(s) addresses and same-origin absolute paths: a raw string containing any ASCII control character, whitespace or `\` is rejected outright (browsers strip tabs / newlines, so `/\t/evil` would become `//evil`), and one starting with `/` is resolved against a placeholder origin whose origin must stay unchanged; anything else (`javascript:`, `data:`, protocol-relative addresses, relative paths) renders no link and no image, and shows only the file name. When an image fails to load, `onImageError` is called; when `retry` is greater than 0 the image address gets the cache parameter `retry=<n>` and reloads (the link is unchanged); when `onOpen` is given, an unmodified left click is handed to the caller to open.
- **Card `tone="accent"`**: superseded on the conversation page by §6.16.11–§6.16.13, where only the pending approval keeps the `accent` outline (the question and connect cards use `line`).
- Charts keep using `BarChart` / `Sparkline` from §6.8, property lists keep using `KeyValue`, and tables keep using DataTable; none is reinvented.

### 6.10 Span waterfall (SpanWaterfall)

The waterfall above the trace viewer (T8): the spans of the runs in one conversation laid out by hierarchy and time. It takes only plain props (`spans`, `selectedId`, `onSelect`, `labels.empty`, optional `labels.kinds`, optional `label`); span hierarchy is given by `parentId`, and the caller passes them in depth-first order.

- Span fields: `kind` (`run` / `step` / `model` / `tool` / `wait`), `label`, `startMs` (offset relative to the earliest span), `durationMs` (null if unknown), `status` (`ok` / `error` / `pending`), optional `meta` (such as the token count).
- Each span is one row (height 28), from left to right: name column (fixed 40%: indented 16 per depth level, a `kind` badge (text defaults to the design i18n: Run / Step / Model / Tool / Wait in zh, run / step / model / tool / wait in en; overridable through `labels.kinds`) 11px `faint` with a fixed width of 5ch + name single line with ellipsis + `meta` small `muted`) ｜ time track (1px `line` left line; the bar is positioned by `startMs / total duration` and sized by `durationMs / total duration`, minimum 2px) ｜ status (`StatusMark`: ok succeeded, error failed, pending running; a `wait` that has not ended is pending approval) ｜ duration (right-aligned, `6.8s` / `312ms` / `00:02:18`, `—` if unknown).
- Bar colors: ok `line-strong`; error `fail`; pending `accent` (something is happening, an extension of the §2.3 "text" role), and a span that has not ended extends from its start to the end of the time track. A `wait` bar is a 1px outlined hollow bar (waiting is not execution).
- Total duration = the maximum over spans of `startMs + (durationMs ?? 0)` (at least 1ms).
- Interaction: `role="tree"` (`aria-label` taken from `label`, default "Span waterfall"; always expanded, cannot be collapsed), each row `role="treeitem"`, with `aria-selected`, `aria-level` (depth + 1), and a row with child spans has `aria-expanded="true"`; focus stays on the tree, and the current item is indicated by `aria-activedescendant`. Clicking a row selects it; once focused, ↑ / ↓ select the previous / next, and Home / End select the first / last. The selected row gets the `selected` background + a 2px `ink` bar on the left (neutral, §2.3).
- Empty: only one line of `labels.empty` (`muted`).

---

### 6.11 Interaction

The interaction rules are part of the spec and are covered by Playwright interaction tests (§9.5).

- **Hover**: grounds transition `background-color` over `motion.hover` (120ms); borders and text color transition with them. Pressed states are instant.
- **Expand / collapse**: groups (sidebar conversation groups, tool groups, expandable rows) animate their height over `motion.expand` (160ms); the toggle is a `button` with `aria-expanded`, and its chevron (`chevron-down` expanded / `chevron-right` collapsed) changes with it.
- **Overlays** fade in with a 4px offset over `motion.overlay`; Esc closes the topmost overlay; focus is trapped while open and returned to the trigger after closing.
- **Skip link**: the AppShell's first tab stop is a "Skip to main content" link (visually hidden until focused, then a `panel` chip at the top left) that moves focus to `main`.
- **Sidebar keyboard**: Tab enters the nav list at the current item and the conversation list at the active conversation (one roving tab stop per list); ↑ / ↓ move between nav items and between conversation rows; Home / End go to the first / last; ↵ follows the link; Enter / Space on a group label toggles the group (`aria-expanded`); Esc closes the drawer and returns focus to the menu button.
- **Composer keys** (§6.16.2): ↵ sends while idle and **interjects** while a run is going; ⌘↵ (Ctrl+↵ off macOS) **queues** while a run is going and sends while idle; Shift+↵ is a newline; Esc closes the open picker menu, then the right-panel Sheet, and never stops a run (Stop stays on its button).
- **Queue** (§6.16.14): queued messages are sent one at a time after the current turn ends, each as its own user message; an interjection never touches the queue or jumps ahead of it; "Send now" turns a queued message into an interjection; while waiting for an approval or an answer the queue waits for the turn to end; a failed or stopped run pauses it until "Continue sending". The queue lives in the kernel, so it survives a reload and two tabs converge.
- **Conversation toggles**: tool lines, tool groups, tool rows, thinking rows and sub-agent rows are `button`s with `aria-expanded` and open over `motion.expand`.
- **Right panel**: the resize handle on its left edge is focusable (`role="separator"`, `aria-orientation="vertical"`, `aria-valuenow` the width): ← / → change the width by 16px, Home / End go to the minimum / maximum. The open panel's title-bar icon has `aria-pressed="true"`; opening another panel replaces it, its close button or the pressed icon closes it, and focus returns to the icon. Switching conversation closes the panel and drops the old conversation's panel, files, uploads and queue state.
- **Reduced motion**: under `prefers-reduced-motion: reduce` every transition and animation above is instant (duration ≤ 0.01ms); the spinner stops on a static frame and the streaming cursor is steady.

### 6.12 Icon

`Icon({ name, size = 16, label? })` renders one icon of the set (§2.6) as an inline `svg` (`viewBox 0 0 24 24`, `stroke: currentColor`, stroke width 1.5, round caps and joins), so it takes the surrounding text color. Sizes 16 (default, nav items, buttons), 14 (dense controls, inline with small text), 12 (inside `small` text: field errors, status cells). The names are listed in `ICON_NAMES`; `IconGallery({ size })` shows them all (catalog pages only); a new name is added to `packages/design/scripts/gen-icons.mjs`, never drawn by hand in a page.

<!-- states: icon -->
States: `set-16`, `set-14`, `set-12`

<!-- size-table: icon -->
| Part | State | Property | Value |
|---|---|---|---|
| icon | set-16 | width | 16 |
| icon | set-16 | height | 16 |
| icon | set-16 | stroke-width | 1.5 |
| icon | set-14 | width | 14 |
| icon | set-12 | width | 12 |

### 6.13 Sidebar (with the conversation list)

The left sidebar replaces the TopBar on every page (UI refresh spec §4.4). Sidebar v3 (web-order spec `docs/superpowers/specs/2026-10-31-web-order-design.md` §2.1–§2.2, the approved canvas "侧边栏组件") has **three contexts** and changes as a whole between them: the **workspace** (one org at a time, `context.kind: "work"`), the **admin console** (the whole deployment, `kind: "admin"`) and the **setup** of an org that cannot run yet (`kind: "setup"`, drawn by `SetupPage`, §5.5).

- **Frame**: width `layout.sidebar`, `sidebar` ground, a `line-soft` right divider, the full window height; padding `space.3` / `space.2` / `space.2` (top / sides / bottom) and every block `space.2` apart (the 8 px rhythm).
- **Workspace context**, top to bottom:
  1. **Brand row** (`brand-row`, `row.default`): logo (pixel unit 2) + wordmark `CAPYBARA`, then at its right end two ghost icon buttons (`control.default`, 2 apart): **search** (`search`, accessible name and native tooltip "搜索 ⌘K", opens the command palette) and the **inbox** (`inbox`, a link to `/inbox`, `sidebar-active` while current). The inbox carries a small count badge (`inbox-badge`: `selected` ground, mono `micro`, inset 2px from the box's top right, min width 14, padding 0 3px) only while something is pending (`99+` above 99, `n+` when truncated); its accessible name includes the count ("收件箱，3 项待处理"), else "收件箱".
  2. **Org switcher** (`org-switcher`): a 40 high block on `bg` with a `line` border and radius `md`: the org's initial in a 24 box (radius `sm`) on `ink` with `bg` text (mono, 600), the org's name (600) over `~/<slug> · <role>` (mono `micro`, `muted`), and a `chevrons-up-down` 14 icon. It opens the org menu (the user's orgs as `menuitemradio` items, then "创建组织…" when allowed); its accessible name is "当前组织：{org}，切换组织". This is the only place the current org is shown and switched. Without menu items it is static (not a button).
  3. **Navigation** (`nav` labelled "Main navigation", gap 2): 新会话 (`plus`), then the primary items 首页 · Agents.
  4. **更多** (`more-toggle`, `more-horizontal` + label + a `chevron-right` 12, `muted`): a button opening a **flyout menu to the right of the sidebar** (the design `Menu` with `side="right"`, anchored to the row, `space.3` past the sidebar's edge): 技能, 连接器, 插件, 渠道, 评测与运行, 组织设置 (the last three for org admins only; hiding is cosmetic, the kernel decides), then, after a separator, the org's extension pages. The row takes the `sidebar-active` ground and `ink` (`data-active`) while the current page is one of its items, and that item is marked current inside the flyout (`aria-current="page"`, `selected` ground). Enter, Space and → open it; Escape closes it and returns focus to the row. Nothing is remembered and it never opens by itself.
  5. **Conversations** (`section` labelled "会话"): take the rest of the height and scroll on their own, after a `line-soft` divider and `space.2`. See below.
  6. **管理后台** (`admin-entry`, enterprise admins only, `context.adminHref`): `admin` icon (a shield), the label and an outward `arrow-up-right` 14, `muted`, directly above the account row; it enters the admin context.
  7. **Account row** (`account`): a `line-soft` divider with `space.2` above (the block gap) and below; a 24 round initial avatar on `selected` (the name's first grapheme) + the name (no org: the switcher shows it), opening the account menu (切换组织 ▸, 语言 ▸, …, sign out); its accessible name is "账户: {name}". After it, in the same row, `ThemeToggle` (light / dark icon radio, the chosen one on `selected`). The rail has no room for it, so there the theme leads the account menu ("Theme: Light"). Menu items may open a submenu (`submenu`: a `chevron-right` mark, opens on hover, click or the right arrow). The auth pages (`AuthPage`) show `PreferenceBar` (a dense language `Select` and the `ThemeToggle`) in the bottom-right corner, `space.4` (16) inside the right dither column (16 from the edge below 640, where the columns are hidden), each control at its own width. The language is a cookie (`NEXT_LOCALE`), never part of the URL.
- **Admin context**, top to bottom: the brand row; the **context block** (`context-block`): the switcher's size and light style but static (no chevrons): a shield in the accent tint (`accent-tint` ground, `accent` icon), "管理后台" and `整个部署 · /admin` in mono; below it a link "← 回到工作区 ~/<slug>" (`back`, `row.dense`, `small` `muted`, `arrow-left` 14); the items 概览, 账号, 组织, 扩展, 企业目录, 市场, 模型, 部署设置; no conversations, no 新会话, no search or inbox buttons (⌘K still opens the palette); the account row.

- **Setup context** (`kind: "setup"`, web-SSR spec §4), top to bottom: the brand row without the search and inbox buttons; the org switcher (`context.org`, as in the workspace); the navigation (`nav` "Main navigation"): **开始之前** (`nav-item`, `diamond`, the setup home `context.home`, current when `activeNav` is `home`), then the required steps, then the label **可以稍后再做** (`step-group-label`, mono `micro` `faint`, letter-spacing 0.06em, `row.dense` high with the text at its bottom; the optional steps form a `group` it names), then the optional steps; the fill; the admin entry (`context.adminHref`); the account row. No conversations, no 新会话, no command palette. A **step item** (`step-item`, `SetupStep { id, label, state, href?, reason?, optional? }`) has the nav item's box and a state mark (`step-mark`, an `Icon` 16, never a character): `done` a `check` in `ok` (still a link), `todo` a `circle` in `muted` (a link), `waiting` a `clock` in `muted`: not a link (`role="link"`, `aria-disabled="true"`, the label `muted`, no hover ground, still a roving stop so its reason can be read) with `reason` as its second line (`step-reason`, `micro` `muted`, one line with an ellipsis), which makes the item 48 high. The current step takes the nav item's current style. Its accessible name is "{label}，{state}" (已完成 / 未完成, or the reason of a waiting step; en "{label}, {state}"). In the rail the steps are their marks alone (`row.default` squares) with the accessible name in the Tooltip to the right; the group label becomes a `line-soft` divider (`step-divider`, 24 × 1). The drawer is the full setup sidebar.
- **Pending navigation**: every design link (nav items, steps, the admin entry, the back link, conversation rows; object rows, item lists, tabs, breadcrumbs, the settings navigation) renders `LinkPendingMark` as its last child. It calls the `DesignProvider`'s `useLinkPending` (apps/web: `() => useLinkStatus().pending` from next/link, so it must sit inside the link) and, while that navigation is pending, carries `data-pending` and draws a 2 px `accent` underline along the link's bottom that sweeps left to right in `motion.cursor` (reduced motion: a still underline). Without the hook nothing is ever pending. The reference block `sidebar-pending` is the setup sidebar with one step's navigation pending.

  The overview (`OverviewPage`) is built from `Grid columns="main-side"` (a main column twice the side column; one column below 960), Cards, `ItemList` (rows of a tag, a linked title with a muted meta line, a status and actions, split by `line-soft`; an empty list shows its muted empty text) and the setup layout (§5.5) uses `StepList inset="card"` (the checklist OnboardingPage centers, filling a Card) until a model and an agent exist. A `StepList` row is the state mark (top-aligned), the label over a `small` `muted` description, and **one** thing at the right, centered with the row: 已完成 / Done (`small` `muted`) when done, else the step's `action` (the button this viewer can use, or the `small` `muted` reason it waits). There is no 待办 / To do label (a hidden one for screen readers when a step has neither) and never a disabled button next to its reason.
- **Nav items**: `row.default` high, radius `sm`, padding `pad.dense.x`, icon 16 + label (`body`, `ink`, single line with an ellipsis). The current item gets the `sidebar-active` ground, `ink` and weight 600 (§2.3); hover the `hover` ground. An item may still carry a count (`nav-count`, an `accent` pill, 18 high, radius 9, mono `micro`, `on-accent`; `99+` above 99, `n+` when truncated, the accessible name includes it); the inbox, the one item that had one, is now the brand row's button.
- **Conversation section**:
  - A header: the label `会话` (mono `micro` `faint`, letter-spacing 0.06em) and a dense filter icon button (`filter`, "筛选会话", `aria-expanded`; `accent` while a filter applies). Open, it shows a dense search input ("按标题搜索", case-insensitive title substring) and a dense filled `Segmented` (全部 / 运行中 / 等待我). The filter is controlled (`conversations.filter`): the page asks the kernel with it (`?q=`, `?state=`) and the rows shown are narrowed at once; groups without a matching row hide; no match is the compact empty state "没有匹配的会话" with 清除筛选. Closing the filter (the button or Esc in the input) clears it.
  - **Groups** by agent, most recent first: a label row (`row.dense`): the agent name (`small`, 500, `ink`; single line with an ellipsis, full name in `title`) inside a toggle button with `aria-expanded` and a `chevron-down` / `chevron-right` 12 icon, and a dense `plus` icon button "与 {agent} 新建会话". Collapse is remembered per viewer and org in `localStorage["cap.sidebar.collapsed.<orgId>"]` (a JSON array of agent ids, read and written inside try/catch; renders expanded when storage throws).
  - **Rows** (`conversation-row`, `row.dense`, radius `sm`): a 6 px state dot only for running (`ok`) or waiting for me (`warn`) (`state-dot`, `role="img"` named "运行中" / "等待我"), the title link (`conversation`, `ink`, single line with an ellipsis, full text in `title`), and the `⋯` menu (`row-menu`, 22 square, `more-horizontal` 14): 重命名 / 归档 / 删除 (danger, last). The menu button shows on hover, on focus within the row and on the current row; Tab reaches the menu of the row holding the list's tab stop. The current row gets the `sidebar-active` ground. An untitled conversation reads `未命名会话 · MM-DD HH:mm` / `Untitled conversation · MM-DD HH:mm` (its start time).
  - **重命名** is inline: a dense input with the title, focused and selected; Enter saves (trimmed; empty is not allowed and marks the input invalid), Escape cancels; focus returns to the row. **删除** asks first with `Dialog` (danger; "删除会话？", the title in the body; 取消 is focused). **归档** archives at once.
  - Each group shows its 5 most recent conversations, then "显示更多" (or "再显示 N 个" when the count is known; `small` `faint`, 26 high); the list shows 20 groups, then "更多分组".
  - **Archived**: `已归档 · N` (`archived-entry`, `archive` 14, `small` `faint`) at the end of the list when N > 0 swaps the list **in place** for the archived conversations: a header `← 已归档 · N` (`archived-back`, `ink`, 600; accessible name "返回会话列表：已归档 · N") returns; archived rows' menu offers 取消归档 and 删除; group ＋ buttons hide; the filter applies to it too. No separate page.
- **States of the conversation section**: empty: the compact EmptyState (§6.18) "还没有会话" / "No conversations yet" with a 新会话 link (the archived list: "没有已归档的会话"; a filter matching nothing: "没有匹配的会话" + 清除筛选); loading: skeleton bars (`space.3` high, `selected`, radius `sm`) in three groups (3, 2, 2), `aria-busy`, no spinner; error: `circle-alert` + "会话列表加载失败" / "Couldn't load conversations" in `fail` and a dense ghost "Retry" (`refresh`).
- Long titles and agent names (40+ CJK characters without spaces) truncate to one line and never widen the sidebar.
- **Rail** (below 1280): width `layout.sidebar-rail`, icons only: the brand row is the logo alone; under it the expand button (`panel-left`, "Expand sidebar", opens the drawer), then search and the inbox as rail icons (the inbox badge as in the brand row); the org initial (a button opening the org menu, named as the switcher; the admin context shows the shield and the back arrow), 新会话, the primary items (each `row.default` square, accessible name kept, a Tooltip with the label to the right, past the rail's edge, on hover and focus), 更多 as one `more-horizontal` button opening the same flyout (on `sidebar-active` while the current page is inside), the admin entry and the account. Hover over the current item takes the `hover` ground (the signed rail reference). No conversations.
- **Drawer** (below 960): the full sidebar slides in from the left over a `scrim`, with `shadow-float`, opened from the menu button in the drawer menu bar; its brand row carries a close button (`x`), and the drawer menu bar carries the search button (`search`, at its right end) so the command palette stays reachable by pointer below 960. Esc, the close button and route changes close it; focus returns to the menu button. The drawer is the touch form: its rows (nav items, the back link, group heads, conversation rows, the archived entry) are 40 high and a conversation row's menu is a 40 px square.
- **First paint**: the full / rail / drawer variant follows the window width through CSS media queries before hydration (both panels are drawn, one shown), so the server render never draws the full 256 sidebar at a narrow width. Remembered collapsed groups apply on the first client commit (layout effects) without the height motion; the motion runs only after the viewer toggles a group. The remembered collapsed list keeps at most 100 ids and drops ids of agents no longer listed once every group of that org is loaded.
- Hover never replaces the current item's `sidebar-active` ground.
- Interaction: §6.11.

<!-- states: sidebar -->
States: `default`, `item-hover`, `item-focus`, `conversation-active`, `group-collapsed`, `more-open`, `filter`, `archived`, `empty`, `loading`, `error`, `long-title`, `many-groups`, `guest`, `admin`, `rail`, `drawer`, `setup`, `setup-waiting`, `setup-hover`, `setup-focus`, `setup-rail`, `setup-drawer`, `pending`

<!-- size-table: sidebar -->
| Part | State | Property | Value |
|---|---|---|---|
| sidebar | default | width | layout.sidebar |
| sidebar | default | background-color | color.sidebar |
| sidebar | default | border-right-color | color.line-soft |
| sidebar | default | padding-top | space.3 |
| sidebar | default | padding-left | space.2 |
| org-switcher | default | height | 40 |
| org-switcher | default | background-color | color.bg |
| org-switcher | default | border-radius | radius.md |
| org-initial | default | width | control.dense |
| org-initial | default | background-color | color.ink |
| new-conversation | default | color | color.ink |
| nav-item | default | height | row.default |
| nav-item | default | border-radius | radius.sm |
| nav-item | default | padding-left | pad.dense.x |
| nav-item | default | font-size | type.body |
| nav-item | default | color | color.ink |
| nav-item[aria-current=page] | default | background-color | color.sidebar-active |
| nav-item[aria-current=page] | default | color | color.ink |
| search | default | height | control.default |
| inbox | default | height | control.default |
| inbox-badge | default | top | 2 |
| inbox-badge | default | min-width | 14 |
| inbox-badge | default | background-color | color.selected |
| more-toggle | default | height | row.default |
| more-toggle | default | color | color.muted |
| admin-entry | default | height | row.default |
| admin-entry | default | color | color.muted |
| group-label | default | height | row.dense |
| group-label | default | font-size | type.small |
| group-label | default | color | color.ink |
| conversation-row | default | height | row.dense |
| conversation-row | default | padding-left | pad.dense.x |
| state-dot | default | width | 6 |
| archived-entry | default | height | row.dense |
| archived-entry | default | color | color.faint |
| account | default | height | row.default |
| avatar | default | width | control.dense |
| nav-item[data-ref-forced=true] | item-hover | background-color | color.hover |
| nav-item[data-ref-forced=true] | item-hover | color | color.ink |
| nav-item[data-ref-forced=true] | item-focus | outline-color | color.accent |
| nav-item[data-ref-forced=true] | item-focus | outline-width | 1 |
| conversation-row[data-current=true] | conversation-active | background-color | color.sidebar-active |
| conversation[aria-current=page] | conversation-active | color | color.ink |
| group-label[aria-expanded=false] | group-collapsed | color | color.ink |
| more-toggle[data-active=true] | more-open | background-color | color.sidebar-active |
| more-toggle[data-active=true] | more-open | color | color.ink |
| archived-back | archived | height | row.dense |
| archived-back | archived | color | color.ink |
| context-block | admin | height | 40 |
| back | admin | height | row.dense |
| back | admin | color | color.muted |
| empty-hint empty-state-text | empty | color | color.ink |
| skeleton-bar | loading | height | space.3 |
| skeleton-bar | loading | background-color | color.selected |
| retry | error | height | control.dense |
| sidebar | long-title | width | layout.sidebar |
| conversation-row | long-title | height | row.dense |
| sidebar | many-groups | width | layout.sidebar |
| sidebar | guest | width | layout.sidebar |
| sidebar | rail | width | layout.sidebar-rail |
| nav-item | rail | width | row.default |
| nav-item[data-ref-forced=true] | rail | background-color | color.hover |
| inbox-badge | rail | top | 2 |
| inbox-badge | rail | right | 2 |
| inbox-badge | rail | min-width | 14 |
| inbox-badge | rail | padding-left | 3 |
| sidebar | drawer | width | layout.sidebar |
| nav-item | drawer | height | 40 |
| conversation-row | drawer | height | 40 |
| step-item | setup | height | row.default |
| step-item | setup | border-radius | radius.sm |
| step-item | setup | padding-left | pad.dense.x |
| step-item | setup | font-size | type.body |
| step-item[aria-current=page] | setup | background-color | color.sidebar-active |
| step-item[aria-current=page] | setup | color | color.ink |
| step-mark | setup | width | 16 |
| step-mark | setup | height | 16 |
| step-mark[data-state=done] | setup | color | color.ok |
| step-mark[data-state=todo] | setup | color | color.muted |
| step-group-label | setup | height | row.dense |
| step-group-label | setup | font-size | type.micro |
| step-group-label | setup | color | color.faint |
| step-item[aria-disabled=true] | setup-waiting | height | 48 |
| step-item[aria-disabled=true] | setup-waiting | color | color.muted |
| step-mark[data-state=waiting] | setup-waiting | color | color.muted |
| step-reason | setup-waiting | font-size | type.micro |
| step-reason | setup-waiting | color | color.muted |
| step-item[data-ref-forced=true] | setup-hover | background-color | color.hover |
| step-item[data-ref-forced=true] | setup-focus | outline-color | color.accent |
| step-item[data-ref-forced=true] | setup-focus | outline-width | 1 |
| sidebar | setup-rail | width | layout.sidebar-rail |
| step-item | setup-rail | width | row.default |
| step-item | setup-rail | height | row.default |
| step-divider | setup-rail | height | 1 |
| step-divider | setup-rail | width | control.dense |
| sidebar | setup-drawer | width | layout.sidebar |
| link-pending[data-pending=true] | pending | height | 2 |
| link-pending[data-pending=true] | pending | background-color | color.accent |

### 6.14 StatCards

The key metrics of a list page, as a row of cards below the PageHeader (§5.1), at most 5 (throws in development and tests otherwise).

- The row: equal-width cards, gap `space.2`. **Below 640** it is two equal columns (four metrics are 2 × 2), gap `space.2` both ways, so a label keeps its words.
- A card: `panel` ground, radius `md`, no border, padding `space.2` / `space.3`; label `small` `muted` on top, value `metric` below.
- Only warn / fail values are colored (`warn` / `fail`), and their label says what they are ("Needs authorization", "Errors"); success values are never colored.
- **Linked** (`href` on a metric, e.g. the admin overview's four numbers): the whole card is the link to the page the number counts (an `a` named by its label and value), `ink` text without an underline; hover: the `hover` ground (`motion.hover`); focus: a 2px `accent` outline, 2px offset. A pending navigation draws the link-pending mark (§6.7). Cards without `href` are not interactive.

<!-- states: stat-cards -->
States: `four`, `five`, `tones`, `link-hover`, `link-focus`, `narrow`

<!-- size-table: stat-cards -->
| Part | State | Property | Value |
|---|---|---|---|
| stat-cards | four | column-gap | space.2 |
| stat-card | four | background-color | color.panel |
| stat-card | four | border-radius | radius.md |
| stat-card | four | padding-top | space.2 |
| stat-card | four | padding-left | space.3 |
| stat-label | four | font-size | type.small |
| stat-label | four | color | color.muted |
| stat-value | four | font-size | type.metric |
| stat-value | four | line-height | type.metric.line |
| stat-value | five | font-size | type.metric |
| stat-value[data-tone=warn] | tones | color | color.warn |
| stat-value[data-tone=fail] | tones | color | color.fail |
| stat-card[data-ref-forced=true] | link-hover | background-color | color.hover |
| stat-card[data-ref-forced=true] | link-focus | outline-color | color.accent |
| stat-card[data-ref-forced=true] | link-focus | outline-width | 2 |
| stat-cards | narrow | row-gap | space.2 |
| stat-card | narrow | width | 175 |

### 6.15 FilterChip

`FilterChip({ label, count?, selected, onSelect, density? })`: a toggle (`button` with `aria-pressed`) for one filter value, used in table toolbars and above lists.

- `control.<step>` high, padding `pad.<step>.x`, radius `sm`, 1px `line` border, transparent ground, `muted` label + an optional `muted` count.
- Selected: the `selected` ground, an `ink` border and `ink` text (no accent, §2.3).
- Hover `hover` ground over `motion.hover`; focus the 2px accent outline.

<!-- states: filter-chip -->
States: `default`, `selected`, `focus`

<!-- size-table: filter-chip -->
| Part | State | Property | Value |
|---|---|---|---|
| filter-chip | default | height | control.default |
| filter-chip | default | padding-left | pad.default.x |
| filter-chip | default | border-radius | radius.sm |
| filter-chip | default | border-top-color | color.line |
| filter-chip | default | color | color.muted |
| filter-chip-count | default | color | color.muted |
| filter-chip[aria-pressed=true] | selected | background-color | color.selected |
| filter-chip[aria-pressed=true] | selected | border-top-color | color.ink |
| filter-chip[aria-pressed=true] | selected | color | color.ink |
| filter-chip[data-ref-forced=true] | focus | outline-color | color.accent |
| filter-chip[data-ref-forced=true] | focus | outline-width | 2 |

### 6.16 Conversation page components

The components of the conversation page (T7, §5.4; UI refresh spec §5), signed off with reference set B on 2026-10-27. They live in `packages/design/src/conversation/`, take plain props (no SDK types) and default their copy to the design i18n (§7). Shared rules:

- **Density**: the stream is `dense` (§2.5): tool lines, tool rows and sub-agent rows are `row.dense` high in `small` type; cards and the composer hold `default` controls.
- **Tool line**: the one-line form used by a single tool call, group headers, thinking, decided cards and captions: `row.dense` minimum height, `small` `muted`, gap `space.2`, the label on one line with an ellipsis; an expandable one is a `button` with `aria-expanded` and a `chevron-right` / `chevron-down` 12 at its end.
- **Floating cards** (inline cards, the question and connect cards, the composer, text and file outputs): `raised` ground, 1px `line` border, radius `md`, padding `space.3`. Only the **pending approval** has an `accent` border.
- **Status**: success has no mark; failure is the word "失败" / "Failed" in `fail` followed by the reason in `muted`; something running is the `spinner` (12, `accent`, one turn per `motion.spin`). Characters are never icons.
- **Load failure** of an extension block (inline card, properties section, right panel, previewer): `circle-alert` 14 + "<name> 加载失败" / "<name> failed to load" in `fail`, the reason in `muted`, and a "重试" / "Retry" link button with `refresh` 12, inside that block only; the stream and the composer keep working.
- **Link buttons** ("View full text", "Copy output", "Retry", "Open"): no ground or border, `muted` (or `fail` inside a failure), underlined in `line-strong` with a 2px offset.
- Names in the reference set are placeholders (示例组织, 研究助手, Acme …); copy comes from §7.

#### 6.16.1 Title bar

- Belongs to the middle column only and never spans the right panel. Height `layout.title-bar`, padding 0 `space.3` 0 `space.5`, no ground, no bottom line.
- Left: the path `<org slug> / <agent> /` (mono `small`, `faint`, the agent a link), spaced like the page head's path (`space.2` on both sides of every `/`), then the title button (`control.default` high, radius `sm`, padding 0 `space.2`, pulled left by `space.2`, `body` `ink`, one line with an ellipsis and the full title in `title`, then `chevron-down` 14 `muted`; `hover` ground on hover and while its menu is open). It opens a menu: Rename (`square-pen`), Copy link (`link`), a separator, Delete (`trash-2`, `fail`). Rename opens a dialog; a manual rename stops title generation for good.
- Untitled: the title reads "未命名会话 · MM-DD HH:mm" / "Untitled conversation · MM-DD HH:mm" (the start time) in `muted` until a generated or manual title exists. The new-conversation page shows only the `muted` label "新会话" / "New conversation".
- Right, two groups of ghost icon buttons (`control.default` square, radius `sm`, icon 16): group 1 is the properties toggle (`panel-right`); then a 1px × `space.4` `line` separator with `space.1` on each side; group 2 is Files (`file-text`, once the conversation has a file; it opens the newest file in the right panel, whose switcher reaches the others) and the panel icons of the extensions enabled in the org, in contribution order, then More (`more-vertical`). Icons that don't fit move into More, a menu of icon + label items; More exists only while two or more icons don't fit (one that doesn't fit takes More's slot, §6.7), and never repeats an icon on the bar. With no icon in group 2 the separator goes too. Each button's name is the panel it opens. The title and More menus hang 2px below their button. The open item's button has `aria-pressed="true"`, the `selected` ground and an `ink` icon; More is pressed while its menu is open.
- **Below 640** the bar is padded 0 `space.1` 0 `space.4` (the path on the 16 px content edge, the last icon's glyph near it), the title button is 40 high and the icon buttons 40 square (tap targets); fewer panel icons fit, and the rest go into More as above.

<!-- states: title-bar -->
States: `default`, `untitled`, `rename-menu`, `panel-active`, `overflow`, `long-title`, `narrow`

<!-- size-table: title-bar -->
| Part | State | Property | Value |
|---|---|---|---|
| title-bar | default | height | layout.title-bar |
| title-bar | default | padding-left | space.5 |
| title-bar | default | padding-right | space.3 |
| title | default | height | control.default |
| title | default | font-size | type.body |
| title | default | color | color.ink |
| title-bar-button | default | width | control.default |
| title-bar-button | default | height | control.default |
| title-bar-button | default | border-radius | radius.sm |
| title-bar-separator | default | width | 1 |
| title-bar-separator | default | height | space.4 |
| title-bar-separator | default | background-color | color.line |
| title | untitled | color | color.muted |
| title[aria-expanded=true] | rename-menu | background-color | color.hover |
| menu | rename-menu | border-radius | radius.md |
| menu-item | rename-menu | height | row.default |
| title-bar-button[aria-pressed=true] | panel-active | background-color | color.selected |
| title-bar-button[aria-pressed=true] | panel-active | color | color.ink |
| title-bar-button[aria-pressed=true] | overflow | background-color | color.selected |
| menu-item | overflow | height | row.default |
| title | long-title | height | control.default |
| title-bar | long-title | height | layout.title-bar |
| title-bar | narrow | padding-left | space.4 |
| title-bar | narrow | padding-right | space.1 |
| title | narrow | height | 40 |
| title-bar-button | narrow | width | 40 |
| title-bar-button | narrow | height | 40 |

#### 6.16.2 Composer

- `raised` ground, 1px `line` border, radius `md`, `shadow-float`, padding `space.2` `space.2` `space.2` `space.3`. While its textarea has focus: an `accent` border plus the 3px `focus-ring` halo (the input focus rule of §2.5) over the same shadow.
- Top to bottom: the attachment strip (§6.16.21) when there are attachments; the textarea (no border or ground, `prose` 15 / 26 `ink`, placeholder `faint`, one line high when empty, growing with its content up to 8 lines and then scrolling, `space.2` below it); the control row.
- **Control row**, gap `space.1`, pulled left by `space.2` so the ＋ lines up with the text: ＋ (ghost `IconButton`, `plus`, "添加附件" / "Attach files") · agent picker · model picker · effort picker · flexible space · send.
  - Pickers are ghost `default`-step buttons in `muted`: label + `chevron-down` 12, padding 0 `space.2`, opening a picker menu (§6.16.3) above them.
  - The agent picker is a picker only in a new conversation; after the first message it is plain `muted` text with no chevron (`data-locked="true"`, `title` "发送第一条消息后不能再换 agent" / "The agent can't change after the first message").
  - The effort picker is hidden when the selected model declares no `effort` values.
  - Send: a `control.default` square icon button with `arrow-up` 16 on the `accent` ground, `on-accent` icon; disabled (no text and no files) it is the `selected` ground with a `faint` icon. While a run is going it becomes Stop (`square` 14, `selected` ground, `ink` icon, "停止" / "Stop").
- Placeholders: idle "输入消息，/ 使用命令" / "Message, / for commands"; new "想让 <agent> 做什么？" / "What should <agent> do?"; while running "按 ↵ 立即发送，按 ⌘↵ 加入队列" / "↵ to send now, ⌘↵ to queue" (Ctrl+↵ off macOS). Keys: §6.11.
- Existing behavior carries over: `/` connector prompts, `@` connector resources, file drop and paste (FileDrop), at most `attachments.maxPerMessage` attachments, `clientMessageId` dedupe on retry.
- **Skill chip** (phase D, state `skill`): a skill picked from the `/` menu (or typed as `/name`) shows as a chip before the text on its first line, `space.2` from it, centered on the prose line: `control.dense` high, radius `sm`, padding 0 `space.1` 0 `space.2`, gap `space.1`, the `accent-tint` ground, the label ("/fix-issue") in mono `body` `accent`, then a remove × (`x` 12, a `type.small.line` square, `hover` ground on hover; "移除 /fix-issue" / "Remove /fix-issue"; its hit target extends invisibly to a `control.dense` square, WCAG 2.5.8). The skill's argument hint replaces the placeholder. Backspace with the caret at the start removes the chip and keeps the text; the text that follows is the skill's arguments. Removing it with the × puts focus in the text; while the chip is there the text area is described by its label (`aria-describedby`).

<!-- states: composer -->
States: `idle`, `new`, `running`, `attachments`, `focus`, `no-effort`, `skill`

<!-- size-table: composer -->
| Part | State | Property | Value |
|---|---|---|---|
| composer | idle | background-color | color.raised |
| composer | idle | border-top-color | color.line |
| composer | idle | border-radius | radius.md |
| composer | idle | padding-top | space.2 |
| composer | idle | padding-left | space.3 |
| composer-input | idle | font-size | type.prose |
| composer-input | idle | line-height | type.prose.line |
| icon-button | idle | width | control.default |
| picker | idle | height | control.default |
| picker | idle | color | color.muted |
| send | idle | width | control.default |
| send | idle | height | control.default |
| send | idle | background-color | color.selected |
| send | idle | color | color.disabled |
| composer-input | new | font-size | type.prose |
| picker | new | height | control.default |
| stop | running | width | control.default |
| stop | running | background-color | color.selected |
| stop | running | color | color.ink |
| picker[data-locked=true] | running | color | color.muted |
| attachment | attachments | border-radius | radius.sm |
| composer | focus | border-top-color | color.accent |
| send | focus | background-color | color.accent |
| send | focus | color | color.on-accent |
| picker | no-effort | height | control.default |
| composer-token | skill | height | control.dense |
| composer-token | skill | border-radius | radius.sm |
| composer-token | skill | padding-left | space.2 |
| composer-token | skill | padding-right | space.1 |
| composer-token | skill | background-color | color.accent-tint |
| composer-token | skill | color | color.accent |
| composer-token | skill | font-size | type.body |
| composer-token-remove | skill | width | type.small.line |
| composer-token-remove | skill | height | type.small.line |
| composer-input | skill | font-size | type.prose |

#### 6.16.3 Picker menu

- The model, effort and agent menus of the composer: a Menu (§6.7: `panel` ground, 1px `line-strong` border, radius `md`, `shadow-1`, padding `space.1`) opening above the composer, `space.1` from its top edge, aligned with its picker. Items are `menuitemradio`, `row.default` high, padding 0 `pad.default.x`, radius `sm`, `ink`; the selected item has `aria-checked="true"`, the `selected` ground and a `check` 14 at its end.
- **Model**: grouped by provider, each group under a label (`micro` `muted`, padding `space.2` `pad.default.x` `space.1`); the chat models of the org's enabled providers (`GET /orgs/:orgId/models`), the agent's own model first and tagged "agent 默认" / "agent default" (`micro` `muted` on the `selected` ground, radius `sm`, padding 0 `space.1`). The agent's fallback model is never listed.
- **Effort**: exactly the values the selected model declares, in the order low, medium, high, xhigh, max.
- **Agent**: the agents the person can use (new conversation only).
- A note closes each menu (`micro` `muted`, a `line-soft` top line, padding `space.2` `pad.default.x` `space.1`): model and effort "从下一条消息起生效" / "Applies from the next message"; agent "发送第一条消息后不能再换 agent" / "The agent can't change after the first message".

<!-- states: picker-menu -->
States: `model`, `effort`, `agent`

<!-- size-table: picker-menu -->
| Part | State | Property | Value |
|---|---|---|---|
| menu | model | background-color | color.panel |
| menu | model | border-top-color | color.line-strong |
| menu | model | border-radius | radius.md |
| menu | model | padding-top | space.1 |
| menu-label | model | font-size | type.micro |
| menu-label | model | color | color.muted |
| menu-item | model | height | row.default |
| menu-item | model | padding-left | pad.default.x |
| menu-item[aria-checked=true] | model | background-color | color.selected |
| menu-tag | model | font-size | type.micro |
| menu-tag | model | background-color | color.selected |
| menu-note | model | font-size | type.micro |
| menu-note | model | color | color.muted |
| menu-note | model | border-top-color | color.line-soft |
| menu-item[aria-checked=true] | effort | background-color | color.selected |
| menu-item | effort | height | row.default |
| menu-item | agent | height | row.default |
| menu-note | agent | color | color.muted |

#### 6.16.4 Prose

- Assistant text in the prose font, `prose` 15 / 26 `ink`. Blocks are separated by `space.3`; a heading gets `space.5` above it. Prose is never collapsed into a group.
- Rendered Markdown (`Markdown`, mdast to React elements, never HTML): headings (`#` to `###` as `h3`–`h5`, all `h2` type 16 / 24, 600), paragraphs, lists (indented `space.5`), blockquotes, code blocks (CodeBlock, §6.9), inline code (mono `body` on the `selected` ground, radius `sm`, padding 0 `space.1`), emphasis, strong (600), links (`ink`, underlined in `line-strong` with a 2px offset; only absolute http(s), opened with `target="_blank" rel="noopener noreferrer"`; anything else renders as text), GFM tables (mono `small`; header `muted` 400, left-aligned; cells padded `pad.dense.y` `space.4` `pad.dense.y` 0 with a `line-soft` top line per body row; numeric columns right-aligned; at most 200 rows, then "还有 N 行" / "N more rows"), thematic breaks. Raw HTML renders as text; images are not loaded (an http(s) image becomes a link with its alt text).
- **Streaming cursor** (`data-part="cursor"`, `aria-hidden`): an `accent` block `space.2` wide and `space.4` high at the end of the text, 2px after it, blinking every `motion.cursor` in steps; steady under reduced motion.
- **File path chips**: inline code or text equal to the path of one of the conversation's file outputs renders as a chip button (mono `body`, `selected` ground, radius `sm`, padding 0 `space.1`, `ink`, no underline) that opens that file in the right panel. A path that matches no file output stays plain inline code.

<!-- states: prose -->
States: `markdown`, `streaming`, `file-chip`

<!-- size-table: prose -->
| Part | State | Property | Value |
|---|---|---|---|
| prose | markdown | font-size | type.prose |
| prose | markdown | line-height | type.prose.line |
| prose | markdown | color | color.ink |
| prose-heading | markdown | font-size | type.h2 |
| prose-heading | markdown | line-height | type.h2.line |
| inline-code | markdown | font-size | type.body |
| inline-code | markdown | background-color | color.selected |
| inline-code | markdown | border-radius | radius.sm |
| md-table | markdown | font-size | type.small |
| md-table-head | markdown | color | color.muted |
| cursor | streaming | width | space.2 |
| cursor | streaming | height | space.4 |
| cursor | streaming | background-color | color.accent |
| file-chip | file-chip | font-size | type.body |
| file-chip | file-chip | background-color | color.selected |
| file-chip | file-chip | color | color.ink |
| file-chip | file-chip | border-radius | radius.sm |

#### 6.16.5 Thinking row

- Collapsed: a tool line "思考了 N 秒" / "Thought for N seconds" (seconds rounded) with a chevron; the whole line is the toggle.
- Expanded: the thinking text below it in the prose font, `prose` size, `muted`, line breaks kept, `space.3` from a 2px `line` rule on its left.
- Live: a `spinner`, "正在思考" / "Thinking" and the elapsed seconds in `faint`; the body streams with the cursor and cannot be collapsed until it ends.
- Replaces §6.9's ThinkingRow.

<!-- states: thinking-row -->
States: `collapsed`, `expanded`, `live`

<!-- size-table: thinking-row -->
| Part | State | Property | Value |
|---|---|---|---|
| tool-line | collapsed | height | row.dense |
| tool-line | collapsed | font-size | type.small |
| tool-line | collapsed | color | color.muted |
| thinking-body | expanded | font-size | type.prose |
| thinking-body | expanded | line-height | type.prose.line |
| thinking-body | expanded | color | color.muted |
| thinking-body | expanded | padding-left | space.3 |
| thinking-body | expanded | border-left-width | 2 |
| thinking-body | expanded | border-left-color | color.line |
| spinner | live | color | color.accent |
| cursor | live | width | space.2 |

#### 6.16.6 User bubble

- Right-aligned, at most 75% of the thread width: `selected` ground, radius `bubble`, padding `pad.default`, a 1px transparent border (the queued form draws it dashed), prose font `prose` 15 / 26 `ink`, line breaks kept.
- Attachments sit above the bubble, right-aligned, `space.2` apart: images as `layout.thumb` square thumbnails (radius `sm`, cropped to fill), then files as attachment chips (§6.16.21, without the remove button). Each opens like today's AttachmentPreview. A thumbnail that fails to load is reported to the caller, which may refresh the session and reload it once (as AttachmentPreview's `retry`).
- **Skill invocation** (phase D, state `skill`): the bubble starts with the skill chip, the composer's chip (§6.16.2) without its remove button: `control.dense` high, radius `sm`, padding 0 `space.2`, the `accent-tint` ground, the label ("/fix-issue") in mono `body` `accent`, centered on the first prose line, `space.2` before the text, which is the invocation's arguments (none: the chip alone). Under the bubble, right-aligned, at most 75% wide, `space.2` below it: a closed Disclosure (§6.5) "技能说明" / "Skill instructions" in `small` `muted`, a `row.dense` summary line whose chevron is `muted` too (not the Disclosure's usual `faint`), whose body is the text sent in the person's name (`small`, line breaks kept). A queued invocation (§6.16.14) shows the same chip in its dashed bubble.

<!-- states: user-bubble -->
States: `default`, `attachments`, `skill`

<!-- size-table: user-bubble -->
| Part | State | Property | Value |
|---|---|---|---|
| bubble | default | background-color | color.selected |
| bubble | default | border-radius | radius.bubble |
| bubble | default | padding-top | pad.default.y |
| bubble | default | padding-left | pad.default.x |
| bubble | default | font-size | type.prose |
| bubble | default | color | color.ink |
| thumb | attachments | width | layout.thumb |
| thumb | attachments | height | layout.thumb |
| thumb | attachments | border-radius | radius.sm |
| attachment | attachments | border-radius | radius.sm |
| bubble-skill | skill | height | control.dense |
| bubble-skill | skill | border-radius | radius.sm |
| bubble-skill | skill | padding-left | space.2 |
| bubble-skill | skill | padding-right | space.2 |
| bubble-skill | skill | margin-right | space.2 |
| bubble-skill | skill | background-color | color.accent-tint |
| bubble-skill | skill | color | color.accent |
| bubble-skill | skill | font-size | type.body |
| bubble-details | skill | font-size | type.small |
| bubble-details | skill | color | color.muted |

#### 6.16.7 Run divider

- A centered line between two 1px `line` rules that fill the width: `small` `muted`, gap `space.3`, on one line, `role="status"`.
- Kinds: **stopped** "已停止 · <who> <time>"; **failed** (the whole divider `fail`) "运行失败：<reason> · 重试" where Retry re-sends the last user message (text and files) and is folded into this divider rather than drawing a second bubble; **compacted** "较早的对话已压缩 · 节省 <n> · 查看摘要", which toggles the summary below it (`panel` ground, radius `md`, padding `space.3`, `prose-small` `muted`; the link reads "收起摘要" / "Hide summary" while open); **fallback** "所选模型 <a> 已不可用，本条起改用 agent 的模型 <b>" (a switched-to model disappeared); **hook-denied** (`fail`) "运行被扩展「<extension>」拦截：<reason>" (`run.hook_denied`).

<!-- states: run-divider -->
States: `stopped`, `failed`, `compacted`, `compacted-open`, `fallback`, `hook-denied`

<!-- size-table: run-divider -->
| Part | State | Property | Value |
|---|---|---|---|
| run-divider | stopped | font-size | type.small |
| run-divider | stopped | color | color.muted |
| run-divider | stopped | column-gap | space.3 |
| divider-rule | stopped | height | 1 |
| divider-rule | stopped | background-color | color.line |
| run-divider | failed | color | color.fail |
| run-divider | compacted | color | color.muted |
| divider-summary | compacted-open | background-color | color.panel |
| divider-summary | compacted-open | border-radius | radius.md |
| divider-summary | compacted-open | padding-left | space.3 |
| divider-summary | compacted-open | font-size | type.prose-small |
| divider-summary | compacted-open | color | color.muted |
| run-divider | fallback | color | color.muted |
| run-divider | hook-denied | color | color.fail |

#### 6.16.8 Tool group

- **One call** is a tool line: the row label (§6.16.9) and a chevron when it has detail; opening it shows the detail (or the diff) in a tool box below.
- **Two or more consecutive calls** form a group: a header tool line (the summary) and, when open, the **tool box**: `panel` ground, radius `md`, `small` type, overflow hidden, one row per call, rows divided by `line-soft`. A finished group is collapsed by default; a running group is open and its header has no chevron.
- **Summary** (copy in §7): counts by kind with each kind's verb, joined by "，" / ", " in a fixed order (commands, tools, reads, edits, as reference set B draws it); failures add "（N 个失败）" / " (N failed)" in `fail`; edits add " · +a −b" in `faint`; a group whose rows all read, or all edit, one path names it in `ink` ("已读取 示例表.xlsx"). Running: a `spinner`, the running verb of the running row's kind and " · 已完成 N 个" / " · N done" in `faint`.
- Groups sit between prose and end at prose, a user message, a human-in-the-loop card, a sub-agent group or a divider. Pages never group calls themselves: `apps/web/src/lib/timeline.ts` turns events into groups.

<!-- states: tool-group -->
States: `single`, `running`, `collapsed`, `collapsed-failed`, `one-object`, `expanded`, `edited`

<!-- size-table: tool-group -->
| Part | State | Property | Value |
|---|---|---|---|
| tool-line | single | height | row.dense |
| tool-line | single | font-size | type.small |
| tool-line | single | color | color.muted |
| tool-line | single | column-gap | space.2 |
| spinner | running | color | color.accent |
| tool-box | running | background-color | color.panel |
| tool-box | running | border-radius | radius.md |
| tool-row | running | height | row.dense |
| tool-line | collapsed | height | row.dense |
| fail-word | collapsed-failed | color | color.fail |
| key-arg | one-object | color | color.ink |
| tool-box | expanded | background-color | color.panel |
| tool-box | expanded | font-size | type.small |
| tool-row | expanded | height | row.dense |
| tool-line | edited | height | row.dense |

#### 6.16.9 Tool row

- `row.dense` minimum height, padding `pad.default`, gap `space.2`, `small` `muted`; `hover` ground on hover (over `motion.hover`), a 1px `accent` outline at -1px on focus. A row with detail is a `button` with `aria-expanded` and a chevron at its end.
- **Label** (one line, ellipsis): verb + source: title (`muted`), then the key arguments (`ink`), then extra information after " · " (`faint`). The title is the tool's declared `title` (e.g. the MCP `title`), else its key; the source is the connector's or the extension's name (builtins have none); the key arguments are the tool's declared `keyArgs` (else the first string argument). A shell row (`sandbox_bash`) shows the `description` the model wrote instead of verb and title. Edits add "+a −b" as the extra.
- **Status**: running — a `spinner` before the label, the label `ink`, the elapsed time in `faint` at the end ("12 秒" / "12s", "1 分 03 秒" / "1m 03s"); done — no mark; failed — "失败" in `fail` and " · <the error's first line>" in `muted` (a shell command with a non-zero exit or a timeout is a failure); blocked by a policy hook — failed, "被扩展「<extension>」拒绝" / `Denied by extension "<extension>"`.
- **Expanded detail**: padding 0 `space.3` `space.3`, gap `space.2`, no IN / OUT labels:
  - inputs as a key / value grid (columns `max-content` and the rest, gap `space.1` × `space.3`, keys `faint`, values `ink`, breaking anywhere); a command as `$ <command>` (the `$` `faint`, the command `ink`);
  - the output: `bg` ground, radius `sm`, padding `pad.default`, `small` `ink`, wrapped, at most `layout.tool-output` high and scrolling; for a failure the full error text;
  - a footer (`micro` `faint`, gap `space.3`): the duration ("2.1 秒" / "2.1s") and "复制输出" / "Copy output"; for a large output instead "输出 82 KB，已显示前 4 KB" / "Output 82 KB, showing first 4 KB" and "查看全文" / "View full text", which reads the archive (`GET …/outputs/:outputId`).

<!-- states: tool-row -->
States: `default`, `hover`, `focus`, `running`, `failed`, `expanded-command`, `expanded-connector`, `expanded-failed`, `large-output`, `hook-denied`

<!-- size-table: tool-row -->
| Part | State | Property | Value |
|---|---|---|---|
| tool-row | default | height | row.dense |
| tool-row | default | padding-top | pad.default.y |
| tool-row | default | padding-left | pad.default.x |
| tool-row | default | column-gap | space.2 |
| tool-row | default | font-size | type.small |
| tool-row | default | color | color.muted |
| tool-row[data-ref-forced=true] | hover | background-color | color.hover |
| tool-row[data-ref-forced=true] | focus | outline-color | color.accent |
| tool-row[data-ref-forced=true] | focus | outline-width | 1 |
| spinner | running | color | color.accent |
| tool-label | running | color | color.ink |
| fail-word | failed | color | color.fail |
| tool-output | expanded-command | background-color | color.bg |
| tool-output | expanded-command | border-radius | radius.sm |
| tool-output | expanded-command | padding-left | pad.default.x |
| tool-output | expanded-command | max-height | layout.tool-output |
| tool-output | expanded-command | font-size | type.small |
| tool-output | expanded-command | color | color.ink |
| tool-footer | expanded-command | font-size | type.micro |
| tool-footer | expanded-command | color | color.faint |
| kv | expanded-connector | column-gap | space.3 |
| kv | expanded-connector | row-gap | space.1 |
| kv-key | expanded-connector | color | color.faint |
| kv-value | expanded-connector | color | color.ink |
| fail-word | expanded-failed | color | color.fail |
| tool-output | expanded-failed | background-color | color.bg |
| tool-footer | large-output | color | color.faint |
| fail-word | hook-denied | color | color.fail |

#### 6.16.10 Diff block

- The expanded form of an edit (`sandbox_edit`, `sandbox_write` over an existing file), inside the tool box, padding `space.1` 0. Each line: gap `space.2`, padding 0 `space.3`, `small` mono, no wrapping; a 4-character right-aligned `faint` gutter with the line number (the new number, the old one for removed lines), a 1-character sign column (+ / − / blank), then the text with an ellipsis.
- Added lines on the `diff-add` ground, removed lines on `diff-del`, both `ink`; context lines keep the box's `muted`. The tint is the only marker besides the sign: no green or red text.
- Past `TOOL_VIEW_DIFF_MAX_LINES` the diff ends with a centered `muted` line under a `line-soft` rule: "差异过长，已截断 · 显示前 N / M 行 · 查看全文" / "Diff too long, truncated · showing first N / M lines · View full text", where N is counted from the lines shown and M is the whole diff's line count (without M: "显示前 N 行" / "showing first N lines").

<!-- states: diff-block -->
States: `default`, `truncated`

<!-- size-table: diff-block -->
| Part | State | Property | Value |
|---|---|---|---|
| diff-line | default | padding-left | space.3 |
| diff-line | default | column-gap | space.2 |
| diff-line | default | font-size | type.small |
| diff-line[data-kind=add] | default | background-color | color.diff-add |
| diff-line[data-kind=add] | default | color | color.ink |
| diff-line[data-kind=del] | default | background-color | color.diff-del |
| diff-line[data-kind=del] | default | color | color.ink |
| diff-gutter | default | color | color.faint |
| diff-cut | truncated | color | color.muted |
| diff-cut | truncated | border-top-color | color.line-soft |

#### 6.16.11 Approval block

- **Pending**: a floating card with an `accent` border, gap `space.3`, `role="group"`. Head: an `accent` dot, "需要你批准" / "Approval needed" (600), the tool (`small` `muted`: "<connector>: <title>", or the source and the localized name when the tool has no title) and then **always** the model-visible tool key (`small` `faint`, e.g. `acme_tickets__send_message`; it wraps rather than truncates). The key stays even without a title, because two sources can share a display name. Then **every** input argument as a key / value grid: the tool's `keyArgs` first, in their order, then the other properties in input order; values that are not strings as compact JSON; each value wraps and is capped at 3 lines; under the grid a `small` `muted` link "查看完整输入" / "Show full input" opens the whole input JSON read-only in place ("无参数" / "No arguments" when the input is empty). Then the actions (`default` step, gap `space.2`): "批准" / "Approve" (primary), "本会话内都批准" / "Approve for this conversation", "总是批准" / "Always approve" (default) — each only when the request allows `once` / `session` / `always` — and "拒绝…" / "Deny…" (default); at the right end a `small` `muted` note naming the rule that asked (the agent's tool policy, the connector's policy, a rule that always asks, the org's sandbox setting, the tool's default, or role escalation).
- **Why the key and every argument**: a tool's title (and its `keyArgs`) come from extension or connector code and a connector's title can change without drift review (it is display only). The person approving must see what the model actually calls: the reviewed key and the full input, so a misleading title can at most mislabel a call whose key and arguments are on screen.
- **Deny with a reason**: "拒绝…" swaps the actions for a reason input ("拒绝原因（选填，会告诉模型）" / "Reason (optional, the model sees it)"), "拒绝" / "Deny" (danger), "取消" / "Cancel" (ghost) and the note "原因会写入会话，模型能看到" / "The reason goes into the conversation; the model sees it".
- **Decided**: collapses to a tool line that names the key too: approved — `check` 12, "<who> 批准了 <tool>" and " <key> · <scope> · <time>" in `faint`; denied — `x` 12, "<who> 拒绝了 <tool>", " <key>" in `faint`, " · 「<reason>」" in `muted` and the time in `faint`.

<!-- states: approval-block -->
States: `pending`, `pending-once`, `deny-reason`, `approved`, `denied`

<!-- size-table: approval-block -->
| Part | State | Property | Value |
|---|---|---|---|
| approval-block | pending | background-color | color.raised |
| approval-block | pending | border-top-color | color.accent |
| approval-block | pending | border-radius | radius.md |
| approval-block | pending | padding-left | space.3 |
| approval-block | pending | row-gap | space.3 |
| button[data-variant=primary] | pending | height | control.default |
| card-note | pending | font-size | type.small |
| card-note | pending | color | color.muted |
| kv-key | pending | color | color.faint |
| tool-key | pending | font-size | type.small |
| tool-key | pending | color | color.faint |
| button[data-variant=primary] | pending-once | height | control.default |
| approval-block | deny-reason | border-top-color | color.accent |
| button[data-variant=danger] | deny-reason | height | control.default |
| tool-line | approved | height | row.dense |
| tool-line | approved | color | color.muted |
| tool-key | approved | color | color.faint |
| tool-line | denied | color | color.muted |
| tool-key | denied | color | color.faint |

#### 6.16.12 Question block

- `ask_user` and connector elicitation. **Pending**: a floating card (`line` border, not accent), gap `space.3`, `role="group"` named by the question. The question in the prose font (`prose`, 600). Options as rows (`row.default` minimum height, padding `pad.default`, 1px `line` border, radius `sm`; a 12 round radio, `line-strong`, `accent` when checked; the checked row has an `ink` border); multi-select options use checkboxes; with `allowOther` a last row "其他：" / "Other:" holds a free-text input. Actions: "回答" / "Answer" (primary), "跳过" / "Skip" (default).
- **URL mode** (the form has a `url`): the full address as a link (`small` `ink`, underlined in `line-strong`, breaking anywhere, `external-link` 14 `muted` before it), "打开链接" / "Open link" (primary, with the icon), Skip, and the note "完成后回到这里继续" / "Come back here when you're done".
- **Answered**: collapses to the question as a tool line and a second one with `corner-down-right` 12, the answer in `ink` and " · <who>" in `faint`; **skipped** says "已跳过" / "Skipped".

<!-- states: question-block -->
States: `pending`, `url`, `answered`, `skipped`

<!-- size-table: question-block -->
| Part | State | Property | Value |
|---|---|---|---|
| question-block | pending | background-color | color.raised |
| question-block | pending | border-top-color | color.line |
| question-block | pending | border-radius | radius.md |
| question-block | pending | padding-left | space.3 |
| question-title | pending | font-size | type.prose |
| option | pending | min-height | row.default |
| option | pending | border-radius | radius.sm |
| option[aria-checked=true] | pending | border-top-color | color.ink |
| button[data-variant=primary] | pending | height | control.default |
| question-url | url | font-size | type.small |
| question-url | url | color | color.ink |
| tool-line | answered | height | row.dense |
| tool-line | skipped | color | color.muted |

#### 6.16.13 Connect block

- **Pending**: a floating card laid out in a row, gap `space.3`: the service's initial (`control.default` round, `selected` ground), then which service and why (`body`) over "只影响你" / "Only affects you" (`small` `muted`), then "连接" / "Connect" (primary).
- **Closed**: a tool line with `connector` 12, "<who> 已连接 <service>" and the time in `faint`.

<!-- states: connect-block -->
States: `pending`, `closed`

<!-- size-table: connect-block -->
| Part | State | Property | Value |
|---|---|---|---|
| connect-block | pending | background-color | color.raised |
| connect-block | pending | border-top-color | color.line |
| connect-block | pending | border-radius | radius.md |
| connect-block | pending | padding-left | space.3 |
| connect-initial | pending | width | control.default |
| button[data-variant=primary] | pending | height | control.default |
| tool-line | closed | height | row.dense |
| tool-line | closed | color | color.muted |

#### 6.16.14 Queued message

- Messages queued with ⌘↵ while a run is going (UI refresh spec §5.7) sit in the chat column after the sent messages, in order: each a user bubble with a 1px dashed `line` border at opacity .6 (`data-queued="true"`), and under it, right-aligned (`small`, gap `space.1`): "排队中" / "Queued" in `faint`, then dense icon buttons (`copy`, `square-pen`, `trash-2`, 14; named 复制 / 编辑 / 删除 · Copy / Edit / Delete) and "立即发送" / "Send now" (dense default button).
- **Editing**: a prose textarea 75% wide (input focus rule) with "取消" / "Cancel" (dense ghost) and "保存" / "Save" (dense primary) under it.
- **Paused** (the run failed or was stopped): the bubbles without their actions, then one line "运行已停止，队列已暂停（N 条）" / "Run stopped; queue paused (N)" in `muted` and "继续发送" / "Continue sending" (dense). When the queue paused for another reason (phase D: the first message's author can no longer send, or its skill can no longer be invoked), the line says that reason instead, same style.
- A queued message is not in the event log until it is sent; behavior and keys in §6.11.

<!-- states: queued-message -->
States: `default`, `hover`, `editing`, `paused`

<!-- size-table: queued-message -->
| Part | State | Property | Value |
|---|---|---|---|
| bubble[data-queued=true] | default | opacity | 0.6 |
| bubble[data-queued=true] | default | border-top-color | color.line |
| bubble[data-queued=true] | default | border-radius | radius.bubble |
| queued-actions | default | font-size | type.small |
| queued-actions | default | column-gap | space.1 |
| queued-label | default | color | color.faint |
| icon-button | default | width | control.dense |
| button | default | height | control.dense |
| button[data-ref-forced=true] | hover | background-color | color.hover |
| button[data-variant=primary] | editing | height | control.dense |
| queued-paused | paused | color | color.muted |
| button | paused | height | control.dense |

#### 6.16.15 Sub-agent group

- Sub-agents group like tools (phase C runtime; B builds them on fixtures; rows in child-creation order, durations "41 秒", "1分12秒" / "41s", "1m 12s"; a waiting sub-agent says what it waits for in `accent`, a stopped one "已停止" / "Stopped" in `muted`). **Running**: a header tool line with a `spinner` and "正在运行 N 个子 agent" / "N subagents running", and the rows in a tool box. **Done**: a collapsed header "N 个子 agent 已完成（M 个失败）· 共 X 次调用 · <duration>" / "N subagents done (M failed) · X calls · <duration>" with the failure count in `fail` and the totals in `faint`.
- **Row** (a tool row): a `spinner` while running; the agent type as a tag (`micro` `muted` on the `selected` ground, radius `sm`, padding 0 `space.1`); the task description in `ink` with an ellipsis; at the end in `faint` ("失败" in `fail` and " · " when failed) "N 次调用 · <duration>" and `chevron-right` 12, a button named "在右侧打开 <description>" / "Open <description> on the right". Success has no mark.
- The row open in the right panel has `aria-current="true"`, the `accent-tint` ground and a 2px `accent` bar on its left (§2.3).
- A row can expand in place (`aria-expanded`): the steps (`small`, gap `space.1`, indented `space.5`, padding 0 `space.3`, a 1px `line` rule on the left), the result (`prose-small` `muted`) and "在右侧打开完整记录" / "Open the full record on the right" (link button with `maximize-2` 12); no `line-soft` rule separates the steps from the next row.

<!-- states: subagent-group -->
States: `running`, `done`, `failed`, `expanded`, `row-open`

<!-- size-table: subagent-group -->
| Part | State | Property | Value |
|---|---|---|---|
| tool-line | running | height | row.dense |
| spinner | running | color | color.accent |
| tool-box | running | background-color | color.panel |
| tool-box | running | border-radius | radius.md |
| subagent-row | running | height | row.dense |
| agent-tag | running | font-size | type.micro |
| agent-tag | running | background-color | color.selected |
| agent-tag | running | color | color.muted |
| fail-word | done | color | color.fail |
| tool-line | done | height | row.dense |
| fail-word | failed | color | color.fail |
| subagent-row | failed | height | row.dense |
| subagent-steps | expanded | padding-left | space.3 |
| subagent-steps | expanded | border-left-color | color.line |
| subagent-result | expanded | font-size | type.prose-small |
| subagent-result | expanded | color | color.muted |
| subagent-row[aria-current=true] | row-open | background-color | color.accent-tint |

#### 6.16.16 Inline card

- An extension card in the stream (`place: "inline"`), hanging off the tool result that named it (`ToolResult.card`); stage B2's MCP Apps widgets use the same frame.
- A title tool line above the card: "来自 <extension> 的卡片" / "Card from <extension>", then at the right its badge in `faint` (e.g. "2 / 5"), "实时" / "Live" in `muted` for a live embed, and a dense ⤢ icon button (`maximize-2` 14, "在右侧面板打开" / "Open in the right panel") when the extension has a right panel.
- The card is a floating card. Body: the rendered view (UiView blocks at the `dense` step) or an embed (EmbedFrame, the embed's own height). Loading: skeleton bars (`selected`, radius `sm`, `aria-busy`), never a spinner. Failure: the load-failure line of §6.16, in this card only.

<!-- states: inline-card -->
States: `view`, `embed`, `loading`, `failed`

<!-- size-table: inline-card -->
| Part | State | Property | Value |
|---|---|---|---|
| inline-card | view | background-color | color.raised |
| inline-card | view | border-top-color | color.line |
| inline-card | view | border-radius | radius.md |
| inline-card | view | padding-left | space.3 |
| inline-card-head | view | font-size | type.small |
| inline-card-head | view | color | color.muted |
| icon-button | view | width | control.dense |
| inline-card | embed | border-radius | radius.md |
| skeleton-bar | loading | background-color | color.selected |
| load-failed-title | failed | color | color.fail |

#### 6.16.17 Properties panel and property section

- The properties panel is `layout.properties` wide and sits **inside** the middle column, under its title bar, right of the thread (padding `space.2` `space.4` `space.4` 0); its sections stack `space.2` apart and it scrolls on its own.
- A section: `panel` ground, no border, radius `md`, padding `space.3`, gap `space.1`; a head with the title in `muted` and a value at the right, `space.1` above the body.
- Built-in sections, in order: **Context** (the usage ratio as the value; a meter `space.1` high, `line` track, `ink` fill, radius `sm`; "<model> · <sandbox status>" and "连接器：…" / "Connectors: …" in `small` `muted`; once the conversation has sub-agents, a last `small` `muted` line with its tokens including theirs, worded by the page); extension sections (`place: "section"`, in contribution order, rendered `dense`); **Files** (the count as the value, the conversation's own files and its sub-agents' deliveries; rows `row.dense`: type badge, name with an ellipsis, for a sub-agent's file "来自 <sub-agent>" / "from <sub-agent>" in `faint` (at most 40% of the row, with an ellipsis), size in `muted`; then "全部 N 个文件" / "All N files" with `chevron-right` 12 in `muted`); **Background tasks** (rows `row.dense`: `spinner`, name, duration `muted`, a dense stop icon button `square` 12 named "停止 <name>" / "Stop <name>"; then "已完成 N 项" / "N completed" with a chevron).
- A failing extension section shows the load-failure line in that section only.

<!-- states: property-section -->
States: `context`, `files`, `background`, `extension`, `failed`

<!-- size-table: property-section -->
| Part | State | Property | Value |
|---|---|---|---|
| properties | context | width | layout.properties |
| property-section | context | background-color | color.panel |
| property-section | context | border-radius | radius.md |
| property-section | context | padding-left | space.3 |
| property-title | context | color | color.muted |
| meter | context | height | space.1 |
| meter | context | background-color | color.line |
| property-row | files | height | row.dense |
| type-badge | files | font-size | type.micro |
| property-row | background | height | row.dense |
| spinner | background | color | color.accent |
| icon-button | background | width | control.dense |
| property-section | extension | background-color | color.panel |
| load-failed-title | failed | color | color.fail |

#### 6.16.18 Right panel

- One extension panel (`place: "panel"`, formerly `conversation`), a file preview or a sub-agent conversation, one at a time; opening it closes the properties panel or the previous panel. Full height, `panel-2` ground, a `line-soft` left divider.
- **Width**: default `layout.panel`, at least `layout.panel-min`, at most the content width minus `layout.chat-min` (so wide screens may go past 600, and at a 1280 window with the full sidebar it is 544). Resizable by a handle on its left edge (§6.11); the width is a per-viewer preference in `localStorage["cap.chat.panelWidth"]` (read and written in try/catch, clamped on read). Below a 1280 window the right area is a Sheet (§5.4).
- **Header**: `layout.title-bar` high, padding 0 `space.2` 0 `space.4`, a `line-soft` bottom line, gap `space.1`: back (`chevron-left`, optional), the type badge (files), the title as a ghost button with `chevron-down` 14 that opens the switcher (a Menu: extension panels, a separator, the conversation's files, each group under a `micro` label; the open item has the `selected` ground and no check; the title keeps the `hover` ground while it is open), or plain text when there is nothing to switch to (a sub-agent); meta in `small` `faint` ("v2 · 10-26 14:20", "2 / 5", a `spinner` and the duration); actions; full screen (`maximize-2`); close (`x`).
- **Body**: padding `space.4` (flush for tables), scrolls on its own. A failing extension panel shows the load-failure line in its body.
- **Sub-agent panel**: header back (returns to what the right area showed before, e.g. the properties panel it was opened from; otherwise closes), description, spinner and duration, "停止" / "Stop" (default), full screen, close; body padding `space.4` `space.5`: the task as a block (`selected` ground, radius `md`, padding `space.3`, `prose-small`; label "任务 · 主 agent 派出" / "Task · from the main agent" in `micro` `muted`), a tool line naming its agent (an org agent's name is a link to that agent, styled as a link button), model and tool scope, then its tool groups and prose like the main thread; read-only; its own status bar at the bottom.

<!-- states: right-panel -->
States: `extension`, `file`, `subagent`, `switcher`, `failed`

<!-- size-table: right-panel -->
| Part | State | Property | Value |
|---|---|---|---|
| right-panel | extension | width | layout.panel |
| right-panel | extension | background-color | color.panel-2 |
| right-panel | extension | border-left-color | color.line-soft |
| panel-head | extension | height | layout.title-bar |
| panel-head | extension | padding-left | space.4 |
| panel-head | extension | border-bottom-color | color.line-soft |
| panel-body | extension | padding-left | space.4 |
| type-badge | file | font-size | type.micro |
| panel-meta | file | font-size | type.small |
| panel-meta | file | color | color.faint |
| subagent-task | subagent | background-color | color.selected |
| subagent-task | subagent | border-radius | radius.md |
| subagent-task | subagent | font-size | type.prose-small |
| menu | switcher | background-color | color.panel |
| menu-label | switcher | color | color.muted |
| load-failed-title | failed | color | color.fail |

#### 6.16.19 File card

- A file the agent delivered (`artifact_created`; UI copy says "files" / 文件, never "artifacts" / 产出物). A link-styled button: at least `layout.file-card` wide, at most the column, padding `pad.default`, 1px `line` border, radius `md`, `raised` ground, `small` `ink`, gap `space.2`: the type badge (`micro` 600 `muted`, 1px `line` border, radius `sm`, padding 0 `space.1`; XLSX, PDF, MD, PNG …, else FILE), the name middle-truncated keeping its extension (full name in `title`), the size in `muted`, `chevron-right` 12. Hover: the `hover` ground; focus: 2px `accent` outline, 2px offset. It opens the preview in the right panel.
- **Removed** (the object is gone from storage): not clickable, `muted`, the name struck through, "文件已不可用" / "No longer available" instead of the size, `data-removed="true"`.

<!-- states: file-card -->
States: `default`, `hover`, `focus`, `long-name`, `removed`

<!-- size-table: file-card -->
| Part | State | Property | Value |
|---|---|---|---|
| file-card | default | min-width | layout.file-card |
| file-card | default | padding-top | pad.default.y |
| file-card | default | padding-left | pad.default.x |
| file-card | default | border-radius | radius.md |
| file-card | default | border-top-color | color.line |
| file-card | default | background-color | color.raised |
| file-card | default | font-size | type.small |
| type-badge | default | font-size | type.micro |
| type-badge | default | border-radius | radius.sm |
| type-badge | default | color | color.muted |
| file-card[data-ref-forced=true] | hover | background-color | color.hover |
| file-card[data-ref-forced=true] | focus | outline-color | color.accent |
| file-card[data-ref-forced=true] | focus | outline-width | 2 |
| file-card | long-name | min-width | layout.file-card |
| file-card[data-removed=true] | removed | color | color.muted |

#### 6.16.20 File outputs

- **Several files**: a two-column grid, gap `space.2`; past 4, the first 3 and a fourth card "还有 N 个文件" / "N more files" (`muted`, chevron) that opens the Files section.
- **Image**: shown inline, `layout.inline-image` wide at its own aspect ratio, `panel` ground, radius `md` (bitmaps through the `?inline=1` rule; SVG never renders inline). Hover shows enlarge (`zoom-in`) and download (`download`) dense icon buttons (`raised` ground, 1px `line` border) `space.2` from the top right. Below it a caption tool line: the name in `ink`, then " · <width>×<height> · <size>" in `faint`.
- **Text** (md, txt, csv …): a floating card without padding: a head (padding `pad.default`, `small`, a `line-soft` bottom line: type badge, name, size `muted`, "打开" / "Open" link button with a chevron) and the first lines as plain text (`small` `muted`, wrapped, 6 lines high, padding `space.2` `space.3`, fading out at the bottom). Never rendered as HTML.

<!-- states: file-outputs -->
States: `two`, `more`, `image`, `image-hover`, `text`

<!-- size-table: file-outputs -->
| Part | State | Property | Value |
|---|---|---|---|
| file-grid | two | column-gap | space.2 |
| file-card | two | border-radius | radius.md |
| file-more | more | color | color.muted |
| image-frame | image | width | layout.inline-image |
| image-frame | image | border-radius | radius.md |
| image-frame | image | background-color | color.panel |
| icon-button | image-hover | width | control.dense |
| icon-button | image-hover | background-color | color.raised |
| text-output | text | border-radius | radius.md |
| text-output | text | background-color | color.raised |
| text-output-head | text | font-size | type.small |
| text-output-body | text | font-size | type.small |
| text-output-body | text | color | color.muted |

#### 6.16.21 Attachment strip

- Attachments in the composer, above the textarea: wrapping, gap `space.2`, `space.2` below. Images are `layout.thumb` square thumbnails (radius `sm`) with a `space.4` round remove button (`x` 12, `panel` ground, 1px `line` border, `muted`) overlapping their top right corner by `space.1`. Files are chips: `row.default` minimum height, padding `pad.dense`, 1px `line` border, radius `sm`, `panel` ground, `small`, gap `space.2`: type badge, name (one line, ellipsis), size `muted`, a dense remove icon button ("移除 <name>" / "Remove <name>").
- **Uploading**: the chip stacks the name, the percent in `muted` and a 2px progress bar (`line` track, `ink` fill, `role="progressbar"`). **Rejected** (too large, wrong type, too many): a `fail` border and the reason in `fail` instead of the size; it can still be removed; when the caller supplies a retry (an upload that failed in transit, not a precheck), a dense `refresh` icon button ("重试 <name>" / "Retry <name>") sits before the remove button.
- Supersedes §6.9's AttachmentChip looks; FileDrop and FileButton are unchanged.

<!-- states: attachment-strip -->
States: `image`, `file`, `uploading`, `rejected`

<!-- size-table: attachment-strip -->
| Part | State | Property | Value |
|---|---|---|---|
| thumb | image | width | layout.thumb |
| thumb | image | height | layout.thumb |
| thumb | image | border-radius | radius.sm |
| thumb-remove | image | width | space.4 |
| attachment | file | min-height | row.default |
| attachment | file | padding-left | pad.dense.x |
| attachment | file | border-radius | radius.sm |
| attachment | file | border-top-color | color.line |
| attachment | file | background-color | color.panel |
| attachment | file | font-size | type.small |
| progress | uploading | height | 2 |
| progress | uploading | background-color | color.line |
| attachment | rejected | border-top-color | color.fail |

#### 6.16.22 File preview

- The right panel showing a file (§6.16.18): header type badge, the name with the file switcher, "v<n> · <updated>" in `faint`, download, full screen, close. There is **no Share** (sharing belongs to Artifacts).
- The body is the previewer that handles the file. Built in: **image** (bitmaps on the `panel` ground, radius `md`, `space.4` margin, scaled to fit; never SVG); **text and source code** (mono `small` `ink`, wrapped, never executed); **Markdown** (§6.16.4, no raw HTML); **CSV / TSV** (a flush table: `small`, header cells `row.dense` `muted` 400, body cells `row.dense` with a `line-soft` top line, padding 0 `space.3`, no wrapping, numbers right-aligned; at most 500 rows, then "显示前 N 行 · 共 M 行" / "Showing the first N of M rows" in `small` `muted`). Spreadsheet previewers may show sheet tabs (`small`, gap `space.4`, the current tab `ink` with a 2px `accent` underline). Extension previewers (`file-preview@1`) come first when one accepts the file; the header lets the person switch when more than one applies.
- **No preview**: a centered floating card (at most 400 wide): type badge, name over "<size> · 没有可用的预览" / "<size> · No preview available", and "下载" / "Download" (default, `download`). **Failed**: the load-failure line, then the same card as the fallback.

<!-- states: file-preview -->
States: `image`, `text`, `markdown`, `csv`, `none`, `failed`

<!-- size-table: file-preview -->
| Part | State | Property | Value |
|---|---|---|---|
| right-panel | image | background-color | color.panel-2 |
| preview-image | image | background-color | color.panel |
| preview-image | image | border-radius | radius.md |
| preview-text | text | font-size | type.small |
| preview-text | text | color | color.ink |
| prose | markdown | font-size | type.prose |
| preview-table | csv | font-size | type.small |
| preview-table-head | csv | color | color.muted |
| preview-table-cell | csv | height | row.dense |
| preview-table-cell | csv | border-top-color | color.line-soft |
| preview-note | csv | color | color.muted |
| no-preview | none | background-color | color.raised |
| no-preview | none | border-radius | radius.md |
| no-preview | none | padding-left | space.3 |
| load-failed-title | failed | color | color.fail |
| no-preview | failed | background-color | color.raised |

---

### 6.17 ObjectList and ObjectRow

`ObjectList({ label, children })` is the panel of an object list: a `ul` on the `panel` ground, 1px `line-soft` border, radius `md`, rows split by `line-soft`. `ObjectRow` is one `li`, at least 64 px high, padding `space.3` / `space.4`, `space.3` between its parts:

- A 36 px mark (radius `md`, `selected` ground): initials in 600 (mono like the whole UI) or an icon; `tone="warn"` tints it with `warn` at 15% when the object needs attention.
- Text column: line 1 the name (600; a link when `href`; `mono` for package names) and chips (`small`, 1px `line` border, radius `sm`; `tone="warn"` draws the warn tint without a border). A chip is a scope or an attention mark (组织共享, 敏感); plain facts such as a version or 必需 are meta text, never a chip; line 2 the description in `muted`, one line with an ellipsis; line 3 the meta in `faint`, `small`, one line.
- At the right: a state label (`state`: `ok` / `warn` / `fail` colored, `muted` in `faint`), a short `trailing` text in `faint`, one row action (`action`: a `default` dense button or link, never `primary`: the page head holds the one primary of the screen, and a row that needs attention says so in its `state`) and the `more-horizontal` overflow menu (`menu`). Below 640 the row wraps, and its action and menu buttons are at least 40 px (tap targets).
- **Loading** (`ObjectList.loading`, `true` for 3 rows or a row count; `ListPage.loading` on a list page): the panel draws skeleton rows in the row shape instead of its rows — a 36 px mark and two 12 px bars (30% and 55% wide) on the `hover` ground, radius `sm` — and the list is `aria-busy` with a hidden "正在加载 / Loading". It wins over `empty`, so no empty state flashes before the first answer; a `records` ListPage draws a Skeleton instead.

### 6.18 EmptyState

One empty state for the whole product. `EmptyState({ text, hint?, action?, icon?, size? })`:

- **Illustration**: the pixel capybara of §3 drawn as a line (`LogoLine`: the outer edges of the bitmap's cells, the eye included, 1 px `faint` stroke, no fill), decorative. `icon` replaces it where an object icon reads better (a failed load: `circle-alert`; a search that matched nothing: `search` / `search-x`), drawn in `faint`.
- **Copy**: one sentence in `ink` saying what will be here ("还没有 agent" / "No agents yet"), an optional second line in `muted` (`small`), and at most one action, the primary next step (a `default` or `primary` button or link). A `primary` action here is the screen's one primary: `ListPage` hides the head's primary while it is shown (§5.1). Never a table header over an icon, never a sentence about the absence of data in general ("暂无数据" is only the DataTable's fallback).
- **Sizes**: `page` (default) is centered in the content frame, no frame of its own, `space.8` × 2 above and below, the illustration at scale 6 (85 × 61). `compact` (panels, the DataTable's empty area, the sidebar's conversation list) is left-aligned with `space.3` padding and `space.2` gaps, the illustration at scale 3, the action `dense`; inside a DataTable it is centered horizontally in the table body instead (§6.6).
- **Where**: every ListPage / ObjectList empty (`ListPage.empty`), the InboxPage with no items (the page state instead of the list + detail split, §5), the DataTable's empty and no-results areas (§6.6, compact), the sidebar's conversation list (compact: "还没有会话" + 新会话; a filter matching nothing: "没有匹配的会话" + 清除筛选).

### 6.20 PendingState

`PendingState({ frame?, delayMs? })`: the neutral loading state of a page whose outcome is not known yet (the app frame before it knows whether to draw the shell or the setup layout). It draws nothing shaped like any of the outcomes (no sidebar, no composer outline, no checklist): only the `bg` ground, a `status` region marked busy with a hidden "正在加载 / Loading", and after 300 ms (`PENDING_DELAY_MS`) three quiet 12 px bars (`hover` ground, radius `sm`; 30 %, 70 %, 45 % wide) in a centered chat-width column. `frame="app"` fills the window, `page` the content area. Rule: never show a placeholder shaped like one of two possible outcomes; skeletons in the frame's shape are for loads whose frame is already known (§6.17).

### 6.19 Callout

`Callout({ tone, action?, children })`: a `role="status"` bar naming what needs action, radius `md`, padding `space.3` / `space.4`: a `circle-alert` icon, the sentence, and one dense button or link. `warn` uses the `warn` tint (15%) and a `warn` icon; `fail` the `fail` tint (12%) and icon. On list pages it sits in the header between the title row and the tabs (`ListPage.callout`). `info` is the quiet form for a standing fact about the page rather than something to fix (the admin overview's "企业管理员不能查看对话内容。"): a `role="note"` on the `panel` ground, `muted` text, a `faint` icon, usually no action; it sits first in the page body, under the head.

### 6.21 DangerZone

`DangerZone({ title, children })` with `DangerZoneItem({ title, description, action })` (role pass): the irreversible actions at the bottom of a settings section (organization deletion). A `region` named by its title, `space.8` above, a 1px border of `fail` at 45 %, radius `md`; the title (`body`, 500, `fail`) in a head row split from the items by `fail` at 25 %. Each item: the title (500, `ink`) over the description (`small`, `muted`), and one dense `danger` button at the right that opens a confirmation (`DangerConfirm`, §6.7), never acts at once; items are split by `line-soft`. After `FormSection`s (a settings page) it sits in their field column (indented by the 240 title column and its gap, the section cards' left edge), full width below 960.

<!-- states: danger-zone -->
States: `default`, `two-items`

<!-- size-table: danger-zone -->
| Part | State | Property | Value |
|---|---|---|---|
| danger-zone | default | border-radius | radius.md |
| danger-zone-title | default | color | color.fail |
| danger-zone-title | default | font-size | type.body |
| danger-zone-title | default | padding-left | space.4 |
| danger-zone-item | default | padding-top | space.3 |
| danger-zone-item | default | padding-left | space.4 |
| danger-zone-desc | default | font-size | type.small |
| danger-zone-desc | default | color | color.muted |
| button[data-variant=danger] | default | height | control.dense |
| danger-zone-item | two-items | padding-top | space.3 |

### 6.22 SecretReveal

`SecretReveal({ label, value })` (role pass): a secret the kernel returns only once (a service token). The label (600), a read-only `Input` holding the value (selected on focus) with a default "复制" / "Copy" button (`copy` icon; "已复制" / "Copied" with `check` for 2 s after copying), and below it a `warn` line with `circle-alert`: "只会显示这一次，请立即复制并妥善保存。" / "Shown only this once. Copy it now and keep it safe." Used inside the dialog that created the secret, replacing its form. Without a usable clipboard (an insecure origin, a refused permission) the copy button selects the field instead and the `warn` line says to copy it by hand ("无法自动复制：已选中令牌，请按 Ctrl+C（⌘C）复制。…").

<!-- states: secret-reveal -->
States: `default`, `copied`

<!-- size-table: secret-reveal -->
| Part | State | Property | Value |
|---|---|---|---|
| secret-reveal | default | row-gap | space.2 |
| input | default | height | control.default |
| input | default | border-radius | radius.sm |
| input-control | default | font-size | type.body |
| secret-once | default | color | color.warn |
| secret-once | default | font-size | type.small |
| button | copied | height | control.default |

### 6.23 No-access state

The T11 `StatusPage` with `kind="no-access"` (§5, role pass): the logo, a 16 px `lock` in `faint` instead of a code, the title (`h2`), the description (`muted`), the role it needs as a chip (`need`: `small`, 1px `line` border, radius `sm`, padding `space.1` / `space.2`, `ink`: "需要：组织管理员" / "Requires: Org admin") and who to ask (`ask`, `muted`). Never an action or a retry.

<!-- states: no-access -->
States: `default`

<!-- size-table: no-access -->
| Part | State | Property | Value |
|---|---|---|---|
| status-lock | default | color | color.faint |
| status-need | default | font-size | type.small |
| status-need | default | border-radius | radius.sm |
| status-need | default | border-top-color | color.line |
| status-need | default | padding-left | space.2 |
| status-need | default | color | color.ink |

### 6.24 ErrorDetail

`ErrorDetail({ summary, detail?, label?, defaultOpen? })`: a failure a person reads first as one sentence in their language, with the system's raw text one click away (a marketplace's last refresh error). The summary (`body`, `fail`, led by `circle-x` 14, `space.1` apart) is one sentence the page maps from the error (a known kind gets its own sentence, anything else a generic one such as "同步失败。"); raw English text never goes into it. Under it, `space.1` below, a toggle button in `small` `muted` ("原始错误" / "Raw error"; `label` overrides) with a `faint` `chevron-right` / `chevron-down` (12) after the words (`aria-expanded`, `aria-controls`; `ink` on hover). Once open, the raw text follows `space.1` below in mono `small` `muted`, line breaks kept and long words broken anywhere, under a 1px `line` guide on the left, indented `space.2` (the Disclosure body, §6.5). Closed by default; without `detail` the toggle is not drawn.

<!-- states: error-detail -->
States: `default`, `open`

<!-- size-table: error-detail -->
| Part | State | Property | Value |
|---|---|---|---|
| error-detail | default | row-gap | space.1 |
| error-detail-summary | default | color | color.fail |
| error-detail-summary | default | font-size | type.body |
| error-detail-toggle | default | color | color.muted |
| error-detail-toggle | default | font-size | type.small |
| error-detail-raw | open | color | color.muted |
| error-detail-raw | open | font-size | type.small |
| error-detail-raw | open | padding-left | space.2 |
| error-detail-raw | open | border-left-color | color.line |

### 6.25 FilePicker

`FilePicker({ dropLabel, onFiles, label?, hint?, accept?, multiple?, disabled?, children? })`: the one file pick of a form or a flow (上传技能, the extension package of 安装扩展, the plugin package of 导入插件), never a bare `+` icon button. A drop zone (`FileDrop`: dragging a file over it draws the `dropLabel` overlay, a drop or a paste hands the files over) drawn as a 1px dashed `line-strong` box, radius `md`, `panel` ground, padding `space.6` / `space.4`, its content centered in a column `space.2` apart: the `upload` icon (16, `faint`), a `default` button with words ("选择文件" / "Choose file"; `label` names the type, "选择 .zip 文件") that opens the system picker, and a `small` prose `muted` hint ("或拖放到这里。" / "or drop it here."; `hint` overrides). What is chosen or happening (the file's `AttachmentChip` with its progress, a cancelled note) goes inside the zone under the hint (`children`). Disabled: the button disabled, the border `line`, drops ignored. Choosing between sources (upload / npm / git) above it uses card radios (§6.3 option cards) in a `Card`, as every install and import flow does.

<!-- states: file-picker -->
States: `default`, `chosen`

<!-- size-table: file-picker -->
| Part | State | Property | Value |
|---|---|---|---|
| file-picker | default | border-radius | radius.md |
| file-picker | default | border-top-color | color.line-strong |
| file-picker | default | background-color | color.panel |
| file-picker | default | padding-top | space.6 |
| file-picker | default | padding-left | space.4 |
| file-picker | default | row-gap | space.2 |
| file-picker-icon | default | color | color.faint |
| file-picker-hint | default | color | color.muted |
| file-picker-hint | default | font-size | type.small |
| button | default | height | control.default |
| file-picker-status | chosen | row-gap | space.2 |

## 7. Copy and internationalization
- All UI text goes through next-intl, in both Chinese and English. Text shown to the model (prompts, tool descriptions) is always English, and the prompt field in a form must say so.
- Thousands separators for numbers; durations `6.8s` / `41.2s` / `00:00:18`; amounts `¥412.80`; relative time ("2 hours ago") for lists, absolute time (`10-18 14:02:11`) for records and logs.
- Error messages state the cause and give an actionable next step; include the error code and request ID for troubleshooting.
- **Files, not artifacts**: what an agent delivers from its sandbox is "文件" / "files" in UI copy, never "产出物" / "artifacts" (reserved for project C's Artifacts). The kernel identifiers (`artifact_created`, `/artifacts/:id/download`) stay as they are.
- **Untitled conversations** read "未命名会话 · MM-DD HH:mm" / "Untitled conversation · MM-DD HH:mm" (the start time) until a title exists.
- **Tool verbs** (§6.16.8, §6.16.9), as the signed reference set B draws them. Counts are Arabic numerals; failures append "（N 个失败）" / " (N failed)" in `fail`; mixed kinds join with "，" / ", " in the fixed order command, tools (connector, tool, search, meta), read, edit:

  | Kind | Row verb zh / en | Group count zh / en | Running header zh / en |
  |---|---|---|---|
  | command | 已运行 / Ran (a shell row shows the model's `description` instead) | 已运行 N 个命令 / Ran N commands | 正在运行命令 / Running command |
  | read | 已读取 / Read | 已读取 N 个文件 / Read N files (one path: 已读取 <path> / Read <path>) | 正在读取文件 / Reading file |
  | edit | 已修改 / Edited | 已修改 N 个文件 · +a −b / Edited N files · +a −b (one path: 已修改 <path>) | 正在修改文件 / Editing file |
  | search | 已搜索 / Searched | counted with tools | 正在使用工具 / Using tool |
  | connector, tool | 已使用 / Used | 已使用 N 个工具 / Used N tools | 正在使用工具 / Using tool |
  | meta | 已加载的工具 / Loaded tools | counted with tools | 正在使用工具 / Using tool |

### 7.1 Copy

The polish checklist below comes from an audit with [unslop](https://github.com/heydamir/unslop) (Damir Sokolovsky, CC BY 4.0), adapted to this product: exact, restrained, a little dry.

- **Periods**: full sentences (descriptions, hints, errors, toasts, empty-state explanations, notices) end with "。" / "."; titles, buttons, labels, menu items, table headers, tabs, short phrase captions ("先配置模型", "设置 · 成员") and inline key hints ("按 ↵ 立即发送，按 Ctrl+↵ 加入队列") have none. `check:i18n` rule `i18n-label-period` rejects a period at the end of a message whose key names a label (`title`, `label`, `action`, `confirm`, `cancel`, `submit`, `button`, `name`, `tab`, `heading`, `item`, `menu`, `placeholder`, also as the last camelCase word, e.g. `confirmLabel`).
- **Ellipsis and punctuation**: the ellipsis is the single character "…", never three dots (`i18n-ellipsis`); in Chinese a half-width `?` `!` `:` `;` never follows a Chinese character, use `？` `！` `：` `；` (`i18n-cjk-halfwidth`).
- **One name per object**: conversation is "会话" (not "对话", which stays a verb), sub-agent is "子 agent", rename is "重命名", a created-at column is "创建时间", the home page is "首页", the admin area is "管理后台" and its first page "概览"; a page's h1 is its nav name.
- **"agent"**: in Chinese running text the word is lowercase ("新建 agent", "agent 决定用哪个模型…"); the nav item and the page name stay "Agents". The create verb is "新建" everywhere (buttons, the setup step, the page title "新建 agent").
- **The path is not translated**: the page-head path and the status bar's path line (`user@org:~/path`) keep the route words (`capybara / settings / members`, `/admin / extensions`); they mirror the URL and are the product's signature.
- **One primary per screen**: the page head (or the action row of a form) holds the one `primary` button; row actions in lists are secondary (§6.17), and a row that needs attention says so in its state text.
- **No badge for plain metadata**: a version, "必需" / "Required" or a source is meta text (§6.17); a badge (chip) is for a scope or something that needs attention ("敏感" / "Sensitive").

## 8. Accessibility
- Text contrast ≥ 4.5:1 (`faint` only for non-essential information).
- All interactive elements are native `button` / `a` / `input`; icon buttons must have an `aria-label`; status is not expressed by color alone.
- Fully keyboard accessible, focus visible (§2.5); overlay focus is trapped and returned.
- Respect `prefers-reduced-motion` and `prefers-color-scheme` (dark by default, switchable by the user).

## 9. Enforcement and acceptance (how the implementation is kept consistent with this spec)

### 9.1 Static rules (`pnpm check`)

1. **Package boundary**: `apps/web` may import UI components and templates only from `@capybara-hq/design`. The import rule is a **blacklist**: `@radix-ui/*`, `cmdk`, CSS-in-JS (`@emotion/*`, `styled-components`, `@stitches/*`, `@vanilla-extract/*`, `styled-jsx`), component libraries (`@mui/*`, `@chakra-ui/*`, `@mantine/*`, `@headlessui/*`, `antd`), `tailwindcss` / `tailwind-merge`, class-name utilities (`clsx`, `classnames`, `class-variance-authority`) and icon libraries (`lucide-react`, `react-icons`) must never be imported; `.css` may only import `@capybara-hq/design/styles.css`. The blacklist grows as new styling dependencies appear.
2. **Template enforcement**: every `page.tsx` under `apps/web/src/app` must render one of the §5 templates imported from `@capybara-hq/design` (aliases and namespace imports are recognized); the Shell layers are rendered only by templates. Two exemptions: the development catalog pages `app/dev/**`; and pages that only handle 404 (containing no JSX and calling `notFound()` from `next/navigation`, such as `[...rest]/page.tsx`), whose page is rendered by the StatusPage in the same segment's `not-found.tsx`.
3. **Style ownership**: in `apps/web/src` there must be no `className` / `class` / `style` / `dangerouslySetInnerHTML` attributes (including spread props and `createElement` / `jsx` calls), `<style>` elements, `.css` files, or any color literal (`#hex`, `rgb()`, `hsl()`, `oklch()`, `color-mix()` and so on); layout inside a page may only use the design package's layout primitives (`Stack`, `Grid`, `Card`, `Text`). In `packages/design`, color literals are allowed only in the generated `tokens.css`. **Characters are not icons** (rule `design-char-icon`, part of `check:web-ui`): no string, template literal or JSX text in non-test code of `apps/web/src` or `packages/design/src` (and no value in `apps/web/messages/*.json`) may contain an icon character (`▾ ✓ ✕ ⋯ ⠿ ▤ ● ‖` and siblings); use `Icon` (§2.6). Box-drawing, `⌘`, `↵`, `→`, `·` and `…` are text.
4. **Tokens**: `check:tokens` keeps `tokens.json`, `tokens.css` and `tokens.ts` in step and checks the contrast pairs (§2).

Every check has a violating-fixture test.

### 9.2 Reference set, state lists and size tables

- **Reference set**: `docs/design/reference/src/*.html` draws the target design, one `<section data-ref-block="<component>-<state>">` per state, from the generated `tokens.css`, the self-hosted fonts and the shared fixtures (`@capybara-hq/design/fixtures`, also used by `/dev/ui`). `pnpm --filter @capybara-hq/web reference:render` renders one PNG per block and theme (`docs/design/reference/<id>-<theme>.png`, device scale factor 2); the committed PNGs come only from the manual `reference-update` workflow (the pinned Linux Playwright image). The sets signed off on 2026-10-26 (A) and 2026-10-27 (B) are the baseline for first acceptance.
- Each component in the reference set has a **state list** and a **size table** in this document, in exactly this form (an HTML comment marker on its own line, the list or table directly below it):

```md
<!-- states: <component> -->
States: `state-a`, `state-b`

<!-- size-table: <component> -->
| Part | State | Property | Value |
|---|---|---|---|
| <part> | <state> | <css property> | <value> |
```

- **Part** is a `data-part` value inside the block, optionally narrowed by attribute selectors (`button[data-variant=primary]`, `segment[aria-checked=true]`) and optionally a descendant of another part (`row[aria-current=true] cell`); `root` means the block element itself. The first matching element in document order is measured. Design components carry these `data-part` attributes.
- **State** names the block `<component>-<state>`; it must be in the component's state list.
- **Property** is a CSS property; `width` and `height` are measured from the element's box, everything else from its computed style.
- **Value** is a `tokens.json` path or a literal number in px. Paths: sizes without the `size.` prefix (`row.default`, `control.dense`, `space.3`, `radius.sm`, `layout.sidebar`, `pad.default.x` / `pad.default.y`); `type.<name>` is the size and `type.<name>.line` the line height; colors are `color.<token>` and are resolved for each theme.
- In `/dev/ui` a block is a `ReferenceBlock` (design package; `apps/web` wraps it as `RefBlock`) with the reference block's id and box, on the route `/dev/ui/reference/<component>`.
- Pseudo-states in `/dev/ui` blocks (`*-hover`, `*-focus`) are forced by the test with the browser's DevTools protocol on the elements the block names; forced elements get `data-ref-forced="true"`, which size-table parts can select.

### 9.3 Measuring tests

`apps/web/visual/fidelity.spec.ts` (Playwright, both themes) opens `/dev/ui/reference/<component>` for every accepted component and checks every size-table row against the block with the same id: sizes within ±1px, colors exactly equal to the token (compared as computed `rgb()` / `rgba()`). A failure names the component, state, part, property, expected and actual value. A state named `narrow` is drawn and measured in a 390 × 844 window, where the phone rules (§4.3, media queries below 640) apply; every other state at 1440 × 900. jsdom cannot measure layout, so these tests are Playwright only (`packages/design/test/narrow.test.tsx` checks the phone rules' CSS and the stacked table's DOM).

### 9.4 State coverage

The same spec fails when `/dev/ui/reference/<component>` lacks a block for a state in the component's state list (`missingStates`), and `checkSpecTables` (unit-tested in `packages/design/test/spec-tables.test.ts`, run against this document) reports a size table without a state list, a row whose state is not in the list, a value `tokens.json` lacks, and a duplicate marker. A completeness case in the same spec fails unless `ACCEPTED` (`apps/web/visual/accepted.ts`) lists exactly the components that have a state list here: a component cannot get a state list and stay out of acceptance unnoticed.

### 9.5 Interaction tests

Hover, focus, expand / collapse motion and its reduced-motion form, the sidebar keyboard paths, the rail and the drawer (§6.11, §6.13) are covered by Playwright interaction specs in `apps/web/visual/` (for example `sidebar.interaction.spec.ts`), including "no horizontal page scroll" at 1440 / 1279 / 959 / 640 / 390 (at 390 the conversation page's composer also stays inside the window's 16 px gutters).

### 9.6 Side-by-side acceptance

After each change to a reference-set component, `COMPARE=<components> pnpm --filter @capybara-hq/web compare` writes `apps/web/compare-out/index.html`: one row per block, the reference PNG on the left and the implementation's screenshot on the right, dark then light. The differences are listed by severity: **severe** (different structure or layout, a missing state, a wrong color) and **moderate** (a size or spacing off) block the merge; **minor** (rendering details) are listed in the PR. The maintainer reviews the page last. There is no pixel diffing against the reference PNGs: font rendering differs between systems and would cause false alarms; the measuring tests carry the pixel-level constraints.

### 9.7 Screenshot regression

Playwright screenshots the `/dev/ui` catalog and compares against the baseline; any difference fails. The committed baselines contain only the Linux version, generated by the `visual-update` workflow in the pinned Playwright Docker image (the CI `visual` job uses the same image); local (darwin) screenshots are gitignored and only for local comparison. A change is first accepted against the reference set (§9.6), then its baselines are regenerated; updating a baseline requires attaching the diff images in the PR.

### 9.8 CI placement and review

- `pnpm check` (lint job, full on every PR) runs §9.1. The measuring, state-coverage and interaction specs run in the `visual` job, by diff: `apps/web/**`, `packages/design/**`, and `docs/design/{spec.md,tokens.json}` through `EXTRA_INPUTS`. `compare` is a local review tool, not CI.
- Every UI PR is checked against this spec for template choice, density steps, accent color usage, status encoding and ActionRow rules.

## 10. Change process

Adding or changing a component, template or token: change this spec first (the rule, the state list and the size table), change `tokens.json` and the reference set (`docs/design/reference/src`) to match, and get the spec diff reviewed → implement in `packages/design` with `data-part` attributes and the `/dev/ui` reference blocks with the same ids → `pnpm --filter @capybara-hq/web compare` and side-by-side acceptance (§9.6) → re-render the reference PNGs (`reference-update`) and the screenshot baselines (`visual-update`). Pages must not invent new patterns ad hoc.
