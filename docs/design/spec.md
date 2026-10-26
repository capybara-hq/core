# Capybara Design System Spec (E · Terminal, refined)

> Status: implemented (`packages/design` + `/dev/ui`) · 2026-10-18; refined E rules, sidebar shell, size tables and states from UI refresh A, implemented and accepted against the reference set (all 14 components and templates) · 2026-10-26; conversation page rules, states and size tables from UI refresh B (reference set B signed off 2026-10-27), being implemented
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
| `selected` | `#1F1F1D` | `#ECEBE6` | Selected segment, selected filter chip ground, avatar, skeleton bars |
| `hover` | `#171716` | `#F4F3EF` | Hover ground, disabled input ground |
| `line-soft` | `#1C1C1A` | `#E6E5E0` | Column dividers, table row dividers, the status bar's and action row's top line, disabled borders |
| `line` | `#2A2A28` | `#D6D5CF` | Input and button border |
| `line-strong` | `#3A3A37` | `#B5B5AE` | Overlay border |
| `ink` | `#E6E6E3` | `#1A1A18` | Text |
| `muted` | `#8E8E89` | `#5E5E5A` | Secondary text, table headers, sidebar group labels |
| `faint` | `#5A5A56` | `#9A9A94` | Placeholders, disabled text and separators only (**must not** carry essential information; contrast is below 4.5:1) |
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

The light accent is `#CC4609`: white text on it has a contrast of 4.72:1 (WCAG AA). The original `#FF6A13` with white text is only 2.87:1 and must not be used in the light theme. The text pairs that must meet AA are listed in `tokens.json` `contrast` and checked by `check:tokens`; a translucent token (`diff-add`, `diff-del`) is composited over `bg` before its pair is checked.

### 2.2 Fonts and type

Two fonts, each with a job:

| Font | Token | Used for |
|---|---|---|
| **Sarasa Mono SC** (OFL-1.1) | `--cb-font` | The UI skeleton: navigation, labels, buttons, tables, tool rows, key names, paths, numbers, the status bar |
| **Inter + Source Han Sans SC** (both OFL-1.1) | `--cb-font-prose` | Prose: descriptions in page headers and form sections, conversation prose, rendered Markdown, table description lines |

- Weights 400 / 700 only, for both fonts.
- Delivery: subsetted to woff2 at build time (`packages/design/scripts/subset-font.py`: ASCII, the 3,755 level-1 common Chinese characters, the characters the UI uses and a symbol table), self-hosted under `packages/design/src/fonts` with their licenses, `font-display: swap`, declared only in `styles/fonts.css`.
- Fallbacks: `'Sarasa Mono SC', ui-monospace, monospace`; `'Inter', 'Source Han Sans SC', system-ui, sans-serif`.

| Name | Size / line height | Weight | Font | Purpose |
|---|---|---|---|---|
| `h1` | 20 / 28 | 700 | mono | PageHeader title |
| `h2` | 16 / 24 | 700 | mono | Section title, Dialog title |
| `body` | 13 / 20 | 400 | mono | Default text, tables, controls, nav items |
| `small` | 12 / 16 | 400 | mono | Table header, help text, error messages, group labels, stat labels |
| `micro` | 11 / 14 | 400 | mono | Status bar, nav counts |
| `metric` | 18 / 24 | 400 | mono | Stat card values |
| `prose` | 15 / 26 | 400 | prose | Conversation prose, rendered Markdown |
| `prose-small` | 13 / 20 | 400 | prose | Page-header and form-section descriptions |

- Numbers always use `font-variant-numeric: tabular-nums`.
- No italics and no letter-spacing adjustment.

### 2.3 The five roles of the accent color (only these five)

| Form | Used for |
|---|---|
| Solid (`accent` ground + `on-accent` text) | The **only** primary action in a view |
| Outline (1px `accent` border + `accent` text) | Secondary actions that need emphasis; a conversation card waiting for a person gets only an outline (`Card tone="accent"`) |
| Tinted ground (`sidebar-active` ground + `ink` text in the sidebar; underline `inset 0 -2px 0 accent` for PageTabs) | The current top-level navigation item (the sidebar is vertical, so it is a tinted ground, not an underline), the current PageTab |
| Text (`accent` text / the `spinner` icon) | Something is happening: running, live, auto-refresh countdown, cursor |
| Ground + left marker (`accent-tint` ground + `inset 2px 0 0 accent`) | The selected row / item |

The accent color must not be used anywhere else. Selected segments and selected filter chips use the `selected` ground, not the accent.

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
| Layout | `sidebar` / `sidebar-rail` / `content-list` / `content-form` / `chat` / `status-bar` / `action-row` / `gutter` | 256 / 48 / 1080 / 880 / 720 / 24 / 40 / 20 | `--cb-layout-<name>` |
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

**Lines**: 1px. Column dividers, table row dividers and the status bar / action row top lines use `line-soft`. Borders (`line`) only on things that float over content or take input: inputs, buttons, chips, inline cards, overlays (`line-strong`). Cards, sections, stat cards, form field cards and the table container have **no border** and use the `panel` ground.

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

- Wordmark: `CAPYBARA`, 700, 8 away from the Logo.
- **Dither dot matrix**: used only for the backgrounds on both sides of auth pages and (optionally) the PageHeader corner of the overview page; 4px squares, density decreasing from one side to the other, with at most 1% accent-colored squares as accents. No other page may use it.
- No illustrations, gradients, frosted glass or emoji.

---

## 4. App Shell (system layout)

Every page (except auth pages, §5 T10) is **Sidebar | content area**. The content area holds, top to bottom, in a fixed order:

| Layer | Height | Required | Content |
|---|---|---|---|
| Drawer menu bar | `row.roomy` | Only below 960 | Menu button that opens the sidebar drawer, page title |
| PageHeader | content | Required | Row 1 breadcrumb (optional); row 2 title + one-line description, actions on the right (§4.2) |
| PageTabs | 36 | Optional (detail pages only) | In-page tabs, current item underlined |
| Body | flexible | Required | One of the layouts in §4.3 |
| ActionRow | `layout.action-row` | Optional | Appears when the page has actions to submit, stacked above the StatusBar |
| StatusBar | `layout.status-bar` | Required | Read-only: context · page status ｜ system status · version · time zone |

- The sidebar spans the full window height; the ActionRow and StatusBar sit **only in the content area**, fixed at its bottom; they never span the sidebar.
- There is no TopBar.

### 4.1 Sidebar

See §6.13 for the component. Width `layout.sidebar`; below 1280 an icon rail of `layout.sidebar-rail`; below 960 a drawer opened from the drawer menu bar.

### 4.2 PageHeader

