# Capybara Design System Spec (E · Terminal, refined)

> Status: implemented (`packages/design` + `/dev/ui`) · 2026-10-18; refined E rules, sidebar shell, size tables and states from UI refresh A, implemented and accepted against the reference set (all 14 components and templates) · 2026-10-26; conversation page rules, states and size tables from UI refresh B (reference set B signed off 2026-10-27), implemented and accepted against the reference set (all 37 components and templates) · 2026-10-27
> Visual reference: the **reference set** in `docs/design/reference/` (one PNG per component state, dark and light, rendered from `docs/design/reference/src/` with the real fonts, the generated tokens and the shared fixtures). The maintainer signed it off on 2026-10-26 (A) and 2026-10-27 (B, the conversation page); it replaces the design canvas as the visual source.
> Visual regression: the `/dev/ui` catalog page and the screenshot baselines checked into the repo (`apps/web/visual/`, Linux version) guard against breakage once a change has been accepted against the reference set (§9).

This document is the **only specification** for the web UI. The reference set and the screenshots illustrate this document; when they disagree, this document wins and the reference set is corrected (§10).
The implementation lives in `packages/design` (package name `@capybara-hq/design`); `apps/web` only consumes it. Rules that can be checked automatically are enforced by `pnpm check`, the measuring and state-coverage tests and the screenshot tests (see §9).

Wording: **must** / **must not** are mandatory; **should** is the default practice, and deviations need a reason stated in review.

---

## 1. Design principles

1. **Two fonts, one skeleton**: the monospace font (Sarasa Mono SC, one Chinese character is exactly two English cells) is the UI skeleton: navigation, labels, buttons, tables, tool rows, keys, paths, numbers. Prose (descriptions in page headers and forms, conversation text, rendered Markdown) uses the proportional font (§2.2).
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

**CSS layers** (client extensions spec §7.2): `packages/design/src/styles/index.css` starts with `@layer design, theme, extensions;` and imports every stylesheet with `layer(design)`; theme CSS is emitted inside `@layer theme`; a plugin's CSS is wrapped in `@layer extensions` by the packer. A later layer wins whatever the specificity, so a plugin rule beats the design and theme rules without `!important`, and a new design stylesheet must be imported into `layer(design)` (an unlayered rule would beat every plugin rule). Plugins may read every `--cb-*` token and define `--cx-<plugin>-*` properties; overriding `--cb-*` from plugin CSS works but is outside the compatibility promise (themes are the contract for tokens).

### 2.1 Colors

| Token | Dark | Light | Purpose |
|---|---|---|---|
| `bg` | `#0A0A0A` | `#FDFDFC` | The paper: the page, the conversation and the right panel from 600 up (§4), and every compact page |
| `panel` | `#111110` | `#FFFFFF` | Cards, table container, stat cards, form field cards, overlays |
| `panel-2` | `#0E0E0D` | `#FCFBF9` | Action row, right-panel ground |
| `sidebar` | `#171716` | `#EDECE7` | The ground: the sidebar and the shell's gutters from 600 up (§4) |
| `sidebar-active` | `rgba(255,255,255,0.07)` | `rgba(26,26,24,0.09)` | Current nav item or conversation in the sidebar |
| `raised` | `#141413` | `#FFFFFF` | Floating inline cards, the composer |
| `selected` | `#21211F` | `rgba(26,26,24,0.07)` | Selection ground: selected segment, filter chip, option card, the palette's current row, the waterfall's selected row; avatar, skeleton bars |
| `hover` | `rgba(255,255,255,0.04)` | `rgba(26,26,24,0.045)` | Hover ground, disabled input ground |
| `line-soft` | `#1C1C1A` | `#E8E7E2` | Column dividers, table row dividers, the action row's top line, disabled borders |
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
| `scrim` | `rgba(0,0,0,.60)` | `rgba(10,10,10,.25)` | Behind dialogs and sheets |
| `lightbox` | `rgba(0,0,0,.88)` | `rgba(10,10,10,.80)` | Behind the image viewer (§6.16.20): a heavier dim than `scrim`, the image is the page |
| `float-ground` | `rgba(28,28,26,0.85)` | `rgba(255,255,255,0.85)` | Touch floating controls: a translucent ground over the page (`ink` and `muted` on it pass 4.5:1 composited over `bg`, both schemes) |
| `float-line` | `rgba(255,255,255,0.08)` | `rgba(26,26,24,0.08)` | The hairline around a touch floating control |
| `diff-add` | `rgba(63,212,131,.08)` | `rgba(22,128,63,.10)` | Added lines in a diff (ground only; the text stays `ink`) |
| `diff-del` | `rgba(255,92,82,.08)` | `rgba(207,34,46,.08)` | Removed lines in a diff (ground only) |

The `avatar-*` tokens (dark and light, in `tokens.json`) are the animal palettes of the agent avatars (§3, §6.30) and are used by `Avatar` only. Each preset's main color against its ground is a `contrast` pair with a floor of 3:1 (WCAG 1.4.11 for graphics), in both themes; the panda's and the penguin's white against their grounds are pairs too.

The light accent is `#CC4609`: white text on it has a contrast of 4.72:1 (WCAG AA). The original `#FF6A13` with white text is only 2.87:1 and must not be used in the light theme. The text pairs that must meet AA are listed in `tokens.json` `contrast` and checked by `check:tokens`; a translucent token (`diff-add`, `diff-del`, the light `hover` / `selected` / `sidebar-active`) is composited over `bg` before its pair is checked, or over the surface a pair names as its fourth element (`["muted", "selected", 4.5, "sidebar"]`: the darkest light surface these grounds sit on). `muted` must reach 4.5:1 on every ground secondary text sits on (`bg`, `panel`, `panel-2`, `sidebar`, `raised`, `selected`, `hover`; dark: 6.02:1 on `bg`, 5.02:1 on `selected`) and `disabled` 3:1 on the grounds a control sits on (dark: 3.86:1 on `bg`, 3.22:1 on `selected`; light: 3.67:1 on `bg`, 3.18:1 on `selected`).

**Ground and paper** (maintainer decision 2026-11-28, one rule for both themes): the paper (`bg`) has the most contrast with the text (the lightest in light, the darkest in dark); the ground (`sidebar`) steps toward the middle; a card on the paper (`panel`) steps one level toward the middle too.

**Hover, selected and current grounds.** In light, `hover`, `selected` and `sidebar-active` are translucent ink overlays (`ink` at 4.5%, 7% and 9%), not fixed colors, so each reads as a darker step on every surface it sits on (`bg`, `panel`, `panel-2`, `raised`, `sidebar`); in dark they are white overlays too (`hover` 4%, `sidebar-active` 7%, maintainer decision 2026-11-28), so they read on the ground and on the paper alike; `selected` stays solid in dark. `tokens.json` `separation` lists `[ground, surface, floor]`: the ground composited over the surface must differ from it by at least the floor in OKLab lightness ×100 (2.5 for `hover` and `selected` on `bg`, `panel` and `sidebar`, and `sidebar-active` on `sidebar`), in both themes (`tokens-separation`), and `selected` must stand further from a surface than `hover` on the same surface (`tokens-separation-order`). Because they are translucent, an element that must hide what is under it (a sticky table header, a badge over an icon) lays the ground over its opaque surface (`linear-gradient(var(--cb-hover), var(--cb-hover)), var(--cb-table-ground)`) instead of using it alone; two stacked overlays (a hovered row's menu button) simply read darker.

### 2.2 Fonts and type

Three font roles, each with a job:

| Font | Token | Used for |
|---|---|---|
| **Sarasa Mono SC** (OFL-1.1) | `--cb-font` | The UI skeleton: navigation, labels, buttons, tables, tool rows, key names, the nav counts. On touch it is the system font (below) |
| **Sarasa Mono SC** (OFL-1.1) | `--cb-font-code` | Code, commands, paths, versions, dates and times, ids: what a person copies or compares. The same stack as `--cb-font` on a pointer device, and Sarasa on touch too |
| **Inter + Source Han Sans SC** (both OFL-1.1) | `--cb-font-prose` | Prose: running text a person reads as sentences: descriptions (page headers, form sections, object rows, plugin and extension descriptions), field help, dialog bodies, callouts, empty-state text, conversation prose, rendered Markdown, table description lines |

- Weights 400 / 500 / 600, never above 600: hierarchy comes from size and color, not weight. The page title (`h1`) and emphasis (the primary button, the current nav or tab item, object names, `strong`) are 600; section, card, dialog and group titles are 500; everything else is 400. Each font ships a 400 and a 700 face: 500 draws with the regular face and 600 with the bold face (CSS font matching), so a 500 title is set apart by its size and `ink` color alone.
- Delivery: subsetted to woff2 at build time (`packages/design/scripts/subset-font.py`: ASCII, the 3,755 level-1 common Chinese characters, the characters the UI uses and a symbol table), self-hosted under `packages/design/src/fonts` with their licenses, `font-display: swap`, declared only in `styles/fonts.css`.
- Fallbacks: `'Sarasa Mono SC', ui-monospace, monospace`; `'Inter', 'Source Han Sans SC', system-ui, sans-serif`.
- **Touch** (maintainer decision 2026-11-21; `touch.ts`, `TOUCH_QUERY`: a coarse primary pointer, or a coarse pointer and no fine one; `useTouch()` is `null` on the server and during hydration): a phone reads the system font, so `--cb-font` and `--cb-font-prose` become `system-ui, -apple-system, 'PingFang SC', 'Noto Sans SC', sans-serif` and the type sizes take the Touch column below. Everything that was Sarasa because it is code, a command, a path, a version or a time says `font-family: var(--cb-font-code)` (the base rules for `code`, `pre`, `kbd` and `samp`, `DateTime`, the version in the account menu, `KeycapCommand`, `CopyCode`, a tool row's command and output, the diff block and the path cells), so it stays Sarasa there. No stylesheet but `fonts.css` and the generated `tokens.css` names Sarasa.

| Name | Size / line height | Touch | Weight | Font | Purpose |
|---|---|---|---|---|---|
| `h1` | 20 / 28 | 28 / 34 | 600 | mono | PageHeader title |
| `h2` | 16 / 24 | 22 / 28 | 500 | mono | Section title, card title, Dialog title |
| `body` | 13 / 20 | 17 / 24 | 400 | mono | Default text, tables, controls, nav items |
| `small` | 12 / 16 | 15 / 20 | 400 | mono | Table header, error messages, group labels, stat labels (field help is the same size in the prose font) |
| `micro` | 11 / 14 | 13 / 18 | 400 | mono | Nav counts |
| `metric` | 18 / 24 | 22 / 28 | 400 | mono | Stat card values |
| `prose` | 15 / 26 | 17 / 26 | 400 | prose | Conversation prose, rendered Markdown |
| `prose-small` | 13 / 20 | 15 / 22 | 400 | prose | Page-header and form-section descriptions, hints and dialog bodies (`Text variant="prose"`) |

A touch type size is never below 13 (`check:tokens`, `tokens-touch-type`); `micro` (11) stays the smallest size only off touch.

- Numbers always use `font-variant-numeric: tabular-nums`.
- **Mono is for things a person copies or compares**: ids, paths, numbers, versions, dates and the UI skeleton. A sentence is never mono: a page writes running text as `Text variant="prose"` (or in a component's own prose part).
- **Dates**: one helper (`formatDateTime`, the `DateTime` component), local time, mono with tabular figures. Two forms only: `full` `YYYY-MM-DD HH:mm` in tables, meta lines and detail fields, with the relative age ("5 分钟前") as the tooltip (`DateTime` draws a `<time>` whose `title` is the age); `compact` `MM-DD HH:mm` in dense lists (the sidebar's untitled conversations "未命名会话 · 11-02 23:42"). Activity lines may say only the relative age ("Grant · 4 分钟前"); no other format (`2026/11/2`, `2026年11月1日`) is used.
- **Versions** are always mono with one leading `v` ("v0.1.0-rc.0"; `versionLabel`), in titles, tables, meta and sentences alike; request bodies keep the bare version.
- No italics and no letter-spacing adjustment.
- `micro` (11) is the smallest size anywhere off touch, at every window width (mono meta lines included); no stylesheet sets a smaller one. On touch the smallest is 13 (the Touch column).

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
- **Attention marks** ("敏感" / "Sensitive", "有新版本"): the word in `warn`, no box, no fill (`Badge tone="warn"`, an ObjectRow chip with `tone: "warn"`); one style on every page. A group that holds sensitive items is an ordinary card (the `line-card` hairline) with the mark in its title, never an accent or warn frame; only the mark is yellow (the reasons are `muted` secondary text, the items the plain `muted` list). Plain metadata (必装 / Required) is `muted` text and a state that needs attention (不可用 / Unavailable) `warn` text, never a badge. A **danger mark** is the same word with no box in `fail` (`Badge tone="fail"`, an ObjectCard meta part with `tone: "fail"`): only for a state that removes a protection. A device's mode does not use it: 「自动」 / "Auto" (a local device without the OS sandbox) keeps the `warn` attention mark and 「沙箱」 / "Sandbox" carries none (auto mode spec §4).
- **High-frequency lists** (tool rows, todo items, connector lists, table status columns): success is shown by **no mark** (plain `muted` text such as "Connected"), failure by the word "Failed" (or the specific error) in `fail` with `circle-x`. Everything that needs a person keeps `warn`.
- **The error dot** (maintainer decision 2026-11-23): a tool call that returned an error, in the conversation thread's tool rows and their group headers (§6.16.8, §6.16.9), is a 6 px `fail` dot instead of the word "失败" / "Failed", since many such errors are ordinary steps the agent corrects on its next call. It is a status mark, not a word: never colour alone, its accessible name and tooltip say "调用返回了错误" / "The call returned an error" (a group: "N 个调用返回了错误" / "N calls returned an error"), and the error text itself stays visible beside it. Run failures, sub-agent failures and background tasks keep the word.

### 2.5 Sizes, density, lines, radius, shadow, layering, motion, focus

Every size a component uses is a step of one of these scales, stored in `tokens.json` (`size.*`) and listed in the component's size table (§6). Pages never pick sizes.

| Scale | Steps | Values | Variables |
|---|---|---|---|
| Control height | `dense` / `default` / `prominent` | 24 / 28 / 32 | `--cb-control-<step>` |
| Row height (lists, tables, sidebar, menus) | `dense` / `default` / `roomy` (rows with a thumbnail or two lines) | 28 / 32 / 44 | `--cb-row-<step>` |
| Touch sizes (§4.3 touch column) | `hit` / `float` / `primary` / `prominent` / `composer` / `row` / `row-roomy` / `icon` / `icon-float` | 44 (the hit target) / 48 (a floating button) / 48 (the primary action) / 52 (the one prominent action) / 60 (the composer) / 52 (a list row) / 56 (a row with two lines) / 22 (an icon) / 24 (a floating button's icon) | `--cb-touch-<step>` |
| Spacing | `1`–`8` | 4, 8, 12, 16, 20, 24, 32, 40 | `--cb-space-<n>` |
| Inner padding (inside a component, vertical / horizontal) | `dense` / `default` | 4/8 · 6/12 | `--cb-pad-<step>-y`, `--cb-pad-<step>-x` |
| Type | §2.2 | | `--cb-type-<name>-size`, `--cb-type-<name>-line` |
| Radius | `sm` / `md` / `bubble` / `pill` | 4 / 8 / 10 / 999 (a full round: the floating button, a count badge) | `--cb-radius-<step>` |
| Layout | `sidebar` / `sidebar-rail` / `content` / `chat` / `action-row` / `gutter` | 256 / 48 / 1120 / 720 / 40 / 20 | `--cb-layout-<name>` |
| Layout, cards (§6.34) | `card-min` | 280 (a CardGrid's narrowest card: three columns at the content width, one on a phone) | `--cb-layout-<name>` |
| Layout, tool policies (§6.36) | `policy-select` | 160 (a ToolPolicyList row's policy select: fits 需审批 / Ask for approval at `dense`) | `--cb-layout-<name>` |
| Layout, theme pickers (§6.38) | `swatch-min` | 160 (a ThemeSwatchGroup column's least width) | `--cb-layout-<name>` |
| Layout, schedule calendar (§6.40) | `calendar-axis` / `calendar-hour` / `calendar-day-min` / `calendar-cell` | 48 (the week's time axis) / 48 (one hour row; a block is half of it, the 24 px tap-target floor) / 76 (the narrowest day column: 7 × 76 + 48 = 580, the least frame width of the week grid; a narrower frame draws the agenda) / 112 (a month cell's least height: the date row and three 24 px lines) | `--cb-layout-<name>` |
| Layout, page head (§4.2 "Head rhythm") | `head-path` / `head-description` / `head-tabs` / `head-tabs-content` / `head-content` | 12 / 4 / 16 / 16 / 24 | `--cb-layout-<name>` |
| Layout, shell (§4) | `content-min` / `bottom-nav` / `top-bar` | 552 (a content area's least width: the narrowest medium window, 600, less the 48 rail) / 56 / 44 (no longer drawn: the chat-first compact shell has no bottom navigation and no top bar, §4.6; the tokens stay until the token pass removes them) | `--cb-layout-<name>` |
| Layout, conversation page | `title-bar` / `properties` / `panel-min` / `panel` / `chat-min` / `tool-detail` / `file-card` / `thumb` / `inline-image` / `menu-max-height` / `bubble-clamp` | 48 / 300 / 360 / 560 / 480 / 204 (the tool detail viewport, §6.16.9: twelve `type.small` lines and `pad.default.y` twice) / 240 / 56 / 360 / 328 (ten `row.default` items and the menu's padding) / 208 (eight `type.prose.line` lines: a long user message's clamp, §6.16.6) | `--cb-layout-<name>` |

**Touch column, the mobile sizes** (maintainer decisions 2026-11-21 and 2026-11-22): the scales above step up under `MOBILE_SIZE_QUERY` (`touch.ts`: `(max-width: 599px), <TOUCH_QUERY>`), that is at the **compact size class whatever the pointer** (a narrowed desktop window too) **or on a touch device at any width** (an iPad at medium or expanded), and every component follows with no rule of its own: there is no separate mobile component set, the same components switch by this one media query (maintainer decision 2026-11-22). The size overrides are one `@media MOBILE_SIZE_QUERY` block at the end of `tokens.css` after the scheme blocks; the font overrides of §2.2 stay in their own `@media TOUCH_QUERY` block before it (a narrow desktop window keeps its fonts). The touch components' forms (§6.7 bottom sheet, §6.16 the floating composer pill with its settings chip and sheet, the end-edge user bubble, the 48 high approval buttons, §6.17 / §6.33 large rows, §6.51 floating button, §6.52 drawer rows) follow the same `MOBILE_SIZE_QUERY` (in JS `useMobileSizes()`, for the sheet's Segmented and the approval order); only what is about the pointer itself stays under `TOUCH_QUERY` / `useTouch()` / `isTouchPointer()`: the system font, hover-less affordances (the prompt suggestion's button, since a touch device has no Tab key), a tap that never focuses the composer, and the desktop-only gate of §6.54 (maintainer decision 2026-11-22). `control` `dense` / `default` / `prominent` become 44 / 44 / 52; `row` `dense` / `default` / `roomy` 44 / 44 / 56; `radius` `sm` / `md` / `bubble` 12 / 20 / 20; the type sizes are §2.2's Touch column. Spacing, padding tokens, layout widths and colors do not change. The `touch.*` sizes above are for the touch components only (§6): the floating button is `touch.float` high with `radius.pill`, `touch.icon-float` icon inside, on `float-ground` with a `float-line` hairline and `shadow-float-touch`; the touch composer is `touch.composer` high; the touch drawer is `layout.drawer` (320) wide. `tokens.json` holds the overrides under `touch` (a name must exist at its base: `check:tokens`).

**Mobile sizes of the controls** (maintainer decision 2026-11-22; under `MOBILE_SIZE_QUERY`, beside the controls' own rules): every control is a `touch.hit` (44) target: buttons, icon buttons, filter chips and text fields by the control scale, tabs (§6.4, the settings sub-nav's items, a panel's tabs) `touch.hit` high, a Segmented group `control.default` (44) high, level with the fields and buttons of its row, each segment filling the whole group (over its 1px border) so its hit area is 44, at least 44 wide, the selected ground drawn inset (on a `::before`) rather than shrinking the segment. The visible box is the hit box: no invisible ring is needed under the mobile sizes. **A control with text pads wider than it is tall** ("左右大于上下"): the space between its border and its text at the sides is greater than above and below, so a button or chip pads `space.4` (16) at the sides (`space.5`, 20, at `prominent`), a tab `space.4`, a segment `space.4` (16); an icon-only button stays a square at the control height. Text fields (inputs, textareas, selects, steppers) are 44 high with their text `space.3` (12) from the border and at least 16 px (§4.3). `apps/web/visual/compact.interaction.spec.ts` measures both rules on every template page at 382 and 390 on touch and 480 with a fine pointer (`mobile-sizes.ts`).

**Density steps.** Controls and rows come in three steps, chosen by context, never by taste:

| Step | Used for | Not used for |
|---|---|---|
| `dense` | Inside table rows (row menus, inline controls) and table pagination, tool groups and tool rows, inline cards, property sections, tag-like chips | Anything a person is expected to read at length or aim at often outside a dense container, including a table's toolbar, bulk action bar and empty-state actions (those are `default`, as the signed reference draws them) |
| `default` | Everything else: buttons, inputs, selects, segmented controls, filter chips, table toolbars, bulk action bars and empty-state actions, the composer's controls, sidebar items, menu items, form fields | — |
| `prominent` | At most one per view, where the action *is* the page: the auth pages' submit, an empty state's first action, the onboarding checklist's next step | Ordinary page-header primaries, form submits in the action row, dialogs |

- A container sets the step for what it holds (a DataTable's rows and pagination are `dense`, its toolbar, bulk action bar and empty-state actions `default`; a form is `default` throughout); mixing steps inside one row is not allowed. In code the step is the `density` prop (`"dense" | "default" | "prominent"`) of `Button`, `IconButton`, `Input`, `Select`, `Segmented` and `FilterChip`; a container provides it through `DensityContext` and an explicit prop wins.
- Icon buttons are square at the same step's height.
- The page-header primary action and the action-row actions are `default`.
- Spacing usage: inside components steps 1–3; between components 2–3; between sections 4–6; page gutters `layout.gutter`. **If spacing can separate it, don't draw a line.**

**Lines**: 1px. Column dividers, table row dividers, the hairlines between rows or groups inside a box (`ItemList` rows, divided Repeater items, flush `Subsection`s, a divided `Grid`) and the action row's top line uses `line-soft`. Borders (`line`) only on things that float over content or take input: inputs, buttons, chips, inline cards, overlays (`line-strong`). Cards, sections, stat cards, form field cards and object lists use the `panel` ground with a 1px `line-card` hairline (`rgba(255,255,255,.08)` in dark, where the ground alone barely separates them; drawn as an inset shadow where a border would change the box); the table container has no border.

**One box is enough** (§1 principle 7): a box holds headings, hairlines and space, never a second box. Inside a padded box a group is a `Subsection` (an `h3` in the `body` step, 500, its help line, then its content under the Disclosure's 1px `line` guide, §6.32) or `ItemList` rows split by `line-soft` (§6.33); in a flush box (a `flush` FormSection) rows and flush subsections are padded themselves (`space.4` for item rows, `space.3` for a subsection's heading row, in line with a table's first column) so their hairlines run to the box's edges. The allowed exceptions are option cards, form controls, the FilePicker in a Dialog and full-height panes (§1).

- **Input borders are a signed-off contrast exception.** An input's 1px `line` border on the page ground is about 1.38:1 (dark, `#2A2A28` on `#0A0A0A`) / 1.36:1 (light, `#D9D8D2` on `#FAF9F6`), below the 3:1 WCAG asks of UI component boundaries. The maintainer signed this off with the reference set (2026-10-26): the soft line is the refined E look, and an input is never identified by its border alone. It always carries a visible label (Field, `body` `ink`) or a placeholder/prefix inside it, it shows a `line-strong` border on hover, and focus draws an `accent` border plus the 3px `focus-ring` halo. `tokens.json` keeps no contrast pair for `line` for this reason; a new component that relies on a `line` border as its only boundary needs its own sign-off.

**Radius**: `sm` for inputs, buttons, chips, nav items and conversation rows; `md` for inline cards, property sections, stat cards, form field cards and overlays; `bubble` for message bubbles and the switch track; **0** for tables and page structure (sidebar, header, action row).

**Shadows** are used only for things that float:

| Token | Dark | Light | Used for |
|---|---|---|---|
| `shadow-1` | `0 8px 24px rgba(0,0,0,.40)` | `0 2px 8px rgba(10,10,10,.08)` | Menu, Popover, Toast, Tooltip, inline menu |
| `shadow-2` | `0 16px 48px rgba(0,0,0,.50)` | `0 8px 24px rgba(10,10,10,.12)` | Dialog, command palette |
| `shadow-sheet` | `-16px 0 40px rgba(0,0,0,.40)` | `-4px 0 16px rgba(10,10,10,.08)` | Sheet |
| `shadow-float` | `0 8px 24px rgba(0,0,0,.45)` | `0 8px 24px rgba(26,26,24,.08)` | The composer |
| `shadow-float-touch` | `0 6px 20px rgba(0,0,0,.35)` | `0 6px 20px rgba(26,26,24,.10)` | Touch floating controls (on `float-ground`) |

- Layering: Sheet 40 · Dialog 50 · Popover/Menu 60 · Toast 70 · Decoration 80 (`--cb-z-*`; the decoration layer of §4.5 sits above everything).
- Motion: hover background transitions `motion.hover` (120ms); expand / collapse height transitions `motion.expand` (160ms); overlays fade in with a 4px offset over `motion.overlay` (120ms), `ease-out`, no bounce; the spinner turns once per `motion.spin` (800ms), the streaming cursor blinks every `motion.cursor` (1000ms), a running agent's dot in the agent map pulses every `motion.pulse` (1600ms, §6.16.28), the generating image placeholder's colour field drifts once per `motion.flow` (6000ms, `ease-in-out`, alternate; transform only, §6.16.20). `prefers-reduced-motion: reduce` makes all of them instant, the spinner static, the cursor steady and the placeholder still (§6.11).
- Push motion: a push and a pop (§4.6) run over `motion.push` (350ms) with `ease.push` (`cubic-bezier(0.2, 0.9, 0.3, 1)`, the iOS navigation default); under `:root[data-shell-platform="android"]` (a native shell on Android) they are 300ms and `cubic-bezier(0.2, 0, 0, 1)` (Material emphasized). `tokens.json` holds the curves under `ease` (`--cb-ease-<name>`) and the platform values under `platform.<ios|android>`; reduced motion makes them instant.
- Focus: inputs, selects and textareas get an `accent` border plus a 3px `focus-ring` halo (`box-shadow: 0 0 0 3px focus-ring`); other controls use `outline: 2px solid accent; outline-offset: 2px`; table rows, list items, nav items and conversation rows use `outline: 1px solid accent; outline-offset: -1px`. `:focus-visible` only. A ring never follows a mouse click: a text field (input, textarea, stepper, the composer) keeps its halo while it has focus, since it is being typed in, but every other control, the Select's button included, draws it under `:focus-visible` (the Select also while its list is open); a tab a pointer focused carries `data-pointer-focus` and draws no ring whatever the browser's heuristics say, until a key press (a modifier alone does not count) or a blur (acceptance issue Y); the mark is set only when focus arrives from that press (or at once when the pressed tab already has focus, since Chrome keeps that focus's keyboard origin), so a press that gives no focus (WebKit and Firefox on macOS do not focus a clicked button) never hides a later keyboard ring. The focus a compact overlay moves on open (the drawer's first row, a level's back row, a bottom sheet's close button) draws a ring only when the overlay was opened from the keyboard: otherwise the element carries `data-quiet-focus` (no ring, no ground) until a key press (a modifier alone does not count) or a blur, whatever the browser's heuristics say (Chromium rings a script's focus when it has seen no pointer press, as in a native shell's call; acceptance 2026-11-22). `packages/design/test/focus-rings.test.ts` checks the stylesheets.

### 2.6 Icons

- One line-icon set site-wide: Lucide (ISC, vendored as paths in `packages/design/src/icons/paths.ts` by `pnpm --filter @capybara-hq/design gen:icons`, license next to it), 24 grid, stroke 1.5, sizes 16 / 14 / 12; on touch 22 (`touch.icon`) and 24 inside a floating button (`touch.icon-float`). The component is `Icon({ name, size, label? })` (§6.12).
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
- **The brand slot**: the sidebar's brand row (`Sidebar` prop `brand`, a function of the panel it is drawn in, `(v: { collapsed, panel: "full" | "rail" }) => ReactNode`, called once per drawn panel; default the `Logo` above, with the wordmark unless the sidebar is the rail) is the replaceable slot `shell.brand`: one chosen plugin `component` may draw the row's content instead (props `builtin`, the default node, `collapsed`, true on the rail, and `panel`). The row keeps its size and its `data-cap-part="sidebar.brand"`; a failing or still loading replacement shows the built-in (`ReplaceableFrame`, §4.5). The theme's logo (above) still reaches the built-in through the design context.
- **Brand from a theme**: a theme may replace the logo mark and the wordmark. The web passes the resolved theme's brand to `DesignProvider` (`brand: { markUrl, wordmark, illustrationUrl, decoration, productName }`, any URL or text part null), and `Logo` draws it where it draws the pixel capybara: `markUrl` as an `img` as high as the bitmap would be (10 × the pixel unit, so 20 / 30 / 60; its width follows the file; `alt` is the product name, else the wordmark, else "Logo") instead of the bitmap, `wordmark` as the wordmark text instead of `CAPYBARA` (only where the wordmark is drawn: the rail has none). A null part keeps the built-in one. The sidebar, `AuthPage` and `StatusPage` draw `Logo` and take no props for it.
- **Theme graphics**: the brand a theme gives (`Brand`: `markUrl`, `wordmark`, `illustrationUrl`, `decoration`) reaches three more places besides `Logo`: the working line's and the greeting's mark (§6.16.24, §6.16.25: the theme mark, 20 px high, width following the file up to 3 × the height) and the empty state's art (§6.18: `illustrationUrl ?? markUrl` as a mask filled with `faint`). The platform name is only `Logo`'s `alt`; the greeting's, the working line's and the empty state's art are decorative. A mark that fails to load falls back to the pixel capybara it replaces. A URL reaches CSS only through the `--cb-brand-art` custom property, set as an escaped quoted string (`url("…")` with `"` and `\` escaped), never interpolated into a stylesheet. `decoration: "none"` removes the auth pages' dither columns (§5.10). The built-in `CAPYBARA` wordmark stays unless the theme gives its own `wordmark`.
- **Dither dot matrix**: used only for the backgrounds on both sides of auth pages and (optionally) the PageHeader corner of the overview page; 4px squares in `line`, density decreasing from one side to the other, greyscale only (no accent squares). No other page may use it.
- **Agent avatars** (§6.30) are the one place with pictures and their own colors: the ten pixel animals, drawn like the Logo (a 12×12 bitmap of solid squares, `crispEdges`), each in its animal's palette on a soft ground (the `avatar-*` color tokens, and `accent` for the capybara). Nothing else in the UI may use the animal palettes.
- Apart from agent avatars, the generating image placeholder (§6.16.20, built from `accent`, `accent-hover`, `ink` and `panel` only) and a theme's empty-state art (§6.18, only as a `faint` mask): no illustrations, gradients, frosted glass or emoji. Nothing else may cite these exceptions.

---

## 4. App Shell (system layout)

The shell follows the window's **size class** (mobile and foldable layout spec `docs/superpowers/specs/2026-11-19-mobile-layout-design.md` §3), by window width in CSS px, never by orientation, device model or user agent:

| Class | Window width | Media query | Typical windows |
|---|---|---|---|
| `compact` | below 600 | `(max-width: 599px)` | Phones in portrait, the iPhone Duo outer display (382), a narrow split screen |
| `medium` | 600–840 | `(min-width: 600px) and (max-width: 840px)` | Tablets in portrait, unfolded foldables in portrait |
| `expanded` | 841 and up | `(min-width: 841px)` | Tablets in landscape, the iPhone Duo inner display in landscape (951), desktops |

- A foldable opening or closing, split screen or a narrowed desktop window is just a class change, handled by CSS live, with no reload and no lost state.
- **CSS is the authority.** Every structural difference between classes is a media query on exactly these widths (`SIZE_CLASS_QUERIES`, exported once from `shell/size-class.ts`; it replaces the sidebar's `SIDEBAR_RAIL_QUERY` / `SIDEBAR_DRAWER_QUERY`). The one other width threshold is **1280**, where the conversation's right area sits inline beside the thread (§5.4); the `design-breakpoint` check rejects any other `max-width` / `min-width` number in a width media query of the design CSS (mobile layout spec §3.1, §11.4). Component-level fits are container queries on the template frame (§4.3), which that check does not cover.
- `useSizeClass()` returns `"compact" | "medium" | "expanded" | null` (`null` on the server and during hydration). Where a tree differs by class the server renders every variant and CSS shows one (§6.13 "First paint"); a page never branches on the width, the class or the shell.
- The shell element carries the class as the state token `size=` (§4.5), so plugin CSS can follow it without its own media queries.

Every page (except auth pages, §5 T10) is **navigation | content area**, drawn per class:

| | compact | medium | expanded |
|---|---|---|---|
| Navigation | The **drawer** from the floating menu button on a chat surface (§4.6, §6.54) | **Navigation rail**: the icon rail (`layout.sidebar-rail`), the conversations behind a rail button (§4.1) | **The full sidebar**, collapsible to the rail by the person (§4.1) |
| Ground and paper | None: the page is full-bleed paper | The rail on the ground, one paper | The sidebar on the ground, one paper (two on a conversation with the right panel inline, from 1280) |
| Page | Full screen; every page but a chat surface is **pushed** (back in the floating row, §4.6, §6.56) | One pane, or two panes when both fit (§6.47) | Today's layouts (§4.3) |
| Sidebar content (org switcher, 更多, account, admin entry) | The drawer (§6.54) and its account sheet (§6.55); the management pages are not in touch navigation | Rail popovers | The sidebar |
| Right area (conversation) | A full-screen page pushed over the conversation (§5.4) | A side sheet with a follow-finger dismiss (§6.7) | Inline paper from 1280, a side sheet below (§5.4) |
| Floating row | The **floating row** (§6.56): menu or back, the page's centre and trailing controls | None | None |
| ActionRow | Sticky at the bottom, above the safe area and the keyboard | As today | As today |

The content area holds, top to bottom, in a fixed order:

| Layer | Height | Required | Content |
|---|---|---|---|
| Floating row | over the page's top | Compact only | Menu (chat surfaces) or back (pushed pages), the page's centre pill and overflow (§6.56) |
| PageHeader | content | Required | Row 1 the path; row 2 title + one-line description, actions on the right; optional tabs row (§4.2) |
| PageTabs | the head's tab row | Optional (detail pages only) | In-page tabs, current item underlined; drawn by the template as the head's tab row, the same box as the PageHeader's row 4 (§4.2) |
| Body | flexible | Required | One of the layouts in §4.3 |
| ActionRow | `layout.action-row` | Optional | Appears when the page has actions to submit, fixed at the bottom of the paper (compact: above the safe area) |

- The sidebar (or the rail) spans the full window height; the ActionRow sits **only in the content area**, fixed at the bottom of the paper; it never spans the sidebar. There is no status bar (maintainer decision 2026-11-28): what it showed lives in the composer, the properties panel and the account menu (§6.16.2, §6.16.17, §6.13).
- **Ground and paper** (maintainer decision 2026-11-28, layered shell spec `docs/superpowers/specs/2026-11-28-layered-shell-design.md`): from 600 up the shell has two planes. The **ground** (`sidebar` colour) is the sidebar, the rail and the gutters; the **paper** (`bg`) is the page, lying on the ground: inset `space.2` from the top, the end and the bottom (at its start it meets the sidebar's edge), radius `md`, clipped, **no border and no shadow** (the edge is the colour step alone; a shadow on the warm ground drew a grey fringe). The conversation page has two papers side by side, `space.2` apart, the thread's column and the right panel inline (from 1280; the panel's resize handle sits in that gap, and a side sheet or a full-screen panel leaves one paper). Below 600 there is no ground: the page is full-bleed paper. The paper is the shell's, not a box a page draws (§1: one box is enough). The content keeps its maximum width on every template, centered, with the paper's colour on both sides.
- There is no floating row on medium and expanded; on compact it lies over the page's top (§4.6).
- **Short window** (`data-short`, §4.7): height below 480 sets `data-short` on the shell, whatever the width.

**Inside the desktop shell** (desktop client spec §7.3 "The top row", mobile layout spec §9.3): the shell has no band above it; the sidebar's brand row, the conversation title bar, a template head's path row, the compact floating row and the shared file page's bar are the window's top row, as high as the window controls' rectangle and keeping clear of it (the brand's wordmark gives way beside the lights; where the controls reach past the rail, the top row is one band across the window on the page ground, the rail's surface and divider start below it with a `line-soft` hairline under the band across the window, and the collapsed rail's expand button, or the medium rail's sidebar toggle, sits in the band after the controls). The path row's path follows whatever precedes it in the row, not the centred content frame (maintainer decision 2026-11-21): beside the full sidebar it starts at the title bar's start padding, past a rail right after the band's toggle; a path of the org slug alone is not shown there. A browser keeps the path row in the content frame. The window drags only from `DragFill` spacers (empty, `aria-hidden`, drawn by those templates between their controls) and the controls area, never from a row that holds controls, and not while an overlay is open.

### 4.1 Sidebar

See §6.13 for the component.

- **Expanded** (841 and up): the full sidebar, width `layout.sidebar`, with a **collapse toggle** at the end of its brand row (`panel-left`, "收起侧栏" / "Collapse sidebar"; ⌘\ / Ctrl+\). The person's choice, the full sidebar or the rail of `layout.sidebar-rail`, is remembered in the cookie `cb-sidebar=rail`, which the app layout reads like the theme cookie, so the first paint draws the chosen form and nothing jumps. The sidebar never turns into the rail by itself at any width.
- **Medium** (600–840): the rail only, with no expand button (the full sidebar does not fit beside the content); instead a **sidebar toggle** (`panel-left`, "显示侧栏" / "Show sidebar") where the expand button sits opens the full sidebar as a **drawer** over the content (maintainer decision 2026-11-21, §6.13), and ⌘\ / Ctrl+\ opens and closes it (maintainer decision 2026-11-22; the remembered choice stays); and one more button, 会话, which opens the sidebar's conversation section as a side sheet over the content (§6.13); the account row's popover holds the org switcher and 更多 as the rail's does.
- **Trims** (maintainer decision 2026-11-28): the sidebar has no right line and its own ground is the shell's `sidebar` colour, so it reads as the ground (§4); nothing in it is framed: the org switcher draws no box, and there is no line above the account row.
- **Compact** (below 600): no sidebar. The drawer (§6.54), opened from the floating menu button on a chat surface, holds what the sidebar held, less the management pages.
- **Two width rules** are the whole width layout beside the classes: the full sidebar from 841; the conversation's right area inline from 1280 (§5.4). With the full sidebar at 841 the content area is 585 wide, above `layout.chat-min` (480) and `layout.content-min` (552).

### 4.2 PageHeader

- Four rows. Row 1: the **path** `scope / page [/ object]` (mono, `small`; the segments in `muted`, the `/` separators in `faint`, the last segment, the current page, in `ink` with `aria-current="page"`; the conversation title bar's path the same), inside a `nav` labelled "Path"; earlier segments with a link are links. The scope is the org slug for workspace pages (links to the workspace's home, the new conversation `/`; there is no home page, and `/chat` redirects permanently to `/`, maintainer decision 2026-11-07), `~` for personal pages (`/account/*`), `/admin` for admin pages. Row 2: title (`h1`, single line with an ellipsis, full text in `title`) + count / status, actions on the right, centred on the title's line whether or not a description follows (one alignment on every page; browser review F23, 2026-11-10) (at most one primary, rightmost; an action whose call is running draws the Button's loading state, `loading`, and cannot be pressed again until it settles; meanwhile the head's other buttons are `disabled`). An object's page may lead row 2 with its avatar (`avatar`: an `Avatar` at 40, §6.30, centered on the row; the agent page). Row 3 (optional): a one-line description (`prose-small` `muted`, single line with an ellipsis). Row 4 (optional): **tabs** with counts (`全部 6 · 我的 3`) for pages with views, with the **search** field at the right end of the same row; a tab changes the view (`onSelect`) or links (`href`). The tab row has one height with or without the search (`control.default` + `space.1` above and below) and a 1 px `line-soft` bottom border; the tabs sit at its bottom and overlap the border by 1 px, so the selected tab's underline lies **on** the border; the search is centered vertically. While a ListPage loads, the tabs and the search keep their place and a tab's count is a `faint` "–" (§5.1). Tabs never wrap: a tab row too narrow for its tabs scrolls sideways (§6.4). **Below 600** (maintainer decision 2026-11-09) the title and the description take the full width and the description wraps instead of taking an ellipsis; the actions, the search and the tabs take the compact head below (maintainer decision 2026-11-22; it replaces this rule's actions line, search line and 40 px tabs).
- **Loading** (`PageHeader.loading`, `{ title?, avatar?, actions?, tabs? }`; `avatar` draws a 40 px `block` skeleton in the avatar slot for a head whose loaded state carries an avatar (the agent page), so the row keeps its height; the templates' `loading` states build on it): the header keeps its rows, so nothing moves when the data arrives. What the page already knows renders for real: the path, a known title, the `actions` and `tabs` it was given. A `title` that is not known yet is a `title`-size bar (§6.29) 30% wide in the h1's line box, with no empty heading. `actions` / `tabs` give the number of placeholders to draw when the page does not know them yet (an action is a 72 px `default` control block, a tab a 56 px `body` text slot); they are drawn only while the real list is empty. **Below 600 the placeholders take the compact head's sizes** (state `narrow-loading`): there is no path row (as loaded), the title bar is the large title's line, the action blocks sit on the actions line under the title at the `default` control height (44 under the mobile sizes, §2.5) like the real primary, and the tab slots are `touch.hit` (44) high like the compact tabs (the segmented control or the scrolling tab row), so the header does not change height when the answer arrives. The action placeholders are the ones the loaded actions line will show: in a shell one for the primary (a full-width one for a `block` primary) and none for a FAB, whose line then takes no room; outside a shell the ⋯ and the primary (only the ⋯ for a FAB). The header is `aria-busy` with the hidden "正在加载 / Loading", unless it sits inside a skeleton group (§6.29), which announces once. Nothing animates.
- **Path rule** (maintainer decision 2026-11-28): from 600 up row 1 is **not rendered** when the path has two segments or fewer (a first-level page: scope / page; the sidebar already says where the page is); the title row starts the head. A path of three segments or more keeps row 1. The `path` prop stays required (the compact back and `web-ui-page-path` walk it). Because a page without row 1 would have no drag area in the desktop shell, the title row holds a `DragFill` between the title block and the actions (empty, `aria-hidden`; the row's controls never drag, §4).
- No bottom line and no background; spacing separates it from the body.
- **Compact: no path row** (maintainer decision 2026-11-22; replaces the short-window rule R26): below 600 the PageHeader draws no row 1 at any height, in a browser and in every shell: the floating row's back (§4.6) and the h1 name the page and keep the way up. A band head (below) keeps its actions. Medium and expanded have no floating row (a phone in landscape at 844 × 390 is expanded), so they keep the path row as their way up on pages of three segments or more (first-level pages draw none, the path rule below; inside the desktop shell the path row is the top row, desktop client spec §7.3, and a first-level page's title row carries the drag filler).
- **Compact head** (below 600; maintainer decision 2026-11-22; responsive system spec §2.1): one form for every template that has a head, drawn by the template, never by a page. No path row (above). The title is a **large title** (`h1` at the compact size) with its count (`header.count`, else the first tab's count) beside it in muted mono (「智能体 3」); the description wraps. The template says where the **primary** goes (`PageHeader.primaryForm`, never set by a page; medium and expanded ignore it): `"fab"` on a ListPage, whose `data-fab` CSS restyles the head's primary button itself as the floating action button (§6.62; one element, and an actions line holding nothing else takes no room in the head); `"block"` on a DetailPage, SettingsPage and OverviewPage, a full-width button on the actions line under the title (and the description), `control.default` (44) high, `space.3` (12) below the title block; `"head"` (the default) keeps the head's ordinary button on that line, start-aligned. A Form or Wizard keeps its sticky ActionRow (§4.4). The **secondary actions** (`header.actions` without `variant: "primary"`) all go into the floating row's "…" overflow (§6.56) through `ShellPage.actions`, also when there is only one (no second row of buttons in the head; links navigate through the shell's `onNavigate`); a head outside a shell folds them all into one `more-horizontal` menu on the actions line, before the primary (the head draws that menu in the first paint inside a shell too: the server render and the page before hydration have no shell "…" holding the actions yet, and hydration hands them over, coordinator ruling 2026-11-22). The count is mono. The secondaries and the count differ per class, so they are drawn by `ClassForms` (responsive system spec §5.3): the server render carries both forms and CSS shows one, the hydrated page keeps the matching one. The path is one element: the compact stylesheet hides it before hydration and the hydrated compact page drops it (`useClassForm`). The primary is one element in both forms. The **search** takes its own full-width line under the title: 44 high, filled `selected` ground, no border, 16 px text. The **tabs** (first-level scope) are a full-width segmented control with equal parts for two or three tabs (`look="segmented-compact"`, §6.4; the tab row then draws no bottom line, the control has its own frame) and stay the sideways-scrolling tab row for four or more; a level-2 view choice is a row of scope chips (§6.63). Search and scopes are one block that scrolls away with the content and returns on scrolling up (§6.65).
- **A band head** (`PageHeader.titleHidden`, the device page; accepted 2026-11-14): a page whose first block is its own name band (a `DeviceNameplate`) leaves row 2 out and the band is the page's visible head. The path and the actions share one row (the path takes the room between them, `space.3` between them), and `title` stays a visually hidden `h1` so the page still has a name for assistive tech. The description, count, status and avatar have no place in this variant; a page that needs them keeps its title row. The band sits `layout.head-path` (12) below that row; a tab row the page still owns follows the band at `space.2` (8), so the tab's own `space.1` inner padding puts its text 12 below the band; the first block sits `space.4` (16) below the tab row, or below the band when the page has no tabs. The template draws all of it (DetailPage, §5.2): the page passes `header` and `facts` and no spacing. A title-less head whose page knows nothing yet is `DetailPage.loading.band`, a band-shaped skeleton of the band's height, so the head does not jump when the data lands. **Below 600** there is no path (above): the row holds the actions alone, start-aligned (the secondaries in the shell's "…" as on every compact head); a name band's figures put each value on one line and wrap whole figures, never breaking a value.
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

  The gaps are the head's own: the body adds no space above its first block (no top padding on a detail page's content, a form's first section or a settings grid), and no template sets a gap of its own, so the path, the title row, the tabs and the first block sit at the same y on every template for the same head (List, Detail, Form, Settings, Overview, Inbox, Trace, Wizard, and Status / Onboarding, which share the head). A detail page's in-page tabs are the head's tab row (the same box as row 4: `control.default` + `space.1` above and below, the 1 px `line-soft` bottom border, 40 px tabs below 600). In-head StatCards sit `layout.head-content` below the PageHeader. A title row led by the avatar centres the title block and the actions on the 40 px avatar. The conversation title bar (§6.16.1) is one 48 px row (the path and the title on one line), so the rhythm does not apply to it; it shares the path's look and its horizontal spacing only. Checked by the `head-rhythm` blocks (below) and `apps/web/visual/head-rhythm.spec.ts`, which measures every template's path, title row, tab row and first block and expects them equal, and by the design unit test `head-rhythm.test.tsx`.

The `narrow` and `narrow-loading` states are the compact head in a 390 window, outside a shell: no path row, the secondary folded into the head's ⋯ beside the head primary on the actions line, the search full width (358) above three tabs drawn as the segmented control.

<!-- states: page-header -->
States: `title`, `path`, `description-actions`, `long-title`, `narrow`, `loading`, `narrow-loading`, `avatar`, `no-title`

<!-- size-table: page-header -->
| Part | State | Property | Value |
|---|---|---|---|
| page-header-title | title | font-size | type.h1 |
| page-header-title | title | line-height | type.h1.line |
| page-header-title | title | color | color.ink |
| page-header-row | title | margin-top | 0 |
| path | path | font-size | type.small |
| path | path | color | color.faint |
| page-header-row | path | margin-top | layout.head-path |
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
| tab | narrow | height | touch.hit |
| button[data-variant=primary] | narrow | height | control.default |
| skeleton-text[data-size=title] | loading | height | type.h1.line |
| skeleton-box[data-box=default] | loading | height | control.default |
| skeleton-box[data-box=default] | narrow-loading | height | control.default |
| page-header-tab-slots | narrow-loading | height | touch.hit |
| page-header-avatar avatar | avatar | width | 40 |
| page-header-avatar avatar | avatar | height | 40 |
| page-header-titleless | no-title | gap | space.3 |
| page-header-titleless | no-title | height | control.default |

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
| List + Item | list 320 + flexible; the item's facts inline (a 400 column from a 1100 frame, else above its content) | Inbox (§5.7; maintainer to confirm: R20, R24) |
| Centered | content max `layout.content` (1120), centered | Forms, settings, wizards |

- Content width: **one** width for every page template (list, overview, form, settings, wizard, detail, trace, inbox, onboarding, status), `layout.content` (1120), centered (100% wide below that), with `space.6` (24) of side padding inside the paper from 600 up (the paper's inset already separates the page from the ground, maintainer decision 2026-11-28; 16 below 600) and `space.5` (20) above the header; the page head and the body (also a detail page's tabs) share that container. The head and the scrolling body both reserve the scrollbar gutter (`scrollbar-gutter: stable`), so a classic (non-overlay) scrollbar never shifts the body's column against the head. The head therefore sits at the same x and y on every page and on every tab of one page. The inbox's list + item split is capped at that width inside the same padding; the trace viewer's waterfall and detail share its one left edge (§5 T8). A form keeps its label column inside it (forms put `space.6` between sections, lists `space.3`); the conversation page has its own columns (§5.4). The Centered layout has **no anchor navigation**; a form's error count lives in the ActionRow.
- Content has a minimum width of `layout.content-min` (552: the narrowest medium window, 600, less the 48 rail; the full sidebar at 841 leaves 585). A facet Rail is collapsible; the inbox's list has no collapse button and its facts are inline, never closed (§5.7; maintainer to confirm: R20).
- **Side columns fit** (maintainer decision 2026-11-20: the full sidebar keeps its 256 from 841, so a window can leave a body less room than today's rail did): a body's side column (the facet Rail 240, a FormSection's label column 240, a SettingsPage's sub-nav 200, the inbox's list 320) is inline only while its template frame leaves `layout.content-min` for what sits beside it (the inbox list: 320 beside a detail of at least 360, §6.47); otherwise it takes its narrow form: the Rail a toolbar "Filter" button with a sheet, the label column stacked above its fields, the sub-nav stacked above the content, the inbox a two-level stack. The fit is a container query on the template frame, not on the window, so the sidebar or rail, a second viewport segment and a nested pane count correctly.
- Scrolling: the sidebar, PageHeader / PageTabs / ActionRow are fixed; the sidebar's conversation section, the Rail (or the inbox's list) and the Content (the inbox's open item) scroll independently; the page must not show a horizontal scrollbar (wide tables scroll inside their own container).
- Responsive, by size class (§4): the inbox's facts never move into a Sheet (§5.7); a facet Rail that does not fit (above) is a toolbar "Filter" button plus a sheet (a bottom sheet on compact, a side sheet on medium and expanded); the shell's own forms per class are §4 and §6.13; on **compact** (below 600; phones, checked at 382 and 390 × 844) the head is the compact head (§4.2: the secondary actions in the floating row's "…"), and:
  - nothing scrolls sideways: the side padding is 16 on every template and on the conversation page (§5.4), and nothing keeps a minimum width wider than the window;
  - tab rows scroll instead of wrapping (§6.4), with the edge fade as the scroll hint and the current item scrolled into view (the settings sub-nav too), and the page head's search takes its own line (§4.2);
  - every DataTable is stacked rows (§6.6) and StatCards are two columns (§6.14);
  - a `Grid columns="list-detail"` (a 220 px list beside a flexible detail, top-aligned: the agent page's prompt files and the open file's editor) is a `ListDetail` (§6.47): the list is the page, and choosing an item pushes the detail full screen;
  - every hit target is 44 (`touch.hit`), with a fine pointer too (the mobile sizes, §2.5, maintainer decision 2026-11-22): controls and rows are 44 by their scales, `control.prominent` 52, the sticky ActionRow's primary `touch.primary` 48; the page head's tabs, the settings sub-nav's items, the DataTable row menu, the page head's actions and an ObjectRow's action and menu are 44 by the same scales, with no invisible ring; the floating buttons (§6.51) are `touch.float`; the drawer's rows (§6.53) and the conversation title bar's buttons (§6.16.1) keep their own sizes there;
  - every object list is one grouped card of rows (§6.17, maintainer decision 2026-11-22): a row that opens something shows no buttons (its actions in an ActionSheet on long press or right click) and ends in a chevron, a row that opens nothing keeps its one button and a labelled ⋯ when it has more menu items, and the state closes the meta line in its tone;
  - the page head stacks (§4.2): title and description across the width (the description wraps), the actions under them;
  - a SettingsPage's sub-nav row sticks to the top of the scrolling body (§5 T5); the PageHeader's own tabs and a DetailPage's in-page tabs sit in the fixed head already;
  - type takes the Touch column's sizes (§2.2, the mobile sizes of §2.5): `micro` (13) is the smallest.
  - under the mobile sizes (`MOBILE_SIZE_QUERY`: compact, or a touch screen at any width) text fields (inputs, textareas, selects, editable text) are at least 16 px, so iOS Safari never zooms the page into a focused field; the viewport keeps pinch zoom (no `maximum-scale`).
  - on a touch device (`isTouchPointer()`: a coarse primary pointer, or a coarse pointer and no fine one) a tap that only chooses something (an agent, a quick action) never moves focus into a text field, so the keyboard does not pop up; a quick action places its text without focusing. Pointer devices keep the autofocus (maintainer acceptance 2026-11-09).
  - **the on-screen keyboard** (maintainer acceptance 2026-11-09): iOS keeps the layout viewport when the keyboard opens, so a composer pinned at the bottom would sit behind it. `AppShell` follows `window.visualViewport` (`resize` and `scroll`, coalesced to one `requestAnimationFrame`, listeners removed on unmount) and writes the keyboard's height over the shell's bottom (`keyboardInset`: shell bottom − `vv.height` − `vv.offsetTop`, at least 0) to the shell as `--cb-keyboard-inset`, with `data-keyboard="open"` while it is above 0. The conversation page pads its bottom by it, so the composer (on a new conversation and on `/chat/<id>`) stays above the keyboard and the thread above it shrinks;  While the keyboard is open the shell never scrolls the document (the inset does the work); once it closes the document goes back to 0, 0 as before.

### 4.4 ActionRow

- **ActionRow**: when the page has actions to submit (forms, bulk edits, approval decisions, wizards) it stays fixed at the bottom of the paper. Height `layout.action-row`, `panel-2` ground across the content area, `line-soft` top line; inside a template its row is the content frame (the template's side padding, `layout.content` wide and centered, the body's scrollbar gutter), so the primary ends where the content ends; outside a template (the reference set) the padding is `layout.gutter`. Left: an accent dot + "N unsaved changes" (`muted`) `·` "N errors" (`fail` text, no icon, as the signed reference; the words carry the state), or a muted "No unsaved changes" ("没有未保存的修改", when the page passes `unsaved: 0`; never on a create form, §5.3); right: Cancel / Discard (default) · secondary action (default) · primary action (primary, rightmost), all `default` density. With no changes the primary is disabled.
- **Compact** (§4): there is no status bar (the account sheet carries the system status, version and time zone, §6.55); the ActionRow is sticky at the bottom of the content area, above the bottom inset (`--cb-inset-bottom`) and the keyboard (`--cb-keyboard-inset`), There its buttons are **stacked to the width** (maintainer decision 2026-11-20; on every ActionRow, forms included: maintainer to confirm: R16): the **primary fills the bottom line** on its own, full width, and the other actions (Cancel / Discard, a secondary) share the line above it side by side in equal widths, never right-aligned with empty space on the left; each button is `touch.hit` (44) high and the primary `touch.primary` (48) (the mobile sizes, §2.5, maintainer decision 2026-11-22) with its usual variant, the lines `space.2` apart, the row padded `space.2` 16 px (the gutters) and growing to fit (no fixed `layout.action-row` height). The unsaved / errors text, when the page has it, is one `small` line above the buttons. A row with **one** other action (a form's Cancel / Discard + Save) puts it alone on the upper line at full width, the primary alone under it; a row with only a primary is that one full-width line.
- A page must not create its own floating / fixed bottom button bar.
- ActionRow is a design component; a page passes its props to the template and does not render it directly.

<!-- states: action-row -->
States: `unsaved-errors`, `clean`, `compact`

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
| action-row | compact | background-color | color.panel-2 |
| action-row | compact | padding-top | space.2 |
| action-row | compact | padding-left | space.4 |
| action-row | compact | row-gap | space.2 |
| action-primary | compact | height | touch.primary |
| action-secondary | compact | height | touch.hit |

---

### 4.5 Plugin decoration primitives

Three primitives host plugin interface code (client extensions spec §6, §7.4, §9.6); the design system draws them, apps/web only places them.

- **DecorationLayer**: `position: fixed; inset: 0` at `z.decoration` (80, above every other layer), `pointer-events: none` on the layer and its descendants except `[data-cap-interactive]`. Not a box; it holds no content a person needs. The layer is not `aria-hidden` itself, because an interactive element must never sit under `aria-hidden`: a layout effect and a MutationObserver put `aria-hidden` on every element that neither is nor holds an interactive element (`data-cap-interactive` or focusable; only the layer's own marks are removed again, a plugin's `aria-hidden` stays). Text directly beside an interactive element stays exposed (rewriting React-owned text nodes was tried and reverted), so a plugin marks such decorative text `aria-hidden` itself.
- **ReplaceableFrame** (`pending`): wraps a built-in region a plugin component may replace; while `pending` it is `visibility: hidden` (no `inert` or `aria-hidden`, which would outlast the reveal; `visibility` itself keeps it out of the focus order and the accessibility tree), so the region keeps its size and nothing jumps. CSS alone reveals it after 1 500 ms (`CLIENT_LIMITS.pendingMs`), so a pending frame the server drew never stays hidden, with or without scripts. It takes a `ref` to its element so the host can watch what renders inside. It draws no box of its own (`display: contents`).
- **SafeModeBanner** (`onExit`): one `panel` row with a hairline below, the message and an "exit safe mode" button. It is drawn **as a row of the App Shell**: `AppShell` and `SetupPage` take `banner`, which sits in row 1 of the shell's grid (`.cb-shell-banner`, `data-part="shell-banner"`; the shell carries `data-banner="true"`, the sidebar and the content column start in row 2), so the shell still ends at the viewport bottom and the composer is not clipped. The width queries (`SIZE_CLASS_QUERIES`, §4) are exported from `shell/size-class.ts` and are the only place they are written.

Built-in elements carry `data-cap-part="<name>"` (the public hooks of plugin CSS, `UI_PARTS` in the SDK; `data-part` stays internal); the shell element also carries `data-cap-state` (`AppShell` prop `capState`), and `Sidebar` takes `brand` (a function of the panel) to draw instead of the Logo.

- **Parts** (`UI_PARTS`, client extensions spec §7.1; table in [docs/guide/ui-parts.md](../guide/ui-parts.md), generated): a part name is public, versioned and carried as a literal `data-cap-part` attribute that may hold several names (`button button.primary`); plugin CSS selects with `[data-cap-part~="<name>"]`. `owner` is the list of files that draw the element (one concept can have several drawers). A part promises only the states in its `states` (`aria-current`, `aria-busy`, `aria-expanded`, `disabled`); the `sidebar` and `section` parts promise no `aria-expanded` (the sidebar mode is a state token). Renaming or removing a part, or dropping a promised state, bumps its `version`; inner markup is not part of the contract (selectors stop at the part). `pnpm check:ui-parts` pins every literal to its owner.
- **State tokens** (§7.3): `data-cap-state` on the shell element is a space-separated token list in this order: `run=idle|running|waiting|failed`, `theme=<plugin>/<theme file id>` or `theme=builtin`, `sign-in=new` on the first workspace document of a sign-in, then after hydration `motion=full|reduced`, `sidebar=rail|full` (absent on compact: there is no sidebar), `size=compact|medium|expanded` (§4), and `shell=desktop|mobile` (only inside a native shell, mobile layout spec §9.3). Selected with `[data-cap-state~="run=running"]`.

### 4.6 Compact shell: chat surfaces, pushed pages, floating controls and the drawer

The chat-first compact shell (maintainer decisions 2026-11-21, mobile layout spec §4; mobile app plan Decisions 17-19, 25, 27). One shell for every pointer: a narrow desktop window gets it too, with the mobile sizes (controls, rows, type and the floating buttons' `touch.float` apply under `MOBILE_SIZE_QUERY`, compact or touch, maintainer decision 2026-11-22, §2.5); the touch components' forms (the bottom sheet's touch form §6.7, the large rows §6.17 / §6.33, the drawer's rows §6.52) follow the width too; only what is about the pointer itself (the system font §2.2, the desktop-only gate §6.54) stays under `TOUCH_QUERY`.

- **No top bar and no bottom navigation.** Below 600 the shell draws neither a title row nor a tab bar; there is no status bar on any class (its system status is in the account sheet, §6.55). The page reaches the top edge, and a **floating row** (§6.56) lies over its top, `space.2` under the OS top inset, `space.4` from both sides.
- **Chat surfaces and pushed pages.** A *chat surface* is the home's new conversation (`/`) and a conversation (`/chat/<id>`); the app says so (`AppShell.chatSurface`), no page declares its depth. Every other page is *pushed*. On a chat surface the floating row's leading control is the **menu button** (§6.51, the badge is the pending inbox count), which opens the drawer; on a pushed page it is the **back button**. A `ListDetail` in its detail form (§6.47) and a conversation's right area (§5.4) are pushed pages too, keyed by their URL state: their back replaces the menu button.
- **The centre and trailing floating controls belong to the page.** A conversation's title bar becomes the centre pill and one trailing overflow button (§6.16.1); the home has nothing in the centre and nothing at the trailing end (no 无痕会话 button, Decision 27). A pushed page's head sits below the floating row (the shell pads a pushed page's top by the row's height, `--cb-float-row`), so its h1 carries the title; a chat surface clears the row itself (the thread and the new conversation are padded by it).
- **Back** goes to the previous in-app history entry when there is one, else to the last linked segment of the page's `path` (every page head has a path), else `/` (Decision 19), so a deep link opened from outside still has a way up. The left screen edge is left to the browser's own swipe-back: the web adds no edge gesture.
- **The drawer** (§6.54, maintainer decision 2026-11-22): at the top the search field (it opens the command palette) and the 新会话 button; the navigation as one grouped card: 收件箱 (the count), 智能体, 自动化 (not for a guest) and 更多, which opens the 「技能、连接器、设备…」 level of the same drawer (Decision 18); 最近会话 with 全部 (the conversations page) over the recent conversations by time; and at the foot the account row (it opens the account sheet, §6.55). Management pages (插件, 扩展, 渠道, 组织设置, 评测与运行, 管理后台) are not in it.
- **Back closes an overlay first** (Decision 25): on a compact touch window the drawer, a bottom sheet (the account sheet, the composer's settings sheet) and a sheet over the drawer each hold one history entry, so the system back (Android's back, the iOS edge swipe) closes the top overlay before it navigates.
- **Transitions.** A push slides in from the end edge over `motion.push` with `ease.push` (§2.5), and a pop slides back, bringing the page underneath in from `translateX(-30%)` and `brightness(0.9)` while the top page leaves (CSS view transitions where the browser has them, an instant swap otherwise; nothing under `prefers-reduced-motion`). A pop the browser already animated (`PopStateEvent.hasUAVisualTransition`, a back gesture) swaps at once, so it never animates twice; a move between chat surfaces (a drawer pick of a conversation, the new-conversation button) never slides, nor a move between a native shell's tab roots (mobile app spec §7.2). The sheets' follow-finger drag is §6.7, not a push.

### 4.7 Short windows and safe areas

- **A short window** is one shorter than 480 px (a phone in landscape; the iPhone Duo outer display at its shortest, 368). Width decides the class; the shell sets `data-short`, which no longer trims anything since the status bar went (the PageHeader's path row is gone on compact at every height, §4.2, maintainer decision 2026-11-22; medium and expanded, such as 844 × 390, keep it on pages of three segments or more). A short desktop window gets the same.
- **Safe areas.** With `viewport-fit=cover` the shell pads by the OS insets: the floating row and the drawer by the top inset, the drawer, the sticky ActionRow and the floating composer by the bottom inset (the home indicator), both sides by the left and right insets in landscape (inside a native shell the band already holds the top inset, so the floating row adds only its `space.2`). One set of properties, `--cb-inset-top|right|bottom|left` = `max(env(safe-area-inset-*), var(--cb-shell-inset-*, 0px))`, combines the OS insets with a native shell's own chrome; nothing hardcodes a device's inset. The heights in this spec (`touch.float`, `layout.drawer`) are without the inset.

---

## 5. Page templates

A new page **must** pick one of the following templates; a new template requires extending this section first and going through review. Every template takes the PageHeader of §4.2 and the content widths of §4.3.

| # | Template | Body | PageTabs | ActionRow | Width | Typical pages |
|---|---|---|---|---|---|---|
| T1 | Overview | Single | — | — | content | Agent summary, admin overview, the setup home (the workspace has no home page: the new conversation is the home) |
| T2 | List | Rail + Content | — | During bulk edits | content | Agents, connectors, extensions |
| T3 | Detail | Single (one centred column; the facts block first, §5.2) | Yes | — | content | Agent, connector, channel, eval set and run details |
| T4 | Form | Centered | — | Always (submit actions) | content | Create / edit Agent |
| T5 | Settings | The PageHeader across the full content width, then below it a 200 px sub-nav (named "Settings navigation"; groups with a mono `faint` label, 30 px items, the current item on `sidebar-active`, optional mono counts) beside the content column (while the frame does not fit the nav, §4.3, it stacks above the content; on compact it is a compact control, one sideways-scrolling row of its items above the content with no group labels, 40 px high, the current item scrolled into view, so the content starts on the first screen; it sticks to the top of the scrolling body, right under the fixed head, on the `bg` ground with its `line-soft` hairline, so the sections stay one tap away while the content scrolls, maintainer decision 2026-11-09); the header's `tabs` (a section's own views, such as the models page's 模型 / 用途默认) and `description` open the content column instead of the head, tabs first, so the head keeps one height and the sub-nav's top, aligned with the content's, has the same y on every settings page | — | When there are changes | content | Org, members, environment, security |
| T6 | Inbox | List + Item (facts inline) | — | During decisions | content | Human approval, alert handling |
| T7 | Conversation | Title bar + thread + composer, with the properties panel or one right panel (§5.4) | — | — | own columns | The conversation page (`/chat`, `/chat/<id>`) |
| T8 | Trace | Single: the span waterfall, then the selected span's detail right after it (no stretched waterfall, no gap); from 1280 the detail is a 400 px right panel inside the width, both columns scrolling on their own; stats, waterfall and detail share one left edge | — | — | content | Single run detail |
| T9 | Wizard | Centered + step bar | — | Always (Previous / Next) | content | First-time model, connector and extension setup |
| T10 | Auth | No Shell, centered card + dither dot matrix on both sides | — | — | — | Sign in, password recovery, accept invitation, initialization |
| T11 | System status | Single centered | — | — | content | 404, 403, under maintenance, not enabled, no access (`kind="no-access"`: a 16 px `lock` in `faint` instead of the code, the title, what the page is, `need` as a mono chip "需要：组织管理员" / "Requires: Org admin" (1px `line`, radius `sm`, `small`), `ask` in `muted` (who to ask); never an action or a retry; the web app's one role gate draws it, web-order spec §9) |
| T12 | Onboarding | Single centered checklist | — | — | content | New org, empty environment |
| T13 | Setup | The Shell's geometry with the setup sidebar (§6.13 `context.kind: "setup"`: the setup home and the steps as navigation), the content area (§5.5) | — | — | the page's own (content) | The workspace while the org has no model or no agent (web-order spec §3.8, web-SSR spec §4) |
| T14 | Shared file | No Shell: a top bar (the file's type, name, who shared it and the expiry, Download) over the file rendered across the full width and the remaining height (§5.12) | — | — | full width | A shared file's link (`/s/<code>`; file sharing design §6) |
| T15 | Library | The list (320, grouped by time) and the selected file's preview as two cards side by side (§5.13; a side Sheet when they do not fit, a pushed screen on compact) | — | — | content | The Files page (`/files`; file library design §6) |

### 5.5 Setup (T13)

`SetupPage({ sidebar, title?, children })` is the layout the app frame draws while the current org cannot run yet (web-SSR spec `docs/superpowers/specs/2026-11-01-web-ssr-design.md` §4). It has the Shell's geometry and is built on `AppShell` (§4): the Sidebar on the left, the content area (the top bar on compact, the page) on the right, with the same rail on medium and the bottom navigation on compact (its steps a pushed list, with the setup home as the tab root). The sidebar is the setup context (§6.13): `sidebar` carries the org (the switcher, as in the workspace), `home` (the setup home's link), `steps`, `activeNav` (a step id or `home`), the account, the theme and `adminHref` (super admins). There is no command palette: ⌘K opens nothing and the compact top bar has no search button. The page brings its own template and page head in the content width: the setup home (`/`, the workspace's home; the old `/chat` redirects there, and a route that is no setup route goes there) is an `OverviewPage` with the path `<slug> / 开始之前`, the h1 开始之前, the progress 已完成 n / 2 as the page head's `count` beside the h1, the checklist card (no head band of its own) and 可以稍后再做 (an `h2` over an `ObjectList` of the optional steps, each an `ObjectRow` with the step's icon, its label as the linked name and one sentence saying what it is for); a step page is its own template exactly as in the shell. There is no back link (the sidebar is the way back) and no top bar.

- **Classes** (size classes, §4; mobile layout spec §5.1; each template draws its form, a page never branches on width): **compact**: the floating row's steps button pushes the steps as a list over the setup home; **medium**: the rail with the steps (§6.13 `setup-rail`); **expanded**: as above.

### 5.1 List (T2)
- Order in the content column: PageHeader → StatCards (when the header has `metrics`) → the DataTable (its toolbar above the table, pagination below): the first block sits `layout.head-content` (24) below the head, or `layout.head-tabs-content` (16) below its tab row (§4.2 "Head rhythm"), and the blocks are separated by `space.3`.
- Rail: faceted filters; each group has a title (muted) + checkbox items + counts.
- Content = one DataTable (§6.6) on the `panel` ground (framed, as the signed reference; inside a box, a Card or a flush form card, a table is unframed by itself, §1), whose toolbar, bulk bar and pagination all belong to the DataTable.
- Subordinate section (optional, at most one): below the main table with a `space.6` gap, an `h2` title + one DataTable listing secondary objects closely related to the main object and few in number (such as "Invitations" on the members page, a settings page that follows the same rule); it has no filters or metrics of its own, and the create entry stays in the PageHeader. When the secondary objects need their own filters or are numerous, make a separate list page.
- PageHeader: title + total, description, secondary actions on the right + Create (primary); metrics ≤ 5 as StatCards.
- **One primary per screen**: while `empty` is drawn with a `primary` action, the template leaves the head's primary out and the empty state carries it (the head's other actions stay); with rows, while loading, or when the empty state has no primary action, the head keeps it. Pages pass the same action to both and never draw two.
- **Variants** (`variant`): `records` (default) holds a DataTable; `objects` wraps its ObjectRows (§6.17) in one ObjectList panel (things people own and configure: skills, connectors, plugins); `cards` lays its ObjectCards (§6.34) out in one CardGrid on the page ground, no box around it (things a person picks by look and starts from: the workspace 智能体 page's 智能体 and 模板 tabs, the admin 智能体 / 模板 tab's template list; ruling P4-15). The head, its tabs and search, the `filters` row (a toolbar filter above the grid, such as the agents' `Segmented` 全部 / 我的 / 组织共享), `callout`, `empty` and `loading` work as for the other variants. The `callout` prop draws a Callout (§6.19) in the header between the title row and the tabs; `empty` draws an EmptyState (§6.18) instead of the content. `loading` (`true`, or `{ rows?, stats?, table?, keep? }`; spec §7.1 of the web query cache design) draws the page's frame until the first answer, with one busy announcement (§6.29): the head keeps its real layout (§4.2: the path, a known title, actions and search for real, an unknown title is a `title` bar; the tabs stay with their counts shown as a `faint` "–"), so nothing moves when the answer arrives; `stats` stat card placeholders stand in for `metrics` the page does not know yet (§5.6); the list is skeleton rows in the loaded list's own container: for `objects`, the ObjectList panel with `rows` rows (default 3), each the object row's box with a 36 px mark box and a name and a description line in the one bar look (§6.17); for `cards`, the CardGrid's skeleton cards, `rows` of them (default 6, §6.34); and for `records`, the DataTable's own loading state in the caller's `table` shape (`label`, `columns`, `rowHeight`, `framed`, as InboxPage, §5.7), else four full-width `body` bars (`Skeleton({ rows })`); the action row, when there is one, stays with its buttons disabled; a page whose content is its own sections (each `FormSection` saying for itself whether it is loading) passes `keep`, and its `children` render as they are inside the page's one busy region, so no section announces itself (state `loading-keep`, against the loaded `keep`). Loading wins over `empty`. Exception: a tab that exists only when the data holds something different from 全部 cannot be known before the answer and appears after it. An object list has no rail: tabs with counts in the header replace the filters.
- **Scope** (`scope`, responsive system spec §2.2 level 2): a view choice inside the set the head's tabs choose (the conversations page's 全部 + one chip per agent) is a row of scope chips (§6.63) above the list, scrolling sideways; kept while loading. Below 600 the chips sit in the quick-return bar (§6.65); from 600 a scope of five options or fewer is a `Segmented` above the list and one of more options a secondary `Tabs` row there (responsive system spec §2.2); a scope whose options carry avatars stays chips at every width (§6.63; neither draws an avatar). A `scope` and a `Segmented` or `Tabs` passed through `filters` are never both given (the template throws in development; it sees those written in the `filters` element tree, not ones another component draws inside itself).
- **Filters** (`filters`; maintainer decision 2026-11-22): field filters only (`Field`, `Select`); a view choice is the typed `scope`, and a `Segmented` or `Tabs` in `filters` is a `web-ui-filters-scope` finding (§9.1). Below 600 the field filters and the facet rail share one Filter bottom sheet (§6.59), opened by a Filter button that shows the count of active filters (`filterCount`, mono and muted after the label); from 600 the field filters are a row above the list, after the `scope`'s Segmented or Select on the same row when the page has both (wrapping when the row is too narrow).
- **The primary below 600** (responsive system spec §2.5): the head's primary button is restyled as the list's floating action button (§6.62; CSS only, the same element; the template marks itself `data-fab`). Without a primary, or while the empty state carries it, there is no button.
- **Classes** (size classes, §4; mobile layout spec §5.1; each template draws its form, a page never branches on width): **compact**: a single column, rows compact (§4.3), cards one per row, records stacked, the facet rail behind a "Filter" button and a bottom sheet, the head's search a filled field without a border (`selected` ground), the primary as the FAB; **medium**: cards two per row once two `layout.card-min` columns fit (the grid is auto-fill, §6.34), one below (maintainer decision 2026-11-20: two 280 columns do not fit the 552 content width), the facet rail as a Filter side sheet; **expanded**: as above, the facet rail inline while it fits (§4.3 "Side columns fit"). **Responsive system** (maintainer decision 2026-11-22; responsive system spec §3.1): **compact**: the compact head (§4.2): no path, a large title with its count, the primary the FAB (§6.62), the secondary actions in the floating row's "…" (§6.56), the search full width and filled, the tabs a segmented control for two or three (§6.4); a level-2 `scope` as scope chips (§6.63); the field filters and the rail together in the Filter bottom sheet, its button showing the count of active filters; `cards` and `objects` a **grouped list of rows** in one rounded card with an action sheet in place of row buttons (§6.34, §6.17, §6.61; a row that opens nothing keeps its one action button and a labelled ⋯ when it has more menu items); `records` the DataTable's grouped rows by the declared row mapping, the stacked rows as the fallback (§6.6); the page as one scroller with the quick-return bar and the scrolled title (§6.65); **medium** and **expanded**: the head and its actions as above, `scope` a Segmented (five options or fewer) or a secondary Tabs row. An empty list carries the primary in its EmptyState and has no FAB.

<!-- states: template-list -->
States: `page`, `default-objects`, `loading-objects`, `keep`, `loading-keep`, `cards`, `loading-cards`

<!-- size-table: template-list -->
| Part | State | Property | Value |
|---|---|---|---|
| sidebar | page | width | layout.sidebar |
| content | page | max-width | layout.content |
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

**The 扩展 pages** (workspace `/extensions`, admin console `/admin/extensions`; design note 2026-11-06): a `records` ListPage with one roomy DataTable, sorted by capability. The head's tabs are 全部, 模型 (`model-provider`), 网页 (`web-search`, `web-fetch`), 连接器 (`connector`), 沙箱 (`sandbox`), 存储 (`object-store`) and 工具与界面, each with its count, and the search by name at the row's end; the open tab is `?tab=<id>` (none for 全部). One web module maps the points to the tabs (`apps/web/src/lib/extension-capabilities.ts`): an extension providing points of two tabs is in both and once in 全部, and under a tab its row shows only what it provides there; 工具与界面 is the catch-all for an extension that provides none of the mapped points (agent tools, UI views, channels, directory, a point the module does not know yet, or nothing), so there is no 其他 tab. All seven tabs are always drawn (counts may be 0), so the loading head is the loaded one. A row: the display name over `plugin · version` (`CellTitle mono`), the capabilities (a `wrap` list: 模型, 网页搜索, 网页读取, 智能体工具, 界面 …), the state, and in the workspace for org admins the enable switch (an `interactive` column). Rows needing attention come first (待配置 or a refused switch in the workspace; any status neither enabled nor disabled on the admin console), then those on, then the rest, by display name. A row opens a right-side Sheet (§6.7): on top the config form (the workspace's org config, 保存配置 / 保存并启用 in the footer; the admin console's deployment config), then the state region (the state as its first line, then the capabilities; the admin console's lifecycle actions and replicas), then the permissions under their 权限 heading folded into one line (「数据库表 2 · 智能体工具 1 · 敏感」, a `Disclosure`) that opens the full permission blocks (on the admin console with the approval, open by itself while one waits). A refused switch opens its Sheet with the reason. Members read the same list without the switch and a Sheet with the capabilities and the state only (the kernel gives them no config, secrets or permissions, only the extension points each provides, `provides`, from which their tabs and chips come). The workspace page keeps the default providers (in 全部 and 网页) and the file previewers (in 全部 and 工具与界面) under the table, then (in 全部 and 工具与界面, for members too) one muted prose line with a `LinkButton` 「界面位置在 组织设置 → 外观」: the arrangement of extension UI lives on 组织设置 › 外观 (maintainer decision 2026-11-10), after the theme sections: 替换 (a flush section, one DataTable: 位置, 使用 and for an org one 来源 column, 本组织 with a ghost 改为跟随平台 or 跟随平台), then 界面位置 (a flush section, one `Subsection` table per slot with 隐藏 switches and ↑↓, the first row's ↑ and the last row's ↓ disabled). 平台设置 has the same two sections after the platform theme.

**The 智能体 page and the template cards** (workspace `/agents`, admin console `/admin/agents`, its 模板 tab `/admin/agents/templates`; rulings P4-14 to P4-17 of the plugin component management design): one `cards` ListPage with the head tabs 智能体 and 模板 (`?tab=templates`; 智能体 is the bare `/agents`), both counted, the search at the row's end (one per tab, cleared on a switch) and 新建智能体 as the head's primary; guests, who cannot create agents, get the agents alone without tabs. 智能体 takes the `Segmented` filter 全部 / 我的 / 组织共享 in the `filters` row. An agent card: its avatar, the name (the card opens the agent's page, read-only for whoever may only use it), the description, the meta owner · 可见范围 (「我」 for one's own; a guest's cards show the visibility only), the primary 开始会话 (a link to the new conversation with the agent picked) and ⋯ with 设置 (whoever may change it), 运行记录 (org admins and a member owner) and 另存为模板 (org admins); the owner is changed on the agent page only, never from the list (acceptance item P). A template card: the initial square, the name (the card opens the template page `/agents/templates/<id>`), the description, the meta source · v (平台 / 本组织 / the owner org's name / 插件 · name; an off platform template adds its state in `warn`), the primary 用它创建 on a template usable in the org (an org admin's 启用 on one that is off, else none) and ⋯ with 查看, or for owner-org admins 编辑 (the template page is their editor), 设为可共享 / 取消共享 and 删除 (the preview first, the name typed), then the org admin's switch actions (停用 with its preview, 查看插件). The admin 智能体 / 模板 tabs (`/admin/agents`, `/admin/agents/templates`; likewise 连接器 / 模板 at `/admin/connectors`) are separate pages; the 模板 tab draws the same cards under the owner filter 全部 / 平台 / 组织创建: the meta source · owner · scope · v (内置 plain, 已停用 / 插件已停用 in `warn`), the primary 查看 (the detail) and ⋯ with 对其他组织显示, 设置范围 and 停用 / 启用 (上传新版本 stays on the detail). 技能 and the 连接器 / 连接器模板 lists keep their tables. Each tab has its own loading (skeleton cards under the real head and tabs), empty and error states; a tab whose list cannot be read says so in the list's place with 重试, its head and tabs kept. `/agent-templates` and `/agent-templates/<id>` redirect (temporarily: the old path never shipped) to `/agents?tab=templates` and `/agents/templates/<id>`.

**用它创建 and 待配置** (rulings P4-3 to P4-8, P4-18; a `Dialog` opened by a template's primary, on the cards and the template page): the name (the template's), a preset avatar (an upload comes after creating), 可见范围 only for org admins (members always 仅自己, the option never drawn), the model preselected with the source of the choice said, then the preview in three `Disclosure`s 带入 / 待配置 / 不可用 with counts (待配置 and 不可用 open while non-empty; each item a kind tag, its name and the reason in words) and the settings left out; 创建 lands on the new agent, on its Tools section when connectors wait. A changed template or org state (409) re-reads the preview, says what changed in a `warn` Callout and the next 创建 sends the new hash; a template no longer usable offers no 创建. On the agent page the basics show 「由模板 X vN 创建」 (the name links while the template is usable) and Tools opens with the 待配置 notice: org admins get 配置 per entry in one dialog (use an existing connector, one more from the connector template, or the prefilled custom connector form); the owner who cannot configure sees the request state (已申请 / 驳回理由 with 重新申请 / 申请) and the same entries sit in the admin inbox as a 连接器配置申请 with the same dialog.

**The template page and 另存为模板** (`/agents/templates/<id>`; rulings P4-9 to P4-14): the agent page's frame, a `SettingsPage` with the section nav 基本信息 / 快捷操作 / 提示词 / 模型 / 工具 / 技能 / 连接器 / 子智能体 (`?s=`; no 渠道) and the open section. The head follows the agent page's (not §5.2's component-detail head): the initial square (`Avatar` without a picture), the name, the description (drawn as the agent page draws it; 基本信息 does not repeat it), source · v in the title row's count slot (mono, as on the cards), the path `<org> / agents / templates / <name>` (templates goes back to `/agents?tab=templates`), 用它创建 as the primary on a template usable in the org, and ⋯ with 设为可共享 / 取消共享 and 删除 for owner-org admins (删除 is the cards' dialog: the preview first, a transfer to the platform said, the name typed; then back to the 模板 tab) and the org admin's switch actions on a platform template. Members up read every section (a template is read before 用它创建): key-value rows, flush lists of rows (tools with their policy, skills with 预载, connectors with a needs entry's address and tools, sub-agents), the prompt files and inline instructions as code blocks; guests get no access. Owner-org admins get the editor in the same sections, each with its own draft and action row as on the agent page, the prompt files and quick actions in the agent page's own editors; each save writes the whole definition as a new version with `expectedVersion`, and a stale one is the fail Callout with 重新加载 above the section. The name is fixed (it is the roster type); 模型 is the tier, an optional concrete model and the effort; 技能 picks by name with up to 3 preloaded, a name the org lacks kept and marked; 连接器 lists template entries by name and needs entries edited in place (name, protocol, address, tools one per line; an address with a user name, a query or a fragment is refused on the field with the clean form to use, before and after the kernel's check), one policy select per listed tool (默认 / 先询问 / 禁止, as in 工具; an entry naming no tools keeps its policies read-only and says so), and adds a connector template on in the org (a select) or a needs entry. A platform template offered to the org but off there (the kernel serves no detail) is an `OverviewPage` with the component's head and the page `EmptyState` 这个模板未在本组织启用, with 启用 as its action for an org admin who may switch it (查看插件 when its plugin is off), else whom to ask; a template the detail marks not usable here (`usable: false`: the owner's own promoted template switched off in its org) keeps its page with the warn notice, 启用 in it when the component is offered, and no 用它创建. 另存为模板 (org admins, from the agent page's ⋯ and the agent card's) is a `Dialog`: the name (the agent's name in the bare-name form), the description (the agent's), a sentence on what goes in (never credentials) and the org agents of its sub-agent roster, which stay out; a name taken in the org names its owner on the field (平台 / 本组织 / the sharing org), a reserved one says so. Saved: the new template's page, or first, when the kernel left more out, the dialog's second step listing each omission in plain words (what, then why) with 打开模板 as a `LinkButton` primary.

### 5.2 Detail (T3)
- PageHeader: path ending with the object's name; name + version (faint) + status; actions: Edit (default), Trial run (secondary), `more-horizontal`.
- PageTabs: Summary · Runs · Config · Versions · Permissions · Audit (pick per object type), with counts following in faint. An object with one view has no tab row (`DetailPage.tabs` left out): a row of one tab says nothing (the workspace plugin detail).
- Content: sections on the `panel` ground with radius `md` (no border), section header h2 + actions on the right, `space.4` between sections.
- **One centred column, no right pane** (2026-11-07 ruling: no detail page has a right inspector for now): the content is one centred column of the content width. `DetailPage.facts` is the object's facts block (`data-part="detail-facts"`): a KeyValue (key muted at the page's key width, value single line with ellipsis; grouped KeyValues with a small muted group title when the object has groups), drawn by the template as the first block of the column, right under the head and its tabs, above the tab's content (`children`), `space.3` apart like every block of the column. A page puts its full description (when the head does not carry it, below) first inside `facts`, above the KeyValue, so the order is always description, facts, tab. Every action stays in the head, never in the facts block. What a page used to open in an inspector on selection (an eval run's result) opens in a right-side Sheet (§6.7) instead.
- **Plugin and component details** (admin and workspace 插件 / 技能 / 连接器模板 / 智能体模板 details; 2026-11-06 ruling; the workspace template page `/agents/templates/<id>` is the exception: it follows the agent page's head, §5.1 "The template page and 另存为模板"): the head carries no description: the full description (line breaks kept) is the first block of the column, right under the head, as `prose` `muted` text, since the head's one-line description would cut it; every action is in the head (a destructive one such as 删除 is the head's `more-horizontal` menu item, never a button in the page), the facts (包, 来源, 发布者, 归属, 范围, 在用组织, 权限, 更新时间 …) are a KeyValue after it, the tab's content follows, and the license is a 许可证 fact whose value ends with 全文 ›, a small muted button opening a Dialog with the license text in a `CodeBlock` (no folded section at the end).
- **The band form** (`header.titleHidden`, the device page): the page's first block is its own name band, drawn as `facts` directly under the head's path row (`layout.head-path` 12, the template head then carries no bottom padding), and the page's `tabs` follow the band at `space.2` (8), the first block `space.4` (16) below whichever comes last. The standard order (tab row, then facts, then content) is unchanged for every page that keeps its title row. The loaded band's own component holds the name, its origin, state and mark, and its figures; the template only places it.
- **Loading** (`DetailPage.loading`, `{ facts?, band?, blocks?, content?, stats? }`; spec §7.1 of the web query cache design): every region keeps its box, so nothing moves when the data arrives. The header is the PageHeader's loading state (§4.2); a page whose loaded header has `metrics` passes `stats` (their count), and that many stat card placeholders (§5.6: the `panel` card with a `small` label slot over a `metric` value slot) stand under the header where its StatCards will be (the header's own `metrics`, when the page knows them, render for real instead); the PageTabs stay real (the tabs are static per page), the content is `blocks` card-shaped blocks (default 2) in place of `children`: the `panel` card of the sections above, its head band holding a 30% `body` text slot and its body three text slots (100%, 70%, 55%) `space.2` apart; the card is 147 px high (a 1 px border on each side, the head band 37 = `space.2` × 2 + one `body` line + its 1 px rule, and the body 108 = padding 16 × 2 + three `body` lines + two `space.2` gaps). The facts block mirrors the loaded one: with `loading.facts` set, the column's first block is the same `detail-facts` block holding KeyValue's own box (§6.5, the same `dl`) with four rows, each a `body` slot for the 8ch key and a 55% `body` slot for the value (a group title is not drawn: the loaded facts' groups are the page's), above the content blocks; `facts` the page passes for real stays; `loading.facts` as `{ rows?, keyWidth?, columns?, lead? }` draws that many rows with that key width in one or two columns (the loaded facts' KeyValue), and `lead` puts a 70% `prose` line over them (gap 12) for facts that start with the object's description (the eval set). A page whose loaded facts block has no KeyValue rows to mirror leaves it unset. A tab whose static structure the page knows passes `content` (`BlockShape[]`) instead of `blocks`: the blocks stand in a gap-16 stack as the loaded tab stacks its parts (state `loading-content`, against the loaded `content`). A block is `lines` (a gap-4 stack, a `body` line over `small` ones), `list` (a labelled list: a `body` label slot over `items` `body` lines, gap 8), `key-value` (KeyValue's own `dl`, `rows`, one or two `columns`, `keyWidth`), `buttons` (a gap-8 row of `count` 88 px control-height slots, with a `small` line under it when `help`), `table` (the page's real `small` muted title over the DataTable's own loading state with its `label` and header `columns`, gap 8; a static `toolbar`, such as a refresh button, renders for real in the table's toolbar row) or `card` (a titled card on the page ground, an `ItemShape`, §5.8). A `radios` field shape (§5.8) is a plain RadioGroup's own markup: per option its box and a `body` label slot. One busy announcement for the page (§6.29). Nothing animates.
- **Classes** (size classes, §4; mobile layout spec §5.1; each template draws its form, a page never branches on width): **compact**: a pushed page (§4.6), the facts block first, PageTabs scrolling sideways, a band head stacked; **medium**: one centred column as above; **expanded**: as above. **Responsive system** (maintainer decision 2026-11-22; spec §3.2): **compact**: no path row, a large title; the primary a full-width button under it, the secondary actions in the floating row's "…"; the page tabs a segmented control for two or three (§6.4), a scrolling row for four or more; the body's tables as grouped rows by their row mapping (§6.6); the page as one scroller with the scrolled title (§6.65); a band head has no path row and its band stacks.

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
- Sections: the section title (`h2`; `marks`, a muted state word, may stand on its line, `space.2` after it, wrapping under a long title) and a description (`prose-small` `muted`), then the fields on a `panel` card with radius `md`, padding `space.4`, `space.3` between fields. Sections are separated by `space.6` of spacing, **not by lines**; rows inside a list of switches are divided by `line-soft`.
- **Columns by count** (maintainer decision 2026-11-23): the two-column section layout (a grid, the left column 240 wide with the title and description, the right column the card) is for pages with more than two sections. A page, or the tab's panel on show, with **one or two sections stacks them** (the head above the card across the full width, as "Stacked sections" below); with **three or more** they stand in the two columns. The template decides from its count, never the page: `FormSection` has no columns option, and the stylesheet switches a template's sections to columns when it holds three or more sibling `FormSection`s (`.cb-template:has(.cb-form-section ~ .cb-form-section ~ .cb-form-section)`, so the server render is already right; loading sections count too, so a loading page passes the loaded page's section list). Sections must therefore be siblings (a fragment, or one wrapper for all); three or more split across wrappers throw in development and tests (the template frame's `assertSectionGroups`), and `formSectionLayout(templateElement)` reports the layout to tests. A SettingsPage (§5.8) is always stacked. A danger zone after columned sections sits in their field column, after stacked ones it spans their width (§6.21). Pages whose layout this changed when it was introduced: the device page's 项目 tab, the workspace 新建智能体, 新建评测集, the eval run wizard's steps, the admin connector detail, the admin 插件来源 page and the workspace 扩展 page's default-provider and previewer tabs (all one or two sections, now stacked).
- **The card is the one box** (§1 principle 7): what a section holds groups with headings, hairlines and space, never cards. A list of things each with its own lines or fields (quick actions, inline sub-agents) is one `ItemList inset="flush"` of `ItemListItem` rows in a `flush` section (§6.33: each row padded `space.4`, its title line, meta lines, then its field; rows split by `line-soft`); a table is unframed in a `flush` section, running to the card's edges, and several tables in one card are flush `Subsection`s, each an `h3` heading row over its table, split by `line-soft` (§6.32, §6.6); a nested group of fields (a config object) is a `Subsection` under the Disclosure's guide; an array of objects is a `Repeater`, whose items are divided rows inside the card (§6.26). A notice about the section goes above the section card (§6.19); a Callout that does land inside a box (a panel shared with a Sheet) draws its line form there by itself.
- **Model purposes** (`/admin/models` and `/settings/models`, tab 用途默认; maintainer decision 2026-11-23): **each purpose is its own section**, never a row of one shared card, so an overridden purpose stands out from its neighbours. The section head holds the purpose's label (`h2`), a muted state word beside it (`FormSection marks`: 已覆盖 on the org page) and its one line as the description (a kernel purpose's hint, what happens while it is unset; an extension's 「来自 <display name>」); the tab's own description is the page head's. The card holds the warnings (a `warn` line with its icon: the eval judge or the image tool unmapped; a saved model that is no longer listed is marked in the select), the model `Select`, then the model's parameters folded in a `Disclosure` (§6.5), closed by default, whose summary counts the parameters set away from their default (「参数 · 2 项已自定义」 / 「参数 · 全部默认」); a save that fails on a parameter opens it, and a model without parameter declarations draws none. The sections are the template's siblings, so the count decides the layout: the admin console (a ListPage with nine or more purposes) stands them in columns, the org page (a SettingsPage) stacks them; while loading, each page draws the kernel's nine purposes as loading sections (`LoadingFormSection`, titles unknown). The page keeps its one ActionRow saving every changed purpose (§4.4).
- **Stacked sections**: the head (the `h2` title over its description, `space.1` apart) sits above the fields card, `space.3` below it, and the card takes the content's full width. Every section of a page with one or two sections is stacked (above); in a page of three or more, `FormSection layout="stacked"` (the only value: the columns cannot be forced) keeps one section stacked whose content needs the width, such as an editor (the agent page's prompt files, §5.8 "List + editor"). **Every section of a SettingsPage (§5.8) is stacked**, whatever its count: the sub-nav already holds a column of titles, and a second title column beside the cards would leave an empty band between the nav and the fields. Where the label column does not fit (§4.3 "Side columns fit": a body under 792, and always below 841) every section is stacked this way already, so the narrow layout does not change. A loading section passes the same `layout`, so its skeleton keeps the loaded section's boxes.
- Fields: label on top (`body` `ink`; required marked with an accent `*`, optional marked "Optional" in faint); controls `default` density; help text and error message below (`small`); on error the border is `fail` and the message starts with the `circle-alert` icon and gives an actionable suggestion.
- The ActionRow is always present: Cancel · Save draft (⌘S) · Publish.
- **Create forms** (`FormPage create`, a new object): focus starts on the first field; the ActionRow never says "No unsaved changes" (nothing exists yet to be unchanged; typed fields still count as unsaved and guard leaving); the primary is disabled until the form is valid (the required fields filled), as in a create dialog. A create form whose prerequisite is missing (no channel extension enabled for 新建渠道) draws only the `EmptyState` with the next step, never the form.

- **Loading** (`FormPage.loading`, a flag; `FormSection.loading`, `{ fields }` or `{ items }`; spec §7.1 of the web query cache design): every region keeps its box. The header is its loading state (§4.2: the path the page knows, a title bar when the title is not known yet). Each section is the page's own `FormSection`, so the page passes its static section list and a section whose data is ready renders for real next to loading ones: a loading section keeps its title and description and draws `fields` field placeholders in its card in place of `children`; a section that lists items passes `items` (`ItemShape[]`, §5.8) instead and draws those item row placeholders in a flush card (never card placeholders inside the card, §1). `fields` is a count (that many default inputs) or `FieldShape[]`, the page's static field layout, which it knows before the data arrives and **must pass** whenever a field is not a plain input, so the loading card is as tall as the loaded one: `{ control?: input | textarea | select | segmented; help?: boolean; rows?: number; pair?: boolean }`. A field placeholder is the loaded `.cb-field` itself: a `body` slot (30%) in the field head where the label is, then the control's own box directly in the field (`control.default` for input, select and segmented; a textarea is `max(rows, 2)` `body` lines + `space.2` + 2 px high, `rows` default 2), so the box has whatever width the field's rule gives a control (never a width of its own), then, when `help` is set, one `small` slot (the loaded field's help text, error message or counter line). A shape with `pair` and the one after it sit in the two-column `Grid` (gap 12) the loaded section draws for paired fields. The ActionRow stays, its buttons disabled and with no unsaved or error count. A `flush` section (a SwitchList) keeps its flush card (no padding) and draws `fields` switch rows in SwitchList's own list and row (divider, padding, `row.roomy` height): a `body` name slot (30%) over a `small` description slot (55%) in the text column and a 32 × 20 box in the switch's place. One busy announcement (§6.29); a loading section outside a loading page announces itself. Nothing animates.
- **Classes** (size classes, §4; mobile layout spec §5.1; each template draws its form, a page never branches on width): **compact**: a single column with labels above their fields (every section stacked) and a **sticky ActionRow** above the safe area (§4.4); **medium**: labels above fields; **expanded**: the 240 label column while it fits (§4.3), else stacked. **Responsive system** (maintainer decision 2026-11-22; spec §3.4): **compact**: no path row, a large title, labels above fields at the mobile field sizes (§2.5); the sticky ActionRow keeps its full-width primary; the page is one scroller with the scrolled title (§6.65); a wizard's step bar stays "2 / 4" text.

<!-- states: template-form -->
States: `page`, `loading`

<!-- size-table: template-form -->
| Part | State | Property | Value |
|---|---|---|---|
| sidebar | page | width | layout.sidebar |
| content | page | max-width | layout.content |
| action-row | page | height | layout.action-row |
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
  - The **middle column** holds, top to bottom: the title bar (§6.16.1), the thread (centered, at most `layout.chat` wide, gutters `layout.gutter`, padding `space.4` on top, items `space.3` apart; it opens at its latest message and follows the bottom while the reader is at the bottom, see **Thread scrolling** below; it reserves a classic scrollbar's gutter on the end side, `scrollbar-gutter: stable`, and centers on the middle column, where the composer centers, so it keeps the composer's center line whether or not it scrolls; not `both-edges`, which WebKit lays out on the wrong side once a reversed column overflows), the composer (§6.16.2, at most `layout.chat` plus the gutters wide, centered, `space.3` from the bottom of the paper). It is never narrower than `layout.chat-min`, except **below 600**, where it fills the window and the title bar, the thread and the composer use `space.4` (16) gutters, so the composer, its send button and the user bubbles never run past the right edge.
  - The **right area** holds one thing at a time: either the **properties panel** (§6.16.17), which sits *inside* the middle column under its title bar so the title bar spans thread and properties, or **one right panel** (§6.16.18), full height beside the middle column, whose title bar then narrows with it. Opening one closes the other; "none" is the default.
- **Thread scrolling** (acceptance 2026-11-07: a reload painted the thread from its first message, then jumped): the thread's scroller (`.cb-conv-scroll`) is anchored at the bottom by CSS, a reversed column (`flex-direction: column-reverse`) around its one content wrapper (`.cb-conv-thread`), so its scroll origin is the bottom and the first painted frame, the server HTML before any script, already shows the latest message; the wrapper's bottom auto margin keeps a short thread at the top. Only the wrapper is reversed against, never the items, so reading, focus and screen-reader order stay top to bottom. Content growing while the reader is at the bottom (streamed text, new events, an extension block or a long bubble laying out) stays in view; within 48 px of the bottom still counts as at the bottom (the view snaps back to it); a reader who scrolled further up is never moved: what they look at stays still while content arrives below (the browser's scroll anchoring, or `useFollowBottom` keeping the distance from the top where there is none), and following resumes once they scroll back to the bottom. Scrolling is always instant, never smooth. The hook is a callback ref, so it attaches to whichever element is the scroller (the new conversation's centered layout giving way to the thread). The new conversation's centered layout (`data-center`) is not reversed. There is no jump-to-latest control.
  - **Edge fade** (browser review F15, 2026-11-10): the scroller masks its top and bottom `space.4` (the thread's padding) from transparent to opaque, so a line cut under the title bar or above the composer fades out instead of ending mid-line; a thread at rest is never dimmed (its first and last lines sit inside the padding).
  - **History in pages** (history paging spec 2026-11-07): the page paints the log's last page and reads earlier pages as the reader scrolls up. `ConversationPage.history` (`{ state, onLoadEarlier }`) draws `ThreadHistory` as the thread wrapper's first child: `more` a centered "加载更早的消息" / "Load earlier messages" link between the run divider's rules, with an observed edge that reads the previous page once it comes within 600 px of the visible area (rooted at the nearest scroller, observed again on every state change); `loading` one placeholder line (`SkeletonText` 70%, prose size) and a polite status "正在加载更早的消息" / "Loading earlier messages"; `failed` the fail divider "更早的消息加载失败 · 重试" / "Couldn't load earlier messages · Retry" (`role="alert"`); `start` the divider "会话开始" / "Beginning of conversation", shown only after earlier pages were loaded (a conversation that fits one page has no edge). It reuses the run divider (§6.16.7) and the loading turn, so it has no look of its own. Prepended history never moves what the reader looks at: the reversed scroller keeps its distance from the bottom, browsers with scroll anchoring keep the anchor, and `useFollowBottom`'s fallback keeps the topmost visible item where it was (for content arriving below as well). A sub-agent's panel (§6.16.18) puts the same edge above its thread.
- **Narrow windows**: below 1280 the right area is a right-side Sheet over the page (`layout.panel` wide, `shadow-sheet`, a `scrim` behind it), closed by Esc, its close button or a click on the scrim; the server render and hydration cannot know the window, so below 1280 a CSS media query hides the inline right area until the first client render makes it the Sheet (a pushed page on compact, below) (the page never scrolls sideways, no flash). At 1280 and above it sits beside the thread; with the full sidebar at exactly 1280 the panel narrows to 544 so the thread keeps `layout.chat-min` (maintainer ruling 2026-10-27).
- **New conversation on a phone** (below 600, maintainer decision 2026-11-09): the composer is pinned at the bottom of the middle column as on a conversation (sticky in the scroller, on the `bg` ground, `space.3` above the bottom of the paper; `new-composer`), the greeting and the agents row sit at the top (`space.4` from the title bar), the agents row is one line that scrolls sideways (no wrapping, bleeding to the window's edges, snapping to chips, the selected chip scrolled into view, every chip a tab stop), and the selected agent's quick actions are listed between them (`ConversationPage.newConversation.quickActions`, a `QuickActionList`, §6.16.27; `new-quick-actions`, shown below 600 only), so the composer has no `zap` button there (`data-quick`); an agent without quick actions lists nothing. 600 and up the page is unchanged.
- **New conversation**: nothing is created until the first send. The title bar shows "新会话" / "New conversation"; the thread is replaced by a centered column (`layout.chat` wide) holding, top to bottom and `space.4` apart (agent profile design §4, U1): the greeting (§6.16.25), the agents row (§6.16.26; hidden with one usable agent) and the composer, whose control row then has no agent picker (the row chooses the agent; the model and effort pickers stay) and holds the selected agent's quick actions as a `zap` button after the effort picker (§6.16.27; none when it has none). `ConversationPage.newConversation` takes them as `greeting` and `agents`; without a `greeting` the agent's name (`h2`) and description (`prose-small` `muted`) stand in its place. With either of the two the column's parts are `space.4` apart; with none it is the name and description over the composer, `space.2` apart.
- **No status bar** (maintainer decision 2026-11-28): the round and elapsed time are the Context section's 轮次 / Turns row (§6.16.17); the run state is the composer's stop button, the process block and the failed card, and a visually hidden polite `role="status"` line (`run-announce`) announces idle / running / waiting / stopped / failed to screen readers; the context used is the composer's context meter (§6.16.2).
- **Runs** (design note, unslop fixes 2026-11-03): every run that ended closes with a **run row** (§6.16.23), a quiet mono line `运行 · <model> · <duration> · <tokens>` with its status mark (the duration is working time, waits for a person left out, as the Rounds row counts it), built from the log alone (`run_started`, `model_call`, `usage`, `run_finished` / `run_failed` / `run_aborted`). A finished run's row is collapsed and uncoloured except its `ok` check; a failed run's row is open at first and red only in its mark, its status word and the failure sentence; its detail holding the failure (ErrorDetail: the sentence in the reader's language, the raw kernel text behind 原始错误), 重试 (the last failure only, while nothing runs), 查看轨迹 (`/trajectories/<conversationId>`, only for those the kernel lets read it: org admins and owners, or the agent's owner) and, for a super admin when the model service is misconfigured (`model.auth`, `model.unconfigured`, `run.model_unavailable`), 去配置模型服务 (`/admin/extensions`). A stopped run's row names who stopped it. The run row replaces the stopped, failed and hook-denied dividers (no run is drawn twice); a running run shows nothing new (the live indicators stay). A manual compact run has no run row: its outcome is one divider (§6.16.7: compacted, nothing to compact, failed or stopped; maintainer decision 2026-11-28). The properties panel's Context section adds the last run's line (model, duration, tokens; cost only when the log carries one, which it does not today).
- Extension slots, files and sub-agents: §6.16.16–§6.16.18, §6.16.15. Extension UI goes into **slots** of the SDK catalog (`docs/guide/ui-slots.md`, spec `docs/superpowers/specs/2026-11-08-ui-slots-design.md`); this page draws `conversation.panel`, `conversation.properties.section` and `conversation.tool-result.card` through `ExtensionSlot`. The agent page (its `agent.detail.section` sections), the organization settings page (its `org.settings.section` sections) and the admin console (`platform.page` entries under the 扩展 group, `/admin/p/<plugin>/<id>`) draw their extension sections the same way, in the page's own template and boxes (a section is a `FormSection` or heading group, never a box inside a box, §1); a failing one shows the load-failure line in that section only.
- **Loading** (`ConversationPage.loading`, `{ thread?, title?, rightArea? }`, per part; spec §7.1 of the web query cache design): every region keeps its box and the page announces once (§6.29). `thread`: the real thread column (`.cb-conv-scroll`, with its scrollbar gutter, and the thread at most `layout.chat` wide, items `space.3` apart) holds three turns: a user bubble's box (the bubble's padding and 1 px border, 45% of the thread, right-aligned) with a `prose` bar in it, then two `prose` bars, 100% and 70% wide; a `prose` slot is one `type.prose.line` high (§6.29). The composer always renders for real and keeps its box, stays mounted and focusable and its textarea stays editable (autofocus works); it cannot send while the thread loads (`composer` may be a function receiving `{ sendDisabled }`, which the page passes to the composer's `send.disabled`), and it stays mounted when the thread arrives, so a draft and its focus are never lost. `title`: the title bar keeps its path and every icon (properties toggle, panel icons); the title is a `body` bar in the title's own box, 30% of the bar wide, in place of the title menu. `rightArea`: an open right area draws its own loading state instead of `panel` / `properties`: the right panel's `loading` state (§6.16.18: the head with the open panel's title, which the caller gives as `rightArea: { title }` (default "右侧面板" / "Right panel"), and close, without the full-screen button, and the block's loading bars in the body) or the properties panel with its one always-present section loading (上下文 / Context; §6.16.17; the Files and extension sections exist only when the data holds something, so no placeholder stands in for them); a closed area stays closed. Nothing animates.
- **Classes** (size classes, §4; mobile layout spec §5.1; each template draws its form, a page never branches on width): **compact**: `/chat/<id>` is a chat surface (§4.6): the floating row carries the menu button, the title as the centre pill and an overflow menu holding properties, the agent map and the conversation actions (§6.16.1); the **right area is a pushed full-screen page** over the conversation, keyed by the same URL hash as today (`#properties`, `#panel=…`, `#file=…`, `#output=…`, `#subagent=…`), so back closes it and a reload keeps it (a right panel's content, a file preview, an embed or the agent map, needs the full screen); approval, question and connect blocks keep their actions within the thread width with 40 px buttons; **medium**: the thread centered as today, the right area a side sheet (`layout.panel` or the window less 48, whichever is smaller) with a follow-finger dismiss (§6.7), the conversations in the rail's sheet (§6.13); **expanded**: as today, the right area inline from 1280 and a side sheet below. `/conversations` (the drawer's 全部会话) is a ListPage (T2) of the sidebar's conversation groups (the same query, with its search and "load more") with a 新会话 action to `/`; it renders at every class and never redirects by width (a shared link must not depend on the sender's window; on expanded it is the same list the sidebar shows), and `/` stays the new conversation and the home.

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
| sidebar | properties-sheet | width | layout.sidebar-rail |
| properties | properties-sheet | background-color | color.panel-2 |
| property-section | properties-sheet | padding-left | 0 |
| property-section | properties-sheet | padding-top | space.3 |
| property-section | properties-sheet | border-top-left-radius | 0 |
| title-bar | loading | height | layout.title-bar |
| thread | loading | max-width | layout.chat |
| right-panel | loading | width | 544 |
| skeleton-text[data-size=prose] | loading | height | type.prose.line |

### 5.6 Overview (T1)
- Order in the content column: PageHeader → StatCards (the header's `metrics`) → the page's sections (cards, lists): the first block sits `layout.head-content` (24) below the head (§4.2 "Head rhythm"), and the blocks are separated by `space.3`.
- **Loading** (`OverviewPage.loading`, `{ stats?, sections?, keep? }`): the header is its loading state (§4.2); `stats` stat cards (default 4) in the loaded card's box (the `panel` card with a `small` label slot over a `metric` value slot), unless the header's own `metrics` are given, which render for real; `sections` card-shaped blocks (default 2, as in §5.2) in place of `children`; a page whose content does not depend on the data (a note under the numbers) passes `keep`, and its `children` render as they are in place of the blocks (state `loading-keep`, against the loaded `keep`). One busy announcement (§6.29). Nothing animates.
- **Classes** (size classes, §4; mobile layout spec §5.1; each template draws its form, a page never branches on width): **compact**: StatCards 2 × 2, sections stacked; **medium**: StatCards in a row of up to four; **expanded**: as above. **Responsive system** (maintainer decision 2026-11-22; spec §3.5): **compact**: no path row; the primary a full-width button under the title, the secondary actions in the floating row's "…"; one scroller with the scrolled title (§6.65).

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

- **Sections** (`OverviewSection({ title, actions?, state, loading?, error?, children })`, `state` `"loading" | "error" | "ready"`): a page whose sections read their own data (the admin overview: 待处理, 最近的平台操作) draws each one as an `OverviewSection`, so the page holds no state logic and one failing read never blanks the others. It is the section's one Card (the Card of §6.9: the head with `title` and the static `actions`, such as 查看全部, kept in every state) and provides the box to what it holds, so its content groups with `ItemList` rows, an unframed DataTable or `Subsection`s, never a second box (§1). Its body is, by `state`: `loading`, the loaded block's skeleton from `loading` (`BlockShape[]`, as in §5.2; default three lines), a busy region named by the title (§6.29: inside the page's own loading group it adds no second announcement); `error`, the in-place error line (the extension block's load-failure line of §6.16): the ErrorDetail sentence (`error.summary`, led by `circle-x`, the raw `error.detail` behind 原始错误, §6.24) with 重试 (`refresh` 12, a `small` muted link button) at the line's right, which calls `error.onRetry` and reads that section again; `ready`, the children. An empty section is its content's own empty state (`EmptyState size="panel"`, §6.18), drawn by the page in `ready`.

<!-- states: overview-section -->
States: `default`, `loading`, `error`

<!-- size-table: overview-section -->
| Part | State | Property | Value |
|---|---|---|---|
| overview-section | default | background-color | color.panel |
| overview-section | default | border-top-left-radius | radius.md |
| overview-section | loading | background-color | color.panel |
| skeleton-text[data-size=body] | loading | height | type.body.line |
| error-detail-summary | error | color | color.fail |
| error-detail-summary | error | font-size | type.body |
| overview-section-retry | error | color | color.muted |
| overview-section-retry | error | font-size | type.small |

### 5.7 Inbox (T6)
- Rail (320, the list column; wider than a filter rail's 240): the filters above the list (`filters`, then `list`); the list is a `ListDetailList` (§6.47) on every inbox page, never a DataTable (maintainer to confirm: R24): a row leads with the item's display name (one line, the ellipsis on the name, the full text in `title`) and its version beside it (`trailing`, never cut), what kind of item it is on the second line (the meta), the time at the end, and the warn dot for what waits for the person's decision (a request, an approval; a notice or a decided answer has none). The open item is a `ListDetailItem` (§6.47): its title (`h2`, the status mark beside it), its facts (`title`, `status`, `facts`, `factsLabel`, `aside` on `InboxPage`: a KeyValue `facts` variant of translated labels, never raw payload keys, only a tool key's value mono), the page's content after them (`children`), and the decision ActionRow at the bottom of the item's pane; the facts are inline, never in a Sheet: a 400 column beside the content while the template frame is at least 1100 wide, else above the content (the rail has no collapse button: maintainer to confirm: R20).
- **Refresh** (`InboxPage.onRefresh`, a promise): pull to refresh around the page in the native mobile shell on touch (§6.67).
- **Loading** (`InboxPage.loading`, `{ rows?, facts? }`): the header is its loading state (§4.2); the rail's `filters` stay real (they are static); the list is `rows` rows (default 4) in the `ListDetailList`'s own row box (64 px: the dot slot, a `body` slot at 55% over a `small` one at 30%, a `small` time slot at the end); the content is one card-shaped block (§5.2) in place of `children`. A page whose loaded state opens its first item keeps its frame while loading: `facts` (`true`, or `{ rows?, keyWidth? }`) draws `small` KeyValue placeholders in the facts block, and the page passes its `factsLabel` and its decision `actionRow` (the labels are static), which stays with its buttons disabled (as in §5.3). One busy announcement (§6.29). Nothing animates.
- **Classes** (size classes, §4; mobile layout spec §5.1; each template draws its form, a page never branches on width): **compact**: a **two-level stack**, the list is the page and an item is pushed full screen with its decision buttons (allow once / for the session / deny, the scope picker) in the sticky bottom row in its compact form (§4.4); a decision pops back to the list; **medium**: a `ListDetail` (§6.47), two panes (list 320 + detail at least 360) when both fit, else the stack; **expanded**: rail + the open item, its facts **inline**, never in a Sheet: a 400 column beside the content while the template frame is at least 1100 wide, else above the content, the decision ActionRow at the bottom of the item's pane (§6.47; maintainer to confirm: R24), and the list-detail fit applying (§4.3); the rail has no collapse button (maintainer to confirm: R20). A link `/chat/<id>#approval=<id>` opens the conversation scrolled to the approval card. **Responsive system** (maintainer decision 2026-11-22; spec §3.6, D6): **compact**: the list's rows take the grouped-row look (§6.17) and have **no long press**: a decision is deliberate and made on the pushed item.

<!-- states: template-inbox -->
States: `default`, `loading`

<!-- size-table: template-inbox -->
| Part | State | Property | Value |
|---|---|---|---|
| content | default | max-width | layout.content |
| content | loading | max-width | layout.content |
| rail | default | width | 320 |
| list-row | default | height | 64 |
| loading-row | loading | height | 64 |
| loading-row | loading | padding-left | space.4 |

### 5.8 Settings (T5)
- **Sections are stacked** (§5.3 "Stacked sections"): beside the sub-nav, each `FormSection` puts its head above its card at every width and whatever the section count (the one exception to §5.3 "Columns by count": the sub-nav is the title column), so the content column starts with the section title right after the nav.
- **Loading** (`SettingsPage.loading`, `{ sections? }`): the header is its loading state (§4.2); the sub-nav is real (static per page) and so is the header's `description`; an ActionRow the page passes stays with its buttons disabled. `sections` (one entry per section: `fields`, and the `title` / `description` the page already knows) draws each section in the `FormSection` frame (§5.3) in place of `children`: a title the page does not know is an h2-sized slot (`SkeletonText` `heading`, 45%), a description it does not know a `body` slot (70%), then `fields` field placeholders (§5.3; a count or `FieldShape[]`). Without `sections` the children render as they are, each `FormSection` or list saying for itself whether it is loading. One busy announcement (§6.29). Nothing animates.
  - **Control groups** that are no `Field` have their own `FieldShape`s, each drawn in a `Stack` (gap 8) with an optional `help` line (`small`, 55%) under it, as a settings section draws a group and its hint: `radio-cards` is the card RadioGroup's own markup (`.cb-radios[data-variant=card]`, gap 8) with `options` cards (default 2), each the card's frame (padding `space.2` `space.3`, 1 px `line` border) holding a 14 px box slot and the text column's `body` label slot (30%) over its `small` description slot (70%); `key-value` is KeyValue's own `dl` with `rows` rows (default 3), a `body` slot in the `keyWidth` key column (default 8ch) and a 55% value slot; `switch` is a row (gap 12, centred) of a 32 × 20 box (the Switch) and a 64 px `body` slot (its state word). Two shapes stand beside the groups without a stack: `text` is one `body` slot (70%: a hint is `Text variant="prose"`, whose prose-small line is the body line), a hint line the section always shows; `item-group` is a `small` label slot (30%) over an `ItemList`'s own rows (`options` rows, default 2, split by `line-soft`), each a 30% `body` title slot over `rows` `small` slots (default 2) `space.1` apart, as a labelled list inside a form card (an extension's permissions): rows, never cards (§1). A loading slot that sits in a flex row (a card radio's text column, a card's title) takes the row's free width (`flex: 1`, `min-width: 0`), so its percentage bar is never 0 px wide. Static text the page shows beside a group (a read-only note, "applies to new sandboxes") renders for real through `help` only when the page knows it is shown. States `radio-cards` / `loading-radio-cards`.
  - **Items**: a section that lists items, each with its own lines and field (quick actions, inline sub-agents), is a `flush` FormSection holding one `ItemList inset="flush"` of `ItemListItem` rows (§6.33), never a card per item (§1). Its loading shape is `items: ItemShape[]` instead of `fields` (`FormSection.loading`, `SettingsPage.loading.sections[].items`): the flush card holds the flush ItemList's own `ul` and rows (padding `space.4`, split by `line-soft`), each row in the loaded row's own boxes: the title line (a 45% `body` title slot and `actions` button slots, 88 px wide, `control.default` high), then `lines` text slots (`lineSize` `body` or `small`; 70% then 55%) in the meta lines' box (`space.1` below the title line, `space.1` apart), then in the body's box (`space.3` below) the `field`'s placeholder, as a row that describes a setting and then edits it; or a gap-8 row of `buttons` button slots (88 px, `control.default`); or a labelled `list` (a `small` label slot and `list` `small` slots, gap 4). States `items` / `loading-items`.
  - **Cards on the page ground**: a page that is a stack of titled cards with no section around them (installed plugins) passes `loading.cards`: `ItemShape[]`, or `{ shape, count }` (one shape repeated, default 3), in a 16-gap stack as the loaded cards; each placeholder is the `Card` frame with the title line in its head and the body as an item row's. A card on the page ground is the one box, so this is allowed; inside a section the items are rows. States `cards` / `loading-cards`.
  - **List + editor**: a section that edits a list of named items next to the open item (the agent page's prompt files, §3.3 of the agent profile design) is a stacked `FormSection` (§5.3), so its card has the content's full width, and lays the card out as `Grid columns="list-detail"` (gap 16; one column below 600, §4.3): on the left a gap-8 stack of a rows `Repeater` (§6.26) whose rows each hold the item's name as a default-height button, and a `small` count line under it; on the right, with **no card** around them (§1), the open item's name as an `h3` (`Text variant="h3"`) over its fields, gap 12. The two columns are split by a `line-soft` column divider (`Grid columns="list-detail" divided`, the only grid that takes `divided`: the divider `space.4` from each column, running the row's full height; a row divider above the detail once the grid stacks below 600). Its loading shape is `{ control: "list-editor", options?, rows? }`: the same divided grid and stack, the Repeater's own list of `options` rows (default 1), each a `control.default` slot, its add button slot (`control.dense`, 88 px) and a `small` 70% count slot; and, in a gap-12 stack, a 45% `body` slot for the `h3` over a name field placeholder (an input with its help line) and a `rows`-line textarea placeholder with its help line (default 16).
- **Classes** (size classes, §4; mobile layout spec §5.1; each template draws its form, a page never branches on width): **compact**: the sub-nav is the sticky sideways row (maintainer decision 2026-11-09, kept); **medium**: the sub-nav stacked above the content; **expanded**: the sub-nav beside the content while it fits (§4.3), else stacked. **Responsive system** (maintainer decision 2026-11-22; spec §3.3): **compact**: no path row; the primary (开始会话 on the agent page) a full-width button under the title, the secondary actions in the floating row's "…"; the section tabs (`header.tabs`) a segmented control for two or three; tables in sections as grouped rows by their row mapping (§6.6); the content one scroller under the sticky sub-nav with the scrolled title (§6.65).

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
- **One step** (`steps.length === 1`): no step bar, neither the step list nor the compact count; the head, the body and the ActionRow stay (a review that is the only step, such as a plugin import).
- **Loading** (`WizardPage.loading`, `{ fields }`, `{ content }` or `{ keep: true }`): the header is its loading state (§4.2); the step bar is real (the steps are static); the ActionRow stays with its buttons disabled; the step's body is one card (the `panel` card of §5.2 with a 30% `body` slot as its title) holding `fields` field placeholders (§5.3; a count or the page's static `FieldShape[]`) `space.4` apart, in place of `children`; a step whose body is no card (a review stack) passes `content` (`BlockShape[]`, §5.2) instead, drawn in a gap-16 stack (state `loading-content`, against the loaded `content`); a step that is its own `FormSection`s passes `keep`, and its `children` render as they are inside the page's one busy region, each section saying for itself whether it is loading (§5.3), so the static titles, descriptions and field layouts stay real and no section announces itself. One busy announcement (§6.29). Nothing animates.
- **Classes** (size classes, §4; mobile layout spec §5.1; each template draws its form, a page never branches on width): **compact**: a single column, the step bar as "2 / 4" text and a sticky previous / next row (§4.4); **medium** and **expanded**: as above. **Responsive system** (maintainer decision 2026-11-22): **compact**: no path row, a large title, one scroller with the scrolled title (§6.65).

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
- **Title**: the card's h1 is a sentence (often mixed Chinese and Latin), so it uses the prose font at the `h1` step and weight (maintainer decision 2026-11-21); every AuthPage page gets it from the template.
- **Loading** (`AuthPage.loading`, `{ fields, subtitle?, note?, hint?, buttons? }`): the page keeps its frame: the two dither columns, the logo, the 400 px card with the title and subtitle the page knows (an empty `title` is an h1-sized bar; `subtitle: true` is a 70% `body` slot for a subtitle that comes with the data), and its `footer` and `preferences`. The card's body is `fields` field placeholders (§5.3; a count or the page's static `FieldShape[]`), then `note` (static content the page shows for real after the data, such as a warning card), then the card's buttons: a gap-8 stack of `buttons` `prominent` boxes (§2.5; default 1, the submit button), opened by `hint` (a static `prose` `muted` line the page shows above its buttons) when given; these parts are `space.4` apart, in place of `children`. One busy announcement (§6.29). Nothing animates.
- **No decoration** (`no-decoration`: the theme's `decoration` is `"none"`): no dither columns; the card and its width (400) are unchanged and the preference bar keeps its corner.
- **Classes** (size classes, §4; mobile layout spec §5.1; each template draws its form, a page never branches on width): **compact**: full width with 16 px gutters and the safe areas; **medium**: centered; **expanded**: as above (the status and onboarding templates, T11 and T12, take the same forms). **Responsive system** (maintainer decision 2026-11-22; spec §3.5): **compact**: the status and onboarding templates' actions are full-width buttons stacked, not side by side.

<!-- states: template-auth -->
States: `default`, `loading`, `no-decoration`

<!-- size-table: template-auth -->
| Part | State | Property | Value |
|---|---|---|---|
| auth-card | default | width | 400 |
| auth-card | loading | width | 400 |
| auth-card | no-decoration | width | 400 |
| skeleton-box[data-box=default] | loading | height | control.default |
| skeleton-box[data-box=prominent] | loading | height | control.prominent |

### 5.11 Trace (T8)
- Layout: Single in the content width (`layout.content`, §4.3): the stats (the header's `metrics` as StatCards, §5.6) in the head, then the span waterfall (§6.10) and the selected span's detail right after it; from 1280 the detail is a 400 px right panel inside the width with a `line-soft` left divider, both columns scrolling on their own, and the stats, waterfall and detail share one left edge.
- **Loading** (`TracePage.loading`, `{ spans?, stats? }`; spec §7.1 of the web query cache design): every region keeps its box and the page announces once (§6.29). The header is its loading state (§4.2); the stats are real when the header carries `metrics`, otherwise `stats` stat card placeholders (default 4: a `small` label slot over a `metric` value slot in the loaded card's box, §5.6); the waterfall is `spans` rows (default 6; a page that knows the count passes it) in the waterfall's own container and row box (28 px high, with its `line` bottom border, the name column 40%, the time track with its `line` left border, the status cell and the duration column), each with a `body` name bar (70% / 55% alternating) and a `body` duration bar filling its column; a loading row has no hover and no pointer; the detail is a card-shaped block (§5.2: the head band's 30% bar and three text bars) in the detail column's own box. Nothing animates.
- **Classes** (size classes, §4; mobile layout spec §5.1; each template draws its form, a page never branches on width): **compact**: the waterfall at full width, a span pushed as its own screen; **medium**: the waterfall with the detail below; **expanded**: as above. **Responsive system** (maintainer decision 2026-11-22; spec §3.7): **compact**: no path row; the stats 2 × 2; one scroller with the scrolled title (§6.65).

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

### 5.12 Shared file (T14)

`SharedFilePage({ name, badge, meta, onDownload?, state, children })` is the page behind a shared file's link (file sharing design `docs/superpowers/specs/2026-11-18-file-sharing-design.md` §6). It is public: no Shell, no sidebar; the people who open it may have no account.

- **Layout**: the whole window (`100dvh`) on the `panel-2` ground, the right panel's ground (§6.16.18), so a previewer looks exactly as it does in the panel. A **top bar** `layout.title-bar` high, padding 0 `space.4`, a `line-soft` bottom line, gap `space.2`: the type badge (§6.16.19), the file name (`body` 500 `ink`, one line, ellipsis; the page's `h1`), the meta line in `small` `muted` (`meta`, already localized: "张三 分享 · 2026-11-25 过期" / "Shared by 张三 · expires 2026-11-25"; one line, ellipsis), then on the right "下载" / "Download" (default button, `download` 14). Without `onDownload` there is no button. Below the bar the **body** fills the rest of the window, full width, and holds the file exactly as the right panel's body would (§6.16.22): the HTML document frame (§6.43), a built-in previewer, an extension previewer or the no-preview card; it scrolls inside itself, never the page.
- **Loading** (`state: "loading"`): the bar keeps its frame; a name or meta the page does not know yet (an empty string) is a skeleton bar (§6.29); no Download yet; the body shows the panel's loading line ("正在加载预览…" / "Loading preview…", `muted`, centered); the page is `aria-busy` once.
- **Phones** (below 600): the bar keeps one row; the name and the meta shrink (ellipsis) before the Download button does.
- The invalid-link page ("This link is invalid or has expired") is the System status template (T11, `kind: "404"`), not this one.
- **Classes** (size classes, §4; mobile layout spec §5.1; each template draws its form, a page never branches on width): **compact**: the bar compact (the name and Download), the file full screen; **medium** and **expanded**: as above.

<!-- states: shared-file-page -->
States: `loading`, `ready`, `ready-no-download`

<!-- size-table: shared-file-page -->
| Part | State | Property | Value |
|---|---|---|---|
| shared-file-page | ready | background-color | color.panel-2 |
| shared-file-bar | ready | height | layout.title-bar |
| shared-file-bar | ready | padding-left | space.4 |
| shared-file-bar | ready | border-bottom-color | color.line-soft |
| type-badge | ready | font-size | type.micro |
| shared-file-name | ready | font-size | type.body |
| shared-file-name | ready | color | color.ink |
| shared-file-meta | ready | font-size | type.small |
| shared-file-meta | ready | color | color.muted |
| button | ready | height | control.default |
| html-frame | ready | width | 960 |
| shared-file-bar | ready-no-download | height | layout.title-bar |
| preview-table | ready-no-download | font-size | type.small |
| shared-file-bar | loading | height | layout.title-bar |
| skeleton-text[data-size=body] | loading | height | type.body.line |
| preview-loading | loading | color | color.muted |

### 5.13 Library (T15)

`LibraryPage` is the Files page (file library design `docs/superpowers/specs/2026-11-27-file-library-design.md` §6, §8): the person's files, a list beside a preview. The design package has no copy of its own here; every label comes from the page.

- **Props**: `header` (path, title, the origin views as `tabs`: 全部 / 智能体交付 / 我上传的, each with `onSelect`, and `activeTab`; the `search`), `actions` (the upload, `variant: "primary"`, added after `header.actions`), `filters` and `filterCount` (the agent and type Selects), `usage` (one localized line: the storage used), `list` (a `ListDetailList` with `groups` 今天 / 本周 / 更早 and `current`, rows with a type `icon`, §6.47), `detail` (the selected file's preview frame and its details, or `null`), `detailTitle` (the file's name), `detailActions` (`LibraryAction`: `{ id, label, icon, onSelect? | href? + download?, menu?, danger? }`; none is accented, the upload is the screen's one primary), `detailEmpty` (the preview pane with nothing selected), `open`, `onBack`, `empty`, `loading` (`true` or `{ rows? }`). The template draws the detail's heading and actions, so the page passes no action row in `detail`.
- **Layout** (from 600): the head (the views and the search in its tab row, the upload rightmost), the `filters` in one row under it, then one `ListDetail` (§6.47) capped at the content width: the list column 320 and the preview at least 360, **each pane a card** (`panel`, 1px `line-card`, radius `md`), the list card `space.3` short of its 320 column so the two stand apart; the list scrolls inside its card and ends with the `usage` line (`small` `muted`, a `line-soft` top line); the preview card is a head row `layout.title-bar` high (the file's name `body` 500 `ink`, one line with an ellipsis; the actions: labelled default buttons, a download a link, `menu` actions in one `more-horizontal` menu) over the body padded `space.4` that scrolls. Each pane is a box (§1): what the page puts in it draws its unboxed form (`BoxScope` `card`; `findNestedBoxes` names them "LibraryPage list" and "LibraryPage detail"). Two panes show the selected file whether or not it is `open`; with nothing selected the preview card holds `detailEmpty` as a `panel` EmptyState.
- **Empty and loading**: `empty` draws one `page` EmptyState in place of the panes; the head and the filters stay, so a filter or a search can be undone (the page passes the no-files or the no-match copy). `loading` keeps the head (its counted tabs pending) and the filters, draws `rows` placeholder rows (default 6) in the list's row box and placeholder lines (a `30%` title line over three body lines) on the preview card's own ground, never a card inside it; one busy announcement.
- **Classes** (size classes, §4; mobile layout spec §5.1, §5.2; the template decides, a page never branches on width): **expanded** and **medium**: two panes while the region fits a 320 list beside a 360 preview (the ListDetail fit 680, read by the same container width); otherwise the list fills the region and an `open` file shows in a side `Sheet` (§6.7, draggable, titled with the file's name, its actions in the footer) whose close calls `onBack`, the row still the current one. The preview is mounted once, where it shows: in the second pane only while two panes show, else in the Sheet or the pushed screen. With `open` true, a window that shrinks or grows across the fit moves the file between the second pane and the Sheet (from 600), or onto its own screen when it crosses into compact; `open` and the selection are kept, so growing back shows the same file again. **compact**: a pushed page under the floating back (§4.6); the head has no path, the upload is the floating action button (§6.62; the strip pill's under `nav@1`), and a bar under the head holds the origin views as a full-width Segmented (§6.4 `fill`) over the search, an icon that expands into the field (and collapses, clearing it), and one 筛选 button (its active count) opening the filters in a bottom sheet; the rows take the grouped look (§6.17) with the `usage` line under them. An open file is its own screen: the head and the bar give way, the shell's floating back calls `onBack`, and a top bar holds the file's name and its actions as icon buttons (share, download) and the `more-horizontal` menu; the body runs edge to edge.

<!-- states: template-library -->
States: `default`, `loading`

<!-- size-table: template-library -->
| Part | State | Property | Value |
|---|---|---|---|
| content | default | max-width | layout.content |
| list-pane | default | margin-right | space.3 |
| list-pane | default | border-top-color | color.line-card |
| detail-pane | default | min-width | 360 |
| list-group-label | default | font-size | type.micro |
| list-group-label | default | color | color.muted |
| list-row | default | height | 64 |
| list-row[aria-current=true] | default | background-color | color.accent-tint |
| library-usage | default | font-size | type.small |
| library-usage | default | color | color.muted |
| library-detail-head | default | height | layout.title-bar |
| content | loading | max-width | layout.content |
| loading-row | loading | height | 64 |

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
- Mobile sizes (§2.5, maintainer decision 2026-11-22; compact or touch): 44 / 44 / 52 high by the control scale; a button with text pads `space.4` at the sides at `dense` and `default` and `space.5` at `prominent`, so its side space is greater than the space above and below its text; an icon button is a 44 (52) square.
- Hover transitions background, border and color over `motion.hover`.
- Disabled: `disabled` text, transparent ground, and never a border the enabled button lacks (a ghost or icon button stays borderless, so a row of sort arrows never reads inverted; default and danger keep their `line` border, a secondary's `accent` border turns `line`); a disabled primary gets the `selected` ground, a `line` border and weight 400; `cursor: not-allowed`. A disabled icon button draws its icon in `faint` (its enabled icon is already `muted`, so it must drop further to read as off), and when it is off for a reason the person cannot see (a Repeater's remove at its minimum, §6.26) its tooltip and accessible description say why.
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
| button[data-variant=ghost] | disabled | color | color.disabled |
| button[data-variant=primary] | loading | height | control.default |

### 6.2 Input / Select / Textarea / Stepper
- Height `control.<step>` (28 by default), inner padding `space.2`, 1px `line` border, radius `sm`, transparent ground, `body` type.
- Mobile sizes (§2.5, maintainer decision 2026-11-22; compact or touch): 44 high (52 at `prominent`), the text `space.3` (12) from the border, at least 16 px (§4.3).
- Focus: `accent` border + 3px `focus-ring` halo (§2.5); error: `fail` border; disabled: `line` border, `hover` ground, `disabled` text. Hover and focus transition border and halo over `motion.hover`.
- Prefix / suffix use `faint` / `muted` icons (such as `search`, `chevron-down`, `⌘K`).
- Field: label on top (`body` `ink`), help and error below (`small`; error `fail` with `circle-alert` 12), `space.1` between them.
- Field with an action (`Field.action`): a control that acts on the field's value (the device page's 「添加」 button after the host input) sits after the control on the control's own line, `space.2` apart, vertically centred on it; the control takes the rest of the width, the action keeps its own. The help, error and count stay below the whole line, so the action lines up with the control, never with the label or the help. Never a separate row of a Field and a Button (the button would sit level with the help text).
- A Textarea is two lines high unless `rows` asks for more. A Textarea with a character count shows `n / max` (muted) at the bottom right. Prose textareas (descriptions) use `prose-small`; prompts and code use the mono font.
- Textareas are plain, as the signed reference: no line-number gutter and no resize grip (`resize: none`). Code-like input (prompts, JSON) keeps lines unwrapped in the mono font (`code`); read-only code is shown by CodeBlock (§6.9).
- Stepper: `− value +`, with square buttons at the step's height on both sides.
- **Select** (maintainer decision R, 2026-11-07): the field looks like an input (the rules above, `chevron-down` 14 `muted` at its end) but is a button (`role="combobox"`, `aria-haspopup="listbox"`, `aria-expanded`; a `Field`'s `label[for]` names it) that opens the design system's own list, never the browser's popup: the composer's anchored menu (§6.16.3, the same code) as a `listbox` of `option`s (`aria-selected`), named like the field. It hangs `space.1` under the field (above it when the room below is short), its start edge on the field's, at least the field's width, its height `min(layout.menu-max-height, the live room on its side)`; the selected option has the `selected` ground and a `check` 14 at its end and is scrolled into view; a long label is cut with an ellipsis and whole in its tooltip. With more than ten options the menu's filter field heads it (focus starts there, the IME guard, typing on an option goes back to it, Space on an option picks it); otherwise focus starts on the selected option and typing jumps to the option it starts (typeahead). ↓, ↑, Enter and Space open it; the arrows move, Enter or Space picks (the change fires only for another option), Escape closes and focus returns to the field; Tab (Shift+Tab) closes it without a change and moves the focus on to the next (previous) field, as a native select (the list does not trap Tab). A click on its label focuses the field without opening it. The field is as wide as its widest option (every label sits in it, only the current one shown) and cuts the current one with an ellipsis when narrower; a value matching no option shows the `placeholder` in `faint`. Disabled: the input's disabled look, it never opens. In a form it carries a hidden native copy (`name`, `required`, `form`) so the form submits and validates it; the copy is hidden from assistive tech and never focused (a failed validation sends the focus to the field).
- Slider: a discrete block track (20 cells by default, cell width adaptive, 2 between cells, 8 high); the selected part is `accent` and the rest `line`; the thumb is a 4×16 `ink` vertical bar; keyboard ←→ by step, PageUp/PageDown by 10 steps; can be linked with a value input box on the right (8ch wide). When no value is set, the thumb is centered and the track is all `line`, so it doesn't pretend to be some value.
- Reset to default: when a field has been set by the user, a ghost small link "Reset to default" with the `refresh` icon appears on the right of the label row; clicking clears the value and returns to the default display.

<!-- states: input -->
States: `default`, `focus`, `error`, `disabled`, `action`

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
| field-control | action | column-gap | space.2 |
| input | action | height | control.default |

- **Options with a person** (state `person`): an option may carry `person: { avatarUrl }`, a 16 circle `Avatar` (§6.30; `null` draws the initial of the label) before the label, in the field (after the field's `space.2` padding, `space.1` before the label) and in the list (before the label, the menu item's own `space.2` gap). The label keeps its ellipsis and the avatar its size; an option without `person` is drawn as before. The first letter of the label is the initial.

<!-- states: select -->
States: `default`, `placeholder`, `open`, `person`, `long`, `disabled`, `error`

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
| select-label | person | column-gap | space.1 |
| select avatar[data-size=16] | person | width | 16 |
| select avatar[data-size=16] | person | height | 16 |
| select avatar[data-shape=circle] | person | border-top-left-radius | 50% |
| menu-item avatar[data-size=16] | person | width | 16 |
| menu-item avatar[data-size=16] | person | height | 16 |
| menu-item | person | height | row.default |
| menu | long | max-height | layout.menu-max-height |
| menu-filter | long | height | control.dense |
| menu-filter | long | font-size | type.small |
| menu-item | long | height | row.default |
| select | disabled | background-color | color.hover |
| select | disabled | border-top-color | color.line |
| select | disabled | color | color.disabled |
| select | error | border-top-color | color.fail |

### 6.3 Checkbox / Radio / Switch / option card
- Checkbox and radio are 14×14 with radius `sm` (radio round); the checkbox keeps the base `sm` (4) under the mobile sizes (§2.5), whose 12 would round it into a radio. Checkbox checked: `accent` ground + `on-accent` `check` icon; indeterminate `minus`. Disabled: `line` border on the `hover` ground; a checked disabled box (a choice that cannot change, a built-in skill) keeps its `check` in `muted`. Radio checked: `accent` border + a 6×6 `accent` inner dot.
- Switch: a `space.7` × `space.5` (32 × 20) track with radius `bubble` and 2px padding, a `space.4` (16) round knob; off: `line` track + `muted` knob; on: `accent` track + `on-accent` knob moved right by `space.3`; the knob moves over `motion.hover`. Where a switch stands alone its label and current state ("On" / "Off", muted) are shown as text next to it, so the state never relies on color: `SwitchField` draws that row, `control.default` high with `space.2` gaps (clicking the label toggles too).
- Switch list (`SwitchList`, a form's tools and similar lists): one `row.roomy` row per item with the name and a `small` prose `muted` description (each one line with an ellipsis), `muted` `small` meta text (such as the policy) and the switch; padding `space.4`, rows divided by `line-soft`; it sits in a `flush` FormSection card.
- Option card (rich option of a single choice): a single option may be disabled on its own (`RadioGroup` option `disabled`, drawn as the disabled card) and then says why in its description (「组织最高允许：开发」 / "Organization allows up to: Development"); the rest stay choosable. 1px `line` border, radius `md`; selected: `line-strong` border + `selected` ground (neutral, §2.3), the radio dot in `accent`. Option cards are the one allowed card inside a box (§1): a choice drawn as cards on purpose (the org 沙箱 page's 直接执行 / 需要审批 inside its form card).

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
- Tabs: text + underline when selected (§2.3); hover `hover` ground; disabled `disabled`. In the page head's tab row the underline sits on the row's bottom border (§4.2). Tabs stay on one line at every width (a tab never wraps its label); a row of tabs that does not fit scrolls sideways without a drawn scrollbar, and since the row clips, a tab's focus ring is drawn inside it. The scroll hint is an edge fade: an edge with tabs scrolled out of view fades over `space.6` (`data-fade-start` / `data-fade-end`, measured on scroll and resize), so a phone shows there is more to swipe to.
- Mobile sizes (§2.5, maintainer decision 2026-11-22; compact or touch): a tab is `touch.hit` (44) high and pads `space.4` at the sides; a Segmented group is `control.default` (44) high at every step, level with its row, with no inner padding or gap: each segment fills the whole group (its box covers the group's 1px border, so its hit area is the full 44), is at least 44 wide and pads `space.4` at the sides; the selected ground (and the hover ground) is drawn inset by 3px (the old 2px gap plus the border) on a `::before`, so it looks as before without shrinking the segment.
- **Segmented look of Tabs** (`Tabs look="segmented-compact"`; maintainer decision 2026-11-22; responsive system spec §2.1): below 600 a tab row of two or three items is drawn as a full-width segmented control: equal parts, `control.default` (44) high with each tab filling that height (the 44 hit area; the frame line is an inset 1px outline, so nothing is clipped), the Segmented's group look (the line, radius and `selected` ground of the existing Segmented above), the counts after the names. It is the same DOM as the underline tabs, restyled by CSS, so it keeps `role="tablist"`, the tab order and the arrow keys. Four or more tabs stay the sideways-scrolling row (decision D4); the page head's template sets the look by the tab count, a page declares nothing. The list's level-2 view choice is not Tabs but the scope chips (§6.63).
- Segmented in a form field takes the field's width with equal segments (`fill`).
- A Segmented either hugs its segments or is `fill` with equal segments: never a frame stretched
  wider than its segments with them bunched at the start (a stretching parent such as a column
  flex or a grid cell does not widen a hugging one: `max-width: max-content`). It holds 2–5 short
  options; more options take a Select (or Tabs when they navigate). It never wraps or scrolls.
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
- Badge: 1px `line` border, small, radius `sm`, 6 left and right; the emphasis version is outlined in the accent color; the count version is `selected` ground with `ink` text. As a mark (§2.4) it has no box: `tone="warn"` the word in `warn` (an attention mark), `tone="fail"` the word in `fail` (a danger mark). A badge is one unit: it never shrinks or wraps beside a long text (`flex: none`, `nowrap`), so a squeezed row never draws 「平 / 台」 one character per line.
- Kbd: 1px `line` border + 2px bottom edge, radius `sm`.
- Tooltip: `panel` ground + `line-strong` border + `shadow-1`, radius `sm`, small, padding `pad.dense`, 400ms delay.
- Up / down: `trending-up` 8.2% (ok) / `trending-down` 1.1s (fail) — up and down are the one place `ok` is shown.
- KeyValue: a key-value list (a detail page's facts block, the inbox inspector's property groups, detail sections); key muted with a fixed 8ch width, value single line with ellipsis. `columns={2}` (an overview card's figures, an extension's facts) flows the pairs into two columns: keys at their natural width, each value `space.3` after its key, the second column `space.7` (32 px) after the first, so a value never reads as part of the next label; one column below 600. `variant="facts"` is an open item's facts in a list-detail region (§6.47): `small` type, the keys (`fact-key`) in the UI's mono face, `muted`, the values in the prose face, `ink`, and a row marked `mono` (a tool key) keeps its value mono.
- Disclosure: an expandable block (a skill body, a run's details). Its body's 1px `line` guide on the left, indented `space.2`, is also how a `Subsection` (§6.32) sets a nested group apart inside a box. The summary line is the toggle button (`aria-expanded`, `aria-controls`, a `faint` `chevron-right` / `chevron-down` icon (12) on the right, `hover` ground, same row style as ThinkingRow); closed by default (`defaultOpen` opens it; `open` with `onOpenChange` hands the state to the owner, which opens it itself to show an error inside, §5.3 "Model purposes"); once open, the body follows `space.1` below under a 1px `line` guide on the left, indented `space.2`. The body is rendered only while open. Not in the reference set: no state list or size table yet (like KeyValue).
- DisclosureLinks: a row of inline disclosures for a block's secondary texts (a file body, an agent template's instructions, a connector template's endpoint; a description is ExpandableProse, a license DisclosureLink): `small` `muted` text buttons each followed by a `chevron-right` / `chevron-down` 12, `space.4` apart and wrapping, `ink` on hover and while open; at most one is open, its body under the row with the Disclosure's guide. Never a full-width line: that is Disclosure. DisclosureLink is one such button on its own, inline after a value, for a text that opens in a Dialog instead of under the row (a license's 全文 ›, `aria-haspopup="dialog"`).
- ExpandableProse: a prose paragraph (`body`, line breaks kept) that shows a `summary` (a description's first sentence) followed inline by a toggle with the look of a DisclosureLinks item (`small` `muted` text, a `chevron-right` 12 after the words, `ink` on hover and while open); opening shows the whole `text` with the toggle (`chevron-down`, its closing label) at its end. The labels are passed in (the plugin review head: 「完整说明」 / 「收起」). With `summary === text` no toggle is drawn. Not in the reference set: no state list or size table (like DisclosureLinks).
- Metrics on list pages are StatCards (§6.14).
- TextLink: an in-site text link drawn through the DesignProvider's `link` (§6.7 Links): `ink` text, a `line-strong` underline offset 3px that turns `ink` on hover, the accent focus ring; visited links keep `ink`. Pages never show the browser's link colors. A page's own anchor inside a design component (a `next/link` in a DataTable cell, a description) gets the same look from the base styles (`:where(a:any-link)`, zero specificity, so every component's link styles still win).
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
- **More pages** (a table read by cursor: `onLoadMore`, `hasMore`, `loadingMore`, `loadMoreError` instead of `pagination`): as ObjectList's (§6.17). Below 600 the end is a row of the grouped rows (a skeleton row in the row mapping's shape, the lead box when `compactLead`, while loading; the retry row on a failure); a table without compact roles puts it in the panel after its stacked rows. From 600 up a Load more button under the table, where the pagination stands, only while rows are drawn (never under the loading, error or empty state).
- **Narrow (below 600): stacked rows.** Every table becomes rows; it is the table's own behaviour. A table whose columns declare a compact role draws the **grouped rows** by the row mapping below (maintainer decision 2026-11-22); one without declarations draws the stacked rows described here, the fallback. The header row is hidden from sight (also above an empty state) but stays for screen readers: every table element carries its explicit role (`table`, `rowgroup`, `row`, `columnheader`, `cell`), because the stacked display drops the implicit table semantics in WebKit, and the hidden header holds plain text, no controls. What the header did moves to a compact bar above the rows, drawn only when there is something to do: a 全选 checkbox (with row selection) and a 排序 select listing each sortable column both ways (「名称 升序」, 「名称 降序」). Each row is a card, `space.2` padding above and below, a `line-soft` line between rows: the first column's cell is its title line (500, at least `row.dense` high), with the row checkbox before it and the row menu after it on the same line; every other cell is one `label value` line, the label being the column header (`small` `muted`, 10ch, one line with an ellipsis; a column without a header has no label) and the value one line with an ellipsis (the full text in `title`). Cells keep the `space.3` edge padding. Nothing sticks; the selected row keeps its 2px accent bar on the card's left; the row-menu button is a 40 px square (tap target). The toolbar wraps and its search takes the full width.
- **Row mapping (compact)** (maintainer decision 2026-11-22; responsive system spec §4.2): `Column.compact` is `"title" | "subtitle" | "meta" | "trailing" | "hidden"`, and `DataTable.compactLead(row)` returns an avatar or mark for the row. Below 600 a table where any column declares `compact` draws one **grouped list** in one rounded card (§6.34's look, from the same values, `--cb-grouped-*`: a 1px `line-soft` line when framed, none inside a box; rows padded `space.3` `space.4`; the 40 lead; hairlines inset `space.4`, or `space.4` + 40 + `space.3` past a lead): each row is exactly 64 high with a lead and up to two text lines (the text column fits the 40 lead, as §6.34's rows; a meta line adds its height) and at least 52 without, the lead, then the text column, then the trailing slot and a `chevron-right` when the row opens (`onOpen` / `href`), the hairlines inset to the text column. `title`: the one column drawn on the first line (500, `ink`, one line with an ellipsis; when none is declared, the first column without a role, never an `interactive` one; an `interactive` declared title does not open the row); `subtitle`: one muted line (several are joined with 「 · 」); `meta`: a faint `small` line (joined with 「 · 」); `trailing`: at most one, a state label, a count or a time, at the end before the chevron; `hidden`: not drawn (bulk checkboxes, wide numbers the detail shows). `Column.compactOnly: true` makes a column exist only here: it needs a role other than `hidden` (development error otherwise) and the wide table draws no header, cell or sort entry for it, so a plain-text line (a run's reason) can be the subtitle while a richer wide column shows the same fact once. An `interactive` column is drawn only when it is `trailing`, otherwise its action must be in `rowMenu`. The row's `rowMenu` and selection are not drawn: the menu items open as an ActionSheet on long press or context menu (§6.61, §6.66), titled with `rowLabel` or else the title cell; a row that opens nothing (a disabled row of an opening table included) but has menu items draws one trailing ⋯ `IconButton` labelled with the row's name (「行操作：{row name}」 / "Row actions: {name}"; 「行操作」 / "Row actions" when the row has no name) that opens the same sheet, so its actions stay reachable by keyboard; row selection and bulk actions are hidden (decision D5), so bulk work stays desktop work. The two forms are one DataTable on two DOMs (§6.64); the header stays for assistive tech as in the stacked form, one header per drawn slot (a slot of several columns names them joined with 「 · 」) plus the actions header when the table has a `rowMenu`, and every row draws each declared slot's cell, empty or not, so each cell sits under its header.
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
| menu-cell icon-button | narrow | width | control.dense |
| menu-cell icon-button | narrow | height | control.dense |

### 6.7 Overlays

Selection rules: the user needs to decide → Dialog; view / edit one object without leaving the list → Sheet; in-place options / filters → Popover / Menu; feedback on an operation result → Toast (a Dialog must not be used); creating something with more than 6 fields → a form page (T4).

- **Dialog**: width 480 / 640 (the agent map's tree is as wide as its tree, from its levels 2 and 3's width up to 1100, and those levels the conversation's column plus the body padding, §6.16.28), `panel` background + `line-strong` border + radius `md` + `shadow-2` + `scrim`. Header (h2 title + close `x`) / body (padding 16) / footer (right-aligned: ghost Cancel + primary action, the primary action carries `↵`), with 1px `line` separating header and footer. Esc closes; focus is trapped and returned after closing. Default focus: on the first field for a dialog that asks for input (新建组织, 新建令牌), else on the primary action (a `LinkButton` primary too); on Cancel for a dangerous dialog. A create dialog's primary is disabled until it is valid. A dialog that only explains why something cannot be done (退出组织 as the only owner) is not dangerous: plain title, one default button "知道了" / "Got it", and a link to where it can be fixed. A dialog whose next step lives elsewhere (加入评测集 with no eval set) says so and offers that step as its primary (`LinkButton`), never a disabled dead end. **Compact form** (below 600; interaction model spec §2.2, §2.4, D1): the same `Dialog` is a bottom sheet (§6.59), drawn per class (`ClassForms`): the handle and the sheet head (the centred title, the round close), the body in the sheet's scrolling body, and the footer in a non-scrolling sheet footer under it, over the bottom inset: its buttons full width and stacked, drawn primary first (a dangerous dialog's destructive button on top, Cancel under it), so the tab order is the visual order. The size does not apply. Focus starts on the sheet's close, also for a dialog that asks for input (no keyboard jumps up on a phone), and on Cancel for a dangerous dialog; quietly after a pointer (§2.5). The sheet holds one history entry on a compact touch window (the system back closes it); opened from an action sheet's pick it replaces it (one overlay). Crossing 600 while open draws the other form anew, so a dialog's body keeps no state of its own: it lives with the caller.
- **Dangerous confirmation**: the ordinary frame and title (`line-strong`, `ink`): the red is only on the destructive button; explains the consequences and recoverability; the object name must be typed, the confirm button is disabled until it matches, and is danger-solid once it matches. A caller that must read something first (what a delete does, ruling P3-19) passes `confirmDisabled`: the button then stays disabled and `danger` while the read is pending or failed, even with the name typed.
- **Sheet**: slides out from the right, width 480 / 720, `panel` background + `line-strong` left line + `shadow-sheet`; no scrim by default (the list is still operable). Header: an optional 28 px mark (`mark`: the plugin's icon of an extension, else its initial, §6.17) + name + version + open in a new page `external-link` + close `x`; may contain Tabs; footer: actions, a bar under a `line-soft` hairline that stays at the bottom while the body scrolls (a form's save goes there, never into the body; the primary save is enabled only while there are changes). Closing with unsaved changes needs a second confirmation. A body with several kinds of content groups them into titled regions, `Subsection variant="divided"` (§6.32): one optional status line on top (no title), then the regions split by hairlines (the extension Sheets: 部署配置 or 组织配置, 状态, 副本, 权限); a region with nothing to show is left out.
- **Follow-finger sheets** (mobile layout spec §7.4): bottom sheets (the composer's options sheet §6.16.2, a ListPage's Filter sheet, the drawer's account sheet §6.55) and side sheets (the medium class's right area and conversation list) track the finger. A bottom sheet's anatomy, sizes and behaviour are §6.59 (Bottom sheet); this item covers only the drag. The handle and the head drag the sheet (`touch-action: none` on them only); the body drags it only while its own scroll is at the top (bottom sheets), so content scrolling never fights the gesture: on touch the body's gesture is claimed by a non-passive `touchmove` that prevents the browser's pan once the finger moves down at scroll top (upward and sideways pans stay the browser's), and a cancelled gesture springs back. The handle's accessible name is 「拖动以关闭」 / "Drag to close". A side sheet drags along its horizontal axis from anywhere on it (vertical pans stay the browser's). Only the sheets named here drag (an ordinary Sheet, an admin form's, never does unless it opts in with `draggable`). The sheet carries its drag state in `data-drag` (`idle`, `dragging`, `settling`), never in `data-state`, which stays the dialog library's. Pointer events; no gesture library in `apps/web`.
  - **Dragging**: the sheet follows the finger along its axis with no transition (a bottom sheet down, a right side sheet to the right, the rail's conversation sheet to the left; never past its rest position); where the sheet has a scrim (a bottom sheet does; the side sheets have none by default) it fades by the share of the sheet's size dragged (opacity `1 − share`).
  - **Settling**: on release the sheet travels to its dismissed or its rest position over `motion.expand`, `ease-out`. A release past **40%** of the sheet's size, or above a velocity threshold, dismisses; otherwise it springs back. Under `prefers-reduced-motion: reduce` the sheet still drags and then snaps without animation.
  - Esc, the scrim and the close button still close it and focus returns as for any overlay (§6.11); full-page transitions are reserved for pushes (§4.6).
  - **Touch form** (`MOBILE_SIZE_QUERY`: compact or touch, §2.5; maintainer decisions 2026-11-21 and 2026-11-22): the sheet's top corners are `radius.md` (20 on touch), its option rows `touch.row` (52) high, its head has no hairline under it; the handle, the head, the body and the drag behaviour are unchanged. A `BottomSheet` also holds one history entry while open on a compact touch window (§6.52 "System back").

<!-- states: sheet -->
States: `dragging`, `settling`

<!-- size-table: sheet -->
| Part | State | Property | Value |
|---|---|---|---|
| sheet | dragging | background-color | color.panel |
| sheet | dragging | border-top-color | color.line-strong |
| sheet | dragging | border-top-left-radius | radius.md |
| sheet-handle | dragging | width | space.7 |
| sheet-handle | dragging | height | space.1 |
| sheet-handle | dragging | background-color | color.muted |
| sheet-head | dragging | height | touch.row |
| sheet-close | dragging | width | touch.sheet-close |
| sheet-close | dragging | height | touch.sheet-close |
| sheet-close | dragging | background-color | color.hover |
| option | dragging | height | 40 |
| sheet | settling | background-color | color.panel |
| sheet-handle | settling | background-color | color.line-strong |
| sheet-head | settling | height | touch.row |

- **Inside an overlay** (§1 "One box is enough"): a Dialog or a Sheet is the box. Its body groups with `ContentSection` headings (§6.31), `Subsection`s (§6.32) and hairline-divided `ItemList` rows (§6.33), never Cards or FormSections; a confirmation that previews a change's consequences draws them with `ImpactPreview` (§6.35); tables, code blocks and repeaters inside draw their unboxed forms by themselves. Choosing between sources in a dialog is a card `RadioGroup` straight in the body (no Card around it), and its one `FilePicker` drop zone is allowed (§6.25).
- **Links**: the design package is framework-agnostic; links in the sidebar navigation, the PageHeader path, Tabs, Sheet, TextLink and LinkCard are rendered through the `link` component of `DesignProvider` (default `<a>`); `apps/web` passes next-intl's `Link` to get client-side navigation and the locale prefix. Pages should not build `<a href>` themselves for in-site navigation.
- **Popover / Menu**: `panel` background + `line-strong` border + radius `md` + `shadow-1`; it keeps 8 px from the viewport's edges (collision padding) and, opening below or above its trigger, is at least as wide as the trigger (the org switcher, the account row; a flyout to the side keeps its own width); menu items are `row.default` high with padding `pad.default.x`, optionally led by a 16 px `muted` icon (a navigation menu's items carry the main nav's icons); an item may carry a description after its label (`small`, `muted`, one line with an ellipsis; a Repeater preset's help); the current choice of a single-choice set (the current org, the language) is an ordinary item in `ink` with a `check`, never drawn disabled; a filter Popover has a search `>` at the top and "Clear / Apply ↵" at the bottom; a hovered item gets a `hover` background. Destructive (`danger`) items go last, after a separator; a menu never draws an empty group: no separator leads, trails or follows another, so a menu whose only item is destructive (an object row's ⋯ → 停用) has no line above it. The trigger button is outlined in the accent color when open and holding a value.
- **No menu of one**: an overflow menu (`more-horizontal` in a page head or an object row, More on the conversation title bar) is drawn only when it holds two or more actions a person can take, or one destructive one (separators and disabled items don't count). With none it is not drawn; with one safe action, that action is drawn directly in its place (a button or link). A destructive (`danger`) action is never promoted out of its menu: a menu whose only action is dangerous stays a `more-horizontal` menu with that one item. A table's row menu keeps its column, so a row with one action keeps `⋯`, and a row with none shows no button (§6.6). An ObjectCard with `oneButton` keeps a lone safe item in its ⋯ beside its primary (§6.34). Never list an action twice on one screen (a menu item that repeats a visible button, the name link or a sidebar entry).
- **Command palette (⌘K)**: width 560, input with a `>` prefix; group titles small faint; the current item has the `selected` background + a 1px `line-strong` outline (neutral, §2.3); key hints at the bottom. An empty list says why in one `muted` sentence (`emptyText`; default 「没有匹配」) and may offer the next step under it as a text link (`emptyAction`, which closes the palette as it navigates).
  - **Items** are one `row.dense` line, gap `space.2`: the label (`ink`), then an optional hint (`faint`, a skill's argument hint "[issue-number]"), then optional tags (`micro` `muted` on the `selected` ground, radius `sm`, padding 0 `space.1`, the picker-menu tag), then an optional description (`muted`, filling the rest of the line with an ellipsis), then an optional source, a secondary label (`small` `faint`, at the end of the line: the plugin a skill comes from, "superpowers"), then an optional shortcut (`Kbd`, at the end).
  - **Filtering and ranking**: the query (a leading `/` ignored, case-insensitive) matches the label, an item's extra search text (not shown; e.g. a skill's qualified name "superpowers:brainstorming") and the description. Order: label prefix, then search-text prefix (also after a `<plugin>:`), then label substring, then search-text substring, then description substring; anything else is hidden. Groups follow their best item.
  - The palette is ⌘K's. The composer's `/` and `@` menus are no longer this palette: they are the `ComposerMenu` anchored to the composer (§6.16.30), which ranks with the same `commandScore`.

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
- **Toast**: top center, 16px (`space.4`) below the top of the content area (there is no TopBar, §4), stacked downward with the newest on top (errors, which stay until closed, above the rest); centered rather than top right so it never covers the PageHeader's actions (the primary button sits top right); 360px wide, and below 600px it spans the width with a 16px gutter, at the top docked under the top row (below the safe-area inset and the floating row, or the desktop shell's flat title bar, with a `space.2` gap; interaction model D2 as amended by maintainer decision 2026-11-23), sliding down into place (`motion.overlay`, none under reduced motion) and dismissed by a swipe up (compact only, back toward the top edge; from 600 a touch swipe down dismisses), one at a time: the oldest error, else the oldest other toast (first in, first shown); the others wait in a queue (`data-queued`, hidden) and an auto-dismiss timer runs only while its toast is visible, so a queued success never expires unseen and gets its full time once shown (a success pushed back by an arriving error starts over when shown again). `panel` background + `line-strong` border + radius `md` + `shadow-1`, no status-color bar: a leading 16px status icon carries the status, so it never relies on color alone (success `circle-check` in `ok`, error `circle-alert` in `fail`, progress `spinner` in accent), together with the error's `role="alert"` and the `role="status"` live region of the others. Success auto-dismisses 4s after it becomes visible, or 8s when it carries an undo ("撤销" / "Undo", no arrow; a Repeater's remove, §6.26); an error must be dismissed manually and may carry "View →"; every toast has a close button; a progress type carries a segmented progress bar under its message. A name in a toast message is quoted: corner quotes in zh (已启用「待办清单」。), straight double quotes in en (`Enabled "Todo".`), §7 "Copy".

### 6.8 Charts
- Bar charts stack discrete blocks (pixel style), `line-strong` for normal values, `fail` marks the failure count, and the current period uses the accent color.
- Mini trend Sparkline (inside tables): 12 square bars 4px wide, `muted`.
- The `fail` in a bar chart is a subset of `value` (the total): the bar height = the total, and the failure count is drawn as blocks at the top of the bar.
- Axis labels small faint; no grid lines.
- **TrendChart** (`TrendChart({ label, x, panels, current?, extra?, extraLabel?, empty?, defaultActive? })`, `panels` `{ id, label, values: (number | null)[], format(n) }[]`; admin overview design §10.1, decision D1): a time series as **small multiples**, one panel per measure, stacked, sharing the x positions (`x`, the dates) and their labels under the last panel. Each panel has its own scale; there is never a second y-scale on one plot (the eye would compare slopes the scales made up), and the API has no prop for one. A panel is its title (`small` `muted`, left; it names the one series, so there is no legend) and its latest value (the `current` point's, else the last one's; `small` `ink`, right) over the plot, 96 high at `default` and 72 at `dense` (§2.5 density from `DensityContext`): a 2 px polyline in `muted`, a 6 px square marker per value (`crispEdges`), the `current` point and the segment into it in `accent` (the text role of §2.3: the period happening now), a 1 px `line` baseline at zero, and as the y-axis only the panel's max (formatted) at the top-left in `small` `faint`; no grid lines. A `null` value is a gap: no marker, no segment across it. When no value of any panel is above zero the chart draws its flat zero state (the points on the baseline, no max) with the `empty` line (`small` `muted`) above it. The x positions are full-height columns over every panel: hovering one (or tapping it on a touch screen, where it stays after the finger lifts) draws one crosshair (1 px `line-strong`) through every panel and one tooltip (the `panel` ground, a `line-strong` border, `shadow-1`, `radius.sm`, `small`) beside it on the side with more room, holding the date (marked 当前 / current at `current`), each panel's formatted value (the label `muted`, the value `ink`) and `extra(i)` (估算 ¥12.30); it is at most half the chart wide and wraps, so it fits beside the crosshair even on a 390 phone. A pointer's point hides when the pointer leaves. `defaultActive` shows a point before any pointer or key (the reference set's hover block). The columns are the chart's width over the point count: they stay at least 24 px wide (the hit-target floor) up to about 14 points at phone width (358 px of chart), so a longer series on a phone is read through the keyboard, the summaries and the table. The chart is one focusable group (`role="group"` named `label`, the 2 px `accent` focus outline): focus shows the current point, ←/→ move it, Home/End jump, Esc hides, and the tooltip's text of a point reached by keyboard (not a pointer's hover) is mirrored in a polite live region; a point reached by keyboard stays when the pointer leaves. Each panel's plot is `role="img"` with a summary from the design i18n (「运行：最高 11-06 的 132，最新 11-11 的 64」, 「Token：全部为 0」); a visually hidden table holds every value (the row of `current` marked) and `extra(i)` in a last column headed `extraLabel`, so neither the tooltip nor color gates a value. Under `forced-colors` the strokes and markers are `CanvasText` and the current ones `Highlight`. It fills its container's width (the x positions are percentages; a 390 phone holds seven dates). `formatCompact(n, locale)` (en `3.4M`, zh `340万`) formats large measures such as tokens.

<!-- states: trend-chart -->
States: `default`, `hover`, `current`, `empty`, `gap`, `phone`

<!-- size-table: trend-chart -->
| Part | State | Property | Value |
|---|---|---|---|
| trend-chart-plot | default | height | 96 |
| trend-chart-title | default | color | color.muted |
| trend-chart-title | default | font-size | type.small |
| trend-chart-latest | default | color | color.ink |
| trend-chart-point | default | width | 6 |
| trend-chart-point | default | fill | color.muted |
| trend-chart-segment | default | stroke | color.muted |
| trend-chart-baseline | default | stroke | color.line |
| trend-chart-max | default | fill | color.faint |
| trend-chart-x | default | color | color.faint |
| trend-chart-x | default | font-size | type.small |
| trend-chart-point[data-kind=current] | current | fill | color.accent |
| trend-chart-segment[data-kind=current] | current | stroke | color.accent |
| trend-chart-crosshair | hover | stroke | color.line-strong |
| trend-chart-tooltip | hover | background-color | color.panel |
| trend-chart-tooltip | hover | border-top-color | color.line-strong |
| trend-chart-tooltip | hover | font-size | type.small |
| trend-chart-empty | empty | color | color.muted |
| trend-chart-plot | phone | height | 96 |

### 6.9 Conversation timeline and plugin view building blocks

Components shared by the conversation stream (modeled on the Claude Code VS Code extension) and plugin views (rendered from a schema, see `docs/superpowers/specs/2026-10-21-chat-panel-plugin-ui-design.md` §3–§4). The components take only plain props and do not depend on SDK types; text can be overridden through `labels`, and defaults to the design package's own i18n.

- **Timeline / TimelineItem**: an ordered list; each step has a 7×7 square marker on the left, and a 1px `line-strong` vertical line strings the steps together (the first item starts at the marker, the last ends at the marker). Markers: `dot` (`muted` solid, completed), `hollow` (`faint` border, hollow, thinking / secondary), `running` (accent solid, blinking, static under reduced motion), `error` (`fail` solid).
- **ThinkingRow**: one `muted` line "Thought for N seconds" (seconds rounded); when there is body text the whole row is an expand button (`aria-expanded`, `chevron-right` / `chevron-down` `faint` on the right), and once expanded the body is `muted`, with a 1px `line` guide on the left, preserving line breaks.
- **ToolCallRow** (superseded by the tool group and tool row of §6.16.8–§6.16.10, together with IoBlock, Timeline and the Inspector-only Checklist; kept until the conversation page moves over, then deleted): by default only one line: tool name (600) + a one-sentence description (`muted`, single line with ellipsis) + a `StatusMark` for non-completed states (running / failed / cancelled) + `▸` on the right. The whole row is an expand button, with a `hover` background on hover. On error the tool name is `fail`; when cancelled it is `muted`. Once expanded, inside a 1px `line` frame come two `IoBlock`s, IN and OUT (no OUT while running); when the output is truncated, the bottom shows small `faint` "Output too long, truncated" + a "View full output" text button (leaving it to the caller to fetch the full text from the archive).
- **IoBlock**: `panel` background; a 5ch label column on the left (`IN` / `OUT`, 11px 600 `faint`, right line `line`), and monospace raw text on the right (line breaks preserved, long words broken); IN is `ink`, OUT is `muted` (`fail` when the tool errored). The text stands in the tool detail viewport of §6.16.9 (`layout.tool-detail` high, scrolling, the 「展开」 / 「收起」 expand control on overflow; it replaced the old "Expand all (M lines)" line slicer, maintainer decision 2026-11-27).
- **Checklist**: each item is `icon + text`. `pending` `square` `faint`; `in_progress` `spinner` accent, the whole row gets an `accent-tint` background + a 2px accent bar on the left + 600, `aria-current="step"`; `completed` `check` `muted` (success is not colored, §2.4), text `faint` and struck through with `<s>`. Each item carries screen-reader status text (To do / In progress / Done). An item with an id carries it as `data-ui-item` (a right panel scrolls to it); an item with an open target (§5.3 linkage) renders its text as a link button that reads as the item's text: start-aligned when it wraps, the item's color and weight (struck through when completed), underlined only on hover and keyboard focus (the focus ring stays).
- **CodeBlock**: 1px `line` frame, `panel` background; when there is a language, an 11px `faint` language label at the top + a bottom line; body monospace, no wrapping, horizontal scrolling inside the frame; no syntax highlighting. **Inside a box** (a Card body, a form card, a Dialog or Sheet, an inline card, a property section; §1) it draws its borderless form by itself, as a DataTable is unframed there: no line, a `panel-2` tint, radius `sm`, the language label split from the code by spacing alone (no bottom line). An explicit `framed` wins (`framed` forces the frame, which inside a box is a `web-ui-box-in-box` finding). A diff is a CodeBlock (`language="diff"`), so a file diff in a review card follows the same rule. **With a title or a copy button** (`title`, `copyable`; a setup guide's code block, drawn by GuideDocument below; setup guides v2 spec `2026-11-09-setup-guides-v2-design.md` §7.3) the head is one row, min height 28, padded 2 / 4 / 2 / 8: the title in `muted` `small` at the left (one line, ellipsis), the language label in `faint` micro and a dense ghost 复制 button (`copy` icon) at the right; the bottom line as above, none inside a box. Copying writes `text` to the clipboard and the button reads 已复制 (`check` icon, `data-state="copied"` on the block) for two seconds; without a usable clipboard the code is selected and the button reads 「已选中，请按 Ctrl+C（⌘C）复制」. One line people copy (a command, an address, a code) is a CopyCode (§6.58), not a one-line copyable CodeBlock.
- **InstructionList**: numbered steps a person follows outside the product (a plugin's setup guide, plugin setup guides spec `2026-11-08-plugin-setup-guides-design.md` §5), an `ol` with `space.2` between steps: each step's number in `faint` mono `small`, right-aligned in 2ch, `space.3` before the text in the prose font at `prose-small`. The text is plain: a backtick pair is inline code (the rendered Markdown's inline code, §6.16), nothing else is markup (no HTML, no links). Unlike StepList (§6.12) a step has no done / to-do state.
- **GuideDocument**: a rendered setup guide (setup guides v2 spec `2026-11-09-setup-guides-v2-design.md` §7.2–§7.3), `GuideDocument({ blocks, renderCheck? })` with the route's blocks (`GuideBlock`: `markdown` / `code` / `check`, declared in the design package, structurally equal to the SDK's): prose is the rendered Markdown (§6.16), code a CodeBlock with its `title` and `copyable` (no language label when the language is empty), a check a CheckRow, all in document order, `space.3` apart. The page composes known pieces and never parses directives. `renderCheck` draws a check (the page's live row); without it a check is a `static` CheckRow (「保存后检查」 / "Checked after saving": no saved target yet, no request carries secrets typed into an unsaved form). It draws no box: it sits in the page's section card, where its code blocks take their borderless form (§1).
- **CheckRow**: one setup check as a status row, `CheckRow({ label, state, onRecheck?, staticNote? })` with `state { status: ok | failing | unknown | running | not_run | static, reason?, fix?, checkedAt?, cooldownUntil? }`; a `group` named by the label, no box (§1). The head line (min height `control.dense`, gap `space.2`): the status icon (16; `ok` `circle-check` in `ok`, `failing` `circle-x` in `fail`, `unknown` `circle-alert` in `muted`, `not_run` and `static` `circle` in `faint`, `running` the `spinner` in `accent`, named 「检查中」 / "Checking"), the label (500, `ink`), the status word in `small` `muted` (通过 / 未通过 (`fail`) / 无法确定 / 未检查; none while running), the checked-at time 「检查于5分钟前」 / "Checked 5 minutes ago" (`small` `muted`, relative, from `useNow`) for a result, and at the right a dense ghost 重新检查 / Re-check button (`refresh` icon, named 「重新检查 <label>」) when `onRecheck` is given, disabled until `cooldownUntil` and absent while running and on a static row. Under it, as muted prose lines (`prose-small`): the reason for a result, the fix only when failing (both plain text, never Markdown), the static note (`staticNote`, default 「保存后检查」 / "Checked after saving"). `unknown` is never drawn as a failure the person must act on.
- **EmbedFrame**: with the HTML document frame (§6.43), the **only** component in the UI that renders an iframe (`apps/web` must not write an iframe itself). `sandbox` is fixed to `allow-scripts allow-forms` (never containing `allow-same-origin`), `allow` delegates only Chrome's local network access features (`EMBED_ALLOW`: `local-network-access; local-network; loopback-network`, so after a network change the browser asks the person instead of silently blocking the embed's requests to the app's own origin), `referrerpolicy="no-referrer"`, `title` is required; width fills, height comes from props (default 360), or with `fill` it takes the remaining height of the flex column it sits in (a full-height pane's body: a `file.preview` embed fills the file preview below its header, §6.16.18, as the built-in previews do, and scrolls inside itself; a filling frame is frameless by default, the pane being its box, §1); 1px `line` border, `panel` background. **Inside a box** (an inline card, a property section, a Card; §1, §6.16.16) the box is its frame: no border and no ground of its own (`framed` overrides). Only `message` events whose `event.source` is this iframe are passed to `onMessage` (the caller parses and validates the content), and the iframe is exposed through `frameRef` for `postMessage`.
- **ImageBlock**: an image in a plugin view; block-level, width not exceeding the container, scaled proportionally, 1px `line` border; `loading="lazy"`, `referrerpolicy="no-referrer"`. It takes only an address and alt; it renders only absolute http(s) addresses, and anything else (`javascript:`, `data:`, relative paths) renders nothing.
- **AttachmentChip** (its looks are superseded by the attachment strip of §6.16.21; the behavior below stays): an uploaded file waiting to be sent in the input box. A line with a 1px `line` border and `panel` background: file name (single line with ellipsis, at most 24ch) + size (small `muted`, `B` / `KB` / `MB`) + a remove button on the right (an `x` icon button, `aria-label` "Remove <file name>"). Three states (`data-status`): `uploading` shows a 4px segmented progress bar under the name (`role="progressbar"`, `aria-valuenow` 0–100, completed segments accent, the rest `line-strong`, consistent with the Toast progress); `ready` has no progress bar; `error` has a `fail` border and small `fail` error text under the name (`role="alert"`), and can still be removed; when the caller supplies a retry, an extra `refresh` icon button appears to the left of the remove button ("Retry <file name>").
- **FileDrop**: a drag-and-drop / paste area wrapping the input area. When content carrying files is dragged in (only `Files` is recognized; dragging text does not respond) an overlay covers the area: `accent-tint` background + 1px dashed `accent` border, with one centered line of hint text (passed in by the caller); dropping hands the files to `onFiles`. Pasting a clipboard containing files inside the area also hands them to `onFiles`; when the clipboard has no text, the default paste is prevented, while if it also has text (such as copied from a document) the text is pasted as usual; a paste without files is unaffected. The overlay is always dismissed on drop and dragend. When `disabled` neither responds. `dragging` can force the overlay to show (for the catalog page and screenshots).
- **FileButton**: a file-picking button. It looks like `IconButton` (default `+`, `aria-label` passed in by the caller); clicking opens the system file picker (a hidden `input type=file`, with `accept` / `multiple` settable), and after selection the files are handed to `onFiles` and the input is cleared so the same file can be chosen again. With `showLabel` it is a default `Button` holding the icon and the label instead (a file control that stands alone, such as the profile page's 上传头像, where an icon alone does not say what it does).
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
- **Sidebar keyboard**: Tab enters the nav list at the current item and the conversation list at the active conversation (one roving tab stop per list); ↑ / ↓ move between nav items and between conversation rows; Home / End go to the first / last; ↵ follows the link; Enter / Space on a group label toggles the group (`aria-expanded`); Esc closes the rail's conversation sheet and returns focus to its button.
- **Composer keys** (§6.16.2): ↵ sends; while a run is going (or waits for a person) the message is an **interjection**, logged at once and taken in by the run at its next step (run input spec `docs/superpowers/specs/2026-11-07-run-input-and-live-drafts-design.md` D1); ⌘↵ (Ctrl+↵ off macOS) sends exactly like ↵ (D2); Shift+↵ is a newline; Esc closes the open picker menu, then the right-panel Sheet, and never stops a run (Stop stays on its button). Tab in an empty composer that shows a prompt suggestion (state `suggestion`) fills it; Esc dismisses it; elsewhere Tab moves focus and Shift+Tab is never taken.
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

- **Frame**: width `layout.sidebar`, the full window height; ground `sidebar` (the shell's ground colour from 600 up, so it reads as part of the ground, §4) and no right line from 600 up;  padding `space.3` / `space.2` / `space.2` (top / sides / bottom) and every block `space.2` apart (the 8 px rhythm).
- **Workspace context**, top to bottom:
  1. **Brand row** (`brand-row`, `row.default`): logo (pixel unit 2) + wordmark `CAPYBARA`, then at its right end three ghost icon buttons (`control.default`, 2 apart): **search** (`search`, accessible name and native tooltip "搜索 ⌘K", opens the command palette), the **inbox** (`inbox`, a link to `/inbox`, `sidebar-active` while current) and the **collapse toggle** (`panel-left`, "收起侧栏" / "Collapse sidebar", tooltip with ⌘\ / Ctrl+\; it collapses the sidebar to the rail and the choice is remembered, §4.1; the admin and setup contexts' brand rows hold only this button). The inbox carries a small count badge (`inbox-badge`, the **inset form**, unlike the rail's and the bottom navigation's nav badge below: `selected` ground, mono `micro`, inset 2px from the box's top right, min width 14, padding 0 3px) only while something is pending (`99+` above 99, `n+` when truncated); its accessible name includes the count ("收件箱，3 项待处理"), else "收件箱".
  2. **Org switcher** (`org-switcher`): a 40 high row with no box and no ground (hover paints `hover`): the org's initial in a 24 box (radius `sm`) on `ink` with `bg` text (mono, 600), the org's name (600) alone (the `~/<slug> · <role>` line is in the switch menu only), and a `chevrons-up-down` 14 icon. It opens the org menu (the user's orgs as `menuitemradio` items, then "创建组织…" when allowed); its accessible name is "当前组织：{org}，切换组织". This is the only place the current org is shown and switched. Without menu items it is static (not a button).
  3. **Navigation** (`nav` labelled "Main navigation", gap 2): 新会话 (`plus`), then the primary items 智能体 (`agent`) · 技能 (`skills`) · 连接器 (`connector`) (acceptance 2026-11-07). There is **no home item**: the new conversation is the workspace's home, so 新会话 is the current item (`activeNav: "new"`, `aria-current="page"`, the `sidebar-active` ground) on the new conversation `/` (the old `/chat` redirects there); on a conversation `/chat/<id>` no nav item is current (its row is). 技能 is for members up (guests see 新会话 · 智能体 · 连接器); hiding is cosmetic, the kernel decides.
  4. **更多** (`more-toggle`, `more-horizontal` + label + a `chevron-right` 12, `muted`): a button opening a **flyout menu to the right of the sidebar** (the design `Menu` with `side="right"`, anchored to the row, `space.3` past the sidebar's edge): 插件, 扩展, 渠道, 评测与运行, 组织设置 (插件, 扩展 and 组织设置 for members up, 渠道 and 评测与运行 for org admins only; hiding is cosmetic, the kernel decides; the row is drawn only when it has something to list, so a guest without extension pages has none), then, after a separator, the org's extension pages; every item is led by its nav icon, as in the main nav. The row takes the `sidebar-active` ground and `ink` (`data-active`) while the current page is one of its items, and that item is marked current inside the flyout (`aria-current="page"`, `selected` ground). Enter, Space and → open it; Escape closes it and returns focus to the row. Nothing is remembered and it never opens by itself. **On compact** there is no flyout and these pages are not in touch navigation (the drawer leaves them out, §6.54).
  5. **Conversations** (`section` labelled "会话"): take the rest of the height and scroll on their own, after a `line-soft` divider (inset by the sidebar's padding, like the account row's) and `space.2`. The scroll box runs out over the sidebar's `space.2` side padding to its edges and pads its content back by `space.2`, so the rows keep their place and the scrollbar sits flush on the right border, never over the rows' ends. See below.
  6. **管理后台** (`admin-entry`, super admins only, `context.adminHref`): `admin` icon (a shield), the label and an outward `arrow-up-right` 14, `muted`, directly above the account row; it enters the admin context.
  7. **Account row** (`account`): no line above it (maintainer decision 2026-11-28); a person's circle `Avatar` at 24 (§6.30: the account's image, else the name's first grapheme muted on `selected`) + the name (no org: the switcher shows it), opening the account menu (语言 ▸, 个人设置, sign out; no org entry, the switcher owns it). The menu has a **head line** and a **foot line** (maintainer decision 2026-11-28, as the compact account sheet's footnote, §6.55): the head is the system status, drawn **only when it is not ok** (`small`, `muted`, a `fail` dot; the account row then carries a `fail` dot too), the foot is `<version> · <time zone>` (`small`, `muted`); both are plain text rows, not menu items and not focusable; its accessible name is "账户: {name}". After it, in the same row, `ThemeToggle` (light / dark icon radio, the chosen one on `selected`). The rail has no room for it, so there the theme leads the account menu ("Theme: Light"). Menu items may open a submenu (`submenu`: a `chevron-right` mark, opens on hover, click or the right arrow). The auth pages (`AuthPage`) show `PreferenceBar` (a dense language `Select` and the `ThemeToggle`) in the bottom-right corner, `space.4` (16) inside the right dither column (16 from the edge below 600, where the columns are hidden), each control at its own width. The language is a cookie (`NEXT_LOCALE`), never part of the URL.
- **Admin context**, top to bottom: the brand row; the **context block** (`context-block`), one row (maintainer decision 2026-11-28): a shield in the accent tint (`accent-tint` ground, `accent` icon), "管理后台" and at its end a dense link "← 回到工作区" (`back`, `control.dense` high, padding `pad.dense.x`, radius `sm`, `small` `muted`, `arrow-left` 14; `ink` on `hover` ground on hover; its `aria-label` and `title` are "回到工作区 ~/<slug>"); there is no scope line (整个部署 · /admin); the rail keeps its shield and back button; the items 概览, 账号, 组织, 插件 (its count: what waits in its 待确认 tab), 扩展, 模型, 部署设置; no conversations, no 新会话, no search or inbox buttons (⌘K still opens the palette); the account row.

- **Setup context** (`kind: "setup"`, web-SSR spec §4), top to bottom: the brand row without the search and inbox buttons (the collapse toggle stays); the org switcher (`context.org`, as in the workspace); the navigation (`nav` "Main navigation"): **开始之前** (`nav-item`, `diamond`, the setup home `context.home`, current when `activeNav` is `home`), then the required steps, then the label **可以稍后再做** (`step-group-label`, mono `micro` `faint`, letter-spacing 0.06em, `row.dense` high with the text at its bottom; the optional steps form a `group` it names), then the optional steps; the fill; the admin entry (`context.adminHref`); the account row. No conversations, no 新会话, no command palette. A **step item** (`step-item`, `SetupStep { id, label, state, href?, reason?, optional? }`) has the nav item's box and a state mark (`step-mark`, an `Icon` 16, never a character): `done` a `check` in `ok` (still a link), `todo` a `circle` in `muted` (a link), `waiting` a `clock` in `muted`: not a link (`role="link"`, `aria-disabled="true"`, the label `muted`, no hover ground, still a roving stop so its reason can be read) with `reason` as its second line (`step-reason`, `micro` `muted`, one line with an ellipsis), which makes the item 48 high. The current step takes the nav item's current style. Its accessible name is "{label}，{state}" (已完成 / 未完成, or the reason of a waiting step; en "{label}, {state}"). In the rail the steps are their marks alone (`row.default` squares) with the accessible name in the Tooltip to the right; the group label becomes a `line-soft` divider (`step-divider`, 24 × 1). On compact the steps are a pushed list reached from the setup home, the tab root (§5.5).
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
- **Rail** (the medium class, or the expanded sidebar collapsed by the person, §4.1; the sidebar never turns into it by itself): width `layout.sidebar-rail`, icons only: the brand row is the logo alone; under it the **expand button** (`panel-left`, "展开侧栏" / "Expand sidebar", ⌘\ / Ctrl+\; it expands the sidebar and the choice is remembered; **absent on medium**, where the full sidebar does not fit beside the content; inside the desktop shell, where the window controls reach past the rail, it sits in the top row's band right after the controls instead and the rail starts below the band, desktop client spec §7.3); on medium the same place holds the **sidebar toggle** (`drawer-toggle`, `panel-left`, "显示侧栏" / "Show sidebar", `aria-expanded`, its tooltip with ⌘\ / Ctrl+\, which open and close the drawer on medium as they collapse and expand the sidebar on expanded, maintainer decision 2026-11-22; in the desktop shell's band like the expand button) which opens the **sidebar drawer** (maintainer decision 2026-11-21): the full sidebar (`layout.sidebar` wide) from the start edge over the rail and the content with a `scrim`, nothing pushed, starting below the desktop shell's top band so the band and the window controls stay uncovered; focus is trapped in it; Esc, the scrim, the toggle again (the band's, or the drawer's own brand-row `panel-left`, "隐藏侧栏" / "Hide sidebar"), and a choice of a page or a conversation close it; it slides in with `motion.overlay` (none under reduced motion), turns every drag region off while open, and never changes the remembered collapsed choice; then search and the inbox as rail icons (the inbox badge is the **nav badge** below, not the brand row's inset one); the org initial (a button opening the org menu, named as the switcher; the admin context shows the shield and the back arrow), 新会话, then **会话** (`chats`, "会话" / "Conversations", a rail button under 新会话; a Tooltip like the other rail items), the primary items (each `row.default` square, accessible name kept, a Tooltip with the label to the right, past the rail's edge, on hover and focus), 更多 as one `more-horizontal` button opening the same flyout (on `sidebar-active` while the current page is inside), the admin entry and the account. Hover over the current item takes the `hover` ground (the signed rail reference). **会话 opens the conversation section** (the same component as the full sidebar's, §6.13 above) as a **side sheet** from the rail's edge over the content, `layout.sidebar` wide, with no scrim (maintainer decision 2026-11-20); Esc, the close button, a choice of a conversation and a drag toward the rail dismiss it (§6.7); on two viewport segments it is a pane beside the conversation instead (mobile layout spec §8). The rail holds no conversation list of its own. The `chats` icon is Lucide `messages-square`, vendored with the BottomNav implementation.
- **Nav badge** (maintainer decision 2026-11-20; the rail's inbox `inbox-badge` and a rail item's `rail-badge`, and the drawer row's `navrow-badge`, §6.53: one look and **one size** for both): the count (mono `micro`, `ink`) on the `selected` ground, radius `sm`, min width 14, height 14 (`type.micro.line`), padding 0 3px. It sits **outside the icon's top-right corner**, never over the glyph: its left edge 2px past the icon's right edge and its vertical center on the icon's top edge. A 2px **ring in the ground color** of the rail or bar it sits in (`sidebar`, as a box shadow) fills that gap and cuts the badge out of whatever it crosses (the badge reaches past a rail item's square onto the rail's ground). **On the rail** (`layout.sidebar-rail`, 48) a centered 16 icon leaves 16 beside it, too little for the gap, a 14 badge and its ring, so the badge never leaves the rail: the count is **capped at `9+`**, and the badge sits **above** the corner instead (its bottom edge 2px over the icon's top edge, still clear of the glyph) with its right edge 4px inside the rail's edge (the ring and 2px clear), growing leftward.  Drawn only while something is pending (`9+` above 9 on the rail, `99+` elsewhere, `n+` when truncated); the item's accessible name always carries the full count. The full sidebar's brand-row inbox keeps its **inset** badge (above): its icon button sits 2 from the next one, with no room outside the corner.
- **Drawer forms**: below 600 the chat-first shell's drawer (§6.54) holds the sidebar's content; between 600 and 840 the rail does, and its sidebar toggle shows the full sidebar as a drawer (above).
- **First paint**: the full / rail variant follows the window width (`SIZE_CLASS_QUERIES`, §4) and the `cb-sidebar` cookie through CSS before hydration (both panels are drawn, one shown), so the server render never draws the full 256 sidebar at a narrow width nor the wrong form for a person who collapsed it. Remembered collapsed groups apply on the first client commit (layout effects) without the height motion; the motion runs only after the viewer toggles a group. The remembered collapsed list keeps at most 100 ids and drops ids of agents no longer listed once every group of that org is loaded.
- Hover never replaces the current item's `sidebar-active` ground.
- Interaction: §6.11.

<!-- states: sidebar -->
States: `default`, `item-hover`, `item-focus`, `conversation-active`, `group-collapsed`, `more-open`, `filter`, `filter-empty`, `archived`, `empty`, `loading`, `error`, `long-title`, `many-groups`, `guest`, `account-status`, `account-menu`, `admin`, `rail`, `rail-medium`, `setup`, `setup-waiting`, `setup-hover`, `setup-focus`, `setup-rail`, `pending`

<!-- size-table: sidebar -->
| Part | State | Property | Value |
|---|---|---|---|
| sidebar | default | width | layout.sidebar |
| sidebar | default | background-color | color.sidebar |
| sidebar | default | padding-top | space.3 |
| sidebar | default | padding-left | space.2 |
| org-switcher | default | height | 40 |
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
| back | admin | height | control.dense |
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
| inbox-badge | rail | min-width | 14 |
| inbox-badge | rail | height | type.micro.line |
| inbox-badge | rail | padding-left | 3 |
| inbox-badge | rail | background-color | color.selected |
| inbox-badge | rail | font-size | type.micro |
| sidebar | rail-medium | width | layout.sidebar-rail |
| nav-item | rail-medium | width | row.default |
| nav-item | rail-medium | height | row.default |
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
| link-pending[data-pending=true] | pending | height | 2 |
| link-pending[data-pending=true] | pending | background-color | color.accent |

### 6.14 StatCards

The key metrics of a list page, as a row of cards below the PageHeader (§5.1), at most 5 (throws in development and tests otherwise).

- The row: equal-width cards, gap `space.2`. **Below 600** it is two equal columns (four metrics are 2 × 2), gap `space.2` both ways, so a label keeps its words.
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
- Mobile sizes (§2.5, maintainer decision 2026-11-22; compact or touch): 44 high, padded `space.4` at the sides.
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
- **Status**: success has no mark; failure is the word "失败" / "Failed" in `fail` followed by the reason in `muted` (a tool call that returned an error is the error dot instead, §2.4, §6.16.9); something running is the `spinner` (`accent`, one turn per `motion.spin`): 16 on the live rows of the thread (thinking, tool lines and rows, group headers, sub-agent rows), 12 in panel headers and the properties panel's background tasks; a call that waits for a person has no spinner (§6.16.9). Characters are never icons.
- **Load failure** of an extension block (inline card, properties section, right panel, previewer): `circle-alert` 14 + "<name> 加载失败" / "<name> failed to load" in `fail`, the reason in `muted`, and a "重试" / "Retry" link button with `refresh` 12, inside that block only; the stream and the composer keep working.
- **Link buttons** ("View full text", "Copy output", "Retry", "Open"): no ground or border, `muted` (or `fail` inside a failure), underlined in `line-strong` with a 2px offset.
- Names in the reference set are placeholders (示例组织, 研究助手, Acme …); copy comes from §7.

#### 6.16.1 Title bar

- Belongs to the middle column only and never spans the right panel. Height `layout.title-bar`, padding 0 `space.3` 0 `space.5`, no ground, no bottom line.
- Left: the path `<org slug> / <agent> /` (mono `small`, `faint`, the agent a link led by its `Avatar` 16 and `space.1`, §6.30; the name takes the ellipsis), spaced like the page head's path (`space.2` on both sides of every `/`), then the title button (`control.default` high, radius `sm`, padding 0 `space.2`, pulled left by `space.2`, `body` `ink`, one line with an ellipsis and the full title in `title`, then `chevron-down` 14 `muted`; `hover` ground on hover and while its menu is open). It opens a menu: Rename (`square-pen`), Copy link (`link`), a separator, Delete (`trash-2`, `fail`). Rename opens a dialog; a manual rename stops title generation for good.
- Untitled: the title reads "未命名会话 · MM-DD HH:mm" / "Untitled conversation · MM-DD HH:mm" (the start time) in `muted` until a generated or manual title exists. The new-conversation page shows only the `muted` label "新会话" / "New conversation".
- Right, two groups of ghost icon buttons (`control.default` square, radius `sm`, icon 16): group 1 is the properties toggle (`panel-right`); then a 1px × `space.4` `line` separator with `space.1` on each side; group 2 is Files (`file-text`, once the conversation has a file; it opens the newest file in the right panel, whose switcher reaches the others) and the panel icons of the extensions enabled in the org, in contribution order, then More (`more-vertical`). The agent map has no icon here: its entry is the composer's agents chip (§6.16.29; acceptance item AC3, 2026-11-07). Icons that don't fit move into More, a menu of icon + label items; More exists only while two or more icons don't fit (one that doesn't fit takes More's slot, §6.7), and never repeats an icon on the bar. With no icon in group 2 the separator goes too. Each button's name is the panel it opens. The title and More menus hang 2px below their button. The open item's button has `aria-pressed="true"`, the `selected` ground and an `ink` icon; More is pressed while its menu is open.
- **Below 600** the bar is padded 0 `space.1` 0 `space.4` (the path on the 16 px content edge, the last icon's glyph near it), the title button is `touch.hit` (44) high and the icon buttons `touch.hit` square (tap targets, the mobile sizes of §2.5); fewer panel icons fit, and the rest go into More as above.
- **Compact form inside the AppShell** (the chat-first shell, §4.6): the bar leaves the column's flow and joins the floating row after the shell's menu button (or back, while the right area is pushed). The path is not drawn; the title button is the **centre pill**: the row's height (`touch.float`, the mobile sizes of §2.5: compact or touch), `radius.pill`, the `float-ground` with its `float-line` hairline and `shadow-float-touch`, weight 500, padded `space.4`, the title with its ellipsis and `chevron-down`, opening the same title menu. Every icon (the properties toggle, Files, the extensions' panels) folds into one **trailing overflow** button (`more-horizontal`, a round floating button of the same size; its menu lists the properties toggle and then the panels; accessible name 更多操作 / More actions). The new conversation's bar is not drawn there: the home's centre and trailing slots stay empty (plan Decision 27). The thread and the new conversation start under the row (`--cb-float-row`). The overflow is exactly the menu button's and the pill's size, the row's float size (`touch.float`), never the 40 px floor of the title bar's buttons (maintainer decision 2026-11-22: it was drawn larger). Outside a shell the bar keeps the form above.
- **Compact flat title bar inside the desktop shell** (maintainer decision 2026-11-22; desktop client spec §7.3): where the desktop shell reports window controls, the compact floating row is a flat title bar like the rail's band instead: one row as high as the controls (`--cb-shell-row`, 48), on the `bg` ground with a `line-soft` hairline under it across the window, the content below it. Order: the controls' reserve, the menu button (back on a pushed page), the title, "…". The buttons are the ghost IconButton at the fine pointer's `control.default` (no fill, no hairline, no shadow), the menu and "…" one size. The title is **plain text, not a button**, in the bar's text style (body, `ink`; the untitled label `muted`), one line with an ellipsis; its whole box and every empty spot of the row are window drag regions (a `DragFill` laid over the text; the controls' area; the bar's end margin), so only the two buttons take clicks, and double-clicking the title zooms the window as the native title bar does (Electron's drag region). Every drag region is off while an overlay is open (§7.3). The title menu's items (rename, copy link, compact context: whatever the page passes) move into the "…" after the properties toggle and the panels, behind a separator, in their own order. The home and the pushed pages draw the same flat row with an empty drag filler between the leading control and the page's own "…" (no path or title text in the row: the page's h1 names it, §4.2). The flat form is a style query on `--cb-shell-flat` (a registered length, 0 without controls, with a banner, in fullscreen and from 600), so a browser, a touch device and the mobile shells keep the floating row above.

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
| title | narrow | height | touch.hit |
| title-bar-button | narrow | width | touch.hit |
| title-bar-button | narrow | height | touch.hit |

#### 6.16.2 Composer

- `raised` ground, 1px `line` border, radius `md`, `shadow-float`, padding `space.2` `space.2` `space.2` `space.3`. While its textarea has focus: an `accent` border plus the 3px `focus-ring` halo (the input focus rule of §2.5) over the same shadow.
- **Touch** (`MOBILE_SIZE_QUERY`: compact whatever the pointer, or touch at any width, §2.5, maintainer decision 2026-11-22; maintainer decision 2026-11-21, reference block from the 首页, 会话中 and 对话设置 boards): the frame draws no box of its own; the **pill** (the text box `.cb-composer-box`, UI part `composer.box`: a real element holding ＋, the textarea and send, so a theme can style it and its `:focus-within`; 600 and up with a fine pointer it is `display: contents` and its three join the control row's line in the frame's grid) is a floating bar `touch.composer` (60) high, radius `radius.pill`, on `float-ground` with a 1px `float-line` border and `shadow-float-touch` (an `accent` border and the focus halo while the textarea has focus; no blur: §6, frosted glass stays out). It holds exactly the ＋ (`touch.hit` square, `muted`), the textarea and send, a `touch.float` round `accent` button (stop while a run goes); there is **no voice or microphone button** (Decision 24). Above the pill, at the start side, the **settings chip** (`ComposerOptions`, `touch.hit` high, pill radius, `<model> · <effort> · <device>`) opens the settings sheet at every width: model, thinking as a `Segmented` (低 / 中 / 高; a change plays the `selection` haptic), where to run, permissions, and the note 「设置只对这次会话生效。」 / "Settings apply to this conversation only." The device and mode pickers, quick actions and the agents chip stay below or beside the pill (rows 5 and 6 of the frame's grid), outside it. On a conversation the composer floats over the thread's bottom (`position: absolute`, `space.3` plus `--cb-inset-bottom` from the screen's edge; the open keyboard drops the inset and the page lifts the column by `--cb-keyboard-inset`), and the thread's bottom padding clears it. On the new conversation the composer is inside the page's scroll, pinned to its bottom (`position: sticky`) with `space.3` plus `--cb-inset-bottom` under it (the inset dropped with the keyboard open); the thread's clearance never applies there.
- Top to bottom: the top strip when the page passes `place`; the attachment strip (§6.16.21) when there are attachments; the textarea (no border or ground, `prose` 15 / 26 `ink`, placeholder `faint`, one line high when empty, growing with its content up to 8 lines and then scrolling, `space.2` below it); the control row.
- **Top strip** (`place: { device, project? }`, composer menus spec 2026-11-28 §6, §7; part `composer-place`, state `place`): where the conversation runs, above the attachments and the text: the device picker, a `muted` 「/」 (`composer-place-sep`, padding 0 `space.1`), the project picker (a project belongs to a device; the project picker is absent when the device offers none). Both are the composer pickers (ghost `default` step, `muted`, `chevron-down` 12, the menu anchored to them), pulled left by `space.2` like the control row so the device's label lines up with the text, `space.1` under the strip. On a conversation (state `place-locked`) both are `locked`: plain `muted` text, no chevron and no menu, the full value then the hint in the tooltip (「<value>: 发送第一条消息后不能再换设备」). A long value gives way with an ellipsis and its whole value is the tooltip; the project gives way first (it shrinks a hundred times faster than the device). With `place` the control row draws no device picker (`pickers.device` is ignored); a page that passes no `place` keeps the device picker in the control row (below).
  - **Expanded** (841 and up): device / project in full; the control row is ＋ · the mode button (icon and label) · quick actions · agents chip · flexible space · model picker (「<model> · <effort>」 with the mode menu) · context meter · send.
  - **Medium** (600 to 840, by window width only; state `place-medium`): the mode button shows its icon and `chevron-down` only, the label hidden, its tooltip naming the mode (「<mode>: <sentence>」, which `place` gives the mode button in every class); the project truncates first.
  - **Compact** (below 600; states `compact-place`, `compact-place-sheet`): the strip is one picker, the **place chip** (`composer-place-chip`, styled as the settings chip: `touch.hit` high, pill radius, `float-ground`, 1px `float-line`, `muted`, padding 0 `space.3`) reading 「<device> / <project>」 (the device without a trailing 「设备」 and kept whole up to 8em, the project giving way first with an ellipsis) with `chevron-down` 12, named 「运行位置: <device> / <project>」 / "Where it runs: <device> / <project>". It opens the **place sheet** (`composer-place-sheet`, §6.59, titled 「运行位置」 / "Where it runs"): a `SheetGroup` per picker under its heading, 设备 / Device (the device picker's items as `SheetOptionList` radios, a disabled item with its reason tag, its badge, the device action as a dense ghost button under the group, the picker's note), then 项目 / Project (that device's projects; while it has none to offer, a disabled picker with no items, the heading stays and the picker's `notice` says why under it, such as the projects loading). The mode-menu effort leaves wherever the touch form draws (`MOBILE_SIZE_QUERY`: compact, or a touch device at any width). Picking a device calls the device picker's `onPick` and keeps the sheet open (the project group follows the new device); picking a project calls the project picker's `onPick` and closes it. A tap, Space or Enter picks; the arrow keys move the focus between a group's options without picking. When neither picker can change (each locked, disabled or absent) the chip is static text with no chevron and no sheet, its tooltip 「<value>: <hint>; <hint>」 and the hints also its visually hidden text, so they are announced; a locked picker's warning (`locked.warning`, a project no longer there) keeps it a button: the chip shows the warning's `circle-alert` mark and label after the value and a tap calls the warning's `onInspect`; a locked group in the sheet is its value read-only with the hint. The chip sits on the row above the pill at its start (row 3 of the touch grid), sharing it with the mode button and the settings chip at its end; ＋ and the mode button are `touch.hit` icon buttons (the mode's icon only, no label and no chevron), the settings chip (`ComposerOptions`) reads the model's name only and holds the model and the effort (no device; no permission while the mode button shows), so the effort moves into the model's sheet and the mode menu holds the profiles alone (no effort segments wherever the touch form draws); the settings chip is at most 11em wide, the model's name cut with an ellipsis. The suggestion's touch button moves to the quick actions' row at its end, and an agent picker (no page passes one) to a row of its own under the pill.
- **Control row**, gap `space.1`, pulled left by `space.2` so the ＋ lines up with the text: ＋ (ghost `IconButton`, `plus`, "添加附件" / "Attach files"; it opens the ＋ menu, §6.16.30, when the page passes `attachOpen`: then `aria-haspopup="menu"` and `aria-expanded`; without it ＋ opens the file picker) · agent picker · device picker · model picker · effort picker · quick actions · agents chip · flexible space · context meter · send (with `place`: ＋ · mode · quick actions · agents chip · flexible space · model · context meter · send, the top strip's classes above). The agent picker is optional (`pickers.agent`) and neither page passes it: the new conversation page's agents row chooses the agent (§5.4), and on a conversation the title bar's path names it (§6.16.1; maintainer decision U, 2026-11-07), so the control row repeats no agent label. The quick actions (`quickActions`, §6.16.27) are a ghost `zap` icon button, given only when the agent has some. The agents chip (`agents`, §6.16.29) is the agent map's entry, given once the conversation has a sub-agent (never on the new conversation page).
  - Pickers are ghost `default`-step buttons in `muted`: label + `chevron-down` 12, padding 0 `space.2`, opening a picker menu (§6.16.3) anchored to them (below, or above when the room below is short). When the row is short a picker's label gives way with an ellipsis, the whole value in its tooltip; a value of at most three characters (an effort, 「高」; `data-short`) never gives way, so one glyph is never cut in half (acceptance 2026-11-09); the icon buttons and the agents chip keep their size (AC3 fix round 1).
  - **Phones** (below 600, maintainer decision 2026-11-09): the device, model and effort pickers collapse into one **options button** (`ComposerOptions`, `composer-options`; the pickers stay in the DOM for 600 and up, CSS shows one of the two): a ghost picker-styled button reading `<model> · <effort> · <device>` with `chevron-down` 12, each part shortened (the model without a vendor path or a date / `latest` suffix, the device without a trailing 「设备」 / "device", the model then cut with an ellipsis, the effort never), the whole values in its name ("会话选项: …" / "Conversation options: …") and tooltip. It opens a **bottom sheet** (`composer-options-sheet`, §6.59: `panel` ground, a `line-strong` top border, radius `md` at the top, over a `scrim`; titled "会话选项" / "Conversation options") with one group per picker, 设备 / 模型 / 思考档位 (Device / Model / Effort), hairlines between them. The **model** is not a list there (maintainer decision 2026-11-23, many models made the sheet a long scroll): its group is one `SheetRow` in a `SheetGroup` (`options-model`: the `cpu` icon, the label 模型 / Model, the current model as the muted value, a `chevron-right`) that drills into the **model page** inside the same sheet (§6.59 "In-sheet drill-in"; titled 模型 / Model, its back named 「返回会话选项」 / "Back to conversation options"). The model page lists the picker's items as `SheetOptionList`s, one `SheetGroup` per provider under its heading (`SheetGroup heading`); with more than eight models (`LONG_PICKER_THRESHOLD`) a search field heads it (`options-model-search`, the menu filter's look, `touch.hit` high under the mobile sizes, sticky at the body's top; named and placeholder 「搜索模型」 / "Search models") that keeps the models whose name or provider name holds the text (case-insensitive), a search with no match the quiet line 「没有匹配的模型」 / "No matching models" in an always-mounted live region, and the current model and the agent's default (`PickerItem.pinned`, tagged 智能体默认) lead in a group of their own, 「当前与默认」 / "Current and default", moved out of their providers. A tap, Space or Enter picks the model and goes back to the options; ↑/↓ move between the models across the groups (and up into the field) without picking; Enter in the field picks the first match. The page's notice, action and note are the picker's. The page always opens on the options again. A group reuses its picker's props: the items as radios 40 high (provider labels, the checked item on the `selected` ground with a `check`, a disabled item with its reason tag), the note under them, a standing `notice` as one `small` `muted` line under the group's title on the rows' text column (for every pointer); a `locked` picker (a conversation's device) is its value read-only with the hint. Choosing calls the picker's `onPick` and keeps the sheet open; Esc, × or the scrim close it. An existing conversation's composer uses the same button, its device read-only. The agent picker (no page passes it) and the quick actions stay in the row.
  - Where a page passes the agent picker it is a picker only before the first message; a `locked` one is plain `muted` text with no chevron (`data-locked="true"`, `title` "发送第一条消息后不能再换 agent" / "The agent can't change after the first message").
  - The device picker (`pickers.device`, environments design §15: a conversation picks its device before the model) sits between the agent and the model pickers, so the slot order is 智能体 · 设备 · 模型 · 档位. States: default (a picker menu of the devices the agent may use, the current one checked); a device that cannot be chosen is a **disabled item** (`PickerItem.disabled`, not selectable, its `tag` the reason, "未配置" / "Not configured"); an item may carry a mark after its tag (`PickerItem.badge`, a Badge in `PickerItem.badgeTone`: 「自动」 / "Auto" in `warn` for a local device in auto mode and 「沙箱」 / "Sandbox" in `default`, or for a cloud device its network, 「开放（挡内网）」 / "Open (private networks blocked)" in `warn` and 「白名单」 / "Allowlist" in `default`; auto mode spec §4; the properties panel's Context section shows the same mark under its device row, `ContextSection.deviceBadge` with `deviceBadgeTone`); **locked** after the first message (the same `locked` plain `muted` text with no chevron and no menu, `data-locked="true"`, `title` "发送第一条消息后不能再换设备" / "The device can't change after the first message"); **no device** (the person has none but may create one, maintainer decision 2026-11-23): the button leads with `cpu` 12 (`PickerProps.icon`, the chip's own `muted` ink) and reads 「不用设备」 / "No device", what the conversation will do, never 「—」; its menu has no item list, only the action 新建设备 / New device (`PickerProps.action`, standing alone without a separator; it opens the Devices page's new-device dialog) and the note. A person who has no device and cannot create one gets no device picker. It is absent when the page passes none, and with `place` the top strip holds the device instead.
  - The permission picker (`pickers.permission`, §6.16.3) is absent when the page passes none. From 640 up a page that passes it also passes the **mode menu** (`mode`, §6.16.3a, maintainer request 2026-11-19): one button at the end of the row, after the flexible space and before send, holds the permission profiles and the effort, so the row draws neither the permission nor the effort picker and the model picker reads `<model> · <effort>` (the left of the row keeps ＋, the device, that model · effort chip, the quick actions and the agents chip). Shift+Tab in the textarea (no other modifier, not composing) moves to the next choosable profile, as the mode menu's head says; with no other profile to choose it stays focus navigation. On phones the permission group follows 设备 in the options sheet (权限 / Permissions) and its value joins the options button's name; the mode button is hidden there.
  - The effort picker is hidden when the selected model declares no `effort` values; with the mode menu, the effort segments are hidden then and the model picker reads the model alone.
  - No standing explanation sits in or under the composer: guidance is a placeholder (the running and waiting hints, which show only while they apply) or lives in a menu.
  - **Context meter** (`ContextMeter`, `composer-context-meter`, state `context-meter`, maintainer decision 2026-11-28; it replaces the status bar's "上下文 N%"): a ring `control.dense` square right before send (a `line` track, a `muted` arc of the used share, `role="meter"` 0 to 100), shown once the conversation has usage and absent before; its tooltip and name "上下文已用 N%" / "Context N% used". From the compaction threshold (80 % by default) the arc is `fail` (state `context-meter-over`, `data-tone="fail"`).
  - Send: a `control.default` square icon button with `arrow-up` 16 on the `accent` ground, `on-accent` icon; disabled (no text and no files) it is the `selected` ground with a `faint` icon and no border (§6.1: an icon button never gains a border when disabled). While a run is going it becomes Stop (`square` 14, `selected` ground, `ink` icon, "停止" / "Stop").
- Placeholders: idle "输入消息，/ 使用命令" / "Message, / for commands"; new "想让 <agent> 做什么？" / "What should <agent> do?"; while running (state `running`) the hint "运行中发送的消息会在下一步交给智能体" / "Messages sent while it works reach it at its next step" (run input spec 2026-11-07 §4: ↵ and ⌘↵ both send an interjection); a prompt suggestion (state `suggestion`) replaces the idle placeholder. Keys: §6.11.
- Existing behavior carries over: file drop and paste (FileDrop), at most `attachments.maxPerMessage` attachments, `clientMessageId` dedupe on retry.
- **Menus** (§6.16.30, composer menus spec 2026-11-28): ＋, `/` and `@` open the composer's menu, drawn by the composer's `menu` slot (`menu.node`, the open `ComposerMenu`) above the frame. While the page passes `menu` the textarea is a **combobox** (`role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, and while open `aria-controls` the menu's listbox and `aria-activedescendant` its active row), focus never leaves it, and the menu's keys (`menu.onKeyDown`: ↑↓ ↵ Esc) come before the composer's own, so the ↵ that picks a row never sends. The control row's order and sizes do not change.
- **Skill chip** (phase D, state `skill`): a skill picked from the `/` menu (or typed as `/name`) shows as a chip before the text on its first line, `space.2` from it, centered on the prose line: `control.dense` high, radius `sm`, padding 0 `space.1` 0 `space.2`, gap `space.1`, the `accent-tint` ground, the label ("/fix-issue") in mono `body` `accent`, then a remove × (`x` 12, a `type.small.line` square, `hover` ground on hover; "移除 /fix-issue" / "Remove /fix-issue"; its hit target extends invisibly to a `control.dense` square, WCAG 2.5.8). The skill's argument hint replaces the placeholder. Backspace with the caret at the start removes the chip and keeps the text; the text that follows is the skill's arguments. Removing it with the × puts focus in the text; while the chip is there the text area is described by its label (`aria-describedby`).
- **Suggestion** (state `suggestion`, prompt suggestions spec `docs/superpowers/specs/2026-11-19-prompt-suggestions-design.md` §5): the person's likely next message after a completed run (`suggestion: { text, onDismiss }`). It is the textarea's placeholder (the same `faint` placeholder, replacing the idle one, never combined) while the draft is empty, no skill chip is set and no run is going (the running hint wins); below 600 it is one line, cut with an ellipsis. **Tab** (no modifier, not composing, the draft empty, the suggestion shown) fills the draft with the text, the caret at its end, and dismisses it; Tab is taken in exactly this state, so focus navigation is unchanged everywhere else, and Shift+Tab is never taken. **Esc** while it shows dismisses it. Any change that makes the draft non-empty (typing, a paste, attaching a file) dismisses it for that run: it does not come back when the draft is emptied. While it shows the textarea is described (`aria-describedby`) by a visually hidden 「按 Tab 使用建议」 / "Press Tab to use the suggestion" (`composer-suggestion-hint`); there is no live region, so its arrival never interrupts reading the reply. On a touch device (`isTouchPointer()`, no Tab key) a ghost `control.dense` button 「使用建议」 / "Use suggestion" (`composer-suggestion-use`, `corner-down-left` 14) stands at the end of the control row before send, only while the suggestion shows; its accessible name holds the text (「使用建议：<text>」 / "Use suggestion: <text>"), and a tap fills the draft without focusing the textarea (no keyboard pops up).
- **Token warning** (setup guides v2 spec §12.1, decided 2026-11-09): every composer (new conversation, a conversation, sub-agent replies) warns before sending a draft that holds something credential-like, scanned in the browser by `findTokenLikeSpans` (`conversation/token-like.ts`: Slack `xox[bpaer]-` / `xapp-`, GitHub `gh[pousr]_` / `github_pat_`, `sk-` keys, AWS `AKIA`, Google `AIza`, PEM private keys, JWTs, and runs of 32 or more base64url characters at 4.0 bits per character or more holding a digit and a letter, except URLs, `data:` URIs, paths, identifiers and package names made of words, UUIDs, hex hashes, SRI hashes, raw file base64 and code spans that hold words). A paste holding such text raises it at once; typed text is checked on send, where the first ↵ (or send click) shows the warning instead of sending. It is the Callout's warn line (§6.19) at the top of the frame (under the top strip when there is one), above the attachment strip, never a box in the composer box: 「这段内容看起来像密钥或令牌（Slack 令牌）。密钥只应填在设置页的对应字段里，不要发到对话中。」 / "This looks like a secret or token (Slack token). Secrets belong in the setting's field, not in the conversation." naming each kind found once, with 「移除」 / "Remove" (deletes the matched spans, focus back in the text except on a touch device) and 「仍然发送」 / "Send anyway" (sends the draft unchanged: `onSend`, which also works while the button is Stop); the buttons go under the sentence when the row is short (a phone). While it shows, ↵ sends; an edit that leaves no match clears it. Nothing blocks sending, nothing is highlighted in the text, and nothing is logged, reported or sent to the kernel.

<!-- states: composer -->
States: `idle`, `new`, `running`, `attachments`, `focus`, `no-effort`, `skill`, `device`, `device-locked`, `suggestion`, `context-meter`, `context-meter-over`, `place`, `place-locked`, `place-medium`, `compact-place`, `compact-place-sheet`

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
| picker | device | height | control.default |
| picker | device | color | color.muted |
| picker | device-locked | height | control.default |
| picker | device-locked | color | color.muted |
| composer-token-remove | skill | height | type.small.line |
| composer-input | skill | font-size | type.prose |
| composer-input | suggestion | font-size | type.prose |
| composer-suggestion-use | suggestion | height | control.dense |
| composer-context-meter | context-meter | width | control.dense |
| composer-context-meter | context-meter | height | control.dense |
| composer-context-meter | context-meter | color | color.muted |
| composer-context-meter | context-meter-over | color | color.fail |
| picker | place | height | control.default |
| picker | place | color | color.muted |
| composer-place-sep | place | color | color.muted |
| composer-place-sep | place | padding-left | space.1 |
| mode-button | place | height | control.default |
| picker | place-locked | height | control.default |
| picker | place-locked | color | color.muted |
| mode-button | place-medium | height | control.default |
| mode-button | place-medium | color | color.muted |
| composer-place-chip | compact-place | height | touch.hit |
| composer-place-chip | compact-place | color | color.muted |
| composer-place-chip | compact-place | padding-left | space.3 |
| mode-button | compact-place | width | touch.hit |
| mode-button | compact-place | height | touch.hit |
| sheet-group | compact-place-sheet | background-color | color.hover |
| sheet-group | compact-place-sheet | border-top-left-radius | radius.sm |
| sheet-group-heading | compact-place-sheet | font-size | type.micro |
| sheet-group-heading | compact-place-sheet | color | color.muted |

#### 6.16.3 Picker menu

- The model, effort and agent menus of the composer, and the quick actions' (§6.16.27): a Menu (§6.7: `panel` ground, 1px `line-strong` border, radius `md`, `shadow-1`, padding `space.1`) **anchored to its trigger** (maintainer decision 2026-11-07; `ConvMenu anchored`):
  - **Placement** (`menuPlacement`, a pure function): `space.1` from the trigger, below it by default, above it when the menu does not fit below but fits above (so the new conversation page's menus open below, the conversation page's above); when neither side fits the whole menu, on the side with more room. Its start edge sits on the trigger's; it may cover the textarea. 8 px stay between the menu and the viewport edge (collision padding; it shifts sideways to keep them).
  - **Size**: as wide as its content, at least the trigger's width and at most `min(320px, 100vw − 16px)`, a long label cut with an ellipsis and the whole label in its tooltip. Its height is the smaller of `layout.menu-max-height` (328: ten `row.default` items and the padding) and the room from the trigger to the viewport edge on its side minus the gap and the 8 px; it is set in CSS from Radix's live available height, so it stays right after a resize, a zoom or a phone keyboard (the side is chosen once, on open). The list scrolls inside it while the filter field above and the note below stay in view.
  - **Filter**: with more than ten items a filter field heads the menu (`menu-filter`: `control.dense` high, 1px `line` border, `accent` when focused, radius `sm`, `bg` ground, `small`, placeholder "筛选" / "Filter" in `faint`). Focus starts in it; typing narrows the items to those whose label contains the text (case-insensitive) and keeps the group label over each group that still has a match; ↓ moves to the first match and the arrows go on through the matches, ↑ on the first match returns to the field; Enter picks the first match (never while an IME composes); no match is the line "没有匹配项" / "No matches" (`menu-empty`, prose `small` `muted`). When the pointer has moved the focus onto an item or the menu, typing and Backspace go back to the field; Space on a focused item is not typing: it picks the item, as Enter does (Space in the field stays text). The field controls the list (`aria-controls`) and is described by an always-mounted live region with the match count ("N 项匹配" / "N matches") or the no-match line.
  - **Model search** (maintainer decision 2026-11-23): the model menu (`Picker searchable`, the composer's model picker) has its own filter: it shows above eight models (`LONG_PICKER_THRESHOLD`, not ten), is named and placeholdered 「搜索模型」 / "Search models", says 「没有匹配的模型」 / "No matching models" when nothing matches, and also matches the provider's name (an item's `keywords`). Past eight models the current model and the agent's default lead the menu under the label 「当前与默认」 / "Current and default", moved out of their providers; the keys are the filter's above. The options sheet's model page is the same list (§6.16.2).
  - **Open**: the list is scrolled so the checked item is in view.
  - **Form selects**: the form `Select` (§6.2) opens this same anchored menu as a `listbox` (options with `aria-selected`; without a filter the focus starts on the selected option).
- Items are `menuitemradio`, `row.default` high, padding 0 `pad.default.x`, radius `sm`, `ink`; the selected item has `aria-checked="true"`, the `selected` ground and a `check` 14 at its end.
- **Model**: grouped by provider, each group under a label (`micro` `muted`, padding `space.2` `pad.default.x` `space.1`); the chat models of the org's enabled providers (`GET /orgs/:orgId/models`), the agent's own model first and tagged "agent 默认" / "agent default" (`micro` `muted` on the `selected` ground, radius `sm`, padding 0 `space.1`). The agent's fallback model is never listed.
- **Effort**: exactly the values the selected model declares, in the order low, medium, high, xhigh, max.
- **Agent**: the agents the person can use (new conversation only).
- **Permission** (`pickers.permission`, conversation permission profiles spec 2026-11-16; state `permission`): the phone sheet's group after 设备 (智能体 · 设备 · 权限 · 模型 · 档位); from 640 up the same rows are the mode menu's (§6.16.3a), and a page passing no mode menu draws this picker after the device picker. Three **described rows** in this order: 请求批准 / Request approval (`hand`), 帮我批准 / Approve for me (`shield-check`, the default), 自动模式 / Auto (`lock-open`, identifier `full-access`). A described row (`PickerItem.icon`, `PickerItem.description`; `data-described`) grows to two lines: the icon 14 (`muted`) on the label's line, the label (`ink`) and an optional reason tag on the first line, the sentence under them (prose `small`, `muted`; `disabled` with the row), padding `space.2` `pad.default.x`, at least `row.default` high; its accessible name is the label and the tag, its description the sentence. All three rows use one look (maintainer decision 2026-11-16): no tone, badge or accent for Auto, the chosen row marked only by the `selected` ground and the `check`. A row that cannot be chosen is a disabled item with its reason as the tag; a device without scoped operations does not disable a profile (its notice is the mode menu's, §6.16.3a), and the Auto item carries only the transient tags 检查中 / Checking and 检查失败 / Check failed. An optional **action** (`PickerProps.action`, not a choice) follows the rows after a separator as a plain `menuitem` with its icon (设置审查模型 / Set up the review model, org admins only); choosing it closes the menu; in the phone sheet it is a dense ghost button under the group. There is no standing note; only a transient one (the device is checked when it starts).
- A note closes each menu (`micro` `muted`, a `line-soft` top line, padding `space.2` `pad.default.x` `space.1`): model and effort "从下一条消息起生效" / "Applies from the next message" (an ongoing conversation only: on a new conversation the pick is the first message's, so its menus have no note); agent "发送第一条消息后不能再换 agent" / "The agent can't change after the first message".

<!-- states: picker-menu -->
States: `model`, `effort`, `agent`, `permission`, `long`

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
| menu | permission | background-color | color.panel |
| menu-item | permission | padding-left | pad.default.x |
| menu-item[aria-checked=true] | permission | background-color | color.selected |
| menu-desc | permission | font-size | type.small |
| menu-desc | permission | color | color.muted |
| menu-tag | permission | font-size | type.micro |
| menu-note | permission | color | color.muted |
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

#### 6.16.3a Mode menu

- The composer's **mode menu** (`ModeMenu`, `mode` on `ComposerBox`; maintainer request 2026-11-19, after Claude Code's composer): one ghost picker-styled button at the end of the control row (`mode-button`, `default` step, `muted`, padding 0 `space.2`, gap `space.1`): the current profile's icon 14, its label, `chevron-down` 12; it keeps its size while the model's label gives way. Its accessible name is "权限: <profile>: 思考档位 <effort>" / "Permissions: <profile>: Effort <effort>" (the effort part only when there is one); its tooltip is the profile's sentence, or a locked menu's reason (`data-locked="true"`).
- It opens the anchored picker menu (§6.16.3: placement, size, `align` end on the button) with, top to bottom:
  - a **head**: the menu's label ("权限" / "Permissions", the `menu-label` look) and at the end of its line the key hint "⇧Tab 切换" / "⇧Tab to switch" (`menu-hint`, `faint`), only while the profile can change;
  - the optional **notice** (`ModeMenuProps.notice`): one `small` `muted` line right after the head and before the profiles, in the menu's note look (`menu-note`), for a standing fact about the choice, such as a device whose sandbox plugin or runtime cannot run device tools ("此设备的运行环境无法执行沙箱限制，设备工具暂时无法运行。"). It is not an item: it takes no focus, and the roving focus still opens on the first profile; the closing `note` below the profiles is separate and stays a transient fact;
  - the three profiles as **described rows** (the §6.16.3 `permission` rows: icon, label, a reason tag when one cannot be chosen, the one-line sentence, the checkmark on the current one, one neutral look);
  - a transient note when one applies (the device is checked when it starts), never a standing explanation;
  - the optional action (设置审查模型 / Set up the review model, org admins) after a hairline;
  - a hairline, then the **effort** (only when the selected model declares efforts): its label (思考档位 / Effort, `menu-label`) over one row of equal **segments** (`menu-segments`: a 1px `line` frame, radius `sm`, `bg` ground, 2 px padding and gaps, inset `pad.default.x`; each `menu-segment` `control.dense` high, `small` `muted`, radius `sm`; the checked one on `selected` in `ink`, hover `hover`). The row is a `group` named by its label; each segment is a `menuitemradio`.
- **Keyboard**: the menu's roving focus runs through the profiles, the action and the segments with ↑/↓; ←/→ move between the segments; Enter or Space picks; Escape closes; focus returns to the button. Picking a profile closes the menu; picking an effort keeps it open.
- **Locked** (a recorded or inherited profile, an unconfirmed one): every profile row is disabled, there is no key hint, and the reason closes the profiles as the menu's note; the effort stays choosable.
- Choosing Auto still goes through its confirmation (the page's dialog).

<!-- states: mode-menu -->
States: `closed`, `open`, `no-effort`, `locked`, `notice`

<!-- size-table: mode-menu -->
| Part | State | Property | Value |
|---|---|---|---|
| mode-button | closed | height | control.default |
| mode-button | closed | color | color.muted |
| menu | open | background-color | color.panel |
| menu | open | border-top-color | color.line-strong |
| menu | open | border-radius | radius.md |
| menu-label | open | font-size | type.micro |
| menu-hint | open | color | color.faint |
| menu-item[aria-checked=true] | open | background-color | color.selected |
| menu-desc | open | font-size | type.small |
| menu-segment | open | height | control.dense |
| menu-segment | open | border-radius | radius.sm |
| menu-segment | open | font-size | type.small |
| menu-segment[aria-checked=true] | open | background-color | color.selected |
| menu-segment[aria-checked=true] | open | color | color.ink |
| menu-item | no-effort | padding-left | pad.default.x |
| menu-note | locked | color | color.muted |

#### 6.16.4 Prose

- Assistant text in the prose font, `prose` 15 / 26 `ink`. Blocks are separated by `space.3`; a heading gets `space.5` above it. Prose is never collapsed into a group.
- Rendered Markdown (`Markdown`, mdast to React elements, never HTML): headings (`#` to `###` as `h3`–`h5`, all `h2` type 16 / 24, 600), paragraphs, lists (indented `space.5`), blockquotes, code blocks (CodeBlock, §6.9, `copyable`: the head with the language and the 复制 button), inline code (mono `body` on the `selected` ground, radius `sm`, padding 0 `space.1`), emphasis, strong (600), links (`ink`, underlined in `line-strong` with a 2px offset; only absolute http(s), opened with `target="_blank" rel="noopener noreferrer"`; anything else renders as text), GFM tables (mono `small`; header `muted` 400, left-aligned, a `line` under it; cells at least 4em wide, padded `pad.dense.y` `space.3` (none before the first column or after the last), a `line` between body rows; numeric columns right-aligned; at most 200 rows, then "还有 N 行" / "N more rows"), thematic breaks. Raw HTML renders as text; images are not loaded (an http(s) image becomes a link with its alt text). Parsing is CommonMark + GFM with the CJK-friendly emphasis amendment (`micromark-extension-cjk-friendly`), so `按**「框架」**来` and `**（注意）**这里` are strong, which plain CommonMark's flanking rules refuse.
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
- Expanded: the whole thinking text below it as rendered Markdown (§6.16.4; blocks `space.2` apart, headings at the text's own size) in the prose font, `prose` size, `muted`, `space.3` from a 2px `line` rule on its left. Inside a process rail (`inRail`, `data-in-rail="true"`) the rail is the rule: no left rule or padding and the text is `prose-small`.
- Live (maintainer decision 2026-11-27): no spinner (a single live step says its state in words, §6.16.8a): "正在思考 · 6 秒" / "Thinking · 6s", the seconds in `faint` and hidden from assistive technology. Under it the text's **tail** (part `thinking-tail`): the rendered Markdown in the secondary style, `prose-small` `muted` (inside a rail or not), held to its last three lines (`3 × type.prose-small.line` high, the newest line at the bottom) with the streaming cursor at its end; once older lines are cut, its top line fades out (a mask over one `type.prose-small.line`). It cannot be collapsed while it streams; when the thinking ends the row becomes the collapsed "思考了 N 秒" / "Thought for N seconds" line, and opening it shows the whole text as above.
- Replaces §6.9's ThinkingRow.

<!-- states: thinking-row -->
States: `collapsed`, `expanded`, `live`, `in-rail`

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
| thinking-body | in-rail | font-size | type.prose-small |
| thinking-body | in-rail | line-height | type.prose-small.line |
| thinking-body | in-rail | padding-left | 0 |
| thinking-body | in-rail | border-left-width | 0 |
| thinking-tail | live | font-size | type.prose-small |
| thinking-tail | live | line-height | type.prose-small.line |
| thinking-tail | live | color | color.muted |
| cursor | live | width | space.2 |

#### 6.16.6 User bubble

- Right-aligned, at most 75% of the thread width: `selected` ground, radius `bubble`, padding `pad.default`, a 1px transparent border (the queued form draws it dashed), prose font `prose` 15 / 26 `ink`, line breaks kept.
- **Touch** (`MOBILE_SIZE_QUERY`: compact or touch, maintainer decision 2026-11-22): the user's bubble sits at the end edge (`margin-inline-start: auto`, at most 85% wide); sizes follow the touch type scale (§2.2).
- **Long** (states `long`, `expanded`; acceptance item AC4, 2026-11-07, Claude's "Show more"): the bubble's text (`bubble-body`, the skill chip and the text) is clamped at `layout.bubble-clamp` (208, eight prose lines) and its last line fades out (a mask from opaque to transparent over the last `type.prose.line`, like the text output's fade, §6.16.20). Only when the clamp hides something (measured, and again on resize; the server render and hydration, which cannot measure, guess from the text: more than eight lines, counting the hard lines and each line's wrapping at about 34 CJK or 68 other characters, so a long message is folded from the first paint and the measurement then corrects it) a link button "展开" / "Show more" (`small`, the §6.16 link button: `muted`, underlined in `line-strong`) sits under the bubble, right-aligned, `space.2` below it and before the details; it has `aria-expanded` and `aria-controls` the text, opens it in full and becomes "收起" / "Show less". The attachments above, the skill chip on the first line and the details below always show. The open state is the bubble's own, local to the view and never kept (a reload or another conversation starts folded). A pending bubble (the queued form) and the transcript's bubbles behave the same.
- **Pending** (the queued form, `queued`): a message on its way, or an interjection the run has not taken in yet, or a leftover queued message (§6.11 "No queue"): the dashed bubble of §6.16.14 at opacity .6, and for an interjection or a leftover "待处理" / "Pending" under it in `small` `faint`; no actions.
- Attachments sit above the bubble, right-aligned, `space.2` apart: images as `layout.thumb` square thumbnails (radius `sm`, cropped to fill), then files as attachment chips (§6.16.21, without the remove button). A thumbnail opens the image; a file chip opens the file in the right panel (§6.16.22) like a delivered file, and a dense `download` icon button ("下载" / "Download") after the chip downloads it (a resource mention has none). A thumbnail that fails to load is reported to the caller, which may refresh the session and reload it once (as AttachmentPreview's `retry`).
- **Skill invocation** (phase D, state `skill`): the bubble starts with the skill chip, the composer's chip (§6.16.2) without its remove button: `control.dense` high, radius `sm`, padding 0 `space.2`, the `accent-tint` ground, the label ("/fix-issue") in mono `body` `accent`, centered on the first prose line, `space.2` before the text, which is the invocation's arguments (none: the chip alone). Under the bubble, right-aligned, at most 75% wide, `space.2` below it: a closed Disclosure (§6.5) "技能说明" / "Skill instructions" in `small` `muted`, a `row.dense` summary line whose chevron is `muted` too (not the Disclosure's usual `faint`), padded 0 `space.2` with radius `sm` (its hover ground never touches the words) and pulled right by `space.2` so the words stay on the bubble's edge, whose body is the text sent in the person's name (`small`, line breaks kept). A queued invocation (§6.16.14) shows the same chip in its dashed bubble.

- **Sender** (state `sender`, agent map spec §9.4): a message another agent sent (a parent's message in a sub-agent's transcript) has, above the bubble and right-aligned, "来自 <sender>" / "From <sender>" (`small`, `muted`, one line with an ellipsis, at most 75% wide, `space.2` above the bubble). A person's own message has none.

- **Author** (state `author`, account profile design): `author` `{ name, avatarUrl, showName? }` is the person who wrote the message, drawn as a 40 circle `Avatar` (as tall as a one-line bubble) (§6.30, `shape="circle"`: the picture, or the initial of `name` when `avatarUrl` is `null` or fails) at the bubble's end side: the bubble and the circle sit in one row, `space.2` apart, top-aligned, the row as wide as the thread, the bubble still at most 75%. With `showName` the name is above the message (above the attachments too), right-aligned and pulled in by the circle's width and the gap so it ends on the bubble's edge: `small`, `muted`, one line with an ellipsis, at most 75% wide, `space.2` above what follows (the trajectory's form, where the writer is not the viewer). The conversation page passes `author` only for a message another person wrote, never for the viewer's own (maintainer decision 2026-11-21). Without `author` nothing is drawn and the bubble is as before; a message with no bubble (attachments only) shows the name line but no circle.

<!-- states: user-bubble -->
States: `default`, `attachments`, `skill`, `sender`, `author`, `long`, `expanded`

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
| bubble-author-name | author | font-size | type.small |
| bubble-author-name | author | color | color.muted |
| bubble-row | author | column-gap | space.2 |
| bubble-row avatar[data-size=40] | author | width | 40 |
| bubble-row avatar[data-size=40] | author | height | 40 |
| bubble-row avatar[data-shape=circle] | author | border-top-left-radius | 50% |
| bubble | author | background-color | color.selected |
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
- **One line per compaction, a person's switch, merged sub-agent lines** (maintainer decision 2026-11-28): a manual compact run draws no run row (§6.16.23); its outcome is exactly one divider: **compacted** (unchanged) when it wrote a summary, or a **notice**: "无需压缩 · 对话还很短" / "Nothing to compact · the conversation is still short" (`compaction_skipped`: nothing precedes the kept tail, since a manual compaction summarizes every turn before the latest and keeps only about a fifth of the window of the latest turn, maintainer decision 2026-11-28; an older `too_few_turns` skip draws the same line), "压缩失败：<reason>" / "Compaction failed: <reason>" (its `compaction_failed`, or the compact run's own failure; the reason's first line as the kernel wrote it, a quiet notice, never `fail`), "已停止压缩" / "Compaction stopped" (the compact run was stopped). While it runs, the compacting row (§4.10 of the compaction spec) stays. A person's own model switch (`model_switched`, reason `user`) is a **notice** at its position: "已切换到 <model>" / "Switched to <model>", "已切换到 <model>，推理强度 <effort>" / "Switched to <model>, effort <effort>" when it set an effort, "<model>" being "智能体的模型" / "the agent's model" when the switch went back to it; the fallback keeps its own divider, and nothing is drawn for a sub-agent's model. A sub-agent that hands back a report and then completes, with nothing drawn in between, is one **notice** "<description> 交回报告并已完成 · 查看" / "<description> handed back a report and finished · Show" whose action opens the report (the separate finish line with its "打开" goes; a non-completed end after a report, or anything drawn between, keeps two lines).
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
- **Touch** (`MOBILE_SIZE_QUERY`: compact or touch, maintainer decision 2026-11-22): a group's summary line stays one line (the label ellipsizes), `touch.hit` high and full width, with the chevron at the end.
- **Two or more consecutive calls** form a group: a header tool line (the summary) and, when open, the **tool box**: `panel` ground, radius `md`, `small` type, overflow hidden, one row per call, rows divided by `line-soft`. A finished group is collapsed by default; a running group is open and its header has no chevron.
- **Summary** (copy in §7): counts by kind with each kind's verb, joined by "，" / ", " in a fixed order (commands, background task reads, tools, reads, edits, as reference set B draws it); calls that returned an error add the error dot (§2.4) and their count in the header's own color, a space after the text, the dot and the count `space.1` apart ("已运行 2 个命令 •1"; part `tool-errors`; the dot's accessible name "N 个调用返回了错误" / "N calls returned an error" names it once, the visible count is hidden from assistive technology; only rows in the failed state: a non-zero exit, a guard refusal and a not-loaded notice are not errors, §6.16.9); guard refusals add "（N 个已拦下）" / " (N blocked)" in the header's own color; edits add " · +a −b" in `faint`; a group whose rows all read, or all edit, one path names it in `ink` ("已读取 示例表.xlsx"). Running: a `spinner` (16; none when the group is a step of a process rail, §6.16.8a, where the block head spins and each running row keeps its own), the running verb of the running row's kind with the count of the group's calls of that kind, done or not ("正在运行 2 个命令" / "Running 2 commands"), and " · 已完成 N 个" / " · N done" in `faint` ("正在运行 2 个命令 · 已完成 0 个" / "Running 2 commands · 0 done"; once all are done the summary above, "已运行 2 个命令" / "Ran 2 commands"); when every live call waits for a person (§6.16.9), no spinner and the waiting word in `accent` instead of the verb ("等待你回答 · 已完成 N 个").
- **One call with a link** (§6.16.9): the tool line holds its toggle (the label and the chevron) and, after it, the link; the two are separate buttons.
- A group is the unit inside a process block (§6.16.8a) where a burst of parallel calls is still useful; what ends a block is the process-blocks spec §1.2 (an answer, a user message, a sub-agent group, the end of the run), not "prose". Pages never group calls themselves: `apps/web/src/lib/timeline.ts` turns events into groups.

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
| error-dot | collapsed-failed | background-color | color.fail |
| error-dot | collapsed-failed | width | 6 |
| tool-errors | collapsed-failed | column-gap | space.1 |
| key-arg | one-object | color | color.ink |
| tool-box | expanded | background-color | color.panel |
| tool-box | expanded | font-size | type.small |
| tool-row | expanded | height | row.dense |
| tool-line | edited | height | row.dense |
| tool-line | linked | height | row.dense |
| tool-link | linked | color | color.muted |
| tool-link | linked | font-size | type.small |

#### 6.16.8a Process block

One run's thinking, tool calls and narration drawn as one block (conversation process blocks spec §1.3, §3, §4; `ProcessBlock`, `RailStep`, `PendingActions`). No frame: the only boxes are an expanded tool box and the cards, never a box inside a box.

- **Spinners** (maintainer decision 2026-11-27): a block draws a `spinner` in only two places: (a) its head while the run is live; (b) each of several concurrent sibling items (each running row of a parallel group, §6.16.8), to tell running from done. A rail step's gutter always shows the step's kind icon (`lightbulb` for thinking, `terminal` for a command, `file-text`, …), live, waiting or done; it never turns into a spinner or a hand. A single live step has no spinner of its own: it states its state in words ("正在思考 · 6 秒" / "Thinking · 6s", §6.16.5; a running tool line its `ink` label and its time, §6.16.9; a waiting one its waiting word). Tool groups and lines in a rail are drawn `inRail`. The one exception is the planning row's capybara: it is the icon of the "next step not started" node, the rail's only animated node, with no spinner beside it.
- **Planning row** (`rail-planning`; maintainer decision 2026-11-27): while the run is live and no step is (the model plans the next one; the §6.16.24 "when"), the rail's last row is the walking capybara of the working line (§6.16.24) drawn at one CSS pixel per art pixel (14 × 10, crisp on any DPR; a theme's mark 10 high and at most 16 wide, its aspect kept; maintainer decision 2026-11-27: no larger than the rail's other marks), centred in the 20 px icon column like the 14 px icons, the rule breaking 4 px clear of it as the node and the rotating caption ("规划中…") as the row's text, aria-hidden (the head is the live region). When a step starts, it takes the planning row's place (the same row, the same `row.dense` height); when the step ends and the model plans again, the row is appended at the tail again. The block stands from the run's start (head and planning row before any step; a message this view sent before its run is logged gets such a block after its bubble), and the row goes when the run ends, as the block collapses. A live block showing only its last steps keeps it, as does a block the person closed. While it stands the head reads only "正在运行" / "Running" and the time, no step. It is the rail's last edge (`data-edge` `last`, or `only` alone).

- **Head** (part `process-head`, the polite live region; one tool line, `row.dense`, never wraps; the label ellipsizes before the status words, the error mark and the chevron; its text changes only when the current step changes, the elapsed time is hidden from assistive technology; while **running** with `announce`, the visible `process-summary` follows a streaming call within 300 ms and is `aria-hidden`, and the visually hidden part `process-announce` is what the live region reads, throttled by the page to one change per 3 s). **Running**: a `spinner` (16, `accent`), "正在运行 · <当前步骤>" / "Running · <step>" in `ink` (part `process-summary`; the step is a command's description when it has one, never the raw command line, else the tool name and its key argument; several commands running side by side read "<first description> 等 n 个命令" / "<first> and n−1 more commands", e.g. "检查依赖 等 2 个命令" / "检查依赖 and 1 more command") and the elapsed time at the end (`process-time`, `faint`, tabular, live form of `formatDuration`); no chevron. **Waiting**: `hand` in `accent` (16), the waiting words in `accent` (`process-waiting`), " · " and the step label, the elapsed time; no spinner, no chevron. **Finished**: up to six **kind chips** (`process-chip`: 20 circles, `panel` ground, `line-soft` border, 11 icon in `muted`, overlapping by 5, first-use order; each chip is an image named by its kind, with the same title), the summary in `muted` ("已处理 2 分 43 秒 · 待办 4/4 · 思考 4 次 · 12 个工具" / "Worked for 2m 43s · Todos 4/4 · Thought 4 times · 12 tools": the pinned card's title and badge when the run has one; zero thoughts or tools are left out; no time known: "已处理" / "Worked"), the error dot and count when a call returned an error (§2.4, §6.16.8, the dot named "N 个调用返回了错误"), and a chevron (`aria-expanded`, `aria-controls` the rail). **Stopped** / **failed**: the finished head plus the word "已停止" / "Stopped" in `muted` or "失败" / "Failed" in `fail` (`process-state-word`, never shrinks).
- **Background tasks**: after a run ends with tasks still going, a `small` `faint` line "N 个后台任务仍在运行" / "N background tasks still running" under the head.
- **Pinned card**: under the head, before the rail, `space.1` below it.
- **Rail** (`process-rail`, open only; `space.1` under the head): one `rail-step` per step, a 20 `rail-gutter` (`row.dense` high) holding the step's kind icon (14, `faint`; a plugin's image 14; narration a 5 `rail-dot` in `line-strong`; never a spinner or a hand, see **Spinners**) on a 1px `line` rule that runs from the first icon to the last, broken around every mark with 4 px clear above and below it (maintainer decision 2026-11-27: each row draws its segment above its mark and below it, through the gap to the next row; the first row has none above, the last none below; drawn segments, never a ground behind the mark, so the break holds on hover, selected and dark grounds; the capybara, the narration dot and a section header's icon alike) (a rail drawn by hand: by the first and last `rail-step` among the rail's children, so its steps must be the rail's direct DOM children; a rail given as `rows` (`RailList`, part `rail-list`): by each row's `data-edge`, `first` / `mid` / `last` / `only`, its true place on the rail whichever rows are mounted); steps sit `space.1` apart (padding, so the rule stays continuous). Narration text is `prose-small` `muted`, rendered Markdown (inline code at `small` in the code face, bold, links, lists; blocks `space.2` apart, headings at the text's size); thinking rows draw `inRail` (§6.16.5), tool lines and rows expand in place as before. The rail never repeats the icon on the line itself.
- **Fold row** (`process-fold`): "前 N 步" / "N earlier steps" in `faint` with `chevron-up` (12) in the gutter, above the first drawn step; it opens the earlier steps. Its gutter is a step's (20 wide, `row.dense` high) centred on the row's text, so the chevron stands in the rail's icon column and on the text's line. A running block shows only its last four steps.
- **Long rails** (`RailList`): up to 120 rows every row is mounted; past it only the rows within 800 px of the viewport are (measured as they mount, estimated until then), and a `rail-spacer` (`aria-hidden`, carrying the rule) stands for each run of unmounted rows, so the rail keeps its height and the reading order stays the rail's; a row holding focus stays mounted. No paging and no "more" row.
- **Sections** (`rail-section`, process blocks spec §1.3): with a task list in play (a pinned card whose text is a Markdown task list), the rail is cut by the item that was current when each step ran (the list's first unchecked item as of the latest list before the step); each section opens with a header row on the rule: its gutter holds `list-checks` (14, `faint`), `check` once the run's latest list has the item done; its body is a toggle (`rail-section-head`, `row.dense` high, `aria-expanded`) with the item's words (`prose-small`, 600, `muted`, ellipsized), the step count ("3 步" / "3 steps", `small` `faint`, tabular) and a chevron (12). A done item's section starts closed. Steps before the first list, or while no item is open, stand without a header.
- **Touch** (`MOBILE_SIZE_QUERY`): the head, the fold row and a section header are `touch.hit` high; the head stays one line, the label yields.
- **Pending actions** (`pending-actions`): things that need the person without blocking the run (handoff links), one box (`raised` ground, 1px `line` border, radius `md`, `hidden` overflow), rows divided by `line-soft` hairlines, each an icon (14, `muted`), a title (`body`, 600, `ink`), an optional description (`small`, `muted`) and its action in `accent`: a link to the page where it is done, or a button that starts it in place (a connector connection; `busy` disables it, `faint`), drawn alike. With two or more items the box opens with "N 项需要你处理 · 不阻塞，我已继续" / "N things need you · not blocking, I carried on" (`pending-many`, `micro` `faint`); one item has no such line. Order outside the block: block, blocking cards, pending actions, files and edits, answer.
- The tool line's key argument is `faint` in every row state (a running label turns `ink`, its key argument does not).

<!-- states: process-block -->
States: `running`, `live-commands`, `live-thinking`, `planning`, `waiting`, `finished`, `open`, `stopped`, `failed`, `pending`, `pending-many`

<!-- size-table: process-block -->
| Part | State | Property | Value |
|---|---|---|---|
| tool-line | running | height | row.dense |
| tool-line | running | font-size | type.small |
| spinner | running | color | color.accent |
| spinner | running | width | space.4 |
| process-summary | running | color | color.ink |
| process-time | running | color | color.faint |
| rail-gutter | live-commands | width | 20 |
| tool-row | live-commands | height | row.dense |
| spinner | live-commands | color | color.accent |
| tool-label | live-commands | font-size | type.small |
| rail-gutter | live-thinking | width | 20 |
| thinking-tail | live-thinking | font-size | type.prose-small |
| thinking-tail | live-thinking | color | color.muted |
| rail-planning | planning | height | row.dense |
| working-mark | planning | color | color.accent |
| process-waiting | waiting | color | color.accent |
| tool-line | finished | height | row.dense |
| process-summary | finished | color | color.muted |
| process-chip | finished | width | 20 |
| process-chip | finished | height | 20 |
| process-chip | finished | background-color | color.panel |
| process-chip | finished | border-top-color | color.line-soft |
| error-dot | finished | background-color | color.fail |
| rail-gutter | open | width | 20 |
| rail-gutter | open | height | row.dense |
| rail-step | open | padding-bottom | space.1 |
| rail-dot | open | width | 5 |
| rail-dot | open | background-color | color.line-strong |
| key-arg | open | color | color.faint |
| process-fold | open | color | color.faint |
| process-state-word | stopped | color | color.muted |
| process-state-word | failed | color | color.fail |
| pending-actions | pending | background-color | color.raised |
| pending-actions | pending | border-radius | radius.md |
| pending-title | pending | color | color.ink |
| pending-title | pending | font-size | type.body |
| pending-desc | pending | color | color.muted |
| pending-action | pending | color | color.accent |
| pending-many | pending-many | color | color.faint |
| pending-many | pending-many | font-size | type.micro |

#### 6.16.9 Tool row

A single tool line reserves its complete waiting state without shrinking or wrapping it. Long
tool descriptions yield space with an ellipsis before the status, in both languages and at phone
widths; the disclosure chevron remains visible.


- `row.dense` minimum height, padding `pad.default`, gap `space.2`, `small` `muted`; `hover` ground on hover (over `motion.hover`), a 1px `accent` outline at -1px on focus. A row with detail is a `button` with `aria-expanded` and a chevron at its end.
- **Label** (one line, ellipsis), as the Claude Code VS Code extension draws it: the **name** in bold (600, the bold face; §2.2, `muted`), then the key-argument preview (`faint`), then extra information after " · " (`faint`).
  - **Name**: a builtin's tool name as is (`Bash`, `Read`, `Edit`, `Grep` …), untranslated, as a proper noun; a connector tool's connector display name, or an extension tool's plugin display name, followed by its local tool name in brackets (`Acme 工单 [search_tickets]`). The brackets show the local name, never the declared `title`: the title is the row's tooltip (`title` attribute).
  - **Preview**: a shell row (`Bash`) shows the `description` the model wrote (no description: the command, cut as below); its extra is never the kernel's display summary (the exit code and the command line): the command and the exit code are in the detail (maintainer decision 2026-11-27); every other row its key argument: the tool's declared `keyArgs` (else the first string argument; Read / Write / Edit the path, Glob / Grep the pattern, Skill the skill). The preview is its first line, cut at 80 characters with "…".
  - Edits add "+a −b" as the extra, unless the edit could not be diffed (a `Write` over a binary or very large file: `truncated` without hunks), which shows no line counts and no diff.
  - **The question tool** (`AskUserQuestion`, kind `question`, which the web derives from the builtin's name; the kernel's kind stays `meta`): the name slot reads the verb "已提问" / "Asked" (600), the preview the first question's `header`, else its question, else the tool's title. Its question card (§6.16.12) stays below.
- **Link** (`link`: a label and an action): a background `Bash` call (`run_in_background: true`) links its task, "查看「<description>」的输出" / "View output of <description>", which opens the task's output on the right (§6.16.18); its row reads "后台运行" / "In background" as the extra, which replaces any other extra. The link is a link button (`small` `muted`, underlined, `ink` on hover) at the row's end, after the chevron; the row is then a plain container holding its toggle (a button with the label and the chevron, `aria-expanded`) and the link, never one inside the other. Without detail the toggle is the label alone.
- **Status**: running — a `spinner` (16) before the label (none on a single tool line in a process rail, §6.16.8a: its gutter names the kind and the block head spins; rows inside a group keep it), the label `ink`, the elapsed time in `faint` at the end (every live row: a queued call that has not started yet counts from when it was logged) ("12 秒" / "12s", "1 分 03 秒" / "1m 03s"; `formatDuration` with `live`, §7); waiting for a person — a live call with a pending approval, question or connection (the web reads it from the log: `approval_requested` without its decision, `question_asked` without its answer, `connection_required` before the result) has no spinner and no timer: the label `ink` and at the end the waiting word in `accent`, "等待你回答" / "Waiting for your answer", "等待你批准" / "Waiting for your approval", "等待你连接" / "Waiting for you to connect"; when someone else has to act (a shared conversation: the approval's assigned member or escalation role, the run's starter for a question or a connection, per the log's `approval_requested` and `run_started`), the word names them: "等待 张三 批准" / "Waiting for 张三 to approve", "等待 张三 回答" / "Waiting for 张三 to answer", "等待 张三 连接" / "Waiting for 张三 to connect", with a role for an escalated approval ("等待 管理员 批准" / "Waiting for an admin to approve"); a log without the approver keeps "你"; once answered the row runs as before; done — no mark; failed — the error dot (§2.4: 6 px, `fail`, a space after the label, part `error-dot`, `role="img"` with the accessible name and tooltip "调用返回了错误" / "The call returned an error"; never the word "失败") and " · <the error's first line>" in `muted`, the expanded output keeping the full error text (a shell command that timed out or was stopped is a failure; a non-zero exit is not: the command ran and its exit code is information, so the row is done and names the code after the label, " · 退出码 1" / " · exit 1" in `fail` (part `exit-code`, in the meta, state `exit-code`); a zero exit is not named on the row, and the expanded detail names every exit code; old logs render the same); refused by a guard — a `Write` / `Edit` the read-before-write check stopped (`tool_result.view.kind: "guard"`; the model still gets the error) is done, not failed: after the label " · 已拦下：需先读取" / " · Blocked: read the file first" (`not_read`) or " · 已拦下：需先重新读取" / " · Blocked: read the file again first" (`modified`) in `muted` (part `guard-word`), the expanded output shows the refusal; a log without the guard view keeps the failed row; not loaded — a call to a tool the catalog holds but the step's request did not carry (`tool_result.view.kind: "not_loaded"`; the kernel tells the model to load it with `ToolSearch` and the model retries, so this is the protocol working) is done, not failed: after the label " · 需先加载工具" / " · Load the tool first" in `muted` (part `notice-word`), the expanded output shows the kernel's message; it is not counted in the group header at all; a log without the view keeps the failed row; reconciling — a background `Bash` start the kernel sent but could not confirm (`tool_result.view.kind: "launch_unconfirmed"`, after a transport loss; the model still gets the error and the kernel reconciles the start under its original identity) is done, not failed: after the label " · 正在确认是否已启动" / " · Confirming whether it started" in `muted` (part `notice-word`, `data-notice="reconciling"`), the row keeps its link to the task; it settles from the log (`background_task_finished`) or the background tasks list (`starting` false): a task confirmed running or that ran and ended drops the word, a launch given up, abandoned, revoked or refused (`lost` / `failed` with a `launch…` reason) becomes a failed row with the call's text; not counted in the group header; ran outside the sandbox — a command the command review admitted to run outside the OS sandbox (a per-call escalation, `tool_result.review.sandbox: "escalated"`), done or failed, adds after the label (and after a failure's reason) " · 在沙箱外运行" / " · Ran outside the sandbox" in `muted` (part `sandbox-word`); never while pending or running, not counted in the group header; approved automatically — a boundary crossing Full access granted by itself (`tool_result.review.decisionSource: "full-access"` with a `crossing`), done or failed, adds " · 已自动批准：<kind>" / " · Approved automatically: <kind>" in `muted` (part `auto-granted-word`; kinds 目录 / directory, 主机 / host, 在沙箱外运行 / running outside the sandbox, 敏感命令 / sensitive command), after the sandbox word; never while pending or running, not counted in the group header; approved without asking — a call the Auto profile ran, or the review model approved under Approve for me (`ToolRowProps.approvedBy: "auto" | "review-model"`, from the call's `tool_ask_decided` event), done or failed, adds " · 已自动批准" / " · Approved automatically" or " · 审查模型已批准" / " · Approved by the review model" in `muted` (part `approved-by-word`), after the auto-granted word; never while pending or running, not counted in the group header (states `auto-approved`, `review-approved`); the status words (the guard, notice, sandbox, auto-granted and approved-by words, and the cancelled word) are the row's meta (part `tool-meta`), drawn after the label in an element that never shrinks or wraps, so a long description or key argument yields with the ellipsis and the words stay whole (state `auto-granted`: a long command Full access let run outside the sandbox; R3 Mac acceptance 2026-11-20); blocked by a policy hook — failed (the error dot), "被扩展「<extension>」拒绝" / `Denied by extension "<extension>"` as the reason.
- **Streaming** (`status: "streaming"`; streaming tool input spec §6.4): a call whose input the model is still writing; nothing runs yet. Before the label the **stream mark** (part `stream-mark`) stands where the spinner would: a `space.4` (16) square holding three round `accent` dots `space.1` (4) wide (part `stream-dot`), spread across it, each fading to 0.35 opacity and back over `motion.pulse` (`ease-in-out`), the second and third a third and two thirds of a period later, so a calm wave runs through them; under reduced motion the three dots stand still at full opacity. The mark is decorative (`aria-hidden`): the word says the state. The label is `ink`, as running. At the end, where a running row's timer stands, the **progress** (part `stream-progress`, `faint`, never shrunk or wrapped, like the meta): the word, then the lines when the input view counts them (`file_write`, `file_edit`, `text`: the lines of the text being written), then the input's size (`formatBytes`), joined by " · ": 「生成中 · 86 行 · 2.7 KB」 / "Writing · 86 lines · 2.7 KB" for a tool with an input view (`command` has no line count: 「生成中 · 214 B」 / "Writing · 214 B"); 「生成参数中 · 1.2 KB」 / "Writing input · 1.2 KB" for any other tool (the generic form). No timer, no actions: no approve, no answer, no stop, no link (stopping the run stops it); a row with detail keeps its toggle and chevron after the progress. The key argument fills in as it parses (a `Bash` row shows the command text until its `description` is complete, never a half description); a `Write` against a base keeps the "+a −b" extra, counting only the aligned part (§6.16.10 `live`). **A guessed key argument** (`keyArgGuess`, state `streaming-guess`; Write content-first spec §4.5): a `Write` whose model writes `content` before `file_path` is drawn against a base the kernel guessed from the files the conversation touched; until the real path parses and confirms it, the key argument is the guessed path after the prefix 「推测：」 / "Guess: " in `muted` (part `key-arg-guess`, in the label's line, no space after the prefix), and the row has no "+a −b" (only the progress's line count), so no number is presented as fact before the path confirms it; a confirmed guess becomes the ordinary row against a base, a rejected one the writing form. The row carries `aria-busy="true"`; neither its label nor its detail is a live region (no `aria-live`, nothing announced per delta). When the logged call arrives the row becomes the running or waiting row in place: the same element, the same expansion. In a group's header a streaming call counts as running (§6.16.8); a single streaming call's tool line draws the mark, the label and " · " the progress, with `aria-busy` (as a running line draws " · " its time). In a process block (§6.16.8a) a streaming call is a live row: its rail step's gutter shows the `spinner`, and it stands in the rail step its logged call takes over (the step's calls, by their first call), so logging it remounts nothing; its step's text moves into the block as narration once the call starts.
- **Opens by itself** (maintainer decision 2026-11-27): a row whose detail is live shows it open without a click: a streaming call with detail (a `Write` / `Edit` live diff, an `Agent` prompt, a command, a generic tool's input parsed so far), the same call while it stays live once logged (pending, waiting for a person, running: the row never folds between its streaming and its logged form, being the same element under the same rules), and a running call whose output grows. Its boxes follow their tail (§6.16.10 tail-follow). When the call ends, a row the person never toggled folds back to collapsed, so a long run stays calm (a decided default); a row the person toggled keeps the person's choice, and a live row the person collapsed stays collapsed. A row opened by itself does not animate (only a person's toggle runs the expand motion, none under reduced motion). The same holds for a single tool line, for the rows inside a group and inside a process block (§6.16.8a). A controlled row (`open` given) follows its owner only.
- **Detail viewport** (part `detail-viewport`, maintainer decision 2026-11-27): every scroll box of a tool's detail — a finished or live diff (§6.16.10), the OUT output (a command's output too), the IN command and the IN key / value grid, an `Agent` prompt — is one viewport at most `layout.tool-detail` (204: about twelve `small` lines) high whose content scrolls. When its content overflows, an **expand control** stands in its top corner (`space.1` from the top and the end, clear of a classic scrollbar): a dense ghost icon button (part `detail-expand`, `maximize-2`, on the `panel` ground with a 1px `line-soft` border so the text under it is hidden) named 「展开」 / "Expand" (accessible name and tooltip), `aria-expanded="false"`, `aria-controls` the box. Pressed, the box grows to the tall cap, 70% of the viewport height (`70dvh`), where it still scrolls, and the control turns into 「收起」 / "Collapse" (`minimize-2`, `aria-expanded="true"`), shown as long as the box is expanded. A box whose content fits shows no control. A live box keeps following its tail in both heights. The deprecated `IoBlock` (trajectory view) draws its text in the same viewport; there is no second fold.
- **Expanded detail**: padding 0 `space.3` `space.3`, gap `space.2`, two labelled blocks, each a label column (`micro` 600 `faint`, "IN" / "OUT" in English, "输入" / "输出" in Chinese, `4ch` wide, gap `space.2`) beside its body:
  - **IN**: the command for a shell row as `$ <command>` (the `$` `faint`, the command `ink`); else the inputs as a key / value grid (columns `max-content` and the rest, gap `space.1` × `space.3`, keys `faint`, values `ink`, breaking anywhere). Omitted when there is no input;
  - **OUT**: the output: `bg` ground, radius `sm`, padding `pad.default`, `small` `ink`, wrapped, in the detail viewport (`layout.tool-detail` high, scrolling, the expand control on overflow); for a failure the full error text; then a footer (`micro` `faint`, gap `space.3`): a command's exit code ("退出码 0" / "exit 0", part `tool-exit`, zero too), the duration ("2.1 秒" / "2.1s") and "复制输出" / "Copy output"; for a large output instead "输出 82 KB，已显示前 4 KB" / "Output 82 KB, showing first 4 KB" and "查看全文" / "View full text", which reads the archive (`GET …/outputs/:outputId`). Omitted while there is no output yet.
  - **Result images** (`detail.images`, part `tool-images`; tool result images design §4): the images a call's result carried, shown to the agent, as thumbnails under the output (and above its footer) in a wrapping row, gap `space.2`; each a `button` of `layout.thumb` × `layout.thumb`, `bg` ground, 1px `line` border, radius `sm`, the image covering it, named by the image's name (accessible name and tooltip); a click opens the image viewer (§6.16.20) on that image, navigable across the group's images. An unsafe source draws the empty thumbnail. Images alone make a row expandable.
  - An edit's expanded form stays its diff (§6.16.10), without labels.
  - **While streaming**: a `Write` or an `Edit` shows the live diff block (§6.16.10 `live`), without labels, and keeps it once the call is logged (pending or running) until the result's diff replaces it; a `text` view (an `Agent` prompt) grows in OUT with the streaming cursor (§2.4) at its end, in the detail viewport and following its tail as the live diff does; a `command` shows IN, the command growing; a generic tool shows IN as the key / value grid of the input parsed so far (a value still being written ends where the text ends); both follow their tail in the viewport too. The detail opens by itself while live (above). Nothing in the detail is a live region.

<!-- states: tool-row -->
States: `default`, `hover`, `focus`, `running`, `failed`, `exit-code`, `expanded-command`, `expanded-connector`, `expanded-failed`, `large-output`, `expanded-images`, `hook-denied`, `waiting`, `linked`, `auto-granted`, `auto-approved`, `review-approved`, `streaming`, `streaming-input`, `streaming-guess`

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
| tool-name | default | color | color.muted |
| key-arg | default | color | color.faint |
| tool-row[data-ref-forced=true] | hover | background-color | color.hover |
| tool-row[data-ref-forced=true] | focus | outline-color | color.accent |
| tool-row[data-ref-forced=true] | focus | outline-width | 1 |
| spinner | running | color | color.accent |
| spinner | running | width | space.4 |
| tool-label | running | color | color.ink |
| error-dot | failed | background-color | color.fail |
| error-dot | failed | width | 6 |
| error-dot | failed | height | 6 |
| exit-code | exit-code | color | color.fail |
| tool-output | expanded-command | background-color | color.bg |
| tool-output | expanded-command | border-radius | radius.sm |
| tool-output | expanded-command | padding-left | pad.default.x |
| tool-output | expanded-command | max-height | layout.tool-detail |
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
| error-dot | expanded-failed | background-color | color.fail |
| tool-output | expanded-failed | background-color | color.bg |
| tool-footer | large-output | color | color.faint |
| error-dot | hook-denied | background-color | color.fail |
| tool-row | waiting | height | row.dense |
| tool-label | waiting | color | color.ink |
| waiting-word | waiting | color | color.accent |
| tool-row | linked | height | row.dense |
| tool-link | linked | color | color.muted |
| tool-link | linked | font-size | type.small |
| tool-row[aria-busy=true] | streaming | height | row.dense |
| tool-row[aria-busy=true] | streaming | column-gap | space.2 |
| stream-mark | streaming | width | space.4 |
| stream-mark | streaming | height | space.4 |
| stream-dot | streaming | width | space.1 |
| stream-dot | streaming | height | space.1 |
| stream-dot | streaming | background-color | color.accent |
| tool-label | streaming | color | color.ink |
| stream-progress | streaming | color | color.faint |
| stream-progress | streaming | font-size | type.small |
| tool-row[aria-busy=true] | streaming-input | height | row.dense |
| stream-dot | streaming-input | background-color | color.accent |
| tool-label | streaming-input | color | color.ink |
| stream-progress | streaming-input | color | color.faint |
| tool-row[aria-busy=true] | streaming-guess | height | row.dense |
| key-arg-guess | streaming-guess | color | color.muted |
| tool-label | streaming-guess | color | color.ink |
| stream-progress | streaming-guess | color | color.faint |

#### 6.16.10 Diff block

- The expanded form of an edit (`Edit`, `Write` over an existing file), inside the tool box, padding `space.1` 0. Each line: gap `space.2`, padding 0 `space.3`, `small` mono, no wrapping; a 4-character right-aligned `faint` gutter with the line number (the new number, the old one for removed lines), a 1-character sign column (+ / − / blank), then the text with an ellipsis.
- Added lines on the `diff-add` ground, removed lines on `diff-del`, both `ink`; context lines keep the box's `muted`. The tint is the only marker besides the sign: no green or red text.
- **Viewport**: the lines stand in the tool detail viewport (§6.16.9 "Detail viewport": at most `layout.tool-detail` high, scrolling, the expand control on overflow), so a long `Write` no longer stands at full height (maintainer decision 2026-11-27); the truncation line and the live footer stay under it, outside the scroll.
- Past `TOOL_VIEW_DIFF_MAX_LINES` the diff ends with a centered `muted` line under a `line-soft` rule: "差异过长，已截断 · 显示前 N / M 行 · 查看全文" / "Diff too long, truncated · showing first N / M lines · View full text", where N is counted from the lines shown and M is the whole diff's line count (without M: "显示前 N 行" / "showing first N lines").
- **Live** (`live`; streaming tool input spec §6.4, §6.5): the lines while the model is still writing the input, display only (the result's diff replaces them). Once the call is logged (pending or running) the block keeps its last live lines and forms (the pending line, the footer, the earlier line) without the caret (`caret={false}`): the row does not jump to its inputs before the result. A call that ends without a diff in its result (a failure, a cancel) shows its inputs and output instead. The block is the detail viewport (§6.16.9: at most `layout.tool-detail` high, scrolling, the expand control on overflow; part `diff`), which a finished diff uses too. The last line receiving text ends with the **caret** (part `diff-caret`): the streaming cursor of §2.4 (an `accent` block `space.2` × `space.4`, the line's height, blinking over `motion.cursor` in steps, steady under reduced motion), on that line only, after the text and never shrunk: an over-wide line takes the ellipsis and the caret stays visible after it. **Tail-follow**: while the viewport is at its bottom, new lines (and a changed pending or earlier line) keep it there; a scroll up by the reader stops following, and scrolling back to the bottom resumes it. The block is never a live region. Its forms:
  - **Against a base** (a `Write` over a file the conversation read unchanged, state `live`): the diff of the text so far against the base, with real line numbers. Base lines past the last aligned line are not removals yet: one **pending line** (part `diff-pending`, `pending > 0`) closes the block, in the lines' rhythm with the gutter and sign blank, no tint, 「后面 N 行待对齐」 / "N more lines not reached yet" in `faint` (N with the locale's grouping). Only the result decides what is removed.
  - **Writing form** (a `Write` without a base: until the base arrives, a new file, or no base; state `live-writing`): the text as context lines numbered from 1, no signs, no tint; under the lines the **footer** (part `diff-foot`: `micro` `faint`, padding 0 `space.3` `space.1`, under the block's own `space.1` bottom padding, outside the scrolling viewport so it stays in view) 「写入预览」 / "Preview".
  - **Edit form** (`gutter="pending"`, a streaming `Edit`; state `live-edit`): `old_string` as removed lines, `new_string` growing as added lines, the gutter blank (its 4ch column kept, so the text does not move when the result brings the numbers); footer 「行号待定」 / "Line numbers after it runs".
  - **Long text** (state `live-cut`): past `TOOL_VIEW_DIFF_MAX_LINES` lines the web keeps the last ones (the live tail: `truncated: true` with `totalLines`), and the block opens with one **earlier line** (part `diff-earlier`, drawn as the pending line): 「前面 N 行」 / "N earlier lines", N = `totalLines` less the lines shown. The result's truncated diff keeps its own form (the first lines and the truncation line, above).
- **Long lines**: any diff, live or not, draws at most `TOOL_VIEW_LINE_MAX_CHARS` (2,000) characters of a line (the kernel's cap for a result's lines; `DIFF_LINE_MAX_CHARS`, cut by `cutDiffLine`, never inside a surrogate pair, which the web's live diffs use too); the rest is cut before it reaches the page, and the line's ellipsis shows it goes on. A live line keeps its caret after the cut.
- **Line identity**: a line is keyed by its kind and number alone, so the live tail moving the first hunk's starts keeps every line's element (and a selection in it).

<!-- states: diff-block -->
States: `default`, `truncated`, `live`, `live-writing`, `live-edit`, `live-cut`

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
| diff | default | max-height | layout.tool-detail |
| diff-cut | truncated | color | color.muted |
| diff-cut | truncated | border-top-color | color.line-soft |
| diff | live | max-height | layout.tool-detail |
| diff-line[data-kind=add] | live | background-color | color.diff-add |
| diff-gutter | live | color | color.faint |
| diff-caret | live | background-color | color.accent |
| diff-caret | live | width | space.2 |
| diff-caret | live | height | space.4 |
| diff-pending | live | padding-left | space.3 |
| diff-pending | live | font-size | type.small |
| diff-pending | live | color | color.faint |
| diff | live-writing | max-height | layout.tool-detail |
| diff-line | live-writing | color | color.muted |
| diff-gutter | live-writing | color | color.faint |
| diff-caret | live-writing | background-color | color.accent |
| diff-foot | live-writing | font-size | type.micro |
| diff-foot | live-writing | color | color.faint |
| diff-foot | live-writing | padding-left | space.3 |
| diff-line[data-kind=del] | live-edit | background-color | color.diff-del |
| diff-line[data-kind=add] | live-edit | background-color | color.diff-add |
| diff-caret | live-edit | background-color | color.accent |
| diff-foot | live-edit | color | color.faint |
| diff | live-cut | max-height | layout.tool-detail |
| diff-earlier | live-cut | font-size | type.small |
| diff-earlier | live-cut | color | color.faint |

#### 6.16.11 Approval block

- **Pending**: a floating card with an `accent` border, gap `space.3`, `role="group"`. Head: an `accent` dot, "需要你批准" / "Approval needed" (600), the tool (`small` `muted`: "<connector>: <title>", or the source and the localized name when the tool has no title) and then **always** the model-visible tool key (`small` `faint`, e.g. `acme_tickets__send_message`; it wraps rather than truncates). The key stays even without a title, because two sources can share a display name. Then **every** input argument as a key / value grid: the tool's `keyArgs` first, in their order, then the other properties in input order; values that are not strings as compact JSON; each value wraps and is capped at 3 lines; under the grid a `small` `muted` link "查看完整输入" / "Show full input" opens the whole input JSON read-only in place ("无参数" / "No arguments" when the input is empty). Then the actions (`default` step, gap `space.2`): "批准" / "Approve" (primary), "本会话内都批准" / "Approve for this conversation", "总是批准" / "Always approve" (default) — each only when the request allows `once` / `session` / `always` — and "拒绝…" / "Deny…" (default); at the right end a `small` `muted` note naming the rule that asked (the agent's tool policy, the connector's policy, a rule that always asks, the org's sandbox setting, the tool's default, or role escalation).
- **Touch** (`MOBILE_SIZE_QUERY`: compact or touch, maintainer decision 2026-11-22; the order follows `useMobileSizes()`): the card's buttons share one row (flex-basis 0, a long label wraps inside its button) at least `touch.primary` (48) high, in the order 拒绝, the wider grants (本会话内都批准, 总是批准), then 批准 (the `accent` primary) last; the touch 拒绝 is the generic word, the variants' own wording (「拒绝…」 and the network / command forms) is the desktop's; a network ask's hints keep their wrapped layout. The command or path is set in the code font role (`font-code`, `cb-hcard-command`).
- **Summary**: a call that carries a kernel-rendered summary (a Platform operation: what it does, in the UI language, from the operation and its params) shows it as one `small` line between the head and the argument grid; the key and every argument stay on screen below it. The summary is a convenience, never a substitute for the arguments.
- **File**: a call that takes a file of the conversation in place of an upload (a Platform operation, platform web parity spec §5) shows the file the person confirms after the argument grid (part `file`): the thumbnail of an image (only a WebP data URL the kernel made, part `file-thumbnail`), the name (part `file-name`, one line with the ellipsis) and "<size> · sha256 <first 12 hex>" in `small` `muted` (part `file-meta`). The inbox's approval detail shows the same row (`ApprovalFileRow`) above the input.
- **Why the key and every argument**: a tool's title (and its `keyArgs`) come from extension or connector code and a connector's title can change without drift review (it is display only). The person approving must see what the model actually calls: the reviewed key and the full input, so a misleading title can at most mislabel a call whose key and arguments are on screen.
- **Deny with a reason**: "拒绝…" swaps the actions for a reason input ("拒绝原因（选填，会告诉模型）" / "Reason (optional, the model sees it)"), "拒绝" / "Deny" (danger), "取消" / "Cancel" (ghost) and the note "原因会写入会话，模型能看到" / "The reason goes into the conversation; the model sees it".
- **Decided**: collapses to a tool line that names the key too: approved — `check` 12, "<who> 批准了 <tool>" and " <key> · <scope> · <time>" in `faint`; denied — `x` 12, "<who> 拒绝了 <tool>", " <key>" in `faint`, " · 「<reason>」" in `muted` and the time in `faint`. A request the person answered with a message reads "批准请求已跳过：<tool>" / "Approval request skipped: <tool>" (network asks only, below).
- **Network ask** (network ask spec §6.5): a command on a device was refused network hosts by the device's own policy, and the device owner is asked. Same accent card, no tool, key or argument grid. Head: the `accent` dot and the title (600): one host "智能体想访问 `files.slack.com`，允许吗？" / "The agent wants to reach `files.slack.com`. Allow?", the host as inline code; n hosts "智能体想访问 n 个域名，允许吗？" / "The agent wants to reach n domains. Allow?". Body: "这条命令被这台设备的网络规则拦下了：<description>" / "This command was blocked by this device's network rules: <description>" (without a description the sentence ends there). The command read-only in code style (the full-input box of a tool approval), clipped to 300 characters with an ellipsis. Then the hosts, one per line: the registrable domain (600; e.g. **evil.io** in `files.slack.com.evil.io`, the last two labels, three under a known multi-label suffix such as `co.uk`, `com.cn`: a display aid, never a security decision) and the full host as inline code; with more than one host each line is a checkbox, all checked, and the decision covers the checked ones (none checked disables both allow buttons, Deny stays). Actions: "这次允许" / "Allow this time" (primary, the first and focused one) with a `small` `muted` hint under it, "到智能体这次回复结束为止有效" / "Until the agent finishes this reply", and "拒绝" / "Deny" (default), which opens the same reason form as a tool approval. A second button, "加入此设备的列表" / "Add to this device's list" (`always`, offered when the page's scopes include it), adds the hosts to the device's network list; under it the `scope-hint` says when it takes effect (`NetworkAsk.appliesAt`: "从下一条命令起生效" / "Applies from the next command", "下次使用这台设备时生效" / "Applies the next time the device is used", "重建文件后生效" / "Applies after the files are rebuilt"). A page offering only `always` shows only that button, as the primary. Decided with `always`: "已加入此设备的列表" / "Added to this device's list". States: `network-always` (both buttons, each with its hint), `network-list-only` (only "加入此设备的列表", the primary, with its hint), `network-added` (the decided `always` line). Host, command and description are model-controlled: always plain text or code, never markup.
- **Network ask decided**: a tool line with `check` 12 (allowed) or `x` 12 and the word: "已允许（这次）" / "Allowed (this time)", "已拒绝" / "Denied", "已过期" / "Expired", "已跳过" / "Skipped" (the person sent a message instead of answering), "已取消" / "Cancelled"; then the hosts it covers (the granted ones when allowed) and who in `faint` (expired and cancelled name no one); a denial's reason and the time as for tool approvals.
- **Command ask** (auto mode spec §5.4, approval profiles design): the command review holds a shell command, or a file read or write outside the scope, until the person allows it. Same accent card, no argument grid. Head: the `accent` dot, the question (600: "智能体想运行这条命令，允许吗？" / "The agent wants to run this command. Allow?", or the read / write question), the tool and its key as for a tool approval. Then the lead (`small`, `command-reason`: what is asked, worded by the page from the ask's facts), the review's own reason under it in `faint` when it adds what the lead cannot, and the command read-only in code style (unframed, clipped to 300 characters; a read or write shows its path under the title "路径" / "Path"). Actions: "允许一次" / "Allow once" (primary), "本会话允许同类" / "Allow this kind for this conversation" when offered, "拒绝" / "Deny" (the same reason form).
- **Secure input** (`ApprovalBlockProps.secureInput`; profiles-govern-every-approval design): a request for secret values only the person can enter, asked under every profile and never part of a tool approval. Same accent card, no tool, key, argument grid or scope buttons. Head: the `accent` dot and "输入密钥：<target>" / "Secure input: <target>" (600; the target is what the values are saved to, e.g. "Anthropic: deployment config"). Body: a `small` `muted` note "值直接保存，智能体看不到。" / "The values are saved directly; the agent never sees them." and one masked field per secret (`PersonFieldRow`: label, optional description, never prefilled, no reveal toggle, an error under the field). Actions: "提交" / "Submit" (primary; disabled while any field is empty, while busy or when the page says so) and "取消" / "Cancel" (default). Decided: a tool line with `check` 12 and "已提交" / "Submitted", or `x` 12 and "已取消" / "Cancelled", then the target and the time in `faint`; an expired request reads as an expired approval. The card never shows the values once decided.
- **Details inside the card** (maintainer decision 2026-11-21; any pending approval but a network ask may carry them, all optional, all plain text the page passes, nothing boxed inside the card): **reason**: the requester's own words as the card's leading statement, right under the head: a `small` `muted` attribution ("智能体的理由" / "Agent's reason") over the words in the prose font (`prose`), quoted by a 2px `line-strong` rule on the left, wrapping, never clipped, never a link. **Facts**: a compact list above the input (the command, or the argument grid): one row per fact, its label `small` `faint`, its values `small` mono `ink`, one per line, wrapping, never clipped or summarized (a permission crossing's read-write directories, read-only directories, hosts and target file). **Working root**: one `small` `muted` line right above the command, "在 <path> 运行" / "Runs in <path>", the path mono and middle-truncated past 64 characters with the full path as its title. **Hints**: the consequence of approving is a short `small` `muted` `scope-hint` line under the whole action row, never under its button, so the buttons stay adjacent with the normal gap (the page's `scopeHints`, e.g. "仅这一次调用；下次仍在沙箱内运行" / "This call only; the next one runs in the sandbox again"; with more than one hinted scope each line starts with its button's label and " · "); further notes (a background process that keeps running) are `small` `muted` lines under it (`card-hint`). Hints and notes hide while the deny form is open. (The network ask keeps its one hint under "这次允许", above.) The details belong to the pending card only: decided or superseded, the card is its one line, with an optional short phrase of what was crossed after the word ("已允许（一次） Bash · 在沙箱外运行 · <who> · <time>"); the conversation log keeps the rest.
- **Command ask decided**: a tool line with `check` 12 (allowed) or `x` 12 and the word: "已允许（一次）" / "Allowed (once)", "已允许（本会话同类）" / "Allowed (this kind for this conversation)", "已拒绝" / "Denied", "已过期" / "Expired", "已取消" / "Cancelled"; then in `faint` the key, the crossing phrase when given and who (expired and cancelled name no one); a denial's reason in `muted` and the time in `faint`.

- **Decider as a person**: `who` is `string | { name, avatarUrl }`. A string stays plain text ("你", "系统"); a person is a `PersonName` (§6.50) at size 16 in the same place, inline in the line ("<PersonName> 批准了 <tool>", and the same for the denied, network and command lines, where it stands after the key joined by " · "). It keeps its own `ink`; the line's `muted` stays on the words around it.

<!-- states: approval-block -->
States: `pending`, `pending-once`, `pending-summary`, `deny-reason`, `approved`, `denied`, `network`, `network-hosts`, `network-once`, `network-always`, `network-list-only`, `network-added`, `network-allowed`, `network-denied`, `network-skipped`, `command-escalation`, `command-scope`, `command-allowed`, `secure-input`, `secure-input-submitted`, `secure-input-cancelled`

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
| tool-line | secure-input-submitted | height | row.dense |
| tool-line | denied | color | color.muted |
| tool-key | denied | color | color.faint |
| approval-block | network | border-top-color | color.accent |
| button[data-variant=primary] | network | height | control.default |
| scope-hint | network | font-size | type.small |
| scope-hint | network | color | color.muted |
| button[data-variant=primary] | network-always | height | control.default |
| scope-hint | network-always | font-size | type.small |
| scope-hint | network-always | color | color.muted |
| button[data-variant=primary] | network-list-only | height | control.default |
| scope-hint | network-list-only | color | color.muted |
| tool-line | network-added | height | row.dense |
| tool-key | network-added | color | color.faint |
| tool-line | network-allowed | height | row.dense |
| tool-key | network-allowed | color | color.faint |
| tool-line | network-skipped | color | color.muted |
| approval-block | command-escalation | border-top-color | color.accent |
| reason-label | command-escalation | font-size | type.small |
| reason-label | command-escalation | color | color.muted |
| reason-text | command-escalation | font-size | type.prose |
| reason-text | command-escalation | color | color.ink |
| reason | command-escalation | border-left-color | color.line-strong |
| reason | command-escalation | padding-left | space.3 |
| working-root | command-escalation | font-size | type.small |
| working-root | command-escalation | color | color.muted |
| scope-hint | command-escalation | font-size | type.small |
| scope-hint | command-escalation | color | color.muted |
| card-hint | command-escalation | font-size | type.small |
| card-hint | command-escalation | color | color.muted |
| fact-label | command-scope | font-size | type.small |
| fact-label | command-scope | color | color.faint |
| fact-value | command-scope | font-size | type.small |
| fact-value | command-scope | color | color.ink |
| button[data-variant=primary] | command-scope | height | control.default |
| tool-line | command-allowed | height | row.dense |
| tool-line | command-allowed | color | color.muted |
| tool-key | command-allowed | color | color.faint |

#### 6.16.11a Network facts

- What a command on a device was refused that no card in the conversation can lift (network ask spec §6.5), under the group that holds the command, from the display-only `network_blocked` event: hosts outside the org's network allowlist (`org` layer) and private or local addresses (`address` layer). Device-layer hosts are the network ask's, never listed here. One `info` Callout per layer, one sentence per host, the host as inline code: "`api.foo.com` 不在组织的网络白名单里，只有组织管理员能添加。" / "`api.foo.com` is not in the organization's network allowlist; only an org admin can add it."; "`10.0.0.5`：这个地址指向内网或本机，智能体的命令不能访问。" / "`10.0.0.5`: This address points to a private network or this machine; agent commands cannot reach it.". Text only for now; the org-layer Callout takes one action (a request to the org admins, a later phase).

<!-- states: network-facts -->
States: `org`, `address`

<!-- size-table: network-facts -->
| Part | State | Property | Value |
|---|---|---|---|
| callout | org | background-color | color.panel |
| network-fact | org | color | color.muted |
| callout | address | background-color | color.panel |
| network-fact | address | color | color.muted |

#### 6.16.12 Question block

- `AskUserQuestion` and connector elicitation. **Pending**: a floating card (`line` border, not accent), gap `space.3`, `role="group"` named by the question. The question in the prose font (`prose`, 600). Options as rows (`row.default` minimum height, padding `pad.default`, 1px `line` border, radius `sm`; a 12 round radio, `line-strong`, `accent` when checked; the checked row has an `ink` border); multi-select options use checkboxes; with `allowOther` a last row "其他：" / "Other:" holds a free-text input. Actions: "回答" / "Answer" (primary), "跳过" / "Skip" (default).
- **URL mode** (the form has a `url`): the full address as a link (`small` `ink`, underlined in `line-strong`, breaking anywhere, `external-link` 14 `muted` before it), "打开链接" / "Open link" (primary, with the icon), Skip, and the note "完成后回到这里继续" / "Come back here when you're done".
- **Buttons** (state `confirm`; the form's `choices`, plugin-sdk `InputForm`): one mechanism for every question answered by pressing a button. When the form's only field is required and a single choice (`boolean`, or `enum` without Other) and carries `choices`, the field draws no control: the actions are one button per choice in their order, the first primary and the rest default, and a press answers at once (no 回答). A confirm form is `{ done: boolean }` with 完成 / 取消; a one-value wait (long waits spec §5.5, 结束等待) is a one-choice `enum`. An optional **body** (`InputForm.body`) sits under the short title as the requester's quote (`hitl` reason style: `line-strong` left rule, prose). An optional **action** (a `ghost` button with its icon after the choices, e.g. 打开浏览器 for a question that names a panel) does not answer.
- **Answered**: collapses to the question as a tool line and a second one with `corner-down-right` 12, the answer in `ink` and " · <who>" in `faint`. The other closed states use the same two lines with their word in place of the answer: **skipped** (the run's starter sent a message instead of answering) says "已跳过：直接回复了消息" / "Skipped: replied with a message" with " · <who>"; **cancelled** (the run ended first) says "已取消" / "Cancelled"; **expired** says "已过期" / "Expired". Cancelled and expired name no one.

- **Answerer as a person** (state `person`): the `who` of an answered or skipped question is `string | { name, avatarUrl }` as in §6.16.11: the " · " stays `faint` and the person is a `PersonName` at size 16 after it.

<!-- states: question-block -->
States: `pending`, `url`, `confirm`, `answered`, `person`, `skipped`, `cancelled`, `expired`

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
| tool-line | person | height | row.dense |
| tool-line person-name[data-size=16] avatar[data-size=16] | person | width | 16 |
| tool-line person-name[data-size=16] avatar[data-size=16] | person | height | 16 |
| tool-line person-name[data-size=16] avatar[data-shape=circle] | person | border-top-left-radius | 50% |
| tool-line | skipped | color | color.muted |
| tool-line | cancelled | color | color.muted |

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

- Sub-agents group like tools (phase C runtime; durations "41 秒", "1 分 12 秒" / "41s", "1m 12s", `formatDuration`, §7). **Running**: a header tool line with a `spinner` (16) and "正在运行 N 个子智能体" / "N subagents running", then one Agent call block per sub-agent, `space.2` apart. **Waiting**: when every active sub-agent waits for a person, the header has no `spinner` and says what the first one waits for in `accent` ("等待批准" / "Waiting for approval"), with " · 已完成 N 个" / " · N done" in `faint` as when running (§6.16.9). **Done**: a collapsed header "N 个子智能体已完成（M 个失败）· 共 X 次调用 · <duration>" / "N subagents done (M failed) · X calls · <duration>" with the failure count in `fail` and the totals in `faint`; sub-agents that reached a limit add "（K 个已达上限）" / " (K reached a limit)" in `warn` after it (**Limit** state); opening it shows the blocks. With `onOpenMap` the header ends with the link button "智能体图" / "Agent map" (`tool-link` style, part `subagent-map-link`; agent map spec §9.2) in every state; a done header then is a toggle beside the link, never nesting it (§6.16.9).
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

- An extension card in the stream (slot `conversation.tool-result.card`), hanging off the tool result that named it (`ToolResult.card`); stage B2's MCP Apps widgets use the same frame.
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
- A section: `panel` ground, no border, radius `md`, padding `space.3`, gap `space.1`; a head with the title in `muted` and a value at the right, `space.1` above the body. A section may carry a **hint** (`PropertySection.hint`, a note about the section such as Background tasks' starting-grant sentence): an `info` 12 button in `faint` (`property-hint`, `ink` on hover and while open) `space.1` after the title, named "关于「<title>」" / "About <title>" and described by the text; its Tooltip (max 320 wide, wrapping) opens on hover or focus and a press toggles it (a touch screen neither hovers nor focuses first); the button's hit area reaches `space.2` past the icon without growing the head. No muted paragraph in the body says the same.
- Built-in sections, in order: **Context** (the usage ratio as the value; a meter `space.1` high, `line` track, `ink` fill, radius `sm`; then labeled rows in `small` (`context-facts`, maintainer decision 2026-11-23): the labels in `muted` in a column as wide as the widest label, the values in `ink` `space.3` after it, the rows `space.1` apart: 模型 / Model; 设备 / Device "<name> · <state>" with the device's mark (`ContextSection.deviceBadge`) as a Badge on its own line under it; 连接器 / Connectors (the connectors used, when any); 轮次 / Turns "第 N 轮 · 已用 <elapsed>" / "Turn N · <elapsed>" (`context-rounds`, maintainer decision 2026-11-28, the elapsed is the run's working time, ticking only while the run works; shown once a round has run; `ContextSection.rounds`) before the last run; 上次运行 / Last run "<duration> · <tokens>" (`context-last-run`, once a run ended; the run's model leads only when it differs from the Model row; cost joins it only when the log carries one); and once the conversation has sub-agents, 合计 / Total with its tokens including theirs, worded by the page (`context-total`). A value breaks between words only (`word-break: keep-all`: never 「已暂/停」; a word longer than the line still breaks)); extension sections (slot `conversation.properties.section`, rendered `dense`; each sits after its `after` anchor `context` (default), `files` or `background`, and in the org's arrangement order within it); **Files** (the count as the value, the conversation's own files and its sub-agents' deliveries; rows `row.dense`: type badge, name with an ellipsis, for a sub-agent's file "来自 <sub-agent>" / "from <sub-agent>" in `faint` (at most 40% of the row, with an ellipsis), size in `muted`; then "全部 N 个文件" / "All N files" with `chevron-right` 12 in `muted`); **Background tasks** (sub-agents and background Bash tasks, running ones only; rows `row.dense`: `spinner`, name, duration `muted` (a sub-agent waiting for a person: no `spinner`, and what it waits for in `accent` instead of the duration), a dense stop icon button `square` 12 named "停止「<name>」" / "Stop <name>"; a task whose stop is under way keeps its `spinner` and shows "正在停止…" / "Stopping…" in `muted` instead of the button; a sub-agent's own tasks are nested under it, indented `space.4` (a task with a parent is nested whatever the parent's status); then "已完成 N 项" / "N completed" with a chevron, counting finished tasks and sub-agents together and opening their list in the right panel). The section shows running items only: finished tasks and sub-agents are not rows, they are counted in "N completed". **The finished list** (`BackgroundFinishedList`, the body of the right panel "已完成的后台任务" / "Finished background tasks" that "N completed" opens, §6.16.18): the finished tasks and sub-agents (a sub-agent's own tasks as rows of their own, not indented), newest finished first, as `BackgroundTaskRow`s in their finished states `space.1` apart, each ending with when it finished (`DateTime` compact, `faint`, `task-time`); a row's name opens its task's output (whose header then has back, returning to the list) or its sub-agent; with none, the panel `EmptyState` "没有已完成的后台任务" / "No finished background tasks". `BackgroundTaskRow`'s finished states: no `spinner`, ending with the status word: "已完成" / "Done", "已停止" / "Stopped" and "已丢失" / "Lost" in `muted` (success is not colored), "失败" / "Failed" and "已超时" / "Timed out" in `fail`; a sub-agent that reached a limit "已达上限" / "Limit reached" in `warn`.
- **Task output** (`TaskOutputPanel`, the body of the right panel for a task, §6.16.18): a head line with the status word (`muted`, `fail` when failed or timed out), the elapsed time in `faint` and, while running, a dense stop icon button at the right (once a stop is under way, the task view's `stopping` or the page's own stop in flight, "正在停止…" / "Stopping…" in `muted` with `role="status"` instead of the button); the command in the design's monospace (`font.mono`, which the size table cannot express: it holds numbers and colors only) in `ink`; when the output cannot be read now, a note in `muted` (`small`) saying why, naming where the task ran: "设备" / "device" for a local device, "沙箱" / "sandbox" for a cloud one, never the sandbox for a device: the task is starting ("任务正在启动，还没有输出。"), did not start ("任务没有启动。", with the launch's reason under it in the design's monospace, `faint`, and no output line), the device is offline ("设备离线，读不到完整输出。"), the {env} is suspended ("{env}已暂停，读不到完整输出。"), was rebuilt ("{env}已重建，输出没有保留。"), the output file is gone ("{env}上的输出文件已不在。"), the conversation can no longer use it, the {env} is unavailable, or the read failed; when the finish event's last lines follow, the note ends "下面是任务结束时保留的最后几行。" / "Below are the last lines kept when it finished."; the last lines in a `CodeBlock` (§6.8), or, when there are none, "没有输出" / "No output" in `muted` (`small`, `task-output-empty`) instead of an empty block. The elements sit `space.2` apart.
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

The `unavailable` state covers every reason (the note's words change, not its look); a task without
output lines draws `task-output-empty` (`muted`) in the `CodeBlock`'s place.

<!-- size-table: task-output-panel -->
| Part | State | Property | Value |
|---|---|---|---|
| task-command | running | color | color.ink |
| icon-button | running | width | control.dense |
| task-output-status | finished | color | color.muted |
| task-output-note | unavailable | color | color.muted |
| task-output-stopping | stopping | color | color.muted |

#### 6.16.18 Right panel

- One extension panel (slot `conversation.panel`; the deprecated `place: "panel"` / `"conversation"` still map to it), a file preview or a sub-agent conversation, one at a time; opening it closes the properties panel or the previous panel. Full height, `panel-2` ground, a `line-soft` left divider.
- **Width**: default `layout.panel`, at least `layout.panel-min`, at most the content width minus `layout.chat-min` (so wide screens may go past 600, and at a 1280 window with the full sidebar it is 544). Resizable by a handle on its left edge (§6.11); the width is a per-viewer preference in `localStorage["cap.chat.panelWidth"]` (read and written in try/catch, clamped on read). Below a 1280 window the right area is a Sheet (§5.4).
- **Header**: `layout.title-bar` high, padding 0 `space.2` 0 `space.4`, a `line-soft` bottom line, gap `space.1`: back (`chevron-left`, optional), the type badge (files), the title as a ghost button with `chevron-down` 14 that opens the switcher (a Menu: extension panels, a separator, the conversation's files, each group under a `micro` label; the open item has the `selected` ground and no check; the title keeps the `hover` ground while it is open), or plain text when there is nothing to switch to (a sub-agent); meta in `small` `faint` ("v2 · 10-26 14:20", "2 / 5", a `spinner` and the duration); actions; full screen (`maximize-2`, "全屏" / "Full screen"); close (`x`).
- **Full screen** maximises the panel inside the page, never the browser's full screen (`ConversationPage` `rightFull`): the panel takes the conversation's content area under its title bar, in place of the thread and the composer (and the properties panel), in either layout (no Sheet below 1280); the app sidebar and the title bar stay. Its button then reads "退出全屏" / "Exit full screen" (`minimize-2`) and restores the panel at its previous width, as does Esc (unless a menu or dialog in the panel takes it first). It is page state: closing the panel or leaving the conversation ends it. Beside the thread the panel stays mounted across the switch (one panel slot element, laid over the content area while maximised; an embed's iframe is never reloaded by it); from a narrow window's Sheet it mounts again. The panel reads the mode it is drawn in with `useRightFull()`.
- **Body**: padding `space.4` (flush for tables), scrolls on its own. A failing extension panel shows the load-failure line in its body.
- **Sub-agent panel**: header back (returns to what the right area showed before, e.g. the properties panel it was opened from; otherwise closes), description, spinner and duration, "停止" / "Stop" (default), full screen, close; body padding `space.4` `space.5`: the task as a block (`selected` ground, radius `md`, padding `space.3`, `prose-small`; label "提示词 · 上级智能体派出" / "Prompt · from the parent agent" in `micro` `muted`: the prompt the parent gave it, never called 任务, which names background tasks), a tool line naming its agent (an org agent's name is a link to that agent, styled as a link button), model and tool scope, then its tool groups and prose like the main thread; no composer and no read-only copy (the missing composer says it); the context use in the panel head's meta ("<duration> · 上下文 N%", maintainer decision 2026-11-28).

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
- **Image**: shown inline, `layout.inline-image` wide at its own aspect ratio, `panel` ground, radius `md` (bitmaps through the `?inline=1` rule; SVG never renders inline). Before the bitmap loads the frame keeps the producing call's ratio when known (`ratio`), else 16:9. Hover shows enlarge (`zoom-in`) and download (`download`) dense icon buttons (`raised` ground, 1px `line` border) `space.2` from the top right. Below it a caption tool line: the name in `ink`, then " · <width>×<height> · <size>" in `faint`.
- **Generating image** (`ImagePlaceholder`, `image-placeholder`): shown in place of each image a running `GenerateImage` call will deliver, so the image later replaces it at the same position and size. The frame is the Image frame: `layout.inline-image` wide, `max-width: 100%`, radius `md`, `panel` ground, clipped, `aspect-ratio` from the call's ratio (`1:1`, `4:3`, `3:4`, `3:2`, `2:3`, `16:9` or `9:16`; 1:1 when unknown). It holds an oversized layer with three soft radial colour fields, `accent` at about 35 %, `accent-hover` at about 25 % and `ink` at about 8 %, each mixed into `panel` (`color-mix(in oklab, …)`) and fading to transparent, that drifts once per `motion.flow` (transform only; reduced motion leaves it still at its rest pose). Centred on top, an `image` icon (16, `faint`). Below it the same caption tool line as the Image: "正在生成图片" / "Generating image", "正在生成图片 2/3" / "Generating image 2/3" when the call asks for several, then in `faint` " · 16:9" when the ratio is known. ARIA: the frame is `role="img"` with `aria-busy="true"` and `aria-label` the caption text; no live region. Theme plugins restyle it through `data-cap-part="image-placeholder"`.
- **Image viewer** (`ImageViewer`, `image-viewer`; what a bubble's image thumbnail and the right panel's image open): a full-screen overlay (portal over the page, the dialog primitive's focus trap, Esc and focus return) on the `lightbox` ground. The image starts fit to the viewport (inset `space.8` + `space.4` top and bottom, `space.4` at the sides for the bars), never upscaled; it zooms 10 % to 800 % by wheel (around the pointer), pinch and the bottom toolbar (`zoom-out`, the percent in mono, `zoom-in`, `1:1`, `maximize-2` for fit), pans by dragging once it exceeds the viewport, and a double click toggles fit and 100 %. The top bar (a `raised` strip, `line` border, radius `md`) holds the name, the size and "n / total" (several images only) at the left, and 在新标签打开 (`external-link`), 下载 and 关闭 at the right; with several images side buttons and ← / → switch (reset to fit; disabled at the ends). Esc, 关闭 and a click on the backdrop (not on the image or a drag's end) close it. A failed image shows `LoadFailed` (with Retry when the caller can reload) in a `raised` card; only `isSafeAttachmentHref` sources load. Reduced motion draws it without the fade. It replaces the `Dialog`-based `ImageZoom`.
- **Text** (md, txt, csv …): a floating card without padding: a head (padding `pad.default`, `small`, a `line-soft` bottom line: type badge, name, size `muted`, "打开" / "Open" link button with a chevron) and the first lines as plain text (`small` `muted`, wrapped, 6 lines high, padding `space.2` `space.3`, fading out at the bottom). Never rendered as HTML.

<!-- states: file-outputs -->
States: `two`, `more`, `image`, `image-hover`, `text`, `generating`, `generating-several`, `generating-wide`

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
| image-placeholder | generating | width | layout.inline-image |
| image-placeholder | generating | border-radius | radius.md |
| image-placeholder | generating | background-color | color.panel |
| tool-line | generating | font-size | type.small |

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

- The right panel showing a file (§6.16.18): header type badge, the name with the file switcher, "v<n> · <updated>" in `faint`, share, download, full screen, close. **Share** (`share` 16, "分享" / "Share"; file sharing design §5) is an icon button right before Download, shown only when the caller passes `onShare` (the conversation's owner, a file that is not removed); it opens the share dialog. A file with a live share carries a **shared marker** on that button: a `space.2` round dot in `ok` at its top right, ringed by the `panel-2` ground, and the button's name becomes "已分享" / "Shared" (the dialog behind it lists the file's shares). Never the accent (§2.3). The conversation's files are what the agent delivered and what people sent with messages; a sent file is marked "上传" / "Uploaded" in the switchers and the Files section.
- The body is the previewer that handles the file. Built in: **HTML** (the HTML document frame, §6.43, wins over extension previewers; a Rendered / Source switch, Source being the text previewer); **image** (bitmaps on the `panel` ground, radius `md`, `space.4` margin, scaled to fit; never SVG); **text and source code** (mono `small` `ink`, wrapped, never executed); **Markdown** (§6.16.4, no raw HTML); **CSV / TSV** (a flush table: `small`, header cells `row.dense` `muted` 400, body cells `row.dense` with a `line-soft` top line, padding 0 `space.3`, no wrapping, numbers right-aligned; at most 500 rows, then "显示前 N 行 · 共 M 行" / "Showing the first N of M rows" in `small` `muted`). Spreadsheet previewers may show sheet tabs (`small`, gap `space.4`, the current tab `ink` with a 2px `accent` underline). Extension previewers (`file-preview@1`) come first when one accepts the file; the header lets the person switch when more than one applies.
- **No preview**: a centered floating card (at most 400 wide): type badge, name over "<size> · 没有可用的预览" / "<size> · No preview available", and "下载" / "Download" (default, `download`). **Failed**: the load-failure line, then the same card as the fallback.

<!-- states: file-preview -->
States: `image`, `text`, `markdown`, `csv`, `none`, `failed`, `unshared`, `shared`

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
| icon-button[data-share=true] | unshared | width | control.default |
| share-marker | shared | width | space.2 |
| share-marker | shared | height | space.2 |
| share-marker | shared | background-color | color.ok |

#### 6.16.23 Run row

`RunRow({ status, parts, statusText?: ReactNode, defaultOpen?, error?, facts?, onRetry?, retryLabel?, links? })` closes every run that ended (§5.4): what ran, how long, what it cost, and how it ended, without colour unless it failed. A manual compact run (`run_started.trigger: "compact"`) draws none (maintainer decision 2026-11-28): it runs no model step, and its outcome is its one divider (§6.16.7).

- **Line**: a tool line (§6.16, `row.dense` high, mono `small` `muted`, gap `space.2`): "运行" / "Run" and the `parts` the page fills (the model, the duration such as "3.7 秒" / `3.7s` (`formatDuration`, §7), the tokens such as `1,234 tokens`; unknown ones are left out) joined by " · " with an ellipsis, then the **status**: the mark (12) and the status word, `space.1` apart: `ok` a `check` in `ok` and "完成" / "Done" in `muted` (the one coloured mark of a quiet row, an exception to §2.4's uncoloured success: a run is a unit a person checks for its outcome); `failed` a `circle-x` and "失败" / "Failed" (or the page's words such as "失败 · 已重试") both in `fail`; `stopped` a `ban` and the page's words "已停止 · <who> <time>" in `muted`. Then a `chevron-right` / `chevron-down` 12 when there is a detail. The duration is the run's working time: from its start to its end without the time it waited for a person (an approval or a question, until answered), the same derivation as the Rounds row's "已用" (§6.16.17), so the two agree.
- **Status text as a node** (state `stopped-person`): `statusText` is a `ReactNode`, so the words after the mark may hold a person: a `PersonName` (§6.50) at size 16 inside them ("已停止 · <PersonName> 14:03"; the viewer is drawn the same way, "你" with their avatar); a string is drawn as before ("已停止 · 系统 14:03"). The mark and the gap are unchanged; the person keeps its own `ink`, the words around it stay `muted`.
- **Disclosure**: with a detail the line is a `button` with `aria-expanded` and `aria-controls`; the detail is a `region` named "运行详情" / "Run details". A failed row starts open (`defaultOpen` overrides), the others closed. Without any detail the line is plain text.
- **Detail**: `space.1` below the line, `space.2` between its parts, under a 1px `line` guide on the left, indented `space.3` (the thinking body's guide): the failure as an `ErrorDetail` (§6.24: the localized sentence, the raw text behind its toggle); `facts`, plain mono `small` `muted` lines (the token split, the start time); then the actions, a row `space.2` apart of `dense` buttons: Retry ("重试" / "Retry", default) and the `links` as `LinkButton`s (default): "查看轨迹" / "View trajectory", "去配置模型服务" / "Configure model services". The page decides which actions a role gets; the row never draws one the reader cannot use.

<!-- states: run-row -->
States: `ok`, `ok-open`, `failed`, `stopped`, `stopped-person`, `warning`

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
| run-status | warning | color | color.warn |
| run-mark | warning | color | color.warn |
| run-detail | warning | padding-left | space.3 |

A bound project whose context did not load uses the same disclosure with `warning`: the circle-alert
mark and status use `warn`; its detail is neutral, expanded at first, with the directory, reason,
and a last-run snapshot hint. View device links to the bound device. Start a free conversation opens
a new conversation with the same agent; it never clears or disguises the original binding. The
composer retains the bound name with a warning action that reopens the same disclosure. Controlled
`open` / `onOpenChange`, `detailsLabel`, and neutral children support this shared presentation.
Project paths wrap even within long directory names. Opening details from the composer scrolls
after expansion layout settles, so the conversation's follow-bottom behavior cannot hide them again.


#### 6.16.24 Working line

`WorkingLine({ still? })` fills the silence from a person's send until the run's first output
(conversation send spec `docs/superpowers/specs/2026-11-04-conversation-send-design.md` §2.2).

- **Where** (maintainer decision 2026-11-27): the conversation page draws it as the process
  block's **planning row** (`RailPlanning`, part `rail-planning`, §6.16.8a), the rail's last row,
  never as a line of its own under the thread (the page jumped as it came and went);
  `ConversationPage`'s `working` slot remains for other hosts.
- **When** (the page decides, from the log and its pending messages): from a send (the pending bubble) or
  a run start until the run's first output (a thinking row, prose, a tool, a sub-agent, an
  approval, a question, a connect block, or the run row when the run ends without output); again
  after a tool result while the model has not answered. Exactly one per conversation.
- **Line**: a tool line (`row.dense`, mono `small` `muted`, gap `space.2`), no timer (the thinking
  row keeps its seconds).
- **Mark**: the pixel capybara of §3 at pixel unit 2 (28 × 20, the sidebar logo's size), `accent`,
  `crispEdges`, in a `control.default` × `space.5` (28 × 20) box; the line stays `row.dense` high
  (the planning row draws it at pixel unit 1, 14 × 10, §6.16.8a). It walks: two frames swap the legs (rows 9–10 of the bitmap; frame 2 moves
  each pair one pixel inward) every 400ms.
- **Themed mark** (`branded`: the theme gives a `markUrl`): an `img` 20 px high (`space.5`) in place of the bitmap, width following the file, at most 3 × the height (60), `object-fit: contain`, in the same line (still `row.dense`, `gap space.2`); it carries `data-part="working-mark"` itself (the part sits on the img in this state), `alt=""` inside the `aria-hidden` line, and the cap is 3 × `space.5` (60); it does not walk: it pulses in opacity with the leg frames' period (`data-motion="pulse"`, a subtle change between full and 60 %), static under reduced motion and when `still`. A failed load falls back to the pixel capybara. Captions rotate unchanged.
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
States: `default`, `reduced-motion`, `branded`

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
| working-line | branded | height | row.dense |
| working-mark | branded | height | space.5 |
| working-mark | branded | max-width | 60 |

#### 6.16.25 Greeting

`Greeting({ text?, sub?, still? })` opens a new conversation (agent profile design §4.1, U10).

- **Line**: the pixel capybara of §3 at pixel unit 2 (28 × 20, the working line's mark, §6.16.24),
  `accent`, `crispEdges`, in a `control.default` × `space.5` box, then `space.3`, then the line:
  `h1` size and line height, 600, `ink`, one line with an ellipsis; a heading (`h2` element).
- **Themed mark** (`branded`: the theme gives a `markUrl`): an `img` 20 px high (`space.5`), width following the file up to 3 × the height (60), instead of the bitmap, then `space.3` and the line; a failed load falls back to the bitmap. The `img` carries `data-part="greeting-mark"` itself (the part sits on the img in this state; the cap is 3 × `space.5`, 60), `aria-hidden`, `alt` empty.
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
States: `default`, `placeholder`, `branded`

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
| greeting-mark | branded | height | space.5 |
| greeting-mark | branded | max-width | 60 |
| greeting-line | branded | column-gap | space.3 |

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
1082 + the gutter at three columns, 1097 with Chromium's 15 px classic scrollbars, 1082 with
overlay scrollbars), at least the width of levels 2 and 3 (the
head and legend fit, going back and forth does not jump narrower) and at most 1100 (and the window
less 32); a wider tree (four columns) scrolls sideways inside the canvas. Levels 2 and 3 have fixed heights, 600 and 640 (at most
the window less 32), so the dialog does not jump while an agent works (the §6.7 frame: `panel`,
`line-strong`, radius `md`, `shadow-2`, `scrim`). The frame has no padding at any level: the head,
body and footer pad themselves in the compact dialog rhythm of §6.7, tightened for the map so a
tree of twenty agents reads at a glance (maintainer request 2026-11-19: compact and refined): head
`space.2` `space.4` with 1px `line-soft` below, body `space.3` `space.4`, footer `space.2`
`space.4`; level 3's thread keeps `space.4` on each side, so it fills the dialog. Level 1's head is
the title "智能体图" / "Agent map" (`h2`, prose, 500) and close, over a body padded `space.3`
`space.4` (`agent-map-content`) that holds the tree, or, while the page reads it, the page's loading bars
(`SkeletonBars`, state `loading`) or its error line (state `failed`); levels 2 and 3 draw their own
head with the same parts (one shared head: back, status dot, title, close, then meta lines).
Levels 1 and 2 are a dialog box (§1: what they hold draws its unboxed form); level 3's thread is a
pane, like `RightPanel`, so it renders exactly as in the main chat. Esc closes the tree and goes back one level
from levels 2 and 3 (`onBack`); focus is trapped and returned, and when the view changes (another
level or agent, `view`) it moves to the new head's back button, else its title.
`AgentMapTree({ root, background, selectedId, onOpen })` is level 1:

- **Count line** at the top of the body (prose `small`, `muted`, `space.2` above the tree): "N 个智能体 · M 个运行中 · 点击查看详情" /
  "N agents · M running · Click a node for details" ("1 agent"); N counts the sub-agents, every
  node but the root (the conversation itself), M the running ones among them: the same number
  as the composer's agents chip (§6.16.29; AC3 ruling 4, 2026-11-07).
- **Tree**: a dense tree, not stacked cards: columns left to right by depth, `space.5` apart; a
  parent sits level with its first child (top-anchored, so a long column of children never pushes
  it away from them when scrolled); standard elbow connectors (1px `line-strong`) meet every node
  at its vertical centre (half of `row.roomy` below its top: from the parent a `space.2` stub
  straight across to the first child, the vertical line down to the last child's centre, a
  `space.3` stub into each child); siblings `space.2` apart, newest first (the agent dispatched last on top; the
  page passes them in dispatch order, as the kernel's tree gives them). No "main agent" or "level N" labels: position and lines
  show the hierarchy. Four columns (three levels below the root) are wider than the dialog: the
  tree scrolls inside it.
- **Node**: a compact card-button 336 wide and `row.roomy` (44) high, the same for the root and
  every sub-agent (padding 0 `space.2`, 1px `line` border on `raised`, radius `sm`; hover the
  `hover` ground); line 1 the status dot and the description (`body`, 500, `ink`); line 2
  exactly "model · time · tokens" (`small`, `muted`, "opus 5.5 · 42分18秒 · 392.7k tokens"; the
  model is its display name alone, no provider prefix: the map is about the agents, and the
  prefix would push the model name into an ellipsis), indented past the dot. Both lines are one
  line; the description ends with an ellipsis, and on line 2 only the model gives way (its own
  ellipsis) while " · time · tokens" always stays whole. The node's tooltip is the full text.
  The root (the conversation itself) has no hover and is not a button: it has no summary to open
  and is never selected.
  The node open at level 2 has the `selected` ground and an `accent` border
  (`aria-current="true"`). Activating a node opens it
  (`onOpen`).
- **Status is only the dot** (8, round, `role="img"` with the status word as its label): running
  `accent`, pulsing every `motion.pulse` (still under reduced motion); waiting `warn`; completed
  `ok`; limit reached `warn` ("已达上限" / "Limit reached": the run ended on its step or time limit
  or its tree's token budget after handing back what it had, not a failure); failed `fail`; stopped
  `faint`. No status words in the tree (the exception to §2.4's icon and text rule): the **legend**
  names the six statuses in a tooltip (one per line, `space.1` apart) on the count line's
  "图例" / "Legend" trigger at its right end (prose `small`, `faint`, dotted underline; hover or
  focus opens it); every dot also carries its word as its accessible label.
- **Background tasks**: the root's own background tasks under the root column (336 wide, `space.3`
  below the tree): a heading "后台任务 · N" / "Background tasks · N" (`small`, `faint`, aligned
  with the rows' dots) and one compact row per task, the nodes' way (`row.dense`, padding 0
  `space.2`, no ground or border, `small`): the dot, a `Bash` tag
  (the picker-menu tag: `micro` `muted` on `selected`), the description with an ellipsis and the
  duration in `faint`. None: nothing. A child's background tasks show only in its level 2.
- **Canvas**: the tree's scroll region is a labelled region ("智能体树" / "Agent tree") the
  keyboard can focus (`tabindex="0"`, the focus ring inset), so a tree wider than the dialog
  scrolls without a pointer.

`AgentDetail({ node, agentType, inBackground?, spawnedBy, latestText, task, background, toolCalls,
onBack, onClose, onOpenParent, onOpenTranscript, onStop?, stopping?, now? })` is level 2, one agent's summary, live at
the granularity of tool summaries. The dialog is 600 high (at most the window less 32), so it does
not jump while the agent works; head, body and footer pad themselves (compact, as level 1):

- **Head** (padding `space.2` `space.4`, 1px `line-soft` below): a dense back button
  (`arrow-left`, "返回智能体图" / "Back to the agent map"), the status dot, the description (`h2`,
  one line with an ellipsis) and close. Under it, indented past the back button (`control.dense` +
  `space.2`), two meta lines (`small` on its own 16 px line, `muted`, `space.1` under the title):
  "运行中 · <agent type> · <model> · 后台" ("后台" only while `inBackground`, the default: a fork
  skill's child runs in the foreground and has none); then "由 <parent> 派出 · <time> · <tokens>"
  / "Spawned by <parent> · <time> · <tokens>", the parent an underlined `ink` link that opens its
  node (`onOpenParent`).
- **Body** (scrolls, padding `space.3` `space.4`): the latest text (prose, `space.2` above the
  sections), then three collapsible
  sections, each a button (chevron, title 500, count `faint`) with `aria-expanded`: **提示词 / Prompt**
  (the dispatch prompt, prose small `muted`, closed at first), **后台任务 / Background tasks · N**
  (the agent's own tasks, level 1's rows, closed at first; with none, a compact `EmptyState`
  "暂无后台任务" / "No background tasks" in `small` `muted` where the rows start) and **工具调用 / Tool calls · N** (open):
  the calls newest first, each a `row.dense` line: a dot slot (`space.2`; the running call's dot
  pulses), the tool name (500, at least 44 wide), its display summary (`muted`; the running one
  `ink`) with an ellipsis, and at the end in `faint` a range ("第 1–180 行") or the running call's
  clock. The section content starts under its title, `space.1` above the next section.
- **Footer** (padding `space.2` `space.4`, 1px `line-soft` above): "打开完整记录" / "Open transcript"
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
| agent-map-dialog | tree | width | 1097 |
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
| agent-map-content | tree | padding-top | space.3 |
| agent-map-count | tree | color | color.muted |
| agent-map-count | tree | font-size | type.small |
| agent-node | tree | width | 336 |
| agent-node | tree | height | row.roomy |
| agent-node | tree | padding-left | space.2 |
| agent-node | tree | border-radius | radius.sm |
| agent-node[data-root=true] | tree | background-color | color.raised |
| agent-node[data-root=true] | tree | border-top-color | color.line |
| agent-node[data-depth=2] | tree | background-color | color.raised |
| agent-node[data-depth=2] | tree | border-top-color | color.line |
| agent-node[aria-current=true] | tree | border-top-color | color.accent |
| agent-node[aria-current=true] | tree | background-color | color.selected |
| agent-node-name | tree | font-size | type.body |
| agent-node-meta | tree | font-size | type.small |
| agent-node-meta | tree | color | color.muted |
| agent-dot | tree | width | space.2 |
| agent-dot[data-status=waiting] | tree | background-color | color.warn |
| agent-dot[data-status=completed] | tree | background-color | color.ok |
| agent-dot[data-status=failed] | tree | background-color | color.fail |
| agent-task | tree | height | row.dense |
| agent-task-tag | tree | font-size | type.micro |
| agent-task-tag | tree | background-color | color.selected |
| agent-task-time | tree | color | color.faint |
| agent-legend-trigger | tree | color | color.faint |
| agent-node | deep | height | row.roomy |
| agent-node[data-depth=3] | deep | width | 336 |
| agent-map-head | loading | border-bottom-color | color.line-soft |
| agent-map-content | loading | padding-left | space.4 |
| agent-map-content | loading | padding-top | space.3 |
| skeleton-bar | loading | height | space.3 |
| agent-map-content | failed | padding-left | space.4 |
| agent-map-content | failed | padding-top | space.3 |
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
| agent-detail | detail | padding-top | space.3 |
| agent-detail-foot | detail | padding-left | space.4 |
| agent-detail-foot | detail | padding-top | space.2 |
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
- **Below 600** (state `narrow`): the mark (the dot, or the `agent` icon 14 when nothing is
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

#### 6.16.30 Composer menu

The composer's ＋, `/` and `@` menus (`ComposerMenu`, `useComposerMenu`; composer menus spec `docs/superpowers/specs/2026-11-28-composer-menus-design.md` §1–§4, §7): one shell for the three, replacing the command palette for `/` and `@` (⌘K keeps the palette, §6.7).

- **Kinds**: ＋ (`plus`: everything a person can add or use, for people who do not know the keys: 添加 · 能力 · 连接器), `/` (`slash`: skills by source, a connector's prompts, unavailable connectors, then commands last), `@` (`at`: matching files, then resources grouped by connector). The page builds the groups and passes data only.
- **Shell** (from 600 up): anchored to the composer frame: as wide as the frame (its border included), start-aligned, `space.2` above it, so it covers the thread and never the composer; a Menu's ground and line (§6.7: `panel`, 1px `line-strong`, radius `md`, `shadow-1`, padding `space.1`, `z.popover`); at most `layout.menu-max-height` high, its list scrolling inside while the footer stays.
- **Rows** (`composer-menu-item`, the described-item row of §6.16.3): the **lead** (`composer-menu-lead`, a `space.6` square): an icon 16 `muted` for the row's kind (a command `terminal`, a skill `skills`, a ＋ row its own: 上传文件 `upload`, 项目文件 `folder`…), or for a thing a connector brings (the connector's ＋ row, its prompts and resources) its `ObjectMark` 24 (the connector's icon, falling back to the initial, §6.17), or for a file its type badge (§6.16.19); then the name (`ink`, one line, ellipsis; never a leading `/` or `$`), an optional hint after it (`composer-menu-hint`, `faint`: a skill's argument hint), and one optional line under it (`composer-menu-desc`, prose `small` `muted`, one line with an ellipsis); a trailing badge (`composer-menu-badge`, the `warn` Badge: 待配置 / Needs setup on a connector waiting for setup). A row without a line is `row.default` high, padding `space.1` `pad.default.x`; with one, padding `space.2` `pad.default.x`. Radius `sm`. The **active** row (`aria-selected="true"`) is on `selected`; the pointer moving onto a row makes it active. A disabled row is `disabled` (lead and line too), skipped by ↑↓, a click does nothing. Group labels (`composer-menu-label`) are the menu label look (`micro` `muted`, padding `space.2` `pad.default.x` `space.1`); groups keep the page's order whatever the query, so a command never takes the first ↵ meant for a skill.
- **Query**: no search box of its own: the query is the composer text after the trigger (`/fix`, `@report`); the rows are ranked with the palette's `commandScore` (§6.7: label prefix, search-text prefix, label substring, search-text substring, description substring; anything else hidden), the rest of a group ordered by score. The `@` menu's results come searched from the kernel (`filter={false}`: every row stays in the page's order); while the rows are still an earlier query's (the query has not rested, or its answer is on its way) the page filters them like the other menus, so ↵ never picks a row the query no longer matches. No match: the empty line (`composer-menu-empty`, prose `small` `muted`, padding `space.2` `pad.default.x`, the page's sentence); results on their way: the loading row (`composer-menu-loading`, the spinner and 「正在加载」 / "Loading", same look) in place of the empty line; both in an always-mounted live region. An optional **notice** under the list (a `muted` line and a next-step text link that closes the menu as it navigates: the `/` menu of an agent with no invocable skills links someone who can edit the agent to its skills section).
- **Footer** (`composer-menu-foot`, from 841 up; the composer menus spec's size table, which keeps medium without key hints): a `line-soft` hairline, padding `space.2` `pad.default.x` `space.1`, `micro` `faint`, the keys `muted`: 「@ 文件与资源 · / 技能与命令 · ↑↓ 选择 · ↵ 使用 · esc 关闭」 / "@ Files and resources · / Skills and commands · ↑↓ Select · ↵ Use · esc Close", and at its end the `muted` hint 「输入以搜索」 / "Type to search" (not on ＋). The `@` and `/` hints are buttons (`composer-menu-switch`, `aria-pressed` on the current one, hover `ink`) that switch to that menu; a click keeps the focus in the composer.
- **Keys** (the composer textarea keeps the focus; `useComposerMenu().onKeyDown`, offered before the composer's own): ↑↓ move the active row (wrapping, skipping disabled rows), ↵ picks it; with no row to choose it closes the menu (results on their way: it waits) and never sends the draft while the menu is open (the next ↵ sends), Esc closes once and keeps the text, Backspace through the trigger closes (the key still deletes it; with a selection it is plain editing and the menu stays to the page's trigger rule), a space right after `@`, or after `@…` with nothing found, closes (the person is writing an address or plain text). Only key moves scroll the active row into view; the pointer never scrolls the list. The footer's switch hints are pointer shortcuts outside the tab order (the keys switch by typing the trigger). Nothing during an IME composition: its ↵ confirms the text and never picks; the page treats the composition's intermediate text as no query (it opens, closes and searches nothing) and checks what it commits at `compositionend` (`ComposerBox onCompositionStart` / `onCompositionEnd`), while a key an IME commits directly (keyCode 229 with no composition, Shift+2 giving `@`) types like any other. **Leaving** the composer closes the anchored menu and keeps the text: a press outside the composer frame, or the focus moving to an element outside it (the focus leaving the window keeps it open); the compact sheet closes as any bottom sheet. A pick calls the row's action; the page closes or switches the menu (技能 opens `/`). A click on a row keeps the focus in the composer.
- **Compact** (below 600): the same content in a bottom sheet (§6.59; `composer-menu-sheet`, titled 添加 / 技能与命令 / 文件与资源, "Add" / "Skills and commands" / "Files and resources"), one history entry (the system back closes it), dismissal as any bottom sheet: a **search field** at the sheet's top (`composer-menu-search`, `touch.hit` high, the `hover` ground, radius `sm`, placeholder 「搜索」 / "Search" in `faint`, `touch.sheet-inset` under it) because the keyboard covers the composer; ↑↓ ↵ Esc work in it too. The groups are the sheet's groups (§6.59: the heading over the rows on the `hover` ground, `touch.sheet-inset` apart, `line-soft` separators from the text column), rows `touch.row` high padded `space.4`, gap `space.3`; no key hints. Focus starts on the sheet's close (no keyboard jumps up); on touch neither a choice nor the sheet's closing focuses the composer (no focus return: it would pop the keyboard; `BottomSheetContent returnFocus`, read as it closes with `isTouchPointer`), with a fine pointer focus goes back to the composer. The sheet's type and radii are the mobile sizes (§2.5), as in the reference's compact block (`data-mobile-sizes`).
- **Accessibility**: the composer textarea is the combobox (§6.16.2 "Menus"); the list is a `listbox` named by the menu's title, groups `group`s named by their label, rows `option`s named by their name (and badge) and described by their line, a disabled row `aria-disabled`; the ＋ button keeps `aria-haspopup="menu"` with `aria-expanded`, and while its menu is open `aria-controls` the listbox.

<!-- states: composer-menu -->
States: `plus`, `slash`, `at`, `empty`, `loading`, `compact`

<!-- size-table: composer-menu -->
| Part | State | Property | Value |
|---|---|---|---|
| composer-menu | plus | background-color | color.panel |
| composer-menu | plus | border-top-color | color.line-strong |
| composer-menu | plus | border-radius | radius.md |
| composer-menu | plus | padding-top | space.1 |
| composer-menu | plus | max-height | layout.menu-max-height |
| composer-menu-label | plus | font-size | type.micro |
| composer-menu-label | plus | color | color.muted |
| composer-menu-item | plus | height | row.default |
| composer-menu-item | plus | padding-left | pad.default.x |
| composer-menu-item[aria-selected=true] | plus | background-color | color.selected |
| composer-menu-lead | plus | width | space.6 |
| composer-menu-lead | plus | color | color.muted |
| composer-menu-desc | plus | color | color.muted |
| composer-menu-foot | plus | border-top-color | color.line-soft |
| composer-menu-foot | plus | font-size | type.micro |
| composer-menu-foot | plus | color | color.faint |
| composer-menu-item[aria-selected=true] | slash | background-color | color.selected |
| composer-menu-item | slash | padding-left | pad.default.x |
| composer-menu-hint | slash | color | color.faint |
| composer-menu-desc | slash | font-size | type.small |
| composer-menu-desc | slash | color | color.muted |
| composer-menu-switch | slash | color | color.faint |
| composer-menu-type | slash | color | color.muted |
| composer-menu-item | at | padding-left | pad.default.x |
| composer-menu-lead | at | width | space.6 |
| composer-menu-desc | at | color | color.muted |
| composer-menu-empty | empty | font-size | type.small |
| composer-menu-empty | empty | color | color.muted |
| composer-menu-loading | loading | font-size | type.small |
| composer-menu-loading | loading | color | color.muted |
| composer-menu-search | compact | height | touch.hit |
| composer-menu-search | compact | background-color | color.hover |
| composer-menu-label | compact | color | color.muted |
| composer-menu-item | compact | min-height | touch.row |
| composer-menu-item | compact | padding-left | space.4 |
| composer-menu-item[aria-selected=true] | compact | background-color | color.selected |

| | compact | medium | expanded |
|---|---|---|---|
| Menu | bottom sheet, search field on top, rows `touch.row`, no key hints | anchored above the composer, no key hints | anchored above the composer, key hints |

#### 6.16.31 Project file picker

The composer's 项目文件 (`ProjectFilePicker`; composer menus spec `docs/superpowers/specs/2026-11-28-composer-menus-design.md` §5): a person references files of the conversation's device project without uploading them. One directory at a time (the kernel lists one per call, with a name filter); the page owns the path, the filter and the selection and passes the listing in, so a choice survives moving between folders.

- **Frame**: a 640 Dialog (§6.7) titled 「引用项目文件」 / "Reference project files"; below 600 the Dialog's bottom sheet (§6.59, one history entry, the system back closes it). Focus starts on the filter from 600 up, on the sheet's close below 600.
- **Path row** (`project-file-path`, a `navigation` named 「位置」 / "Location"): the project's name, then one segment per folder down to the listed one, `/` in `faint` between them; segments (`project-file-segment`) are mono, `control.dense` high, padding 0 `space.1`, radius `sm`; every segment but the last is a button in `muted` (hover: the `hover` ground and `ink`) that goes to that folder; the last is `ink` text with `aria-current="location"`. Long names cut with an ellipsis, the full name in the tooltip.
- **Filter** (`project-file-filter`): the Input (§6.2) with `search` 14, placeholder and name 「筛选此文件夹」 / "Filter this folder"; it filters the listed folder's names (the page asks the kernel with it). ↓ in it moves into the rows. Going to another folder clears it.
- **Rows** (`project-file-row`, the options of a multi-select `listbox` named by the listed folder): `row.default` high, padding 0 `pad.default.x`, gap `space.2`, radius `sm`, `hover` ground on hover; the list scroll pulls out by `pad.default.x` so the names line up with the path row. A row holds a checkbox column (14 wide and `space.1` more after it, so a wide type badge such as JSON never touches the box: a file's checkbox look, square at every size (§6.3), `aria-selected` on a file's option, empty for a folder, whose option has no `aria-selected`), the **lead** (`project-file-lead`, `space.6` wide, `muted`: a folder's `folder` 16, a file's type badge §6.16.19), the name (`ink`, one line, ellipsis), and at the end a folder's `chevron-right` 12 in `faint` or a file's size (`project-file-size`, `small` `muted`, `formatBytes`). A folder row goes into the folder (its name reads 「文件夹 src」 / "Folder src"); a file row toggles its choice. At the cap (`max`, 10 per message) the file rows not chosen are `disabled` (skipped by ↑↓, a click does nothing); folders stay open. The list keeps one height from 600 up (nine rows), so the dialog does not jump between folders; a new folder starts at its top. The listbox stays mounted (empty and `aria-busy` while a folder loads), so a folder opened from the keyboard keeps the focus; a path segment that becomes the current one hands the focus to the listbox.
- **Keys** (the listbox holds the focus, `aria-activedescendant` names the active row): ↑↓ move (wrapping, skipping disabled rows), Home / End, Space or ↵ act on the active row (a folder opens, a file toggles). With the keyboard the active row is the palette's current item (§6.7: `selected` ground, a 1px `line-strong` outline).
- **Status** (an always-mounted live region under the rows, prose `small` `muted`, padding `space.2` `pad.default.x`): the loading row (`project-file-loading`, the spinner and 「正在加载」 / "Loading") in place of the rows while the folder loads; the cap's hint (`project-file-truncated`, 「未列出全部，用筛选缩小范围。」 / "Not everything is listed; filter to narrow it down.") when the listing stopped at its cap. An empty folder is the panel EmptyState (§6.18) 「这个文件夹是空的」 / "This folder is empty"; a filter with no match 「这里没有名称包含「<q>」的项」 / "Nothing here has "<q>" in its name". A failed listing (the page's ErrorDetail, §6.24: a device whose provider cannot list files, `device.list_unsupported`) takes the rows' place at their height, and the filter is disabled.
- **Footer**: the count at the start (`project-file-count`, prose `small` `muted`, a `status`: 「选择要引用的文件」 / "Choose files to reference", 「已选 2 个」 / "2 selected", at the cap 「已选 10 个，最多 10 个」 / "10 selected, at most 10" in `warn`), then 取消 / Cancel (ghost) and 「引用」 / "Reference" (primary, disabled with nothing chosen), which hands the chosen paths to the page. Below 600 the count stands centred over the full-width buttons, 「引用」 first.
- **Compact sizes**: below 600 the picker takes the mobile sizes (§2.5, `MOBILE_SIZE_QUERY`) like every component: `row.default` rows, the path segments, the filter and the buttons are 44 high, the type is §2.2's Touch column and radius `sm` is 12 (the checkbox keeps its square, §6.3); the reference's compact block draws under the same overrides (`data-mobile-sizes`).

<!-- states: project-file-picker -->
States: `root`, `folder`, `filtered`, `selected`, `empty`, `loading`, `unsupported`, `compact`

<!-- size-table: project-file-picker -->
| Part | State | Property | Value |
|---|---|---|---|
| project-file-picker | root | background-color | color.panel |
| project-file-picker | root | border-top-color | color.line-strong |
| project-file-picker | root | border-radius | radius.md |
| project-file-segment | root | height | control.dense |
| project-file-segment | root | color | color.ink |
| project-file-row | root | height | row.default |
| project-file-row | root | padding-left | pad.default.x |
| project-file-row | root | border-radius | radius.sm |
| project-file-lead | root | width | space.6 |
| project-file-lead | root | color | color.muted |
| project-file-size | root | font-size | type.small |
| project-file-size | root | color | color.muted |
| project-file-count | root | font-size | type.small |
| project-file-count | root | color | color.muted |
| project-file-segment | folder | height | control.dense |
| project-file-segment | folder | color | color.muted |
| project-file-segment[aria-current=location] | folder | color | color.ink |
| project-file-truncated | folder | font-size | type.small |
| project-file-truncated | folder | color | color.muted |
| project-file-row | filtered | height | row.default |
| project-file-row | selected | height | row.default |
| project-file-count | selected | color | color.muted |
| project-file-loading | loading | font-size | type.small |
| project-file-loading | loading | color | color.muted |
| error-detail-summary | unsupported | color | color.fail |
| project-file-row | compact | height | row.default |
| project-file-row | compact | padding-left | pad.default.x |

| | compact | medium | expanded |
|---|---|---|---|
| Picker | the Dialog's bottom sheet, the count over full-width buttons | 640 dialog | 640 dialog |

---

### 6.17 ObjectList and ObjectRow

`ObjectList({ label, children })` is the panel of an object list: a `ul` on the `panel` ground, 1px `line-soft` border, radius `md`, rows split by `line-soft`. `ObjectRow` is one `li`, at least 64 px high, padding `space.3` / `space.4`, `space.3` between its parts:

- A 36 px mark (radius `md`, `selected` ground; an agent's row draws its `Avatar` 28 centred in that place on no ground, `mark.avatar`, §6.30): the one avatar-tile rule, the upper-cased first grapheme of the display name in 600 (mono like the whole UI; `initialOf`, as the org switcher and the account row), for extensions and plugins too; an icon only for rows that are steps, not objects (the setup page); `tone="warn"` tints it with `warn` at 15% when the object needs attention.
- **A plugin's icon as the mark** (maintainer decision 2026-11-08): a thing a plugin brings (a channel connection, an extension, a model provider) may take the icon its plugin declares (`plugin.json` `icon`, served only by the kernel's catalog icon routes) as its mark: `mark.image` here, `avatar: { image }` on an `ObjectCard` (§6.34), `image` on a `CellTitle` (§6.6), `mark` on an `ItemList` row (§6.33) and a `Sheet` head (§6.7), and `ObjectMark` (24 / 28 / 40) on its own (a page head's `avatar`). The icon is an `<img alt="">` (decorative: the name is written beside it), contained on the same `selected` tile (24 in the 36 and 40 tiles, 20 in the 28 tile, 16 in the 24 tile), never cropped, never inlined. Without an icon, or when it fails to load, the tile draws the initial as above: objects without one keep the initial. Never an icon of our own for an object (the rule above stands); the plugin's own picture is not one.
- Text column: line 1 the name (600; a link when `href`; `mono` for package names) and chips (`small`, 1px `line` border, radius `sm`; `tone="warn"` draws the warn tint without a border). A chip is a scope or an attention mark (组织共享, 敏感); plain facts such as a version or 必需 are meta text, never a chip; line 2 the description in `muted` prose, one line with an ellipsis; line 3 the meta in `faint`, `small`, one line; a meta list part `{ person }` (a requester) is a `PersonName` 16 (§6.50) inline in that line, joined with 「 · 」, vertically centred (state `person`).
- At the right: a state label (`state`: `ok` / `warn` / `fail` colored, `muted` in `faint`), a short `trailing` text in `faint`, one row action (`action`: a `default` dense button or link, never `primary`: the page head holds the one primary of the screen, and a row that needs attention says so in its `state`) and the `more-horizontal` overflow menu (`menu`). Below 600 every ObjectList is the grouped list below.
- **Pending**: while an action of the row runs (a switch, a preview call), the row's buttons are disabled until it settles; the running one shows the Button's loading state (`action.loading`: the `spinner` before its label, `aria-busy`), or, when the running action came from the menu (`busy`), the menu button draws the `spinner` in place of `more-horizontal` (`aria-busy`; a lone menu item drawn as a button carries the loading state itself). Never a click that seems to do nothing.
- **Loading** (`ObjectList.loading`, `true` for 3 rows or a row count; `ListPage.loading` on a list page): the panel draws skeleton rows in the row's shape instead of its rows (the same `.cb-object-row` box, 64 px at least, with its divider and first-row rule): a `mark` box (36 × 36, radius `md`, §6.29) and a name line and a description line in the text column, `body` bars 30% and 55% wide in the one bar look (§6.29), and the list is `aria-busy` with a hidden "正在加载 / Loading" (none of its own inside a skeleton group, which announces once). It wins over `empty`, so no empty state flashes before the first answer; a `records` ListPage draws the DataTable's loading state in the caller's table shape, else a Skeleton (§6.29), instead.
- **More pages** (mobile interaction model spec §3 "Infinite scroll", D6): a list read by cursor takes `onLoadMore`, `hasMore`, `loadingMore` and `loadMoreError` (`ListMoreProps`; the same four on `CardGrid` §6.34, `DataTable` §6.6 and `ItemList` §6.33, whose end is an `li` after its rows with a skeleton row in its own row look). Below 600 the list's end (`ListEnd`) lives inside its grouped card: a sentinel (`useListSentinel(onLoadMore, { hasMore, loading })`, the hook `ConversationList`'s end uses too, §6.60) asks for the next page once as it comes within 600 px of the view (an `IntersectionObserver`); while the page loads the list's own skeleton row stands at the end (hidden from assistive tech; the end keeps one `status` region mounted, role `none` while idle or loading, and fills it with 正在加载 then, so the announcement is heard); `loadingMore` is required with `onLoadMore` in practice: the sentinel arms again only after a load has run (or `hasMore` came back); a failure is one row in the card, its message in `fail` with 重试 (a ghost button calling `onLoadMore`), `touch.row` high with a full-width `line-soft` hairline above; the last page draws nothing. Never a 「加载更多」 row below 600. From 600 up the list draws a Load more button (`default`, 加载更多, loading while `loadingMore`, the failure in `fail` beside it) under the list, `space.3` below it (`ListMoreButton`, the wide copy of `ClassForms`), so the desktop keeps its button. A page passes the props and never draws its own Load more button (`web-ui-load-more`, §9.1).

- **Touch** (from 600 up: `MOBILE_SIZE_QUERY` on a touch device, §2.5, maintainer decision 2026-11-22; below 600 the grouped list below applies instead): a row is `touch.row` (52) high, `touch.row.roomy` (56) when it has a second line (description or meta), with no `line-soft` divider; the list draws no `line-card` border, radius or ground (the rows sit straight on the page: one box is enough, §1), Below 600 the grouped list below wins over these sizes; they stay for touch devices from 600 up. Outside the touch query the rules above stand.

- **Grouped list** (maintainer decision 2026-11-22; responsive system spec §2.3; mobile layout spec §4.5): below 600 **every** `ObjectList` (a ListPage's `objects` variant and any other use) draws its rows as one **grouped list**: one card (the `panel` ground, 1px `line-soft`, radius `md`; one card, never a box per row) from the shared grouped values (`--cb-grouped-*`, as CardGrid's and DataTable's compact rows: rows padded `space.3` `space.4`, the 40 lead, hairlines `line-soft` inset to the text column), each row exactly 64 high with a lead and up to two text lines (`--cb-grouped-row-lead`, each line half the 40 lead; a third line, the meta line, grows the row by 20); the mark, the name and its chips, the description and the meta line in the text column, and the **state closes the meta line** in its tone (`ok` / `warn` / `fail`; `muted` in `faint`; a row with a state and no meta draws a meta line for it here only; a long meta line takes the ellipsis, never the state; the row's own state label is hidden, the label stays one node read from the meta's `data-state`). A row with `href` shows **no buttons**: the action and the `more-horizontal` menu are not drawn, a `chevron-right` ends the row and the name's link covers it; its actions (the action, then the menu items) open as an ActionSheet on long press or right click (§6.61, §6.66), one sheet per list titled with the row's name, and every action stays reachable on the object's detail page. A row without `href` keeps its one button (the marketplace's 安装; a lone menu item drawn as a button) at the mobile control height (44, §2.5), and whenever it has more menu items a labelled ⋯ (「行操作：<name>」 / "Row actions: <name>") that opens the same sheet, so they stay reachable without a long press (coordinator ruling 2026-11-22). Such a row is not held to 64: the 44 button and the `space.3` padding make it 68 (`min-height` 64, the button sets the height). The skeleton rows take the same frame. The buttons exist on the wide forms and not on this one: two DOMs (§6.64).

<!-- states: object-list -->
States: `person`, `compact`

<!-- size-table: object-list -->
| Part | State | Property | Value |
|---|---|---|---|
| object-row | person | min-height | 64 |
| object-row | person | padding-top | space.3 |
| object-row | person | padding-left | space.4 |
| object-row | person | column-gap | space.3 |
| object-row-mark | person | width | 36 |
| object-row-mark | person | height | 36 |
| object-row-mark | person | border-top-left-radius | radius.md |
| object-row-mark | person | background-color | color.selected |
| object-row-person avatar[data-size=16] | person | width | 16 |
| object-row-person avatar[data-size=16] | person | height | 16 |
| object-row-person avatar[data-shape=circle] | person | border-top-left-radius | 50% |
| object-row-person person-name[data-size=16] | person | column-gap | space.1 |
| object-row-person person-name-text | person | font-size | type.small |
| object-row | compact | height | 64 |
| object-row | compact | padding-left | space.4 |

### 6.18 EmptyState

One empty state for the whole product, in three styles. `EmptyState({ text, hint?, action?, size? })`:

- **Illustration**: the pixel capybara of §3 drawn as a line (`LogoLine`: the outer edges of the bitmap's cells, the eye included, 1 px `faint` stroke, no fill), decorative, on the `page` and `panel` styles (never `compact`). No other art or icon stands in for it (a search that matched nothing is the same style with its own sentence).
- **Themed art** (the theme gives `illustrationUrl` or `markUrl`): `page` and `panel` draw `illustrationUrl ?? markUrl` instead of the line-art capybara, as a CSS mask (`data-part="empty-brand-art"`, from `--cb-brand-art`, §3) filled with `faint`, inside `data-part="empty-illustration"`, a fixed box (`page` 96 × 60, `panel` 64 × 40), `mask-size: contain`, centred, `aria-hidden`. `compact` stays text only. A file that fails to load leaves the box empty (the mask hides it; the box keeps its size, the words stay).
- **Copy**: one sentence in `ink` (prose font) saying what will be here ("还没有 agent" / "No agents yet"), an optional second line in `muted` (`small`, prose font), and at most one action, the primary next step (a `default` or `primary` button or link). A `primary` action here is the screen's one primary: `ListPage` hides the head's primary while it is shown (§5.1). Never a table header over an icon, never a sentence about the absence of data in general ("暂无数据" is only the DataTable's fallback).
- **Styles**: `page` (default) is the line-art capybara over the words, centered in the content frame, no frame of its own, `space.8` × 2 above and below, the illustration at scale 6 (85 × 61). `panel` (an empty region inside a box) is the same centered look sized down: the illustration at scale 4 (57 × 41), the sentence (+ hint) centered under it, the action `dense`, `space.8` above and below and `space.2` at the sides so it fits the 240 px sidebar. `compact` is the words alone, no art: left-aligned with `space.3` padding (none inside a card body, which pads it already) and `space.2` gaps, the action `dense`; inside a DataTable it is centered horizontally in the table body instead (§6.6).
- **Where** (maintainer decision 2026-11-08, acceptance): the style follows the space the empty state fills, never the caller's taste.
  - `page`: a page or settings content area with nothing to show: every ListPage / ObjectList / CardGrid empty (`ListPage.empty`), the InboxPage with no items (the page state instead of the list + detail split, §5), a settings page whose list is empty (我的连接: "没有需要你个人凭据的连接器。" + hint; an agent's 渠道 section on the page ground: "这个智能体还没有接入渠道。" with 接入渠道 for an org admin), a page search matching nothing (市场源: "没有匹配的市场源。" + 清除搜索), a wizard step with nothing to fill, an extension's own page whose view is empty.
  - `panel`: an empty region inside a box: an `ItemList` with no rows (§6.33: a template's tools / skills / connectors, a deployment config's org copies), an empty Card or FormSection card (no model providers, no tools to review, no agent to bind, no custom marketplace), a Sheet or Dialog whose list is empty (a tool group without tools, no member to reassign to, no evaluation set, no connector to bind), a ToolPolicyList filter matching nothing (§6.36), the span waterfall with no spans (§6.10), the sidebar's conversation list ("还没有会话" + 新会话, the archived list's "没有已归档的会话", a filter matching nothing: "没有匹配的会话" + 清除筛选), and an extension's schema view with nothing to show in a right panel, an inline card or a file preview (§6.16.17): no blocks, or only a checklist / key-value list / table without items, draws one panel empty state with the host's sentence "这里还没有内容。" / "Nothing here yet." (the UiView contract carries no empty text), and an empty checklist or key-value list among other blocks draws the same in its place. A properties section whose view is empty is not drawn at all (no header, no badge, no empty state; acceptance decision 2026-11-13, like the built-in 文件 and 后台任务 sections): it appears once its view has something to show (todo's 待办 after the first write), and it is not drawn during its first load either; once drawn (content or a load failure) it keeps its frame while it reloads.
  - `compact`: only where the space is one line: the DataTable's empty and no-results areas (§6.6, centered in the table body, the same in every table, an extension's table block too). A line inside a form field (a checkbox group with nothing to pick: "组织还没有技能。"), a Repeater with no items (§6.26), a ContentSection's or an ImpactPreview's empty line (a fact in a summary, §6.31, §6.35) and a menu or palette matching nothing are not empty states: they stay one muted line.
  - The action stays `default` (dense in `panel` and `compact`) unless it is the page's one primary.

<!-- states: empty-state -->
States: `branded-page`, `branded-panel`

The list covers only the theme-art states; the built-in line art is unchanged and measured elsewhere.

<!-- size-table: empty-state -->
| Part | State | Property | Value |
|---|---|---|---|
| empty-illustration | branded-page | width | 96 |
| empty-illustration | branded-page | height | 60 |
| empty-brand-art | branded-page | width | 96 |
| empty-brand-art | branded-page | height | 60 |
| empty-illustration | branded-panel | width | 64 |
| empty-illustration | branded-panel | height | 40 |
| empty-brand-art | branded-panel | width | 64 |
| empty-brand-art | branded-panel | height | 40 |

### 6.20 PendingState

`PendingState({ frame?, delayMs? })`: the neutral loading state of a page whose outcome is not known yet (the app frame before it knows whether to draw the shell or the setup layout). It draws nothing shaped like any of the outcomes (no sidebar, no composer outline, no checklist): only the `bg` ground, a `status` region marked busy with a hidden "正在加载 / Loading", and after 300 ms (`PENDING_DELAY_MS`) three quiet bars in the one bar look of §6.29 (`space.3` high on the `selected` ground, radius `sm`; 30 %, 70 %, 45 % wide) in a centered chat-width column. `frame="app"` fills the window, `page` the content area. Rule: never show a placeholder shaped like one of two possible outcomes; skeletons in the frame's shape are for loads whose frame is already known (§6.17).

### 6.19 Callout

`Callout({ tone, action?, actions?, children })`: a `role="status"` bar naming what needs action, radius `md`, padding `space.3` / `space.4`: a `circle-alert` icon, the sentence, and one dense button or link (`actions` adds more, in order, for a choice between ways to resolve it: the composer's token warning, §6.16.2). `warn` uses the `warn` tint (15%) and a `warn` icon; `fail` the `fail` tint (12%) and icon. On list pages it sits in the header between the title row and the tabs (`ListPage.callout`). `info` is the quiet form for a standing fact about the page rather than something to fix (the admin overview's "超级管理员不能查看会话内容。"): a `role="note"` on the `panel` ground, `muted` text, a `faint` icon, usually no action; it sits first in the page body, under the head. The tinted bar is a box (§1), so **inside a box it draws its unboxed form by itself**, as a CodeBlock drops its line (§6.9): inside a card, a form card, a Dialog or a Sheet (any `BoxScope`) it is the `warn` / `fail` line with its icon, `data-framed="false"`: no tint, no padding, no radius, the 12 px `circle-alert` on the first line, the sentence in the prose font at `prose-small` in the tone's colour (`info`: `muted`, `faint` icon), the action at the right `space.2` after it; still a `status` (`note`). So a panel drawn both on a page and in a Sheet (an extension's failed replicas, its missing config, a plugin's permission mismatch) passes a Callout and gets the tinted bar on the page and the line in the Sheet. A notice about a whole section still stands above the section's card (between the section head and the card on a stacked section, or above the section), never as its first line.

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

`DangerZone({ title, children })` with `DangerZoneItem({ title, description, action })` (role pass): the irreversible actions at the bottom of a settings section (organization deletion). A `region` named by its title, `space.8` above, a 1px border of `fail` at 45 %, radius `md`; the title (`body`, 500, `fail`) in a head row split from the items by `fail` at 25 %. Each item: the title (500, `ink`) over the description (`small`, `muted`), and one dense `danger` button at the right that opens a confirmation (`DangerConfirm`, §6.7), never acts at once; items are split by `line-soft`. After side-by-side `FormSection`s it sits in their field column (indented by the 240 title column and its gap, the section cards' left edge); after stacked sections (one or two in the page, §5.3 "Columns by count"; every SettingsPage section; `layout="stacked"`) and where the label column does not fit (§4.3) it spans the full width, like the section cards.

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

`Repeater({ label, items, addLabel?, onAdd?, presets?, onRemove?, onMove?, onToggle?, min?, max?, disabled?, empty?, variant?: "cards" | "divided" | "rows" })` with `RepeaterItem { key, title?, subtitle?, body, invalid?, collapsed? }`: an array of objects in a config form (an extension's endpoints, an endpoint's models; config forms spec §5). Without `onAdd` there is no footer and without `onRemove` no remove buttons: with `onMove` alone it is an **order-only** list, a fixed set the person only reorders (the platform's login methods). A `group` named by `label` around a list (`ul`) of items, `space.2` apart; each item is a `group` named by its title (an untitled item by its position, "第 2 项" / "Item 2").

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

`FieldRow({ children, advanced?, first?, defaultAdvancedOpen? })`: a compact row of small fields for an object whose form hints say `layout: "row"` (a model: ID, context window, max output, the capability checkboxes). The fields (`Field`s) share the row equally, `space.3` apart; a row's checkboxes go in one `FieldRowGroup({ label, children })`: a `group` named by its label ("能力" / "Capabilities"), drawn above the boxes like a field's label (`body`, `ink`, the label head's 20 px) and, like it, on the first row only; the boxes sit side by side on the inputs' line (`control.default` high, `space.3` apart, wrapping), the group at its own width. Other non-field children (a lone checkbox) keep their own width and sit on the inputs' line. Labels are drawn on the first row only (`first`); later rows keep them as the fields' accessible names, out of sight, so a list of rows reads as one table. With `advanced`, a "高级" / "Advanced" toggle ends the row (`small`, `muted`, a `faint` `chevron-right` / `chevron-down` 12 after the words, `aria-expanded`, `aria-controls`; `ink` on a `hover` ground); open, the advanced fields follow under the row, `space.2` below, wrapping at their own width under a 1px `line` guide on the left, indented `space.2` (the Disclosure body, §6.5), their labels always drawn; `defaultAdvancedOpen` starts it open (an issue inside it). **Below 600** the row stacks: one field per line, `space.2` apart, every label drawn; consecutive rows are split by `line-soft` with `space.2` above.

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

An agent's picture (a person's, as a circle, below), everywhere an agent appears (the new conversation page, the agent picker, the agent list rows, the agent page head, the conversation title bar, the sidebar group titles; agent profile design §2.3).

- `Avatar({ value, name, size })`, `size` 16, 24, 28, 40 or 64, a square of that size. `value` is one of:
  - `{ kind: "preset", id }`: one of the ten pixel animals (`AVATAR_PRESETS`): 水豚 / Capybara, 黑熊 / Black bear, 熊猫 / Panda, 大象 / Elephant, 狐狸 / Fox, 猫头鹰 / Owl, 企鹅 / Penguin, 兔子 / Rabbit, 乌龟 / Turtle, 鲸 / Whale (ids `capybara`, `black-bear`, `panda`, `elephant`, `fox`, `owl`, `penguin`, `rabbit`, `turtle`, `whale`). Each is a 12×12 bitmap drawn like the Logo (§3: solid squares, `shape-rendering: crispEdges`, no outline, no anti-aliasing), one SVG path per palette color, on its ground color. The palette values and the ground are token names (`avatar-*`, and `accent` for the capybara, §2.1), so no color literal is involved. The pixel unit is the whole number nearest to `size / 12` (16: 1, 24: 2, 28: 2, 40: 3, 64: 5), the drawing centred in the square; every size holds the whole drawing, nothing is clipped.
  - `{ kind: "image", src }`: the uploaded image, covering the square; when it fails to load, the initial.
  - `null`: the initial square, the avatar tile rule of §6.17: the first grapheme of `name` (`initialOf`), 600, `ink` on `selected`; `micro` at 16, `small` at 24 and 28, the h2 size at 40, the h1 size at 64.
  - **A person** (`shape="circle"`, default `"square"`; `data-shape` on the avatar): a circle (radius 50%) for an account, everywhere a person appears (§6.50 PersonName, the sidebar's account row at 24, the Me page's at 40, the profile page at 64). It takes no preset (a preset value draws the initial instead); an image covers the circle, and `null` or a failed image draws the initial, `muted` on `selected` (an agent's initial stays `ink`), at the same sizes. Agents stay square, people round, so a row mixing both reads at once.
  - Radius `sm`, `md` at 64 (a circle: 50% at every size). The avatar is decorative (`aria-hidden`): the name is always written next to it.
- `AvatarPicker({ value, onChange, hidden?, extra?, onUpload?, uploadOffReason?, label?, disabled? })` (`disabled`: every tile disabled while the owner saves, the value still shown): the ten presets as one radio group (named `label`, default "头像" / "Avatar"; each radio named by its preset's name), 48 px tiles (a 40 avatar, 3 px padding, a 1 px border, radius `md`) `space.2` apart and wrapping, then the theme's own presets (`extra`, below), then an upload tile (`upload` icon, "上传图片" / "Upload image"; `line` dashed border) that opens a file dialog for png, jpg or webp and passes the file to `onUpload` (cropping and the 2 MB limit are the caller's). A checked tile is neutral (§2.3): `selected` ground and a `line-strong` border; hover is the `hover` ground; keyboard focus the accent ring. When `value` is an image, the upload tile shows it and is the checked one; if that image fails to load, the tile shows the `upload` icon again. Without `onUpload` the upload tile is disabled (`disabled` icon color) and `uploadOffReason` (default "这里不能上传图片。" / "Uploading is not available here.") is written under the tiles in `small` `muted`, and describes the tile; presets still work.
- **Hidden and theme presets** (a theme's brand, #451): `hidden` lists built-in preset ids the picker does not offer (a stored one still renders as an `Avatar`). `extra` is a list of `{ key, name, src }` theme presets, drawn after the remaining built-ins and before the upload tile: the same 48 px radio tile showing the image at 40 (`Avatar` image rule), named (accessible name) by `name`, which arrives already localized; it is checked when `value` is `{ kind: "theme", key }`, and selecting it calls `onChange({ kind: "theme", key, src })` (`AvatarChoice`). `visibleAvatarChoices(hidden, extra)` returns the choices in that order (for a random default). Without `hidden` and `extra` the picker is unchanged.

<!-- states: avatar -->
States: `presets`, `sizes`, `initial`, `person`, `title-bar`, `sidebar-row`, `list-row`, `picker`, `picker-theme-presets`, `picker-upload-off`

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
| avatar[data-shape=circle] | person | width | 24 |
| avatar[data-shape=circle] | person | border-top-left-radius | 50% |
| avatar[data-shape=circle] | person | background-color | color.selected |
| avatar[data-shape=circle] | person | color | color.muted |
| avatar[data-shape=circle][data-size=40] | person | width | 40 |
| avatar[data-shape=circle][data-size=40] | person | font-size | type.h2 |
| avatar[data-shape=circle][data-size=64] | person | width | 64 |
| avatar[data-shape=circle][data-size=64] | person | border-top-left-radius | 50% |
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

`ItemList({ label, rows?, children?, empty?, inset?: "card" | "flush", more? })` (`& ListMoreProps`: `onLoadMore`, `hasMore`, `loadingMore`, `loadMoreError`; its end is the one of §6.17 "More pages") with plain rows `ItemListRow { id, tag?, title, meta?, status?, href?, actions? }` or `ItemListItem({ title, code?, marks?, tag?, mark?, href?, actions?, meta?, invalid?, children? })` children: things to look at, act on or edit inside one box, as rows split by `line-soft` hairlines, never cards (§1). A `ul` named by `label`; an empty list shows `empty` (a sentence, or `{ text, hint?, action? }`) as the panel empty state (§6.18): a list is always inside a box.

- **Plain rows** (`rows`): at least `row.roomy` high, `space.2` above and below, gap `space.3`: a tag (`micro`, `muted`, a 1px `line` chip; `accent` for what waits on the viewer), an optional 28 px mark (`mark`: a thing a plugin brings draws its plugin's icon, else the initial, §6.17), the title (`ink`, a link when it has `href`) over one `small` `muted` meta line, a status word, the actions (the org chooser).
- **Item rows** (`ItemListItem`): rows that hold more than a line, where a card per item would have stood (a quick action, an inline sub-agent, a permission group). The title line (at least `control.dense` high, gap `space.2`): a `mark` tile (24, §6.17: a plugin's icon for a thing it brings, else the initial) before the title, the title in `body` 500 `ink` (a link with `href`), its mono id `code` (`small`, `muted`: `eval`), `marks` (a `Badge`, a muted state word: 已覆盖), and the `actions` at the right (dense). Then `meta`, lines `space.1` apart (`small`, `muted` by default: who declares it, the deployment default; a `warn` line carries its icon). Then the body (fields, a list, a warning and its borderless code, §6.9), `space.3` below, its parts `space.3` apart. A row with a body is a `group` named by its title, so its fields read as that row's. `invalid` draws a 2px `fail` bar on the row's left (in the box's padding; at the card's edge when flush).
- **Inset**: `card` (default) inside a padded box (a Card body, a form card that holds other fields, a Sheet): the rows reach the box's padding (no padding of their own at the sides; item rows `space.3` above and below, the first and last `space.2` so they meet the box's padding). `flush`: the list alone in a flush box (a `flush` FormSection): plain rows padded `space.2` `space.4`, item rows `space.4` on every side, so the hairlines run to the card's edges, as a SwitchList's do (§6.3).
- **A review row** (PermissionReview): one item row per category, the category as the title, the 「敏感」 `Badge` as a mark, its reasons as meta lines, its entries as `small` `muted` lines in the body; a danger block (destructive migration statements) is a row whose meta is a `warn` line with the `circle-alert` icon (`Text variant="small" tone="warn" icon="circle-alert"`) and whose body is the code (a CodeBlock, borderless inside the box).

- **Touch** (`MOBILE_SIZE_QUERY`: compact or touch, §2.5, maintainer decision 2026-11-22): a row is `touch.row` (52) high, `touch.row.roomy` (56) with a meta line, with no `line-soft` divider. Outside that query the rules above stand.

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

`CardGrid({ label, loading?, empty?, children })` lays `ObjectCard`s out on the page ground (ruling P4-15 of the plugin component management design: the workspace 智能体 page's 智能体 and 模板 tabs, the admin 智能体 / 模板 tab's template list; on a list page `ListPage variant="cards"`, §5.1). It is a `ul` named by `label` with no box of its own: a CSS grid of `auto-fill` columns at least `layout.card-min` (280) wide (`minmax(min(100%, layout.card-min), 1fr)`), `space.3` apart both ways, so three columns at the content width and one below 600 (§4.3). It is drawn on the page ground only (§1); inside a box the same things are `ItemList` rows (§6.33).

`ObjectCard({ avatar?, title, href?, description?, meta?, state?, primary?, menu?, oneButton?, id? })`, or `{ loading: true }`, is one `li` and the one box (§1): the `panel` ground, a 1px `line-card` border, radius `md`, padding `space.4`, its parts `space.3` apart in a column. Nothing inside it is boxed.

- **Head** (40 high, gap `space.3`): the avatar, an agent's `Avatar` at 40 (§6.30; `null` or none draws the initial square of the title), `{ icon }` for an object without a picture (its 16 px icon on a 40 px `selected` tile, radius `sm`), or `{ image }` for a thing a plugin brings (a channel connection: its plugin's icon, 24 and contained, on that tile; the title's initial in the h2 size without one or when it fails to load, §6.17), decorative (`aria-hidden`); then the name, `body` 600 `ink`, one line with an ellipsis; when it is cut off, the full text is its `title` (measured after layout and on resize: a name that fits has no tooltip); then, optionally, the object's `state` at the head's right (a mono `small` label: `ok` / `warn` / `fail` in their colour, `muted` in `faint`, as ObjectRow's, §6.17; it sits beside the link, never inside it: the channels page's 运行中 / 出错 / 已停用; a short word or a version, a sentence explaining it leads the description; it takes at most half the head and is cut with an ellipsis past that, its full text the `title`, so it never squeezes the name away).
- **Person in the meta** (state `person`; maintainer review of the account profile plan, 2026-11-20): a meta list part `{ person: { name, avatarUrl } }` is a `PersonName` 16 (§6.50) inline in the meta line, joined with 「 · 」 like the text parts, vertically centred; an agent's owner is drawn this way (the viewer's own card reads "Me" with their avatar). The line keeps its single line and ellipsis.
- **Description** (optional): prose, `prose-small`, `muted`, clamped to two lines (`-webkit-line-clamp: 2`); when it is cut off, the full text is its `title`. A card without one draws no line and no gap; the grid stretches the cards of a row to one height and the foot keeps to the bottom.
- **Foot** (at least `control.dense`, at the card's bottom, gap `space.2`): the meta, one mono `small` `muted` line with an ellipsis (a list joins its parts with 「 · 」, a `warn` part in `warn`, a `fail` part in `fail` (a danger mark, §2.4: a state that removes a protection); an agent: owner · 可见范围, a template: source · version, ruling P4-15); then the primary (`primary`, a `dense` `default` button or link: never the solid `primary` variant, which would put an accent button on every card, while the screen's one primary stays in the page head, §5.1); then the `more-horizontal` menu (`menu`, a dense icon button, §6.7: no menu of one, a lone safe item is a second button, none draws nothing); a card list that shows one button per card passes `oneButton`: beside a primary a lone safe item then stays in the ⋯ menu, a menu of one, so the card never shows two buttons; without a primary it is still the card's one button: the `/connectors` and `/account/connections` cards, maintainer decision 2026-11-09). A card may carry an `id` on its `li`, a page anchor that scrolls to it (`/account/connections#connector-<id>`). While the primary runs (`primary.loading`) it draws the Button's loading state and the card's other buttons are disabled. The primary, a lone item and the menu button keep their own names (开始会话, 更多操作) and are described by the card's name (`aria-describedby` on the name), so a screen reader hears which card they act on.
- **One link, the whole card**: the name is the card's only link (`href`; left out for a viewer who may not open the detail, a read-only list: the name is plain text in the same look, the card has no hover and opens nothing, and has no tab stop unless it has buttons); its `::after` is stretched over the card, so a click anywhere opens the detail and the card keeps a link's behaviour (a new tab, the URL on hover, the pending mark along the card's bottom while the router navigates, §6.13). The primary, the menu and the description sit above it (`z-index`), beside the link in the markup and never inside it (valid HTML, no nested interactive elements), so pressing them never navigates. The description passes a click on to the link, so its tooltip shows and the card still opens: a plain click navigates as the link does, Ctrl / Cmd / Shift or the middle button open the detail in a new tab, and a click that ends a text selection inside the description stays a selection (a selection elsewhere on the page does not count).
- **Hover** lays the `hover` ground over the card (fading over `motion.hover`); **keyboard focus** on the link draws the 2px `accent` ring, offset 2px, around the whole card (`:has(:focus-visible)`, §2.5).
- **Keyboard: roving focus by row** (ruling P4-15). The grid is one tab stop, the card last reached (the first by default). ← / → move to the previous / next card in reading order, across rows; ↑ / ↓ to the card above / below in the same column (from a column the short last row lacks, ↓ goes to the last card); Home / End to the first / last card. Tab then goes through that card's link, its primary and its menu and leaves the grid: the other cards' controls are out of the tab order (`tabIndex` −1) until an arrow or a click brings focus into them. Arrows on the primary or the menu belong to them (↵ or ↓ opens the menu). Skeleton cards take no part. The stop belongs to a card, by its key, not to a position: cards added or removed elsewhere leave it where it is; when the held card goes away (deleted from its own ⋯ menu, filtered out), the stop moves to its neighbour (the card now in its place, else the new last card), and if focus was inside the card (its link, its buttons, its open menu) focus moves to that neighbour's link, never to the page body. The children are a flat list of cards; fragments among them are opened, and each card needs a stable `key`. An ObjectCard outside a CardGrid keeps every control in the tab order.
- **Phones** (below 600; maintainer decision 2026-11-22, replacing the one-column card with buttons; responsive system spec §0 item 4, §2.3): the grid becomes a **grouped list of rows** in one rounded card (the grid, state `narrow`: `panel` ground, 1px `line-soft`, radius `md`, no gap between rows) and each `ObjectCard` a row: `object-card` exactly 64 high with its lead and up to two text lines (the name and the muted line take half the 40 lead each, the description at the `small` size; a meta line would add its height, a card row has none), padded `space.3` above and below and `space.4` at the sides, the avatar (a rounded square), the name (500, one line) over one muted line (the description, else owner · visibility), a `chevron-right`, the hairlines inset to the text column. **No buttons in the row**: the foot, the primary and the ⋯ menu are not drawn; a tap opens the item, and the card's primary and menu items open as an ActionSheet on long press or context menu (§6.61, §6.66; `ObjectCard.primary` and `menu` are unchanged, a page declares nothing new). A card with no `href` keeps its one button at the mobile control height (44, §2.5), and that row is 68, not 64 (the button and the `space.3` padding set its height, as an ObjectRow's, §6.17). The row has the card's keyboard stop, and its accessible name is the name link's.
- **Where** (beyond ruling P4-15): the org channels page `/channels` is a card list too (maintainer decision 2026-11-08): a card per connection with its plugin's icon, the connection name as the link to its detail, the platform's display name as the description, the bound agent and the unbound-person mode (提示绑定 / 匿名访客) as the meta, the running state as the card's `state`. The agent page's 渠道 section (`/agents/<id>?s=channels`) draws the same cards (maintainer decision 2026-11-08; one shared card rendering in apps/web): the bound agent is implicit there, so the meta is the unbound mode alone; the section has no card of its own: its heading (h2) and description stand on the SettingsPage's content ground with 接入渠道 at the heading row's right for an org admin, the grid below (`space.3`), the `page` EmptyState carrying 接入渠道 when nothing is bound, skeleton cards while loading, and cards without links for a viewer who may not open a connection.
- **Loading** (`CardGrid.loading`: `true` for six cards, two rows of three, or a count; `ObjectCard` with `loading: true`): skeleton cards in the card's anatomy and box (§6.29): a 40 × 40 `block` box in the avatar's place, a `body` slot 45% wide for the name, two `body` slots (100%, 55%: the line boxes of two `prose-small` lines) for the description, a `small` slot 45% wide for the meta and a 72 px `dense` box for the primary; the list is `aria-busy` with one hidden "正在加载 / Loading" (none inside a skeleton group, which announces once). Loading wins over `empty`.
- **Empty** (`CardGrid.empty`): the `page` EmptyState (§6.18) instead of the grid; on a list page the template's `empty` draws it (§5.1).
- **More pages** (`onLoadMore`, `hasMore`, `loadingMore`, `loadMoreError`): as ObjectList's (§6.17): below 600 the sentinel, a skeleton card row while loading and the retry row live in the grid's grouped card; from 600 up a Load more button under the grid.

<!-- states: card-grid -->
States: `default`, `long-text`, `no-description`, `person`, `loading`, `empty`, `narrow`

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
| object-card-meta object-card-person avatar[data-size=16] | person | width | 16 |
| object-card-meta object-card-person avatar[data-size=16] | person | height | 16 |
| object-card-meta object-card-person avatar[data-shape=circle] | person | border-top-left-radius | 50% |
| object-card-meta object-card-person person-name-text | person | font-size | type.small |
| object-card | loading | padding-top | space.4 |
| skeleton-box[data-box=block] | loading | width | 40 |
| skeleton-box[data-box=block] | loading | height | 40 |
| skeleton-text[data-size=body] | loading | height | type.body.line |
| skeleton-box[data-box=dense] | loading | height | control.dense |
| empty-state-text | empty | color | color.ink |
| card-grid | narrow | border-top-left-radius | radius.md |
| card-grid | narrow | background-color | color.panel |
| object-card | narrow | height | 64 |
| object-card | narrow | padding-top | space.3 |
| object-card | narrow | padding-left | space.4 |

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

`ToolPolicyList({ label, rows, policyOptions, onCheck?, onPolicy, onCheckAll?, search?, disabled?, inset?: "card" | "flush", control?: "checkbox" | "switch", readOnly? })` with `ToolPolicyRow { id, label, tooltip?, note?: { text, tone?: "muted" | "warn", action?: { label, onClick, ariaLabel? } }, checked, checkLocked?, policy, locked? }`: the tools an agent may call, each with its policy next to it (the agent page's 工具 section, its 内置工具 rows in the form card and an extension's or connector's tools in the 配置 Sheet; a connector's 工具 tab). It replaces a checkbox list followed by a second list of policy selects that the reader had to match up.

- **Labels**: `label` is the tool's display title (its declared title, e.g. the MCP `title`, else its bare name without the `mcp__<slug>__` / `plugin__<plugin>__` prefix); the model-facing key and the description go to `tooltip` (the key first), never to a second visible line.

- **Rows**: a `ul` named by `label`; one row per tool, at least `row.default` high, `space.1` above and below, gap `space.3`, split by `line-soft` hairlines (never cards, §1). On the left the Checkbox (§6.3) named by the tool's display title (`ink`, one line with an ellipsis; `tooltip` is its hover text, for a human description; a key or the model-facing English description is never drawn). Under the title an optional `note` line (`small`, `muted`; `warn` with the 12 px `circle-alert`: why a selected tool cannot be used now), indented to the title. On the right the policy `Select` (§6.2) at `dense`, `layout.policy-select` (160) wide, named 「<title> 的策略」; it is disabled while the tool is unchecked (the caller passes the default option's value then: a policy only applies to a tool the agent uses). The options are the caller's (默认 / 需审批 / 禁止: a policy can only tighten).
- **Select all** (`onCheckAll`): a head row of the same height under a `line-soft` hairline: the 「全选」 Checkbox (mixed while some rows are checked) and the checked count `n/m` (`small`, `muted`) at the right; it acts on the rows the filter shows.
- **Filter** (`search`, for a group with many tools, about eight or more): a `dense` search Input with the `search` icon above the rows (「搜索工具」), `space.2` above the select-all row; it narrows the rows by title, and with no match shows 「没有匹配的工具」 as the panel EmptyState (§6.18) in the rows' place.
- **Inset**: `card` (default) in a padded box (a form card, a Sheet): the rows reach its padding; `flush` alone in a flush card: rows padded `space.4` at the sides, so the hairlines run to the card's edges (as ItemList, §6.33).
- `disabled` turns every checkbox, switch and select off (while a save runs); a row's `locked` turns its select off (a policy fixed by someone else, the reason in its `note`), its `checkLocked` its checkbox or switch (a tool that cannot be switched now, the reason in its `note`).
- **Note action** (`note.action`): a text button after the note's text, drawn as the in-site link (§6.5: `ink`, `line-strong` underline), that leads to where the note is resolved (待复核 → 去复核, which opens the 复核 tab).
- **Switch** (`control: "switch"`, with `onCheck`): the use control is a Switch (§6.3) at the row's end after the select, named 「启用 <title>」, and the select stays on while the tool is off (a connector's 工具 tab: the default policy is set before a tool is switched on); no select-all row. A connector's tools are grouped by what they declare, one `ToolPolicyList` per group (只读 / 可能写入, each a `Subsection` with its count) in the tab's one card, a filter over both groups above them when there are many.
- **Read-only** (`readOnly`, someone who may not change the tools): each row's policy is its option's label (`body`, `muted`) in the select's column and no checkbox or switch is drawn; what is off is said in the row's `note`.
- **Without checkboxes** (no `onCheck`; `onCheckAll` is then ignored): each row is the title (`body`, `ink`) and its select, the note not indented: a list of policies for tools that are all in use, e.g. a member's own policies on the connector card's 权限 Sheet, one `ToolPolicyList` per group (只读 / 可能写入, each a `Subsection` with its count), the default option marked 「允许（默认）」.
- Groups of tools (an extension, a connector) are not nested lists: in the form card each group is one `ItemList` row (§6.33: its name, the 扩展 / 连接器 tag, a summary meta line 「已启用 12/30 个工具 · 2 个需审批」 and a 「配置」 button) that opens a Sheet (§6.7) holding the group's `ToolPolicyList` with `onCheckAll`.

<!-- states: tool-policy-list -->
States: `default`, `select-all`, `switch`, `read-only`

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
| tool-policy-switch | switch | width | space.7 |
| tool-policy-note-action | switch | font-size | type.small |
| tool-policy-note-action | switch | color | color.ink |
| tool-policy-value | read-only | font-size | type.body |
| tool-policy-value | read-only | color | color.muted |

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

### 6.39 CheckList

`CheckList({ label, rows, onCheck, onCheckAll?, title?, disabled?, inset?: "card" | "flush" })` with `CheckListRow { id, title, mark?, marks?, description?, checked, locked? }`: a multi-select of named things that each carry a line of description (the agent page's 组织技能 and the agent template's 技能, maintainer acceptance 2026-11-12). It replaces a column of checkboxes whose labels ran 「name · description」 in one long wrapping line with the badges squeezed beside them.

- **Rows**: a `ul` named by `label`; one row per choice, at least `row.default` high, `space.1` above and below, its two lines `space.1` apart, split by `line-soft` hairlines (never cards, §1). The first line: the Checkbox (§6.3) named by the `title` alone (`ink`, one line with an ellipsis, the full name as its hover), then the `marks` (`Badge`s: 平台, 内置, 手动) `space.2` after it, which never shrink or wrap. The second line: the `description` in prose, `small`, `muted`, indented to the title (22 px: the box and its gap), cut at one line with an ellipsis and its full text as the hover (`title`); a row without one has no second line.
- **Mark** (`mark`, a thing a plugin brings: the plugin wizard's connector templates): a 24 px mark tile (§6.17, the plugin's icon or the initial) between the checkbox and the title, `space.2` from the title and inside the checkbox's text (clicking it toggles the row); decorative, the title still names the checkbox. The description then lines up under the title (indented by the box, the tile and their gaps).
- **Head row** (`title` and / or `onCheckAll`): a row of the same height under a `line-soft` hairline. With `onCheckAll`, the group's checkbox, its text the group's `title` (500, `ink`; 「全选」 without one) and named 「全选「<title>」」, mixed while some rows are checked, and the checked count `n/m` (`small`, `muted`, tabular) at the right; it acts on the rows given (a page that filters passes only the rows it shows). Without `onCheckAll`, or when every row is locked, the head is the title as text and the row count.
- **Locked** (`locked`): a choice that cannot change (a built-in skill every agent has): its checkbox drawn checked and disabled, the title `muted`; it counts in neither the head's state nor `n/m`, and select-all leaves it alone.
- **Groups and filter**: groups are one `CheckList` each, `space.3` apart (a plugin's skills, the org's own, the built-in ones); with many choices (about eight or more) the page draws one `dense` search Input with the `search` icon above all the groups, narrowing by title and description, and the panel EmptyState (§6.18) when nothing matches, as the connector's 工具 tab does (§6.36).
- **Inset**: `card` (default) in a padded box: the rows reach its padding; `flush` alone in a flush card: rows and head padded `space.4` at the sides.
- `disabled` turns every checkbox off (while a save runs).

<!-- states: check-list -->
States: `default`, `group`

<!-- size-table: check-list -->
| Part | State | Property | Value |
|---|---|---|---|
| check-list-row | default | min-height | row.default |
| check-list-row | default | padding-top | space.1 |
| check-list-title | default | color | color.ink |
| check-list-line | default | column-gap | space.2 |
| check-list-description | default | font-size | type.small |
| check-list-description | default | color | color.muted |
| check-list-all | group | min-height | row.default |
| check-list-group | group | color | color.ink |
| check-list-count | group | font-size | type.small |
| check-list-count | group | color | color.muted |

### 6.40 ScheduleCalendar

`ScheduleCalendar({ range, days, today, now, timeZone, items, collapsed, selectedId?, onSelect, onNavigate, onRange, rangeLabel, scope?, footnote?, loading?, refreshing?, empty?, error?, notLoadedFrom?, onDay?, day? })`, `items` `{ id, day, minute, time, title, meta?, state, mark?, label, person?: { name, avatarUrl } }[]`, `collapsed` `{ id, day, title, summary, failed?, state, label }[]`, `state` `upcoming | running | completed | failed | skipped` (scheduled tasks calendar design §4, §6, §7, §8): the scheduled task runs of a week or a month, recorded runs and planned occurrences on one time grid. Named for its one use: no durations, all-day events or editing. Plain props: the page places every item in the viewer's zone (`day` YYYY-MM-DD, `minute` 0..1439) and writes every label; the component reads no clock and no zone of its own (§2.2): `now` (epoch ms, the page's `useNow`) and `timeZone` only place the now line.

- **Toolbar** (a row of `default` controls on the page ground): 今天, the `chevron-left` / `chevron-right` icon buttons (上一周 / 下一周, 上个月 / 下个月), the range label (`rangeLabel`, mono; with `refreshing` a 14 px `spinner` in `accent` beside it while the previous range stays drawn), then at the right end a `Segmented` 周 / 月 (`onRange`) and, for org admins (`scope`), a `Segmented` 只看我的 / 全组织. Under the box a `small` `muted` footnote (`footnote`: the zone, the horizon).
- **The box**: the grid on the `panel` ground with the `line-card` hairline, radius `md`; it is the one box (§1), nothing inside it is boxed.
- **Week**: an axis column (`layout.calendar-axis`) and seven day columns (Monday first in both locales, at least `layout.calendar-day-min`), headed 「周四 11-12」 (`muted`; today `ink` 500 with its date on the `selected` ground). The axis holds 00:00–23:00, one `layout.calendar-hour` row each, its label `small` `muted` (it carries information, so never `faint`), a `line-soft` hairline per hour across the days and between the columns. The day rows scroll vertically inside the box (12 hours visible) under the pinned header; a new range opens at 07:00, or an hour before its earliest item when that is earlier, instantly, and again when its items first arrive unless the person has scrolled it. A **block** sits at its `minute`, half an hour high (half of `layout.calendar-hour`: 24 px, the tap-target floor), one line: the state icon, the time (mono) and the name (ellipsis), the `mark` (试运行) `muted` after it. Blocks whose half hours overlap share the column side by side, up to two (three left about 51 px each, an icon and a clipped time; coordinator decision 2026-11-13); a cluster that needs more keeps one and draws 「+N」 in the second place (`line` border, `muted`), a Popover of the rest as buttons under the day's name. A Popover's items carry the item states (the dashed `upcoming` border, `muted` `upcoming` and `skipped` text, the `fail` time, the `line-strong` selected border); choosing one closes the Popover, then calls `onSelect`. The **now line** is 1 px `accent` across today's column with a 6 px square at its axis end (the text role of §2.3, "happening now"), `aria-hidden`, not drawn when today is outside the range. A **dense lane** under the day headers holds one chip per collapsed task-day (`collapsed`: the name, the `summary` 「每小时 · 24 次」 `muted`, `failed` 「· 2 次失败」 in `fail` with `circle-x`), drawn only when the range has one.
- **Month**: weekday names (`small` `muted`) over 6 × 7 cells (Monday first, at least `layout.calendar-cell` high, `line-soft` between them). A cell is its day number (`small`; `muted` outside the month; today on the `selected` ground; a button to that day's week when `onDay` is given) and up to three one-line items by time (collapsed tasks first, counting toward the three); with more, the third line is 「+N 项」 (`muted`), a Popover listing the whole day. Days outside the month draw their items; no now line, no tint for past days.
- **Item states** (§2.4; success is not colored, maintainer decision Q2): `upcoming` `clock`, no ground, a 1 px dashed `line` border, `muted` text; `running` `spinner` in `accent`, `selected` ground, `ink`; `completed` `check` in `muted`, `selected` ground, `ink`; `failed` `circle-x` in `fail`, `selected` ground with a 2 px `fail` left marker, `ink` with the time in `fail`; `skipped` `ban` in `muted`, `hover` ground, `muted`. Every block, chip, line and row carries its icon and its full `label`, so no state is told by color alone. Hover draws a 1 px `line` border and no new ground. The selected item (`selectedId`) gets a 1 px `line-strong` border (the neutral selection inside a control, §2.3), never the accent.
- **Agenda** (phones, design §7): seven day buttons (40 px: the narrow weekday and the day number; today `ink` 600 and `aria-current="date"`, the chosen `day` on the `selected` ground and `aria-pressed`, a 4 px `fail` square under a day with a failed run, named in its label) over the chosen day's rows (40 px, `body`: the state icon, the time, the name, the agent `small` `muted` at the right), collapsed tasks first; a day with none says 这天没有运行。 in `muted`. A month's agenda pages by the week of `day`. The component draws the grid and the agenda and CSS shows the agenda while the template frame is narrower than 580 (maintainer decision 2026-11-20: the week grid needs 580 and a 600 window leaves 552) (7 × `calendar-day-min` + `calendar-axis`; a container query, §4.3: a 600 window beside the rail leaves 552), so a phone never paints the grid first; `range="agenda"` forces it at every width (the grid is then not drawn) and folds 周 / 月 and the scope into one `sliders` options Menu (the range choices, a separator, the scope choices). Both the grid and the agenda are in the DOM at the other ranges (CSS hides one), so page tests scope their queries to one of them (`schedule-calendar-grid` or `schedule-calendar-agenda`).
- **Keyboard and names**: the grid is a `group` named by `rangeLabel`, each day a `group` named 「11月12日 周四」 with a visually hidden `h3`; blocks, chips, lines, 「+N」 and the month day numbers are buttons with one tab stop for the grid (roving `tabindex`: the selected item, else today's first, else the first). ↑ / ↓ the previous / next item of the day (month: the same place in the week above / below); ← / → the nearest item in time on the previous / next day with one (month: the previous / next item in order); Home / End the first / last; PageUp / PageDown `onNavigate("prev" | "next")`, focus landing on the same weekday of the new range; `t` `onNavigate("today")` (the focus request waits until the new range has items, focus resting on the grid meanwhile); ↵ / Space open (`onSelect`). When the focused item leaves the data the tab stop falls back the same way. A new `rangeLabel` is announced in a polite live region. Focus draws the 1 px `accent` inset outline of list items (§2.5).
- **States**: `loading` draws the toolbar for real and the grid frame with skeleton blocks (§6.29) in one busy region (`aria-busy`); `empty` (`{ text, hint?, action? }`) draws a `panel` EmptyState (§6.18) on the `panel` ground centered over the grid body, the grid still under it; `error` (`{ retry, code? }`) draws the load-failed line at the top of the box (「加载失败」 with `circle-x` in `fail`, the code `muted`, a `dense` 重试), the grid kept; days at or after `notLoadedFrom` draw no items and a `muted` 未加载 in their header (the kernel cut the range).
- `forced-colors`: borders `CanvasText`, the failed marker, the now line and the agenda dot `Highlight`. Reduced motion: the spinner is static (§6.11).

- **Creator** (state `person`): an item's `person` is its creator, an avatar-only chip at the end of the block, line, row or pop-over item: a 16 circle `Avatar` (§6.30), `flex: none`, pushed to the end by `margin-left: auto` (after the mark). The name is never drawn in the block; it goes into the block's `title` tooltip after the label ("每日简报，研究助手，11月12日 周四 09:00，已完成 · Ada Lovelace"), while `aria-label` stays the caller's `label`. A block without `person` is drawn as before.

<!-- states: schedule-calendar -->
States: `week`, `week-dense`, `month`, `agenda`, `loading`, `empty`, `failed`, `selected`, `person`

<!-- size-table: schedule-calendar -->
| Part | State | Property | Value |
|---|---|---|---|
| schedule-calendar-box | week | background-color | color.panel |
| schedule-calendar-axis | week | width | layout.calendar-axis |
| schedule-calendar-hour | week | height | layout.calendar-hour |
| schedule-calendar-hour | week | color | color.muted |
| schedule-calendar-hour | week | font-size | type.small |
| schedule-calendar-day | week | min-width | layout.calendar-day-min |
| schedule-calendar-day-head | week | color | color.muted |
| schedule-calendar-day-head[data-today=true] | week | color | color.ink |
| schedule-calendar-date[data-today=true] | week | background-color | color.selected |
| schedule-calendar-block | week | height | 24 |
| schedule-calendar-block[data-state=completed] | week | background-color | color.selected |
| schedule-calendar-block[data-state=completed] | week | color | color.ink |
| schedule-calendar-block[data-state=running] | week | background-color | color.selected |
| schedule-calendar-block[data-state=running] schedule-calendar-icon | week | color | color.accent |
| schedule-calendar-block[data-state=failed] schedule-calendar-icon | week | color | color.fail |
| schedule-calendar-block[data-state=failed] schedule-calendar-time | week | color | color.fail |
| schedule-calendar-block[data-state=skipped] | week | background-color | color.hover |
| schedule-calendar-block[data-state=skipped] | week | color | color.muted |
| schedule-calendar-block[data-state=upcoming] | week | border-top-color | color.line |
| schedule-calendar-block[data-state=upcoming] | week | color | color.muted |
| schedule-calendar-more | week | height | 24 |
| schedule-calendar-more | week | color | color.muted |
| schedule-calendar-now | week | background-color | color.accent |
| schedule-calendar-now | week | height | 1 |
| schedule-calendar-footnote | week | color | color.muted |
| schedule-calendar-chip | week-dense | height | 24 |
| schedule-calendar-chip-failed | week-dense | color | color.fail |
| schedule-calendar-summary | week-dense | color | color.muted |
| schedule-calendar-cell | month | min-height | layout.calendar-cell |
| schedule-calendar-weekday | month | color | color.muted |
| schedule-calendar-cell[data-outside=true] schedule-calendar-day-number | month | color | color.muted |
| schedule-calendar-number[data-today=true] | month | background-color | color.selected |
| schedule-calendar-line | month | height | 24 |
| schedule-calendar-more | month | color | color.muted |
| schedule-calendar-agenda-day | agenda | height | space.8 |
| schedule-calendar-agenda-day[aria-pressed=true] | agenda | background-color | color.selected |
| schedule-calendar-dot | agenda | background-color | color.fail |
| schedule-calendar-row | agenda | height | space.8 |
| schedule-calendar-meta | agenda | color | color.muted |
| skeleton-box | loading | background-color | color.selected |
| skeleton-box | loading | height | 24 |
| empty-state-text | empty | color | color.ink |
| schedule-calendar-error-text | failed | color | color.fail |
| schedule-calendar-error-text | failed | font-size | type.small |
| schedule-calendar-block[data-selected=true] | selected | border-top-color | color.line-strong |
| schedule-calendar-block schedule-calendar-person avatar[data-size=16] | person | width | 16 |
| schedule-calendar-block schedule-calendar-person avatar[data-size=16] | person | height | 16 |
| schedule-calendar-block schedule-calendar-person avatar[data-shape=circle] | person | border-top-left-radius | 50% |
| schedule-calendar-block | person | height | 24 |

### 6.41 DeviceNameplate

`DeviceNameplate({ name, origin, state, version?, lastSeen?, created?, badge?, labels? })` (auto mode design §4, P-D14): a device page's head, one flat band, and the only place a device's program version, last seen time and creation time appear.

- **The band**: `panel` ground, the `line-card` hairline, radius `md`, padding `space.3` / `space.4`; `space.4` between its two ends. It is the nameplate itself, never a card in a card (§1), and it carries no accent of its own: the page's one bright element is its status light while the device runs.
- **Left**: the name as the plate (`h2` step, 600, `ink`, one line with an ellipsis), and under it the meta line (`small`, `muted`, `space.2` apart): the origin (`origin`, the device provider's display name such as "Docker devices" or 本机, drawn as the page passes it), the status light, and the optional `badge` (a mode mark: 自动 in `warn`, 沙箱 plain, the network mode of a cloud device).
- **Status light**: an 8 px dot (`space.2`, radius `radius.sm`) followed by the state word, never color alone: `running` `accent` (the one accent), `online` `ok`, `suspended` `warn`, `offline` `muted`. Running is a cloud device's instance; online / offline are a local device's machine.
- **Right**: two mono figures (`small`, `space.5` apart, right-aligned), each a `muted` label over an `ink` value with tabular figures: 程序 / "Program" (`versionLabel(v)`, a dash when the machine has not reported one) and 最后活跃 / "Last seen" (the `DateTime` component — a cloud device's last use, a local one's machine's last seen; 从未连接 / "Never connected" when there is none). `created` adds a third figure after them, 创建时间 / "Created" (the same `DateTime`), so a device's creation time lives on its nameplate and not as a lone KeyValue row on the page; a page without one leaves it out.
- **Phones** (below 600): the figures drop under the name, both ends of the row aligned; a long name still ellipsizes.
- Labels come from the design i18n (§7) and a page may override any of them (`labels`).

<!-- states: device-nameplate -->
States: `cloud`, `local`, `suspended`, `offline`

<!-- size-table: device-nameplate -->
| Part | State | Property | Value |
|---|---|---|---|
| device-nameplate | cloud | background-color | color.panel |
| device-nameplate | cloud | border-radius | radius.md |
| device-nameplate | cloud | padding-top | space.3 |
| device-nameplate | cloud | padding-left | space.4 |
| device-nameplate-name | cloud | font-size | type.h2 |
| device-nameplate-name | cloud | color | color.ink |
| device-nameplate-meta | cloud | font-size | type.small |
| device-nameplate-meta | cloud | color | color.muted |
| device-nameplate-light | cloud | width | space.2 |
| device-nameplate-light | cloud | height | space.2 |
| device-nameplate-light | cloud | border-radius | radius.sm |
| device-nameplate-light[data-state=running] | cloud | background-color | color.accent |
| device-nameplate-light[data-state=online] | local | background-color | color.ok |
| device-nameplate-light[data-state=suspended] | suspended | background-color | color.warn |
| device-nameplate-light[data-state=offline] | offline | background-color | color.muted |
| device-nameplate-figures | cloud | column-gap | space.5 |
| device-nameplate-label | cloud | font-size | type.small |
| device-nameplate-label | cloud | color | color.muted |
| device-nameplate-value | cloud | font-size | type.small |
| device-nameplate-value | cloud | color | color.ink |

### 6.42 KeycapCommand

`KeycapCommand({ command, hint?, copyLabel? })` (auto mode design §4): **one inline row**, not a block — the hint (when there is one) in prose `small`, `muted`, then the command as keycaps, then the copy button beside them. Each word of `command` is its own `kbd`-styled key (1 px `line` border with a 2 px bottom edge, radius `sm`, `panel` ground, `small` mono `ink`) with `space.1` between them. The copy button is a dense ghost (copy 14), it copies the whole command, reads 已复制 / "Copied" for two seconds, and without a usable clipboard selects the keycaps and says to copy by hand. It is the only place the command appears on a page (`capybara-device ceiling set …`), and its accessible name names the command (复制 <command> / "Copy <command>"). Not in the reference set: no state list or size table yet (like `Kbd`, §6.5).

### 6.43 HtmlDocumentFrame

`HtmlDocumentFrame({ src, title })` (file sharing design §4) shows an HTML file as a whole document: the kernel serves it (`/api/v1/html/<token>`) with a CSP that sandboxes it, and this frame is the second layer. With EmbedFrame (§6.9) it is the only component that renders an iframe; `apps/web` never writes one.

- **Fixed attributes**: `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"` (`HTML_DOCUMENT_SANDBOX`; never `allow-same-origin`, `allow-top-navigation` or `allow-forms`, and the caller cannot widen it), `referrerpolicy="no-referrer"`, `title` required (the file name). Scripts run; links open in a new, unsandboxed tab; the document cannot reach the app.
- **Look**: it fills its container (the right panel's body, the shared file page's body), no border, no radius, no padding. A document without its own background reads as a light page in either theme (what it is when opened alone): the frame's ground is the browser's light page color, and a document that declares a dark color scheme paints its own.
- No loading or failure state of its own: the caller shows the panel's loading line until it has a token, and the document's own errors stay inside it.

<!-- states: html-frame -->
States: `ready`

<!-- size-table: html-frame -->
| Part | State | Property | Value |
|---|---|---|---|
| html-frame | ready | width | 560 |
| html-frame | ready | height | 360 |
| html-frame | ready | border-top-width | 0 |

### 6.44 CopyField

`CopyField({ label, value, help?, state? })` (file sharing design §5; copy line ruling 2026-11-21): a labelled value people copy and may see again (a share link, an invitation link, a webhook address, a command among a dialog's steps), unlike SecretReveal (§6.22), which is shown once. It is a `Field`'s shape around a `CopyCode` (§6.58): the label (`body` `ink`, as a Field's label), the CopyCode, then the help when there is one (`muted` prose `small`, as a Field's help), `space.1` apart. The label names the CopyCode's group (`aria-labelledby`) and the help describes it (`aria-describedby`). There is no warning line. Copying, the two-second 已复制, the manual fallback and the framed / unframed look are the CopyCode's.

- **Ruling (2026-11-21): CopyField stays, as the labelled form of CopyCode.** A value that sits among a form's or a dialog's fields, or needs a visible name and a sentence of help, is a CopyField; a value that already has its heading or sentence above it (a card's body, a step's prose) is a bare CopyCode. Until 2026-11-21 CopyField was a read-only `Input` with a separate 复制 button beside it; that look is gone, and no page draws a read-only input with a copy button of its own.

<!-- states: copy-field -->
States: `idle`, `copied`, `manual`

<!-- size-table: copy-field -->
| Part | State | Property | Value |
|---|---|---|---|
| copy-field | idle | row-gap | space.1 |
| copy-field-label | idle | color | color.ink |
| copy-field-label | idle | font-size | type.body |
| copy-code-line | idle | min-height | control.default |
| copy-code-button | idle | height | control.dense |
| copy-code-button | copied | height | control.dense |
| copy-code-manual | manual | color | color.muted |
| copy-code-manual | manual | font-size | type.small |

### 6.47 ListDetail

`ListDetail` is the one behavior of a **list-detail region**: any template part that shows a list beside the open item (mobile layout spec §5.2): the InboxPage's list and detail, `Grid columns="list-detail"` (the agent page's prompt files), the TracePage's waterfall and detail, a record list with its Sheet (the 扩展 pages), and the conversations list with a conversation (medium). Templates use it; a page never builds one.

- **Compact**: the **list is the page** and choosing an item **pushes the detail** full screen (§4.6): the floating row shows back, and back returns to the list at its scroll position. The URL state is the template's own today (a query parameter or a hash). The detail's decisions sit in a sticky ActionRow at the bottom in its compact form (§4.4: the primary a full-width line, the other decisions side by side above it); an item's page is not a second list.
- **Medium and expanded**: two panes while the template frame is at least the **list column plus the detail minimum** wide, else the compact stack. Each template names its minimums; the inbox's are a 320 list and a detail of at least 360 (§5.7). The fit is a container query on the template frame (§4.3 "Side columns fit"), so the rail, the full sidebar and a second viewport segment count correctly.
- **Two viewport segments** (mobile layout spec §8): the list in the first segment, the detail in the second.
- **The list** is `ListDetailList` (`label`, `items`: `{ id, title, trailing?, meta?, at?, waiting?, icon? }` or `groups`: `{ id, label, items }[]`, `current`, `onOpen`; a group's label (`micro` 500 `muted`, padded `space.3 space.4 space.1`) heads its rows, which are a list named by it, and an empty group is left out; an `icon` (a file's type) is a 16 px `muted` icon in the dot slot, unless the row waits; `trailing`, a version, sits beside the title and is never cut, the title taking the ellipsis and carrying its full text in `title`): rows `64` high (a 6 px state dot only for what waits for the person, `warn`; the title `body` `ink`; the meta `small` `muted`, both one line with an ellipsis; the time `micro` `faint` at the end), split by `line-soft`. In two panes the list column is 320 with a `line-soft` right line and the current row is the selected row of §2.3 (`accent-tint` ground and an inset 2px `accent` marker). **The detail** is `ListDetailItem` (`title`, `facts`: `{ label, value, mono? }`, `actions`, `children`), a page body padded `space.4`: its title `h2`, its facts as a KeyValue (`variant="facts"`, §6.5), what the page adds under them, and the ActionRow (`actions`) at the bottom of the pane (as an inspector's). The KeyValue's **keys are translated labels** (频道 / Channel, 内容 / Content), **never raw payload keys** (`channel`, `text`) in the label column (maintainer decision 2026-11-20): a payload field without a translated label stays in the payload's own block (the arguments as code), not among the facts. The label column is one face, the UI skeleton's mono (`small` `muted`), whatever the label's script; the values are in the prose face, and only the 键 / Key row's value, a tool key, stays mono.
- **Back control**: in the compact detail the back is the shell's floating back (§6.56); a `ListDetail` rendered without a shell draws the same button in a bar of its own so the region always has one (`findCompactViolations`, mobile layout spec §11.3).

<!-- states: list-detail -->
States: `compact-list`, `compact-detail`, `two-pane`

<!-- size-table: list-detail -->
| Part | State | Property | Value |
|---|---|---|---|
| float-btn | compact-list | width | touch.float |
| list-row | compact-list | height | 64 |
| list-row | compact-list | padding-left | space.4 |
| float-btn | compact-detail | width | touch.float |
| float-btn | compact-detail | height | touch.float |
| action-row | compact-detail | background-color | color.panel-2 |
| action-row | compact-detail | border-top-color | color.line-soft |
| action-row | compact-detail | padding-top | space.2 |
| action-row | compact-detail | row-gap | space.2 |
| action-primary | compact-detail | height | touch.primary |
| action-secondary | compact-detail | height | touch.hit |
| fact-key | compact-detail | font-size | type.small |
| fact-key | compact-detail | color | color.muted |
| list-pane | two-pane | width | 320 |
| list-pane | two-pane | border-right-color | color.line-soft |
| detail-pane | two-pane | min-width | 360 |
| list-row | two-pane | height | 64 |
| list-row[aria-current=true] | two-pane | background-color | color.accent-tint |

### 6.49 IconPreview

`IconPreview({ src, labels? })` (mobile layout spec §10.2.1): one icon drawn twice, on a light and on a dark ground side by side, so an uploaded app icon is judged on both whichever theme the page is in. It is the picture in an app-icon row of the super admin's 外观 settings; it takes no action.

- **Two tiles**, `space.3` apart, each a square 64 wide and high, `radius.md`, a 1px `line` border, the icon centered at `space.8` (40) with `object-fit: contain`, no filter or mask (the picture is shown as uploaded). The **light** tile is on `color.preview-light`, the **dark** tile on `color.preview-dark`: two fixed grounds, the same in both themes (not `panel` or `bg`, which move with the theme, and not overridable by a theme). The tiles are decorative (`alt=""`, `aria-hidden`) unless `labels` is given.
- **Labels** (`labels: { light, dark }`, optional): a `micro` `muted` caption centered under each tile, `space.1` below it, and the tile takes the label as its accessible name (`role="img"`). Without `labels` no caption is drawn.
- No hover, focus or selected state (it is not interactive). A picture that fails to load leaves the ground empty.

<!-- states: icon-preview -->
States: `default`, `labelled`

<!-- size-table: icon-preview -->
| Part | State | Property | Value |
|---|---|---|---|
| icon-preview | default | column-gap | space.3 |
| icon-preview-tile[data-ground=light] | default | width | 64 |
| icon-preview-tile[data-ground=light] | default | height | 64 |
| icon-preview-tile[data-ground=light] | default | border-radius | radius.md |
| icon-preview-tile[data-ground=light] | default | background-color | color.preview-light |
| icon-preview-tile[data-ground=light] | default | border-top-color | color.line |
| icon-preview-tile[data-ground=dark] | default | width | 64 |
| icon-preview-tile[data-ground=dark] | default | height | 64 |
| icon-preview-tile[data-ground=dark] | default | background-color | color.preview-dark |
| icon-preview-image | default | width | space.8 |
| icon-preview-image | default | height | space.8 |
| icon-preview-tile[data-ground=light] | labelled | background-color | color.preview-light |
| icon-preview-tile[data-ground=dark] | labelled | background-color | color.preview-dark |
| icon-preview-label | labelled | color | color.muted |
| icon-preview-label | labelled | font-size | type.micro |

### 6.50 PersonName

`PersonName({ name, avatarUrl, size, secondary?, initialFrom? })` is a person (an account) in a line, a table cell, a select option or a row that leads with the person: the member lists, owners, authors, the account row's neighbours. It is one inline run that never wraps and draws no box.

- **Avatar**: the circle `Avatar` (§6.30, `shape="circle"`) at `size` 16 or 24, `value` = the image of `avatarUrl` or, when it is `null` or fails to load, the initial of `name` (`muted` on `selected`). 16 in lines, cells and options; 24 in rows that lead with the person (a member row); the sidebar row, the Me page and the profile page use `Avatar` itself at 24, 40 and 64.
- **Name**: one span, `ink`, `type.small` at 16 and `type.body` at 24, on one line with an ellipsis, the full name in `title`; the avatar and the secondary text keep their size and the name takes the cut. `space.1` (4) between the avatar and the name at 16, `space.2` (8) at 24.
- **Secondary** (optional, `secondary`): after the name, `type.small` `muted`, never cut; the same gap as before the name. The email, the role or "you" belong here, never in the name.
- **The viewer** (optional, `initialFrom`): where the viewer is named by a replacement word ("你" / "You", "我" / "Me") instead of their name, `name` is that word and `initialFrom` their own display name: the initial comes from `initialFrom`, so the viewer keeps their own initial (the image, when there is one, is theirs as always). Every person part that takes `{ name, avatarUrl }` (bubble author, card and row meta, HITL `who`, calendar chips) takes `initialFrom` too.
- The run is `inline-flex` with `min-width: 0` and `max-width: 100%` so a table cell or a flex row can shrink it. No hover, focus or selected state: it is not interactive; a link or button around it owns those.

<!-- states: person-name -->
States: `sizes`, `image`, `ellipsis`, `secondary`

<!-- size-table: person-name -->
| Part | State | Property | Value |
|---|---|---|---|
| person-name[data-size=24] avatar[data-size=24] | sizes | width | 24 |
| person-name[data-size=24] avatar[data-size=24] | sizes | height | 24 |
| person-name[data-size=24] avatar[data-shape=circle] | sizes | border-top-left-radius | 50% |
| person-name[data-size=24] avatar[data-shape=circle] | sizes | background-color | color.selected |
| person-name[data-size=24] avatar[data-shape=circle] | sizes | color | color.muted |
| person-name[data-size=24] person-name-text | sizes | font-size | type.body |
| person-name[data-size=24] | sizes | column-gap | 8 |
| person-name[data-size=16] avatar[data-size=16] | sizes | width | 16 |
| person-name[data-size=16] avatar[data-size=16] | sizes | height | 16 |
| person-name[data-size=16] person-name-text | sizes | font-size | type.small |
| person-name[data-size=16] | sizes | column-gap | 4 |
| person-name[data-size=24] avatar[data-size=24] | image | width | 24 |
| person-name[data-size=24] avatar[data-kind=image] | image | border-top-left-radius | 50% |
| person-name-text | ellipsis | height | 20 |
| person-name[data-size=24] person-name-secondary | secondary | font-size | type.small |
| person-name[data-size=24] person-name-secondary | secondary | color | color.muted |

### 6.51 FloatingIconButton

`FloatingIconButton({ icon, label, badge?, onClick?, href? })` is a round button that floats over the page: the chat-first compact shell's menu button (top left, the badge is the pending inbox count) and the back button of a pushed page (mobile layout spec §4.1; touch canvas boards 首页, 会话中, 收件箱).

- **Size**: `control.prominent` (32) round on a fine pointer, `touch.float` (48) under `MOBILE_SIZE_QUERY` (compact or touch, §2.5); the icon 20, `touch.icon.float` (24) there, `ink`, one stroke weight.
- **Surface**: the `float-ground` translucent ground (no frosted glass, §1), a 1px `float-line` hairline, `shadow-float-touch`, `radius.pill`. It is the only box (§1): nothing is drawn inside it but the icon and the badge.
- **Badge** (optional `badge`): `badgeText` of the count: nothing for 0, `99+` above 99, `n+` when truncated. Drawn on the top-right corner (the corner offset -2), 18 high, at least 18 wide, `micro`, `ink` on `selected` with a 2px ring in `bg`. The badge is decoration: the count belongs in `label` ("Menu, 3 pending").
- **Link**: with `href` it is a link (the design `link`), drawn the same.
- **States**: `default`; `badge`; press takes the `hover` ground; keyboard focus is a 2px `accent` outline 2px off the edge.

<!-- states: floating-button -->
States: `default`, `badge`

<!-- size-table: floating-button -->
| Part | State | Property | Value |
|---|---|---|---|
| float-btn | default | width | control.prominent |
| float-btn | default | height | control.prominent |
| float-btn | default | border-top-left-radius | radius.pill |
| float-btn | badge | width | control.prominent |
| float-badge | badge | min-width | 18 |
| float-badge | badge | height | 18 |

### 6.52 Drawer

`Drawer({ open, onOpenChange, label, onNavigate?, children })` and `DrawerLevel({ title, backLabel, onBack, children })` are the chat-first compact shell's menu (mobile layout spec §4.2; touch canvas board 抽屉): a panel from the start edge over a scrim, holding search, the section entries, the recent conversations and the account (the shell composes them from `NavRow`, §6.53).

- **Panel**: `layout.drawer` (320, at most 86% of the window) wide, full height (the safe-area insets pad it), on the `panel` ground with a 1px `line-strong` end line and `shadow-float-touch`; it scrolls vertically inside, and only vertically (`overflow-x: hidden`, the thin scrollbar on the `scroll-thumb`); nothing inside is wider than the panel (the sidebar's conversation section drops its negative side margin here, acceptance 2026-11-22). A `role="dialog"` with `aria-modal="true"` and `aria-label` = `label`.
- **Scrim**: the `scrim` ground over the page, as the bottom sheet's (§6.7).
- **Opening**: the menu button (§6.51) is the only way in: while closed the drawer draws nothing and no element on the screen edge listens for a swipe (the edge belongs to the system back gesture). The panel enters over `motion.overlay`, none under reduced motion. Focus moves to the first row.
- **Closing**: Escape, the scrim, a pick (a link, or a `NavRow` that goes somewhere; a row with a chevron that opens a level is not a pick) and a drag along x toward the start edge past 40% of the panel's width (or above the velocity threshold; the helper of §6.7), anywhere on the panel; a short drag springs back; under `prefers-reduced-motion: reduce` the drag then snaps. Focus returns to the menu button.
- **System back** (mobile app plan Decision 25): on a compact touch window opening pushes one history entry carrying a marker in `history.state`, a `popstate` to an entry without the marker closes it, and every other close pops the entry with `history.back()` once. A bottom sheet opened over the drawer holds its own entry: back closes the sheet, then the drawer. Medium, expanded and fine-pointer windows push nothing.
- **A pick navigates from the page's own entry** (mobile touch plan Task 28): with `onNavigate` (the shell's client navigation), a plain click on an in-app link in the panel, or in a sheet over it, pops every open overlay's entry in one traversal first and navigates once that pop has landed (or after 500 ms if its `popstate` never comes, as the floating back's wait), so one back afterwards returns to the page before and no stale overlay entry is left. A modified click or a link that opens elsewhere stays the browser's; without `onNavigate` the link navigates itself and the entry stays behind. A button pick (a `NavRow` or a row marked `data-drawer-pick`) may navigate in its own click, so the overlays leave their entries rather than race it with a back; a row that keeps the page (`data-drawer-pick="stay"`, the account sheet's 切换平台) pops them as a close does. The account sheet's 退出登录 runs only after the overlays' entries are popped.
- **Levels** (plan Decision 18): `DrawerLevel` replaces the list inside the same panel (技能、连接器、设备…): a back row (the arrow `arrow-left` and the level's `title`, accessible name `backLabel`) as a `NavRow`-sized row on top, then the level's rows. The drawer stays open; back returns to the list and focus lands on the back row on entry.

#### The Drawer standard (maintainer decision 2026-11-22)

Terms: a **Drawer** (zh 抽屉) is the side navigation panel from the start edge; a **Sheet** (zh 底部面板) is the bottom panel (§6.59, its own standard). A Drawer holds navigation only: places to go and the person's own account. Actions on an object belong to an action sheet (§6.61), settings to pages.

- **Anatomy**, top to bottom, on the page ground (`bg`; the panel ground stays for a Drawer that holds bare rows, the reference blocks): (1) the **top row**: a search field (a button drawn as the mobile field: `control.default` high, 44 under the mobile sizes, the `selected` fill, no border, radius `sm` = 12 there, a `search` 16 and 搜索 in `muted`) and beside it the **primary** (新会话: `accent` ground, `on-accent` text, weight 500, `square-pen` and the label, the same height and radius); (2) the **navigation card**: one grouped card (`panel`, 1px `line-soft`, radius `sm`) of `NavRow`s, each `row.default` high (44 under the mobile sizes), the icon column (20, `touch.icon` 22 under the mobile sizes), hairlines (`line-soft`) inset to the label column, a count as a pill (§6.53), a row that opens a level ends in a `faint` `chevron-right`; (3) **content sections**: a label row (the section's name, `small` 500 `muted`, and at its end an optional link such as 全部 in `accent`) over one grouped card of rows (the recent conversations, §6.60); (4) the **foot**: the account as one row (§6.54). The cards are the Drawer's only boxes; nothing is boxed inside them (§1).
- **Sizes**: `layout.drawer` wide (320, at most 86% of the window), full height; the content padded `space.3` at the sides with `space.4` between the blocks; rows from the row tokens, so they follow `MOBILE_SIZE_QUERY` by themselves (§2.5).
- **Scrolling**: one vertical scroller, the panel itself (`overflow: hidden auto`, `overscroll-behavior: contain`); never sideways: every block keeps to the panel's width and a long title ends in an ellipsis. A content section grows with its rows (the recent conversations are capped, 20) and the panel scrolls; the foot is sticky at the bottom on the page ground.
- **Dismissal**: the scrim, a drag toward the start edge (past 40% or the velocity threshold), Escape, the system back (one history entry on a compact touch window), and choosing an item (a link, or a row marked `data-drawer-pick`); a row that opens a level, the account row and a long press on a row do not dismiss it. A long press's release never picks the row under it.
- **Stacking**: one sheet may open over the Drawer (the account sheet, a row's action sheet; a dialog an action opens, such as 重命名, opens over both). Each holds its own history entry: back closes the top one first. A pick in a sheet that goes somewhere closes the sheet and the Drawer; a sheet's own close leaves the Drawer open.
- **Focus**: opening moves focus to the first control of the top row (a ring only when opened from the keyboard); Tab stays inside (`aria-modal`); a sheet over it takes focus and hands it back to the row that opened it; closing the Drawer returns focus to the menu button.

<!-- states: drawer -->
States: `open`, `level`

<!-- size-table: drawer -->
| Part | State | Property | Value |
|---|---|---|---|
| drawer | open | width | layout.drawer |
| drawer | open | background-color | color.panel |
| nav-row | open | min-height | row.default |
| drawer | level | width | layout.drawer |
| drawer-back | level | min-height | row.default |

### 6.53 NavRow

`NavRow({ icon?, label, href?, onSelect?, badge?, current?, trailing? })` is a large navigation row: the drawer's entries (搜索, 收件箱, 智能体, 自动化, 技能、连接器、设备…, an inbox row's count) and the level rows (touch canvas boards 抽屉, 收件箱).

- **Row**: a link (with `href`, drawn through the design `link`) or a button; the icon (20, `touch.icon` 22 on touch, `muted`), `space.3` apart from the label (`ink`, one line, ellipsis), then the optional count and an optional `chevron-right` (`trailing="chevron"`). `row.default` high (44) outside the mobile sizes, `touch.row` (52) under `MOBILE_SIZE_QUERY` (compact or touch, §2.5); padded `space.4` at the sides. No divider and no box: rows sit on the drawer's own surface (§1).
- **Count** (`badge`): `badgeText`, `micro`, `ink` on `selected`, `radius.pill`, at least 20 wide; the row's neighbours do not move.
- **Current** (`current`): `aria-current="page"`, the `selected` ground and weight 500.
- **States**: `default`; `current`; `badge`; press and hover take the `hover` ground; focus is the 1px `accent` inset outline of a nav item (§2.5).
- **Pick**: a link or button row that goes somewhere carries `data-drawer-pick`, which closes the drawer (§6.52); a button row with a chevron opens a level and carries none.

<!-- states: nav-row -->
States: `default`, `current`, `badge`

<!-- size-table: nav-row -->
| Part | State | Property | Value |
|---|---|---|---|
| nav-row | default | min-height | row.default |
| nav-row | default | color | color.ink |
| nav-row[aria-current=page] | current | background-color | color.selected |
| nav-row[aria-current=page] | current | font-weight | 500 |
| navrow-badge | badge | min-width | 20 |
| navrow-badge | badge | font-size | type.micro |

### 6.54 NavDrawer

`NavDrawer({ open, onOpenChange, data, pathname?, onNavigate? })` is the chat-first compact shell's drawer (§4.6; mobile layout spec §4.2; approved mockup 2026-11-22), composed by `AppShell` from `DrawerNavData` inside a `Drawer` (§6.52, the Drawer standard) labelled 菜单 / Menu.

- **Top row**: the search field (a button: it closes the drawer and opens the command palette; there is none without `onSearch`) and the 新会话 / New conversation button (a link to `newConversation.href`, a pick). The round compose button at the foot is gone.
- **Navigation card**: `NavRow`s (§6.53) in order 收件箱 (its `badge`, the pending count, as a pill), 智能体, 自动化 (a guest's data has none), each with `data-nav-section`; the row of the section holding the route is current. Then 更多 / More (`more-horizontal`, a chevron) opens a `DrawerLevel` titled `moreLabel` (技能、连接器、设备…) with the `more` entries (技能, 连接器, 设备 and the org's extension pages; Decision 18); its back row is named 返回菜单 / Back to menu. Without `more` entries there is no 更多 row.
- **Recent**: the label 最近会话 / Recent with 全部 / All at its end (a link to `allConversations.href`, named by its label 全部会话), then `recent` (`DrawerRecent`: `state`, `items`, `activeId?`, `onRetry`, `actions?`, `onRefresh?`: pull to refresh, §6.67) as a `ConversationList` (§6.60) without day sections: my newest conversations **by time, not grouped by agent**, at most 20 (`DRAWER_RECENT_MAX`); a row's long press or right click opens its action sheet (重命名, 归档, 删除) over the drawer. Loading is three skeleton rows in the card, a failure 「会话列表加载失败」 with 重试, no conversation the panel empty state.
- **Foot**: sticky on the page ground: the **account row**, one row (`panel` card, `touch.row` high): the person's `Avatar` circle at 32, the name (500) over the org name (`small`, `muted`), both with an ellipsis, and a `faint` `chevron-right`; it opens the account sheet (§6.55) over the drawer.
- **Picks**: a link anywhere in the drawer (a section, a level entry, a recent conversation, 全部, 新会话) closes it as it navigates; the 更多 row, the account row and a row's long press do not.
- **Back** (Decision 25): a sheet over the drawer holds its own entry, so the first back closes the sheet, the second the drawer, the third navigates.

### 6.55 AccountSheet

`AccountSheet({ open, onOpenChange, data, onDone?, more? })` is a bottom sheet (§6.59) from the drawer's account row, titled 账户 / Account (it replaces the compact Me page; the wide account menu is unchanged). It opens **over the drawer**, which stays under it (§6.54). With the native strip (`nav@1`, interaction model §10.2, D11) the strip's account avatar opens it instead, and there is no drawer under it.

- **Groups** (maintainer decision 2026-11-22), the §6.59 body parts in order: (1) the **profile row**: the `Avatar` 40 circle (the nearest avatar size to the mockup's 44, §6.30), the name (`touch.sheet-title`, 500) over 个人资料与偏好设置 / Profile and preferences (`small` `muted`) and a chevron; the whole row is a link to Personal settings (there is no separate 个人设置 row); (2) **组织 / Organization** (`building`) with the current org's name at its end: with several orgs (`orgMenu`) a chevron and the row opens the org menu, with one org the name only and the row is not a control; 切换平台 (`arrow-up-down`, only with `onSwitchProfile`, a native shell's `profiles@1.show`, Decision 23) follows in the same group; outside an org (the platform console) there is no 组织 row; (3) **语言 / Language** (`languages`) with the current language and a chevron, opening the language choice (on a phone the only language switch), and **外观 / Appearance** (`sun`) with a `Segmented` 浅色 / 深色 at its end (the app has no system theme today, so there is no 跟随系统 part); (4) **退出登录 / Sign out** alone in its group, centred, `fail`, 500; then the install hint (the PWA, while not installed) and the **status line** (context · version · time zone, the same line the wide account menu carries, §6.13) as the sheet's footnote, wrapping anywhere.
- **「技能、连接器、设备…」** (`more`, `AccountSheetMoreItem[]`: `id`, `label`, `href`, `icon`; only the strip's sheet passes it, the drawer's More entries, D11; absent or empty: no row): a group of its own right under the profile row, one chevron row 技能、连接器、设备… / Skills, connectors, devices… (`more-horizontal`) that opens a **level in the same sheet** (no second sheet, one history entry): the title becomes the label, the first group is the back row 返回账户 / Back to account (`arrow-left`; it stays in the sheet, no pick), then the entries as link rows under the label; a pick closes the sheet as any row that goes somewhere. A closed sheet opens at its rows again. **Focus**: entering the level moves focus to the back row, leaving it returns focus to the 技能、连接器、设备… row (quietly from a pointer or touch, with the ring from the keyboard, §6.59 "Focus").
- **Closing**: as any bottom sheet; a row that goes somewhere closes the sheet and the drawer under it, and so does a pick in the org or the language menu; the system back closes the sheet first (it holds its own history entry on a compact touch window).

### 6.56 FloatingBar

`FloatingBar({ lead?, trailing? })` is the compact floating row (§4.6), drawn by `AppShell` in every render and shown below 600 by CSS, absolutely over the page's top (`--cb-float-top` = the top inset + `space.2`; `--cb-float-row` = that + the row height + `space.2`, the space a page leaves under it).

- **Lead**: `menu` (a `FloatingIconButton`, `menu`, named 打开菜单 / Open menu, with the count 打开菜单，3 项待处理 / Open menu, 3 pending, and the badge), `back` (`chevron-left`, 返回 / Back: a link to the path target, or a button that goes back through the history or calls the page's own back) or `steps` (the setup frame's steps, §5.5). A chat surface without a drawer has no lead.
- **Centre** (maintainer decision 2026-11-22; responsive system spec §2.5, §2.6): a conversation's title pill (§6.16.1) or, on a pushed page that scrolls as one scroller (§6.65), the **page title** once the large title has passed under the row (the page reports `titleAway`: `ShellPage.titleAway`), centred, with a `line-soft` hairline under the row's strip; before that, nothing.
- **Trailing**: a page's registered overflow menu as a round floating `more-horizontal` button; none on the home. The overflow is the page's registered menu **plus the head's secondary actions** (`ShellPage.actions`, maintainer decision 2026-11-22; the template registers them, links navigate through the shell's `onNavigate`), the one place for "more" on every pushed page.
- **Row**: `control.prominent` high outside the mobile sizes, `touch.float` (48) under `MOBILE_SIZE_QUERY` (compact or touch); it lets taps through between its controls; not selectable, no long-press callout. A conversation's title pill and overflow (§6.16.1) share the row after the lead.

### 6.57 Desktop-only notice (请在电脑上管理)

`DesktopOnlyNotice({ title, description, url, copyLabel, backLabel, backHref, onCopy })` is the `StatusPage` form (§5, `kind="desktop-only"`) a management page shows on a touch device (mobile touch plan Task 29, layout spec §15 decision 4): the logo, a 16 px `cpu` in `faint` in the code's place, the title 「请在电脑上管理」 / "Manage this on a computer" (`h2`), one sentence in `muted` (「插件、扩展、渠道、组织设置和管理后台这类配置，只在电脑上提供。」), the page's full URL in the code font (`font-code`, `muted`, wrapping anywhere, selectable), then 复制链接 (a `Button`) and 回到对话 (a `LinkButton`, primary, to the conversation home).

- **The gate**: `AppShell`'s `desktopOnly` draws the notice and the page in the server render; the touch query (`TOUCH_QUERY`) shows the notice and hides the page, every other pointer the reverse. After hydration only one is mounted (`useTouch()`): on touch the page's components never mount, so its queries never run. Detection is the pointer media query, never the user agent; a wide window with a fine pointer is unchanged.
- **Flagged entries**: the sidebar's, rail's and 更多 flyout's items and the command palette's commands of these pages carry `data-desktop-only` and are hidden under `TOUCH_QUERY`; the compact drawer has none of them.
- **Held queries**: the web wraps a gated page in react-query's restoring state while the pointer is unknown or touch, so even the hydration commit starts no read. On touch the palette also drops the flagged commands in code (a hardware keyboard opens it).
- Presentation only: the kernel's answers are unchanged. The server render may ship the gated page's own authorized data to a touch device (wasted bytes, not a leak), and the prefetch is kept so the desktop paints fast.

### 6.58 CopyCode

`CopyCode({ value, label?, labelledBy?, describedBy?, state? })` (copy line ruling 2026-11-21): **one line people copy**, a command (`npm install -g @capybara-hq/device@next`), an address or a one-time code, drawn as a one-line code block with the copy button inside it. It replaces the read-only `Input` with a separate 复制 button that pages assembled by hand.

- **Look**: a row, min height `control.default`, padded `space.2` at the start and 2 px at the end. The value in the code font (`font-code`, `body`, `ink`), preserved whitespace, one line; at the end a dense ghost button holding only the `copy` icon (14), named 复制 / "Copy" (`aria-label`, and the same `title`), from the design i18n (`copy.copy`). The group (`role="group"`) is named by `label`, or by the visible label `labelledBy` points at (CopyField's).
- **Copied**: the button shows the `check` icon and the text 已复制 / "Copied" (`copy.copied`, now its accessible name) for 2 s, then the icon alone again; `data-state="copied"` on the block. The button is the same element throughout, so keyboard focus stays on it.
- **Manual** (no `navigator.clipboard`, or `writeText` rejects: an insecure origin, a refused permission): the value is selected, and a `muted` `small` line with `circle-alert` 14 under the block says to copy it by hand (`copy.manual`: 「无法自动复制：已选中，请按 Ctrl+C（⌘C）复制。」 / "Couldn't copy automatically: the text is selected, press Ctrl+C (⌘C) to copy.", `role="status"`, CopyField's copy from before); the button keeps its name for another try. An empty `value` disables the button (a command whose address is not known before hydration).
- **Long values: scroll, not wrap (ruling 2026-11-21).** The line never wraps; a value wider than the block scrolls sideways inside the value (thin scrollbar), as a CodeBlock does, while the copy button stays at the right edge. A command or a link is pasted, not read in pieces, and a wrapped command reads as two (a break at a space looks like a newline in a terminal; a break inside a token hides where it ends). The block is `min-width: 0` and never wider than its container, so it never overflows a dialog, a card or a compact window.
- **Framed or not (ruling 2026-11-21, as CodeBlock §6.9).** On the page ground (and in a pane) the block is framed: 1 px `line`, `panel` ground, no radius. **Inside a box** (a Card, a form card, a Dialog or Sheet, an inline card, a property section; §1) it draws its unframed form by itself: no line, a `panel-2` tint, radius `sm`. There is no `framed` prop: a CopyCode can never draw a second frame inside a box (`findNestedBoxes` lists the framed form, `.cb-copy-code-line:not([data-framed="false"])`, as a box).
- **Touch** (§4.3; `MOBILE_SIZE_QUERY`, compact or touch, maintainer decision 2026-11-22): the copy button is at least `touch.hit` (44) wide and high; the block grows to hold it.
- **Not for**: several lines of code (a CodeBlock, `copyable` for a guide's snippet), a secret shown once (SecretReveal §6.22), the device ceiling command drawn as keycaps (KeycapCommand §6.42), a row action that shares or copies an item's link (a Button in the row).

<!-- states: copy-code -->
States: `idle`, `copied`, `manual`, `in-box`, `long`

<!-- size-table: copy-code -->
| Part | State | Property | Value |
|---|---|---|---|
| copy-code-line | idle | min-height | control.default |
| copy-code-line | idle | border-top-width | 1 |
| copy-code-line | idle | border-top-color | color.line |
| copy-code-line | idle | background-color | color.panel |
| copy-code-line | idle | padding-left | space.2 |
| copy-code-value | idle | color | color.ink |
| copy-code-value | idle | font-size | type.body |
| copy-code-button | idle | height | control.dense |
| copy-code-button | idle | width | control.dense |
| copy-code-button | copied | height | control.dense |
| copy-code-manual | manual | color | color.muted |
| copy-code-manual | manual | font-size | type.small |
| copy-code | manual | row-gap | space.1 |
| copy-code-line | in-box | border-top-width | 0 |
| copy-code-line | in-box | background-color | color.panel-2 |
| copy-code-line | in-box | border-radius | radius.sm |
| copy-code-line | long | width | 320 |

### 6.59 Bottom sheet (底部面板)

**Terms.** A **bottom sheet** (底部面板; `BottomSheet`, `BottomSheetContent`) rises from the bottom edge on the compact class and on touch. A **Drawer** (抽屉, §6.52) is the side panel that slides in from the start (left) edge and holds navigation; the two are never called by each other's name. The wide-window side `Sheet` (§6.7, from the right, for forms and details) is a different component. Every bottom sheet is built from the parts below (maintainer decision 2026-11-22, the approved mockup); no sheet styles its own head, rows or footnote.

- **Users**: the composer's options sheet (会话选项, §6.16.2), the account sheet (账户, §6.55), a ListPage's Filter sheet (§6.7), the pickers that open as a sheet on compact, the long-press action sheet (§6.61, its rows a `SheetGroup` of `SheetRow`s), and every `Dialog` and `DangerConfirm` below 600 (§6.7 "Compact form": the body in the sheet's body, the buttons in a non-scrolling sheet footer).
- **Anatomy**, top to bottom: the **grab handle** (`sheet-handle`, `space.7` × `space.1`, `radius.sm`, `line-strong`, centred `space.2` below the top edge, `muted` while dragging); the **head** (`sheet-head`): `touch.row` (52) high, **no hairline** under it (the groups below separate it), the **title** centred over the sheet (`touch.sheet-title`, 15, weight 600: the bold face, §2.2), one line with an ellipsis, and the **close** (`sheet-close`) at the end: a `touch.sheet-close` (30) circle on the `hover` ground with an `x` glyph `touch.sheet-close-icon` (14) at stroke 2.2, vertically centred, its end edge `touch.sheet-inset` (14) from the sheet's, where the body's groups end; its hit area is `touch.hit` (44) through an invisible ring (`::after`), and its ground is the same at rest, on hover and pressed (only the glyph turns `ink` on hover), so nothing paints when the sheet opens; the **body** (`bsheet-body`), padded `space.2` above, `touch.sheet-inset` at the sides and `space.4` plus the bottom inset below; an optional **footer** (`bsheet-foot`: a dialog's buttons) under the body, outside its scroll, padded `space.2` above, `touch.sheet-inset` at the sides and `space.4` plus the bottom inset below (the body above it then ends `space.2` under its content); the **footnote**.
- **Body parts**: `SheetGroup`, a group of rows on the `hover` ground (`radius.sm`; a ground, not a box: no border, so a sheet holds no box inside its box, §1), groups `touch.sheet-inset` apart; `SheetRow`, `touch.row` high (taller with a lead such as an avatar), padded `space.4`, the icon column (`touch.icon`, `muted`; kept empty in a row without an icon), `space.3`, the label (one line, ellipsis) with an optional `small` `muted` line under it, then a `muted` value, a control or a `chevron-right` (`faint`); rows split by `line-soft` separators from the text column to the row's end; a link row (`href`) is a pick, a button row with a chevron and no action opens something in place (a menu) and is no pick, a `static` row is text; a `centered` `danger` row is a lone destructive action (sign out); `SheetFootnote`, `micro` mono `faint`, centred, `touch.sheet-inset` under the last group, wrapping anywhere. Single-choice picker groups (the options sheet's) keep their option rows (§6.16.2) inside the same body column.
- **Height and scrolling**: one detent: as tall as its content, at most 85% of the viewport (`dvh`); only the body scrolls (the thin scrollbar on `scroll-thumb`), the handle and the head stay; nothing inside is wider than the sheet.
- **In-sheet drill-in** (maintainer decision 2026-11-23; first user: the options sheet's model page, §6.16.2): a row with a `chevron-right` may open a **page inside the same sheet** instead of a list in place, iOS-settings style, when its choice is too long for the sheet. `BottomSheetContent` takes the shown page's key (`page`) and, on a drilled-in page, its way back (`back: { label, onBack }`); the caller keeps the page in its own state and gives the page's `title`. The head then draws the **back control** (`sheet-back`) at its start: the close's circle, ground, hit ring and glyph size (a `chevron-left`), mirrored to the start edge, named by `back.label` (「返回<上一页>」 / "Back to <previous page>"); the title stays centred. The body holds the page in a pane (`sheet-pane`, `data-page`) that slides in when the page changes: a push from the end edge, a pop back from the start (`translateX(±24px)` and a fade, over `motion.push` with `ease.push`, as a pushed page, §4.6; none under reduced motion), and the body scrolls to its top. Esc on a drilled-in page goes back a page; the next Esc, the close, the scrim, a drag or the system back close the whole sheet (one history entry, Decision 25), and the next open starts on the first page. **Focus**: on a push to the first field (a search) when the push came from the keyboard, else quietly to the page's chosen or first item (a tap never raises the keyboard); on a pop to the row that opened the page. A page's groups may carry a visible heading (`SheetGroup heading`: `micro` 500 `muted`, padded `space.4` at the start like the rows' text, `space.1` above the group, `touch.sheet-inset` under the group before it), which names the group. A pick on a single-choice page goes back by itself. Only one level deep.
- **Dismissal**: the close, the scrim, a drag down (§6.7 "Follow-finger sheets"), Esc, and the system back on a compact touch window (it holds one history entry, Decision 25).
- **Stacking**: a sheet opened from the drawer (the account sheet) lies over it; back closes the sheet first, then the drawer (§6.52, §6.54).
- **With the native strip** (the iPhone Duo in the app; interaction model §10.4, §10.7, D13, D16): the **panel stays inside the side insets** (`left: --cb-inset-left`, `right: --cb-inset-right`, so it never lies under the strip on either side) while the **scrim runs full bleed** (`inset: 0`, over the strip's area too; the strip's pill stays live: a tap closes the sheet, then acts). No rule keys on the strip's side (`data-strip`): the insets carry it and the other side's is 0, so a live change of side (a split) moves the open panel by CSS in the same frame, **without a remount** (the sheet, its scroll and its focus stay).
- **Focus**: focus is trapped while open and returns to the opener on close (§6.11). On open it moves to the first control (the close), also in a dialog drawn as a sheet that asks for input (no keyboard jumps up), except a dangerous dialog's, which starts on Cancel (§6.7): from the keyboard with the ring, from a pointer or touch quietly (`data-quiet-focus`, §2.5), so neither a ring nor a ground shows on open.
- **Accessibility**: `role="dialog"`, `aria-modal`, named by its title; the handle is an image named 「拖动以关闭」 / "Drag to close"; the close is named 关闭 / Close.
- **Sizes**: the `touch.sheet-*` tokens (`sheet-inset` 14, `sheet-close` 30, `sheet-close-icon` 14, `sheet-title` 15), `touch.row`, `touch.hit` and `touch.icon`; a bottom sheet exists only where the compact or touch forms apply, so its sizes are these at every pointer.

### 6.60 ConversationList

`ConversationList({ label, items, sections?, activeId?, state?, onRetry?, empty?, actions?, end?, onRefresh? })` lists conversations by time (maintainer decision 2026-11-22): the drawer's recent conversations (§6.54) and the conversations page (`/conversations`). A `section` named `label`.

- **Rows** (`ConversationListItem`: `id`, `title` (null: `untitledLabel(startedAt)`), `startedAt`, `updatedAt`, `href`, `agent { name, avatar? }`, `activity`): a link, `touch.row` (52) high in every class, padded `space.3` at the sides: the agent's `Avatar` (a rounded square, 30, radius `sm`), the title (weight 500, one line, ellipsis) over the agent's name and its state (`small`, `muted`; running: a 6 px dot and 运行中 in `ok`; waiting for the person: a dot and 等你处理 / Needs you in `warn`), and the time at the end (`micro`, the code font, tabular figures, `faint`): `HH:mm` today, 昨天 / Yesterday, the weekday within the last week, `MM-DD` before, `YYYY-MM-DD` in another year (`formatListTime`, in the viewer's zone). The open conversation's row is current (`selected` ground, `aria-current="page"`). No row is boxed: the rows lie in one grouped card (`panel`, 1px `line-soft`, radius `sm`) with hairlines inset to the text column.
- **Sections** (`sections`): 今天 / Today, 昨天 / Yesterday, 本周 / This week (2 to 6 days back), 更早 / Earlier (`dayBucket`), each an `h2` label (`small` 500 `muted`) over its own card; an empty section is not drawn. Without `sections` all rows are one card (the drawer).
- **Actions** (`actions`: `onRename`, `onArchive`, `onDelete`, `archived?`): a long press (500 ms, cancelled by 10 px of movement) or a context menu (right click, two-finger tap) opens the row's action sheet (§6.61) titled with the conversation: 重命名 (a dialog with the title field), 归档 (取消归档 in an archived list), 删除 (fail, a confirmation). From 600 up each row also ends in a ⋯ menu with the same items; below 600 rows carry no buttons (responsive system spec §2.4). The long press never shows the system's link callout and its release never opens the row.
- **The end** (`end { more, loading, error?, onMore }`): while there are more pages, the next one is asked for as the list's end comes within 600 px of the view (an `IntersectionObserver`), never by a button or a 「加载更多」 row; while it loads a muted 正在加载更多会话 line, a failure its message with 重试. The sentinel is the shared `useListSentinel` (§6.17 "More pages"): it asks once per arming, again only after a load has run or more pages come back.
- **States**: `loading` (three skeleton rows in the card, before the first answer), `error` (the failure line with 重试 when nothing is shown), `empty` (the caller's empty state instead of the card).
- **Refresh** (`onRefresh`, a promise): pull to refresh around the list (§6.67), on the conversations page and the drawer's recents; nothing without it or outside the native mobile shell.

### 6.61 ActionSheet

`ActionSheet({ open, onOpenChange, title, items })` is an object's actions on compact (responsive system spec §2.4; the minimal form of plan T0.3, which phase 0 completes with the native `menu@1` form): a bottom sheet (§6.59) titled with the object's name, its `MenuItem`s as the bottom sheet's rows (§6.59: `SheetGroup` / `SheetRow`, `touch.row` (52) high padded `space.4`, the group on the `hover` ground, separators as `line-soft` hairlines), a separator in the items starting a new group, a `danger` item in `fail`. A pick closes the sheet and then runs (a dialog it opens starts over the page); a link item navigates through the design link. `actionSheetItems(ObjectActions)` lists an object's primary first, then its items, a submenu flattened. `useLongPress` is the one long press / context menu hook. **Native form** (maintainer decision 2026-11-22; plan P3, responsive system spec §2.4): in a native shell that offers `menu@1`, a sheet of plain actions (no link item) may be the platform's sheet; a sheet that holds a link stays the web sheet, so `menu@1` is used only for sheets without links, and no page chooses.

The `open` state is the sheet at rest over a list page at the phone size, one group of a primary, two actions and one `danger` action (the same id and box as the reference block).

<!-- states: action-sheet -->
States: `open`

<!-- size-table: action-sheet -->
| Part | State | Property | Value |
|---|---|---|---|
| action-sheet-group | open | background-color | color.hover |
| action-sheet-group | open | border-top-left-radius | radius.sm |
| action-sheet-item | open | height | touch.row |
| action-sheet-item | open | padding-left | space.4 |
| action-sheet-item[data-danger=true] | open | color | color.fail |

### 6.62 List floating action button

The ListPage's primary below 600 (responsive system spec §2.5; plan T0.12): **the head's primary button itself, restyled by CSS** (spec §5.4 "B preferred": one DOM), never a second copy, so the first paint without script, the hydrated page and a live resize across 600 always agree, and the action exists once in the accessibility tree. The template marks itself `data-fab` when its head has a primary; below 600 that button becomes a `touch.prominent` (52) square fixed `space.4` from the end edge and above `--cb-inset-bottom`, radius `md`, the `accent` ground, `shadow-float-touch`, its icon (the action's, else `plus`, drawn only in this form) at 24 in `on-accent`, its label visually hidden and still its accessible name. From 600 up it is the head's ordinary primary. The list leaves room for it at its end. (`ListFab`, a separate element, was dropped: two copies raced the hydration in screenshots.)

- **With the native strip** (`<html data-native-nav>`; interaction model §10.3, D10, D14): the ListPage registers its primary with the shell (`ShellPage.primary`: `id`, `label`, `icon`, and either `run`, the action's `onSelect`, or `href`, a link the shell follows through its `onNavigate`), which sends it as the strip pill's top item on compact; the compact stylesheet then hides the FAB form (`:root[data-native-nav] … [data-head-primary="true"][data-form="fab"] { display: none }`, below 600 only) and the list keeps no room for it at its end. Medium and expanded keep the head's button (the pill keeps 新会话 there). A disabled or loading primary registers nothing, and neither does an empty state that carries the primary (one primary per screen): the pill then keeps 新会话. Without the strip the FAB form is back.
- **More pages** (`ListPage.more`, `ListMoreProps`): passed to the list it holds (`ObjectList`, `CardGrid` or `DataTable`, §6.17 "More pages"); the page never draws its own Load more.

### 6.63 ScopeChips

`ScopeChips({ label, value, options, onChange })` is the list's view choice as chips (responsive system spec §2.2 level 2; `ListPage.scope`): pills `control.default` high (44 under the mobile sizes) in one row that scrolls sideways without a scrollbar, each an optional `Avatar` 16 (an agent) and the label, 1px `line`; the selected one an `ink` fill with `bg` text. A `radiogroup`: arrow keys move the choice, only the selected chip is in the tab order. Distinct from the toggle `FilterChip` (§6.15).

### 6.64 ClassForms

`ClassForms({ compact, wide })` and `useClassForm()` are the one way a design component or template draws a structure that differs per size class (maintainer decision 2026-11-22; responsive system spec §5). The rule: **one DOM restyled** by media queries (class structure) and container queries (frame fit) is the default; a different structure per class is allowed only where the semantics differ (a `table` and a list of links), the interaction differs (row buttons and an action sheet) or the placement crosses a landmark or a scroller (a head action that must sit in the shell's top row). Different sizes, order, wrapping, decoration and a button turning fixed are not reasons.

- **Render** (mechanism A of the spec: the server does not know the width): before hydration both forms are in the markup, each wrapped with `data-class-form="compact"` or `"wide"`, and CSS shows the one that matches the class, so the first paint is right without script; after hydration only the matching form stays mounted (one commit), and a live resize or fold remounts. The hidden copy is `display: none` (out of the accessibility tree, not focusable) and `inert` until it is pruned, so a fast tab key cannot reach it. Ids inside come from `useId`, so the two copies never share one.
- **State**: both forms read the same props and the page's or template's state (a search value, a sheet's open state); neither keeps a competing state of its own.
- `useClassForm()` returns `"compact"`, `"wide"` or `null` (the server and the hydration pass) for a template that must choose in code. No component writes its own `useHydrated` plus a width or touch query pair (`design-dual-render`, §9.1), and pages never read the size class (`web-ui-size-branch`, §9.1): a page declares data, the template draws the form.
- **Where** it is used: `ObjectCard` / `ObjectRow` (buttons and none), `DataTable` (table and mapped rows), `PageHeader` (the path and actions row and none), `ListPage`'s compact bar (search and scopes in the head's tab row and the quick-return block in the scroller), the facet rail and sheet, the sidebar and drawer, the right area and the pushed page. Not used: tabs as a segmented control, Segmented and scope chips, the FAB (one DOM restyled).
- **Test helper** `renderAtClass(width, ui)` (jsdom: stubs `matchMedia`, renders, flushes hydration) for the template tests at 390, 768 and 1440: each landmark and control name occurs once after hydration.

### 6.65 One scroller, the quick-return bar and the scrolled title

On compact (maintainer decision 2026-11-22; responsive system spec §2.6, D7) a pushed page (ListPage, DetailPage, SettingsPage, OverviewPage, TracePage, FormPage, WizardPage) scrolls as **one scroller, head included**: the head no longer stays fixed with only the body scrolling, which on a phone kept some 180 px of head on screen. Exceptions: the conversation keeps its thread scroller, the settings sub-nav stays sticky (decision 2026-11-09), and sticky ActionRows stay.

- **Scrolled title**: when the large title has passed under the floating row (§6.56) the template reports `titleAway` and the row draws the title centred, with a `line-soft` hairline under its strip.
- **Quick-return bar**: the search and the scopes (first level tabs and level-2 chips) are one block, a direct child of the scroller, that scrolls away with the content; scrolling up brings it back under the floating row, scrolling down hides it again (`position: sticky` with the offset animated over `motion.overlay`; none under reduced motion). A scroll has a direction only after a person's gesture on the scroller (wheel, touch, pointer, or a scrolling key outside an editable field), so a programmatic restore keeps the bar shown; typing is no gesture.
- The scroller starts under the floating row; `useCompactScroll` reads `--cb-float-row` again on every window or visual viewport resize.
- **Where it lives**: the template's root, `TemplateFrame` (`data-scroll="one"`), is the scroller of every template with a head (also StatusPage and OnboardingPage); its `TemplateHead` reports the title line, and the frame registers `titleAway` with the shell. In a pushed shell the root is pulled up by `--cb-float-row` and padded back down by it, so it starts at the row's top. The body's boxes stop scrolling on their own below 600. A ListPage hands its quick-return bar to the frame (`bar`); the root then carries `data-bar-hidden` while the bar is away. The InboxPage keeps its two-level stack's panes (§6.47); below 600 its list rows are one grouped card from the shared `--cb-grouped-*` values, with no long press or context menu (decision D6). The scroller stays a flex column: the body takes at least the room between the head and a sticky ActionRow, so a short form keeps the ActionRow at the bottom. A band DetailPage's title is its name band, never the title-less head row.
- **The ListPage's bar** (`data-part="list-compact-bar"`): the search (44, filled, no border, 16 px text), the head's tabs (segmented for two or three, a scrolling tab row for four or more) and the scope chips, in that order, `space.2` apart; the head gives its tab row up to it (`ClassForms`: one search field after hydration; before hydration the compact stylesheet hides the head's row). It sticks at `top: 0` on the page ground, which is right under the floating row: a sticky offset counts from the scroller's padding edge, and the scroller's padding-top is already `--cb-float-row` (an offset of the row again left a row-high gap above the returned bar with the list showing through it, issue #642; the settings sub-nav's sticky offset is 0 for the same reason), and hides by a transform (`translateY(-100% - --cb-float-row)`), never by its box, so hiding never changes the scroll height and a short list neither hides it nor jitters.
- **Scroll restoration** (ListPage): every scroll stores the scroller's position for the location (path and query) in the session, the 50 most recent locations kept. A back or forward traversal to that location owes the position: a list mounting for it gets it in the scroller's ref, before the frame's first read, so the position and the scrolled title come back together; a list kept mounted because only the query changed (same path) gets it in a layout effect, and a list re-rendering after the location left its path takes nothing. A traversal is the popstate being dispatched (a router rendering it eagerly inside the event) or a recorded popstate for the same history entry (the Navigation API entry, else the same location and history length, which cannot tell a later same-length push or replace apart); one no list took is dropped, so a fresh visit always starts at the top. While the content is shorter than the owed position the scroller goes as far as there is, the scroll is not stored, and the restore waits for the content to grow (each render and each size change of the body there now, at most 20 times). A person's gesture drops the owed position without moving the scroller: from then on the position is theirs.
- **The primary's form on the other heads**: TracePage, StatusPage and OnboardingPage keep `primaryForm` `"head"` (the default, §4.2) because none of them carries a head primary today; a primary added to one of them later takes `"block"` (decision D2), as a DetailPage's.
- The page leaves `--cb-float-row` above its first block and the FAB's room (§6.62) at its end. The medium and expanded classes keep the fixed head and the body scroller.

### 6.66 Object actions

`ObjectActions` is one menu model for every object (maintainer decision 2026-11-22; responsive system spec §2.4): `{ primary?: HeaderButtonLike, items?: MenuItem[] }`, the primary being the object's main action (开始会话, 用它创建) and the items the rest in order, `danger` marking destructive ones. `ObjectCard` (`primary` + `menu`), `ObjectRow` (`action` + `menu`) and `DataTable` (`rowMenu`) already carry this data, so pages declare nothing new.

- **Medium and expanded**: as before: a card's primary button and ⋯, an ObjectRow's action and ⋯, a DataTable's row menu.
- **Compact**: the row shows no buttons; a long press (500 ms, cancelled by 10 px of movement) or a context-menu event (right click, two-finger tap, Android long press) opens the ActionSheet (§6.61) titled with the object's name. A row that opens nothing keeps its one action button, and a labelled ⋯ (「行操作：{row name}」 / "Row actions: {name}") when it has more menu items.
- Every action stays reachable on the object's detail page: the page requirement of the system, and the reason nothing hints at the long press (decision D3).

### 6.67 PullToRefresh

`PullToRefresh({ onRefresh, children })` reads a list again on a pull down (mobile interaction model spec §3, D4). Templates and components wrap their list in it when the caller passes `onRefresh` (a promise); a page never draws it.

- **Where**: only in the **native mobile shell on a touch device**: the shell's declared kind is `mobile` (`window.capybaraShell.kind`, read and checked as the shell environment reads it, `useShellKind`; never the user agent, never inferred from a capability) and the pointer is coarse (`useTouch`). The browser keeps its own pull-to-reload (mobile Safari and Chrome; never doubled) and the desktop shell has none: there no listener is added and nothing is drawn; the wrapper is always rendered (no box), so turning active after hydration never remounts the list.
- **Surfaces**: the inbox (`InboxPage.onRefresh`, §5.7), the conversations page (`ConversationList.onRefresh`, §6.60) and the drawer's recents (`DrawerRecent.onRefresh`, §6.54). Nowhere else: lists stay fresh through the query cache and SSE.
- **Gesture**: passive touch listeners, so the scroller's own overscroll bounce plays and the indicator rides on top. A pull counts only when **every vertical scroller under the finger** is at its top when it starts (the inbox's list pane scrolls inside a template that does not) and stays so, and only while the drag is more vertical than horizontal (an axis lock after 8 px: a sideways drag is never a pull). The indicator follows the finger at half its travel (at most 96); the **threshold** is 64 (`PULL_THRESHOLD`).
- **Indicator** (`pull-indicator`, hidden from assistive tech): the `spinner` icon at 16 and a `small` label in `muted`, hung from the top centre of the scroller under the finger and centred there by a translate (`translate(-50%, …)`), portalled to the body (a container-type ancestor would hold a fixed box). Its label says 下拉刷新 / Pull to refresh, past the threshold 松开刷新 / Release to refresh (`data-ready`, the label in `ink`), and 正在刷新 / Refreshing while the refresh runs (`data-pending`, the spinner turning).
- **Release** past the threshold plays the `selection` haptic (`haptics@1`, §7 of the interaction spec) and calls `onRefresh`; the indicator stays at the threshold, spinning, until the promise settles (also on a rejection). A release short of it springs back and does nothing.
- **Accessibility**: one `status` region stays mounted inside the wrapper and says 正在刷新 while the refresh runs, so the announcement is heard. The wrapper adds no box (`display: contents`).

### 6.68 FileTree and FileBrowser

`FileTree({ label, files: { path, size? }[], selected, onSelect, pinned? })` is the archive-previewer tree of a skill's or a package's files; `FileBrowser({ label, tree, open?, onBack?, selected?, children })` lays it beside the selected file's preview. Not in the reference set: no state list or size table yet (like KeyValue).

- **Anatomy**: a `role="tree"`; each row is a `treeitem` of the row height (`row.default`, the mobile size at compact like every control), indented `space.4` per depth. A folder row leads with a `faint` `chevron-right` / `chevron-down` (12) and the folder name; a file row leads with the `file` icon (14), the name (`body`, `ink`, one line, ellipsis) and, at the row end, the size (`small`, `muted`, never cut). The folders come from the paths: `pinned` paths first among their siblings (in that order, before folders: a skill's SKILL.md), then folders, then files, each alphabetical (numbers compare as numbers); a file at the root sits among the root files.
- **States**: folders start open and toggle on click; `hover` ground; the selected file is the selected row of §2.3 (`selected` ground, a 2px accent edge on the start side) with `aria-selected="true"` and `aria-current`; the keyboard focus is the 1px accent ring inset.
- **Keyboard**: one tab stop (the selected file, else the first row); ArrowUp / ArrowDown move, Home / End jump, ArrowRight opens a closed folder or steps into an open one, ArrowLeft closes an open folder or steps to the parent, Enter / Space select a file or toggle a folder. `aria-expanded` on folders, `aria-selected` on files.
- **FileBrowser**: a `ListDetail` (§6.47) with the tree as the list (240 least) and the preview as the item (340 least): two panes while the region is 580 wide or more, else the compact form: the tree alone, and once `open` (a file is selected) the preview is pushed in its place with the back control, which calls `onBack`. In the compact form while the tree is the page no row is drawn selected (nothing is shown yet). Moving: when `open` turns true, or `selected` changes while open, the preview is scrolled into view (`block: nearest`, smooth unless reduced motion is asked for); when `open` turns false the tree's selected row is, so back returns to where the tree was; never on the first render. The preview is the caller's (the web's file preview body); the region draws no box of its own (one box is enough).

## 7. Copy and internationalization
- All UI text goes through next-intl, in both Chinese and English. Text shown to the model (prompts, tool descriptions) is always English, and the prompt field in a form must say so.
- Thousands separators for numbers; amounts `¥412.80`; relative time ("2 hours ago") for lists, absolute time (`10-18 14:02:11`) for records and logs.
- **Durations** (browser review F29, 2026-11-10): one formatter, `formatDuration(ms, locale, { live? })`, for every span a page shows (the Rounds row's 已用, the run row, the context's last run, a tool's elapsed and finished time, sub-agents, background tasks), so one span reads the same everywhere: below 10 s one decimal ("2.1 秒" / "2.1s"), then whole seconds ("42 秒" / "42s"), minutes and padded seconds ("1 分 09 秒" / "1m 09s"), hours and padded minutes ("1 小时 02 分" / "1h 02m"). A `live` timer (it ticks each second while something runs) shows whole seconds rounded down. The trace waterfall's axis keeps its own compact figures.
- Error messages state the cause and give an actionable next step; include the error code and request ID for troubleshooting.
- **Files, not artifacts**: what an agent delivers from its sandbox is "文件" / "files" in UI copy, never "产出物" / "artifacts" (reserved for project C's Artifacts). The kernel identifiers (`artifact_created`, `/artifacts/:id/download`) stay as they are.
- **Untitled conversations** read "未命名会话 · MM-DD HH:mm" / "Untitled conversation · MM-DD HH:mm" (the start time) until a title exists.
- **Tool group wording** (§6.16.8; rows carry no verb: they name the tool, §6.16.9), as the signed reference set B draws them. Counts are Arabic numerals; calls that returned an error append the error dot and their count (§6.16.8; plain text, e.g. an accessible name: " · N 个调用返回了错误" / " · N calls returned an error", one: "1 个调用返回了错误" / "1 call returned an error"), then guard refusals (§6.16.9) "（N 个已拦下）" / " (N blocked)" in the header's own color; mixed kinds join with "，" / ", " in the fixed order command, task, tools (connector, tool, search, meta, question), read, edit:

  | Kind | Group count zh / en | Running header zh / en (N: the group's calls of the running call's kind) |
  |---|---|---|
  | command | 已运行 N 个命令 / Ran N commands | 正在运行 N 个命令 / Running N commands (one: 正在运行 1 个命令 / Running 1 command) |
  | task (`TaskOutput`, `TaskList`: reading background tasks, never a file read) | 已查看 N 次后台任务 / Checked background tasks N times (one: 已查看 1 次后台任务 / Checked a background task) | 正在等待 N 个后台任务 / Waiting on N background tasks (one: 正在等待后台任务 / Waiting on a background task) |
  | read | 已读取 N 个文件 / Read N files (one path: 已读取 <path> / Read <path>) | 正在读取 N 个文件 / Reading N files (one: 正在读取 1 个文件 / Reading 1 file) |
  | edit | 已修改 N 个文件 · +a −b / Edited N files · +a −b (one path: 已修改 <path>) | 正在修改 N 个文件 / Editing N files (one: 正在修改 1 个文件 / Editing 1 file) |
  | search | counted with tools | 正在使用 N 个工具 / Using N tools |
  | connector, tool | 已使用 N 个工具 / Used N tools | 正在使用 N 个工具 / Using N tools (one: 正在使用 1 个工具 / Using 1 tool) |
  | meta | counted with tools | 正在使用 N 个工具 / Using N tools |
  | question | counted with tools (its row: 已提问 <header> / Asked <header>, §6.16.9) | 等待你回答 / Waiting for your answer while it waits |

### 7.1 Copy

The polish checklist below comes from an audit with [unslop](https://github.com/heydamir/unslop) (Damir Sokolovsky, CC BY 4.0), adapted to this product: exact, restrained, a little dry.

- **Periods**: full sentences (descriptions, hints, errors, toasts, empty-state explanations, notices) end with "。" / "."; titles, buttons, labels, menu items, table headers, tabs, short phrase captions ("先配置模型", "设置 · 成员") and inline hints ("运行中发送的消息会在下一步交给智能体") have none. `check:i18n` rule `i18n-label-period` rejects a period at the end of a message whose key names a label (`title`, `label`, `action`, `confirm`, `cancel`, `submit`, `button`, `name`, `tab`, `heading`, `item`, `menu`, `placeholder`, also as the last camelCase word, e.g. `confirmLabel`).
- **Names in messages**: a name interpolated into a toast or notice is quoted: corner quotes 「」 in zh (已启用「待办清单」。, 已移除「deepseek」。), straight double quotes in en (`Enabled "Todo".`).
- **Ellipsis and punctuation**: the ellipsis is the single character "…", never three dots (`i18n-ellipsis`); in Chinese a half-width `?` `!` `:` `;` never follows a Chinese character, use `？` `！` `：` `；` (`i18n-cjk-halfwidth`).
- **One name per object**: conversation is "会话" (not "对话", which stays a verb), sub-agent is "子智能体", rename is "重命名", a created-at column is "创建时间", the new conversation is "新会话" (the workspace has no home page and no "首页"), the admin area is "管理后台" and its first page "概览"; a page's h1 is its nav name.
- **Device modes** (auto mode design §4): a device is 自动 / "Auto" or 沙箱 / "Sandbox"; the sandbox tier words (严格 / 开发 / 开放) are never used for a device's mode, and each mode's explanation is prose. The CLI line is `capybara-device ceiling set …` (the owner ceiling of a local device), mono and once per page (`KeycapCommand`, §6.42); a cloud device's network reads 开放（挡内网） / "Open (private networks blocked)" or 白名单 / "Allowlist". The mode itself is chosen with card radios (§6.3) on the device page's 设置 tab, the same control the organization's sandbox settings use for the same choice: two options, one consequence each, the one that cannot be chosen here saying why on its card. The two-state scale this page used until 2026-11-14 was removed with it.
- **"agent"**: Chinese says "智能体" (sub-agent "子智能体", agent template "智能体模板", the nav item and the page name "智能体"); English stays "agent" (`check:i18n` rule `i18n-zh-agent` rejects the Latin word in zh messages). The create verb is "新建" everywhere (buttons, the setup step, the page title "新建智能体").
- **Roles and the platform**: the roles are "超级管理员" / "Super admin" (the deployment level), "组织所有者" / "Org owner", "组织管理员" / "Org admin", "组织成员" / "Org member" and "访客" / "Guest"; the deployment layer is "平台" / "Platform" (平台目录, 平台统一), a non-official marketplace is "自定义市场源" / "Custom marketplace", and "企业" is never used (`i18n-zh-enterprise`; plugin and component management spec §13.4b, §13.4c).
- **The path is not translated**: the page-head path keeps the route words (`capybara / settings / members`, `/admin / extensions`); they mirror the URL and are the product's signature.
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

6. **One responsive system** (maintainer decision 2026-11-22; responsive system spec §7): `web-ui-size-branch` (part of `check:web-ui`): apps/web pages and components import no size hook (`useSizeClass`, `useMediaQuery`, `useTouch`, `useMobileSizes`, `useClassForm`), no `ClassForms` and no size query (`SIZE_CLASS_QUERIES`, `TOUCH_QUERY`, `COMPACT_QUERY`, `MOBILE_SIZE_QUERY`, `INLINE_RIGHT_AREA_QUERY`, `INLINE_RIGHT_AREA_BELOW`) and read no `window.innerWidth` or `matchMedia` (`AppFrame` and the extension hosts are the reasoned allowlist); a structure that differs per class lives in a design template or component through `ClassForms` (§6.64). `design-dual-render` (a design check): a component may not pair `useHydrated` with a class or touch query outside the `ClassForms` helper. `web-ui-filters-scope`: `ListPage.filters` holds no `Segmented` or `Tabs` (use `scope`, §5.1). `web-ui-template-only-props`: the template-only props (`PageHeaderProps.primaryForm`, Tabs `look`) are set by templates and design components, never by a page. `web-ui-load-more`: apps/web draws no 「加载更多」 / Load more button (a `Button` / `LinkButton` saying a `loadMore` message or the words, or the `LoadMore` wrapper); the page passes `onLoadMore` & co. to `ObjectList` / `CardGrid` / `DataTable` (§6.17); there is no allowlist.

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
- **Value** is a `tokens.json` path or a literal number in px (or a percentage such as `50%`, a circle's radius, measured as its number). Paths: sizes without the `size.` prefix (`row.default`, `control.dense`, `space.3`, `radius.sm`, `layout.sidebar`, `pad.default.x` / `pad.default.y`); `type.<name>` is the size and `type.<name>.line` the line height; colors are `color.<token>` and are resolved for each theme.
- In `/dev/ui` a block is a `ReferenceBlock` (design package; `apps/web` wraps it as `RefBlock`) with the reference block's id and box, on the route `/dev/ui/reference/<component>`. A compact-class block that the reference draws as a whole phone screen (the reference's `r-screen`: the top bar, the body, the bottom navigation or a sticky row) puts its component in a `ReferenceScreen` (`top`, `bottom`, `pad`) inside the block; it stands in for the shell (a `ListDetail` inside draws no back bar of its own) and is for the development catalog only, never a page.
- Pseudo-states in `/dev/ui` blocks (`*-hover`, `*-focus`) are forced by the test with the browser's DevTools protocol on the elements the block names; forced elements get `data-ref-forced="true"`, which size-table parts can select.

### 9.3 Measuring tests

`apps/web/visual/fidelity.spec.ts` (Playwright, both themes) opens `/dev/ui/reference/<component>` for every accepted component and checks every size-table row against the block with the same id: sizes within ±1px, colors exactly equal to the token (compared as computed `rgb()` / `rgba()`). A failure names the component, state, part, property, expected and actual value. A state named `narrow` is drawn and measured in a 390 × 844 window, where the phone rules (§4.3, media queries below 600) apply; every other state at 1440 × 900. jsdom cannot measure layout, so these tests are Playwright only (`packages/design/test/narrow.test.tsx` checks the phone rules' CSS and the stacked table's DOM).

### 9.4 State coverage

The same spec fails when `/dev/ui/reference/<component>` lacks a block for a state in the component's state list (`missingStates`), and `checkSpecTables` (unit-tested in `packages/design/test/spec-tables.test.ts`, run against this document) reports a size table without a state list, a row whose state is not in the list, a value `tokens.json` lacks, and a duplicate marker. A completeness case in the same spec fails unless `ACCEPTED` (`apps/web/visual/accepted.ts`) lists exactly the components that have a state list here: a component cannot get a state list and stay out of acceptance unnoticed.

### 9.5 Interaction tests

Hover, focus, expand / collapse motion and its reduced-motion form, the sidebar keyboard paths, the rail, its conversation sheet, the compact floating row and drawer and the sheets' drags (§6.7, §6.11, §6.13, §6.52, §6.56) are covered by Playwright interaction specs in `apps/web/visual/` (for example `sidebar.interaction.spec.ts`), including "no horizontal page scroll" at 1440 / 1279 / 841 / 840 / 600 / 599 / 390 (at 390 the conversation page's composer also stays inside the window's 16 px gutters).

### 9.6 Side-by-side acceptance

After each change to a reference-set component, `COMPARE=<components> pnpm --filter @capybara-hq/web compare` writes `apps/web/compare-out/index.html`: one row per block, the reference PNG on the left and the implementation's screenshot on the right, dark then light. The differences are listed by severity: **severe** (different structure or layout, a missing state, a wrong color) and **moderate** (a size or spacing off) block the merge; **minor** (rendering details) are listed in the PR. The maintainer reviews the page last. There is no pixel diffing against the reference PNGs: font rendering differs between systems and would cause false alarms; the measuring tests carry the pixel-level constraints.

### 9.7 Screenshot regression

Playwright screenshots the `/dev/ui` catalog and compares against the baseline; any difference fails. The committed baselines contain only the Linux version, generated by the `visual-update` workflow in the pinned Playwright Docker image (the CI `visual` job uses the same image); local (darwin) screenshots are gitignored and only for local comparison. A change is first accepted against the reference set (§9.6), then its baselines are regenerated; updating a baseline requires attaching the diff images in the PR.

### 9.8 CI placement and review

- `pnpm check` (lint job, full on every PR) runs §9.1. The measuring, state-coverage and interaction specs run in the `visual` job, by diff: `apps/web/**`, `packages/design/**`, and `docs/design/{spec.md,tokens.json}` through `EXTRA_INPUTS`. `compare` is a local review tool, not CI.
- Every UI PR is checked against this spec for template choice, density steps, accent color usage, status encoding and ActionRow rules.

## 10. Change process

Adding or changing a component, template or token: change this spec first (the rule, the state list and the size table), change `tokens.json` and the reference set (`docs/design/reference/src`) to match, and get the spec diff reviewed → implement in `packages/design` with `data-part` attributes and the `/dev/ui` reference blocks with the same ids → `pnpm --filter @capybara-hq/web compare` and side-by-side acceptance (§9.6) → re-render the reference PNGs (`reference-update`) and the screenshot baselines (`visual-update`). Pages must not invent new patterns ad hoc.
