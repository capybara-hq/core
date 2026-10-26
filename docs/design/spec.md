# Capybara Design System Spec (E · Terminal, refined)

> Status: implemented (`packages/design` + `/dev/ui`) · 2026-10-18; refined E rules, sidebar shell, size tables and states from UI refresh A · 2026-10-26
> Visual reference: the **reference set** in `docs/design/reference/` (one PNG per component state, dark and light, rendered from `docs/design/reference/src/` with the real fonts, the generated tokens and the shared fixtures). The maintainer signed it off on 2026-10-26; it replaces the design canvas as the visual source.
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

The light accent is `#CC4609`: white text on it has a contrast of 4.72:1 (WCAG AA). The original `#FF6A13` with white text is only 2.87:1 and must not be used in the light theme. The text pairs that must meet AA are listed in `tokens.json` `contrast` and checked by `check:tokens`.

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
| Outline (1px `accent` border + `accent` text) | Secondary actions that need emphasis, the current page number; a conversation card waiting for a person gets only an outline (`Card tone="accent"`) |
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

**Density steps.** Controls and rows come in three steps, chosen by context, never by taste:

| Step | Used for | Not used for |
|---|---|---|
| `dense` | Inside tables and table toolbars, tool groups and tool rows, inline cards, property sections, the status bar, tag-like chips | Anything a person is expected to read at length or aim at often outside a dense container |
| `default` | Everything else: buttons, inputs, selects, segmented controls, filter chips, the composer's controls, sidebar items, menu items, form fields | — |
| `prominent` | At most one per view, where the action *is* the page: the auth pages' submit, an empty state's first action, the onboarding checklist's next step | Ordinary page-header primaries, form submits in the action row, dialogs |

- A container sets the step for what it holds (a DataTable is `dense` throughout; a form is `default` throughout); mixing steps inside one row is not allowed. In code the step is the `density` prop (`"dense" | "default" | "prominent"`) of `Button`, `IconButton`, `Input`, `Select`, `Segmented` and `FilterChip`; a container provides it through `DensityContext` and an explicit prop wins.
- Icon buttons are square at the same step's height.
- The page-header primary action and the action-row actions are `default`.
- Spacing usage: inside components steps 1–3; between components 2–3; between sections 4–6; page gutters `layout.gutter`. **If spacing can separate it, don't draw a line.**

**Lines**: 1px. Column dividers, table row dividers and the status bar / action row top lines use `line-soft`. Borders (`line`) only on things that float over content or take input: inputs, buttons, chips, inline cards, overlays (`line-strong`). Cards, sections, stat cards, form field cards and the table container have **no border** and use the `panel` ground.

**Radius**: `sm` for inputs, buttons, chips, nav items and conversation rows; `md` for inline cards, property sections, stat cards, form field cards and overlays; `bubble` for message bubbles and the switch track; **0** for tables and page structure (sidebar, header, status bar, action row).

**Shadows** are used only for things that float:

| Token | Dark | Light | Used for |
|---|---|---|---|
| `shadow-1` | `0 8px 24px rgba(0,0,0,.40)` | `0 2px 8px rgba(10,10,10,.08)` | Menu, Popover, Toast, Tooltip, inline menu |
| `shadow-2` | `0 16px 48px rgba(0,0,0,.50)` | `0 8px 24px rgba(10,10,10,.12)` | Dialog, command palette |
| `shadow-sheet` | `-16px 0 40px rgba(0,0,0,.40)` | `-4px 0 16px rgba(10,10,10,.08)` | Sheet |
| `shadow-float` | `0 8px 24px rgba(0,0,0,.45)` | `0 8px 24px rgba(26,26,24,.08)` | The composer, the sidebar drawer |

- Layering: Sheet 40 · Dialog 50 · Popover/Menu 60 · Toast 70 (`--cb-z-*`).
- Motion: hover background transitions `motion.hover` (120ms); expand / collapse height transitions `motion.expand` (160ms); overlays fade in with a 4px offset over `motion.overlay` (120ms), `ease-out`, no bounce. `prefers-reduced-motion: reduce` makes all of them instant (§6.11).
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