- Two rows. Row 1 (optional): breadcrumb, `small` `muted`, links separated by a `faint` `/`, inside a `nav` labelled "Breadcrumb"; a crumb without a link (the current object) is plain text. Row 2: title (`h1`, single line with an ellipsis, full text in `title`) + count / status, a one-line description under it (`prose-small` `muted`, single line with an ellipsis), actions on the right.
- No bottom line and no background; spacing separates it from the body.
- Actions: at most 1 solid primary action + 2 secondary + a `more-horizontal` menu; the primary action is rightmost; all `default` density; an action may lead with a 14 icon (`plus` on a create action). The submit action of form pages **must not** go here; it goes in the ActionRow.
- List-page key metrics are **not** in the header: the template renders them below the header as StatCards (§6.14), at most 4–5. List and overview pages draw them at the top of the body; full-width templates (detail, trace, inbox) draw them in the fixed header area under the PageHeader.
- Content width: the header shares the body's content width (lists 1080, forms 880, centered; §4.3). It sits `space.6` below the top of the content area and `space.3` above the body (StatCards or the table).

<!-- states: page-header -->
States: `title`, `breadcrumb`, `description-actions`, `long-title`

<!-- size-table: page-header -->
| Part | State | Property | Value |
|---|---|---|---|
| page-header-title | title | font-size | type.h1 |
| page-header-title | title | line-height | type.h1.line |
| page-header-title | title | color | color.ink |
| breadcrumb | breadcrumb | font-size | type.small |
| breadcrumb | breadcrumb | color | color.muted |
| page-header-description | description-actions | font-size | type.prose-small |
| page-header-description | description-actions | line-height | type.prose-small.line |
| page-header-description | description-actions | color | color.muted |
| button[data-variant=primary] | description-actions | height | control.default |
| page-header-title | long-title | height | type.h1.line |
| page-header | long-title | width | 608 |

### 4.3 Body layouts and content widths

| Layout | Structure | Used for |
|---|---|---|
| Single | Content | Overview, trace viewer, system status, first use |
| Rail + Content | 240 + flexible | Lists with facet filters |
| Content + Inspector | flexible + 400 | Details |
| Rail + Content + Inspector | 240 + flexible + 400 | Inbox |
| Centered | content max `layout.content-form` (880), centered | Forms, settings, wizards |

- Content widths: list pages and the overview `layout.content-list` (1080), forms / settings content / wizards `layout.content-form` (880), centered; details, inbox and trace use the full width; the conversation page has its own columns (§5.4). The page gutter is `layout.gutter` on both sides. The Centered layout has **no anchor navigation**; a form's error count lives in the ActionRow.
- Content has a minimum width of 560. The Rail is collapsible; the Inspector is closable.
- Scrolling: the sidebar, PageHeader / PageTabs / ActionRow / StatusBar are fixed; the sidebar's conversation section, Rail, Content and Inspector scroll independently; the page must not show a horizontal scrollbar (wide tables scroll inside their own container).
- Responsive: < 1280 the sidebar becomes the rail and the Inspector a right-side Sheet; < 960 the sidebar becomes a drawer and the Rail a toolbar "Filter" button + Sheet; < 640 the header actions beyond the primary fold into `more-horizontal`.

### 4.4 ActionRow and StatusBar

- **StatusBar**: one form only. Height `layout.status-bar`, **no background**, a `line-soft` top line, `micro` type, `muted`, padding `layout.gutter`. Left: `user@org:route` and the page status (such as "Filtered 18 / 24", "Auto-refresh 15s"), `space.3` apart; right: system status, version and time zone, separated by spacing only (`space.3`, as the signed reference). No `>` prefix, no status dot (success is not colored). **Read-only**: it never holds a clickable control and never grows into an action bar. When space runs out the left part truncates first (ellipsis), the right part stays.
- **ActionRow**: when the page has actions to submit (forms, bulk edits, approval decisions, wizards) it appears **above** the StatusBar; both stay fixed at the bottom of the content area. Height `layout.action-row`, `panel-2` ground, `line-soft` top line, padding `layout.gutter`. Left: an accent dot + "N unsaved changes" (`muted`) `·` "N errors" (`fail` text, no icon, as the signed reference; the words carry the state), or a muted "No unsaved changes" ("没有未保存的修改", when the page passes `unsaved: 0`); right: Cancel / Discard (default) · secondary action (default) · primary action (primary, rightmost), all `default` density. With no changes the primary is disabled.
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
| button[data-variant=primary] | clean | color | color.faint |

---

## 5. Page templates

A new page **must** pick one of the following templates; a new template requires extending this section first and going through review. Every template takes the PageHeader of §4.2 and the content widths of §4.3.

| # | Template | Body | PageTabs | ActionRow | Width | Typical pages |
|---|---|---|---|---|---|---|
| T1 | Overview | Single | — | — | list | Org home, Agent summary |
| T2 | List | Rail + Content | — | During bulk edits | list | Agents, connectors, extensions, members |
| T3 | Detail | Content + Inspector | Yes | — | full | Agent, connector, extension details |
| T4 | Form | Centered | — | Always (submit actions) | form | Create / edit Agent |
| T5 | Settings | Rail (second-level navigation, named "Settings navigation", not collapsible, its first item level with the header) + one content column holding the PageHeader and the content at the form width, so the title lines up with the content | — | When there are changes | form | Org, environment, security |
| T6 | Inbox | Rail + Content (+ Inspector) | — | During decisions | full | Human approval, alert handling |
| T7 | Conversation | Title bar + thread + composer, with the properties panel or one right panel (§5.4) | — | — | own columns | The conversation page (`/chat`, `/chat/<id>`) |
| T8 | Trace | Single (top: span waterfall, bottom: span detail) | — | — | full | Single run detail |
| T9 | Wizard | Centered + step bar | — | Always (Previous / Next) | form | First-time model, connector and extension setup |
| T10 | Auth | No Shell, centered card + dither dot matrix on both sides | — | — | — | Sign in, password recovery, accept invitation, initialization |
| T11 | System status | Single centered | — | — | — | 404, 403, under maintenance, not enabled |
| T12 | Onboarding | Single centered checklist | — | — | — | New org, empty environment |

### 5.1 List (T2)
- Order in the content column: PageHeader → StatCards (when the header has `metrics`) → the DataTable (its toolbar above the table, pagination below), separated by `space.3`.
- Rail: faceted filters; each group has a title (muted) + checkbox items + counts.
- Content = one DataTable (§6.6) on the `panel` ground (framed, as the signed reference; `framed={false}` is only for a table inside a Card), whose toolbar, bulk bar and pagination all belong to the DataTable.
- Subordinate section (optional, at most one): below the main table with a `space.6` gap, an `h2` title + one DataTable listing secondary objects closely related to the main object and few in number (such as "Invitations" on the members page); it has no filters or metrics of its own, and the create entry stays in the PageHeader. When the secondary objects need their own filters or are numerous, make a separate list page.
- PageHeader: title + total, description, secondary actions on the right + Create (primary); metrics ≤ 5 as StatCards.
- StatusBar page status: the number of filter results.

