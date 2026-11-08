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
7. **One box is enough** (acceptance item AB, maintainer decision 2026-11-07): inside a box (a Card, a FormSection's card, a Sheet, a Dialog, an InlineCard, a PropertySection, the narrow properties sheet) group with headings (`Subsection`, §6.32), hairlines (`line-soft`: `ItemList` rows, §6.33) and space, **never** a second bordered or filled box. The exceptions are card radios (option cards, §6.3: a choice drawn as cards on purpose), form controls (inputs, textareas, selects, steppers, the `FilePicker` drop zone in a Dialog, §6.25: a border that says "type or drop here", not a group) and a full-height pane (RightPanel, FilePanel, §6.16.18), which holds content like a page. Pieces that would draw a box inside one draw their unboxed form there by themselves: a DataTable is unframed (§6.6), a CodeBlock or an EmbedFrame has no line (§6.9), a Repeater's items are divided rows (§6.26), a Callout is the warn / fail line with its icon (§6.19), a PropertySection in the narrow sheet is a heading and hairline group (§6.16.17). What has no unboxed form (a Card, a FormSection, a DangerZone, an ObjectList, a LinkCard, StatCards, an InlineCard, a CardGrid and its ObjectCards, §6.34) is never drawn inside a box. Every box provides that "inside a box" context to what it holds (Card, FormSection's card, Dialog, Sheet, Popover, InlineCard, PropertySection, the narrow properties sheet, Callout, DangerZone, ObjectList: the boxes `web-ui-box-in-box` knows), and a full-height pane (RightPanel, the file preview) resets it. Enforced in both halves (§9.1): `web-ui-box-in-box` reads apps/web's JSX, and the jsdom guard `findNestedBoxes` checks what the design package and `/dev/ui` render.

---

## 2. Tokens

`docs/design/tokens.json` is the **source of truth** for colors, shadows, the size scales, layout widths, motion, fonts, layering and the contrast pairs. `pnpm gen:tokens` writes `packages/design/src/styles/tokens.css` (the CSS variables `--cb-<token>`, dark under `:root` / `:root[data-theme="dark"]`, light under `:root[data-theme="light"]`) and `packages/design/src/tokens.ts` (`TOKEN_NAMES`, `SIZES`) from it; both files are generated and never edited by hand. `pnpm check:tokens` (part of `pnpm check`) fails when either file is stale, when `tokens.json` is malformed, when a pair in `contrast` misses its ratio, or when a ground in `separation` stands too close to a surface (§2.1).

All colors, sizes and shadows may only be used through tokens. Color literals are allowed only in the generated `tokens.css`. Tailwind is not used.

A **theme** (a plugin's contribution, spec `docs/superpowers/specs/2026-11-08-themes-design.md`) replaces values of these tokens for a scope; the names, the contrast pairs and the dark / light split stay. Components never know a theme is on: they read `var(--cb-<token>)`, and the one color a theme adds to the DOM is the `ThemeSwatch` preview (§6.37), applied as data.

### 2.1 Colors

| Token | Dark | Light | Purpose |
|---|---|---|---|
| `bg` | `#0A0A0A` | `#FAF9F6` | Page background |
| `panel` | `#111110` | `#FFFFFF` | Cards, table container, stat cards, form field cards, overlays |
| `panel-2` | `#0E0E0D` | `#FCFBF9` | Action row, right-panel ground |
| `sidebar` | `#111110` | `#F3F2EE` | Sidebar ground |
| `sidebar-active` | `#1A1A18` | `rgba(26,26,24,0.09)` | Current nav item or conversation in the sidebar |
| `raised` | `#141413` | `#FFFFFF` | Floating inline cards, the composer |
| `selected` | `#1F1F1D` | `rgba(26,26,24,0.07)` | Selection ground: selected segment, filter chip, option card, the palette's current row, the waterfall's selected row; avatar, skeleton bars |
| `hover` | `#171716` | `rgba(26,26,24,0.04)` | Hover ground, disabled input ground |
| `line-soft` | `#1C1C1A` | `#E8E7E2` | Column dividers, table row dividers, the status bar's and action row's top line, disabled borders |
| `line` | `#2A2A28` | `#D9D8D2` | Input and button border |
| `line-strong` | `#3A3A37` | `#B5B5AE` | Overlay border, the border of a selected option card or palette row |
| `line-card` | `rgba(255,255,255,0.08)` | `rgba(26,26,24,0.07)` | The 1px hairline of cards and sections |
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

The `avatar-*` tokens (dark and light, in `tokens.json`) are the animal palettes of the agent avatars (§3, §6.30) and are used by `Avatar` only. Each preset's main color against its ground is a `contrast` pair with a floor of 3:1 (WCAG 1.4.11 for graphics), in both themes; the panda's and the penguin's white against their grounds are pairs too.

The light accent is `#CC4609`: white text on it has a contrast of 4.72:1 (WCAG AA). The original `#FF6A13` with white text is only 2.87:1 and must not be used in the light theme. The text pairs that must meet AA are listed in `tokens.json` `contrast` and checked by `check:tokens`; a translucent token (`diff-add`, `diff-del`, the light `hover` / `selected` / `sidebar-active`) is composited over `bg` before its pair is checked, or over the surface a pair names as its fourth element (`["muted", "selected", 4.5, "sidebar"]`: the darkest light surface these grounds sit on). `muted` must reach 4.5:1 on every ground secondary text sits on (`bg`, `panel`, `panel-2`, `sidebar`, `raised`, `selected`, `hover`; dark: 6.02:1 on `bg`, 5.02:1 on `selected`) and `disabled` 3:1 on the grounds a control sits on (dark: 3.86:1 on `bg`, 3.22:1 on `selected`; light: 3.67:1 on `bg`, 3.18:1 on `selected`).

**Hover, selected and current grounds.** In light, `hover`, `selected` and `sidebar-active` are translucent ink overlays (`ink` at 4%, 7% and 9%), not fixed colors, so each reads as a darker step on every surface it sits on (`bg`, `panel`, `panel-2`, `raised`, `sidebar`); in dark they stay solid. `tokens.json` `separation` lists `[ground, surface, floor]`: the ground composited over the surface must differ from it by at least the floor in OKLab lightness ×100 (2.5 for `hover` and `selected` on `bg`, `panel` and `sidebar`, and `sidebar-active` on `sidebar`), in both themes (`tokens-separation`), and `selected` must stand further from a surface than `hover` on the same surface (`tokens-separation-order`). Because they are translucent, an element that must hide what is under it (a sticky table header, a badge over an icon) lays the ground over its opaque surface (`linear-gradient(var(--cb-hover), var(--cb-hover)), var(--cb-table-ground)`) instead of using it alone; two stacked overlays (a hovered row's menu button) simply read darker.

### 2.2 Fonts and type

Two fonts, each with a job:

| Font | Token | Used for |
|---|---|---|
| **Sarasa Mono SC** (OFL-1.1) | `--cb-font` | The UI skeleton: navigation, labels, buttons, tables, tool rows, key names, paths, numbers, the status bar |
| **Inter + Source Han Sans SC** (both OFL-1.1) | `--cb-font-prose` | Prose: running text a person reads as sentences: descriptions (page headers, form sections, object rows, plugin and extension descriptions), field help, dialog bodies, callouts, empty-state text, conversation prose, rendered Markdown, table description lines |

- Weights 400 / 500 / 600, never above 600: hierarchy comes from size and color, not weight. The page title (`h1`) and emphasis (the primary button, the current nav or tab item, object names, `strong`) are 600; section, card, dialog and group titles are 500; everything else is 400. Each font ships a 400 and a 700 face: 500 draws with the regular face and 600 with the bold face (CSS font matching), so a 500 title is set apart by its size and `ink` color alone.
- Delivery: subsetted to woff2 at build time (`packages/design/scripts/subset-font.py`: ASCII, the 3,755 level-1 common Chinese characters, the characters the UI uses and a symbol table), self-hosted under `packages/design/src/fonts` with their licenses, `font-display: swap`, declared only in `styles/fonts.css`.
- Fallbacks: `'Sarasa Mono SC', ui-monospace, monospace`; `'Inter', 'Source Han Sans SC', system-ui, sans-serif`.

| Name | Size / line height | Weight | Font | Purpose |
|---|---|---|---|---|
| `h1` | 20 / 28 | 600 | mono | PageHeader title |
| `h2` | 16 / 24 | 500 | mono | Section title, card title, Dialog title |
| `body` | 13 / 20 | 400 | mono | Default text, tables, controls, nav items |
| `small` | 12 / 16 | 400 | mono | Table header, error messages, group labels, stat labels (field help is the same size in the prose font) |
| `micro` | 11 / 14 | 400 | mono | Status bar, nav counts |
| `metric` | 18 / 24 | 400 | mono | Stat card values |
| `prose` | 15 / 26 | 400 | prose | Conversation prose, rendered Markdown |
| `prose-small` | 13 / 20 | 400 | prose | Page-header and form-section descriptions, hints and dialog bodies (`Text variant="prose"`) |

- Numbers always use `font-variant-numeric: tabular-nums`.
- **Mono is for things a person copies or compares**: ids, paths, numbers, versions, dates and the UI skeleton. A sentence is never mono: a page writes running text as `Text variant="prose"` (or in a component's own prose part).
- **Dates**: one helper (`formatDateTime`, the `DateTime` component), local time, mono with tabular figures. Two forms only: `full` `YYYY-MM-DD HH:mm` in tables, meta lines and detail fields, with the relative age ("5 分钟前") as the tooltip (`DateTime` draws a `<time>` whose `title` is the age); `compact` `MM-DD HH:mm` in dense lists (the sidebar's untitled conversations "未命名会话 · 11-02 23:42"). Activity lines may say only the relative age ("Grant · 4 分钟前"); no other format (`2026/11/2`, `2026年11月1日`) is used.
- **Versions** are always mono with one leading `v` ("v0.1.0-rc.0"; `versionLabel`), in titles, tables, meta and sentences alike; request bodies keep the bare version.
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

The accent color must not be used anywhere else. Selected segments and selected filter chips use the `selected` ground, not the accent. A **selection inside a control** is neutral too: a checked option card, the command palette's current row and the trace waterfall's selected row use the `selected` ground with a 1px `line-strong` border (the waterfall row, a row of a tree, a 2px `ink` marker on its left instead); the accent stays on the radio dot and the focus ring. Badges and marks never use the accent: a role ("超级管理员") is plain text, and attention is `warn` (§2.4).

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
| Layout, cards (§6.34) | `card-min` | 280 (a CardGrid's narrowest card: three columns at the content width, one on a phone) | `--cb-layout-<name>` |
| Layout, tool policies (§6.36) | `policy-select` | 160 (a ToolPolicyList row's policy select: fits 需审批 / Ask for approval at `dense`) | `--cb-layout-<name>` |
| Layout, theme pickers (§6.38) | `swatch-min` | 160 (a ThemeSwatchGroup column's least width) | `--cb-layout-<name>` |
| Layout, page head (§4.2 "Head rhythm") | `head-path` / `head-description` / `head-tabs` / `head-tabs-content` / `head-content` | 12 / 4 / 16 / 16 / 24 | `--cb-layout-<name>` |
| Layout, conversation page | `title-bar` / `properties` / `panel-min` / `panel` / `chat-min` / `tool-output` / `file-card` / `thumb` / `inline-image` / `menu-max-height` / `bubble-clamp` | 48 / 300 / 520 / 560 / 480 / 120 / 240 / 56 / 360 / 328 (ten `row.default` items and the menu's padding) / 208 (eight `type.prose.line` lines: a long user message's clamp, §6.16.6) | `--cb-layout-<name>` |

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

**Lines**: 1px. Column dividers, table row dividers, the hairlines between rows or groups inside a box (`ItemList` rows, divided Repeater items, flush `Subsection`s, a divided `Grid`) and the status bar / action row top lines use `line-soft`. Borders (`line`) only on things that float over content or take input: inputs, buttons, chips, inline cards, overlays (`line-strong`). Cards, sections, stat cards, form field cards and object lists use the `panel` ground with a 1px `line-card` hairline (`rgba(255,255,255,.08)` in dark, where the ground alone barely separates them; drawn as an inset shadow where a border would change the box); the table container has no border.

**One box is enough** (§1 principle 7): a box holds headings, hairlines and space, never a second box. Inside a padded box a group is a `Subsection` (an `h3` in the `body` step, 500, its help line, then its content under the Disclosure's 1px `line` guide, §6.32) or `ItemList` rows split by `line-soft` (§6.33); in a flush box (a `flush` FormSection) rows and flush subsections are padded themselves (`space.4` for item rows, `space.3` for a subsection's heading row, in line with a table's first column) so their hairlines run to the box's edges. The allowed exceptions are option cards, form controls, the FilePicker in a Dialog and full-height panes (§1).

- **Input borders are a signed-off contrast exception.** An input's 1px `line` border on the page ground is about 1.38:1 (dark, `#2A2A28` on `#0A0A0A`) / 1.36:1 (light, `#D9D8D2` on `#FAF9F6`), below the 3:1 WCAG asks of UI component boundaries. The maintainer signed this off with the reference set (2026-10-26): the soft line is the refined E look, and an input is never identified by its border alone. It always carries a visible label (Field, `body` `ink`) or a placeholder/prefix inside it, it shows a `line-strong` border on hover, and focus draws an `accent` border plus the 3px `focus-ring` halo. `tokens.json` keeps no contrast pair for `line` for this reason; a new component that relies on a `line` border as its only boundary needs its own sign-off.

**Radius**: `sm` for inputs, buttons, chips, nav items and conversation rows; `md` for inline cards, property sections, stat cards, form field cards and overlays; `bubble` for message bubbles and the switch track; **0** for tables and page structure (sidebar, header, status bar, action row).

**Shadows** are used only for things that float:

| Token | Dark | Light | Used for |
|---|---|---|---|
| `shadow-1` | `0 8px 24px rgba(0,0,0,.40)` | `0 2px 8px rgba(10,10,10,.08)` | Menu, Popover, Toast, Tooltip, inline menu |
| `shadow-2` | `0 16px 48px rgba(0,0,0,.50)` | `0 8px 24px rgba(10,10,10,.12)` | Dialog, command palette |
| `shadow-sheet` | `-16px 0 40px rgba(0,0,0,.40)` | `-4px 0 16px rgba(10,10,10,.08)` | Sheet |
| `shadow-float` | `0 8px 24px rgba(0,0,0,.45)` | `0 8px 24px rgba(26,26,24,.08)` | The composer, the sidebar drawer |

- Layering: Sheet 40 · Dialog 50 · Popover/Menu 60 · Toast 70 (`--cb-z-*`).
- Motion: hover background transitions `motion.hover` (120ms); expand / collapse height transitions `motion.expand` (160ms); overlays fade in with a 4px offset over `motion.overlay` (120ms), `ease-out`, no bounce; the spinner turns once per `motion.spin` (800ms), the streaming cursor blinks every `motion.cursor` (1000ms), a running agent's dot in the agent map pulses every `motion.pulse` (1600ms, §6.16.28). `prefers-reduced-motion: reduce` makes all of them instant, the spinner static and the cursor steady (§6.11).
- Focus: inputs, selects and textareas get an `accent` border plus a 3px `focus-ring` halo (`box-shadow: 0 0 0 3px focus-ring`); other controls use `outline: 2px solid accent; outline-offset: 2px`; table rows, list items, nav items and conversation rows use `outline: 1px solid accent; outline-offset: -1px`. `:focus-visible` only. A ring never follows a mouse click: a text field (input, textarea, stepper, the composer) keeps its halo while it has focus, since it is being typed in, but every other control, the Select's button included, draws it under `:focus-visible` (the Select also while its list is open); a tab a pointer focused carries `data-pointer-focus` and draws no ring whatever the browser's heuristics say, until a key press (a modifier alone does not count) or a blur (acceptance issue Y); the mark is set only when focus arrives from that press (or at once when the pressed tab already has focus, since Chrome keeps that focus's keyboard origin), so a press that gives no focus (WebKit and Firefox on macOS do not focus a clicked button) never hides a later keyboard ring. `packages/design/test/focus-rings.test.ts` checks the stylesheets.

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
- **Brand from a theme**: a theme may replace the logo mark and the wordmark. The web passes the resolved theme's brand to `DesignProvider` (`brand: { markUrl, wordmark }`, either part null), and `Logo` draws it where it draws the pixel capybara: `markUrl` as an `img` as high as the bitmap would be (10 × the pixel unit, so 20 / 30 / 60; its width follows the file; `alt` is the wordmark, or "Logo") instead of the bitmap, `wordmark` as the wordmark text instead of `CAPYBARA` (only where the wordmark is drawn: the rail has none). A null part keeps the built-in one. The sidebar, `AuthPage` and `StatusPage` draw `Logo` and take no props for it.
- **Dither dot matrix**: used only for the backgrounds on both sides of auth pages and (optionally) the PageHeader corner of the overview page; 4px squares in `line`, density decreasing from one side to the other, greyscale only (no accent squares). No other page may use it.
- **Agent avatars** (§6.30) are the one place with pictures and their own colors: the ten pixel animals, drawn like the Logo (a 12×12 bitmap of solid squares, `crispEdges`), each in its animal's palette on a soft ground (the `avatar-*` color tokens, and `accent` for the capybara). Nothing else in the UI may use the animal palettes.
- Apart from agent avatars: no illustrations, gradients, frosted glass or emoji.

---

## 4. App Shell (system layout)

Every page (except auth pages, §5 T10) is **Sidebar | content area**. The content area holds, top to bottom, in a fixed order:

| Layer | Height | Required | Content |
|---|---|---|---|
| Drawer menu bar | `row.roomy` | Only below 960 | Menu button that opens the sidebar drawer, page title; below 640 its buttons are 40 px tap targets and it is padded 0 `space.1`, so their icons sit on the 16 px content edge |
| PageHeader | content | Required | Row 1 the path; row 2 title + one-line description, actions on the right; optional tabs row (§4.2) |
| PageTabs | the head's tab row | Optional (detail pages only) | In-page tabs, current item underlined; drawn by the template as the head's tab row, the same box as the PageHeader's row 4 (§4.2) |
| Body | flexible | Required | One of the layouts in §4.3 |
| ActionRow | `layout.action-row` | Optional | Appears when the page has actions to submit, stacked above the StatusBar |
| StatusBar | `layout.status-bar` | Required | Read-only: context · page status ｜ system status · version · time zone |

- The sidebar spans the full window height; the ActionRow and StatusBar sit **only in the content area**, fixed at its bottom; they never span the sidebar.
- There is no TopBar.

### 4.1 Sidebar

See §6.13 for the component. Width `layout.sidebar`; below 1280 an icon rail of `layout.sidebar-rail`; below 960 a drawer opened from the drawer menu bar.

### 4.2 PageHeader

- Four rows. Row 1: the **path** `scope / page [/ object]` (mono, `small`; the segments in `muted`, the `/` separators in `faint`, the last segment, the current page, in `ink` with `aria-current="page"`; the conversation title bar's path the same), inside a `nav` labelled "Path"; earlier segments with a link are links. The scope is the org slug for workspace pages (links to the workspace's home, the new conversation `/`; there is no home page, and `/chat` redirects permanently to `/`, maintainer decision 2026-11-07), `~` for personal pages (`/account/*`), `/admin` for admin pages. Row 2: title (`h1`, single line with an ellipsis, full text in `title`) + count / status, actions on the right (at most one primary, rightmost; an action whose call is running draws the Button's loading state, `loading`, and cannot be pressed again until it settles; meanwhile the head's other buttons are `disabled`). An object's page may lead row 2 with its avatar (`avatar`: an `Avatar` at 40, §6.30, centered on the row; the agent page). Row 3 (optional): a one-line description (`prose-small` `muted`, single line with an ellipsis). Row 4 (optional): **tabs** with counts (`全部 6 · 我的 3`) for pages with views, with the **search** field at the right end of the same row; a tab changes the view (`onSelect`) or links (`href`). The tab row has one height with or without the search (`control.default` + `space.1` above and below) and a 1 px `line-soft` bottom border; the tabs sit at its bottom and overlap the border by 1 px, so the selected tab's underline lies **on** the border; the search is centered vertically. While a ListPage loads, the tabs and the search keep their place and a tab's count is a `faint` "–" (§5.1). Tabs never wrap: a tab row too narrow for its tabs scrolls sideways (§6.4). **Below 640** (maintainer decision 2026-11-09) the title and the description take the full width and the description wraps instead of taking an ellipsis; the actions go on their own line under them, start-aligned (the primary as a button, the other actions folded into `more-horizontal` when there are several, one secondary staying a button); the actions keep their `default` height and reach a 40 px tap target through an invisible ring around them (`::after`, at least 40 × 40), so the head stays compact. The search takes its own full-width line above the tabs (`space.2` between the lines), and the tabs are 40 high (tap targets).
- **Loading** (`PageHeader.loading`, `{ title?, avatar?, actions?, tabs? }`; `avatar` draws a 40 px `block` skeleton in the avatar slot for a head whose loaded state carries an avatar (the agent page), so the row keeps its height; the templates' `loading` states build on it): the header keeps its rows, so nothing moves when the data arrives. What the page already knows renders for real: the path, a known title, the `actions` and `tabs` it was given. A `title` that is not known yet is a `title`-size bar (§6.29) 30% wide in the h1's line box, with no empty heading. `actions` / `tabs` give the number of placeholders to draw when the page does not know them yet (an action is a 72 px `default` control block, a tab a 56 px `body` text slot); they are drawn only while the real list is empty. **Below 640 the placeholders take the loaded parts' phone sizes**: the action blocks keep the `default` control height like the real actions, and the tab slots are 40 high like the real tabs (state `narrow-loading`), so the header does not change height when the answer arrives. The header is `aria-busy` with the hidden "正在加载 / Loading", unless it sits inside a skeleton group (§6.29), which announces once. Nothing animates.
- No bottom line and no background; spacing separates it from the body.
- Actions: at most 1 solid primary action + 2 secondary + a `more-horizontal` menu; the primary action is rightmost; all `default` density; an action may lead with a 14 icon (`plus` on a create action). The submit action of form pages **must not** go here; it goes in the ActionRow.
- List-page key metrics are **not** in the header: the template renders them below the header as StatCards (§6.14), at most 4–5. List and overview pages draw them at the top of the body; detail, trace, inbox, onboarding and status templates draw them in the fixed header area under the PageHeader.
- Content width: the header shares the body's one content width (`layout.content`, 1120, centered; §4.3). It sits `space.5` below the top of the content area; what follows it is the head rhythm below.
- **Head rhythm** (acceptance item S, 2026-11-07): one set of vertical gaps for every page head, the `layout.head-*` tokens (§2.5), drawn by `PageHeader` and the templates' one head (`TemplateHead`), so a page head reads the same on every template:

  | Between | Token | Value |
  |---|---|---|
  | the path (row 1) and the title row (row 2, with its avatar, count / status and actions) | `layout.head-path` | 12 |
  | the title line and the description | `layout.head-description` | 4 |
  | the title row (or the notice, or a detail page's StatCards) and the notice or the tab row | `layout.head-tabs` | 16 |
  | the tab row's bottom line and the body's first block | `layout.head-tabs-content` | 16 |
  | a head without a tab row (its last row, or the StatCards a detail, trace or inbox head carries) and the body's first block | `layout.head-content` | 24 |

  The gaps are the head's own: the body adds no space above its first block (no top padding on a detail page's content, a form's first section or a settings grid), and no template sets a gap of its own, so the path, the title row, the tabs and the first block sit at the same y on every template for the same head (List, Detail, Form, Settings, Overview, Inbox, Trace, Wizard, and Status / Onboarding, which share the head). A detail page's in-page tabs are the head's tab row (the same box as row 4: `control.default` + `space.1` above and below, the 1 px `line-soft` bottom border, 40 px tabs below 640). In-head StatCards sit `layout.head-content` below the PageHeader. A title row led by the avatar centres the title block and the actions on the 40 px avatar. The conversation title bar (§6.16.1) is one 48 px row (the path and the title on one line), so the rhythm does not apply to it; it shares the path's look and its horizontal spacing only. Checked by the `head-rhythm` blocks (below) and `apps/web/visual/head-rhythm.spec.ts`, which measures every template's path, title row, tab row and first block and expects them equal, and by the design unit test `head-rhythm.test.tsx`.

<!-- states: page-header -->
States: `title`, `path`, `description-actions`, `long-title`, `narrow`, `loading`, `narrow-loading`, `avatar`

<!-- size-table: page-header -->
| Part | State | Property | Value |
|---|---|---|---|
| page-header-title | title | font-size | type.h1 |
| page-header-title | title | line-height | type.h1.line |
| page-header-title | title | color | color.ink |
| page-header-row | title | margin-top | layout.head-path |
| path | path | font-size | type.small |
| path | path | color | color.faint |
| page-header-description | description-actions | font-size | type.prose-small |
| page-header-description | description-actions | line-height | type.prose-small.line |
| page-header-description | description-actions | color | color.muted |
| page-header-description | description-actions | margin-top | layout.head-description |
| button[data-variant=primary] | description-actions | height | control.default |
| page-header-title | long-title | height | type.h1.line |
| page-header | long-title | width | 608 |
| page-header-tabs | narrow | row-gap | space.2 |
| page-header-tabs | narrow | margin-top | layout.head-tabs |
| page-header-search | narrow | width | 358 |
| tab | narrow | height | 40 |
| button[data-variant=primary] | narrow | height | control.default |
| skeleton-text[data-size=title] | loading | height | type.h1.line |
| skeleton-box[data-box=default] | loading | height | control.default |
| skeleton-box[data-box=default] | narrow-loading | height | control.default |
| page-header-tab-slots | narrow-loading | height | 40 |
| page-header-avatar avatar | avatar | width | 40 |
| page-header-avatar avatar | avatar | height | 40 |

The head rhythm across the templates: one block per template, all with the same head (the path `capybara / agents / 研究助手`, the title, one default action); `list-tabs` adds the header's tabs and search, `detail` has its in-page tabs, `settings-avatar` leads the title row with the avatar (the agent page). Each block is the template in a 1280 × 480 box.

<!-- states: head-rhythm -->
States: `list`, `list-tabs`, `detail`, `form`, `settings`, `settings-avatar`, `overview`, `inbox`, `trace`, `wizard`

<!-- size-table: head-rhythm -->
| Part | State | Property | Value |
|---|---|---|---|
| template-head | list | padding-top | space.5 |
| template-head | list | padding-bottom | layout.head-content |
| page-header-row | list | margin-top | layout.head-path |
| template-head | list-tabs | padding-bottom | layout.head-tabs-content |
| page-header-tabs | list-tabs | margin-top | layout.head-tabs |
| template-head | detail | padding-bottom | layout.head-tabs-content |
| page-tabs | detail | margin-top | layout.head-tabs |
| page-tabs | detail | height | 37 |
| template-head | form | padding-bottom | layout.head-content |
| template-head | settings | padding-bottom | layout.head-content |
| template-head | settings-avatar | padding-bottom | layout.head-content |
| page-header-row | settings-avatar | margin-top | layout.head-path |
| page-header-row | settings-avatar | height | 40 |
| template-head | overview | padding-bottom | layout.head-content |
| template-head | inbox | padding-bottom | layout.head-content |
| template-head | trace | padding-bottom | layout.head-content |
| template-head | wizard | padding-bottom | layout.head-content |

### 4.3 Body layouts and content widths

| Layout | Structure | Used for |
|---|---|---|
| Single | Content | Overview, details, trace viewer, system status, first use |
| Rail + Content | 240 + flexible | Lists with facet filters |
| Rail + Content + Inspector | 240 + flexible + 400 | Inbox |
| Centered | content max `layout.content` (1120), centered | Forms, settings, wizards |

- Content width: **one** width for every page template (list, overview, form, settings, wizard, detail, trace, inbox, onboarding, status), `layout.content` (1120), centered (100% wide below that), with `layout.content-pad` (32) of side padding (16 below 640) and `space.5` (20) above the header; the page head and the body (also a detail page's tabs) share that container. The head and the scrolling body both reserve the scrollbar gutter (`scrollbar-gutter: stable`), so a classic (non-overlay) scrollbar never shifts the body's column against the head. The head therefore sits at the same x and y on every page and on every tab of one page. The inbox's rail + content + inspector split is capped at that width inside the same padding; the trace viewer's waterfall and detail share its one left edge (§5 T8). A form keeps its label column inside it (forms put `space.6` between sections, lists `space.3`); the conversation page has its own columns (§5.4). The Centered layout has **no anchor navigation**; a form's error count lives in the ActionRow.
- Content has a minimum width of 560. The Rail is collapsible; the Inspector is closable.
- Scrolling: the sidebar, PageHeader / PageTabs / ActionRow / StatusBar are fixed; the sidebar's conversation section, Rail, Content and Inspector scroll independently; the page must not show a horizontal scrollbar (wide tables scroll inside their own container).
- Responsive: < 1280 the sidebar becomes the rail and the Inspector a right-side Sheet; < 960 the sidebar becomes a drawer and the Rail a toolbar "Filter" button + Sheet; < 640 (phones, checked at 390 × 844) the header actions beyond the primary fold into `more-horizontal`, and:
  - nothing scrolls sideways: the side padding is 16 on every template and on the conversation page (§5.4), and nothing keeps a minimum width wider than the window;
  - tab rows scroll instead of wrapping (§6.4), and the page head's search takes its own line (§4.2);
  - every DataTable is stacked rows (§6.6) and StatCards are two columns (§6.14);
  - a `Grid columns="list-detail"` (a 220 px list beside a flexible detail, top-aligned: the agent page's prompt files and the open file's editor) is one column, the list above the detail;
  - tap targets are at least 40 px: the page head's tabs, the DataTable row menu, the drawer menu bar's and the conversation title bar's buttons (§6.16.1) are 40 high; the page head's actions (§4.2) and an ObjectRow's action and menu (§6.17) keep their compact look (`default` / `dense`) and reach 40 × 40 through an invisible ring around the button; the sidebar drawer's rows are 40 high (§6.13);
  - object lists are compact (§6.17, maintainer decision 2026-11-09): the row menu sits on the name line at the right, the state closes the meta line in its tone, and the row action sits at the right of the meta line, or under it when both do not fit;
  - the page head stacks (§4.2): title and description across the width (the description wraps), the actions under them;
  - a SettingsPage's sub-nav row sticks to the top of the scrolling body (§5 T5); the PageHeader's own tabs and a DetailPage's in-page tabs sit in the fixed head already;
  - type keeps its sizes: `micro` (11) stays the smallest (§2.2).
  - on a touch screen (`pointer: coarse`, any width) text fields (inputs, textareas, selects, editable text) are at least 16 px, so iOS Safari never zooms the page into a focused field; the viewport keeps pinch zoom (no `maximum-scale`).
  - on a touch device (`isTouchPointer()`: a coarse primary pointer, or a coarse pointer and no fine one) a tap that only chooses something (an agent, a quick action) never moves focus into a text field, so the keyboard does not pop up; a quick action places its text without focusing. Pointer devices keep the autofocus (maintainer acceptance 2026-11-09).
  - **the on-screen keyboard** (maintainer acceptance 2026-11-09): iOS keeps the layout viewport when the keyboard opens, so a composer pinned at the bottom would sit behind it. `AppShell` follows `window.visualViewport` (`resize` and `scroll`, coalesced to one `requestAnimationFrame`, listeners removed on unmount) and writes the keyboard's height over the shell's bottom (`keyboardInset`: shell bottom − `vv.height` − `vv.offsetTop`, at least 0) to the shell as `--cb-keyboard-inset`, with `data-keyboard="open"` while it is above 0. The conversation page pads its bottom by it, so the composer (on a new conversation and on `/chat/<id>`) stays above the keyboard and the thread above it shrinks; its status bar is hidden while the keyboard is open. While the keyboard is open the shell never scrolls the document (the inset does the work); once it closes the document goes back to 0, 0 as before.

### 4.4 ActionRow and StatusBar

- **StatusBar**: one form only. Height `layout.status-bar`, **no background**, a `line-soft` top line, `micro` type, `muted`, padding `layout.gutter`. Left: the prompt `<login>@<org slug>:~/<path>` in the workspace and `<login>@<org slug>:/admin/<path>` in the admin console (the login in lowercase and the org's slug; the same on the conversation page, `~/chat/<id>`, which also shows the time zone) and the page status (such as "Filtered 18 / 24", "Auto-refresh 15s"), `space.3` apart; right: system status, version and time zone, separated by spacing only (`space.3`, as the signed reference). No `>` prefix, no status dot (success is not colored); a failed run's status ("失败" / "Failed", the conversation page) is drawn in `fail` (`systemTone`, `ConversationStatus.tone`). **Read-only**: it never holds a clickable control and never grows into an action bar. When space runs out the left part truncates first (ellipsis), the right part stays.
- **ActionRow**: when the page has actions to submit (forms, bulk edits, approval decisions, wizards) it appears **above** the StatusBar; both stay fixed at the bottom of the content area. Height `layout.action-row`, `panel-2` ground across the content area, `line-soft` top line; inside a template its row is the content frame (the template's side padding, `layout.content` wide and centered, the body's scrollbar gutter), so the primary ends where the content ends; outside a template (the reference set) the padding is `layout.gutter`. Left: an accent dot + "N unsaved changes" (`muted`) `·` "N errors" (`fail` text, no icon, as the signed reference; the words carry the state), or a muted "No unsaved changes" ("没有未保存的修改", when the page passes `unsaved: 0`; never on a create form, §5.3); right: Cancel / Discard (default) · secondary action (default) · primary action (primary, rightmost), all `default` density. With no changes the primary is disabled.
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
| T1 | Overview | Single | — | — | content | Agent summary, admin overview, the setup home (the workspace has no home page: the new conversation is the home) |
| T2 | List | Rail + Content | — | During bulk edits | content | Agents, connectors, extensions |
| T3 | Detail | Single (one centred column; the facts block first, §5.2) | Yes | — | content | Agent, connector, channel, eval set and run details |
| T4 | Form | Centered | — | Always (submit actions) | content | Create / edit Agent |
| T5 | Settings | The PageHeader across the full content width, then below it a 200 px sub-nav (named "Settings navigation"; groups with a mono `faint` label, 30 px items, the current item on `sidebar-active`, optional mono counts) beside the content column (below 960 the nav stacks above the content; below 640 it is a compact control, one sideways-scrolling row of its items above the content with no group labels, 40 px high, the current item scrolled into view, so the content starts on the first screen; it sticks to the top of the scrolling body, right under the fixed head, on the `bg` ground with its `line-soft` hairline, so the sections stay one tap away while the content scrolls, maintainer decision 2026-11-09); the header's `tabs` (a section's own views, such as the models page's 模型 / 用途默认) and `description` open the content column instead of the head, tabs first, so the head keeps one height and the sub-nav's top, aligned with the content's, has the same y on every settings page | — | When there are changes | content | Org, members, environment, security |
| T6 | Inbox | Rail + Content (+ Inspector) | — | During decisions | content | Human approval, alert handling |
| T7 | Conversation | Title bar + thread + composer, with the properties panel or one right panel (§5.4) | — | — | own columns | The conversation page (`/chat`, `/chat/<id>`) |
| T8 | Trace | Single: the span waterfall, then the selected span's detail right after it (no stretched waterfall, no gap); from 1280 the detail is a 400 px right panel inside the width, both columns scrolling on their own; stats, waterfall and detail share one left edge | — | — | content | Single run detail |
| T9 | Wizard | Centered + step bar | — | Always (Previous / Next) | content | First-time model, connector and extension setup |
| T10 | Auth | No Shell, centered card + dither dot matrix on both sides | — | — | — | Sign in, password recovery, accept invitation, initialization |
| T11 | System status | Single centered | — | — | content | 404, 403, under maintenance, not enabled, no access (`kind="no-access"`: a 16 px `lock` in `faint` instead of the code, the title, what the page is, `need` as a mono chip "需要：组织管理员" / "Requires: Org admin" (1px `line`, radius `sm`, `small`), `ask` in `muted` (who to ask); never an action or a retry; the web app's one role gate draws it, web-order spec §9) |
| T12 | Onboarding | Single centered checklist | — | — | content | New org, empty environment |
| T13 | Setup | The Shell's geometry with the setup sidebar (§6.13 `context.kind: "setup"`: the setup home and the steps as navigation), the content area, the status bar (§5.5) | — | — | the page's own (content) | The workspace while the org has no model or no agent (web-order spec §3.8, web-SSR spec §4) |

### 5.5 Setup (T13)

`SetupPage({ sidebar, status, title?, children })` is the layout the app frame draws while the current org cannot run yet (web-SSR spec `docs/superpowers/specs/2026-11-01-web-ssr-design.md` §4). It has the Shell's geometry and is built on `AppShell` (§4): the Sidebar on the left, the content area (the drawer menu bar below 960, the page, the StatusBar) on the right, the same rail below 1280 and drawer below 960. The sidebar is the setup context (§6.13): `sidebar` carries the org (the switcher, as in the workspace), `home` (the setup home's link), `steps`, `activeNav` (a step id or `home`), the account, the theme and `adminHref` (super admins). There is no command palette: ⌘K opens nothing and the drawer menu bar has no search button. The page brings its own template and page head in the content width: the setup home (`/`, the workspace's home; the old `/chat` redirects there, and a route that is no setup route goes there) is an `OverviewPage` with the path `<slug> / 开始之前`, the h1 开始之前, the progress 已完成 n / 2 as the page head's `count` beside the h1, the checklist card (no head band of its own) and 可以稍后再做 (an `h2` over an `ObjectList` of the optional steps, each an `ObjectRow` with the step's icon, its label as the linked name and one sentence saying what it is for); a step page is its own template exactly as in the shell. There is no back link (the sidebar is the way back) and no top bar.

### 5.1 List (T2)
- Order in the content column: PageHeader → StatCards (when the header has `metrics`) → the DataTable (its toolbar above the table, pagination below): the first block sits `layout.head-content` (24) below the head, or `layout.head-tabs-content` (16) below its tab row (§4.2 "Head rhythm"), and the blocks are separated by `space.3`.
- Rail: faceted filters; each group has a title (muted) + checkbox items + counts.
- Content = one DataTable (§6.6) on the `panel` ground (framed, as the signed reference; inside a box, a Card or a flush form card, a table is unframed by itself, §1), whose toolbar, bulk bar and pagination all belong to the DataTable.
- Subordinate section (optional, at most one): below the main table with a `space.6` gap, an `h2` title + one DataTable listing secondary objects closely related to the main object and few in number (such as "Invitations" on the members page, a settings page that follows the same rule); it has no filters or metrics of its own, and the create entry stays in the PageHeader. When the secondary objects need their own filters or are numerous, make a separate list page.
- PageHeader: title + total, description, secondary actions on the right + Create (primary); metrics ≤ 5 as StatCards.
- **One primary per screen**: while `empty` is drawn with a `primary` action, the template leaves the head's primary out and the empty state carries it (the head's other actions stay); with rows, while loading, or when the empty state has no primary action, the head keeps it. Pages pass the same action to both and never draw two.
- StatusBar page status: the number of filter results.
- **Variants** (`variant`): `records` (default) holds a DataTable; `objects` wraps its ObjectRows (§6.17) in one ObjectList panel (things people own and configure: skills, connectors, plugins); `cards` lays its ObjectCards (§6.34) out in one CardGrid on the page ground, no box around it (things a person picks by look and starts from: the workspace 智能体 page's 智能体 and 模板 tabs, the admin 智能体模板 list; ruling P4-15). The head, its tabs and search, the `filters` row (a toolbar filter above the grid, such as the agents' `Segmented` 全部 / 我的 / 组织共享), `callout`, `empty` and `loading` work as for the other variants. The `callout` prop draws a Callout (§6.19) in the header between the title row and the tabs; `empty` draws an EmptyState (§6.18) instead of the content. `loading` (`true`, or `{ rows?, stats?, table?, keep? }`; spec §7.1 of the web query cache design) draws the page's frame until the first answer, with one busy announcement (§6.29): the head keeps its real layout (§4.2: the path, a known title, actions and search for real, an unknown title is a `title` bar; the tabs stay with their counts shown as a `faint` "–"), so nothing moves when the answer arrives; `stats` stat card placeholders stand in for `metrics` the page does not know yet (§5.6); the list is skeleton rows in the loaded list's own container: for `objects`, the ObjectList panel with `rows` rows (default 3), each the object row's box with a 36 px mark box and a name and a description line in the one bar look (§6.17); for `cards`, the CardGrid's skeleton cards, `rows` of them (default 6, §6.34); and for `records`, the DataTable's own loading state in the caller's `table` shape (`label`, `columns`, `rowHeight`, `framed`, as InboxPage, §5.7), else four full-width `body` bars (`Skeleton({ rows })`); the action row, when there is one, stays with its buttons disabled; a page whose content is its own sections (each `FormSection` saying for itself whether it is loading) passes `keep`, and its `children` render as they are inside the page's one busy region, so no section announces itself (state `loading-keep`, against the loaded `keep`). Loading wins over `empty`. Exception: a tab that exists only when the data holds something different from 全部 cannot be known before the answer and appears after it. An object list has no rail: tabs with counts in the header replace the filters.

<!-- states: template-list -->
States: `page`, `default-objects`, `loading-objects`, `keep`, `loading-keep`, `cards`, `loading-cards`

<!-- size-table: template-list -->
| Part | State | Property | Value |
|---|---|---|---|
| sidebar | page | width | layout.sidebar |
| content | page | max-width | layout.content |
| status-bar | page | height | layout.status-bar |
| content | default-objects | max-width | layout.content |
| content | loading-objects | max-width | layout.content |
| skeleton-box[data-box=mark] | loading-objects | height | 36 |
| skeleton-text[data-size=body] | loading-objects | height | type.body.line |
| content | keep | max-width | layout.content |
| content | loading-keep | max-width | layout.content |
| content | cards | max-width | layout.content |
| card-grid | cards | column-gap | space.3 |
| object-card | cards | padding-top | space.4 |
| content | loading-cards | max-width | layout.content |
| card-grid | loading-cards | column-gap | space.3 |
| skeleton-box[data-box=block] | loading-cards | height | 40 |

**The 扩展 pages** (workspace `/extensions`, admin console `/admin/extensions`; design note 2026-11-06): a `records` ListPage with one roomy DataTable, sorted by capability. The head's tabs are 全部, 模型 (`model-provider`), 网页 (`web-search`, `web-fetch`), 连接器 (`connector`), 沙箱 (`sandbox`), 存储 (`object-store`) and 工具与界面, each with its count, and the search by name at the row's end; the open tab is `?tab=<id>` (none for 全部). One web module maps the points to the tabs (`apps/web/src/lib/extension-capabilities.ts`): an extension providing points of two tabs is in both and once in 全部, and under a tab its row shows only what it provides there; 工具与界面 is the catch-all for an extension that provides none of the mapped points (agent tools, UI views, channels, directory, a point the module does not know yet, or nothing), so there is no 其他 tab. All seven tabs are always drawn (counts may be 0), so the loading head is the loaded one. A row: the display name over `plugin · version` (`CellTitle mono`), the capabilities (a `wrap` list: 模型, 网页搜索, 网页读取, 智能体工具, 界面 …), the state, and in the workspace for org admins the enable switch (an `interactive` column). Rows needing attention come first (待配置 or a refused switch in the workspace; any status neither enabled nor disabled on the admin console), then those on, then the rest, by display name. A row opens a right-side Sheet (§6.7): on top the config form (the workspace's org config, 保存配置 / 保存并启用 in the footer; the admin console's deployment config), then the state region (the state as its first line, then the capabilities; the admin console's lifecycle actions and replicas), then the permissions under their 权限 heading folded into one line (「数据库表 2 · 智能体工具 1 · 敏感」, a `Disclosure`) that opens the full permission blocks (on the admin console with the approval, open by itself while one waits). A refused switch opens its Sheet with the reason. Members read the same list without the switch and a Sheet with the capabilities and the state only (the kernel gives them no config, secrets or permissions, only the extension points each provides, `provides`, from which their tabs and chips come). The workspace page keeps the default providers (in 全部 and 网页) and the file previewers (in 全部 and 工具与界面) under the table.

**The 智能体 page and the template cards** (workspace `/agents`, admin console `/admin/agent-templates`; rulings P4-14 to P4-17 of the plugin component management design): one `cards` ListPage with the head tabs 智能体 and 模板 (`?tab=templates`; 智能体 is the bare `/agents`), both counted, the search at the row's end (one per tab, cleared on a switch) and 新建智能体 as the head's primary; guests, who cannot create agents, get the agents alone without tabs. 智能体 takes the `Segmented` filter 全部 / 我的 / 组织共享 in the `filters` row. An agent card: its avatar, the name (the card opens the agent's page, read-only for whoever may only use it), the description, the meta owner · 可见范围 (「我」 for one's own; a guest's cards show the visibility only), the primary 开始会话 (a link to the new conversation with the agent picked) and ⋯ with 设置 (whoever may change it), 运行记录 (org admins and a member owner) and 另存为模板 (org admins); the owner is changed on the agent page only, never from the list (acceptance item P). A template card: the initial square, the name (the card opens the template page `/agents/templates/<id>`), the description, the meta source · v (平台 / 本组织 / the owner org's name / 插件 · name; an off platform template adds its state in `warn`), the primary 用它创建 on a template usable in the org (an org admin's 启用 on one that is off, else none) and ⋯ with 查看, or for owner-org admins 编辑 (the template page is their editor), 设为可共享 / 取消共享 and 删除 (the preview first, the name typed), then the org admin's switch actions (停用 with its preview, 查看插件). The admin list draws the same cards under its tabs 全部 / 平台 / 组织创建: the meta source · owner · scope · v (内置 plain, 已停用 / 插件已停用 in `warn`), the primary 查看 (the detail) and ⋯ with 对其他组织显示, 设置范围 and 停用 / 启用 (上传新版本 stays on the detail). 技能 and 连接器模板 keep their tables. Each tab has its own loading (skeleton cards under the real head and tabs), empty and error states; a tab whose list cannot be read says so in the list's place with 重试, its head and tabs kept. `/agent-templates` and `/agent-templates/<id>` redirect (temporarily: the old path never shipped) to `/agents?tab=templates` and `/agents/templates/<id>`.

**用它创建 and 待配置** (rulings P4-3 to P4-8, P4-18; a `Dialog` opened by a template's primary, on the cards and the template page): the name (the template's), a preset avatar (an upload comes after creating), 可见范围 only for org admins (members always 仅自己, the option never drawn), the model preselected with the source of the choice said, then the preview in three `Disclosure`s 带入 / 待配置 / 不可用 with counts (待配置 and 不可用 open while non-empty; each item a kind tag, its name and the reason in words) and the settings left out; 创建 lands on the new agent, on its Tools section when connectors wait. A changed template or org state (409) re-reads the preview, says what changed in a `warn` Callout and the next 创建 sends the new hash; a template no longer usable offers no 创建. On the agent page the basics show 「由模板 X vN 创建」 (the name links while the template is usable) and Tools opens with the 待配置 notice: org admins get 配置 per entry in one dialog (use an existing connector, one more from the connector template, or the prefilled custom connector form); the owner who cannot configure sees the request state (已申请 / 驳回理由 with 重新申请 / 申请) and the same entries sit in the admin inbox as a 连接器配置申请 with the same dialog.

**The template page and 另存为模板** (`/agents/templates/<id>`; rulings P4-9 to P4-14): the agent page's frame, a `SettingsPage` with the section nav 基本信息 / 快捷操作 / 提示词 / 模型 / 工具 / 技能 / 连接器 / 子智能体 (`?s=`; no 渠道) and the open section. The head follows the agent page's (not §5.2's component-detail head): the initial square (`Avatar` without a picture), the name, the description (drawn as the agent page draws it; 基本信息 does not repeat it), source · v in the title row's count slot (mono, as on the cards), the path `<org> / agents / templates / <name>` (templates goes back to `/agents?tab=templates`), 用它创建 as the primary on a template usable in the org, and ⋯ with 设为可共享 / 取消共享 and 删除 for owner-org admins (删除 is the cards' dialog: the preview first, a transfer to the platform said, the name typed; then back to the 模板 tab) and the org admin's switch actions on a platform template. Members up read every section (a template is read before 用它创建): key-value rows, flush lists of rows (tools with their policy, skills with 预载, connectors with a needs entry's address and tools, sub-agents), the prompt files and inline instructions as code blocks; guests get no access. Owner-org admins get the editor in the same sections, each with its own draft and action row as on the agent page, the prompt files and quick actions in the agent page's own editors; each save writes the whole definition as a new version with `expectedVersion`, and a stale one is the fail Callout with 重新加载 above the section. The name is fixed (it is the roster type); 模型 is the tier, an optional concrete model and the effort; 技能 picks by name with up to 3 preloaded, a name the org lacks kept and marked; 连接器 lists template entries by name and needs entries edited in place (name, protocol, address, tools one per line; an address with a user name, a query or a fragment is refused on the field with the clean form to use, before and after the kernel's check), one policy select per listed tool (默认 / 先询问 / 禁止, as in 工具; an entry naming no tools keeps its policies read-only and says so), and adds a connector template on in the org (a select) or a needs entry. A platform template offered to the org but off there (the kernel serves no detail) is an `OverviewPage` with the component's head and the page `EmptyState` 这个模板未在本组织启用, with 启用 as its action for an org admin who may switch it (查看插件 when its plugin is off), else whom to ask; a template the detail marks not usable here (`usable: false`: the owner's own promoted template switched off in its org) keeps its page with the warn notice, 启用 in it when the component is offered, and no 用它创建. 另存为模板 (org admins, from the agent page's ⋯ and the agent card's) is a `Dialog`: the name (the agent's name in the bare-name form), the description (the agent's), a sentence on what goes in (never credentials) and the org agents of its sub-agent roster, which stay out; a name taken in the org names its owner on the field (平台 / 本组织 / the sharing org), a reserved one says so. Saved: the new template's page, or first, when the kernel left more out, the dialog's second step listing each omission in plain words (what, then why) with 打开模板 as a `LinkButton` primary.

### 5.2 Detail (T3)
- PageHeader: path ending with the object's name; name + version (faint) + status; actions: Edit (default), Trial run (secondary), `more-horizontal`.
- PageTabs: Summary · Runs · Config · Versions · Permissions · Audit (pick per object type), with counts following in faint. An object with one view has no tab row (`DetailPage.tabs` left out): a row of one tab says nothing (the workspace plugin detail).
- Content: sections on the `panel` ground with radius `md` (no border), section header h2 + actions on the right, `space.4` between sections.
- **One centred column, no right pane** (2026-11-07 ruling: no detail page has a right inspector for now): the content is one centred column of the content width. `DetailPage.facts` is the object's facts block (`data-part="detail-facts"`): a KeyValue (key muted at the page's key width, value single line with ellipsis; grouped KeyValues with a small muted group title when the object has groups), drawn by the template as the first block of the column, right under the head and its tabs, above the tab's content (`children`), `space.3` apart like every block of the column. A page puts its full description (when the head does not carry it, below) first inside `facts`, above the KeyValue, so the order is always description, facts, tab. Every action stays in the head, never in the facts block. What a page used to open in an inspector on selection (an eval run's result) opens in a right-side Sheet (§6.7) instead.
- **Plugin and component details** (admin and workspace 插件 / 技能 / 连接器模板 / 智能体模板 details; 2026-11-06 ruling; the workspace template page `/agents/templates/<id>` is the exception: it follows the agent page's head, §5.1 "The template page and 另存为模板"): the head carries no description: the full description (line breaks kept) is the first block of the column, right under the head, as `prose` `muted` text, since the head's one-line description would cut it; every action is in the head (a destructive one such as 删除 is the head's `more-horizontal` menu item, never a button in the page), the facts (包, 来源, 发布者, 归属, 范围, 在用组织, 权限, 更新时间 …) are a KeyValue after it, the tab's content follows, and a long text such as 许可证全文 is a folded section (Disclosure) at the end.
- **Loading** (`DetailPage.loading`, `{ facts?, blocks?, content?, stats? }`; spec §7.1 of the web query cache design): every region keeps its box, so nothing moves when the data arrives. The header is the PageHeader's loading state (§4.2); a page whose loaded header has `metrics` passes `stats` (their count), and that many stat card placeholders (§5.6: the `panel` card with a `small` label slot over a `metric` value slot) stand under the header where its StatCards will be (the header's own `metrics`, when the page knows them, render for real instead); the PageTabs stay real (the tabs are static per page), the content is `blocks` card-shaped blocks (default 2) in place of `children`: the `panel` card of the sections above, its head band holding a 30% `body` text slot and its body three text slots (100%, 70%, 55%) `space.2` apart; the card is 147 px high (a 1 px border on each side, the head band 37 = `space.2` × 2 + one `body` line + its 1 px rule, and the body 108 = padding 16 × 2 + three `body` lines + two `space.2` gaps). The facts block mirrors the loaded one: with `loading.facts` set, the column's first block is the same `detail-facts` block holding KeyValue's own box (§6.5, the same `dl`) with four rows, each a `body` slot for the 8ch key and a 55% `body` slot for the value (a group title is not drawn: the loaded facts' groups are the page's), above the content blocks; `facts` the page passes for real stays; `loading.facts` as `{ rows?, keyWidth?, columns?, lead? }` draws that many rows with that key width in one or two columns (the loaded facts' KeyValue), and `lead` puts a 70% `prose` line over them (gap 12) for facts that start with the object's description (the eval set). A page whose loaded facts block has no KeyValue rows to mirror leaves it unset. A tab whose static structure the page knows passes `content` (`BlockShape[]`) instead of `blocks`: the blocks stand in a gap-16 stack as the loaded tab stacks its parts (state `loading-content`, against the loaded `content`). A block is `lines` (a gap-4 stack, a `body` line over `small` ones), `list` (a labelled list: a `body` label slot over `items` `body` lines, gap 8), `key-value` (KeyValue's own `dl`, `rows`, one or two `columns`, `keyWidth`), `buttons` (a gap-8 row of `count` 88 px control-height slots, with a `small` line under it when `help`), `table` (the page's real `small` muted title over the DataTable's own loading state with its `label` and header `columns`, gap 8; a static `toolbar`, such as a refresh button, renders for real in the table's toolbar row) or `card` (a titled card on the page ground, an `ItemShape`, §5.8). A `radios` field shape (§5.8) is a plain RadioGroup's own markup: per option its box and a `body` label slot. One busy announcement for the page (§6.29). Nothing animates.

<!-- states: template-detail -->
States: `default`, `loading`, `content`, `loading-content`

<!-- size-table: template-detail -->
| Part | State | Property | Value |
|---|---|---|---|
| content | default | max-width | layout.content |
| content | loading | max-width | layout.content |
| loading-card | loading | border-radius | radius.md |
| loading-card | loading | height | 147 |
| skeleton-text[data-size=body] | loading | height | type.body.line |
| detail-facts key-value-row | default | height | type.body.line |
| detail-facts key-value-row | loading | height | type.body.line |
| content | content | max-width | layout.content |
| content | loading-content | max-width | layout.content |
| skeleton-box[data-box=default] | loading-content | height | control.default |

### 5.3 Form (T4)
- PageHeader: path ending with the object's name (`new` for a new one); title "Create X" + draft badge; only auxiliary actions on the right (such as "Import from YAML").
- No anchor navigation (the Centered body has none, §4.3).
- Sections: a two-column grid, the left column 240 wide with the section title (`h2`) and a description (`prose-small` `muted`), the right column the fields on a `panel` card with radius `md`, padding `space.4`, `space.3` between fields. Sections are separated by `space.6` of spacing, **not by lines**; rows inside a list of switches are divided by `line-soft`.
- **The card is the one box** (§1 principle 7): what a section holds groups with headings, hairlines and space, never cards. A list of things each with its own lines or fields (model purposes, quick actions, inline sub-agents) is one `ItemList inset="flush"` of `ItemListItem` rows in a `flush` section (§6.33: each row padded `space.4`, its title line, meta lines, then its field; rows split by `line-soft`); a table is unframed in a `flush` section, running to the card's edges, and several tables in one card are flush `Subsection`s, each an `h3` heading row over its table, split by `line-soft` (§6.32, §6.6); a nested group of fields (a config object) is a `Subsection` under the Disclosure's guide; an array of objects is a `Repeater`, whose items are divided rows inside the card (§6.26). A notice about the section goes above the section card (§6.19); a Callout that does land inside a box (a panel shared with a Sheet) draws its line form there by itself.
- **Stacked sections** (`FormSection layout="stacked"`; default `columns`): the head (the `h2` title over its description, `space.1` apart) sits above the fields card, `space.3` below it, and the card takes the content's full width. Use it for a section whose content needs the width, such as an editor (the agent page's prompt files, §5.8 "List + editor"). **Every section of a SettingsPage (§5.8) is stacked**, whatever its `layout`: the sub-nav already holds a column of titles, and a second title column beside the cards would leave an empty band between the nav and the fields. Sections elsewhere (a FormPage) keep the two columns. Below 960 every section is stacked this way already, so the narrow layout does not change. A loading section passes the same `layout` (`SettingsPage.loading.sections[].layout`), so its skeleton keeps the loaded section's boxes.
- Fields: label on top (`body` `ink`; required marked with an accent `*`, optional marked "Optional" in faint); controls `default` density; help text and error message below (`small`); on error the border is `fail` and the message starts with the `circle-alert` icon and gives an actionable suggestion.
- The ActionRow is always present: Cancel · Save draft (⌘S) · Publish.
- **Create forms** (`FormPage create`, a new object): focus starts on the first field; the ActionRow never says "No unsaved changes" (nothing exists yet to be unchanged; typed fields still count as unsaved and guard leaving); the primary is disabled until the form is valid (the required fields filled), as in a create dialog. A create form whose prerequisite is missing (no channel extension enabled for 新建渠道) draws only the `EmptyState` with the next step, never the form.

- **Loading** (`FormPage.loading`, a flag; `FormSection.loading`, `{ fields }` or `{ items }`; spec §7.1 of the web query cache design): every region keeps its box. The header is its loading state (§4.2: the path the page knows, a title bar when the title is not known yet). Each section is the page's own `FormSection`, so the page passes its static section list and a section whose data is ready renders for real next to loading ones: a loading section keeps its title and description and draws `fields` field placeholders in its card in place of `children`; a section that lists items passes `items` (`ItemShape[]`, §5.8) instead and draws those item row placeholders in a flush card (never card placeholders inside the card, §1). `fields` is a count (that many default inputs) or `FieldShape[]`, the page's static field layout, which it knows before the data arrives and **must pass** whenever a field is not a plain input, so the loading card is as tall as the loaded one: `{ control?: input | textarea | select | segmented; help?: boolean; rows?: number; pair?: boolean }`. A field placeholder is the loaded `.cb-field` itself: a `body` slot (30%) in the field head where the label is, then the control's own box directly in the field (`control.default` for input, select and segmented; a textarea is `max(rows, 2)` `body` lines + `space.2` + 2 px high, `rows` default 2), so the box has whatever width the field's rule gives a control (never a width of its own), then, when `help` is set, one `small` slot (the loaded field's help text, error message or counter line). A shape with `pair` and the one after it sit in the two-column `Grid` (gap 12) the loaded section draws for paired fields. The ActionRow stays, its buttons disabled and with no unsaved or error count. A `flush` section (a SwitchList) keeps its flush card (no padding) and draws `fields` switch rows in SwitchList's own list and row (divider, padding, `row.roomy` height): a `body` name slot (30%) over a `small` description slot (55%) in the text column and a 32 × 20 box in the switch's place. One busy announcement (§6.29); a loading section outside a loading page announces itself. Nothing animates.

<!-- states: template-form -->
States: `page`, `loading`

<!-- size-table: template-form -->
| Part | State | Property | Value |
|---|---|---|---|
| sidebar | page | width | layout.sidebar |
| content | page | max-width | layout.content |
| action-row | page | height | layout.action-row |
| status-bar | page | height | layout.status-bar |
| sidebar | loading | width | layout.sidebar |
| content | loading | max-width | layout.content |
| action-row | loading | height | layout.action-row |
| skeleton-box[data-box=default] | loading | height | control.default |
| skeleton-box[data-box=textarea] | loading | height | 50 |
| skeleton-text[data-size=body] | loading | height | type.body.line |
| loading-switch-row | loading | height | row.roomy |

### 5.4 Conversation (T7)

`ConversationPage` (it replaced `PlaygroundPage`, which only the conversation page used; removed with UI refresh B). Signed off with reference set B on 2026-10-27; UI refresh spec §5.

- **Columns**: the sidebar (§4.1) | the middle column | the right area.
  - The **middle column** holds, top to bottom: the title bar (§6.16.1), the thread (centered, at most `layout.chat` wide, gutters `layout.gutter`, padding `space.4` on top, items `space.3` apart; it opens at its latest message and follows the bottom while the reader is at the bottom, see **Thread scrolling** below; it reserves a classic scrollbar's gutter on both sides, `scrollbar-gutter: stable both-edges`, so it keeps the composer's center line whether or not it scrolls), the composer (§6.16.2, at most `layout.chat` plus the gutters wide, centered, `space.3` from the status bar) and the status bar (§4.4). It is never narrower than `layout.chat-min`, except **below 640**, where it fills the window and the title bar, the thread and the composer use `space.4` (16) gutters, so the composer, its send button and the user bubbles never run past the right edge.
  - The **right area** holds one thing at a time: either the **properties panel** (§6.16.17), which sits *inside* the middle column under its title bar so the title bar spans thread and properties, or **one right panel** (§6.16.18), full height beside the middle column, whose title bar then narrows with it. Opening one closes the other; "none" is the default.
- **Thread scrolling** (acceptance 2026-11-07: a reload painted the thread from its first message, then jumped): the thread's scroller (`.cb-conv-scroll`) is anchored at the bottom by CSS, a reversed column (`flex-direction: column-reverse`) around its one content wrapper (`.cb-conv-thread`), so its scroll origin is the bottom and the first painted frame, the server HTML before any script, already shows the latest message; the wrapper's bottom auto margin keeps a short thread at the top. Only the wrapper is reversed against, never the items, so reading, focus and screen-reader order stay top to bottom. Content growing while the reader is at the bottom (streamed text, new events, an extension block or a long bubble laying out) stays in view; within 48 px of the bottom still counts as at the bottom (the view snaps back to it); a reader who scrolled further up is never moved: what they look at stays still while content arrives below (the browser's scroll anchoring, or `useFollowBottom` keeping the distance from the top where there is none), and following resumes once they scroll back to the bottom. Scrolling is always instant, never smooth. The hook is a callback ref, so it attaches to whichever element is the scroller (the new conversation's centered layout giving way to the thread). The new conversation's centered layout (`data-center`) is not reversed. There is no jump-to-latest control.
  - **History in pages** (history paging spec 2026-11-07): the page paints the log's last page and reads earlier pages as the reader scrolls up. `ConversationPage.history` (`{ state, onLoadEarlier }`) draws `ThreadHistory` as the thread wrapper's first child: `more` a centered "加载更早的消息" / "Load earlier messages" link between the run divider's rules, with an observed edge that reads the previous page once it comes within 600 px of the visible area (rooted at the nearest scroller, observed again on every state change); `loading` one placeholder line (`SkeletonText` 70%, prose size) and a polite status "正在加载更早的消息" / "Loading earlier messages"; `failed` the fail divider "更早的消息加载失败 · 重试" / "Couldn't load earlier messages · Retry" (`role="alert"`); `start` the divider "会话开始" / "Beginning of conversation", shown only after earlier pages were loaded (a conversation that fits one page has no edge). It reuses the run divider (§6.16.7) and the loading turn, so it has no look of its own. Prepended history never moves what the reader looks at: the reversed scroller keeps its distance from the bottom, browsers with scroll anchoring keep the anchor, and `useFollowBottom`'s fallback keeps the topmost visible item where it was (for content arriving below as well). A sub-agent's panel (§6.16.18) puts the same edge above its thread.
- **Narrow windows**: below 1280 (where the sidebar becomes the rail, §4.3) the right area is a right-side Sheet over the page (`layout.panel` wide, `shadow-sheet`, a `scrim` behind it), closed by Esc, its close button or a click on the scrim; the server render and hydration cannot know the window, so below 1280 a CSS media query hides the inline right area until the first client render makes it the Sheet (the page never scrolls sideways, no flash). At 1280 and above it sits beside the thread; with the full sidebar at exactly 1280 the panel narrows to 544 so the thread keeps `layout.chat-min` (maintainer ruling 2026-10-27).
- **New conversation on a phone** (below 640, maintainer decision 2026-11-09): the composer is pinned at the bottom of the middle column as on a conversation (sticky in the scroller, on the `bg` ground, `space.3` above the status bar; `new-composer`), the greeting and the agents row sit at the top (`space.4` from the title bar), the agents row is one line that scrolls sideways (no wrapping, bleeding to the window's edges, snapping to chips, the selected chip scrolled into view, every chip a tab stop), and the selected agent's quick actions are listed between them (`ConversationPage.newConversation.quickActions`, a `QuickActionList`, §6.16.27; `new-quick-actions`, shown below 640 only), so the composer has no `zap` button there (`data-quick`); an agent without quick actions lists nothing. 640 and up the page is unchanged.
- **New conversation**: nothing is created until the first send. The title bar shows "新会话" / "New conversation"; the thread is replaced by a centered column (`layout.chat` wide) holding, top to bottom and `space.4` apart (agent profile design §4, U1): the greeting (§6.16.25), the agents row (§6.16.26; hidden with one usable agent) and the composer, whose control row then has no agent picker (the row chooses the agent; the model and effort pickers stay) and holds the selected agent's quick actions as a `zap` button after the effort picker (§6.16.27; none when it has none). `ConversationPage.newConversation` takes them as `greeting` and `agents`; without a `greeting` the agent's name (`h2`) and description (`prose-small` `muted`) stand in its place. With either of the two the column's parts are `space.4` apart; with none it is the name and description over the composer, `space.2` apart. The status bar shows only the context and the version.
- **Status bar** (read-only, §4.4): left `user@org:/chat/<id>` and "第 N 轮 · 已用 <elapsed>" / "Turn N · <elapsed>" (the run's working time: it ticks only while the run works and stops while it waits for a person, an approval or a question, then counts on); right the run status ("空闲" / "Idle", "运行中" / "Running", "等待批准" / "Waiting for approval"), "上下文 N%" / "Context N%" and the version.
- **Runs** (design note, unslop fixes 2026-11-03): every run that ended closes with a **run row** (§6.16.23), a quiet mono line `运行 · <model> · <duration> · <tokens>` with its status mark (the duration is working time, waits for a person left out, as the status bar counts it), built from the log alone (`run_started`, `model_call`, `usage`, `run_finished` / `run_failed` / `run_aborted`). A finished run's row is collapsed and uncoloured except its `ok` check; a failed run's row is open at first and red only in its mark, its status word and the failure sentence; its detail holding the failure (ErrorDetail: the sentence in the reader's language, the raw kernel text behind 原始错误), 重试 (the last failure only, while nothing runs), 查看轨迹 (`/trajectories/<conversationId>`, only for those the kernel lets read it: org admins and owners, or the agent's owner) and, for a super admin when the model service is misconfigured (`model.auth`, `model.unconfigured`, `run.model_unavailable`), 去配置模型服务 (`/admin/extensions`). A stopped run's row names who stopped it. The run row replaces the stopped, failed and hook-denied dividers (no run is drawn twice); a running run shows nothing new (the live indicators stay). The properties panel's Context section adds the last run's line (model, duration, tokens; cost only when the log carries one, which it does not today).
- Extension slots, files and sub-agents: §6.16.16–§6.16.18, §6.16.15.
- **Loading** (`ConversationPage.loading`, `{ thread?, title?, rightArea? }`, per part; spec §7.1 of the web query cache design): every region keeps its box and the page announces once (§6.29). `thread`: the real thread column (`.cb-conv-scroll`, with its scrollbar gutter, and the thread at most `layout.chat` wide, items `space.3` apart) holds three turns: a user bubble's box (the bubble's padding and 1 px border, 45% of the thread, right-aligned) with a `prose` bar in it, then two `prose` bars, 100% and 70% wide; a `prose` slot is one `type.prose.line` high (§6.29). The composer always renders for real and keeps its box, stays mounted and focusable and its textarea stays editable (autofocus works); it cannot send while the thread loads (`composer` may be a function receiving `{ sendDisabled }`, which the page passes to the composer's `send.disabled`), and it stays mounted when the thread arrives, so a draft and its focus are never lost. `title`: the title bar keeps its path and every icon (properties toggle, panel icons); the title is a `body` bar in the title's own box, 30% of the bar wide, in place of the title menu. `rightArea`: an open right area draws its own loading state instead of `panel` / `properties`: the right panel's `loading` state (§6.16.18: the head with the open panel's title, which the caller gives as `rightArea: { title }` (default "右侧面板" / "Right panel"), and close, without the full-screen button, and the block's loading bars in the body) or the properties panel with its one always-present section loading (上下文 / Context; §6.16.17; the Files and extension sections exist only when the data holds something, so no placeholder stands in for them); a closed area stays closed. Nothing animates.

<!-- states: template-conversation -->
States: `properties`, `file-panel`, `subagent-panel`, `new`, `sheet`, `properties-sheet`, `loading`

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
| new-conversation-body | new | row-gap | space.4 |
| greeting-line | new | height | type.h1.line |
| agent-chip | new | height | control.prominent |
| quick-actions | new | width | control.default |
| sidebar | sheet | width | layout.sidebar-rail |
| right-panel | sheet | width | layout.panel |
| status-bar | sheet | height | layout.status-bar |
| sidebar | properties-sheet | width | layout.sidebar-rail |
| properties | properties-sheet | background-color | color.panel-2 |
| property-section | properties-sheet | padding-left | 0 |
| property-section | properties-sheet | padding-top | space.3 |
| property-section | properties-sheet | border-top-left-radius | 0 |
| title-bar | loading | height | layout.title-bar |
| thread | loading | max-width | layout.chat |
| right-panel | loading | width | 544 |
| skeleton-text[data-size=prose] | loading | height | type.prose.line |
| status-bar | loading | height | layout.status-bar |

### 5.6 Overview (T1)
- Order in the content column: PageHeader → StatCards (the header's `metrics`) → the page's sections (cards, lists): the first block sits `layout.head-content` (24) below the head (§4.2 "Head rhythm"), and the blocks are separated by `space.3`.
- **Loading** (`OverviewPage.loading`, `{ stats?, sections?, keep? }`): the header is its loading state (§4.2); `stats` stat cards (default 4) in the loaded card's box (the `panel` card with a `small` label slot over a `metric` value slot), unless the header's own `metrics` are given, which render for real; `sections` card-shaped blocks (default 2, as in §5.2) in place of `children`; a page whose content does not depend on the data (a note under the numbers) passes `keep`, and its `children` render as they are in place of the blocks (state `loading-keep`, against the loaded `keep`). One busy announcement (§6.29). Nothing animates.

<!-- states: template-overview -->
States: `default`, `loading`, `keep`, `loading-keep`

<!-- size-table: template-overview -->
| Part | State | Property | Value |
|---|---|---|---|
| content | default | max-width | layout.content |
| content | loading | max-width | layout.content |
| skeleton-text[data-size=small] | loading | height | type.small.line |
| skeleton-text[data-size=metric] | loading | height | type.metric.line |
| content | keep | max-width | layout.content |
| content | loading-keep | max-width | layout.content |

### 5.7 Inbox (T6)
- Rail (320, the list column; wider than a filter rail's 240): the filters above the list (`filters`, then `list`); content: the selected item; an optional inspector (400). A row leads with the item's display name (one line, the ellipsis on the name, the full text in `title`), its version beside the name in `CellTitle`'s `trailing` (never cut), and what kind of item it is on the second line; the list's column header is neutral (事项 / Item), since rows are requests and notices alike.
- **Loading** (`InboxPage.loading`, `{ rows?, inspector? }`): the header is its loading state (§4.2); the rail's `filters` stay real (they are static); the list is `rows` rows (default 4) in the object list's own container (§6.17: the same border, radius and first row) in the 64 px row: a 36 px mark and two text slots (a `body` one at 55%, a `small` one at 30%); `loading.list: "records"` (with `loading.table`: `label`, `columns`, `rowHeight`, `framed`) draws the DataTable's loading state (§6.6) in the caller's table shape instead, for the inbox pages whose list is a DataTable (`rowHeight="dense" framed={false}`); the content is one card-shaped block (§5.2) in place of `children`. A real `inspector` stays. A page whose loaded state opens its first item (the rail-inspector layout, an ActionRow for the decision) keeps both while loading: `inspector` (`true`, or `{ rows?, keyWidth? }` as in §5.2) draws KeyValue placeholders in the inspector column, and the page passes its `inspectorTitle` and its decision `actionRow` (the labels are static), which stays with its buttons disabled (as in §5.3). One busy announcement (§6.29). Nothing animates.

<!-- states: template-inbox -->
States: `default`, `loading`, `default-records`, `loading-records`

<!-- size-table: template-inbox -->
| Part | State | Property | Value |
|---|---|---|---|
| content | default | max-width | layout.content |
| content | loading | max-width | layout.content |
| content | default-records | max-width | layout.content |
| content | loading-records | max-width | layout.content |
| rail | default | width | 320 |
| rail | default-records | width | 320 |
| loading-row | loading | height | 64 |
| skeleton-box[data-box=mark] | loading | height | 36 |

### 5.8 Settings (T5)
- **Sections are stacked** (§5.3 "Stacked sections"): beside the sub-nav, each `FormSection` puts its head above its card at every width, so the content column starts with the section title right after the nav.
- **Loading** (`SettingsPage.loading`, `{ sections? }`): the header is its loading state (§4.2); the sub-nav is real (static per page) and so is the header's `description`; an ActionRow the page passes stays with its buttons disabled. `sections` (one entry per section: `fields`, and the `title` / `description` the page already knows) draws each section in the `FormSection` frame (§5.3) in place of `children`: a title the page does not know is an h2-sized slot (`SkeletonText` `heading`, 45%), a description it does not know a `body` slot (70%), then `fields` field placeholders (§5.3; a count or `FieldShape[]`). Without `sections` the children render as they are, each `FormSection` or list saying for itself whether it is loading. One busy announcement (§6.29). Nothing animates.
  - **Control groups** that are no `Field` have their own `FieldShape`s, each drawn in a `Stack` (gap 8) with an optional `help` line (`small`, 55%) under it, as a settings section draws a group and its hint: `radio-cards` is the card RadioGroup's own markup (`.cb-radios[data-variant=card]`, gap 8) with `options` cards (default 2), each the card's frame (padding `space.2` `space.3`, 1 px `line` border) holding a 14 px box slot and the text column's `body` label slot (30%) over its `small` description slot (70%); `key-value` is KeyValue's own `dl` with `rows` rows (default 3), a `body` slot in the `keyWidth` key column (default 8ch) and a 55% value slot; `switch` is a row (gap 12, centred) of a 32 × 20 box (the Switch) and a 64 px `body` slot (its state word). Two shapes stand beside the groups without a stack: `text` is one `body` slot (70%: a hint is `Text variant="prose"`, whose prose-small line is the body line), a hint line the section always shows; `item-group` is a `small` label slot (30%) over an `ItemList`'s own rows (`options` rows, default 2, split by `line-soft`), each a 30% `body` title slot over `rows` `small` slots (default 2) `space.1` apart, as a labelled list inside a form card (an extension's permissions): rows, never cards (§1). A loading slot that sits in a flex row (a card radio's text column, a card's title) takes the row's free width (`flex: 1`, `min-width: 0`), so its percentage bar is never 0 px wide. Static text the page shows beside a group (a read-only note, "applies to new sandboxes") renders for real through `help` only when the page knows it is shown. States `radio-cards` / `loading-radio-cards`.
  - **Items**: a section that lists items, each with its own lines and field (the model purposes: `/admin/models` 用途默认映射, `/settings/models`), is a `flush` FormSection holding one `ItemList inset="flush"` of `ItemListItem` rows (§6.33), never a card per item (§1). Its loading shape is `items: ItemShape[]` instead of `fields` (`FormSection.loading`, `SettingsPage.loading.sections[].items`): the flush card holds the flush ItemList's own `ul` and rows (padding `space.4`, split by `line-soft`), each row in the loaded row's own boxes: the title line (a 45% `body` title slot and `actions` button slots, 88 px wide, `control.default` high), then `lines` text slots (`lineSize` `body` or `small`; 70% then 55%) in the meta lines' box (`space.1` below the title line, `space.1` apart), then in the body's box (`space.3` below) the `field`'s placeholder, as a row that describes a setting and then edits it; or a gap-8 row of `buttons` button slots (88 px, `control.default`); or a labelled `list` (a `small` label slot and `list` `small` slots, gap 4). States `items` / `loading-items`.
  - **Cards on the page ground**: a page that is a stack of titled cards with no section around them (installed plugins) passes `loading.cards`: `ItemShape[]`, or `{ shape, count }` (one shape repeated, default 3), in a 16-gap stack as the loaded cards; each placeholder is the `Card` frame with the title line in its head and the body as an item row's. A card on the page ground is the one box, so this is allowed; inside a section the items are rows. States `cards` / `loading-cards`.
  - **List + editor**: a section that edits a list of named items next to the open item (the agent page's prompt files, §3.3 of the agent profile design) is a stacked `FormSection` (§5.3), so its card has the content's full width, and lays the card out as `Grid columns="list-detail"` (gap 16; one column below 640, §4.3): on the left a gap-8 stack of a rows `Repeater` (§6.26) whose rows each hold the item's name as a default-height button, and a `small` count line under it; on the right, with **no card** around them (§1), the open item's name as an `h3` (`Text variant="h3"`) over its fields, gap 12. The two columns are split by a `line-soft` column divider (`Grid columns="list-detail" divided`, the only grid that takes `divided`: the divider `space.4` from each column, running the row's full height; a row divider above the detail once the grid stacks below 640). Its loading shape is `{ control: "list-editor", options?, rows? }`: the same divided grid and stack, the Repeater's own list of `options` rows (default 1), each a `control.default` slot, its add button slot (`control.dense`, 88 px) and a `small` 70% count slot; and, in a gap-12 stack, a 45% `body` slot for the `h3` over a name field placeholder (an input with its help line) and a `rows`-line textarea placeholder with its help line (default 16).

<!-- states: template-settings -->
States: `default`, `loading`, `radio-cards`, `loading-radio-cards`, `cards`, `loading-cards`, `items`, `loading-items`

<!-- size-table: template-settings -->
| Part | State | Property | Value |
|---|---|---|---|
| content | default | max-width | layout.content |
| content | loading | max-width | layout.content |
| settings-nav | default | width | 200 |
| settings-nav | loading | width | 200 |
| skeleton-box[data-box=default] | loading | height | control.default |
| skeleton-text[data-size=heading] | loading | height | type.h2.line |
| content | radio-cards | max-width | layout.content |
| content | loading-radio-cards | max-width | layout.content |
| skeleton-text[data-size=small] | loading-radio-cards | height | type.small.line |
| content | cards | max-width | layout.content |
| content | loading-cards | max-width | layout.content |
| skeleton-box[data-box=default] | loading-cards | height | control.default |
| content | items | max-width | layout.content |
| item-list-row | items | padding-left | space.4 |
| item-list-row | items | padding-top | space.4 |
| item-list-body | items | margin-top | space.3 |
| content | loading-items | max-width | layout.content |
| loading-item-row | loading-items | padding-left | space.4 |
| skeleton-box[data-box=default] | loading-items | height | control.default |

### 5.9 Wizard (T9)
- **Loading** (`WizardPage.loading`, `{ fields }`, `{ content }` or `{ keep: true }`): the header is its loading state (§4.2); the step bar is real (the steps are static); the ActionRow stays with its buttons disabled; the step's body is one card (the `panel` card of §5.2 with a 30% `body` slot as its title) holding `fields` field placeholders (§5.3; a count or the page's static `FieldShape[]`) `space.4` apart, in place of `children`; a step whose body is no card (a review stack) passes `content` (`BlockShape[]`, §5.2) instead, drawn in a gap-16 stack (state `loading-content`, against the loaded `content`); a step that is its own `FormSection`s passes `keep`, and its `children` render as they are inside the page's one busy region, each section saying for itself whether it is loading (§5.3), so the static titles, descriptions and field layouts stay real and no section announces itself. One busy announcement (§6.29). Nothing animates.

<!-- states: template-wizard -->
States: `default`, `loading`, `content`, `loading-content`

<!-- size-table: template-wizard -->
| Part | State | Property | Value |
|---|---|---|---|
| content | default | max-width | layout.content |
| content | loading | max-width | layout.content |
| action-row | loading | height | layout.action-row |
| skeleton-box[data-box=default] | loading | height | control.default |
| content | content | max-width | layout.content |
| content | loading-content | max-width | layout.content |

### 5.10 Auth (T10)
- **Loading** (`AuthPage.loading`, `{ fields, subtitle?, note?, hint?, buttons? }`): the page keeps its frame: the two dither columns, the logo, the 400 px card with the title and subtitle the page knows (an empty `title` is an h1-sized bar; `subtitle: true` is a 70% `body` slot for a subtitle that comes with the data), and its `footer` and `preferences`. The card's body is `fields` field placeholders (§5.3; a count or the page's static `FieldShape[]`), then `note` (static content the page shows for real after the data, such as a warning card), then the card's buttons: a gap-8 stack of `buttons` `prominent` boxes (§2.5; default 1, the submit button), opened by `hint` (a static `prose` `muted` line the page shows above its buttons) when given; these parts are `space.4` apart, in place of `children`. One busy announcement (§6.29). Nothing animates.

<!-- states: template-auth -->
States: `default`, `loading`

<!-- size-table: template-auth -->
| Part | State | Property | Value |
|---|---|---|---|
| auth-card | default | width | 400 |
| auth-card | loading | width | 400 |
| skeleton-box[data-box=default] | loading | height | control.default |
| skeleton-box[data-box=prominent] | loading | height | control.prominent |

### 5.11 Trace (T8)
- Layout: Single in the content width (`layout.content`, §4.3): the stats (the header's `metrics` as StatCards, §5.6) in the head, then the span waterfall (§6.10) and the selected span's detail right after it; from 1280 the detail is a 400 px right panel inside the width with a `line-soft` left divider, both columns scrolling on their own, and the stats, waterfall and detail share one left edge.
- **Loading** (`TracePage.loading`, `{ spans?, stats? }`; spec §7.1 of the web query cache design): every region keeps its box and the page announces once (§6.29). The header is its loading state (§4.2); the stats are real when the header carries `metrics`, otherwise `stats` stat card placeholders (default 4: a `small` label slot over a `metric` value slot in the loaded card's box, §5.6); the waterfall is `spans` rows (default 6; a page that knows the count passes it) in the waterfall's own container and row box (28 px high, with its `line` bottom border, the name column 40%, the time track with its `line` left border, the status cell and the duration column), each with a `body` name bar (70% / 55% alternating) and a `body` duration bar filling its column; a loading row has no hover and no pointer; the detail is a card-shaped block (§5.2: the head band's 30% bar and three text bars) in the detail column's own box. Nothing animates.

<!-- states: template-trace -->
States: `default`, `loading`

<!-- size-table: template-trace -->
| Part | State | Property | Value |
|---|---|---|---|
| content | default | max-width | layout.content |
| content | loading | max-width | layout.content |
| skeleton-text[data-size=small] | loading | height | type.small.line |
| skeleton-text[data-size=metric] | loading | height | type.metric.line |
| skeleton-text[data-size=body] | loading | height | type.body.line |
| loading-span-row | loading | height | 28 |
| loading-card | loading | border-radius | radius.md |

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
- Disabled: `faint` text, `line-soft` border (a disabled ghost button too), transparent ground; a disabled primary gets the `selected` ground and weight 400; `cursor: not-allowed`. A disabled icon button draws its icon in `faint` (its enabled icon is already `muted`, so it must drop further to read as off), and when it is off for a reason the person cannot see (a Repeater's remove at its minimum, §6.26) its tooltip and accessible description say why.
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
- **Select** (maintainer decision R, 2026-11-07): the field looks like an input (the rules above, `chevron-down` 14 `muted` at its end) but is a button (`role="combobox"`, `aria-haspopup="listbox"`, `aria-expanded`; a `Field`'s `label[for]` names it) that opens the design system's own list, never the browser's popup: the composer's anchored menu (§6.16.3, the same code) as a `listbox` of `option`s (`aria-selected`), named like the field. It hangs `space.1` under the field (above it when the room below is short), its start edge on the field's, at least the field's width, its height `min(layout.menu-max-height, the live room on its side)`; the selected option has the `selected` ground and a `check` 14 at its end and is scrolled into view; a long label is cut with an ellipsis and whole in its tooltip. With more than ten options the menu's filter field heads it (focus starts there, the IME guard, typing on an option goes back to it, Space on an option picks it); otherwise focus starts on the selected option and typing jumps to the option it starts (typeahead). ↓, ↑, Enter and Space open it; the arrows move, Enter or Space picks (the change fires only for another option), Escape closes and focus returns to the field; Tab (Shift+Tab) closes it without a change and moves the focus on to the next (previous) field, as a native select (the list does not trap Tab). A click on its label focuses the field without opening it. The field is as wide as its widest option (every label sits in it, only the current one shown) and cuts the current one with an ellipsis when narrower; a value matching no option shows the `placeholder` in `faint`. Disabled: the input's disabled look, it never opens. In a form it carries a hidden native copy (`name`, `required`, `form`) so the form submits and validates it; the copy is hidden from assistive tech and never focused (a failed validation sends the focus to the field).
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

<!-- states: select -->
States: `default`, `placeholder`, `open`, `long`, `disabled`, `error`

<!-- size-table: select -->
| Part | State | Property | Value |
|---|---|---|---|
| select | default | height | control.default |
| select | default | border-radius | radius.sm |
| select | default | border-top-color | color.line |
| input-control | default | padding-left | space.2 |
| input-control | default | font-size | type.body |
| input-control | default | color | color.ink |
| select-label[data-placeholder=true] | placeholder | color | color.faint |
| select | open | border-top-color | color.accent |
| menu | open | background-color | color.panel |
| menu | open | border-top-color | color.line-strong |
| menu | open | border-radius | radius.md |
| menu-item | open | height | row.default |
| menu-item | open | padding-left | pad.default.x |
| menu-item[aria-selected=true] | open | background-color | color.selected |
| menu | long | max-height | layout.menu-max-height |
| menu-filter | long | height | control.dense |
| menu-filter | long | font-size | type.small |
| menu-item | long | height | row.default |
| select | disabled | background-color | color.hover |
| select | disabled | border-top-color | color.line |
| select | disabled | color | color.disabled |
| select | error | border-top-color | color.fail |

### 6.3 Checkbox / Radio / Switch / option card
- Checkbox and radio are 14×14 with radius `sm` (radio round). Checkbox checked: `accent` ground + `on-accent` `check` icon; indeterminate `minus`. Radio checked: `accent` border + a 6×6 `accent` inner dot.
- Switch: a `space.7` × `space.5` (32 × 20) track with radius `bubble` and 2px padding, a `space.4` (16) round knob; off: `line` track + `muted` knob; on: `accent` track + `on-accent` knob moved right by `space.3`; the knob moves over `motion.hover`. Where a switch stands alone its label and current state ("On" / "Off", muted) are shown as text next to it, so the state never relies on color: `SwitchField` draws that row, `control.default` high with `space.2` gaps (clicking the label toggles too).
- Switch list (`SwitchList`, a form's tools and similar lists): one `row.roomy` row per item with the name and a `small` prose `muted` description (each one line with an ellipsis), `muted` `small` meta text (such as the policy) and the switch; padding `space.4`, rows divided by `line-soft`; it sits in a `flush` FormSection card.
- Option card (rich option of a single choice): 1px `line` border, radius `md`; selected: `line-strong` border + `selected` ground (neutral, §2.3), the radio dot in `accent`. Option cards are the one allowed card inside a box (§1): a choice drawn as cards on purpose (the org 沙箱 page's 直接执行 / 需要审批 inside its form card).

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
- Segmented: one `line` border around the group, radius `sm`, height `control.<step>`, 2px inner padding and gap; each segment has radius `sm` and padding `space.2`, `muted` text; the selected segment gets the `selected` ground + `ink` text (no accent). A label stays on one line: one that does not fit its segment (a `fill` group in a narrow column) is cut with an ellipsis, never wrapped; copy is written to fit (en "Needs me", not "Waiting for me").
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
- KeyValue: a key-value list (a detail page's facts block, the inbox inspector's property groups, detail sections); key muted with a fixed 8ch width, value single line with ellipsis. `columns={2}` (an overview card's figures, an extension's facts) flows the pairs into two columns: keys at their natural width, each value `space.3` after its key, the second column `space.7` (32 px) after the first, so a value never reads as part of the next label; one column below 640.
- Disclosure: an expandable block (a skill body, a license text). Its body's 1px `line` guide on the left, indented `space.2`, is also how a `Subsection` (§6.32) sets a nested group apart inside a box. The summary line is the toggle button (`aria-expanded`, `aria-controls`, a `faint` `chevron-right` / `chevron-down` icon (12) on the right, `hover` ground, same row style as ThinkingRow); closed by default (`defaultOpen` opens it); once open, the body follows `space.1` below under a 1px `line` guide on the left, indented `space.2`. The body is rendered only while open. Not in the reference set: no state list or size table yet (like KeyValue).
- Metrics on list pages are StatCards (§6.14).
- TextLink: an in-site text link drawn through the DesignProvider's `link` (§6.7 Links): `ink` text, a `line-strong` underline offset 3px that turns `ink` on hover, the accent focus ring; visited links keep `ink`. Pages never show the browser's link colors.
- LinkCard: a card that leads to another page (on the page ground only, §1) (not used by the admin overview any more: its numbers link to their pages, §6.14, and the sidebar leads to the rest): `panel` ground, radius `md`, padding `space.4`, `space.2` apart: the title (`body`, 500), a `prose-small` `muted` description, and one TextLink with a `faint` `chevron-right` (12). Not in the reference set (like KeyValue).

### 6.6 DataTable
Structure, top to bottom: toolbar / bulk action bar → the table (header and rows on the `panel` ground, **square, no border**) → pagination. The toolbar and pagination sit on the page ground outside the panel.

- **Framed or not** (§1 "One box is enough"): `framed` defaults to the place. On the page ground and in a pane (RightPanel) the table sits on its `panel` ground; inside a box (a Card, a form card, a Dialog or Sheet, an inline card, a property section) it is unframed by itself, with no ground of its own (it takes the box's ground for its sticky header: `panel`, or `raised` in an inline card). An explicit `framed` wins. A table inside a form section goes in a `flush` FormSection, so it runs to the card's edges (its cells keep the `space.3` edge padding), as an only-child unframed table does in a Card body. Several tables in one card (one per model provider) are flush `Subsection`s (§6.32): each an `h3` heading row padded `space.3` over its table, the subsections split by `line-soft`. A table in a padded form card is a `web-ui-box-in-box` finding (§9.1).

- **Density**: the rows (row menus, inline controls) and the pagination are `dense` (`DensityContext` around the body); the toolbar, the bulk action bar and the empty-state actions are `default`, as the signed reference draws them, so the toolbar has the height of the page's other controls.
- Toolbar: search (240 wide, `search` icon prefix, `/` focuses), filter chips (§6.15), clear all; at the right end (`toolbarEnd`, right-aligned as the signed reference) sort, view switch, column settings. It has the same height as the bulk action bar so nothing jumps when one replaces the other in place.
- Bulk action bar: when ≥1 row is checked it **replaces the toolbar in place**, `panel` ground, radius `sm`, left "N selected" (600) + bulk actions, right "Deselect Esc". An accent border or ground must not be used.
- Header: `row.dense` high, padding `space.2`, `small` `muted`, weight 400; the column being sorted is `ink` + `arrow-down` / `arrow-up`; a sortable column shows `arrow-up-down` and a `hover` ground on hover.
- Name cell of a roomy row: `CellTitle` (an optional initial tile, `control.dense` square on `selected` with radius `sm`, holding the plugin's icon instead when `image` is given for a thing a plugin brings, the initial again when it fails to load, §6.17; then the name and a `small` prose `muted` description, each one line with an ellipsis; `mono` draws a description that is an id or a version, `plugin · v1.0.0`, in mono instead of prose; `trailing` puts a short mono label such as a version after the name on its line, `small` `faint`, which never takes the ellipsis: the name does). A row is named by its first cell (the row checkbox reads "Select {name}"): a plain-text cell, or the `title` of a `CellTitle`; `rowLabel` overrides it.
- Rows: height by `rowHeight`: `dense` 28, `default` 32, `roomy` 44 (two lines: name + a `small` prose description, or a thumbnail). Cell padding `space.2` horizontally, the first and last columns `space.3` toward the edge. Row dividers are 1px `line-soft` above each row; no outer border. Success in a status column has no mark (§2.4).
- Alignment: numbers, durations and amounts are right-aligned; IDs and times are left-aligned; IDs and times use `muted`. An overlong single line is truncated with an ellipsis and the full text is shown on hover with a native `title`. A column marked `wrap` (a short list that must stay readable, such as a model's capabilities 「工具 · 图片 · 推理」) wraps onto more lines instead, never an ellipsis: the row grows, the extra lines get `space.1` above and below; names and ids never wrap. A wrap cell given a list of strings draws them joined by 「 · 」, each item with its separator as one no-break unit, so lines break only between items (never inside 「缓存」, never before a 「·」). A column marked `fit` (a short id, a version, a relative time) is as wide as its content and never truncated, so a `wrap` column beside it takes the rest of the row (an extension's replicas: 副本, 状态 and 心跳 fit, 原因 wraps).
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
  - Empty (first time): the compact EmptyState (§6.18) centered horizontally in the area: no art (a table's area is the one-line case; every table draws it the same, an extension's table block too), one `ink` sentence (+ an optional `muted` hint) and the next action (`default`), `space.8` padding above and below (the page rhythm, not pinned to the top-left corner).
  - The empty states and the skeleton rows keep a row cell's horizontal padding: `space.3` at the first-column edge (left) and `space.2` on the right, as the signed reference draws its full-width cell, so their centered content sits 2px right of the panel's middle.
  - No results (caused by filters): the compact EmptyState, centered the same way, "No matching results", a description of the current filters and "Clear filters".
  - Error: `circle-x` + "Failed to load" in `fail`, the error code · request ID (muted) + "Retry" (`refresh`).
- **Narrow (below 640): stacked rows.** Every table becomes stacked rows; it is the table's own behaviour, no page opts in. The header row is hidden from sight (also above an empty state) but stays for screen readers: every table element carries its explicit role (`table`, `rowgroup`, `row`, `columnheader`, `cell`), because the stacked display drops the implicit table semantics in WebKit, and the hidden header holds plain text, no controls. What the header did moves to a compact bar above the rows, drawn only when there is something to do: a 全选 checkbox (with row selection) and a 排序 select listing each sortable column both ways (「名称 升序」, 「名称 降序」). Each row is a card, `space.2` padding above and below, a `line-soft` line between rows: the first column's cell is its title line (500, at least `row.dense` high), with the row checkbox before it and the row menu after it on the same line; every other cell is one `label value` line, the label being the column header (`small` `muted`, 10ch, one line with an ellipsis; a column without a header has no label) and the value one line with an ellipsis (the full text in `title`). Cells keep the `space.3` edge padding. Nothing sticks; the selected row keeps its 2px accent bar on the card's left; the row-menu button is a 40 px square (tap target). The toolbar wraps and its search takes the full width.
- Inline controls: a column marked `interactive` holds its own control (the 扩展 pages' enable switch); a click inside it works the control and never opens the row (`onOpen`), like the checkbox and the row menu.
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

- **Dialog**: width 480 / 640 (the agent map's tree is as wide as its tree, from its levels 2 and 3's width up to 1100, and those levels the conversation's column plus the body padding, §6.16.28), `panel` background + `line-strong` border + radius `md` + `shadow-2` + `scrim`. Header (h2 title + close `x`) / body (padding 16) / footer (right-aligned: ghost Cancel + primary action, the primary action carries `↵`), with 1px `line` separating header and footer. Esc closes; focus is trapped and returned after closing. Default focus: on the first field for a dialog that asks for input (新建组织, 新建令牌), else on the primary action (a `LinkButton` primary too); on Cancel for a dangerous dialog. A create dialog's primary is disabled until it is valid. A dialog that only explains why something cannot be done (退出组织 as the only owner) is not dangerous: plain title, one default button "知道了" / "Got it", and a link to where it can be fixed. A dialog whose next step lives elsewhere (加入评测集 with no eval set) says so and offers that step as its primary (`LinkButton`), never a disabled dead end.
- **Dangerous confirmation**: the ordinary frame and title (`line-strong`, `ink`): the red is only on the destructive button; explains the consequences and recoverability; the object name must be typed, the confirm button is disabled until it matches, and is danger-solid once it matches. A caller that must read something first (what a delete does, ruling P3-19) passes `confirmDisabled`: the button then stays disabled and `danger` while the read is pending or failed, even with the name typed.
- **Sheet**: slides out from the right, width 480 / 720, `panel` background + `line-strong` left line + `shadow-sheet`; no scrim by default (the list is still operable). Header: an optional 28 px mark (`mark`: the plugin's icon of an extension, else its initial, §6.17) + name + version + open in a new page `external-link` + close `x`; may contain Tabs; footer: actions, a bar under a `line-soft` hairline that stays at the bottom while the body scrolls (a form's save goes there, never into the body; the primary save is enabled only while there are changes). Closing with unsaved changes needs a second confirmation. A body with several kinds of content groups them into titled regions, `Subsection variant="divided"` (§6.32): one optional status line on top (no title), then the regions split by hairlines (the extension Sheets: 部署配置 or 组织配置, 状态, 副本, 权限); a region with nothing to show is left out.
- **Inside an overlay** (§1 "One box is enough"): a Dialog or a Sheet is the box. Its body groups with `ContentSection` headings (§6.31), `Subsection`s (§6.32) and hairline-divided `ItemList` rows (§6.33), never Cards or FormSections; a confirmation that previews a change's consequences draws them with `ImpactPreview` (§6.35); tables, code blocks and repeaters inside draw their unboxed forms by themselves. Choosing between sources in a dialog is a card `RadioGroup` straight in the body (no Card around it), and its one `FilePicker` drop zone is allowed (§6.25).
- **Links**: the design package is framework-agnostic; links in the sidebar navigation, the PageHeader path, Tabs, Sheet, TextLink and LinkCard are rendered through the `link` component of `DesignProvider` (default `<a>`); `apps/web` passes next-intl's `Link` to get client-side navigation and the locale prefix. Pages should not build `<a href>` themselves for in-site navigation.
- **Popover / Menu**: `panel` background + `line-strong` border + radius `md` + `shadow-1`; it keeps 8 px from the viewport's edges (collision padding) and, opening below or above its trigger, is at least as wide as the trigger (the org switcher, the account row; a flyout to the side keeps its own width); menu items are `row.default` high with padding `pad.default.x`, optionally led by a 16 px `muted` icon (a navigation menu's items carry the main nav's icons); an item may carry a description after its label (`small`, `muted`, one line with an ellipsis; a Repeater preset's help); the current choice of a single-choice set (the current org, the language) is an ordinary item in `ink` with a `check`, never drawn disabled; a filter Popover has a search `>` at the top and "Clear / Apply ↵" at the bottom; a hovered item gets a `hover` background. Destructive (`danger`) items go last, after a separator; a menu never draws an empty group: no separator leads, trails or follows another, so a menu whose only item is destructive (an object row's ⋯ → 停用) has no line above it. The trigger button is outlined in the accent color when open and holding a value.
- **No menu of one**: an overflow menu (`more-horizontal` in a page head or an object row, More on the conversation title bar) is drawn only when it holds two or more actions a person can take, or one destructive one (separators and disabled items don't count). With none it is not drawn; with one safe action, that action is drawn directly in its place (a button or link). A destructive (`danger`) action is never promoted out of its menu: a menu whose only action is dangerous stays a `more-horizontal` menu with that one item. A table's row menu keeps its column, so a row with one action keeps `⋯`, and a row with none shows no button (§6.6). Never list an action twice on one screen (a menu item that repeats a visible button, the name link or a sidebar entry).
- **Command palette (⌘K)**: width 560, input with a `>` prefix; group titles small faint; the current item has the `selected` background + a 1px `line-strong` outline (neutral, §2.3); key hints at the bottom. An empty list says why in one `muted` sentence (`emptyText`; default 「没有匹配」) and may offer the next step under it as a text link (`emptyAction`, which closes the palette as it navigates): the composer's `/` menu on an agent with no invocable skills explains that an org skill must be selected on the agent and links someone who can edit the agent to its skills section.
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
- **Toast**: top center, 16px (`space.4`) below the top of the content area (there is no TopBar, §4), stacked downward with the newest on top (errors, which stay until closed, above the rest); centered rather than top right so it never covers the PageHeader's actions (the primary button sits top right); 360px wide, and below 640px it spans the width with a 16px gutter. `panel` background + `line-strong` border + radius `md` + `shadow-1`, no status-color bar: a leading 16px status icon carries the status, so it never relies on color alone (success `circle-check` in `ok`, error `circle-alert` in `fail`, progress `spinner` in accent), together with the error's `role="alert"` and the `role="status"` live region of the others. Success auto-dismisses after 4s, or after 8s when it carries an undo ("撤销" / "Undo", no arrow; a Repeater's remove, §6.26); an error must be dismissed manually and may carry "View →"; every toast has a close button; a progress type carries a segmented progress bar under its message. A name in a toast message is quoted: corner quotes in zh (已启用「待办清单」。), straight double quotes in en (`Enabled "Todo".`), §7 "Copy".

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
- **CodeBlock**: 1px `line` frame, `panel` background; when there is a language, an 11px `faint` language label at the top + a bottom line; body monospace, no wrapping, horizontal scrolling inside the frame; no syntax highlighting. **Inside a box** (a Card body, a form card, a Dialog or Sheet, an inline card, a property section; §1) it draws its borderless form by itself, as a DataTable is unframed there: no line, a `panel-2` tint, radius `sm`, the language label split from the code by spacing alone (no bottom line). An explicit `framed` wins (`framed` forces the frame, which inside a box is a `web-ui-box-in-box` finding). A diff is a CodeBlock (`language="diff"`), so a file diff in a review card follows the same rule. **With a title or a copy button** (`title`, `copyable`; a setup guide's template file, plugin setup guides spec `2026-11-08-plugin-setup-guides-design.md` §5) the head is one row, min height 28, padded 2 / 4 / 2 / 8: the title in `muted` `small` at the left (one line, ellipsis), the language label in `faint` micro and a dense ghost 复制 button (`copy` icon) at the right; the bottom line as above, none inside a box. Copying writes `text` to the clipboard and the button reads 已复制 (`check` icon, `data-state="copied"` on the block) for two seconds; without a usable clipboard the code is selected and the button reads 「已选中，请按 Ctrl+C（⌘C）复制」.
- **InstructionList**: numbered steps a person follows outside the product (a plugin's setup guide, plugin setup guides spec `2026-11-08-plugin-setup-guides-design.md` §5), an `ol` with `space.2` between steps: each step's number in `faint` mono `small`, right-aligned in 2ch, `space.3` before the text in the prose font at `prose-small`. The text is plain: a backtick pair is inline code (the rendered Markdown's inline code, §6.16), nothing else is markup (no HTML, no links). Unlike StepList (§6.12) a step has no done / to-do state.
- **EmbedFrame**: the **only** component in the UI that renders an iframe (`apps/web` must not write an iframe itself). `sandbox` is fixed to `allow-scripts allow-forms` (never containing `allow-same-origin`), `referrerpolicy="no-referrer"`, `title` is required; width fills, height comes from props (default 360); 1px `line` border, `panel` background. **Inside a box** (an inline card, a property section, a Card; §1, §6.16.16) the box is its frame: no border and no ground of its own (`framed` overrides). Only `message` events whose `event.source` is this iframe are passed to `onMessage` (the caller parses and validates the content), and the iframe is exposed through `frameRef` for `postMessage`.
- **ImageBlock**: an image in a plugin view; block-level, width not exceeding the container, scaled proportionally, 1px `line` border; `loading="lazy"`, `referrerpolicy="no-referrer"`. It takes only an address and alt; it renders only absolute http(s) addresses, and anything else (`javascript:`, `data:`, relative paths) renders nothing.
- **AttachmentChip** (its looks are superseded by the attachment strip of §6.16.21; the behavior below stays): an uploaded file waiting to be sent in the input box. A line with a 1px `line` border and `panel` background: file name (single line with ellipsis, at most 24ch) + size (small `muted`, `B` / `KB` / `MB`) + a remove button on the right (an `x` icon button, `aria-label` "Remove <file name>"). Three states (`data-status`): `uploading` shows a 4px segmented progress bar under the name (`role="progressbar"`, `aria-valuenow` 0–100, completed segments accent, the rest `line-strong`, consistent with the Toast progress); `ready` has no progress bar; `error` has a `fail` border and small `fail` error text under the name (`role="alert"`), and can still be removed; when the caller supplies a retry, an extra `refresh` icon button appears to the left of the remove button ("Retry <file name>").
- **FileDrop**: a drag-and-drop / paste area wrapping the input area. When content carrying files is dragged in (only `Files` is recognized; dragging text does not respond) an overlay covers the area: `accent-tint` background + 1px dashed `accent` border, with one centered line of hint text (passed in by the caller); dropping hands the files to `onFiles`. Pasting a clipboard containing files inside the area also hands them to `onFiles`; when the clipboard has no text, the default paste is prevented, while if it also has text (such as copied from a document) the text is pasted as usual; a paste without files is unaffected. The overlay is always dismissed on drop and dragend. When `disabled` neither responds. `dragging` can force the overlay to show (for the catalog page and screenshots).
- **FileButton**: a file-picking button. It looks like `IconButton` (default `+`, `aria-label` passed in by the caller); clicking opens the system file picker (a hidden `input type=file`, with `accept` / `multiple` settable), and after selection the files are handed to `onFiles` and the input is cleared so the same file can be chosen again.
- **AttachmentPreview**: an attachment in a message. `kind="image"` is a thumbnail: at most 240×160, cropped proportionally to fill (`object-fit: cover`), 1px `line` border, `loading="lazy"`, `referrerpolicy="no-referrer"`; `kind="file"` is a file card: 1px `line` border, `panel` background, `file` `muted` on the left, file name (single line with ellipsis) + small `muted` description below (such as the type). Both are links that open in a new tab (`target="_blank"`, `rel="noopener noreferrer"`), with a `line-strong` border on hover. Addresses accept only absolute http(s) addresses and same-origin absolute paths: a raw string containing any ASCII control character, whitespace or `\` is rejected outright (browsers strip tabs / newlines, so `/\t/evil` would become `//evil`), and one starting with `/` is resolved against a placeholder origin whose origin must stay unchanged; anything else (`javascript:`, `data:`, protocol-relative addresses, relative paths) renders no link and no image, and shows only the file name. When an image fails to load, `onImageError` is called; when `retry` is greater than 0 the image address gets the cache parameter `retry=<n>` and reloads (the link is unchanged); when `onOpen` is given, an unmodified left click is handed to the caller to open.
- **Card `tone="accent"`**: superseded on the conversation page by §6.16.11–§6.16.13, where only the pending approval keeps the `accent` outline (the question and connect cards use `line`).
- **Card** (§2.5): the `panel` ground, a 1px `line-card` hairline, radius `md`, a head band (`space.2` `space.4`, 500, a `line-soft` rule) over a `space.4` body. It is a box, so it stands on the page ground (or in a pane) and **never inside another box** (§1): a group inside a box is a `Subsection` (§6.32), a list of things is `ItemList` rows (§6.33); a plugin view's blocks inside an inline card or a property section are drawn without frames of their own.
- Charts keep using `BarChart` / `Sparkline` from §6.8, property lists keep using `KeyValue`, and tables keep using DataTable; none is reinvented.

### 6.10 Span waterfall (SpanWaterfall)

The waterfall above the trace viewer (T8): the spans of the runs in one conversation laid out by hierarchy and time. It takes only plain props (`spans`, `selectedId`, `onSelect`, `labels.empty`, optional `labels.kinds`, optional `label`); span hierarchy is given by `parentId`, and the caller passes them in depth-first order.

- Span fields: `kind` (`run` / `step` / `model` / `tool` / `wait`), `label`, `startMs` (offset relative to the earliest span), `durationMs` (null if unknown), `status` (`ok` / `error` / `pending`), optional `meta` (such as the token count).
- Each span is one row (height 28), from left to right: name column (fixed 40%: indented 16 per depth level, a `kind` badge (text defaults to the design i18n: Run / Step / Model / Tool / Wait in zh, run / step / model / tool / wait in en; overridable through `labels.kinds`) 11px `faint` with a fixed width of 5ch + name single line with ellipsis + `meta` small `muted`) ｜ time track (1px `line` left line; the bar is positioned by `startMs / total duration` and sized by `durationMs / total duration`, minimum 2px) ｜ status (`StatusMark`: ok succeeded, error failed, pending running; a `wait` that has not ended is pending approval) ｜ duration (right-aligned, `6.8s` / `312ms` / `00:02:18`, `—` if unknown).
- Bar colors: ok `line-strong`; error `fail`; pending `accent` (something is happening, an extension of the §2.3 "text" role), and a span that has not ended extends from its start to the end of the time track. A `wait` bar is a 1px outlined hollow bar (waiting is not execution).
- Total duration = the maximum over spans of `startMs + (durationMs ?? 0)` (at least 1ms).
- Interaction: `role="tree"` (`aria-label` taken from `label`, default "Span waterfall"; always expanded, cannot be collapsed), each row `role="treeitem"`, with `aria-selected`, `aria-level` (depth + 1), and a row with child spans has `aria-expanded="true"`; focus stays on the tree, and the current item is indicated by `aria-activedescendant`. Clicking a row selects it; once focused, ↑ / ↓ select the previous / next, and Home / End select the first / last. The selected row gets the `selected` background + a 2px `ink` bar on the left (neutral, §2.3).
- Empty: `labels.empty` as the panel EmptyState (§6.18), centered in the waterfall's pane.

---

### 6.11 Interaction

The interaction rules are part of the spec and are covered by Playwright interaction tests (§9.5).

- **Hover**: grounds transition `background-color` over `motion.hover` (120ms); borders and text color transition with them. Pressed states are instant.
- **Expand / collapse**: groups (sidebar conversation groups, tool groups, expandable rows) animate their height over `motion.expand` (160ms); the toggle is a `button` with `aria-expanded`, and its chevron (`chevron-down` expanded / `chevron-right` collapsed) changes with it.
- **Overlays** fade in with a 4px offset over `motion.overlay`; Esc closes the topmost overlay; focus is trapped while open and returned to the trigger after closing.
- **Skip link**: the AppShell's first tab stop is a "Skip to main content" link (visually hidden until focused, then a `panel` chip at the top left) that moves focus to `main`.
- **Sidebar keyboard**: Tab enters the nav list at the current item and the conversation list at the active conversation (one roving tab stop per list); ↑ / ↓ move between nav items and between conversation rows; Home / End go to the first / last; ↵ follows the link; Enter / Space on a group label toggles the group (`aria-expanded`); Esc closes the drawer and returns focus to the menu button.
- **Composer keys** (§6.16.2): ↵ sends; while a run is going (or waits for a person) the message is an **interjection**, logged at once and taken in by the run at its next step (run input spec `docs/superpowers/specs/2026-11-07-run-input-and-live-drafts-design.md` D1); ⌘↵ (Ctrl+↵ off macOS) sends exactly like ↵ (D2); Shift+↵ is a newline; Esc closes the open picker menu, then the right-panel Sheet, and never stops a run (Stop stays on its button).
- **No queue** (run input spec D1, D3): nothing is queued any more. Until the run takes an interjection in, it stands at the bottom of the thread as a pending user bubble (§6.16.6, 待处理); the timeline then places it before the step that took it in. Messages an older version queued (leftovers the kernel still sends one per run after the turn) show the same way after the thread, with no actions, until the log holds them; leftovers a failed or stopped run paused keep the paused line and "Continue sending" of §6.16.14, the only way they drain.
- **Conversation toggles**: tool lines, tool groups, tool rows, thinking rows and sub-agent rows are `button`s with `aria-expanded` and open over `motion.expand`.
- **Right panel**: the resize handle on its left edge is focusable (`role="separator"`, `aria-orientation="vertical"`, `aria-valuenow` the width): ← / → change the width by 16px, Home / End go to the minimum / maximum. The open panel's title-bar icon has `aria-pressed="true"`; opening another panel replaces it, its close button or the pressed icon closes it, and focus returns to the icon. Switching conversation closes the panel and drops the old conversation's panel, files, uploads and pending messages.
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
  3. **Navigation** (`nav` labelled "Main navigation", gap 2): 新会话 (`plus`), then the primary items 智能体 (`agent`) · 技能 (`skills`) · 连接器 (`connector`) (acceptance 2026-11-07). There is **no home item**: the new conversation is the workspace's home, so 新会话 is the current item (`activeNav: "new"`, `aria-current="page"`, the `sidebar-active` ground) on the new conversation `/` (the old `/chat` redirects there); on a conversation `/chat/<id>` no nav item is current (its row is). 技能 is for members up (guests see 新会话 · 智能体 · 连接器); hiding is cosmetic, the kernel decides.
  4. **更多** (`more-toggle`, `more-horizontal` + label + a `chevron-right` 12, `muted`): a button opening a **flyout menu to the right of the sidebar** (the design `Menu` with `side="right"`, anchored to the row, `space.3` past the sidebar's edge): 插件, 扩展, 渠道, 评测与运行, 组织设置 (插件, 扩展 and 组织设置 for members up, 渠道 and 评测与运行 for org admins only; hiding is cosmetic, the kernel decides; the row is drawn only when it has something to list, so a guest without extension pages has none), then, after a separator, the org's extension pages; every item is led by its nav icon, as in the main nav. The row takes the `sidebar-active` ground and `ink` (`data-active`) while the current page is one of its items, and that item is marked current inside the flyout (`aria-current="page"`, `selected` ground). Enter, Space and → open it; Escape closes it and returns focus to the row. Nothing is remembered and it never opens by itself. **In the drawer** (maintainer decision 2026-11-09) 更多 is a disclosure instead of a flyout (a flyout would land over the scrim and past the screen's edge): the row is a button with `aria-expanded` / `aria-controls`, its chevron turns down (90°) while open, and its items are listed in place under it, in a `group` named 更多, one level in (indented by the icon and its gap; the extension pages after a `line-soft` rule), each a nav link that closes the drawer like the others. It opens expanded when the current page is one of its items (the item marked current), collapsed otherwise.
  5. **Conversations** (`section` labelled "会话"): take the rest of the height and scroll on their own, after a `line-soft` divider (inset by the sidebar's padding, like the account row's) and `space.2`. The scroll box runs out over the sidebar's `space.2` side padding to its edges and pads its content back by `space.2`, so the rows keep their place and the scrollbar sits flush on the right border, never over the rows' ends. See below.
  6. **管理后台** (`admin-entry`, super admins only, `context.adminHref`): `admin` icon (a shield), the label and an outward `arrow-up-right` 14, `muted`, directly above the account row; it enters the admin context.
  7. **Account row** (`account`): a `line-soft` divider with `space.2` above (the block gap) and below; a 24 round initial avatar on `selected` (the name's first grapheme) + the name (no org: the switcher shows it), opening the account menu (语言 ▸, 个人设置, sign out; no org entry, the switcher owns it); its accessible name is "账户: {name}". After it, in the same row, `ThemeToggle` (light / dark icon radio, the chosen one on `selected`). The rail has no room for it, so there the theme leads the account menu ("Theme: Light"). Menu items may open a submenu (`submenu`: a `chevron-right` mark, opens on hover, click or the right arrow). The auth pages (`AuthPage`) show `PreferenceBar` (a dense language `Select` and the `ThemeToggle`) in the bottom-right corner, `space.4` (16) inside the right dither column (16 from the edge below 640, where the columns are hidden), each control at its own width. The language is a cookie (`NEXT_LOCALE`), never part of the URL.
- **Admin context**, top to bottom: the brand row; the **context block** (`context-block`): the switcher's size and light style but static (no chevrons): a shield in the accent tint (`accent-tint` ground, `accent` icon), "管理后台" and `整个部署 · /admin` in mono; below it a link "← 回到工作区 ~/<slug>" (`back`, `row.dense`, `small` `muted`, `arrow-left` 14); the items 概览, 账号, 组织, 插件 (its count: what waits in its 待确认 tab), 扩展, 模型, 部署设置; no conversations, no 新会话, no search or inbox buttons (⌘K still opens the palette); the account row.

- **Setup context** (`kind: "setup"`, web-SSR spec §4), top to bottom: the brand row without the search and inbox buttons; the org switcher (`context.org`, as in the workspace); the navigation (`nav` "Main navigation"): **开始之前** (`nav-item`, `diamond`, the setup home `context.home`, current when `activeNav` is `home`), then the required steps, then the label **可以稍后再做** (`step-group-label`, mono `micro` `faint`, letter-spacing 0.06em, `row.dense` high with the text at its bottom; the optional steps form a `group` it names), then the optional steps; the fill; the admin entry (`context.adminHref`); the account row. No conversations, no 新会话, no command palette. A **step item** (`step-item`, `SetupStep { id, label, state, href?, reason?, optional? }`) has the nav item's box and a state mark (`step-mark`, an `Icon` 16, never a character): `done` a `check` in `ok` (still a link), `todo` a `circle` in `muted` (a link), `waiting` a `clock` in `muted`: not a link (`role="link"`, `aria-disabled="true"`, the label `muted`, no hover ground, still a roving stop so its reason can be read) with `reason` as its second line (`step-reason`, `micro` `muted`, one line with an ellipsis), which makes the item 48 high. The current step takes the nav item's current style. Its accessible name is "{label}，{state}" (已完成 / 未完成, or the reason of a waiting step; en "{label}, {state}"). In the rail the steps are their marks alone (`row.default` squares) with the accessible name in the Tooltip to the right; the group label becomes a `line-soft` divider (`step-divider`, 24 × 1). The drawer is the full setup sidebar.
- **Pending navigation**: every design link (nav items, steps, the admin entry, the back link, conversation rows; object rows, item lists, tabs, breadcrumbs, the settings navigation) renders `LinkPendingMark` as its last child. It calls the `DesignProvider`'s `useLinkPending` (apps/web: `() => useLinkStatus().pending` from next/link, so it must sit inside the link) and, while that navigation is pending, carries `data-pending` and draws a 2 px `accent` underline along the link's bottom that sweeps left to right in `motion.cursor` (reduced motion: a still underline). Without the hook nothing is ever pending. The reference block `sidebar-pending` is the setup sidebar with one step's navigation pending.

  `ItemList` (§6.33: rows of a tag, a linked title with a muted meta line, a status and actions, split by `line-soft`; an empty list shows its muted empty text) lists things inside a Card (the org chooser), and the setup layout (§5.5) uses `StepList inset="card"` (the checklist OnboardingPage centers, filling a Card) until a model and an agent exist. A `StepList` row is the state mark (top-aligned), the label over a `small` `muted` description, and **one** thing at the right, centered with the row: 已完成 / Done (`small` `muted`) when done, else the step's `action` (the button this viewer can use, or the `small` `muted` reason it waits). There is no 待办 / To do label (a hidden one for screen readers when a step has neither) and never a disabled button next to its reason.
- **Nav items**: `row.default` high, radius `sm`, padding `pad.dense.x`, icon 16 + label (`body`, `ink`, single line with an ellipsis). The current item gets the `sidebar-active` ground, `ink` and weight 600 (§2.3); hover the `hover` ground. An item may still carry a count (`nav-count`, an `accent` pill, 18 high, radius 9, mono `micro`, `on-accent`; `99+` above 99, `n+` when truncated, the accessible name includes it); the inbox, the one item that had one, is now the brand row's button.
- **Conversation section**:
  - A header: the label `会话` (mono `micro` `faint`, letter-spacing 0.06em) and a dense filter icon button (`filter`, "筛选会话", `aria-expanded`; `accent` while a filter applies). Open, it shows a dense search input ("按标题搜索", case-insensitive title substring) and a dense filled `Segmented` (全部 / 运行中 / 等待我). The filter is controlled (`conversations.filter`): the page asks the kernel with it (`?q=`, `?state=`) and the rows shown are narrowed at once; groups without a matching row hide; no match is the panel empty state (§6.18) "没有匹配的会话" with a dense 清除筛选: the line capybara over the sentence, centered in the list with `space.8` above and below. Closing the filter (the button or Esc in the input) clears it.
  - **One vertical rhythm**: the header, the filter, the archived back row and the list are `space.1` apart, and so are the agent groups inside the list (expanded or collapsed); a group's rows follow its label row with no gap.
  - **Groups** by agent, most recent first: a label row (`row.dense`): the agent's `Avatar` 16 (§6.30; the initial when the agent is not known), then the agent name (`small`, 500, `ink`; single line with an ellipsis, full name in `title`) inside a toggle button with `aria-expanded` and a `chevron-down` / `chevron-right` 12 icon, and a dense `plus` icon button "与 {agent} 新建会话". Collapse is remembered per viewer and org in `localStorage["cap.sidebar.collapsed.<orgId>"]` (a JSON array of agent ids, read and written inside try/catch; renders expanded when storage throws).
  - **Rows** (`conversation-row`, `row.dense`, radius `sm`): a 6 px state dot only for running (`ok`) or waiting for me (`warn`) (`state-dot`, `role="img"` named "运行中" / "等待我"), the title link (`conversation`, `ink`, single line with an ellipsis, full text in `title`), and the `⋯` menu (`row-menu`, 22 square, `more-horizontal` 14): 重命名 / 归档 / 删除 (danger, last). The menu button shows on hover, on focus within the row and on the current row; Tab reaches the menu of the row holding the list's tab stop. The current row gets the `sidebar-active` ground. An untitled conversation reads `未命名会话 · MM-DD HH:mm` / `Untitled conversation · MM-DD HH:mm` (its start time).
  - **重命名** is inline: a dense input with the title, focused and selected; Enter saves (trimmed; empty is not allowed and marks the input invalid), Escape cancels; focus returns to the row. **删除** asks first with `Dialog` (danger; "删除会话？", the title in the body; 取消 is focused). **归档** archives at once.
  - Each group shows its 5 most recent conversations, then "显示更多" (or "再显示 N 个" when the count is known; `small` `faint`, 26 high); the list shows 20 groups, then "更多分组".
  - **Archived**: an icon button (`archived-entry`, `archive` 14, dense `IconButton`, accessible name and tooltip `已归档 · N` / `Archived · N`) in the section header next to the filter button, shown only when N > 0, swaps the list **in place** for the archived conversations: a header `← 已归档 · N` (`archived-back`, `ink`, 600; accessible name "返回会话列表：已归档 · N") returns; archived rows' menu offers 取消归档 and 删除; group ＋ buttons hide; the filter applies to it too. No separate page.
- **States of the conversation section**: empty: the panel EmptyState (§6.18: the line capybara at scale 4 over the sentence, centered in the list, `space.8` above and below) "还没有会话" / "No conversations yet" with a dense `default` 新会话 link, never `primary` (the archived list: the same with "没有已归档的会话" and no action; a filter matching nothing (`filter-empty`): the same with "没有匹配的会话" + 清除筛选); no trailing full stop on these lines; loading: skeleton bars (`space.3` high, `selected`, radius `sm`) in three groups (3, 2, 2), `aria-busy`, no spinner; error: `circle-alert` + "会话列表加载失败" / "Couldn't load conversations" in `fail` and a dense ghost "Retry" (`refresh`).
- Long titles and agent names (40+ CJK characters without spaces) truncate to one line and never widen the sidebar.
- **Rail** (below 1280): width `layout.sidebar-rail`, icons only: the brand row is the logo alone; under it the expand button (`panel-left`, "Expand sidebar", opens the drawer), then search and the inbox as rail icons (the inbox badge as in the brand row); the org initial (a button opening the org menu, named as the switcher; the admin context shows the shield and the back arrow), 新会话, the primary items (each `row.default` square, accessible name kept, a Tooltip with the label to the right, past the rail's edge, on hover and focus), 更多 as one `more-horizontal` button opening the same flyout (on `sidebar-active` while the current page is inside), the admin entry and the account. Hover over the current item takes the `hover` ground (the signed rail reference). No conversations.
- **Drawer** (below 960): the full sidebar slides in from the left over a `scrim`, with `shadow-float`, opened from the menu button in the drawer menu bar; its brand row carries a close button (`x`), and the drawer menu bar carries the search button (`search`, at its right end) so the command palette stays reachable by pointer below 960. Esc, the close button and route changes close it; focus returns to the menu button. The drawer is the touch form: its rows (nav items, the back link, group heads, conversation rows, the archived back row) are 40 high and a conversation row's menu is a 40 px square. The brand row and the bottom block (the admin entry, the account) stay put, and everything between (the org switcher or the admin block, the nav with the expanded 更多 group, the conversations heading and list) is **one scroll region** (`drawer-scroll`), so an expanded 更多 pushes the conversations down instead of squeezing their list; the conversations are not a scroller of their own there. The org menu and the account menu open inside the drawer's width (the account menu's 语言 submenu opens beside it, on screen).
- **First paint**: the full / rail / drawer variant follows the window width through CSS media queries before hydration (both panels are drawn, one shown), so the server render never draws the full 256 sidebar at a narrow width. Remembered collapsed groups apply on the first client commit (layout effects) without the height motion; the motion runs only after the viewer toggles a group. The remembered collapsed list keeps at most 100 ids and drops ids of agents no longer listed once every group of that org is loaded.
- Hover never replaces the current item's `sidebar-active` ground.
- Interaction: §6.11.

<!-- states: sidebar -->
States: `default`, `item-hover`, `item-focus`, `conversation-active`, `group-collapsed`, `more-open`, `filter`, `filter-empty`, `archived`, `empty`, `loading`, `error`, `long-title`, `many-groups`, `guest`, `admin`, `rail`, `drawer`, `setup`, `setup-waiting`, `setup-hover`, `setup-focus`, `setup-rail`, `setup-drawer`, `pending`

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
| conversations | default | row-gap | space.1 |
| conversations | default | margin-left | -8 |
| conversations | default | margin-right | -8 |
| conversations | default | padding-left | space.2 |
| conversations | default | padding-right | space.2 |
| conversation-list | default | row-gap | space.1 |
| group-label | default | height | row.dense |
| group-label | default | font-size | type.small |
| group-label | default | color | color.ink |
| conversation-row | default | height | row.dense |
| conversation-row | default | padding-left | pad.dense.x |
| state-dot | default | width | 6 |
| archived-entry | default | width | control.dense |
| archived-entry | default | height | control.dense |
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
| empty-hint empty-state | empty | padding-top | space.8 |
| empty-hint empty-state | empty | padding-bottom | space.8 |
| empty-hint empty-illustration | empty | width | 57 |
| empty-hint empty-illustration | empty | height | 41 |
| empty-hint empty-state-text | empty | color | color.ink |
| empty-hint empty-state | filter-empty | padding-top | space.8 |
| empty-hint empty-state | filter-empty | padding-bottom | space.8 |
| empty-hint empty-illustration | filter-empty | width | 57 |
| empty-hint empty-state-text | filter-empty | color | color.ink |
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
- **Status**: success has no mark; failure is the word "失败" / "Failed" in `fail` followed by the reason in `muted`; something running is the `spinner` (`accent`, one turn per `motion.spin`): 16 on the live rows of the thread (thinking, tool lines and rows, group headers, sub-agent rows), 12 in panel headers and the properties panel's background tasks; a call that waits for a person has no spinner (§6.16.9). Characters are never icons.
- **Load failure** of an extension block (inline card, properties section, right panel, previewer): `circle-alert` 14 + "<name> 加载失败" / "<name> failed to load" in `fail`, the reason in `muted`, and a "重试" / "Retry" link button with `refresh` 12, inside that block only; the stream and the composer keep working.
- **Link buttons** ("View full text", "Copy output", "Retry", "Open"): no ground or border, `muted` (or `fail` inside a failure), underlined in `line-strong` with a 2px offset.
- Names in the reference set are placeholders (示例组织, 研究助手, Acme …); copy comes from §7.

#### 6.16.1 Title bar

- Belongs to the middle column only and never spans the right panel. Height `layout.title-bar`, padding 0 `space.3` 0 `space.5`, no ground, no bottom line.
- Left: the path `<org slug> / <agent> /` (mono `small`, `faint`, the agent a link led by its `Avatar` 16 and `space.1`, §6.30; the name takes the ellipsis), spaced like the page head's path (`space.2` on both sides of every `/`), then the title button (`control.default` high, radius `sm`, padding 0 `space.2`, pulled left by `space.2`, `body` `ink`, one line with an ellipsis and the full title in `title`, then `chevron-down` 14 `muted`; `hover` ground on hover and while its menu is open). It opens a menu: Rename (`square-pen`), Copy link (`link`), a separator, Delete (`trash-2`, `fail`). Rename opens a dialog; a manual rename stops title generation for good.
- Untitled: the title reads "未命名会话 · MM-DD HH:mm" / "Untitled conversation · MM-DD HH:mm" (the start time) in `muted` until a generated or manual title exists. The new-conversation page shows only the `muted` label "新会话" / "New conversation".
- Right, two groups of ghost icon buttons (`control.default` square, radius `sm`, icon 16): group 1 is the properties toggle (`panel-right`); then a 1px × `space.4` `line` separator with `space.1` on each side; group 2 is Files (`file-text`, once the conversation has a file; it opens the newest file in the right panel, whose switcher reaches the others) and the panel icons of the extensions enabled in the org, in contribution order, then More (`more-vertical`). The agent map has no icon here: its entry is the composer's agents chip (§6.16.29; acceptance item AC3, 2026-11-07). Icons that don't fit move into More, a menu of icon + label items; More exists only while two or more icons don't fit (one that doesn't fit takes More's slot, §6.7), and never repeats an icon on the bar. With no icon in group 2 the separator goes too. Each button's name is the panel it opens. The title and More menus hang 2px below their button. The open item's button has `aria-pressed="true"`, the `selected` ground and an `ink` icon; More is pressed while its menu is open.
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
- **Control row**, gap `space.1`, pulled left by `space.2` so the ＋ lines up with the text: ＋ (ghost `IconButton`, `plus`, "添加附件" / "Attach files") · agent picker · environment picker · model picker · effort picker · quick actions · agents chip · flexible space · send. The agent picker is optional (`pickers.agent`) and neither page passes it: the new conversation page's agents row chooses the agent (§5.4), and on a conversation the title bar's path names it (§6.16.1; maintainer decision U, 2026-11-07), so the control row repeats no agent label. The quick actions (`quickActions`, §6.16.27) are a ghost `zap` icon button, given only when the agent has some. The agents chip (`agents`, §6.16.29) is the agent map's entry, given once the conversation has a sub-agent (never on the new conversation page).
  - Pickers are ghost `default`-step buttons in `muted`: label + `chevron-down` 12, padding 0 `space.2`, opening a picker menu (§6.16.3) anchored to them (below, or above when the room below is short). When the row is short a picker's label gives way with an ellipsis, the whole value in its tooltip; a value of at most three characters (an effort, 「高」; `data-short`) never gives way, so one glyph is never cut in half (acceptance 2026-11-09); the icon buttons and the agents chip keep their size (AC3 fix round 1).
  - **Phones** (below 640, maintainer decision 2026-11-09): the environment, model and effort pickers collapse into one **options button** (`ComposerOptions`, `composer-options`; the pickers stay in the DOM for 640 and up, CSS shows one of the two): a ghost picker-styled button reading `<model> · <effort> · <environment>` with `chevron-down` 12, each part shortened (the model without a vendor path or a date / `latest` suffix, the environment without a trailing 「环境」 / "environment", the model then cut with an ellipsis, the effort never), the whole values in its name ("会话选项: …" / "Conversation options: …") and tooltip. It opens a **bottom sheet** (`composer-options-sheet`: `panel` ground, a `line-strong` top border, radius `md` at the top, over a `scrim`, at most 85% of the viewport high, its body scrolling; head "会话选项" / "Conversation options" with a 40 px ×) with one group per picker, 环境 / 模型 / 思考档位 (Environment / Model / Effort), hairlines between them. A group reuses its picker's props: the items as radios 40 high (provider labels, the checked item on the `selected` ground with a `check`, a disabled item with its reason tag), the note under them; a `locked` picker (a conversation's environment) is its value read-only with the hint. Choosing calls the picker's `onPick` and keeps the sheet open; Esc, × or the scrim close it. An existing conversation's composer uses the same button, its environment read-only. The agent picker (no page passes it) and the quick actions stay in the row.
  - Where a page passes the agent picker it is a picker only before the first message; a `locked` one is plain `muted` text with no chevron (`data-locked="true"`, `title` "发送第一条消息后不能再换 agent" / "The agent can't change after the first message").
  - The environment picker (`pickers.environment`, environments design: a conversation picks its environment before the model) sits between the agent and the model pickers, so the slot order is 智能体 · 环境 · 模型 · 档位. States: default (a picker menu of the environments the agent may use, the current one checked); an environment that cannot be chosen is a **disabled item** (`PickerItem.disabled`, not selectable, its `tag` the reason, "未配置" / "Not configured"); **locked** after the first message (the same `locked` plain `muted` text with no chevron and no menu, `data-locked="true"`, `title` "发送第一条消息后不能再换环境" / "The environment can't change after the first message"). It is absent when the page passes none.
  - The effort picker is hidden when the selected model declares no `effort` values.
  - Send: a `control.default` square icon button with `arrow-up` 16 on the `accent` ground, `on-accent` icon; disabled (no text and no files) it is the `selected` ground with a `faint` icon. While a run is going it becomes Stop (`square` 14, `selected` ground, `ink` icon, "停止" / "Stop").
- Placeholders: idle "输入消息，/ 使用命令" / "Message, / for commands"; new "想让 <agent> 做什么？" / "What should <agent> do?"; while running (state `running`) the hint "运行中发送的消息会在下一步交给智能体" / "Messages sent while it works reach it at its next step" (run input spec 2026-11-07 §4: ↵ and ⌘↵ both send an interjection). Keys: §6.11.
- Existing behavior carries over: `/` connector prompts, `@` connector resources, file drop and paste (FileDrop), at most `attachments.maxPerMessage` attachments, `clientMessageId` dedupe on retry.
- **Skill chip** (phase D, state `skill`): a skill picked from the `/` menu (or typed as `/name`) shows as a chip before the text on its first line, `space.2` from it, centered on the prose line: `control.dense` high, radius `sm`, padding 0 `space.1` 0 `space.2`, gap `space.1`, the `accent-tint` ground, the label ("/fix-issue") in mono `body` `accent`, then a remove × (`x` 12, a `type.small.line` square, `hover` ground on hover; "移除 /fix-issue" / "Remove /fix-issue"; its hit target extends invisibly to a `control.dense` square, WCAG 2.5.8). The skill's argument hint replaces the placeholder. Backspace with the caret at the start removes the chip and keeps the text; the text that follows is the skill's arguments. Removing it with the × puts focus in the text; while the chip is there the text area is described by its label (`aria-describedby`).

<!-- states: composer -->
States: `idle`, `new`, `running`, `attachments`, `focus`, `no-effort`, `skill`, `environment`, `environment-locked`

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
| picker | environment | height | control.default |
| picker | environment | color | color.muted |
| picker | environment-locked | height | control.default |
| picker | environment-locked | color | color.muted |
| composer-token-remove | skill | height | type.small.line |
| composer-input | skill | font-size | type.prose |

#### 6.16.3 Picker menu

- The model, effort and agent menus of the composer, and the quick actions' (§6.16.27): a Menu (§6.7: `panel` ground, 1px `line-strong` border, radius `md`, `shadow-1`, padding `space.1`) **anchored to its trigger** (maintainer decision 2026-11-07; `ConvMenu anchored`):
  - **Placement** (`menuPlacement`, a pure function): `space.1` from the trigger, below it by default, above it when the menu does not fit below but fits above (so the new conversation page's menus open below, the conversation page's above); when neither side fits the whole menu, on the side with more room. Its start edge sits on the trigger's; it may cover the textarea. 8 px stay between the menu and the viewport edge (collision padding; it shifts sideways to keep them).
  - **Size**: as wide as its content, at least the trigger's width and at most `min(320px, 100vw − 16px)`, a long label cut with an ellipsis and the whole label in its tooltip. Its height is the smaller of `layout.menu-max-height` (328: ten `row.default` items and the padding) and the room from the trigger to the viewport edge on its side minus the gap and the 8 px; it is set in CSS from Radix's live available height, so it stays right after a resize, a zoom or a phone keyboard (the side is chosen once, on open). The list scrolls inside it while the filter field above and the note below stay in view.
  - **Filter**: with more than ten items a filter field heads the menu (`menu-filter`: `control.dense` high, 1px `line` border, `accent` when focused, radius `sm`, `bg` ground, `small`, placeholder "筛选" / "Filter" in `faint`). Focus starts in it; typing narrows the items to those whose label contains the text (case-insensitive) and keeps the group label over each group that still has a match; ↓ moves to the first match and the arrows go on through the matches, ↑ on the first match returns to the field; Enter picks the first match (never while an IME composes); no match is the line "没有匹配项" / "No matches" (`menu-empty`, prose `small` `muted`). When the pointer has moved the focus onto an item or the menu, typing and Backspace go back to the field; Space on a focused item is not typing: it picks the item, as Enter does (Space in the field stays text). The field controls the list (`aria-controls`) and is described by an always-mounted live region with the match count ("N 项匹配" / "N matches") or the no-match line.
  - **Open**: the list is scrolled so the checked item is in view.
  - **Form selects**: the form `Select` (§6.2) opens this same anchored menu as a `listbox` (options with `aria-selected`; without a filter the focus starts on the selected option).
- Items are `menuitemradio`, `row.default` high, padding 0 `pad.default.x`, radius `sm`, `ink`; the selected item has `aria-checked="true"`, the `selected` ground and a `check` 14 at its end.
- **Model**: grouped by provider, each group under a label (`micro` `muted`, padding `space.2` `pad.default.x` `space.1`); the chat models of the org's enabled providers (`GET /orgs/:orgId/models`), the agent's own model first and tagged "agent 默认" / "agent default" (`micro` `muted` on the `selected` ground, radius `sm`, padding 0 `space.1`). The agent's fallback model is never listed.
- **Effort**: exactly the values the selected model declares, in the order low, medium, high, xhigh, max.
- **Agent**: the agents the person can use (new conversation only).
- A note closes each menu (`micro` `muted`, a `line-soft` top line, padding `space.2` `pad.default.x` `space.1`): model and effort "从下一条消息起生效" / "Applies from the next message" (an ongoing conversation only: on a new conversation the pick is the first message's, so its menus have no note); agent "发送第一条消息后不能再换 agent" / "The agent can't change after the first message".

<!-- states: picker-menu -->
States: `model`, `effort`, `agent`, `long`

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
| menu | long | max-height | layout.menu-max-height |
| menu-filter | long | height | control.dense |
| menu-filter | long | border-radius | radius.sm |
| menu-filter | long | font-size | type.small |
| menu-item | long | height | row.default |
| menu-note | long | color | color.muted |

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
- Live: a `spinner` (16, like the tool rows'), "正在思考" / "Thinking" and the elapsed seconds in `faint`; the body streams with the cursor and cannot be collapsed until it ends.
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
| spinner | live | width | space.4 |
| cursor | live | width | space.2 |

#### 6.16.6 User bubble

- Right-aligned, at most 75% of the thread width: `selected` ground, radius `bubble`, padding `pad.default`, a 1px transparent border (the queued form draws it dashed), prose font `prose` 15 / 26 `ink`, line breaks kept.
- **Long** (states `long`, `expanded`; acceptance item AC4, 2026-11-07, Claude's "Show more"): the bubble's text (`bubble-body`, the skill chip and the text) is clamped at `layout.bubble-clamp` (208, eight prose lines) and its last line fades out (a mask from opaque to transparent over the last `type.prose.line`, like the text output's fade, §6.16.20). Only when the clamp hides something (measured, and again on resize; the server render and hydration, which cannot measure, guess from the text: more than eight lines, counting the hard lines and each line's wrapping at about 34 CJK or 68 other characters, so a long message is folded from the first paint and the measurement then corrects it) a link button "展开" / "Show more" (`small`, the §6.16 link button: `muted`, underlined in `line-strong`) sits under the bubble, right-aligned, `space.2` below it and before the details; it has `aria-expanded` and `aria-controls` the text, opens it in full and becomes "收起" / "Show less". The attachments above, the skill chip on the first line and the details below always show. The open state is the bubble's own, local to the view and never kept (a reload or another conversation starts folded). A pending bubble (the queued form) and the transcript's bubbles behave the same.
- **Pending** (the queued form, `queued`): a message on its way, or an interjection the run has not taken in yet, or a leftover queued message (§6.11 "No queue"): the dashed bubble of §6.16.14 at opacity .6, and for an interjection or a leftover "待处理" / "Pending" under it in `small` `faint`; no actions.
- Attachments sit above the bubble, right-aligned, `space.2` apart: images as `layout.thumb` square thumbnails (radius `sm`, cropped to fill), then files as attachment chips (§6.16.21, without the remove button). Each opens like today's AttachmentPreview. A thumbnail that fails to load is reported to the caller, which may refresh the session and reload it once (as AttachmentPreview's `retry`).
- **Skill invocation** (phase D, state `skill`): the bubble starts with the skill chip, the composer's chip (§6.16.2) without its remove button: `control.dense` high, radius `sm`, padding 0 `space.2`, the `accent-tint` ground, the label ("/fix-issue") in mono `body` `accent`, centered on the first prose line, `space.2` before the text, which is the invocation's arguments (none: the chip alone). Under the bubble, right-aligned, at most 75% wide, `space.2` below it: a closed Disclosure (§6.5) "技能说明" / "Skill instructions" in `small` `muted`, a `row.dense` summary line whose chevron is `muted` too (not the Disclosure's usual `faint`), padded 0 `space.2` with radius `sm` (its hover ground never touches the words) and pulled right by `space.2` so the words stay on the bubble's edge, whose body is the text sent in the person's name (`small`, line breaks kept). A queued invocation (§6.16.14) shows the same chip in its dashed bubble.

- **Sender** (state `sender`, agent map spec §9.4): a message another agent sent (a parent's message in a sub-agent's transcript) has, above the bubble and right-aligned, "来自 <sender>" / "From <sender>" (`small`, `muted`, one line with an ellipsis, at most 75% wide, `space.2` above the bubble). A person's own message has none.

<!-- states: user-bubble -->
States: `default`, `attachments`, `skill`, `sender`, `long`, `expanded`

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
| bubble-sender | sender | font-size | type.small |
| bubble-sender | sender | color | color.muted |
| bubble | sender | background-color | color.selected |
| bubble-body | long | max-height | layout.bubble-clamp |
| bubble-body | long | height | layout.bubble-clamp |
| bubble-more | long | font-size | type.small |
| bubble-more | long | color | color.muted |
| bubble | long | background-color | color.selected |
| bubble-more | expanded | font-size | type.small |
| bubble-more | expanded | color | color.muted |

#### 6.16.7 Run divider

- A centered line between two 1px `line` rules that fill the width: `small` `muted`, gap `space.3`, on one line, `role="status"`.
- On the conversation page a run's end is the run row (§6.16.23): the thread draws only **compacted**, **fallback** and **notice** dividers; the stopped, failed and hook-denied kinds stay in the component.
- Kinds: **stopped** "已停止 · <who> <time>"; **failed** (the whole divider `fail`) "运行失败：<reason> · 重试" where Retry re-sends the last user message (text and files) and is folded into this divider rather than drawing a second bubble; **compacted** "较早的对话已压缩 · 节省 <n> · 查看摘要", which toggles the summary below it (`panel` ground, radius `md`, padding `space.3`, `prose-small` `muted`; the link reads "收起摘要" / "Hide summary" while open); **fallback** "所选模型 <a> 已不可用，本条起改用 agent 的模型 <b>" (a switched-to model disappeared); **hook-denied** (`fail`) "运行被扩展「<extension>」拦截：<reason>" (`run.hook_denied`); **notice** (`muted`, never `fail`, whatever it reports) a quiet line about something that happened outside a run: a background task's finish "后台任务「<description>」<status> · 退出码 <code> · 打开" / "Background task “<description>” <status> · exit code <code> · Open", whose action ("打开" / "Open" by default) opens the task's output on the right.

<!-- states: run-divider -->
States: `stopped`, `failed`, `compacted`, `compacted-open`, `fallback`, `hook-denied`, `notice`

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
| run-divider | notice | color | color.muted |
| run-divider | notice | font-size | type.small |

#### 6.16.8 Tool group

- **One call** is a tool line: the row label (§6.16.9) and a chevron when it has detail; opening it shows the detail (or the diff) in a tool box below.
- **Two or more consecutive calls** form a group: a header tool line (the summary) and, when open, the **tool box**: `panel` ground, radius `md`, `small` type, overflow hidden, one row per call, rows divided by `line-soft`. A finished group is collapsed by default; a running group is open and its header has no chevron.
- **Summary** (copy in §7): counts by kind with each kind's verb, joined by "，" / ", " in a fixed order (commands, tools, reads, edits, as reference set B draws it); failures add "（N 个失败）" / " (N failed)" in `fail`; edits add " · +a −b" in `faint`; a group whose rows all read, or all edit, one path names it in `ink` ("已读取 示例表.xlsx"). Running: a `spinner` (16), the running verb of the running row's kind and " · 已完成 N 个" / " · N done" in `faint`; when every live call waits for a person (§6.16.9), no spinner and the waiting word in `accent` instead of the verb ("等待你回答 · 已完成 N 个").
- **One call with a link** (§6.16.9): the tool line holds its toggle (the label and the chevron) and, after it, the link; the two are separate buttons.
- Groups sit between prose and end at prose, a user message, a human-in-the-loop card, a sub-agent group or a divider. Pages never group calls themselves: `apps/web/src/lib/timeline.ts` turns events into groups.

<!-- states: tool-group -->
States: `single`, `running`, `collapsed`, `collapsed-failed`, `one-object`, `expanded`, `edited`, `linked`

<!-- size-table: tool-group -->
| Part | State | Property | Value |
|---|---|---|---|
| tool-line | single | height | row.dense |
| tool-line | single | font-size | type.small |
| tool-line | single | color | color.muted |
| tool-line | single | column-gap | space.2 |
| spinner | running | color | color.accent |
| spinner | running | width | space.4 |
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
| tool-line | linked | height | row.dense |
| tool-link | linked | color | color.muted |
| tool-link | linked | font-size | type.small |

#### 6.16.9 Tool row

- `row.dense` minimum height, padding `pad.default`, gap `space.2`, `small` `muted`; `hover` ground on hover (over `motion.hover`), a 1px `accent` outline at -1px on focus. A row with detail is a `button` with `aria-expanded` and a chevron at its end.
- **Label** (one line, ellipsis), as the Claude Code VS Code extension draws it: the **name** in bold (600, the bold face; §2.2), then the key-argument preview (`muted`), then extra information after " · " (`faint`).
  - **Name**: a builtin's tool name as is (`Bash`, `Read`, `Edit`, `Grep` …), untranslated, as a proper noun; a connector tool's connector display name, or an extension tool's plugin display name, followed by its local tool name in brackets (`Acme 工单 [search_tickets]`). The brackets show the local name, never the declared `title`: the title is the row's tooltip (`title` attribute).
  - **Preview**: a shell row (`Bash`) shows the `description` the model wrote; every other row its key argument: the tool's declared `keyArgs` (else the first string argument; Read / Write / Edit the path, Glob / Grep the pattern, Skill the skill). The preview is its first line, cut at 80 characters with "…".
  - Edits add "+a −b" as the extra, unless the edit could not be diffed (a `Write` over a binary or very large file: `truncated` without hunks), which shows no line counts and no diff.
  - **The question tool** (`AskUserQuestion`, kind `question`, which the web derives from the builtin's name; the kernel's kind stays `meta`): the name slot reads the verb "已提问" / "Asked" (600), the preview the first question's `header`, else its question, else the tool's title. Its question card (§6.16.12) stays below.
- **Link** (`link`: a label and an action): a background `Bash` call (`run_in_background: true`) links its task, "查看「<description>」的输出" / "View output of <description>", which opens the task's output on the right (§6.16.18); its row reads "后台运行" / "In background" as the extra, which replaces any other extra. The link is a link button (`small` `muted`, underlined, `ink` on hover) at the row's end, after the chevron; the row is then a plain container holding its toggle (a button with the label and the chevron, `aria-expanded`) and the link, never one inside the other. Without detail the toggle is the label alone.
- **Status**: running — a `spinner` (16) before the label, the label `ink`, the elapsed time in `faint` at the end ("12 秒" / "12s", "1 分 03 秒" / "1m 03s"); waiting for a person — a live call with a pending approval, question or connection (the web reads it from the log: `approval_requested` without its decision, `question_asked` without its answer, `connection_required` before the result) has no spinner and no timer: the label `ink` and at the end the waiting word in `accent`, "等待你回答" / "Waiting for your answer", "等待你批准" / "Waiting for your approval", "等待你连接" / "Waiting for you to connect"; when someone else has to act (a shared conversation: the approval's assigned member or escalation role, the run's starter for a question or a connection, per the log's `approval_requested` and `run_started`), the word names them: "等待 张三 批准" / "Waiting for 张三 to approve", "等待 张三 回答" / "Waiting for 张三 to answer", "等待 张三 连接" / "Waiting for 张三 to connect", with a role for an escalated approval ("等待 管理员 批准" / "Waiting for an admin to approve"); a log without the approver keeps "你"; once answered the row runs as before; done — no mark; failed — "失败" in `fail` and " · <the error's first line>" in `muted` (a shell command with a non-zero exit or a timeout is a failure); blocked by a policy hook — failed, "被扩展「<extension>」拒绝" / `Denied by extension "<extension>"`.
- **Expanded detail**: padding 0 `space.3` `space.3`, gap `space.2`, two labelled blocks, each a label column (`micro` 600 `faint`, "IN" / "OUT" in English, "输入" / "输出" in Chinese, `4ch` wide, gap `space.2`) beside its body:
  - **IN**: the command for a shell row as `$ <command>` (the `$` `faint`, the command `ink`); else the inputs as a key / value grid (columns `max-content` and the rest, gap `space.1` × `space.3`, keys `faint`, values `ink`, breaking anywhere). Omitted when there is no input;
  - **OUT**: the output: `bg` ground, radius `sm`, padding `pad.default`, `small` `ink`, wrapped, folded at `layout.tool-output` high and scrolling; for a failure the full error text; then a footer (`micro` `faint`, gap `space.3`): the duration ("2.1 秒" / "2.1s") and "复制输出" / "Copy output"; for a large output instead "输出 82 KB，已显示前 4 KB" / "Output 82 KB, showing first 4 KB" and "查看全文" / "View full text", which reads the archive (`GET …/outputs/:outputId`). Omitted while there is no output yet.
  - An edit's expanded form stays its diff (§6.16.10), without labels.

<!-- states: tool-row -->
States: `default`, `hover`, `focus`, `running`, `failed`, `expanded-command`, `expanded-connector`, `expanded-failed`, `large-output`, `hook-denied`, `waiting`, `linked`

<!-- size-table: tool-row -->
| Part | State | Property | Value |
|---|---|---|---|
| tool-row | default | height | row.dense |
| tool-row | default | padding-top | pad.default.y |
| tool-row | default | padding-left | pad.default.x |
| tool-row | default | column-gap | space.2 |
| tool-row | default | font-size | type.small |
| tool-row | default | color | color.muted |
| tool-name | default | font-weight | 600 |
| tool-name | default | color | color.ink |
| tool-row[data-ref-forced=true] | hover | background-color | color.hover |
| tool-row[data-ref-forced=true] | focus | outline-color | color.accent |
| tool-row[data-ref-forced=true] | focus | outline-width | 1 |
| spinner | running | color | color.accent |
| spinner | running | width | space.4 |
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
| tool-io-label | expanded-connector | color | color.faint |
| tool-io-label | expanded-connector | font-size | type.micro |
| tool-io-label | expanded-connector | font-weight | 600 |
| fail-word | expanded-failed | color | color.fail |
| tool-output | expanded-failed | background-color | color.bg |
| tool-footer | large-output | color | color.faint |
| fail-word | hook-denied | color | color.fail |
| tool-row | waiting | height | row.dense |
| tool-label | waiting | color | color.ink |
| waiting-word | waiting | color | color.accent |
| tool-row | linked | height | row.dense |
| tool-link | linked | color | color.muted |
| tool-link | linked | font-size | type.small |

#### 6.16.10 Diff block

- The expanded form of an edit (`Edit`, `Write` over an existing file), inside the tool box, padding `space.1` 0. Each line: gap `space.2`, padding 0 `space.3`, `small` mono, no wrapping; a 4-character right-aligned `faint` gutter with the line number (the new number, the old one for removed lines), a 1-character sign column (+ / − / blank), then the text with an ellipsis.
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
- **Summary**: a call that carries a kernel-rendered summary (a Platform operation: what it does, in the UI language, from the operation and its params) shows it as one `small` line between the head and the argument grid; the key and every argument stay on screen below it. The summary is a convenience, never a substitute for the arguments.
- **Why the key and every argument**: a tool's title (and its `keyArgs`) come from extension or connector code and a connector's title can change without drift review (it is display only). The person approving must see what the model actually calls: the reviewed key and the full input, so a misleading title can at most mislabel a call whose key and arguments are on screen.
- **Deny with a reason**: "拒绝…" swaps the actions for a reason input ("拒绝原因（选填，会告诉模型）" / "Reason (optional, the model sees it)"), "拒绝" / "Deny" (danger), "取消" / "Cancel" (ghost) and the note "原因会写入会话，模型能看到" / "The reason goes into the conversation; the model sees it".
- **Decided**: collapses to a tool line that names the key too: approved — `check` 12, "<who> 批准了 <tool>" and " <key> · <scope> · <time>" in `faint`; denied — `x` 12, "<who> 拒绝了 <tool>", " <key>" in `faint`, " · 「<reason>」" in `muted` and the time in `faint`.

<!-- states: approval-block -->
States: `pending`, `pending-once`, `pending-summary`, `deny-reason`, `approved`, `denied`

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
| summary | pending-summary | font-size | type.small |
| approval-block | deny-reason | border-top-color | color.accent |
| button[data-variant=danger] | deny-reason | height | control.default |
| tool-line | approved | height | row.dense |
| tool-line | approved | color | color.muted |
| tool-key | approved | color | color.faint |
| tool-line | denied | color | color.muted |
| tool-key | denied | color | color.faint |

#### 6.16.12 Question block

- `AskUserQuestion` and connector elicitation. **Pending**: a floating card (`line` border, not accent), gap `space.3`, `role="group"` named by the question. The question in the prose font (`prose`, 600). Options as rows (`row.default` minimum height, padding `pad.default`, 1px `line` border, radius `sm`; a 12 round radio, `line-strong`, `accent` when checked; the checked row has an `ink` border); multi-select options use checkboxes; with `allowOther` a last row "其他：" / "Other:" holds a free-text input. Actions: "回答" / "Answer" (primary), "跳过" / "Skip" (default).
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

- **Retired from the conversation page** (run input spec 2026-11-07): nothing is queued any more, and leftover queued messages render as pending user bubbles (§6.16.6) without these actions; only the **paused** line and "Continue sending" below are still drawn there, for paused leftovers. The full component stays in the design package and the catalog until the kernel's queue routes are removed.
- Messages queued with ↵ while a run is going (UI refresh spec §5.7) sat in the chat column after the sent messages, in order: each a user bubble with a 1px dashed `line` border at opacity .6 (`data-queued="true"`), and under it, right-aligned (`small`, gap `space.1`): "排队中" / "Queued" in `faint`, then dense icon buttons (`copy`, `square-pen`, `trash-2`, 14; named 复制 / 编辑 / 删除 · Copy / Edit / Delete) and "立即发送" / "Send now" (dense default button).
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

- Sub-agents group like tools (phase C runtime; durations "41 秒", "1分12秒" / "41s", "1m 12s"). **Running**: a header tool line with a `spinner` (16) and "正在运行 N 个子智能体" / "N subagents running", then one Agent call block per sub-agent, `space.2` apart. **Waiting**: when every active sub-agent waits for a person, the header has no `spinner` and says what the first one waits for in `accent` ("等待批准" / "Waiting for approval"), with " · 已完成 N 个" / " · N done" in `faint` as when running (§6.16.9). **Done**: a collapsed header "N 个子智能体已完成（M 个失败）· 共 X 次调用 · <duration>" / "N subagents done (M failed) · X calls · <duration>" with the failure count in `fail` and the totals in `faint`; sub-agents that reached a limit add "（K 个已达上限）" / " (K reached a limit)" in `warn` after it (**Limit** state); opening it shows the blocks. With `onOpenMap` the header ends with the link button "智能体图" / "Agent map" (`tool-link` style, part `subagent-map-link`; agent map spec §9.2) in every state; a done header then is a toggle beside the link, never nesting it (§6.16.9).
- **Agent call block** (`AgentCallBlock({ description, prompt, state, onOpen?, defaultExpanded? })`, agent map spec §9.5, as Claude Code draws an `Agent` call): a tool box (`panel`, radius `md`, `small`) whose header (`row.dense`, padding `pad.default`) is the tool name "Agent" (600, `ink`) and the task description (`ink`), one line with an ellipsis; the body is the IN block of an expanded tool row (§6.16.9: the label "输入" / "IN" in `micro` `faint`, 4ch) with the prompt in `ink`, line breaks kept, **two lines with an ellipsis**. When the two lines hide something (measured, again on resize) a link button "展开" / "Show more" (`aria-expanded`, `aria-controls` the prompt) opens it in full and becomes "收起" / "Show less". No prompt: no body.
- **Status line** under the box (`row.dense`, padding 0 `pad.default.x`, `small`, `muted`, gap `space.2`): the status dot of the agent map (§6.16.28: 8, round, `role="img"` with the status word; running `accent` pulsing every `motion.pulse`, waiting `warn`, completed `ok`, limit reached `warn`, failed `fail`, stopped `faint`), the state (one line, ellipsis) and at the end the link button "在智能体图中查看" / "View in agent map" (`onOpen`: that agent's level 2). While the child works: "后台运行中：<current tool summary>" / "Working in the background: <summary>" ("后台运行中" alone before the first summary; a queued child counts as working); waiting for a person: "后台等待中：<summary>" / "Waiting in the background: <summary>". A foreground child (a fork skill's, or one in a log written before background sub-agents) has the neutral copy: "运行中：<summary>" / "Working: <summary>", "等待中：<summary>" / "Waiting: <summary>" (`background: false`). Once it has ended: "完成" / "Completed", "已达上限" / "Limit reached" (in `warn`), "失败" / "Failed" (in `fail`) or "已停止" / "Stopped", then " · <time> · <tokens>" (each left out when unknown; tokens as the agent map writes them). The action stays after the end. A call refused before any child ran says "失败 · <the refusal's first line>" (the whole text as the tooltip) and has no action: there is nothing to open. The line is not a live region (the summary changes with every tool call).

<!-- states: subagent-group -->
States: `running`, `waiting`, `done`, `failed`, `stopped`, `limit`, `expanded`, `map-link`

<!-- size-table: subagent-group -->
| Part | State | Property | Value |
|---|---|---|---|
| tool-line | running | height | row.dense |
| spinner | running | color | color.accent |
| spinner | running | width | space.4 |
| tool-box | running | background-color | color.panel |
| tool-box | running | border-radius | radius.md |
| agent-call-head | running | height | row.dense |
| agent-call-name | running | color | color.ink |
| tool-io-label | running | color | color.faint |
| agent-call-prompt | running | color | color.ink |
| agent-call-prompt | running | font-size | type.small |
| agent-call-status | running | height | row.dense |
| agent-call-status | running | color | color.muted |
| agent-dot | running | width | space.2 |
| agent-dot | running | background-color | color.accent |
| agent-call-open | running | color | color.muted |
| tool-line | waiting | height | row.dense |
| waiting-word | waiting | color | color.accent |
| agent-dot | waiting | background-color | color.warn |
| fail-word | done | color | color.fail |
| tool-line | done | height | row.dense |
| agent-dot[data-status=failed] | failed | background-color | color.fail |
| agent-call-status[data-status=failed] fail-word | failed | color | color.fail |
| agent-dot[data-status=aborted] | stopped | background-color | color.faint |
| agent-call-more | expanded | color | color.muted |
| agent-call-prompt[data-expanded=true] | expanded | color | color.ink |
| subagent-map-link | map-link | color | color.muted |
| subagent-map-link | map-link | font-size | type.small |

#### 6.16.16 Inline card

- An extension card in the stream (`place: "inline"`), hanging off the tool result that named it (`ToolResult.card`); stage B2's MCP Apps widgets use the same frame.
- A title tool line above the card: "来自 <extension> 的卡片" / "Card from <extension>", then at the right its badge in `faint` (e.g. "2 / 5"), "实时" / "Live" in `muted` for a live embed, and a dense ⤢ icon button (`maximize-2` 14, "在右侧面板打开" / "Open in the right panel") when the extension has a right panel.
- The card is a floating card. Body: the rendered view (UiView blocks at the `dense` step) or an embed (EmbedFrame, the embed's own height). Loading: skeleton bars (`selected`, radius `sm`, `aria-busy`), never a spinner. Failure: the load-failure line of §6.16, in this card only.
- **The card is the one box** (§1): an embed inside it has no border of its own (EmbedFrame's boxed-in form, §6.9), a view's table is unframed (on the card's `raised` ground), its code blocks are borderless (`panel-2`); the caller passes nothing, the pieces read that they are inside a box.

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
- Built-in sections, in order: **Context** (the usage ratio as the value; a meter `space.1` high, `line` track, `ink` fill, radius `sm`; "<model> · <sandbox status>" and "连接器：…" / "Connectors: …" in `small` `muted`; the last run's line "上次运行 · <model> · <duration> · <tokens>" / "Last run · …" in `small` `muted` (`context-last-run`, once a run ended; cost joins it only when the log carries one); once the conversation has sub-agents, a last `small` `muted` line with its tokens including theirs, worded by the page); extension sections (`place: "section"`, in contribution order, rendered `dense`); **Files** (the count as the value, the conversation's own files and its sub-agents' deliveries; rows `row.dense`: type badge, name with an ellipsis, for a sub-agent's file "来自 <sub-agent>" / "from <sub-agent>" in `faint` (at most 40% of the row, with an ellipsis), size in `muted`; then "全部 N 个文件" / "All N files" with `chevron-right` 12 in `muted`); **Background tasks** (sub-agents and background Bash tasks, running ones only; rows `row.dense`: `spinner`, name, duration `muted` (a sub-agent waiting for a person: no `spinner`, and what it waits for in `accent` instead of the duration), a dense stop icon button `square` 12 named "停止「<name>」" / "Stop <name>"; a task whose stop is under way keeps its `spinner` and shows "正在停止…" / "Stopping…" in `muted` instead of the button; a sub-agent's own tasks are nested under it, indented `space.4` (a task with a parent is nested whatever the parent's status); then "已完成 N 项" / "N completed" with a chevron, counting finished tasks and sub-agents together and opening the newest). The section shows running items only: finished tasks and sub-agents are not rows, they are counted in "N completed". `BackgroundTaskRow`'s finished states exist for places that list finished tasks: no `spinner`, ending with the status word: "已完成" / "Done", "已停止" / "Stopped" and "已丢失" / "Lost" in `muted` (success is not colored), "失败" / "Failed" and "已超时" / "Timed out" in `fail`; a sub-agent that reached a limit "已达上限" / "Limit reached" in `warn`.
- **Task output** (`TaskOutputPanel`, the body of the right panel for a task, §6.16.18): a head line with the status word (`muted`, `fail` when failed or timed out), the elapsed time in `faint` and, while running, a dense stop icon button at the right (once a stop is under way, the task view's `stopping` or the page's own stop in flight, "正在停止…" / "Stopping…" in `muted` with `role="status"` instead of the button); the command in the design's monospace (`font.mono`, which the size table cannot express: it holds numbers and colors only) in `ink`; when only the finish event's tail is left (the sandbox is suspended) the note "输出不可读（沙箱已暂停）" / "Output unavailable (sandbox suspended)" in `muted` above the last lines; the last lines in a `CodeBlock` (§6.8). The elements sit `space.2` apart.
- A failing extension section shows the load-failure line in that section only.
- **Boxes inside a section** (§1): an extension section's embed, table and code blocks draw their unboxed forms, as in an inline card (§6.16.16).
- **The narrow properties sheet** (below a 1280 window the properties panel opens in a Sheet, §5.4): the sheet is the box, so its sections are heading and hairline groups there (`data-inset="box"`): no ground, radius or hairline of their own, padding `space.3` 0, a `line-soft` line between the panel's children (so a section the page wraps, such as an extension section in its `data-extension-section` box, is split from its neighbours too); the sheet keeps its `panel-2` ground and padding `space.2` `space.4`, the sections `0` apart (state `properties-sheet` of `template-conversation`, §5.4). A RightPanel or a file preview opened in the sheet is a full-height pane and holds content like a page.

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
| task-row | background | height | row.dense |
| spinner | background | color | color.accent |
| icon-button | background | width | control.dense |
| property-section | extension | background-color | color.panel |
| load-failed-title | failed | color | color.fail |

<!-- states: background-task -->
States: `running`, `waiting`, `done`, `failed`, `stopped`, `lost`, `nested`

<!-- size-table: background-task -->
| Part | State | Property | Value |
|---|---|---|---|
| task-row | running | height | row.dense |
| spinner | running | color | color.accent |
| icon-button | running | width | control.dense |
| task-row | waiting | height | row.dense |
| waiting-word | waiting | color | color.accent |
| task-row | done | height | row.dense |
| task-status | done | color | color.muted |
| fail-word | failed | color | color.fail |
| task-status | stopped | color | color.muted |
| task-status | lost | color | color.muted |
| task-row[data-nested=true] | nested | padding-left | space.4 |

<!-- states: task-output-panel -->
States: `running`, `finished`, `unavailable`, `stopping`

<!-- size-table: task-output-panel -->
| Part | State | Property | Value |
|---|---|---|---|
| task-command | running | color | color.ink |
| icon-button | running | width | control.dense |
| task-output-status | finished | color | color.muted |
| task-output-note | unavailable | color | color.muted |
| task-output-stopping | stopping | color | color.muted |

#### 6.16.18 Right panel

- One extension panel (`place: "panel"`, formerly `conversation`), a file preview or a sub-agent conversation, one at a time; opening it closes the properties panel or the previous panel. Full height, `panel-2` ground, a `line-soft` left divider.
- **Width**: default `layout.panel`, at least `layout.panel-min`, at most the content width minus `layout.chat-min` (so wide screens may go past 600, and at a 1280 window with the full sidebar it is 544). Resizable by a handle on its left edge (§6.11); the width is a per-viewer preference in `localStorage["cap.chat.panelWidth"]` (read and written in try/catch, clamped on read). Below a 1280 window the right area is a Sheet (§5.4).
- **Header**: `layout.title-bar` high, padding 0 `space.2` 0 `space.4`, a `line-soft` bottom line, gap `space.1`: back (`chevron-left`, optional), the type badge (files), the title as a ghost button with `chevron-down` 14 that opens the switcher (a Menu: extension panels, a separator, the conversation's files, each group under a `micro` label; the open item has the `selected` ground and no check; the title keeps the `hover` ground while it is open), or plain text when there is nothing to switch to (a sub-agent); meta in `small` `faint` ("v2 · 10-26 14:20", "2 / 5", a `spinner` and the duration); actions; full screen (`maximize-2`); close (`x`).
- **Body**: padding `space.4` (flush for tables), scrolls on its own. A failing extension panel shows the load-failure line in its body.
- **Sub-agent panel**: header back (returns to what the right area showed before, e.g. the properties panel it was opened from; otherwise closes), description, spinner and duration, "停止" / "Stop" (default), full screen, close; body padding `space.4` `space.5`: the task as a block (`selected` ground, radius `md`, padding `space.3`, `prose-small`; label "任务 · 主 agent 派出" / "Task · from the main agent" in `micro` `muted`), a tool line naming its agent (an org agent's name is a link to that agent, styled as a link button), model and tool scope, then its tool groups and prose like the main thread; no composer and no read-only copy (the missing composer says it); its own status bar at the bottom (context use only).

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

#### 6.16.23 Run row

`RunRow({ status, parts, statusText?, defaultOpen?, error?, facts?, onRetry?, retryLabel?, links? })` closes every run that ended (§5.4): what ran, how long, what it cost, and how it ended, without colour unless it failed.

- **Line**: a tool line (§6.16, `row.dense` high, mono `small` `muted`, gap `space.2`): "运行" / "Run" and the `parts` the page fills (the model, the duration such as `3.7s`, the tokens such as `1,234 tokens`; unknown ones are left out) joined by " · " with an ellipsis, then the **status**: the mark (12) and the status word, `space.1` apart: `ok` a `check` in `ok` and "完成" / "Done" in `muted` (the one coloured mark of a quiet row, an exception to §2.4's uncoloured success: a run is a unit a person checks for its outcome); `failed` a `circle-x` and "失败" / "Failed" (or the page's words such as "失败 · 已重试") both in `fail`; `stopped` a `ban` and the page's words "已停止 · <who> <time>" in `muted`. Then a `chevron-right` / `chevron-down` 12 when there is a detail. The duration is the run's working time: from its start to its end without the time it waited for a person (an approval or a question, until answered), the same derivation as the status bar's "已用" (§5.4), so the two agree.
- **Disclosure**: with a detail the line is a `button` with `aria-expanded` and `aria-controls`; the detail is a `region` named "运行详情" / "Run details". A failed row starts open (`defaultOpen` overrides), the others closed. Without any detail the line is plain text.
- **Detail**: `space.1` below the line, `space.2` between its parts, under a 1px `line` guide on the left, indented `space.3` (the thinking body's guide): the failure as an `ErrorDetail` (§6.24: the localized sentence, the raw text behind its toggle); `facts`, plain mono `small` `muted` lines (the token split, the start time); then the actions, a row `space.2` apart of `dense` buttons: Retry ("重试" / "Retry", default) and the `links` as `LinkButton`s (default): "查看轨迹" / "View trajectory", "去配置模型服务" / "Configure model services". The page decides which actions a role gets; the row never draws one the reader cannot use.

<!-- states: run-row -->
States: `ok`, `ok-open`, `failed`, `stopped`

<!-- size-table: run-row -->
| Part | State | Property | Value |
|---|---|---|---|
| run-row | ok | height | row.dense |
| run-row | ok | font-size | type.small |
| run-row | ok | color | color.muted |
| run-mark | ok | color | color.ok |
| run-status | ok | color | color.muted |
| run-detail | ok-open | padding-left | space.3 |
| run-detail | ok-open | border-left-color | color.line |
| run-detail | ok-open | row-gap | space.2 |
| run-status | failed | color | color.fail |
| run-mark | failed | color | color.fail |
| run-detail | failed | padding-left | space.3 |
| error-detail-summary | failed | color | color.fail |
| run-status | stopped | color | color.muted |
| run-mark | stopped | color | color.muted |

#### 6.16.24 Working line

`WorkingLine({ still? })` fills the silence from a person's send until the run's first output
(conversation send spec `docs/superpowers/specs/2026-11-04-conversation-send-design.md` §2.2).

- **When** (the page decides, from the log and its pending messages; `ConversationPage`'s
  `working` draws it after the thread and before the queue): from a send (the pending bubble) or
  a run start until the run's first output (a thinking row, prose, a tool, a sub-agent, an
  approval, a question, a connect block, or the run row when the run ends without output); again
  after a tool result while the model has not answered. Exactly one per conversation.
- **Line**: a tool line (`row.dense`, mono `small` `muted`, gap `space.2`), no timer (the thinking
  row keeps its seconds).
- **Mark**: the pixel capybara of §3 at pixel unit 2 (28 × 20, the sidebar logo's size), `accent`,
  `crispEdges`, in a `control.default` × `space.5` (28 × 20) box; the line stays `row.dense` high. It walks: two frames swap the legs (rows 9–10 of the bitmap; frame 2 moves
  each pair one pixel inward) every 400ms.
- **Caption**, rotating every 2.4s in place (no slide, no fade): 规划中… / 执行中… / 斟酌中… /
  整理中… (en: Planning… / Working… / Pondering… / Composing…), starting at the first. The
  captions share one box, so the line keeps the widest one's width.
- **Reduced motion** (and `still`, the reference set's form): the mark stands still on frame 1 and
  the caption stays on its first entry.
- **A11y**: a polite `role="status"` region (visually hidden) stays mounted while the page uses the
  line and is filled with the first caption when the line starts, so it is announced once per
  start, never on a rotation; the line itself (mark and rotating captions) is `aria-hidden`.
- Existing tokens only, no new colours.

<!-- states: working-line -->
States: `default`, `reduced-motion`

<!-- size-table: working-line -->
| Part | State | Property | Value |
|---|---|---|---|
| working-line | default | height | row.dense |
| working-line | default | font-size | type.small |
| working-line | default | color | color.muted |
| working-line | default | column-gap | space.2 |
| working-mark | default | width | control.default |
| working-mark | default | height | space.5 |
| working-mark | default | color | color.accent |
| working-line | reduced-motion | height | row.dense |
| working-mark | reduced-motion | width | control.default |
| working-mark | reduced-motion | color | color.accent |

#### 6.16.25 Greeting

`Greeting({ text?, sub?, still? })` opens a new conversation (agent profile design §4.1, U10).

- **Line**: the pixel capybara of §3 at pixel unit 2 (28 × 20, the working line's mark, §6.16.24),
  `accent`, `crispEdges`, in a `control.default` × `space.5` box, then `space.3`, then the line:
  `h1` size and line height, 600, `ink`, one line with an ellipsis; a heading (`h2` element).
- **Typing**: the line is typed once, on first paint, one character every 40 ms, with a 2 px
  `accent` caret after the typed text that goes when the line is complete; a re-render with the
  same line never types it again. **Reduced motion** (and `still`, the reference set's form): the
  whole line at once, no caret.
- **Placeholder**: the line is picked on the client from the time-of-day sets (the web's
  `pickGreeting`), so the server render (and any render without `text`) draws the mark and an empty
  text box: the line box is always one `type.h1.line` high, and the line replaces the placeholder
  in place.
- **Sub line** under the text, aligned with it: `prose-small` `muted`, default "选一个智能体开始" / "Pick an agent to start"; `sub={null}` draws none.
- **A11y**: the heading's name is the whole line (a visually hidden copy); the typed text and the
  caret are `aria-hidden`, so the line is read once, never a character at a time. The mark is
  decorative.

<!-- states: greeting -->
States: `default`, `placeholder`

<!-- size-table: greeting -->
| Part | State | Property | Value |
|---|---|---|---|
| greeting-line | default | height | type.h1.line |
| greeting-line | default | column-gap | space.3 |
| greeting-mark | default | width | control.default |
| greeting-mark | default | height | space.5 |
| greeting-mark | default | color | color.accent |
| greeting-text | default | font-size | type.h1 |
| greeting-text | default | color | color.ink |
| greeting-sub | default | font-size | type.prose-small |
| greeting-sub | default | color | color.muted |
| greeting-line | placeholder | height | type.h1.line |
| greeting-mark | placeholder | width | control.default |

#### 6.16.26 Agent row and agent panel

`AgentRow({ agents, selected, onSelect, max = 5, recent, moreLabel })` chooses the agent of a new
conversation (agent profile design §4.2); `agents` are `{ id, name, description, avatar }` in the
page's order (most recent use, then name).

- **Row**: chips `space.2` apart, wrapping (on a phone's new conversation one line scrolling sideways, §5.4). A chip is a button `control.prominent` high: an
  `Avatar` 24 (§6.30), `space.2`, the name (`body`, one line with an ellipsis, the chip at most
  200 wide), padding `space.1` left and `space.3` right, 1px `line` border, radius `md`, `muted`;
  hover the `hover` ground and `ink`. The selected chip is `aria-pressed="true"`: `selected` ground,
  `ink` border and text. The description is the chip's tooltip.
- **Count**: at most `max` chips, then a "更多 +N" / "More +N" chip (no avatar, padding `space.3`);
  a selected agent past the first `max` takes the last place, so the selection always shows. With
  one agent (or none) the row draws nothing.
- **Loading**: while the agents are read, `ConversationPage`'s `loading.agents` draws `AgentRowLoading`
  in the row's place: three chips with the loaded chip's box (height, border, radius, padding, gap),
  each an avatar-sized block (24) and a name bar, with nothing interactive, so the composer does not
  move when the agents arrive; the page's one busy region announces it.
- **Panel**: "更多 +N" opens the agent panel in a popover (§6.7 look: `panel` ground, 1px
  `line-strong` border, radius `md`, `shadow-1`) anchored under the row, as wide as the row (at most
  `layout.chat`), padding `space.2`. Top to bottom: a search field (`Input`, placeholder
  "搜索名称或描述" / "Search name or description"), then the groups "最近用过" / "Recently used" (the
  `recent` ids in order; none when empty) and "全部 N 个" / "All N" (every agent), `space.2` apart.
  Each group is a **two-column grid** (equal columns, gaps `space.1` between rows and `space.2`
  between columns) under its label (`micro` `muted`, spanning both columns), filled row by row.
  An option is `space.8` high, padding 0 `space.2`, radius `sm`: an `Avatar` 28, the name (600,
  `ink`, at most 40% of the option) and the description on the same line (`small` `muted`, one
  line with an ellipsis). The selected agent's option has the `selected` ground; the active one
  (keyboard or pointer) the `hover` ground. The list scrolls past 320, or past the height left
  below the row (Radix's available height minus the search, the gap and the panel's padding).
- **Search** matches name and description, case-insensitively; N counts the matching agents. No
  match: no list, one quiet line "没有匹配的 agent" / "No matching agents" (`small` `muted`).
- **Keyboard**: focus goes to the search when the panel opens and stays there (a combobox with
  `aria-activedescendant` over a listbox of grouped options; the first option is active). The
  arrows move in two dimensions (`gridStep`): ← / → within the row, stopping at its ends; ↑ / ↓ one
  row (two options), keeping the column, and on a row with no option below that column ↓ goes to
  the group's last option. From a group's last row ↓ goes to the next group's first row, from its
  first row ↑ to the previous group's last row, in the same column or the nearest one that exists
  there; at the panel's first and last rows the active option stays. While nothing is listed ← / →
  move the text caret. Enter selects the active option, Escape closes and gives focus back to
  "更多 +N"; selecting (Enter or a click) closes the panel and leaves the focus where `onSelect`
  put it (the new conversation page moves it to the composer), not on "更多 +N". While an IME composes (pinyin),
  Enter and the arrows belong to it: the panel ignores them.

<!-- states: agent-row -->
States: `default`, `panel`, `no-match`

<!-- size-table: agent-row -->
| Part | State | Property | Value |
|---|---|---|---|
| agent-row | default | column-gap | space.2 |
| agent-chip | default | height | control.prominent |
| agent-chip[aria-pressed=false] | default | border-top-color | color.line |
| agent-chip | default | border-radius | radius.md |
| agent-chip avatar | default | width | 24 |
| agent-chip[aria-pressed=true] | default | background-color | color.selected |
| agent-chip[aria-pressed=true] | default | border-top-color | color.ink |
| agent-chip[aria-pressed=true] | default | color | color.ink |
| agent-more | default | height | control.prominent |
| agent-more | default | color | color.muted |
| agent-panel-pop | panel | background-color | color.panel |
| agent-panel-pop | panel | border-top-color | color.line-strong |
| agent-panel-pop | panel | border-radius | radius.md |
| agent-panel-pop | panel | padding-top | space.2 |
| agent-list | panel | row-gap | space.2 |
| agent-group | panel | column-gap | space.2 |
| agent-group | panel | row-gap | space.1 |
| agent-group-label | panel | font-size | type.micro |
| agent-group-label | panel | color | color.muted |
| agent-option | panel | height | space.8 |
| agent-option avatar | panel | width | 28 |
| agent-option[data-active=true] | panel | background-color | color.hover |
| agent-option-desc | panel | font-size | type.small |
| agent-option-desc | panel | color | color.muted |
| agent-empty | no-match | font-size | type.small |
| agent-empty | no-match | color | color.muted |

#### 6.16.27 Quick actions

`QuickActions({ items, onPick, label? })` offers the selected agent's quick actions (agent profile
design §4.3); `items` are `{ id, title }` and the page keeps the bodies. It sits in the composer's
control row (`ComposerBox.quickActions`, §6.16.2), right after the effort picker (after the model
picker when the effort picker is hidden), so the new conversation's column holds no line of its own
between the agents row and the composer (maintainer decision, 2026-11-07). A conversation under way
offers its agent's quick actions in the same place; picking one fills the composer, never sends
(maintainer decision, 2026-11-08).

- **Button**: a ghost `IconButton` like the ＋ (`control.default` square, `muted` icon, `ink` on
  hover), the `zap` icon 16 (the line set, §3), named "常用任务" / "Common tasks" (its accessible name
  and tooltip). Shown only when the agent has quick actions; no items: nothing, and nothing takes its
  place.
- **Menu**: it opens the pickers' anchored menu (§6.16.3: below the button, or above it when the
  room below is short; at least the button's width, at most `min(320px, 100vw − 16px)`; capped at
  `layout.menu-max-height` with a filter past ten items), named like the button, one item per
  title in the agent's order, a long title cut with an ellipsis and whole in its tooltip.
- **Pick**: choosing one closes the menu, then `onPick(id)`: the page puts the body into the
  composer and focuses it (focus does not return to the button; on a touch device the text is placed
  without focus, §4.3); Escape closes the menu and returns focus to the button.
- **Listed on a phone** (`QuickActionList({ items, onPick, label? })`, maintainer decision
  2026-11-09): on a phone's new conversation the quick actions are listed on the page between the
  agents row and the composer (§5.4) instead of the `zap` button: a heading ("常用任务" / "Common
  tasks", `small` `muted`, 500) over plain rows, no box: each row a button 40 high, a `zap` 14
  `muted` then the title (`prose-small` `ink`, one line with an ellipsis), `line-soft` hairlines
  between rows. A tap calls the same `onPick` the menu does. No items: nothing.

<!-- states: quick-actions -->
States: `default`, `hover`, `menu`

<!-- size-table: quick-actions -->
| Part | State | Property | Value |
|---|---|---|---|
| quick-actions | default | width | control.default |
| quick-actions | default | height | control.default |
| quick-actions | default | color | color.muted |
| quick-actions[data-ref-forced=true] | hover | color | color.ink |
| menu | menu | background-color | color.panel |
| menu-item | menu | height | row.default |

#### 6.16.28 Agent map

`AgentMapDialog({ open, onOpenChange, level, onBack?, view?, children })` is a dialog over the conversation page
(agent map spec §9) whose width follows its level: one agent's summary and its transcript the
conversation's column plus the body padding and the border (`layout.chat` + 2 × `space.4` + 2 =
754, at most the window less 32), so the transcript's thread fills the dialog with no empty side
gutters and levels 2 and 3 are one width; the tree as wide as its tree needs (its columns of
nodes and their gaps, the body padding, the border and the canvas's reserved scrollbar gutter:
1042 + the gutter at three columns, 1057 with Chromium's 15 px classic scrollbars, 1042 with
overlay scrollbars), at least the width of levels 2 and 3 (the
head and legend fit, going back and forth does not jump narrower) and at most 1100 (and the window
less 32); a wider tree (four columns) scrolls sideways inside the canvas. Levels 2 and 3 have fixed heights, 600 and 640 (at most
the window less 32), so the dialog does not jump while an agent works (the §6.7 frame: `panel`,
`line-strong`, radius `md`, `shadow-2`, `scrim`). The frame has no padding at any level: the head,
body and footer pad themselves in the compact dialog rhythm of §6.7 (head `space.2` `space.4` with
1px `line-soft` below, body `space.4`, footer `space.3` `space.4`). Level 1's head is the title
"智能体图" / "Agent map" (`h2`, prose, 500) and close, over a body padded `space.4`
(`agent-map-content`) that holds the tree, or, while the page reads it, the page's loading bars
(`SkeletonBars`, state `loading`) or its error line (state `failed`); levels 2 and 3 draw their own
head with the same parts (one shared head: back, status dot, title, close, then meta lines).
Levels 1 and 2 are a dialog box (§1: what they hold draws its unboxed form); level 3's thread is a
pane, like `RightPanel`, so it renders exactly as in the main chat. Esc closes the tree and goes back one level
from levels 2 and 3 (`onBack`); focus is trapped and returned, and when the view changes (another
level or agent, `view`) it moves to the new head's back button, else its title.
`AgentMapTree({ root, background, selectedId, onOpen })` is level 1:

- **Count line** at the top of the body (prose, `muted`, `space.3` above the tree): "N 个智能体 · M 个运行中 · 点击查看详情" /
  "N agents · M running · Click a node for details" ("1 agent"); N counts the sub-agents, every
  node but the root (the conversation itself), M the running ones among them: the same number
  as the composer's agents chip (§6.16.29; AC3 ruling 4, 2026-11-07).
- **Tree**: columns left to right by depth, `space.6` apart; a parent is vertically centred on its
  children; standard elbow connectors (1px `line-strong`) from each parent to the vertical centre of
  each child; siblings `space.2` apart. No "main agent" or "level N" labels: position and lines
  show the hierarchy. Four columns (three levels below the root) are wider than the dialog: the
  tree scrolls inside it.
- **Node**: a button 320 wide and 62 high, the same for every node (padding 0 `space.3`, `panel-2`,
  1px `line`, radius `md`; hover `line-strong` on `hover`); line 1 the status dot and the
  description (500, `ink`); line 2 exactly "model · time · tokens" (`small`, `muted`, "opus 5.5 ·
  42分18秒 · 392.7k tokens"), indented past the dot. Both lines are one line with an ellipsis, and
  the node's tooltip is the full text. The root (the conversation itself) has `line-strong` on
  `raised`, no hover and is not a button: it has no summary to open and is never selected. The
  node open at level 2 has an `accent` border (`aria-current="true"`). Activating a node opens it
  (`onOpen`).
- **Status is only the dot** (8, round, `role="img"` with the status word as its label): running
  `accent`, pulsing every `motion.pulse` (still under reduced motion); waiting `warn`; completed
  `ok`; limit reached `warn` ("已达上限" / "Limit reached": the run ended on its step or time limit
  or its tree's token budget after handing back what it had, not a failure); failed `fail`; stopped
  `faint`. No status words in the tree (the exception to §2.4's icon and text rule): the **legend**
  at the bottom (`small`, `faint`, items `space.4` apart) names the six statuses.
- **Background tasks**: the root's own background tasks under the root column (320 wide, `space.4`
  below the tree): a heading "后台任务 · N" / "Background tasks · N" (`small`, `faint`) and one row
  per task (`row.default`, `panel-2`, 1px `line-soft`, radius `sm`, `small`): the dot, a `Bash` tag
  (the picker-menu tag: `micro` `muted` on `selected`), the description with an ellipsis and the
  duration in `faint`. None: nothing. A child's background tasks show only in its level 2.
- **Canvas**: the tree's scroll region is a labelled region ("智能体树" / "Agent tree") the
  keyboard can focus (`tabindex="0"`, the focus ring inset), so a tree wider than the dialog
  scrolls without a pointer.

`AgentDetail({ node, agentType, inBackground?, spawnedBy, latestText, task, background, toolCalls,
onBack, onClose, onOpenParent, onOpenTranscript, onStop?, stopping?, now? })` is level 2, one agent's summary, live at
the granularity of tool summaries. The dialog is 600 high (at most the window less 32), so it does
not jump while the agent works; head, body and footer pad themselves:

- **Head** (padding `space.2` `space.4`, 1px `line-soft` below): a dense back button
  (`arrow-left`, "返回智能体图" / "Back to the agent map"), the status dot, the description (`h2`,
  one line with an ellipsis) and close. Under it, indented past the back button (`control.dense` +
  `space.2`), three meta lines (`small`, `muted`): "运行中 · <agent type> · <model> · 后台" ("后台" only while `inBackground`, the
default: a fork skill's child runs in the foreground and has none);
  "由 <parent> 派出" / "Spawned by <parent>", the parent an underlined `ink` link that opens its
  node (`onOpenParent`); "<time> · <tokens>".
- **Body** (scrolls, padding `space.4`): the latest text (prose), then three collapsible
  sections, each a button (chevron, title 500, count `faint`) with `aria-expanded`: **任务 / Task**
  (the dispatch prompt, prose small `muted`, closed at first), **后台任务 / Background tasks · N**
  (the agent's own tasks, level 1's rows, closed at first) and **工具调用 / Tool calls · N** (open):
  the calls newest first, each a `row.dense` line: a dot slot (`space.2`; the running call's dot
  pulses), the tool name (500, at least 44 wide), its display summary (`muted`; the running one
  `ink`) with an ellipsis, and at the end in `faint` a range ("第 1–180 行") or the running call's
  clock. The section content starts under its title.
- **Footer** (padding `space.3` `space.4`, 1px `line-soft` above): "打开完整记录" / "Open transcript"
  and, while the agent runs (`onStop` given), "停止" / "Stop" (`danger`; stops its descendants too).
  The buttons share the row; a finished agent's "Open transcript" fills it.
- **Stopping** (`stopping`): from the click until the agent's terminal event arrives, until the
  request fails, or at most about 15 s (the page then reads the agent's log and the tree once more
  and lets Stop be pressed again; the stop is idempotent), Stop stays in its place in the Button's loading state (spinner, `disabled`,
  `aria-busy`, label unchanged, §6.1), even when `onStop` is absent; it
  never disappears and cannot be pressed again while the stop is under way.

`TranscriptFrame({ node, agentType, inBackground?, spawnedBy, onOpenParent?, contextPercent?,
onBack, onClose, onStop?, stopping?, children })` is level 3: the same head with one meta line ("<status> ·
<agent type> · <model> · 后台 · 由 <parent> 派出 · <time> · <tokens>"; "后台" as at level 2, the
parent the same link as at level 2 when `onOpenParent` is given), the thread (`children`: the conversation page's own
timeline components, built from `apps/web/src/lib/timeline.ts`) in the conversation's thread column
(`.cb-conv-thread`, at most `layout.chat`, inside padding `space.4`, scrolling; the dialog is
exactly that wide, so there are no side gutters), and instead of a composer a status line
(`row.dense`, padding 0 `space.4`, 1px `line-soft` above, `small`, `faint`): "上下文 N%" /
"Context N%" when known and, at the end of the line, a dense `danger` Stop while running (in its
loading state while `stopping`, as at level 2). No read-only copy: the missing composer says it. A
transcript with neither (a finished agent whose context use is unknown) has no status line. The
dialog is 640 high.

<!-- states: agent-map -->
States: `tree`, `deep`, `loading`, `failed`, `detail`, `finished`, `stopping`, `transcript`

<!-- size-table: agent-map -->
| Part | State | Property | Value |
|---|---|---|---|
| agent-map-dialog | tree | width | 1057 |
| agent-map-dialog | tree | min-width | 754 |
| agent-map-dialog | tree | max-width | 1100 |
| agent-map-dialog | deep | width | 1100 |
| agent-map-dialog | loading | width | 754 |
| agent-map-dialog | tree | background-color | color.panel |
| agent-map-dialog | tree | border-top-color | color.line-strong |
| agent-map-dialog | tree | border-radius | radius.md |
| agent-map-head | tree | padding-top | space.2 |
| agent-map-head | tree | padding-left | space.4 |
| agent-map-head | tree | border-bottom-color | color.line-soft |
| agent-map-title | tree | font-size | type.h2 |
| agent-map-content | tree | padding-left | space.4 |
| agent-map-content | tree | padding-top | space.4 |
| agent-map-count | tree | color | color.muted |
| agent-node | tree | width | 320 |
| agent-node | tree | height | 62 |
| agent-node[data-depth=1] | tree | background-color | color.panel-2 |
| agent-node[data-depth=1] | tree | border-top-color | color.line |
| agent-node | tree | border-radius | radius.md |
| agent-node[data-root=true] | tree | background-color | color.raised |
| agent-node[data-root=true] | tree | border-top-color | color.line-strong |
| agent-node[aria-current=true] | tree | border-top-color | color.accent |
| agent-node-name | tree | font-size | type.body |
| agent-node-meta | tree | font-size | type.small |
| agent-node-meta | tree | color | color.muted |
| agent-dot | tree | width | space.2 |
| agent-dot[data-status=waiting] | tree | background-color | color.warn |
| agent-dot[data-status=completed] | tree | background-color | color.ok |
| agent-dot[data-status=failed] | tree | background-color | color.fail |
| agent-task | tree | height | row.default |
| agent-task | tree | background-color | color.panel-2 |
| agent-task-tag | tree | font-size | type.micro |
| agent-task-tag | tree | background-color | color.selected |
| agent-task-time | tree | color | color.faint |
| agent-legend | tree | color | color.faint |
| agent-node | deep | height | 62 |
| agent-node[data-depth=3] | deep | width | 320 |
| agent-map-head | loading | border-bottom-color | color.line-soft |
| agent-map-content | loading | padding-left | space.4 |
| agent-map-content | loading | padding-top | space.4 |
| skeleton-bar | loading | height | space.3 |
| agent-map-content | failed | padding-left | space.4 |
| agent-map-content | failed | padding-top | space.4 |
| agent-map-dialog | detail | width | 754 |
| agent-map-dialog | detail | height | 600 |
| agent-map-head | detail | padding-top | space.2 |
| agent-map-head | detail | padding-left | space.4 |
| agent-map-head | detail | border-bottom-color | color.line-soft |
| agent-map-title | detail | font-size | type.h2 |
| agent-meta | detail | font-size | type.small |
| agent-meta | detail | color | color.muted |
| agent-parent | detail | color | color.ink |
| agent-section-head | detail | height | row.dense |
| agent-call | detail | height | row.dense |
| agent-call-tool | detail | font-size | type.body |
| agent-call[data-running=true] agent-call-summary | detail | color | color.ink |
| agent-call[data-running=true] | detail | height | row.dense |
| agent-call-clock | detail | color | color.faint |
| agent-call-range | detail | color | color.faint |
| agent-detail | detail | padding-left | space.4 |
| agent-detail | detail | padding-top | space.4 |
| agent-detail-foot | detail | padding-left | space.4 |
| agent-detail-foot | detail | padding-top | space.3 |
| agent-detail-foot | detail | border-top-color | color.line-soft |
| button[data-variant=danger] | detail | height | control.default |
| agent-detail-foot | finished | border-top-color | color.line-soft |
| agent-call-summary | finished | color | color.muted |
| button | finished | width | 720 |
| button[data-state=loading] | stopping | height | control.default |
| button[data-state=loading] | stopping | width | 354 |
| agent-map-dialog | transcript | width | 754 |
| agent-map-dialog | transcript | height | 640 |
| agent-transcript | transcript | padding-left | space.4 |
| thread | transcript | max-width | layout.chat |
| agent-transcript-status | transcript | height | row.dense |
| agent-transcript-status | transcript | color | color.faint |
| agent-transcript-status | transcript | border-top-color | color.line-soft |
| agent-transcript-status | transcript | padding-left | space.4 |
| agent-context | transcript | font-size | type.small |

#### 6.16.29 Agents chip

`AgentsChip({ count, running, waiting?, onOpen })` is the agent map's entry (acceptance item AC3,
maintainer ruling 2026-11-07, like Claude Code's "0 agents" chip). It sits in the composer's control
row (`ComposerBox.agents`, §6.16.2) after the effort picker and the quick actions, and replaces the
title bar's agent map icon (§6.16.1).

- **Shown** once the conversation has a sub-agent (a root conversation whose log dispatched one);
  never on the new conversation page or a sub-agent's own page (the tree is its root's). `count`
  0: nothing, and nothing takes its place.
- **Look**: a ghost picker (§6.16.2: `default`-step button, padding 0 `space.2`, `muted`, `hover`
  ground and `ink` on hover), no chevron (it opens a dialog, not a menu): the label "N 个智能体" /
  "N agents" ("1 agent"), its number (`agents-chip-number`) in `ink` at weight 500 with tabular
  figures and its words `muted`, so the count is what reads first. It always leads with a mark
  `space.2` before the label: the agent map's status dot (§6.16.28: 8, round, `role="img"`) while
  a sub-agent is active (running, queued included: the `accent` dot pulsing every `motion.pulse`;
  else, while one waits for a person, `warn`), else the `agent` icon 14 in the chip's `muted`.
  While some are active an activity part follows the label `space.2` after it,
  "· 3 个运行中" / "· 3 running" (else "· 2 个等待中" / "· 2 waiting"), its number in `ink` like the
  label's; it repeats the accessible name, so it is `aria-hidden`, and the dot alone carries the
  color (the `accent` text contrast is 3:1, too low for body text). It draws no box of its own
  inside the composer (one box is enough, §1). (Maintainer, 2026-11-07: "稍微来点设计感".)
- **Count**: N is every sub-agent of the conversation's tree, at every depth, at all times (the
  root is not counted; the map's count line shows the same N, §6.16.28). The page reads the agent
  tree with the conversation (the server prefetches it for the first paint) and again on every
  sub-agent event of the root's log and on the progress of an agent the tree lacks; the stream's
  progress and the log's waits count an agent at once. The dot says whether any runs; the running
  count goes into the accessible name and the tooltip: "3 个智能体，1 个运行中" / "3 agents,
  1 running", then "，N 个等待中" / ", N waiting" while some wait. A child of the conversation that
  is active with nothing below it that counts is working itself (a stale tree never drops the
  dot).
- **Below 640** (state `narrow`): the mark (the dot, or the `agent` icon 14 when nothing is
  active) and the count alone ("● 3"), without the label and the activity part; the full text
  stays its accessible name and tooltip. The chip and the icon
  buttons keep their size; a picker's label gives way with an ellipsis (§6.16.2), so the send
  button stays inside the composer with the model, effort, quick actions and the chip.
- **Open**: activating it (click, Enter, Space) opens the agent map at its root level (`#agents`;
  `aria-haspopup="dialog"`); the map keeps its keyboard and Esc behaviour, and focus returns to the
  chip when it closes. The sub-agent group's "智能体图" / "Agent map" link (§6.16.15) stays.

<!-- states: agents-chip -->
States: `default`, `running`, `waiting`, `hover`, `narrow`

<!-- size-table: agents-chip -->
| Part | State | Property | Value |
|---|---|---|---|
| agents-chip | default | height | control.default |
| agents-chip | default | padding-left | space.2 |
| agents-chip | default | color | color.muted |
| agents-chip-number | default | color | color.ink |
| agents-chip-icon | default | color | color.muted |
| agents-chip | running | height | control.default |
| agent-dot | running | width | space.2 |
| agent-dot | running | background-color | color.accent |
| agent-dot | waiting | width | space.2 |
| agent-dot | waiting | background-color | color.warn |
| agents-chip[data-ref-forced=true] | hover | background-color | color.hover |
| agents-chip[data-ref-forced=true] | hover | color | color.ink |
| agents-chip | narrow | height | control.default |
| agents-chip-count | narrow | font-size | type.body |
| agents-chip-count | narrow | color | color.muted |
| agent-dot | narrow | width | space.2 |
| agent-dot | narrow | background-color | color.accent |

---

### 6.17 ObjectList and ObjectRow

`ObjectList({ label, children })` is the panel of an object list: a `ul` on the `panel` ground, 1px `line-soft` border, radius `md`, rows split by `line-soft`. `ObjectRow` is one `li`, at least 64 px high, padding `space.3` / `space.4`, `space.3` between its parts:

- A 36 px mark (radius `md`, `selected` ground; an agent's row draws its `Avatar` 28 centred in that place on no ground, `mark.avatar`, §6.30): the one avatar-tile rule, the upper-cased first grapheme of the display name in 600 (mono like the whole UI; `initialOf`, as the org switcher and the account row), for extensions and plugins too; an icon only for rows that are steps, not objects (the setup page); `tone="warn"` tints it with `warn` at 15% when the object needs attention.
- **A plugin's icon as the mark** (maintainer decision 2026-11-08): a thing a plugin brings (a channel connection, an extension, a model provider) may take the icon its plugin declares (`plugin.json` `icon`, served only by the kernel's catalog icon routes) as its mark: `mark.image` here, `avatar: { image }` on an `ObjectCard` (§6.34), `image` on a `CellTitle` (§6.6), `mark` on an `ItemList` row (§6.33) and a `Sheet` head (§6.7), and `ObjectMark` (24 / 28 / 40) on its own (a page head's `avatar`). The icon is an `<img alt="">` (decorative: the name is written beside it), contained on the same `selected` tile (24 in the 36 and 40 tiles, 20 in the 28 tile, 16 in the 24 tile), never cropped, never inlined. Without an icon, or when it fails to load, the tile draws the initial as above: objects without one keep the initial. Never an icon of our own for an object (the rule above stands); the plugin's own picture is not one.
- Text column: line 1 the name (600; a link when `href`; `mono` for package names) and chips (`small`, 1px `line` border, radius `sm`; `tone="warn"` draws the warn tint without a border). A chip is a scope or an attention mark (组织共享, 敏感); plain facts such as a version or 必需 are meta text, never a chip; line 2 the description in `muted` prose, one line with an ellipsis; line 3 the meta in `faint`, `small`, one line.
- At the right: a state label (`state`: `ok` / `warn` / `fail` colored, `muted` in `faint`), a short `trailing` text in `faint`, one row action (`action`: a `default` dense button or link, never `primary`: the page head holds the one primary of the screen, and a row that needs attention says so in its `state`) and the `more-horizontal` overflow menu (`menu`). Below 640 (phones, maintainer decision 2026-11-09) the row is compact, so a plugin takes the lines it needs and no more:
  - line 1 is the mark, the name and its chips, and the `more-horizontal` menu at the right (the mark overhangs the line into the indent of the lines below, as the text column sits beside it above 640);
  - the description and the meta line follow under the name; the **state closes the meta line** (`1 个扩展 · 平台 · 组织自选 · 已启用`) in its tone (`ok` / `warn` / `fail`; `muted` in `faint`), with no line of its own; a row with a state and no meta draws a meta line for it on phones only; a long meta line takes the ellipsis, never the state;
  - the row action (and a lone menu item drawn as a button) is one group, `dense`, at the right of the meta line, or, when the meta line and the action do not fit together, under it at the right; no action, no space;
  - the action and the menu keep their dense look and reach a 40 × 40 tap target through an invisible ring around them;
  - the DOM keeps the order name link, action, menu (the tab order); the state is read from the meta's `data-state` / `data-state-tone` (generated content), so the label stays one node, and the row's own state label is hidden on phones. The skeleton rows keep their shape.
- **Pending**: while an action of the row runs (a switch, a preview call), the row's buttons are disabled until it settles; the running one shows the Button's loading state (`action.loading`: the `spinner` before its label, `aria-busy`), or, when the running action came from the menu (`busy`), the menu button draws the `spinner` in place of `more-horizontal` (`aria-busy`; a lone menu item drawn as a button carries the loading state itself). Never a click that seems to do nothing.
- **Loading** (`ObjectList.loading`, `true` for 3 rows or a row count; `ListPage.loading` on a list page): the panel draws skeleton rows in the row's shape instead of its rows (the same `.cb-object-row` box, 64 px at least, with its divider and first-row rule): a `mark` box (36 × 36, radius `md`, §6.29) and a name line and a description line in the text column, `body` bars 30% and 55% wide in the one bar look (§6.29), and the list is `aria-busy` with a hidden "正在加载 / Loading" (none of its own inside a skeleton group, which announces once). It wins over `empty`, so no empty state flashes before the first answer; a `records` ListPage draws the DataTable's loading state in the caller's table shape, else a Skeleton (§6.29), instead.

### 6.18 EmptyState

One empty state for the whole product, in three styles. `EmptyState({ text, hint?, action?, size? })`:

- **Illustration**: the pixel capybara of §3 drawn as a line (`LogoLine`: the outer edges of the bitmap's cells, the eye included, 1 px `faint` stroke, no fill), decorative, on the `page` and `panel` styles (never `compact`). No other art or icon stands in for it (a search that matched nothing is the same style with its own sentence).
- **Copy**: one sentence in `ink` (prose font) saying what will be here ("还没有 agent" / "No agents yet"), an optional second line in `muted` (`small`, prose font), and at most one action, the primary next step (a `default` or `primary` button or link). A `primary` action here is the screen's one primary: `ListPage` hides the head's primary while it is shown (§5.1). Never a table header over an icon, never a sentence about the absence of data in general ("暂无数据" is only the DataTable's fallback).
- **Styles**: `page` (default) is the line-art capybara over the words, centered in the content frame, no frame of its own, `space.8` × 2 above and below, the illustration at scale 6 (85 × 61). `panel` (an empty region inside a box) is the same centered look sized down: the illustration at scale 4 (57 × 41), the sentence (+ hint) centered under it, the action `dense`, `space.8` above and below and `space.2` at the sides so it fits the 240 px sidebar. `compact` is the words alone, no art: left-aligned with `space.3` padding (none inside a card body, which pads it already) and `space.2` gaps, the action `dense`; inside a DataTable it is centered horizontally in the table body instead (§6.6).
- **Where** (maintainer decision 2026-11-08, acceptance): the style follows the space the empty state fills, never the caller's taste.
  - `page`: a page or settings content area with nothing to show: every ListPage / ObjectList / CardGrid empty (`ListPage.empty`), the InboxPage with no items (the page state instead of the list + detail split, §5), a settings page whose list is empty (我的连接: "没有需要你个人凭据的连接器。" + hint; an agent's 渠道 section on the page ground: "这个智能体还没有接入渠道。" with 接入渠道 for an org admin), a page search matching nothing (市场源: "没有匹配的市场源。" + 清除搜索), a wizard step with nothing to fill, an extension's own page whose view is empty.
  - `panel`: an empty region inside a box: an `ItemList` with no rows (§6.33: a template's tools / skills / connectors, a deployment config's org copies), an empty Card or FormSection card (no model providers, no tools to review, no agent to bind, no custom marketplace), a Sheet or Dialog whose list is empty (a tool group without tools, no member to reassign to, no evaluation set, no connector to bind), a ToolPolicyList filter matching nothing (§6.36), the span waterfall with no spans (§6.10), the sidebar's conversation list ("还没有会话" + 新会话, the archived list's "没有已归档的会话", a filter matching nothing: "没有匹配的会话" + 清除筛选), and an extension's schema view with nothing to show in a properties section, a right panel, an inline card or a file preview (§6.16.17): no blocks, or only a checklist / key-value list / table without items, draws one panel empty state with the host's sentence "这里还没有内容。" / "Nothing here yet." (the UiView contract carries no empty text), and an empty checklist or key-value list among other blocks draws the same in its place. A properties section whose view is empty still shows, with its header and this state.
  - `compact`: only where the space is one line: the DataTable's empty and no-results areas (§6.6, centered in the table body, the same in every table, an extension's table block too). A line inside a form field (a checkbox group with nothing to pick: "组织还没有技能。"), a Repeater with no items (§6.26), a ContentSection's or an ImpactPreview's empty line (a fact in a summary, §6.31, §6.35) and a menu or palette matching nothing are not empty states: they stay one muted line.
  - The action stays `default` (dense in `panel` and `compact`) unless it is the page's one primary.

### 6.20 PendingState

`PendingState({ frame?, delayMs? })`: the neutral loading state of a page whose outcome is not known yet (the app frame before it knows whether to draw the shell or the setup layout). It draws nothing shaped like any of the outcomes (no sidebar, no composer outline, no checklist): only the `bg` ground, a `status` region marked busy with a hidden "正在加载 / Loading", and after 300 ms (`PENDING_DELAY_MS`) three quiet bars in the one bar look of §6.29 (`space.3` high on the `selected` ground, radius `sm`; 30 %, 70 %, 45 % wide) in a centered chat-width column. `frame="app"` fills the window, `page` the content area. Rule: never show a placeholder shaped like one of two possible outcomes; skeletons in the frame's shape are for loads whose frame is already known (§6.17).

### 6.19 Callout

`Callout({ tone, action?, children })`: a `role="status"` bar naming what needs action, radius `md`, padding `space.3` / `space.4`: a `circle-alert` icon, the sentence, and one dense button or link. `warn` uses the `warn` tint (15%) and a `warn` icon; `fail` the `fail` tint (12%) and icon. On list pages it sits in the header between the title row and the tabs (`ListPage.callout`). `info` is the quiet form for a standing fact about the page rather than something to fix (the admin overview's "超级管理员不能查看会话内容。"): a `role="note"` on the `panel` ground, `muted` text, a `faint` icon, usually no action; it sits first in the page body, under the head. The tinted bar is a box (§1), so **inside a box it draws its unboxed form by itself**, as a CodeBlock drops its line (§6.9): inside a card, a form card, a Dialog or a Sheet (any `BoxScope`) it is the `warn` / `fail` line with its icon, `data-framed="false"`: no tint, no padding, no radius, the 12 px `circle-alert` on the first line, the sentence in the prose font at `prose-small` in the tone's colour (`info`: `muted`, `faint` icon), the action at the right `space.2` after it; still a `status` (`note`). So a panel drawn both on a page and in a Sheet (an extension's failed replicas, its missing config, a plugin's permission mismatch) passes a Callout and gets the tinted bar on the page and the line in the Sheet. A notice about a whole section still stands above the section's card (between the section head and the card on a stacked section, or above the section), never as its first line.

<!-- states: callout -->
States: `warn`, `info`, `in-box`

<!-- size-table: callout -->
| Part | State | Property | Value |
|---|---|---|---|
| callout | warn | padding-left | space.4 |
| callout | warn | padding-top | space.3 |
| callout | warn | border-top-left-radius | radius.md |
| callout | info | padding-left | space.4 |
| callout | info | color | color.muted |
| callout | in-box | padding-left | 0 |
| callout | in-box | padding-top | 0 |
| callout | in-box | border-top-left-radius | 0 |
| callout | in-box | color | color.warn |
| callout-text | in-box | font-size | type.prose-small |
| callout-text | in-box | line-height | type.prose-small.line |

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

`FilePicker({ dropLabel, onFiles, label?, hint?, accept?, multiple?, disabled?, children? })`: the one file pick of a form or a flow (上传技能, the extension package of 安装扩展, the plugin package of 导入插件), never a bare `+` icon button. A drop zone (`FileDrop`: dragging a file over it draws the `dropLabel` overlay, a drop or a paste hands the files over) drawn as a 1px dashed `line-strong` box, radius `md`, `panel` ground, padding `space.6` / `space.4`, its content centered in a column `space.2` apart: the `upload` icon (16, `faint`), a `default` button with words ("选择文件" / "Choose file"; `label` names the type, "选择 .zip 文件") that opens the system picker, and a `small` prose `muted` hint ("或拖放到这里。" / "or drop it here."; `hint` overrides). What is chosen or happening (the file's `AttachmentChip` with its progress, a cancelled note) goes inside the zone under the hint (`children`). Disabled: the button disabled, the border `line`, drops ignored. Choosing between sources (upload / npm / git) above it uses card radios (§6.3 option cards) in a `Card` on a page, as every install and import flow does; in a Dialog the card radios and the drop zone stand straight in the dialog's body, with no Card around them (§1, §6.7). A FilePicker is allowed inside a Dialog (a drop target, not a group); inside a Card or a form card it is a second box (`web-ui-box-in-box`).

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

### 6.26 Repeater

`Repeater({ label, items, addLabel, onAdd, presets?, onRemove, onMove?, onToggle?, min?, max?, disabled?, empty?, variant?: "cards" | "divided" | "rows" })` with `RepeaterItem { key, title?, subtitle?, body, invalid?, collapsed? }`: an array of objects in a config form (an extension's endpoints, an endpoint's models; config forms spec §5). A `group` named by `label` around a list (`ul`) of items, `space.2` apart; each item is a `group` named by its title (an untitled item by its position, "第 2 项" / "Item 2").

- **Cards** (`variant="cards"`, default): a 1px `line` hairline card, radius `md`, no fill (the form card's `panel` shows through). The head is one line at least `row.default` high, split from the body by `line-soft`: the drag handle (`grip-vertical` 14, `faint`, only with `onMove`), a collapse chevron (`chevron-down` / `chevron-right`, a dense icon button with `aria-expanded`, only with `onToggle`), the title (`body`, 500, `ink`, one line with an ellipsis), the subtitle after it (`small`, `muted`, mono, one line with an ellipsis; a template such as `{baseUrl}`), and at the right the dense icon buttons move up / move down (`arrow-up` / `arrow-down`, only with `onMove`) and remove (`trash-2`), each named with the item ("上移 deepseek", "移除 deepseek"). The body holds the item's fields, padding `space.3`, `space.3` between fields. A `collapsed` card (with `onToggle`) draws only its head. An `invalid` card's border is `fail`.
- **Divided** (`variant="divided"`, and what `cards` draws inside a box: a form card, a Card, a Dialog or Sheet; §1): no border, no radius, no fill; the items are split by `line-soft` hairlines, each item `space.3` above and below (the first none above), its head line as the card's (handle, chevron, the title in `body` 500, the subtitle, the actions at the right) with no rule under it and no padding of its own, the body `space.2` below it and indented so its fields start where the title starts: one lead (`control.dense` + the head's `space.2` gap; the handle takes a `control.dense` slot here) for the handle and one for the chevron, none without them. A Repeater nested in an item's body (an endpoint's models) is a nested group like a Subsection's content (§6.32): a 1px `line` guide on its left, indented `space.2`, around its items and its add button, so each level of the list sits one step in (endpoint titles and 「添加端点」; the endpoint's fields, the model titles and 「添加模型」 inside the guide; the model's fields). The page-ground `cards` form keeps its body padding (`space.3`) and draws no guide: the card's frame already sets a nested list one level in. An invalid item carries a 2px `fail` bar `space.2` left of the item, in the box's padding. Keyboard focus draws the list item ring (`outline: 1px solid accent; outline-offset: -1px`, §2.5); a drop target gets the `hover` ground. So `cards` is the page-ground form only.
- **Rows** (`variant="rows"`): compact items without a head, one `FieldRow` (§6.27) each, `space.2` above and below, split by `line-soft`; the handle and the actions sit at the row's ends on the inputs' line (below the first row's labels); an invalid row carries a 2px `fail` bar on its left. Titles only name the rows. A row whose body has no field labels (a list of names, each a button) keeps its handle and actions on its own line on the first row too.
- **Footer**: a dense `default` button with `plus` and the caller's words, which name what it adds ("添加端点" / "Add endpoint", "添加模型"; never a bare "添加" next to another list's). It sits `space.2` below the list's gap (`repeater-foot` `margin-top` `space.2`), aligned with the list's left edge, so the button of a list reads as the list's own; the add button of a nested list (a Repeater inside an item's body) has no extra margin and sits inside its item's frame (inside a box: inside the nested list's guide, one level right of the outer list's button), so it never reads as a pair with the outer list's button. With `presets` it opens a menu (§6.7) of the presets, each with its help as the item's description, then a separator and "空白" / "Blank"; the button carries a `chevron-down` after its words. `onAdd(presetId?)` gets the preset's id, or nothing for a blank item. After an add, focus goes to the new item's first empty required field (`aria-required`; a preset filled the others), else its first field, else the item.
- **Remove** acts at once: `onRemove(key)` removes the item and returns a restore function; the Repeater shows a success toast "已移除「deepseek」。" / `Removed "deepseek".` whose "撤销" / "Undo" action calls it (the toast stays 8 s). Focus moves to the next item (else the previous, else the add button).
- **Reorder** (`onMove(key, to)`): the move buttons, dragging a card by its handle, or Alt+↑ / Alt+↓ anywhere inside a focused item; focus stays on what had it (a move button that became disabled hands it to its sibling). Move up is disabled on the first item, move down on the last.
- **Limits and states**: remove is disabled while there are `min` items or fewer (its tooltip and accessible description then say why: 「至少保留 {min} 项」 / "Keep at least {min}"; its name stays 「移除 deepseek」), add while there are `max` or more. Without items the list gives way to `empty` (`prose-small`, `muted`). `disabled` (a field given by the startup config) disables add, remove, move and dragging, and hides the handle.

<!-- states: repeater -->
States: `default`, `rows`, `invalid`, `empty`, `divided`, `nested`

<!-- size-table: repeater -->
| Part | State | Property | Value |
|---|---|---|---|
| repeater | default | row-gap | space.2 |
| repeater-item | default | border-radius | radius.md |
| repeater-item | default | border-top-color | color.line |
| repeater-head | default | height | row.default |
| repeater-head | default | border-bottom-color | color.line-soft |
| repeater-title | default | color | color.ink |
| repeater-title | default | font-size | type.body |
| repeater-subtitle | default | color | color.muted |
| repeater-subtitle | default | font-size | type.small |
| repeater-body | default | padding-top | space.3 |
| repeater-remove | default | width | control.dense |
| repeater-add | default | height | control.dense |
| repeater-foot | default | margin-top | space.2 |
| repeater-item | rows | padding-bottom | space.2 |
| repeater-item | invalid | border-top-color | color.fail |
| repeater-empty | empty | color | color.muted |
| repeater-empty | empty | font-size | type.prose-small |
| repeater-item | divided | border-left-width | 0 |
| repeater-item | divided | border-top-left-radius | 0 |
| repeater-head | divided | border-bottom-width | 0 |
| repeater-head | divided | padding-left | 0 |
| repeater-title | divided | font-size | type.body |
| repeater-title | divided | color | color.ink |
| repeater-body | divided | padding-top | space.2 |
| repeater-body | divided | padding-left | space.7 |
| repeater-handle | divided | width | control.dense |
| repeater-body | nested | padding-left | space.7 |
| repeater-body repeater | nested | padding-left | space.2 |
| repeater-body repeater | nested | border-left-width | 1 |
| repeater-body repeater | nested | border-left-color | color.line |
| repeater-body repeater-body | nested | padding-left | space.7 |
| repeater-body repeater-foot | nested | margin-top | 0 |

### 6.27 FieldRow

`FieldRow({ children, advanced?, first?, defaultAdvancedOpen? })`: a compact row of small fields for an object whose form hints say `layout: "row"` (a model: ID, context window, max output, the capability checkboxes). The fields (`Field`s) share the row equally, `space.3` apart; a row's checkboxes go in one `FieldRowGroup({ label, children })`: a `group` named by its label ("能力" / "Capabilities"), drawn above the boxes like a field's label (`body`, `ink`, the label head's 20 px) and, like it, on the first row only; the boxes sit side by side on the inputs' line (`control.default` high, `space.3` apart, wrapping), the group at its own width. Other non-field children (a lone checkbox) keep their own width and sit on the inputs' line. Labels are drawn on the first row only (`first`); later rows keep them as the fields' accessible names, out of sight, so a list of rows reads as one table. With `advanced`, a "高级" / "Advanced" toggle ends the row (`small`, `muted`, a `faint` `chevron-right` / `chevron-down` 12 after the words, `aria-expanded`, `aria-controls`; `ink` on a `hover` ground); open, the advanced fields follow under the row, `space.2` below, wrapping at their own width under a 1px `line` guide on the left, indented `space.2` (the Disclosure body, §6.5), their labels always drawn; `defaultAdvancedOpen` starts it open (an issue inside it). **Below 640** the row stacks: one field per line, `space.2` apart, every label drawn; consecutive rows are split by `line-soft` with `space.2` above.

<!-- states: field-row -->
States: `first`, `advanced-open`, `narrow`

<!-- size-table: field-row -->
| Part | State | Property | Value |
|---|---|---|---|
| field-row-fields | first | column-gap | space.3 |
| field-label | first | font-size | type.body |
| field-row-toggle | first | height | control.default |
| field-row-group-label | first | font-size | type.body |
| field-row-group-label | first | color | color.ink |
| field-row-group-items | first | height | control.default |
| field-row-group-items | first | column-gap | space.3 |
| field-row-toggle | first | color | color.muted |
| field-row-more | advanced-open | padding-left | space.2 |
| field-row-more | advanced-open | border-left-color | color.line |
| field-row-fields | narrow | row-gap | space.2 |

### 6.28 KeyValueEditor

`KeyValueEditor({ label, value, onChange, keyLabel, valueLabel, disabled?, maskValues? })`: a record of scalars without form hints (request headers, labels) as rows of two dense inputs, the key (2 parts) and the value (3 parts), and a dense remove icon button (`trash-2`, "移除 X-Org" / "Remove X-Org"; an empty key is named by its row), `space.2` apart both ways. A `group` named by `label`; above the rows a line of column labels (`keyLabel`, `valueLabel`; `small`, `muted`; hidden from screen readers, the inputs are named "名称 1", "值 1"). Under them a dense `default` "添加" / "Add" button with `plus` appends an empty row and focuses its key. Without rows only the button is drawn. `disabled` disables the inputs and both buttons. `maskValues` (a secret record, such as API keys by name) draws the values as password inputs (`autocomplete="new-password"`), the keys as text. `value` is an ordered list of pairs; duplicate or empty keys are the form's to validate.

<!-- states: key-value-editor -->
States: `default`, `empty`, `masked`

<!-- size-table: key-value-editor -->
| Part | State | Property | Value |
|---|---|---|---|
| kv-editor | default | row-gap | space.2 |
| kv-editor-row | default | column-gap | space.2 |
| kv-editor-head | default | color | color.muted |
| kv-editor-head | default | font-size | type.small |
| input | default | height | control.dense |
| kv-editor-add | default | height | control.dense |
| kv-editor-add | empty | height | control.dense |
| input | masked | height | control.dense |

### 6.29 Skeleton

The placeholder primitives every loading state is built from, so a template's loading state is shaped like its loaded page (§5): `SkeletonText`, `SkeletonBox` and `SkeletonGroup`. **Nothing here animates**, in any motion mode (no shimmer, no pulse), so the reduced-motion rule of §6.11 holds without a special case.

- **One bar look**: a skeleton bar is `space.3` (12 px) high on the `selected` ground, radius `sm`: the look of DataTable's (§6.6) and the sidebar's (§6.13) bars. Every bar of every loading state has it; there is no second bar.
- `SkeletonText({ width, size? })`: a **slot** exactly one line box of its type size high, `body` (default, `type.body.line`), `small` (`type.small.line`), `title` (the h1 size, `type.h1.line`), `heading` (the h2 size, `type.h2.line`), `prose` (a thread's prose line, `type.prose.line`) or `metric` (the StatCard value size, `type.metric.line`), so the layout is the loaded one and nothing moves when the text arrives. The slot holds one bar (the look above) centred vertically, as wide as the slot. `width` is `30%`, `45%`, `55%`, `70%`, `100%` or a pixel number.
- `SkeletonBox({ part, height?, width? })`: a block shaped like a control or a mark, on the `selected` ground, radius `sm`. `part` is `dense`, `default` or `prominent` (the control height of §2.5), `mark` (36 × 36, radius `md`, the ObjectRow mark) or `block` (`height` pixels, default 96). `width` is pixels; without it the box fills its container.
- `SkeletonGroup({ label, children })`: the busy region: `role="status"` named by `label`, `aria-busy="true"`, and one hidden "正在加载 / Loading". A group inside a group, and a component that draws its own loading state (PageHeader, ObjectList), adds no second announcement; the bars and blocks themselves are `aria-hidden`. The group draws no box of its own (`display: contents`).
- **One look everywhere**: the bars of DataTable (§6.6), the sidebar (§6.13), ObjectList (§6.17), `Skeleton({ rows })` (stacked full-width `body` slots, `space.2` apart; the dialogs' and panels' placeholder rows), PendingState (§6.20) and a block's loading bars (§6.16.16, §6.16.18) are all this bar: `space.3` high, `selected`, radius `sm`. Placeholders that stand in for text of a known line are `SkeletonText` slots; the older looks (20 px rows and 12 px bars on the `hover` ground) are gone.
- Rule: a skeleton takes the size of what replaces it (a line of text its line box, a control its control height), so the swap moves nothing; no skeleton stands in for text whose width could change the layout of its row.

<!-- states: skeleton -->
States: `text`, `box`, `group`

<!-- size-table: skeleton -->
| Part | State | Property | Value |
|---|---|---|---|
| skeleton-text[data-size=title] | text | height | type.h1.line |
| skeleton-text[data-size=body] | text | height | type.body.line |
| skeleton-text[data-size=small] | text | height | type.small.line |
| skeleton-text[data-size=prose] | text | height | type.prose.line |
| skeleton-bar | text | height | space.3 |
| skeleton-bar | text | background-color | color.selected |
| skeleton-bar | text | border-radius | radius.sm |
| skeleton-box[data-box=dense] | box | height | control.dense |
| skeleton-box[data-box=default] | box | height | control.default |
| skeleton-box[data-box=prominent] | box | height | control.prominent |
| skeleton-box[data-box=mark] | box | width | 36 |
| skeleton-box[data-box=mark] | box | height | 36 |
| skeleton-box[data-box=default] | box | background-color | color.selected |
| skeleton-text[data-size=body] | group | height | type.body.line |
| skeleton-box[data-box=default] | group | height | control.default |

### 6.30 Avatar and AvatarPicker

An agent's picture, everywhere an agent appears (the new conversation page, the agent picker, the agent list rows, the agent page head, the conversation title bar, the sidebar group titles; agent profile design §2.3).

- `Avatar({ value, name, size })`, `size` 16, 24, 28, 40 or 64, a square of that size. `value` is one of:
  - `{ kind: "preset", id }`: one of the ten pixel animals (`AVATAR_PRESETS`): 水豚 / Capybara, 黑熊 / Black bear, 熊猫 / Panda, 大象 / Elephant, 狐狸 / Fox, 猫头鹰 / Owl, 企鹅 / Penguin, 兔子 / Rabbit, 乌龟 / Turtle, 鲸 / Whale (ids `capybara`, `black-bear`, `panda`, `elephant`, `fox`, `owl`, `penguin`, `rabbit`, `turtle`, `whale`). Each is a 12×12 bitmap drawn like the Logo (§3: solid squares, `shape-rendering: crispEdges`, no outline, no anti-aliasing), one SVG path per palette color, on its ground color. The palette values and the ground are token names (`avatar-*`, and `accent` for the capybara, §2.1), so no color literal is involved. The pixel unit is the whole number nearest to `size / 12` (16: 1, 24: 2, 28: 2, 40: 3, 64: 5), the drawing centred in the square; every size holds the whole drawing, nothing is clipped.
  - `{ kind: "image", src }`: the uploaded image, covering the square; when it fails to load, the initial.
  - `null`: the initial square, the avatar tile rule of §6.17: the first grapheme of `name` (`initialOf`), 600, `ink` on `selected`; `micro` at 16, `small` at 24 and 28, the h2 size at 40, the h1 size at 64.
  - Radius `sm`, `md` at 64. The avatar is decorative (`aria-hidden`): the name is always written next to it.
- `AvatarPicker({ value, onChange, onUpload?, uploadOffReason?, label?, disabled? })` (`disabled`: every tile disabled while the owner saves, the value still shown): the ten presets as one radio group (named `label`, default "头像" / "Avatar"; each radio named by its preset's name), 48 px tiles (a 40 avatar, 3 px padding, a 1 px border, radius `md`) `space.2` apart and wrapping, then an upload tile (`upload` icon, "上传图片" / "Upload image"; `line` dashed border) that opens a file dialog for png, jpg or webp and passes the file to `onUpload` (cropping and the 2 MB limit are the caller's). A checked tile is neutral (§2.3): `selected` ground and a `line-strong` border; hover is the `hover` ground; keyboard focus the accent ring. When `value` is an image, the upload tile shows it and is the checked one; if that image fails to load, the tile shows the `upload` icon again. Without `onUpload` the upload tile is disabled (`disabled` icon color) and `uploadOffReason` (default "这里不能上传图片。" / "Uploading is not available here.") is written under the tiles in `small` `muted`, and describes the tile; presets still work.

<!-- states: avatar -->
States: `presets`, `sizes`, `initial`, `title-bar`, `sidebar-row`, `list-row`, `picker`, `picker-upload-off`

<!-- size-table: avatar -->
| Part | State | Property | Value |
|---|---|---|---|
| avatar | presets | width | 40 |
| avatar | presets | height | 40 |
| avatar | presets | border-top-left-radius | radius.sm |
| avatar[data-preset=capybara] | presets | background-color | color.avatar-capybara-ground |
| avatar[data-preset=black-bear] | presets | background-color | color.avatar-black-bear-ground |
| avatar[data-preset=panda] | presets | background-color | color.avatar-panda-ground |
| avatar[data-preset=elephant] | presets | background-color | color.avatar-elephant-ground |
| avatar[data-preset=fox] | presets | background-color | color.avatar-fox-ground |
| avatar[data-preset=owl] | presets | background-color | color.avatar-owl-ground |
| avatar[data-preset=penguin] | presets | background-color | color.avatar-penguin-ground |
| avatar[data-preset=rabbit] | presets | background-color | color.avatar-rabbit-ground |
| avatar[data-preset=turtle] | presets | background-color | color.avatar-turtle-ground |
| avatar[data-preset=whale] | presets | background-color | color.avatar-whale-ground |
| avatar[data-size=16] | sizes | width | 16 |
| avatar[data-size=16] | sizes | height | 16 |
| avatar[data-size=24] | sizes | width | 24 |
| avatar[data-size=28] | sizes | width | 28 |
| avatar[data-size=40] | sizes | width | 40 |
| avatar[data-size=64] | sizes | width | 64 |
| avatar[data-size=64] | sizes | height | 64 |
| avatar[data-size=64] | sizes | border-top-left-radius | radius.md |
| avatar | initial | background-color | color.selected |
| avatar | initial | color | color.ink |
| avatar[data-size=24] | initial | font-size | type.small |
| avatar[data-size=28] | initial | font-size | type.small |
| avatar[data-size=40] | initial | font-size | type.h2 |
| avatar | title-bar | width | 16 |
| avatar | title-bar | height | 16 |
| group-label avatar | sidebar-row | width | 16 |
| group-label avatar | sidebar-row | height | 16 |
| avatar | list-row | width | 28 |
| avatar | list-row | height | 28 |
| avatar-tile | picker | width | 48 |
| avatar-tile | picker | height | 48 |
| avatar-tile[data-state=checked] | picker | background-color | color.selected |
| avatar-tile[data-state=checked] | picker | border-top-color | color.line-strong |
| avatar-tile[data-state=checked] avatar | picker | width | 40 |
| avatar-upload | picker | width | 48 |
| avatar-upload | picker | border-top-color | color.line |
| avatar-upload | picker-upload-off | color | color.disabled |
| avatar-upload-reason | picker-upload-off | color | color.muted |
| avatar-upload-reason | picker-upload-off | font-size | type.small |

### 6.31 ContentSection

`ContentSection({ title, count?, description?, actions?, empty?, children })`: one section of a detail page's single column or a review (a plugin's components: 扩展, 技能, 连接器模板, 依赖; 许可证 …). A `region` named by its heading, the parts `space.2` apart:

- **Heading row**: the title as an `h2` in the `h2` step (16 / 24, 500, `ink`), so it reads as a heading over the lines under it, then the optional `count` (`small`, `faint`, tabular), then optional `actions` at the right (dense buttons or links).
- **Help** (`description`): one line in the prose font, `small`, `muted`.
- **Content**: the children; or, when the section holds nothing, the `empty` line instead (prose font, `small`, `muted`: "没有扩展。"). Secondary text under a heading is always this muted small style, never the heading's size and color.

<!-- states: content-section -->
States: `default`, `empty`

<!-- size-table: content-section -->
| Part | State | Property | Value |
|---|---|---|---|
| content-section | default | row-gap | space.2 |
| content-section-title | default | font-size | type.h2 |
| content-section-title | default | line-height | type.h2.line |
| content-section-title | default | color | color.ink |
| content-section-count | default | color | color.faint |
| content-section-description | default | font-size | type.small |
| content-section-description | default | color | color.muted |
| content-section-title | empty | font-size | type.h2 |
| content-section-empty | empty | font-size | type.small |
| content-section-empty | empty | color | color.muted |

### 6.32 Subsection

`Subsection({ title, count?, description?, actions?, variant?: "guide" | "flush", children })`: a group inside one box, where a second Card would have stood (§1 principle 7): a nested config object in a form card, an advanced group in a Sheet, one provider's table in a card of providers. A `region` named by its heading, the parts `space.2` apart:

- **Heading row**: the title as an `h3` in the `body` step (500, `ink`; also `Text variant="h3"`), then the optional `count` (`small`, `faint`, tabular), then optional `actions` at the right (dense buttons, a status word).
- **Help** (`description`): one line in the prose font, `small`, `muted`, `space.1` under the heading. A string is a paragraph; any other node is a block (a `div`, `data-block`) in the same place for content with lines of its own, which keep their own type step: a provider whose models failed to list shows its error there (the message in `body`, each detail on its own row, `role="alert"`) instead of a table.
- **Loading** (`LoadingSubsection({ variant?, children })`): the same frame with a one-line `body` skeleton bar (120 px, a provider name's width) in the title's slot and no `h3`, then the content (a loading table), so the loaded heading row does not move what is under it (`/admin/models` while its providers load).
- **Content** (`guide`, default; inside a padded box): the children `space.3` apart under the Disclosure's guide (§6.5): a 1px `line` on the left, indented `space.2`. Subsections nest by nesting their guides.
- **Flush** (`variant="flush"`; inside a `flush` form card): the heading row and help padded `space.3` (in line with a table's first column), the content running to the box's edges with no guide (an unframed DataTable, §6.6); a flush subsection after another is split from it by a `line-soft` hairline.
- **Divided** (`variant="divided"`; the regions of a Sheet's or Dialog's body, §6.7): the heading row as in `guide`, the children `space.3` apart with no guide; every divided subsection after the first among its siblings is split from what is above by a `line-soft` hairline with `space.4` under it, so the body reads as titled regions (an extension's Sheet: 部署配置, 状态, 副本, 权限). The regions sit `space.4` apart. A region with nothing to show is left out, heading included.

<!-- states: subsection -->
States: `guide`, `flush`, `divided`

<!-- size-table: subsection -->
| Part | State | Property | Value |
|---|---|---|---|
| subsection | guide | row-gap | space.2 |
| subsection-title | guide | font-size | type.body |
| subsection-title | guide | line-height | type.body.line |
| subsection-title | guide | color | color.ink |
| subsection-description | guide | font-size | type.small |
| subsection-description | guide | color | color.muted |
| subsection-body | guide | padding-left | space.2 |
| subsection-body | guide | border-left-color | color.line |
| subsection-head | flush | padding-left | space.3 |
| subsection-head | flush | padding-top | space.3 |
| subsection-title | flush | font-size | type.body |
| subsection-body | flush | padding-left | 0 |
| subsection | divided | row-gap | space.2 |
| subsection-title | divided | font-size | type.body |
| subsection-title | divided | color | color.ink |
| subsection-body | divided | padding-left | 0 |

### 6.33 ItemList

`ItemList({ label, rows?, children?, empty?, inset?: "card" | "flush" })` with plain rows `ItemListRow { id, tag?, title, meta?, status?, href?, actions? }` or `ItemListItem({ title, code?, marks?, tag?, href?, actions?, meta?, invalid?, children? })` children: things to look at, act on or edit inside one box, as rows split by `line-soft` hairlines, never cards (§1). A `ul` named by `label`; an empty list shows `empty` (a sentence, or `{ text, hint?, action? }`) as the panel empty state (§6.18): a list is always inside a box.

- **Plain rows** (`rows`): at least `row.roomy` high, `space.2` above and below, gap `space.3`: a tag (`micro`, `muted`, a 1px `line` chip; `accent` for what waits on the viewer), an optional 28 px mark (`mark`: a thing a plugin brings draws its plugin's icon, else the initial, §6.17), the title (`ink`, a link when it has `href`) over one `small` `muted` meta line, a status word, the actions (the org chooser).
- **Item rows** (`ItemListItem`): rows that hold more than a line, where a card per item would have stood (a model purpose, a quick action, an inline sub-agent, a permission group). The title line (at least `control.dense` high, gap `space.2`): the title in `body` 500 `ink` (a link with `href`), its mono id `code` (`small`, `muted`: `eval`), `marks` (a `Badge`, a muted state word: 已覆盖), and the `actions` at the right (dense). Then `meta`, lines `space.1` apart (`small`, `muted` by default: who declares it, the deployment default; a `warn` line carries its icon). Then the body (fields, a list, a warning and its borderless code, §6.9), `space.3` below, its parts `space.3` apart. A row with a body is a `group` named by its title, so its fields read as that row's. `invalid` draws a 2px `fail` bar on the row's left (in the box's padding; at the card's edge when flush).
- **Inset**: `card` (default) inside a padded box (a Card body, a form card that holds other fields, a Sheet): the rows reach the box's padding (no padding of their own at the sides; item rows `space.3` above and below, the first and last `space.2` so they meet the box's padding). `flush`: the list alone in a flush box (a `flush` FormSection): plain rows padded `space.2` `space.4`, item rows `space.4` on every side, so the hairlines run to the card's edges, as a SwitchList's do (§6.3).
- **A review row** (PermissionReview): one item row per category, the category as the title, the 「敏感」 `Badge` as a mark, its reasons as meta lines, its entries as `small` `muted` lines in the body; a danger block (destructive migration statements) is a row whose meta is a `warn` line with the `circle-alert` icon (`Text variant="small" tone="warn" icon="circle-alert"`) and whose body is the code (a CodeBlock, borderless inside the box).

<!-- states: item-list -->
States: `rows`, `fields`, `review`

<!-- size-table: item-list -->
| Part | State | Property | Value |
|---|---|---|---|
| item-list-row | rows | min-height | row.roomy |
| item-list-row | rows | padding-top | space.2 |
| item-list-row | fields | padding-left | space.4 |
| item-list-row | fields | padding-top | space.4 |
| item-list-head | fields | min-height | control.dense |
| item-list-title | fields | font-size | type.body |
| item-list-title | fields | color | color.ink |
| item-list-code | fields | font-size | type.small |
| item-list-code | fields | color | color.muted |
| item-list-meta | fields | margin-top | space.1 |
| item-list-body | fields | margin-top | space.3 |
| item-list-row | review | padding-left | 0 |
| code-block | review | background-color | color.panel-2 |
| code-block | review | border-top-width | 0 |
| code-block | review | border-top-left-radius | radius.sm |

### 6.34 CardGrid and ObjectCard

`CardGrid({ label, loading?, empty?, children })` lays `ObjectCard`s out on the page ground (ruling P4-15 of the plugin component management design: the workspace 智能体 page's 智能体 and 模板 tabs, the admin 智能体模板 list; on a list page `ListPage variant="cards"`, §5.1). It is a `ul` named by `label` with no box of its own: a CSS grid of `auto-fill` columns at least `layout.card-min` (280) wide (`minmax(min(100%, layout.card-min), 1fr)`), `space.3` apart both ways, so three columns at the content width and one below 640 (§4.3). It is drawn on the page ground only (§1); inside a box the same things are `ItemList` rows (§6.33).

`ObjectCard({ avatar?, title, href?, description?, meta?, state?, primary?, menu? })`, or `{ loading: true }`, is one `li` and the one box (§1): the `panel` ground, a 1px `line-card` border, radius `md`, padding `space.4`, its parts `space.3` apart in a column. Nothing inside it is boxed.

- **Head** (40 high, gap `space.3`): the avatar, an agent's `Avatar` at 40 (§6.30; `null` or none draws the initial square of the title), `{ icon }` for an object without a picture (its 16 px icon on a 40 px `selected` tile, radius `sm`), or `{ image }` for a thing a plugin brings (a channel connection: its plugin's icon, 24 and contained, on that tile; the title's initial in the h2 size without one or when it fails to load, §6.17), decorative (`aria-hidden`); then the name, `body` 600 `ink`, one line with an ellipsis; when it is cut off, the full text is its `title` (measured after layout and on resize: a name that fits has no tooltip); then, optionally, the object's `state` at the head's right (a mono `small` label: `ok` / `warn` / `fail` in their colour, `muted` in `faint`, as ObjectRow's, §6.17; it sits beside the link, never inside it: the channels page's 运行中 / 出错 / 已停用).
- **Description** (optional): prose, `prose-small`, `muted`, clamped to two lines (`-webkit-line-clamp: 2`); when it is cut off, the full text is its `title`. A card without one draws no line and no gap; the grid stretches the cards of a row to one height and the foot keeps to the bottom.
- **Foot** (at least `control.dense`, at the card's bottom, gap `space.2`): the meta, one mono `small` `muted` line with an ellipsis (a list joins its parts with 「 · 」, a `warn` part in `warn`; an agent: owner · 可见范围, a template: source · version, ruling P4-15); then the primary (`primary`, a `dense` `default` button or link: never the solid `primary` variant, which would put an accent button on every card, while the screen's one primary stays in the page head, §5.1); then the `more-horizontal` menu (`menu`, a dense icon button, §6.7: no menu of one, a lone safe item is a second button, none draws nothing). While the primary runs (`primary.loading`) it draws the Button's loading state and the card's other buttons are disabled. The primary, a lone item and the menu button keep their own names (开始会话, 更多操作) and are described by the card's name (`aria-describedby` on the name), so a screen reader hears which card they act on.
- **One link, the whole card**: the name is the card's only link (`href`; left out for a viewer who may not open the detail, a read-only list: the name is plain text in the same look, the card has no hover and opens nothing, and has no tab stop unless it has buttons); its `::after` is stretched over the card, so a click anywhere opens the detail and the card keeps a link's behaviour (a new tab, the URL on hover, the pending mark along the card's bottom while the router navigates, §6.13). The primary, the menu and the description sit above it (`z-index`), beside the link in the markup and never inside it (valid HTML, no nested interactive elements), so pressing them never navigates. The description passes a click on to the link, so its tooltip shows and the card still opens: a plain click navigates as the link does, Ctrl / Cmd / Shift or the middle button open the detail in a new tab, and a click that ends a text selection inside the description stays a selection (a selection elsewhere on the page does not count).
- **Hover** lays the `hover` ground over the card (fading over `motion.hover`); **keyboard focus** on the link draws the 2px `accent` ring, offset 2px, around the whole card (`:has(:focus-visible)`, §2.5).
- **Keyboard: roving focus by row** (ruling P4-15). The grid is one tab stop, the card last reached (the first by default). ← / → move to the previous / next card in reading order, across rows; ↑ / ↓ to the card above / below in the same column (from a column the short last row lacks, ↓ goes to the last card); Home / End to the first / last card. Tab then goes through that card's link, its primary and its menu and leaves the grid: the other cards' controls are out of the tab order (`tabIndex` −1) until an arrow or a click brings focus into them. Arrows on the primary or the menu belong to them (↵ or ↓ opens the menu). Skeleton cards take no part. The stop belongs to a card, by its key, not to a position: cards added or removed elsewhere leave it where it is; when the held card goes away (deleted from its own ⋯ menu, filtered out), the stop moves to its neighbour (the card now in its place, else the new last card), and if focus was inside the card (its link, its buttons, its open menu) focus moves to that neighbour's link, never to the page body. The children are a flat list of cards; fragments among them are opened, and each card needs a stable `key`. An ObjectCard outside a CardGrid keeps every control in the tab order.
- **Phones** (below 640): one column, and the primary and the menu are 40 px tap targets (§4.3).
- **Where** (beyond ruling P4-15): the org channels page `/channels` is a card list too (maintainer decision 2026-11-08): a card per connection with its plugin's icon, the connection name as the link to its detail, the platform's display name as the description, the bound agent and the unbound-person mode (提示绑定 / 匿名访客) as the meta, the running state as the card's `state`. The agent page's 渠道 section (`/agents/<id>?s=channels`) draws the same cards (maintainer decision 2026-11-08; one shared card rendering in apps/web): the bound agent is implicit there, so the meta is the unbound mode alone; the section has no card of its own: its heading (h2) and description stand on the SettingsPage's content ground with 接入渠道 at the heading row's right for an org admin, the grid below (`space.3`), the `page` EmptyState carrying 接入渠道 when nothing is bound, skeleton cards while loading, and cards without links for a viewer who may not open a connection.
- **Loading** (`CardGrid.loading`: `true` for six cards, two rows of three, or a count; `ObjectCard` with `loading: true`): skeleton cards in the card's anatomy and box (§6.29): a 40 × 40 `block` box in the avatar's place, a `body` slot 45% wide for the name, two `body` slots (100%, 55%: the line boxes of two `prose-small` lines) for the description, a `small` slot 45% wide for the meta and a 72 px `dense` box for the primary; the list is `aria-busy` with one hidden "正在加载 / Loading" (none inside a skeleton group, which announces once). Loading wins over `empty`.
- **Empty** (`CardGrid.empty`): the `page` EmptyState (§6.18) instead of the grid; on a list page the template's `empty` draws it (§5.1).

<!-- states: card-grid -->
States: `default`, `long-text`, `no-description`, `loading`, `empty`, `narrow`

<!-- size-table: card-grid -->
| Part | State | Property | Value |
|---|---|---|---|
| card-grid | default | column-gap | space.3 |
| card-grid | default | row-gap | space.3 |
| object-card | default | width | 344 |
| object-card | default | padding-top | space.4 |
| object-card | default | padding-left | space.4 |
| object-card | default | border-top-left-radius | radius.md |
| object-card | default | background-color | color.panel |
| object-card | default | border-top-color | color.line-card |
| object-card-head | default | height | 40 |
| object-card-avatar avatar | default | width | 40 |
| object-card-name | default | font-size | type.body |
| object-card-name | default | color | color.ink |
| object-card-description | default | font-size | type.prose-small |
| object-card-description | default | line-height | type.prose-small.line |
| object-card-description | default | color | color.muted |
| object-card-meta | default | font-size | type.small |
| object-card-meta | default | color | color.muted |
| object-card-foot button | default | height | control.dense |
| object-card-foot icon-button | default | width | control.dense |
| object-card-description | long-text | height | 40 |
| object-card-name | long-text | height | type.body.line |
| object-card-head | no-description | height | 40 |
| object-card-avatar[data-kind=icon] | no-description | background-color | color.selected |
| object-card-avatar[data-kind=icon] | no-description | border-top-left-radius | radius.sm |
| object-card | loading | padding-top | space.4 |
| skeleton-box[data-box=block] | loading | width | 40 |
| skeleton-box[data-box=block] | loading | height | 40 |
| skeleton-text[data-size=body] | loading | height | type.body.line |
| skeleton-box[data-box=dense] | loading | height | control.dense |
| empty-state-text | empty | color | color.ink |
| object-card | narrow | width | 358 |
| object-card-foot button | narrow | height | 40 |
| object-card-foot icon-button | narrow | width | 40 |

### 6.35 ImpactPreview

`ImpactPreview({ groups, empty })` with `ImpactPreviewGroup { id, title, description?, items?, content?, empty? }` and `ImpactPreviewItem { id, title, code?, marks?, notes?: { text, tone?: "muted" | "warn" | "fail" }[] }`: what a change would do, shown in its confirmation Dialog before it is confirmed (a platform plugin's update and an org's upload of a new version, switching a plugin off, a scope change, a disable). It replaces sentence-per-line previews: every kind of consequence is a titled group, every thing it touches a row.

- **Groups**: each group is a divided `Subsection` (§6.32): its title as the `h3` (会变化, 保持不变, 受影响的智能体, 受影响的组织, 名称冲突 …) with the row count, an optional help line, then optional `content` (a component table, unframed inside the Dialog, §6.6) and its rows. The groups sit `space.4` apart, each after the first under a `line-soft` hairline.
- **Rows**: the group's things as an `ItemList` (§6.33, a `ul` named by the group's title) of item rows: the name (`body` 500), an optional mono `code` (its kind or id), `marks` (a `Badge`), then its `notes` as lines (`small`, `muted`; a `warn` or `fail` note in its tone with the 12 px `circle-alert`). A warning about one org is a note under that org's row, never a sentence of its own. No characters as list markers (`·`, `−`).
- **Empty**: a group with nothing in it shows its own `empty` line (prose, `small`, `muted`: 没有组件会被移除) or, without one, is left out with its heading. When no group holds anything, the preview is the single `empty` line (没有影响), said once.
- A notice about the whole change (the preview went stale, the new version waits for a permission confirmation) is a `Callout` above the preview, a line inside the Dialog by itself (§6.19).

<!-- states: impact-preview -->
States: `default`, `empty`

<!-- size-table: impact-preview -->
| Part | State | Property | Value |
|---|---|---|---|
| impact-preview | default | row-gap | space.4 |
| subsection-title | default | font-size | type.body |
| subsection-title | default | color | color.ink |
| item-list-title | default | font-size | type.body |
| item-list-meta | default | margin-top | space.1 |
| impact-preview-empty | empty | font-size | type.small |
| impact-preview-empty | empty | color | color.muted |

### 6.36 ToolPolicyList

`ToolPolicyList({ label, rows, policyOptions, onCheck, onPolicy, onCheckAll?, search?, disabled?, inset?: "card" | "flush" })` with `ToolPolicyRow { id, label, tooltip?, note?: { text, tone?: "muted" | "warn" }, checked, policy }`: the tools an agent may call, each with its policy next to it (the agent page's 工具 section, its 内置工具 rows in the form card and an extension's or connector's tools in the 配置 Sheet). It replaces a checkbox list followed by a second list of policy selects that the reader had to match up.

- **Rows**: a `ul` named by `label`; one row per tool, at least `row.default` high, `space.1` above and below, gap `space.3`, split by `line-soft` hairlines (never cards, §1). On the left the Checkbox (§6.3) named by the tool's display title (`ink`, one line with an ellipsis; `tooltip` is its hover text, for a human description; a key or the model-facing English description is never drawn). Under the title an optional `note` line (`small`, `muted`; `warn` with the 12 px `circle-alert`: why a selected tool cannot be used now), indented to the title. On the right the policy `Select` (§6.2) at `dense`, `layout.policy-select` (160) wide, named 「<title> 的策略」; it is disabled while the tool is unchecked (the caller passes the default option's value then: a policy only applies to a tool the agent uses). The options are the caller's (默认 / 需审批 / 禁止: a policy can only tighten).
- **Select all** (`onCheckAll`): a head row of the same height under a `line-soft` hairline: the 「全选」 Checkbox (mixed while some rows are checked) and the checked count `n/m` (`small`, `muted`) at the right; it acts on the rows the filter shows.
- **Filter** (`search`, for a group with many tools, about eight or more): a `dense` search Input with the `search` icon above the rows (「搜索工具」), `space.2` above the select-all row; it narrows the rows by title, and with no match shows 「没有匹配的工具」 as the panel EmptyState (§6.18) in the rows' place.
- **Inset**: `card` (default) in a padded box (a form card, a Sheet): the rows reach its padding; `flush` alone in a flush card: rows padded `space.4` at the sides, so the hairlines run to the card's edges (as ItemList, §6.33).
- `disabled` turns every checkbox and select off (while a save runs).
- Groups of tools (an extension, a connector) are not nested lists: in the form card each group is one `ItemList` row (§6.33: its name, the 扩展 / 连接器 tag, a summary meta line 「已启用 12/30 个工具 · 2 个需审批」 and a 「配置」 button) that opens a Sheet (§6.7) holding the group's `ToolPolicyList` with `onCheckAll`.

<!-- states: tool-policy-list -->
States: `default`, `select-all`

<!-- size-table: tool-policy-list -->
| Part | State | Property | Value |
|---|---|---|---|
| tool-policy-row | default | min-height | row.default |
| tool-policy-row | default | padding-top | space.1 |
| tool-policy-row | default | column-gap | space.3 |
| tool-policy-title | default | font-size | type.body |
| tool-policy-title | default | color | color.ink |
| tool-policy-note | default | font-size | type.small |
| tool-policy-note[data-tone=warn] | default | color | color.warn |
| tool-policy-select | default | width | layout.policy-select |
| tool-policy-select select | default | height | control.dense |
| tool-policy-all | select-all | min-height | row.default |
| tool-policy-count | select-all | font-size | type.small |
| tool-policy-count | select-all | color | color.muted |
| tool-policy-search input | select-all | height | control.dense |

### 6.37 ThemeSwatch

`ThemeSwatch({ name, swatches: { bg, panel, ink, accent }, scheme: "dark" | "light", selected?, onSelect?, disabled? })`: one choice of a theme picker (the 外观 settings of a person, an org or the platform). A `button` with `role="radio"` and `aria-checked`; pages put the cards in a `ThemeSwatchGroup` (§6.38), the radio group with its keyboard; Space or Enter selects.

- **Card**: `space.2` padding, a 1px `line` border, `radius.md`; the preview over a foot row, `space.2` apart. Hover takes `line-strong`.
- **Preview**: 48 high, `radius.sm`, a 1px `line` hairline (so a ground close to the page's own still reads), filled with the theme's `bg`; on it a rounded block in the theme's `panel` (the left 40%), a 4 px bar in `ink` and a 16 × 8 block in `accent` (the right half). The four colors are the theme's data, applied as `--cb-swatch-*` custom properties by the component; this is the only place a theme's color values reach the DOM, and pages pass them as props, never as literals (`web-ui-color`).
- **Foot**: the theme's name (`body`, `ink`, one line with an ellipsis, its full text as the title) and a 12 px `moon` or `sun` icon in `muted` for the scheme (`data-scheme`).
- **The built-in theme** in a picker draws `BUILTIN_THEME_SWATCHES[scheme]`: references to `--cb-builtin-<scheme>-{bg,panel,ink,accent}`, which `pnpm gen:tokens` writes into tokens.css from the built-in values, outside the token names, so a theme on the page never changes them.
- **Selected** (`data-state="selected"`): the `selected` ground and a `line-strong` border; selection is neutral (§2.3), the focus ring (2 px `accent`, offset 2) carries the accent. `disabled` greys the card and the pointer shows not-allowed.

<!-- states: theme-swatch -->
States: `default`, `selected`

<!-- size-table: theme-swatch -->
| Part | State | Property | Value |
|---|---|---|---|
| theme-swatch | default | padding-left | space.2 |
| theme-swatch | default | row-gap | space.2 |
| theme-swatch | default | border-top-color | color.line |
| theme-swatch-preview | default | height | 48 |
| theme-swatch-name | default | font-size | type.body |
| theme-swatch-name | default | color | color.ink |
| theme-swatch | selected | border-top-color | color.line-strong |
| theme-swatch | selected | background-color | color.selected |

### 6.38 ThemeSwatchGroup

`ThemeSwatchGroup({ label, value, items: { value, name, swatches }[], onChange, scheme, disabled? })`: a theme picker, the `ThemeSwatch` cards (§6.37) of the 外观 settings (a person's, an org's, the platform's) in one `role="radiogroup"` named by `label`. Pages use it, never a hand-made group of swatches.

- **Grid**: as many columns as fit, each at least `layout.swatch-min` (160) wide, `space.3` apart both ways; one column below that width.
- **Scheme**: each card is drawn in `scheme` (the page's) when its item defines swatches for it, else in the scheme it has (a single-scheme theme), with that scheme's icon; an item without swatches draws `BUILTIN_THEME_SWATCHES`.
- **Keyboard** (a radio group): one tab stop, the selected card (else the first); ←/↑ and →/↓ move to the previous / next card and select it, wrapping; Home / End to the first / last. Click or Space / Enter on a card selects it.
- **Disabled** (a reader of a setting): every card disabled, the selected one still marked; the arrows do nothing.

<!-- states: theme-swatch-group -->
States: `default`

<!-- size-table: theme-swatch-group -->
| Part | State | Property | Value |
|---|---|---|---|
| theme-swatch-group | default | column-gap | space.3 |
| theme-swatch-group | default | row-gap | space.3 |

## 7. Copy and internationalization
- All UI text goes through next-intl, in both Chinese and English. Text shown to the model (prompts, tool descriptions) is always English, and the prompt field in a form must say so.
- Thousands separators for numbers; durations `6.8s` / `41.2s` / `00:00:18`; amounts `¥412.80`; relative time ("2 hours ago") for lists, absolute time (`10-18 14:02:11`) for records and logs.
- Error messages state the cause and give an actionable next step; include the error code and request ID for troubleshooting.
- **Files, not artifacts**: what an agent delivers from its sandbox is "文件" / "files" in UI copy, never "产出物" / "artifacts" (reserved for project C's Artifacts). The kernel identifiers (`artifact_created`, `/artifacts/:id/download`) stay as they are.
- **Untitled conversations** read "未命名会话 · MM-DD HH:mm" / "Untitled conversation · MM-DD HH:mm" (the start time) until a title exists.
- **Tool group wording** (§6.16.8; rows carry no verb: they name the tool, §6.16.9), as the signed reference set B draws them. Counts are Arabic numerals; failures append "（N 个失败）" / " (N failed)" in `fail`; mixed kinds join with "，" / ", " in the fixed order command, tools (connector, tool, search, meta, question), read, edit:

  | Kind | Group count zh / en | Running header zh / en |
  |---|---|---|
  | command | 已运行 N 个命令 / Ran N commands | 正在运行命令 / Running command |
  | read | 已读取 N 个文件 / Read N files (one path: 已读取 <path> / Read <path>) | 正在读取文件 / Reading file |
  | edit | 已修改 N 个文件 · +a −b / Edited N files · +a −b (one path: 已修改 <path>) | 正在修改文件 / Editing file |
  | search | counted with tools | 正在使用工具 / Using tool |
  | connector, tool | 已使用 N 个工具 / Used N tools | 正在使用工具 / Using tool |
  | meta | counted with tools | 正在使用工具 / Using tool |
  | question | counted with tools (its row: 已提问 <header> / Asked <header>, §6.16.9) | 等待你回答 / Waiting for your answer while it waits |

### 7.1 Copy

The polish checklist below comes from an audit with [unslop](https://github.com/heydamir/unslop) (Damir Sokolovsky, CC BY 4.0), adapted to this product: exact, restrained, a little dry.

- **Periods**: full sentences (descriptions, hints, errors, toasts, empty-state explanations, notices) end with "。" / "."; titles, buttons, labels, menu items, table headers, tabs, short phrase captions ("先配置模型", "设置 · 成员") and inline hints ("运行中发送的消息会在下一步交给智能体") have none. `check:i18n` rule `i18n-label-period` rejects a period at the end of a message whose key names a label (`title`, `label`, `action`, `confirm`, `cancel`, `submit`, `button`, `name`, `tab`, `heading`, `item`, `menu`, `placeholder`, also as the last camelCase word, e.g. `confirmLabel`).
- **Names in messages**: a name interpolated into a toast or notice is quoted: corner quotes 「」 in zh (已启用「待办清单」。, 已移除「deepseek」。), straight double quotes in en (`Enabled "Todo".`).
- **Ellipsis and punctuation**: the ellipsis is the single character "…", never three dots (`i18n-ellipsis`); in Chinese a half-width `?` `!` `:` `;` never follows a Chinese character, use `？` `！` `：` `；` (`i18n-cjk-halfwidth`).
- **One name per object**: conversation is "会话" (not "对话", which stays a verb), sub-agent is "子智能体", rename is "重命名", a created-at column is "创建时间", the new conversation is "新会话" (the workspace has no home page and no "首页"), the admin area is "管理后台" and its first page "概览"; a page's h1 is its nav name.
- **"agent"**: Chinese says "智能体" (sub-agent "子智能体", agent template "智能体模板", the nav item and the page name "智能体"); English stays "agent" (`check:i18n` rule `i18n-zh-agent` rejects the Latin word in zh messages). The create verb is "新建" everywhere (buttons, the setup step, the page title "新建智能体").
- **Roles and the platform**: the roles are "超级管理员" / "Super admin" (the deployment level), "组织所有者" / "Org owner", "组织管理员" / "Org admin", "组织成员" / "Org member" and "访客" / "Guest"; the deployment layer is "平台" / "Platform" (平台目录, 平台统一), a non-official marketplace is "自定义市场源" / "Custom marketplace", and "企业" is never used (`i18n-zh-enterprise`; plugin and component management spec §13.4b, §13.4c).
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
5. **One box is enough** (§1 principle 7), in two halves. `web-ui-box-in-box` (part of `check:web-ui`) reads the JSX of `apps/web/src`: a boxed design component (`Card`, `FormSection`, `DangerZone`, `ObjectList`, `LinkCard`, `StatCards`, `InlineCard`, `FilePicker`, `CardGrid`, `ObjectCard`) drawn inside a box (`Card`, `FormSection`, `Dialog`, `Sheet`, `Popover`, the agent map's dialog, `InlineCard`, `PropertySection`, `Callout`, `DangerZone`, `ObjectList`), directly, through an attribute (`title`, `actions`, a render prop) or through what the JSX hands it: a component of apps/web whose JSX draws one (followed across same-file components, relative and `@/` imports and re-exports), a same-function `const` holding JSX (a `.map(...)` result too), a same-file helper returning JSX, a render function a hook returns; a local wrapper that draws a prop inside its box (`children`, renamed or not, or another slot prop) counts as that box for what is passed there; a `DataTable` in a FormSection that is not `flush`; a `CodeBlock`, `EmbedFrame` or `DataTable` forced `framed` inside a box. Overlays are portals: one that is a box (Dialog, Sheet, Popover, the agent map's dialog) is the box of what it holds, the others (menus, the command palette, tooltips) start on no box, so a Card in a Menu in a Card is not inside the Card; full-height panes (RightPanel, the file preview, the agent map's transcript) hold content like a page. Its exceptions: a FilePicker in a Dialog; card radios and form controls are not boxes to it. A CardGrid's cards are judged by the grid alone: a grid in a box is one finding, not one per card. `BOX_PENDING` (`tools/checks/src/box-in-box.ts`) has been empty since AB wave 2, and new code adds no entry; it stays as a ratchet bounded like `KC_PENDING` (`{ path, inner, max }`: more findings fail, fewer fail as "lower max", none as stale, `web-ui-box-stale-pending`). The rendered half is the jsdom guard `findNestedBoxes` (`@capybara-hq/design/reference`): every box the design package draws by its markup (`BOXES`), full-height panes (`PANES`) and the reasoned exceptions (`BOX_EXCEPTIONS`: option cards anywhere, a FilePicker in a Dialog); `packages/design/test/box-in-box.test.tsx` runs it on every box holding every piece with an unboxed form and on the template loading shapes, and `apps/web/test/box-in-box.test.tsx` on every `/dev/ui` route.

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