- Two rows. Row 1 (optional): breadcrumb, `small` `muted`, links separated by a `faint` `/`, inside a `nav` labelled "Breadcrumb". Row 2: title (`h1`, single line with an ellipsis, full text in `title`) + count / status, a one-line description under it (`prose-small` `muted`, single line with an ellipsis), actions on the right.
- No bottom line and no background; spacing separates it from the body.
- Actions: at most 1 solid primary action + 2 secondary + a `more-horizontal` menu; the primary action is rightmost; all `default` density. The submit action of form pages **must not** go here; it goes in the ActionRow.
- List-page key metrics are **not** in the header: the template renders them below the header as StatCards (§6.14), at most 4–5.
- Content width: the header shares the body's content width (lists 1080, forms 880, centered; §4.3).

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
| Content + Inspector | flexible + 400 | Details, playground |
| Rail + Content + Inspector | 240 + flexible + 400 | Inbox |
| Centered | content max `layout.content-form` (880), centered | Forms, settings, wizards |

- Content widths: list pages and the overview `layout.content-list` (1080), forms / settings content / wizards `layout.content-form` (880), centered; details, inbox, playground and trace use the full width. The page gutter is `layout.gutter` on both sides. The Centered layout has **no anchor navigation**; a form's error count lives in the ActionRow.
- Content has a minimum width of 560. The Rail is collapsible; the Inspector is closable.
- Scrolling: the sidebar, PageHeader / PageTabs / ActionRow / StatusBar are fixed; the sidebar's conversation section, Rail, Content and Inspector scroll independently; the page must not show a horizontal scrollbar (wide tables scroll inside their own container).
- Responsive: < 1280 the sidebar becomes the rail and the Inspector a right-side Sheet; < 960 the sidebar becomes a drawer and the Rail a toolbar "Filter" button + Sheet; < 640 the header actions beyond the primary fold into `more-horizontal`.

### 4.4 ActionRow and StatusBar

- **StatusBar**: one form only. Height `layout.status-bar`, **no background**, a `line-soft` top line, `micro` type, `muted`, padding `layout.gutter`. Left: `user@org:route` · page status (such as "Filtered 18 / 24", "Auto-refresh 15s"); right: system status · version · time zone. No `>` prefix, no status dot (success is not colored). **Read-only**: it never holds a clickable control and never grows into an action bar. When space runs out the left part truncates first (ellipsis), the right part stays.
- **ActionRow**: when the page has actions to submit (forms, bulk edits, approval decisions, wizards) it appears **above** the StatusBar; both stay fixed at the bottom of the content area. Height `layout.action-row`, `panel-2` ground, `line-soft` top line, padding `layout.gutter`. Left: an accent dot + "N unsaved changes" (`muted`) `·` "N errors" (`fail` with `circle-alert`), or a muted "No changes"; right: Cancel / Discard (default) · secondary action (default) · primary action (primary, rightmost), all `default` density. With no changes the primary is disabled.
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
| T5 | Settings | Rail (second-level navigation) + Centered | — | When there are changes | form | Org, environment, security |
| T6 | Inbox | Rail + Content (+ Inspector) | — | During decisions | full | Human approval, alert handling |
| T7 | Playground | Content + Inspector | — | — | full | Trial-run an Agent in conversation, live trace on the right (the conversation page until project B decides between a Conversation template and extending T7) |
| T8 | Trace | Single (top: span waterfall, bottom: span detail) | — | — | full | Single run detail |
| T9 | Wizard | Centered + step bar | — | Always (Previous / Next) | form | First-time model, connector and extension setup |
| T10 | Auth | No Shell, centered card + dither dot matrix on both sides | — | — | — | Sign in, password recovery, accept invitation, initialization |
| T11 | System status | Single centered | — | — | — | 404, 403, under maintenance, not enabled |
| T12 | Onboarding | Single centered checklist | — | — | — | New org, empty environment |