<!-- states: template-list -->
States: `page`

<!-- size-table: template-list -->
| Part | State | Property | Value |
|---|---|---|---|
| sidebar | page | width | layout.sidebar |
| content | page | max-width | layout.content-list |
| status-bar | page | height | layout.status-bar |

### 5.2 Detail (T3)
- PageHeader: breadcrumb to the parent; name + version (faint) + status; actions: Edit (default), Trial run (secondary), `more-horizontal`.
- PageTabs: Summary · Runs · Config · Versions · Permissions · Audit (pick per object type), with counts following in faint.
- Content: sections on the `panel` ground with radius `md` (no border), section header h2 + actions on the right, `space.4` between sections.
- Inspector: grouped properties, group title small muted, key 8ch wide muted, value single line with ellipsis.

### 5.3 Form (T4)
- PageHeader: breadcrumb to the parent; title "Create X" + draft badge; only auxiliary actions on the right (such as "Import from YAML").
- No anchor navigation (the Centered body has none, §4.3).
- Sections: a two-column grid, the left column 240 wide with the section title (`h2`) and a description (`prose-small` `muted`), the right column the fields on a `panel` card with radius `md`, padding `space.4`, `space.3` between fields. Sections are separated by `space.6` of spacing, **not by lines**; rows inside a list of switches are divided by `line-soft`.
- Fields: label on top (`body` `ink`; required marked with an accent `*`, optional marked "Optional" in faint); controls `default` density; help text and error message below (`small`); on error the border is `fail` and the message starts with the `circle-alert` icon and gives an actionable suggestion.
- The ActionRow is always present: Cancel · Save draft (⌘S) · Publish.

<!-- states: template-form -->
States: `page`

<!-- size-table: template-form -->
| Part | State | Property | Value |
|---|---|---|---|
| sidebar | page | width | layout.sidebar |
| content | page | max-width | layout.content-form |
| action-row | page | height | layout.action-row |
| status-bar | page | height | layout.status-bar |

### 5.4 Conversation (T7)

`ConversationPage` (replaces `PlaygroundPage`, which only the conversation page used and which is removed when the page moves over). Signed off with reference set B on 2026-10-27; UI refresh spec §5.

- **Columns**: the sidebar (§4.1) | the middle column | the right area.
  - The **middle column** holds, top to bottom: the title bar (§6.16.1), the thread (centered, at most `layout.chat` wide, gutters `layout.gutter`, padding `space.4` on top, items `space.3` apart, following the bottom while the reader is at the bottom), the composer (§6.16.2, at most `layout.chat` plus the gutters wide, centered, `space.3` from the status bar) and the status bar (§4.4). It is never narrower than `layout.chat-min`.
  - The **right area** holds one thing at a time: either the **properties panel** (§6.16.17), which sits *inside* the middle column under its title bar so the title bar spans thread and properties, or **one right panel** (§6.16.18), full height beside the middle column, whose title bar then narrows with it. Opening one closes the other; "none" is the default.
- **Narrow windows**: below 1280 (where the sidebar becomes the rail, §4.3) the right area is a right-side Sheet over the page (`layout.panel` wide, `shadow-sheet`, a `scrim` behind it), closed by Esc, its close button or a click on the scrim. At 1280 and above it sits beside the thread; with the full sidebar at exactly 1280 the panel narrows to 544 so the thread keeps `layout.chat-min` (maintainer ruling 2026-10-27).
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
| primary | `accent` ground, `on-accent` text, 700 | `accent-hover` ground | `accent-press` ground | The only primary action of a view |
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
| button[data-variant=primary] | disabled | color | color.faint |
| button[data-variant=default] | disabled | border-top-color | color.line-soft |
| button[data-variant=ghost] | disabled | border-top-color | color.line-soft |
| button[data-variant=primary] | loading | height | control.default |

### 6.2 Input / Select / Textarea / Stepper
- Height `control.<step>` (28 by default), inner padding `space.2`, 1px `line` border, radius `sm`, transparent ground, `body` type.
- Focus: `accent` border + 3px `focus-ring` halo (§2.5); error: `fail` border; disabled: `line-soft` border, `hover` ground, `faint` text. Hover and focus transition border and halo over `motion.hover`.
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
| input | disabled | border-top-color | color.line-soft |
| input-control | disabled | color | color.faint |