### 5.1 List (T2)
- Order in the content column: PageHeader → StatCards (when the header has `metrics`) → the DataTable (its toolbar above the table, pagination below), separated by `space.3`.
- Rail: faceted filters; each group has a title (muted) + checkbox items + counts.
- Content = one DataTable (§6.6), whose toolbar, bulk bar and pagination all belong to the DataTable.
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

---

## 6. Components

All components provide these states where applicable: default, hover, pressed, focus, disabled and loading, in both dark and light. A component that is part of the reference set has a **state list** and a **size table** in the machine-readable formats of §9.2; `/dev/ui` renders one block per listed state with the same id.

Where older text below still names a character glyph (`▸ ▾ ✓ ⠿ ▤ ✕ ↻ ↗ ⋯`), the matching `Icon` of §2.6 is meant (`chevron-right`, `chevron-down`, `check`, `spinner`, `file`, `x`, `refresh`, `external-link`, `more-horizontal`).

### 6.1 Button

| Variant | Default | Hover | Pressed | Purpose |
|---|---|---|---|---|
| primary | `accent` ground, `on-accent` text, 700 | `accent-hover` ground | `accent-press` ground | The only primary action of a view |
| secondary | transparent, 1px `accent` border and text | `accent-tint` ground | accent @ 20% ground | Secondary actions that need emphasis |
| default | transparent, 1px `line` border, `ink` text | `hover` ground | `selected` ground | Ordinary actions |
| ghost | no border, `muted` text | `hover` ground + `ink` text | `selected` ground | Cancel, low priority |
| danger | transparent, 1px `line` border, `fail` text | `hover` ground, `fail` text | fail @ 20% ground | Entry point of a dangerous action |
| danger-solid | `fail` ground, `on-accent` text | — | — | Only in a dangerous-confirmation dialog, once the confirmation condition is met |

- Density steps: `dense` height 24, padding `pad.dense.x`, gap `space.1`; `default` 28, padding `pad.default.x`, gap `space.2`; `prominent` 32, padding `space.4`. Radius `sm`. Icon buttons are square at the step's height (`IconButton`, icon 16 at default / prominent, 14 at dense).
- Hover transitions background, border and color over `motion.hover`.
- Disabled: `faint` text, `line-soft` border, transparent ground; a disabled primary gets the `selected` ground and weight 400; `cursor: not-allowed`.
- Loading: the `spinner` icon (14) before the label, the label stays, width kept, no repeated clicks (`aria-busy`).
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
| button[data-variant=primary] | loading | height | control.default |

### 6.2 Input / Select / Textarea / Stepper
- Height `control.<step>` (28 by default), inner padding `space.2`, 1px `line` border, radius `sm`, transparent ground, `body` type.
- Focus: `accent` border + 3px `focus-ring` halo (§2.5); error: `fail` border; disabled: `line-soft` border, `hover` ground, `faint` text. Hover and focus transition border and halo over `motion.hover`.
- Prefix / suffix use `faint` / `muted` icons (such as `search`, `chevron-down`, `⌘K`).
- Field: label on top (`body` `ink`), help and error below (`small`; error `fail` with `circle-alert` 12), `space.1` between them.
- A Textarea with a character count shows `n / max` (muted) at the bottom right. Prose textareas (descriptions) use `prose-small`; prompts and code use the mono font.
- Code-like input (prompts) uses an editing area with line numbers: the line-number column is `faint` + a right `line-soft` line.
- Stepper: `− value +`, with square buttons at the step's height on both sides.
- Slider: a discrete block track (20 cells by default, cell width adaptive, 2 between cells, 8 high); the selected part is `accent` and the rest `line`; the thumb is a 4×16 `ink` vertical bar; keyboard ←→ by step, PageUp/PageDown by 10 steps; can be linked with a value input box on the right (8ch wide). When no value is set, the thumb is centered and the track is all `line`, so it doesn't pretend to be some value.
- Reset to default: when a field has been set by the user, a ghost small link "Reset to default" with the `refresh` icon appears on the right of the label row; clicking clears the value and returns to the default display.

<!-- states: input -->
States: `default`, `focus`, `error`, `disabled`

<!-- size-table: input -->
| Part | State | Property | Value |
|---|---|---|---|
| input | default | height | control.default |
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
- Switch: a `space.7` × `space.5` (32 × 20) track with radius `bubble` and 2px padding, a `space.4` (16) round knob; off: `line` track + `muted` knob; on: `accent` track + `on-accent` knob moved right by `space.3`; the knob moves over `motion.hover`. Where a switch stands alone its label and current state ("On" / "Off", muted) are shown as text next to it, so the state never relies on color.
- Option card (rich option of a single choice): 1px `line` border, radius `md`; selected `accent` border + `accent-tint` ground.

<!-- states: switch -->
States: `default`, `selected`, `focus`

<!-- size-table: switch -->
| Part | State | Property | Value |
|---|---|---|---|
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
  - Count `count`: a small `muted` number after the name.
  - Badge `badge` (such as Inspector "Tasks 2/4"): 1px `line` border, small `muted`, radius `sm`; when selected `ink` text.
  - Alert `alert` (such as "Runs" having something to approve): a small accent dot after the name, with screen-reader text "needs attention", so it doesn't rely on color alone.
- Segmented: one `line` border around the group, radius `sm`, height `control.<step>`, 2px inner padding and gap; each segment has radius `sm` and padding `space.2`, `muted` text; the selected segment gets the `selected` ground + `ink` text (no accent).
- Pagination: `1–50 / 1,284` · N per page · previous / next icon buttons (`chevron-left` / `chevron-right`, dense) and page numbers; the current page is outlined in the accent color.

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
- Disclosure: an expandable block (a skill body, a license text). The summary line is the toggle button (`aria-expanded`, `aria-controls`, `▸` / `▾` `faint` on the right, `hover` background, same row style as ThinkingRow); closed by default (`defaultOpen` opens it); once open, the body follows under a 1px `line` guide on the left, indented 8. The body is rendered only while open.
- Metrics on list pages are StatCards (§6.14).

### 6.6 DataTable
Structure, top to bottom: toolbar / bulk action bar → the table (header and rows on the `panel` ground, **square, no border**) → pagination. The toolbar and pagination sit on the page ground outside the panel.

- **Density**: the table is `dense` throughout: its toolbar, bulk bar, row menus and empty-state actions get `dense` controls through `DensityContext`.
- Toolbar: search (`search` icon prefix, `/` focuses), filter chips (§6.15), clear all, sort, view switch, column settings. It has the same height as the bulk action bar so nothing jumps when one replaces the other in place.
- Bulk action bar: when ≥1 row is checked it **replaces the toolbar in place**, `panel` ground, radius `sm`, left "N selected" (700) + bulk actions, right "Deselect Esc". An accent border or ground must not be used.
- Header: `row.dense` high, padding `space.2`, `small` `muted`, weight 400; the column being sorted is `ink` + `arrow-down` / `arrow-up`; a sortable column shows `arrow-up-down` and a `hover` ground on hover.
- Rows: height by `rowHeight`: `dense` 28, `default` 32, `roomy` 44 (two lines: name + a `small` prose description, or a thumbnail). Cell padding `space.2` horizontally, the first and last columns `space.3` toward the edge. Row dividers are 1px `line-soft` above each row; no outer border. Success in a status column has no mark (§2.4).
- Alignment: numbers, durations and amounts are right-aligned; IDs and times are left-aligned; IDs and times use `muted`. An overlong single line is truncated with an ellipsis and the full text is shown on hover with a native `title`.
- Row states (priority from high to low when they occur together): focus ring > selected > checked > hover > default. They paint the row ground, transitioning over `motion.hover`.
  - Hover: `hover` ground; the checkbox border turns `ink`.
  - Selected (opens the detail / Inspector): `accent-tint` ground + a 2px accent bar on the left (§2.3).
  - Checked: only the checkbox turns accent; the row ground is unchanged.
  - Focus: 1px inner outline in the accent color.
  - Disabled / archived: the whole row is `faint` and cannot be checked.