### 6.3 Checkbox / Radio / Switch / option card
- Checkbox and radio are 14×14 with radius `sm` (radio round). Checkbox checked: `accent` ground + `on-accent` `check` icon; indeterminate `minus`. Radio checked: `accent` border + a 6×6 `accent` inner dot.
- Switch: a `space.7` × `space.5` (32 × 20) track with radius `bubble` and 2px padding, a `space.4` (16) round knob; off: `line` track + `muted` knob; on: `accent` track + `on-accent` knob moved right by `space.3`; the knob moves over `motion.hover`. Where a switch stands alone its label and current state ("On" / "Off", muted) are shown as text next to it, so the state never relies on color: `SwitchField` draws that row, `control.default` high with `space.2` gaps (clicking the label toggles too).
- Switch list (`SwitchList`, a form's tools and similar lists): one `row.roomy` row per item with the name and a `small` prose `muted` description (each one line with an ellipsis), `muted` `small` meta text (such as the policy) and the switch; padding `space.4`, rows divided by `line-soft`; it sits in a `flush` FormSection card.
- Option card (rich option of a single choice): 1px `line` border, radius `md`; selected `accent` border + `accent-tint` ground.

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
- Tabs: text + underline when selected (§2.3); hover `hover` ground; disabled `faint`.
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
- LinkCard: a card that leads to another page (admin overview sections): `panel` ground, radius `md`, padding `space.4`, `space.2` apart: the title (`body`, 700), a `prose-small` `muted` description, and one TextLink with a `faint` `chevron-right` (12). Not in the reference set (like KeyValue).

### 6.6 DataTable
Structure, top to bottom: toolbar / bulk action bar → the table (header and rows on the `panel` ground, **square, no border**) → pagination. The toolbar and pagination sit on the page ground outside the panel.

- **Density**: the rows (row menus, inline controls) and the pagination are `dense` (`DensityContext` around the body); the toolbar, the bulk action bar and the empty-state actions are `default`, as the signed reference draws them, so the toolbar has the height of the page's other controls.
- Toolbar: search (240 wide, `search` icon prefix, `/` focuses), filter chips (§6.15), clear all; at the right end (`toolbarEnd`, right-aligned as the signed reference) sort, view switch, column settings. It has the same height as the bulk action bar so nothing jumps when one replaces the other in place.
- Bulk action bar: when ≥1 row is checked it **replaces the toolbar in place**, `panel` ground, radius `sm`, left "N selected" (700) + bulk actions, right "Deselect Esc". An accent border or ground must not be used.
- Header: `row.dense` high, padding `space.2`, `small` `muted`, weight 400; the column being sorted is `ink` + `arrow-down` / `arrow-up`; a sortable column shows `arrow-up-down` and a `hover` ground on hover.
- Name cell of a roomy row: `CellTitle` (an optional initial tile, `control.dense` square on `selected` with radius `sm`, then the name and a `small` prose `muted` description, each one line with an ellipsis). A row is named by its first cell (the row checkbox reads "Select {name}"): a plain-text cell, or the `title` of a `CellTitle`; `rowLabel` overrides it.
- Rows: height by `rowHeight`: `dense` 28, `default` 32, `roomy` 44 (two lines: name + a `small` prose description, or a thumbnail). Cell padding `space.2` horizontally, the first and last columns `space.3` toward the edge. Row dividers are 1px `line-soft` above each row; no outer border. Success in a status column has no mark (§2.4).
- Alignment: numbers, durations and amounts are right-aligned; IDs and times are left-aligned; IDs and times use `muted`. An overlong single line is truncated with an ellipsis and the full text is shown on hover with a native `title`.
- Row states (priority from high to low when they occur together): focus ring > selected > checked > hover > default. They paint the row ground, transitioning over `motion.hover`.
  - Hover: `hover` ground; the checkbox border turns `ink`.
  - Selected (opens the detail / Inspector): `accent-tint` ground + a 2px accent bar on the left (§2.3).
  - Checked: only the checkbox turns accent; the row ground is unchanged.
  - Focus: 1px inner outline in the accent color.
  - Disabled / archived: the whole row is `faint` and cannot be checked.
- Inline menu `more-horizontal` (a dense icon button, right-aligned in a 48-wide last column: `control.dense` + `space.3` on both sides): ≤5 items, the dangerous item at the bottom and separated by a divider; while open, the button ground is `selected`. When a row has no available actions it shows no button (the cell stays, so column alignment doesn't change).
- Expanded row: `panel-2` ground, indentation and a `└` leader, showing a summary (such as the first few steps of an execution trace).
- Empty states (inside the panel, under the header):
  - Loading: skeleton rows (`row.dense` high, `space.3` bars in `selected` with radius `sm`), no spinner; the bars are hidden from assistive tech and a `status` region reads "Loading".
  - Empty (first time): the `empty` icon + one `muted` sentence + the next action (`default`), `space.8` padding above and below.
  - The empty states and the skeleton rows keep a row cell's horizontal padding: `space.3` at the first-column edge (left) and `space.2` on the right, as the signed reference draws its full-width cell, so their content centers 2px right of the panel's middle.
  - No results (caused by filters): the `search-x` icon + a description of the current filters + "Clear filters".
  - Error: `circle-x` + "Failed to load" in `fail`, the error code · request ID (muted) + "Retry" (`refresh`).
- Keyboard: ↑↓ move focus, Space checks, ↵ opens, Esc deselects.
- The header is sticky; when scrolling horizontally the first column sticks to the left.

<!-- states: table -->
States: `default`, `row-hover`, `row-selected`, `loading`, `empty`

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
| table-empty-title | empty | color | color.muted |
| table-empty button | empty | height | control.default |
| menu-cell | default | width | 48 |
| menu-cell icon-button | default | height | control.dense |

### 6.7 Overlays

Selection rules: the user needs to decide → Dialog; view / edit one object without leaving the list → Sheet; in-place options / filters → Popover / Menu; feedback on an operation result → Toast (a Dialog must not be used); creating something with more than 6 fields → a form page (T4).

- **Dialog**: width 480 / 640, `panel` background + `line-strong` border + radius `md` + `shadow-2` + `scrim`. Header (h2 title + close `x`) / body (padding 16) / footer (right-aligned: ghost Cancel + primary action, the primary action carries `↵`), with 1px `line` separating header and footer. Esc closes; focus is trapped and returned after closing. Default focus: on the primary action for an ordinary dialog, on Cancel for a dangerous dialog.
- **Dangerous confirmation**: `fail` frame, `fail` title; explains the consequences and recoverability; the object name must be typed, the confirm button is disabled until it matches, and is danger-solid once it matches.
- **Sheet**: slides out from the right, width 480 / 720, `panel` background + `line-strong` left line + `shadow-sheet`; no scrim by default (the list is still operable). Header: name + version + open in a new page `external-link` + close `x`; may contain Tabs; footer: actions. Closing with unsaved changes needs a second confirmation.
- **Links**: the design package is framework-agnostic; links in the sidebar navigation, the PageHeader breadcrumb, Tabs, Sheet, TextLink and LinkCard are rendered through the `link` component of `DesignProvider` (default `<a>`); `apps/web` passes next-intl's `Link` to get client-side navigation and the locale prefix. Pages should not build `<a href>` themselves for in-site navigation.
- **Popover / Menu**: `panel` background + `line-strong` border + radius `md` + `shadow-1`; menu items are `row.default` high with padding `pad.default.x`; a filter Popover has a search `>` at the top and "Clear / Apply ↵" at the bottom; a hovered item gets a `hover` background. The trigger button is outlined in the accent color when open and holding a value.
- **Command palette (⌘K)**: width 560, input with a `>` prefix; group titles small faint; the current item has an `accent-tint` background + left marker; key hints at the bottom.
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
- **ToolCallRow** (superseded by the tool group and tool row of §6.16.8–§6.16.10, together with IoBlock, Timeline and the Inspector-only Checklist; kept until the conversation page moves over, then deleted): by default only one line: tool name (700) + a one-sentence description (`muted`, single line with ellipsis) + a `StatusMark` for non-completed states (running / failed / cancelled) + `▸` on the right. The whole row is an expand button, with a `hover` background on hover. On error the tool name is `fail`; when cancelled it is `muted`. Once expanded, inside a 1px `line` frame come two `IoBlock`s, IN and OUT (no OUT while running); when the output is truncated, the bottom shows small `faint` "Output too long, truncated" + a "View full output" text button (leaving it to the caller to fetch the full text from the archive).
- **IoBlock**: `panel` background; a 5ch label column on the left (`IN` / `OUT`, 11px 700 `faint`, right line `line`), and monospace raw text on the right (line breaks preserved, long words broken); IN is `ink`, OUT is `muted` (`fail` when the tool errored). Beyond `collapsedLines` (default 12) lines only the first N lines are shown, with an "Expand all (M lines)" / "Collapse" text button below (`aria-expanded`).
- **Checklist**: each item is `icon + text`. `pending` `square` `faint`; `in_progress` `spinner` accent, the whole row gets an `accent-tint` background + a 2px accent bar on the left + 700, `aria-current="step"`; `completed` `check` `muted` (success is not colored, §2.4), text `faint` and struck through with `<s>`. Each item carries screen-reader status text (To do / In progress / Done).
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
- Interaction: `role="tree"` (`aria-label` taken from `label`, default "Span waterfall"; always expanded, cannot be collapsed), each row `role="treeitem"`, with `aria-selected`, `aria-level` (depth + 1), and a row with child spans has `aria-expanded="true"`; focus stays on the tree, and the current item is indicated by `aria-activedescendant`. Clicking a row selects it; once focused, ↑ / ↓ select the previous / next, and Home / End select the first / last. The selected row gets an `accent-tint` background + a 2px accent bar on the left (§2.3).
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

The left sidebar replaces the TopBar on every page (UI refresh spec §4.4).

- **Frame**: width `layout.sidebar`, `sidebar` ground, a `line-soft` right divider, padding `space.3` / `space.2`, the full window height. Sections, top to bottom:
  1. Top row (`row.default`): logo (pixel unit 2) + wordmark `CAPYBARA` + a search icon button (`search`, opens ⌘K; accessible name includes "⌘K").
  2. Navigation (`nav` labelled "Main navigation"): "New conversation" (`plus`, `ink`) first; then Overview · Agents · Skills · Inbox (count) · Connectors · Catalog · Channels · Evals (labels as the code names them); an **Extensions** group (label `small` `muted`) listing the org's extension pages, shown only when there are any; then, after `space.3`, Settings and Admin. Items follow `NavAudience` (all / member / admin / enterprise); hiding is cosmetic, the kernel decides.
  3. Conversations: the current user's conversations **grouped by agent**, groups ordered by latest activity, the section scrolls on its own (`min-height: 0; overflow-y: auto`) after `space.4`.
  4. Account footer, pinned at the bottom (`row.default`): a 24 round initial avatar on `selected` (the name's first grapheme) + "name · org" (no chevron, as the signed reference draws it), opening the account menu (org switch as `menuitemradio` items with the current org checked, language, theme, sign out). Its accessible name is "Account: name · org".
- **Nav items**: `row.default` high, radius `sm`, padding `pad.default.x`, icon 16 + label (`body`, single line with an ellipsis) + an optional count (`micro` `muted`, right-aligned). Others `muted`; the current item gets the `sidebar-active` ground + `ink` text (§2.3), hover the `hover` ground + `ink`. The inbox count shows `99+` above 99 and `n+` when truncated; the accessible name includes it ("Inbox, 3 pending").
- **Groups**: a label row (`row.dense`): the agent name (`small` `muted`, essential text, never `faint`; single line with an ellipsis, full name in `title`) inside a toggle button with `aria-expanded` and a `chevron-down` / `chevron-right` 12 icon, and a dense `plus` icon button "New conversation with {agent}". Collapse is remembered per viewer in `localStorage["cap.sidebar.collapsed"]` (a JSON array of agent ids, read and written inside try/catch; renders expanded when storage throws).
- **Conversation rows**: `row.dense` high, radius `sm`, padding `pad.default.x`, `muted` single line with an ellipsis and the full text in `title`; the active conversation gets `sidebar-active` + `ink`. An untitled conversation reads `未命名会话 · MM-DD HH:mm` / `Untitled conversation · MM-DD HH:mm` (its start time). Each group shows its 5 most recent conversations, then a "More" text row; the list shows 20 groups, then a "More" row for groups.
- **States of the conversation section**: empty: one `small` `muted` line "还没有会话，从 Agents 里选一个开始。" / "No conversations yet. Pick an agent to start."; loading: skeleton bars (`space.3` high, `selected`, radius `sm`) in three groups (3, 2, 2), `aria-busy`, no spinner; error: `circle-alert` + "会话列表加载失败" / "Couldn't load conversations" in `fail` and a dense ghost "Retry" (`refresh`).
- Long titles and agent names (40+ CJK characters without spaces) truncate to one line and never widen the sidebar.
- **Rail** (below 1280): width `layout.sidebar-rail`, icons only (each item `row.default` square, accessible name kept, a Tooltip with the label to the right, past the rail's edge, on hover and focus), the inbox count as a small `selected` badge inset 2px from the icon box's top right corner (min width 14, padding 0 3px, as the signed reference draws it), hover over the current item takes the `hover` ground (the signed rail reference; the full sidebar keeps the current ground under hover), separators in `line-soft`; the conversation section is replaced by one icon button (`panel-left`, "Expand sidebar") that opens the drawer.
- **Drawer** (below 960): the full sidebar slides in from the left over a `scrim`, with `shadow-float`, opened from the menu button in the drawer menu bar; the top row's search button becomes a close button (`x`), and the drawer menu bar carries the search button (`search`, at its right end) so the command palette stays reachable by pointer below 960. Esc, the close button and route changes close it; focus returns to the menu button.
- **First paint**: the full / rail / drawer variant follows the window width through CSS media queries before hydration (both panels are drawn, one shown), so the server render never draws the full 256 sidebar at a narrow width. Remembered collapsed groups apply on the first client commit without the height motion; the motion runs only after the viewer toggles a group. The remembered list is kept per org (`cap.sidebar.collapsed.<orgId>`, the `scope` the page passes), keeps at most 100 ids and drops ids of agents no longer listed once every group of that org is loaded.
- Hover never replaces the current item's `sidebar-active` ground.
- Interaction: §6.11.

<!-- states: sidebar -->
States: `default`, `item-hover`, `item-focus`, `conversation-active`, `group-collapsed`, `empty`, `loading`, `error`, `long-title`, `many-groups`, `guest`, `rail`, `drawer`

<!-- size-table: sidebar -->
| Part | State | Property | Value |
|---|---|---|---|
| sidebar | default | width | layout.sidebar |
| sidebar | default | background-color | color.sidebar |
| sidebar | default | border-right-color | color.line-soft |
| new-conversation | default | color | color.ink |
| nav-item | default | height | row.default |
| nav-item | default | border-radius | radius.sm |
| nav-item | default | padding-left | pad.default.x |
| nav-item | default | font-size | type.body |
| nav-item | default | color | color.muted |
| nav-item[aria-current=page] | default | background-color | color.sidebar-active |
| nav-item[aria-current=page] | default | color | color.ink |
| group-label | default | height | row.dense |
| group-label | default | font-size | type.small |
| group-label | default | color | color.muted |
| conversation | default | height | row.dense |
| conversation | default | padding-left | pad.default.x |
| account | default | height | row.default |
| avatar | default | width | control.dense |
| nav-item[data-ref-forced=true] | item-hover | background-color | color.hover |
| nav-item[data-ref-forced=true] | item-hover | color | color.ink |
| nav-item[data-ref-forced=true] | item-focus | outline-color | color.accent |
| nav-item[data-ref-forced=true] | item-focus | outline-width | 1 |
| conversation[aria-current=page] | conversation-active | background-color | color.sidebar-active |
| conversation[aria-current=page] | conversation-active | color | color.ink |
| group-label[aria-expanded=false] | group-collapsed | color | color.muted |
| empty-hint | empty | font-size | type.small |
| empty-hint | empty | color | color.muted |
| skeleton-bar | loading | height | space.3 |
| skeleton-bar | loading | background-color | color.selected |
| retry | error | height | control.dense |
| sidebar | long-title | width | layout.sidebar |
| conversation | long-title | height | row.dense |
| sidebar | many-groups | width | layout.sidebar |
| sidebar | guest | width | layout.sidebar |
| sidebar | rail | width | layout.sidebar-rail |
| nav-item | rail | width | row.default |
| nav-item[data-ref-forced=true] | rail | background-color | color.hover |
| rail-badge | rail | top | 2 |
| rail-badge | rail | right | 2 |
| rail-badge | rail | min-width | 14 |
| rail-badge | rail | padding-left | 3 |
| sidebar | drawer | width | layout.sidebar |

### 6.14 StatCards

The key metrics of a list page, as a row of cards below the PageHeader (§5.1), at most 5 (throws in development and tests otherwise).

- The row: equal-width cards, gap `space.2`.
- A card: `panel` ground, radius `md`, no border, padding `space.2` / `space.3`; label `small` `muted` on top, value `metric` below.
- Only warn / fail values are colored (`warn` / `fail`), and their label says what they are ("Needs authorization", "Errors"); success values are never colored.

<!-- states: stat-cards -->
States: `four`, `five`, `tones`

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
- **Link buttons** ("View all", "Copy output", "Retry", "Open"): no ground or border, `muted` (or `fail` inside a failure), underlined in `line-strong` with a 2px offset.
- Names in the reference set are placeholders (示例组织, 研究助手, Acme …); copy comes from §7.

#### 6.16.1 Title bar

- Belongs to the middle column only and never spans the right panel. Height `layout.title-bar`, padding 0 `space.3` 0 `space.5`, no ground, no bottom line.
- Left: the title button (`control.default` high, radius `sm`, padding 0 `space.2`, pulled left by `space.2`, `body` `ink`, one line with an ellipsis and the full title in `title`, then `chevron-down` 14 `muted`; `hover` ground on hover and while its menu is open). It opens a menu: Rename (`square-pen`), Copy link (`link`), a separator, Delete (`trash-2`, `fail`). Rename opens a dialog; a manual rename stops title generation for good.
- Untitled: the title reads "未命名会话 · MM-DD HH:mm" / "Untitled conversation · MM-DD HH:mm" (the start time) in `muted` until a generated or manual title exists. The new-conversation page shows only the `muted` label "新会话" / "New conversation".
- Right, two groups of ghost icon buttons (`control.default` square, radius `sm`, icon 16): group 1 is the properties toggle (`panel-right`); then a 1px × `space.4` `line` separator with `space.1` on each side; group 2 is Files (`file-text`) and the panel icons of the extensions enabled in the org, in contribution order, then More (`more-vertical`). Icons that don't fit move into More, a menu of icon + label items. The open item's button has `aria-pressed="true"`, the `selected` ground and an `ink` icon; More is pressed while its menu is open.

<!-- states: title-bar -->
States: `default`, `untitled`, `rename-menu`, `panel-active`, `overflow`, `long-title`

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

<!-- states: composer -->
States: `idle`, `new`, `running`, `attachments`, `focus`, `no-effort`

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
| send | idle | color | color.faint |
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

#### 6.16.3 Picker menu

- The model, effort and agent menus of the composer: a Menu (§6.7: `panel` ground, 1px `line-strong` border, radius `md`, `shadow-1`, padding `space.1`) opening above its picker with a `space.1` gap. Items are `menuitemradio`, `row.default` high, padding 0 `pad.default.x`, radius `sm`, `ink`; the selected item has `aria-checked="true"`, the `selected` ground and a `check` 14 at its end.
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
- Rendered Markdown (`Markdown`, mdast to React elements, never HTML): headings (`#` to `###` as `h3`–`h5`, all `h2` type 16 / 24, 700), paragraphs, lists (indented `space.5`), blockquotes, code blocks (CodeBlock, §6.9), inline code (mono `body` on the `selected` ground, radius `sm`, padding 0 `space.1`), emphasis, strong (700), links (`ink`, underlined in `line-strong` with a 2px offset; only absolute http(s), opened with `target="_blank" rel="noopener noreferrer"`; anything else renders as text), GFM tables (mono `small`; header `muted` 400, left-aligned; cells padded `pad.dense.y` `space.4` `pad.dense.y` 0 with a `line-soft` top line per body row; numeric columns right-aligned; at most 200 rows, then "还有 N 行" / "N more rows"), thematic breaks. Raw HTML renders as text; images are not loaded (an http(s) image becomes a link with its alt text).
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
- Attachments sit above the bubble, right-aligned, `space.2` apart: images as `layout.thumb` square thumbnails (radius `sm`, cropped to fill), then files as attachment chips (§6.16.21, without the remove button). Each opens like today's AttachmentPreview.

<!-- states: user-bubble -->
States: `default`, `attachments`

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
- **Summary** (copy in §7): counts by kind with each kind's verb, joined by "，" / ", " in order of first appearance; failures add "（N 个失败）" / " (N failed)" in `fail`; edits add " · +a −b" in `faint`; a group whose rows all read, or all edit, one path names it in `ink` ("已读取 示例表.xlsx"). Running: a `spinner`, the running verb of the running row's kind and " · 已完成 N 个" / " · N done" in `faint`.
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
- **Status**: running — a `spinner` before the label, the label `ink`, the elapsed `m:ss` in `faint` at the end; done — no mark; failed — "失败" in `fail` and " · <the error's first line>" in `muted` (a shell command with a non-zero exit or a timeout is a failure); blocked by a policy hook — failed, "被 <extension> 拦截" / "Blocked by <extension>".
- **Expanded detail**: padding 0 `space.3` `space.3`, gap `space.2`, no IN / OUT labels:
  - inputs as a key / value grid (columns `max-content` and the rest, gap `space.1` × `space.3`, keys `faint`, values `ink`, breaking anywhere); a command as `$ <command>` (the `$` `faint`, the command `ink`);
  - the output: `bg` ground, radius `sm`, padding `pad.default`, `small` `ink`, wrapped, at most `layout.tool-output` high and scrolling; for a failure the full error text;
  - a footer (`micro` `faint`, gap `space.3`): the duration ("2.1 秒" / "2.1s") and "复制输出" / "Copy output"; for a large output instead "输出 82 KB，已显示前 4 KB" / "Output 82 KB, showing first 4 KB" and "查看全部" / "View all", which reads the archive (`GET …/outputs/:outputId`).

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
- Past `TOOL_VIEW_DIFF_MAX_LINES` the diff ends with a centered `muted` line under a `line-soft` rule: "差异过长，已截断 · 显示前 N / M 行 · 查看全部".

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

- **Pending**: a floating card with an `accent` border, gap `space.3`, `role="group"`. Head: an `accent` dot, "需要你批准" / "Approval needed" (700), the tool (`small` `muted`: "<connector>: <title>", or the source and the localized name when the tool has no title) and then **always** the model-visible tool key (`small` `faint`, e.g. `acme_tickets__send_message`; it wraps rather than truncates). The key stays even without a title, because two sources can share a display name. Then **every** input argument as a key / value grid: the tool's `keyArgs` first, in their order, then the other properties in input order; values that are not strings as compact JSON; each value wraps and is capped at 3 lines; under the grid a `small` `muted` link "查看完整输入" / "Show full input" opens the whole input JSON read-only in place ("无参数" / "No arguments" when the input is empty). Then the actions (`default` step, gap `space.2`): "批准" / "Approve" (primary), "本会话内都批准" / "Approve for this conversation", "总是批准" / "Always approve" (default) — each only when the request allows `once` / `session` / `always` — and "拒绝…" / "Deny…" (default); at the right end a `small` `muted` note naming the rule that asked (the agent's tool policy, the connector's policy, the tool's default, or role escalation).
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

- `ask_user` and connector elicitation. **Pending**: a floating card (`line` border, not accent), gap `space.3`, `role="group"` named by the question. The question in the prose font (`prose`, 700). Options as rows (`row.default` minimum height, padding `pad.default`, 1px `line` border, radius `sm`; a 12 round radio, `line-strong`, `accent` when checked; the checked row has an `ink` border); multi-select options use checkboxes; with `allowOther` a last row "其他：" / "Other:" holds a free-text input. Actions: "回答" / "Answer" (primary), "跳过" / "Skip" (default).
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
- **Paused** (the run failed or was stopped): the bubbles without their actions, then one line "运行已停止，队列已暂停（N 条）" / "Run stopped; queue paused (N)" in `muted` and "继续发送" / "Continue sending" (dense).
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

- Sub-agents group like tools (phase C runtime; B builds them on fixtures). **Running**: a header tool line with a `spinner` and "正在运行 N 个子 agent" / "N subagents running", and the rows in a tool box. **Done**: a collapsed header "N 个子 agent 已完成（M 个失败）· 共 X 次调用 · <duration>" / "N subagents done (M failed) · X calls · <duration>" with the failure count in `fail` and the totals in `faint`.
- **Row** (a tool row): a `spinner` while running; the agent type as a tag (`micro` `muted` on the `selected` ground, radius `sm`, padding 0 `space.1`); the task description in `ink` with an ellipsis; at the end in `faint` ("失败" in `fail` and " · " when failed) "N 次调用 · <duration>" and `chevron-right` 12, a button named "在右侧打开 <description>" / "Open <description> on the right". Success has no mark.
- The row open in the right panel has `aria-current="true"`, the `accent-tint` ground and a 2px `accent` bar on its left (§2.3).
- A row can expand in place (`aria-expanded`): the steps (`small`, gap `space.1`, indented `space.5`, padding 0 `space.3`, a 1px `line` rule on the left), the result (`prose-small` `muted`) and "在右侧打开完整记录" / "Open the full record on the right" (link button with `maximize-2` 12).

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
- Built-in sections, in order: **Context** (the usage ratio as the value; a meter `space.1` high, `line` track, `ink` fill, radius `sm`; "<model> · <sandbox status>" and "连接器：…" / "Connectors: …" in `small` `muted`); extension sections (`place: "section"`, in contribution order, rendered `dense`); **Files** (the count as the value; rows `row.dense`: type badge, name with an ellipsis, size in `muted`; then "全部 N 个文件" / "All N files" with `chevron-right` 12 in `muted`); **Background tasks** (rows `row.dense`: `spinner`, name, duration `muted`, a dense stop icon button `square` 12 named "停止 <name>" / "Stop <name>"; then "已完成 N 项" / "N completed" with a chevron).
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
- **Header**: `layout.title-bar` high, padding 0 `space.2` 0 `space.4`, a `line-soft` bottom line, gap `space.1`: back (`chevron-left`, optional), the type badge (files), the title as a ghost button with `chevron-down` 14 that opens the switcher (a Menu: extension panels, a separator, the conversation's files, each group under a `micro` label), or plain text when there is nothing to switch to (a sub-agent); meta in `small` `faint` ("v2 · 10-26 14:20", "2 / 5", a `spinner` and the duration); actions; full screen (`maximize-2`); close (`x`).
- **Body**: padding `space.4` (flush for tables), scrolls on its own. A failing extension panel shows the load-failure line in its body.
- **Sub-agent panel**: header back, description, spinner and duration, "停止" / "Stop" (default), full screen, close; body padding `space.4` `space.5`: the task as a block (`selected` ground, radius `md`, padding `space.3`, `prose-small`; label "任务 · 主 agent 派出" / "Task · from the main agent" in `micro` `muted`), a tool line naming its agent, model and tool scope, then its tool groups and prose like the main thread; read-only; its own status bar at the bottom.

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

- A file the agent delivered (`artifact_created`; UI copy says "files" / 文件, never "artifacts" / 产出物). A link-styled button: at least `layout.file-card` wide, at most the column, padding `pad.default`, 1px `line` border, radius `md`, `raised` ground, `small` `ink`, gap `space.2`: the type badge (`micro` 700 `muted`, 1px `line` border, radius `sm`, padding 0 `space.1`; XLSX, PDF, MD, PNG …, else FILE), the name middle-truncated keeping its extension (full name in `title`), the size in `muted`, `chevron-right` 12. Hover: the `hover` ground; focus: 2px `accent` outline, 2px offset. It opens the preview in the right panel.
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
- **Uploading**: the chip stacks the name, the percent in `muted` and a 2px progress bar (`line` track, `ink` fill, `role="progressbar"`). **Rejected** (too large, wrong type, too many): a `fail` border and the reason in `fail` instead of the size; it can still be removed.
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

## 7. Copy and internationalization
- All UI text goes through next-intl, in both Chinese and English. Text shown to the model (prompts, tool descriptions) is always English, and the prompt field in a form must say so.
- Thousands separators for numbers; durations `6.8s` / `41.2s` / `00:00:18`; amounts `¥412.80`; relative time ("2 hours ago") for lists, absolute time (`10-18 14:02:11`) for records and logs.
- Error messages state the cause and give an actionable next step; include the error code and request ID for troubleshooting.
- **Files, not artifacts**: what an agent delivers from its sandbox is "文件" / "files" in UI copy, never "产出物" / "artifacts" (reserved for project C's Artifacts). The kernel identifiers (`artifact_created`, `/artifacts/:id/download`) stay as they are.
- **Untitled conversations** read "未命名会话 · MM-DD HH:mm" / "Untitled conversation · MM-DD HH:mm" (the start time) until a title exists.
- **Tool verbs** (§6.16.8, §6.16.9), as the signed reference set B draws them. Counts are Arabic numerals; failures append "（N 个失败）" / " (N failed)" in `fail`; mixed kinds join with "，" / ", " in order of first appearance:

  | Kind | Row verb zh / en | Group count zh / en | Running header zh / en |
  |---|---|---|---|
  | command | 已运行 / Ran (a shell row shows the model's `description` instead) | 已运行 N 个命令 / Ran N commands | 正在运行命令 / Running command |
  | read | 已读取 / Read | 已读取 N 个文件 / Read N files (one path: 已读取 <path> / Read <path>) | 正在读取文件 / Reading file |
  | edit | 已修改 / Edited | 已修改 N 个文件 · +a −b / Edited N files · +a −b (one path: 已修改 <path>) | 正在修改文件 / Editing file |
  | search | 已搜索 / Searched | counted with tools | 正在使用工具 / Using tool |
  | connector, tool | 已使用 / Used | 已使用 N 个工具 / Used N tools | 正在使用工具 / Using tool |
  | meta | 已加载的工具 / Loaded tools | counted with tools | 正在使用工具 / Using tool |

## 8. Accessibility
- Text contrast ≥ 4.5:1 (`faint` only for non-essential information).
- All interactive elements are native `button` / `a` / `input`; icon buttons must have an `aria-label`; status is not expressed by color alone.
- Fully keyboard accessible, focus visible (§2.5); overlay focus is trapped and returned.
- Respect `prefers-reduced-motion` and `prefers-color-scheme` (dark by default, switchable by the user).

## 9. Enforcement and acceptance (how the implementation is kept consistent with this spec)

### 9.1 Static rules (`pnpm check`)

1. **Package boundary**: `apps/web` may import UI components and templates only from `@capybara-hq/design`. The import rule is a **blacklist**: `@radix-ui/*`, `cmdk`, CSS-in-JS (`@emotion/*`, `styled-components`, `@stitches/*`, `@vanilla-extract/*`, `styled-jsx`), component libraries (`@mui/*`, `@chakra-ui/*`, `@mantine/*`, `@headlessui/*`, `antd`), `tailwindcss` / `tailwind-merge`, class-name utilities (`clsx`, `classnames`, `class-variance-authority`) and icon libraries (`lucide-react`, `react-icons`) must never be imported; `.css` may only import `@capybara-hq/design/styles.css`. The blacklist grows as new styling dependencies appear.
2. **Template enforcement**: every `page.tsx` under `apps/web/src/app` must render one of the §5 templates imported from `@capybara-hq/design` (aliases and namespace imports are recognized); the Shell layers are rendered only by templates. Two exemptions: the development catalog pages `app/[locale]/dev/**`; and pages that only handle 404 (containing no JSX and calling `notFound()` from `next/navigation`, such as `[...rest]/page.tsx`), whose page is rendered by the StatusPage in the same segment's `not-found.tsx`.
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

`apps/web/visual/fidelity.spec.ts` (Playwright, both themes) opens `/dev/ui/reference/<component>` for every accepted component and checks every size-table row against the block with the same id: sizes within ±1px, colors exactly equal to the token (compared as computed `rgb()` / `rgba()`). A failure names the component, state, part, property, expected and actual value. jsdom cannot measure layout, so these tests are Playwright only.

### 9.4 State coverage

The same spec fails when `/dev/ui/reference/<component>` lacks a block for a state in the component's state list (`missingStates`), and `checkSpecTables` (unit-tested in `packages/design/test/spec-tables.test.ts`, run against this document) reports a size table without a state list, a row whose state is not in the list, a value `tokens.json` lacks, and a duplicate marker. A completeness case in the same spec fails unless `ACCEPTED` (`apps/web/visual/accepted.ts`) lists exactly the components that have a state list here, except components listed in `PENDING_B` in the same file (the conversation-page components while UI refresh B builds them; each moves to `ACCEPTED` when it passes, and the list is empty when B is done): a component cannot get a state list and stay out of acceptance unnoticed.

### 9.5 Interaction tests

Hover, focus, expand / collapse motion and its reduced-motion form, the sidebar keyboard paths, the rail and the drawer (§6.11, §6.13) are covered by Playwright interaction specs in `apps/web/visual/` (for example `sidebar.interaction.spec.ts`), including "no horizontal page scroll" at 1440 / 1279 / 959 / 640.

### 9.6 Side-by-side acceptance

After each change to a reference-set component, `COMPARE=<components> pnpm --filter @capybara-hq/web compare` writes `apps/web/compare-out/index.html`: one row per block, the reference PNG on the left and the implementation's screenshot on the right, dark then light. The differences are listed by severity: **severe** (different structure or layout, a missing state, a wrong color) and **moderate** (a size or spacing off) block the merge; **minor** (rendering details) are listed in the PR. The maintainer reviews the page last. There is no pixel diffing against the reference PNGs: font rendering differs between systems and would cause false alarms; the measuring tests carry the pixel-level constraints.

### 9.7 Screenshot regression

Playwright screenshots the `/dev/ui` catalog and compares against the baseline; any difference fails. The committed baselines contain only the Linux version, generated by the `visual-update` workflow in the pinned Playwright Docker image (the CI `visual` job uses the same image); local (darwin) screenshots are gitignored and only for local comparison. A change is first accepted against the reference set (§9.6), then its baselines are regenerated; updating a baseline requires attaching the diff images in the PR.

### 9.8 CI placement and review

- `pnpm check` (lint job, full on every PR) runs §9.1. The measuring, state-coverage and interaction specs run in the `visual` job, by diff: `apps/web/**`, `packages/design/**`, and `docs/design/{spec.md,tokens.json}` through `EXTRA_INPUTS`. `compare` is a local review tool, not CI.
- Every UI PR is checked against this spec for template choice, density steps, accent color usage, status encoding and ActionRow rules.

## 10. Change process

Adding or changing a component, template or token: change this spec first (the rule, the state list and the size table), change `tokens.json` and the reference set (`docs/design/reference/src`) to match, and get the spec diff reviewed → implement in `packages/design` with `data-part` attributes and the `/dev/ui` reference blocks with the same ids → `pnpm --filter @capybara-hq/web compare` and side-by-side acceptance (§9.6) → re-render the reference PNGs (`reference-update`) and the screenshot baselines (`visual-update`). Pages must not invent new patterns ad hoc.