- Inline menu `more-horizontal` (a dense icon button): ≤5 items, the dangerous item at the bottom and separated by a divider; while open, the button ground is `selected`. When a row has no available actions it shows no button (the cell stays, so column alignment doesn't change).
- Expanded row: `panel-2` ground, indentation and a `└` leader, showing a summary (such as the first few steps of an execution trace).
- Empty states (inside the panel, under the header):
  - Loading: skeleton rows (`row.dense` high, `space.3` bars in `selected` with radius `sm`), no spinner.
  - Empty (first time): the `empty` icon + one `muted` sentence + the next action (dense), `space.8` padding above and below.
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

### 6.7 Overlays

Selection rules: the user needs to decide → Dialog; view / edit one object without leaving the list → Sheet; in-place options / filters → Popover / Menu; feedback on an operation result → Toast (a Dialog must not be used); creating something with more than 6 fields → a form page (T4).

- **Dialog**: width 480 / 640, `panel` background + `line-strong` border + radius `md` + `shadow-2` + `scrim`. Header (h2 title + close ✕) / body (padding 16) / footer (right-aligned: ghost Cancel + primary action, the primary action carries `↵`), with 1px `line` separating header and footer. Esc closes; focus is trapped and returned after closing. Default focus: on the primary action for an ordinary dialog, on Cancel for a dangerous dialog.
- **Dangerous confirmation**: `fail` frame, `fail` title; explains the consequences and recoverability; the object name must be typed, the confirm button is disabled until it matches, and is danger-solid once it matches.
- **Sheet**: slides out from the right, width 480 / 720, `panel` background + `line-strong` left line + `shadow-sheet`; no scrim by default (the list is still operable). Header: name + version + open in a new page `↗` + close `✕`; may contain Tabs; footer: actions. Closing with unsaved changes needs a second confirmation.
- **Links**: the design package is framework-agnostic; links in the sidebar navigation, the PageHeader breadcrumb, Tabs and Sheet are rendered through the `link` component of `DesignProvider` (default `<a>`); `apps/web` passes next-intl's `Link` to get client-side navigation and the locale prefix. Pages should not build `<a href>` themselves for in-site navigation.
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
- **ThinkingRow**: one `muted` line "Thought for N seconds" (seconds rounded); when there is body text the whole row is an expand button (`aria-expanded`, `▸` / `▾` `faint` on the right), and once expanded the body is `muted`, with a 1px `line` guide on the left, preserving line breaks.
- **ToolCallRow**: by default only one line: tool name (700) + a one-sentence description (`muted`, single line with ellipsis) + a `StatusMark` for non-completed states (running / failed / cancelled) + `▸` on the right. The whole row is an expand button, with a `hover` background on hover. On error the tool name is `fail`; when cancelled it is `muted`. Once expanded, inside a 1px `line` frame come two `IoBlock`s, IN and OUT (no OUT while running); when the output is truncated, the bottom shows small `faint` "Output too long, truncated" + a "View full output" text button (leaving it to the caller to fetch the full text from the archive).
- **IoBlock**: `panel` background; a 5ch label column on the left (`IN` / `OUT`, 11px 700 `faint`, right line `line`), and monospace raw text on the right (line breaks preserved, long words broken); IN is `ink`, OUT is `muted` (`fail` when the tool errored). Beyond `collapsedLines` (default 12) lines only the first N lines are shown, with an "Expand all (M lines)" / "Collapse" text button below (`aria-expanded`).
- **Checklist**: each item is `glyph + text`. `pending` `□` `faint`; `in_progress` `▶` accent, the whole row gets an `accent-tint` background + a 2px accent bar on the left + 700, `aria-current="step"`; `completed` `check` `muted` (success is not colored, §2.4), text `faint` and struck through with `<s>`. Each item carries screen-reader status text (To do / In progress / Done).
- **CodeBlock**: 1px `line` frame, `panel` background; when there is a language, an 11px `faint` language label at the top + a bottom line; body monospace, no wrapping, horizontal scrolling inside the frame; no syntax highlighting.
- **EmbedFrame**: the **only** component in the UI that renders an iframe (`apps/web` must not write an iframe itself). `sandbox` is fixed to `allow-scripts allow-forms` (never containing `allow-same-origin`), `referrerpolicy="no-referrer"`, `title` is required; width fills, height comes from props (default 360); 1px `line` border, `panel` background. Only `message` events whose `event.source` is this iframe are passed to `onMessage` (the caller parses and validates the content), and the iframe is exposed through `frameRef` for `postMessage`.
- **ImageBlock**: an image in a plugin view; block-level, width not exceeding the container, scaled proportionally, 1px `line` border; `loading="lazy"`, `referrerpolicy="no-referrer"`. It takes only an address and alt; it renders only absolute http(s) addresses, and anything else (`javascript:`, `data:`, relative paths) renders nothing.
- **AttachmentChip**: an uploaded file waiting to be sent in the input box. A line with a 1px `line` border and `panel` background: file name (single line with ellipsis, at most 24ch) + size (small `muted`, `B` / `KB` / `MB`) + a remove button on the right (a `✕` icon button, `aria-label` "Remove <file name>"). Three states (`data-status`): `uploading` shows a 4px segmented progress bar under the name (`role="progressbar"`, `aria-valuenow` 0–100, completed segments accent, the rest `line-strong`, consistent with the Toast progress); `ready` has no progress bar; `error` has a `fail` border and small `fail` error text under the name (`role="alert"`), and can still be removed; when the caller supplies a retry, an extra `↻` icon button appears to the left of the remove button ("Retry <file name>").
- **FileDrop**: a drag-and-drop / paste area wrapping the input area. When content carrying files is dragged in (only `Files` is recognized; dragging text does not respond) an overlay covers the area: `accent-tint` background + 1px dashed `accent` border, with one centered line of hint text (passed in by the caller); dropping hands the files to `onFiles`. Pasting a clipboard containing files inside the area also hands them to `onFiles`; when the clipboard has no text, the default paste is prevented, while if it also has text (such as copied from a document) the text is pasted as usual; a paste without files is unaffected. The overlay is always dismissed on drop and dragend. When `disabled` neither responds. `dragging` can force the overlay to show (for the catalog page and screenshots).
- **FileButton**: a file-picking button. It looks like `IconButton` (default `+`, `aria-label` passed in by the caller); clicking opens the system file picker (a hidden `input type=file`, with `accept` / `multiple` settable), and after selection the files are handed to `onFiles` and the input is cleared so the same file can be chosen again.
- **AttachmentPreview**: an attachment in a message. `kind="image"` is a thumbnail: at most 240×160, cropped proportionally to fill (`object-fit: cover`), 1px `line` border, `loading="lazy"`, `referrerpolicy="no-referrer"`; `kind="file"` is a file card: 1px `line` border, `panel` background, `▤` `muted` on the left, file name (single line with ellipsis) + small `muted` description below (such as the type). Both are links that open in a new tab (`target="_blank"`, `rel="noopener noreferrer"`), with a `line-strong` border on hover. Addresses accept only absolute http(s) addresses and same-origin absolute paths: a raw string containing any ASCII control character, whitespace or `\` is rejected outright (browsers strip tabs / newlines, so `/\t/evil` would become `//evil`), and one starting with `/` is resolved against a placeholder origin whose origin must stay unchanged; anything else (`javascript:`, `data:`, protocol-relative addresses, relative paths) renders no link and no image, and shows only the file name. When an image fails to load, `onImageError` is called; when `retry` is greater than 0 the image address gets the cache parameter `retry=<n>` and reloads (the link is unchanged); when `onOpen` is given, an unmodified left click is handed to the caller to open.
- **Card `tone="accent"`**: a card in the conversation waiting for a person (approval / question / connection) gets a 1px `accent` outline (§2.3 outline) and returns to the default border once handled.
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
- **Sidebar keyboard**: Tab enters the nav list at the current item and the conversation list at the active conversation (one roving tab stop per list); ↑ / ↓ move between nav items and between conversation rows; Home / End go to the first / last; ↵ follows the link; Enter / Space on a group label toggles the group (`aria-expanded`); Esc closes the drawer and returns focus to the menu button.
- **Reduced motion**: under `prefers-reduced-motion: reduce` every transition and animation above is instant (duration ≤ 0.01ms); the spinner stops on a static frame.

### 6.12 Icon

`Icon({ name, size = 16, label? })` renders one icon of the set (§2.6) as an inline `svg` (`viewBox 0 0 24 24`, `stroke: currentColor`, stroke width 1.5, round caps and joins), so it takes the surrounding text color. Sizes 16 (default, nav items, buttons), 14 (dense controls, inline with small text), 12 (inside `small` text: field errors, status cells). The names are listed in `ICON_NAMES`; a new name is added to `packages/design/scripts/gen-icons.mjs`, never drawn by hand in a page.

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
  4. Account footer, pinned at the bottom (`row.default`): a 24 round initial avatar on `selected` + "name · org" + `chevron-up`, opening the account menu (org switch with the current org checked, language, theme, sign out).
- **Nav items**: `row.default` high, radius `sm`, padding `pad.default.x`, icon 16 + label (`body`, single line with an ellipsis) + an optional count (`micro` `muted`, right-aligned). Others `muted`; the current item gets the `sidebar-active` ground + `ink` text (§2.3), hover the `hover` ground + `ink`. The inbox count shows `99+` above 99 and `n+` when truncated; the accessible name includes it ("Inbox, 3 pending").
- **Groups**: a label row (`row.dense`): the agent name (`small` `muted`, essential text, never `faint`; single line with an ellipsis, full name in `title`) inside a toggle button with `aria-expanded` and a `chevron-down` / `chevron-right` 12 icon, and a dense `plus` icon button "New conversation with {agent}". Collapse is remembered per viewer in `localStorage["cap.sidebar.collapsed"]` (a JSON array of agent ids, read and written inside try/catch; renders expanded when storage throws).
- **Conversation rows**: `row.dense` high, radius `sm`, padding `pad.default.x`, `muted` single line with an ellipsis and the full text in `title`; the active conversation gets `sidebar-active` + `ink`. An untitled conversation reads `未命名会话 · MM-DD HH:mm` / `Untitled conversation · MM-DD HH:mm` (its start time). Each group shows its 5 most recent conversations, then a "More" text row; the list shows 20 groups, then a "More" row for groups.
- **States of the conversation section**: empty: one `small` `muted` line "No conversations yet"; loading: skeleton bars (`space.3` high, `selected`, radius `sm`), `aria-busy`, no spinner; error: `circle-alert` + "Failed to load" in `fail` and a dense ghost "Retry" (`refresh`).
- Long titles and agent names (40+ CJK characters without spaces) truncate to one line and never widen the sidebar.
- **Rail** (below 1280): width `layout.sidebar-rail`, icons only (each item `row.default` square, accessible name kept, a Tooltip with the label on hover and focus), the inbox count as a small `selected` badge on the icon, separators in `line-soft`; the conversation section is replaced by one icon button (`panel-left`, "Expand sidebar") that opens the drawer.
- **Drawer** (below 960): the full sidebar slides in from the left over a `scrim`, with `shadow-float`, opened from the menu button in the drawer menu bar; the top row's search button becomes a close button (`x`). Esc, the close button and route changes close it; focus returns to the menu button.
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

### 6.16 Conversation page components (added by project B)

The following are specified by project B (the conversation page), each with its own state list and size table when it lands: tool group and tool row (replacing ToolCallRow's IN / OUT IoBlock layout), subagent row, file card, attachment strip, inline card frame, property section, right panel frame, composer (with dropdowns and queue state), diff block, queued message, file preview frame, model / effort dropdowns, the conversation title bar with the untitled-conversation placeholder.

---

## 7. Copy and internationalization
- All UI text goes through next-intl, in both Chinese and English. Text shown to the model (prompts, tool descriptions) is always English, and the prompt field in a form must say so.
- Thousands separators for numbers; durations `6.8s` / `41.2s` / `00:00:18`; amounts `¥412.80`; relative time ("2 hours ago") for lists, absolute time (`10-18 14:02:11`) for records and logs.
- Error messages state the cause and give an actionable next step; include the error code and request ID for troubleshooting.

## 8. Accessibility
- Text contrast ≥ 4.5:1 (`faint` only for non-essential information).
- All interactive elements are native `button` / `a` / `input`; icon buttons must have an `aria-label`; status is not expressed by color alone.
- Fully keyboard accessible, focus visible (§2.5); overlay focus is trapped and returned.
- Respect `prefers-reduced-motion` and `prefers-color-scheme` (dark by default, switchable by the user).

## 9. Enforcement and acceptance (how the implementation is kept consistent with this spec)

### 9.1 Static rules (`pnpm check`)

1. **Package boundary**: `apps/web` may import UI components and templates only from `@capybara-hq/design`. The import rule is a **blacklist**: `@radix-ui/*`, `cmdk`, CSS-in-JS (`@emotion/*`, `styled-components`, `@stitches/*`, `@vanilla-extract/*`, `styled-jsx`), component libraries (`@mui/*`, `@chakra-ui/*`, `@mantine/*`, `@headlessui/*`, `antd`), `tailwindcss` / `tailwind-merge`, class-name utilities (`clsx`, `classnames`, `class-variance-authority`) and icon libraries (`lucide-react`, `react-icons`) must never be imported; `.css` may only import `@capybara-hq/design/styles.css`. The blacklist grows as new styling dependencies appear.
2. **Template enforcement**: every `page.tsx` under `apps/web/src/app` must render one of the §5 templates imported from `@capybara-hq/design` (aliases and namespace imports are recognized); the Shell layers are rendered only by templates. Two exemptions: the development catalog pages `app/[locale]/dev/**`; and pages that only handle 404 (containing no JSX and calling `notFound()` from `next/navigation`, such as `[...rest]/page.tsx`), whose page is rendered by the StatusPage in the same segment's `not-found.tsx`.
3. **Style ownership**: in `apps/web/src` there must be no `className` / `class` / `style` / `dangerouslySetInnerHTML` attributes (including spread props and `createElement` / `jsx` calls), `<style>` elements, `.css` files, or any color literal (`#hex`, `rgb()`, `hsl()`, `oklch()`, `color-mix()` and so on); layout inside a page may only use the design package's layout primitives (`Stack`, `Grid`, `Card`, `Text`). In `packages/design`, color literals are allowed only in the generated `tokens.css`.
4. **Tokens**: `check:tokens` keeps `tokens.json`, `tokens.css` and `tokens.ts` in step and checks the contrast pairs (§2).

Every check has a violating-fixture test.

### 9.2 Reference set, state lists and size tables

- **Reference set**: `docs/design/reference/src/*.html` draws the target design, one `<section data-ref-block="<component>-<state>">` per state, from the generated `tokens.css`, the self-hosted fonts and the shared fixtures (`@capybara-hq/design/fixtures`, also used by `/dev/ui`). `pnpm --filter @capybara-hq/web reference:render` renders one PNG per block and theme (`docs/design/reference/<id>-<theme>.png`, device scale factor 2); the committed PNGs come only from the manual `reference-update` workflow (the pinned Linux Playwright image). The set signed off on 2026-10-26 is the baseline for first acceptance.
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

The same spec fails when `/dev/ui/reference/<component>` lacks a block for a state in the component's state list (`missingStates`), and `checkSpecTables` (unit-tested in `packages/design/test/spec-tables.test.ts`, run against this document) reports a size table without a state list, a row whose state is not in the list, a value `tokens.json` lacks, and a duplicate marker.

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
