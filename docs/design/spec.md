# Capybara Design System Spec (E · Terminal)

> Status: implemented (`packages/design` + `/dev/ui`) · 2026-10-18
> Visual reference: design canvas https://claude.ai/artifact/KsyGe4akVT4KbqUHfHXdXd (two rows "E · Design System", dark / light)
> Visual source of truth: the `/dev/ui` catalog page and the screenshot baselines checked into the repo (`apps/web/visual/`, Linux version); `docs/design/reference/` (canvas export) is not there yet and will be added after the export

This document is the **only specification** for the web UI. The canvas and the screenshots illustrate this document; when they disagree, this document wins and the canvas is corrected.
The implementation lives in `packages/design` (package name `@capybara-hq/design`); `apps/web` only consumes it. Rules that can be checked automatically are enforced by `pnpm check` and the screenshot tests (see §9).

Wording: **must** / **must not** are mandatory; **should** is the default practice, and deviations need a reason stated in review.

---

## 1. Design principles

1. **Character grid**: one monospace font across the whole site, where one Chinese character is exactly two English cells, and the UI aligns on the character grid.
2. **Restraint**: right angles, 1px lines, mostly grayscale; the accent color takes only the five roles listed in §2.3.
3. **Dense and scannable**: numbers are monospaced and right-aligned; status is triple-encoded as "symbol + color + text".
4. **Structure before style**: a page is composed of the App Shell (§4) and page templates (§5); pages never lay out the shell themselves.
5. **Dark first, dark and light from one source**: the two themes share the same set of token names and only change the values.

---

## 2. Tokens

All colors, sizes and shadows may only be used through tokens: the CSS variables `--cb-<token>` in `packages/design/src/styles/tokens.css`, with dark values under `:root[data-theme="dark"]` and light values under `:root[data-theme="light"]`. Color literals are allowed only in `tokens.css`. Tailwind is not used.

### 2.1 Colors

| Token | Dark | Light | Purpose |
|---|---|---|---|
| `bg` | `#0A0A0A` | `#F6F6F3` | Page background |
| `panel` | `#121211` | `#FFFFFF` | TopBar, StatusBar, ActionRow, overlays, Inspector cards |
| `hover` | `#161614` | `#ECECE7` | Hover background, disabled input background, skeleton |
| `line` | `#262624` | `#D6D6D0` | Default 1px line, dividers, input border |
| `line-strong` | `#3A3A37` | `#B5B5AE` | Overlay border, ActionRow top line, hover border, unchecked checkbox |
| `ink` | `#E6E6E3` | `#0A0A0A` | Body text |
| `muted` | `#8E8E89` | `#5E5E5A` | Secondary text, table headers, labels |
| `faint` | `#5A5A56` | `#9A9A94` | Placeholders, disabled text, separator symbols (**must not** carry essential information; contrast is below 4.5:1) |
| `accent` | `#FF6A13` | `#CC4609` | Accent color (§2.3) |
| `accent-hover` | `#FF8240` | `#B83F08` | Solid primary button hover |
| `accent-press` | `#E85A08` | `#A33707` | Solid primary button pressed |
| `on-accent` | `#0A0A0A` | `#FFFFFF` | Text / icons on a solid accent background |
| `accent-tint` | accent @ 12% | accent @ 12% | Selected row / item background |
| `ok` | `#3FD483` | `#16803F` | Success, up |
| `fail` | `#FF5C52` | `#C8302A` | Failure, error, danger, down |
| `warn` | `#F2C14B` | `#8F6500` | Pending approval, unsaved, warning |
| `scrim` | `rgba(0,0,0,.60)` | `rgba(10,10,10,.25)` | Dialog scrim |

The light accent is `#CC4609`: white text on it has a contrast of 4.72:1 (WCAG AA). The original `#FF6A13` with white text is only 2.87:1 and must not be used in the light theme.

### 2.2 Font and sizes

- Font: **Sarasa Mono SC** (OFL-1.1), weights 400 / 700 only. It is the only font on the site; a second font must not be introduced.
- Delivery: subsetted to woff2 at build time (ASCII + the 3,755 level-1 common Chinese characters + the characters the UI actually uses + a symbol table), self-hosted, `font-display: swap`.
- Fallback: `'Sarasa Mono SC', ui-monospace, monospace`.

| Name | Size / line height | Weight | Purpose |
|---|---|---|---|
| `h1` | 20 / 28 | 700 | PageHeader title |
| `h2` | 16 / 24 | 700 | Section title, Dialog title |
| `body` | 13 / 20 | 400 | Default body text, tables, controls |
| `small` | 12 / 16 | 400 | Table header, help text, error messages, StatusBar |
| `micro` | 11 / 14 | 400 | PageHeader metric labels |

- Numbers always use `font-variant-numeric: tabular-nums`.
- No italics and no letter-spacing adjustment (monospace grid).

### 2.3 The five roles of the accent color (only these five)

| Form | Used for |
|---|---|
| Solid (`accent` background + `on-accent` text) | The **only** primary action in a view |
| Outline (1px `accent` border + `accent` text) | Secondary actions that need emphasis, the selected segment, the current page number; a conversation card waiting for a person gets only an outline (`Card tone="accent"`) |
| Underline (`inset 0 -2px 0 accent`) | The current top-level navigation item, the current PageTab |
| Text (`accent` text / `●`) | Something is happening: running, live, auto-refresh countdown, cursor |
| Background + left marker (`accent-tint` background + `inset 2px 0 0 accent`) | The selected row / item / anchor |

The accent color must not be used anywhere else. Up and down use only `ok` / `fail`.

### 2.4 Status encoding

| Status | Symbol | Color | Text |
|---|---|---|---|
| Running | `●` | accent | Running |
| Succeeded | `✓` | ok | Succeeded |
| Failed | `✗` | fail | Failed |
| Pending approval / paused | `‖` | warn | Pending approval |
| Queued | `○` | muted | Queued |
| Cancelled | `⊘` | muted | Cancelled |
| Limit reached | `◆` | warn | Limit reached (stopped after a quota such as the token limit ran out; distinguished from a manual cancel) |

A status must have both a symbol and text; it must not rely on color alone.

### 2.5 Size, lines, corner radius, shadow, layering, motion

- Spacing: multiples of 4 (4 / 8 / 12 / 16 / 24 / 32 / 40).
- Control height: 24 (inside tables, compact) / **28 (default)** / 36 (page-level emphasis). Icon buttons are square.
- Lines: 1px; corner radius: **0** (site-wide).
- Shadows are used only for overlays:

| Token | Dark | Light | Used for |
|---|---|---|---|
| `shadow-1` | `0 8px 24px rgba(0,0,0,.40)` | `0 2px 8px rgba(10,10,10,.08)` | Menu, Popover, Toast, inline menu |
| `shadow-2` | `0 16px 48px rgba(0,0,0,.50)` | `0 8px 24px rgba(10,10,10,.12)` | Dialog, command palette |
| `shadow-sheet` | `-16px 0 40px rgba(0,0,0,.40)` | `-4px 0 16px rgba(10,10,10,.08)` | Sheet |

- Layering: Sheet 40 · Dialog 50 · Popover/Menu 60 · Toast 70.
- Motion: 120ms, fade in + 4px offset, `ease-out`, no bounce; respects `prefers-reduced-motion`.
- Focus ring: controls use `outline: 2px solid accent; outline-offset: 2px`; table rows / list items use `outline: 1px solid accent; outline-offset: -1px`. `:focus-visible` only.

---

## 3. Brand elements

- **Logo**: a pixel capybara, a 14×10 bitmap drawn with a pixel unit of 2px (TopBar) / 3px (empty state) / 6px (auth pages), `shape-rendering: crispEdges`, filled with the accent color. The bitmap (`X` is solid, `O` is the eye cut-out):

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

Every page is made of the following layers from top to bottom, in a fixed order (except auth pages, see §5 T10):

| Layer | Height | Required | Content |
|---|---|---|---|
| TopBar | 40 | Required | Logo · org / environment switcher · top-level navigation · ⌘K search · account |
| PageHeader | 56 | Required | Single line: `parent /` title + count · status ｜ key metrics ≤5 ｜ actions |
| PageTabs | 36 | Optional (detail pages only) | In-page tabs, current item underlined |
| Body | Flexible | Required | One of the five layouts in §4.3 |
| ActionRow | 40 | Optional | Appears when there are changes to submit, stacked above the StatusBar |
| StatusBar | 24 | Required | Context path · page status ｜ system status · version |

### 4.1 TopBar
- Background `panel`, bottom line `line`.
- Top-level navigation: Overview · Agents · Runs · Approvals · Knowledge · Plugins · Settings (subject to the actual product; the order is fixed). The current item is `ink` + accent underline; the others are `muted`.
- A navigation item can carry a count (such as the pending count of the inbox): when greater than 0 it is shown after the name as a count-style Badge (over 99 shows `99+`; `countMore` means the list was truncated and shows `n+`) and is not shown when 0; the link's accessible name includes the count ("Inbox, 3 pending"); when collapsed into "More ▾" on narrow screens it is written into the menu item as "Name (n)".
- Plugin page entry: an "Extensions ▾" dropdown (`Menu`) after the top-level navigation, shown only when there are page contributions; styled like a navigation item.
- The ⌘K input is 220 wide, with prefix `>` and suffix `⌘K`.

### 4.2 PageHeader
- Single line, height 56, left and right padding 16. Top-level and second-level pages have the same height.
- Left: parent path (`muted`, 13px, clickable) + ` / ` + title (`h1`) + count / status (13px). A top-level page has only the title.
- Middle: key metrics ≤5, each as "label (micro, muted) / value (700)", with a 1px `line` vertical rule between items.
- Right: actions, ≤ 1 solid primary action + 2 secondary + a `⋯` menu; the primary action is rightmost. The submit action of form pages **must not** go here; it goes in the ActionRow.
- When there are PageTabs, the PageHeader draws no bottom line, and the PageTabs bottom line closes it off.

### 4.3 The five Body layouts

| Layout | Structure | Used for |
|---|---|---|
| Single | Content | Overview, trace viewer, system status, first use |
| Rail + Content | 240 + flexible | Lists |
| Content + Inspector | flexible + 400 | Details, playground |
| Rail + Content + Inspector | 240 + flexible + 400 | Inbox |
| Centered | anchor navigation 180 + content max 760, whole max 960 centered | Forms, settings, wizards |

- Content has a minimum width of 560. The Rail is collapsible; the Inspector is closable.
- Scrolling: TopBar / PageHeader / PageTabs / ActionRow / StatusBar are fixed; Rail, Content and Inspector scroll independently; the page level must not show a second horizontal scrollbar (wide tables scroll horizontally inside their own container).
- Responsive: < 1280 the Inspector becomes a right-side Sheet; < 960 the Rail becomes a toolbar "Filter" button + Sheet; < 640 the PageHeader metrics fold into `⋯`.

### 4.4 ActionRow and StatusBar
- **The StatusBar has only one form**: 24 high, background `panel`, top line `line`, `small` size `muted`. Left: `> user@org:route` · page status (such as "Filtered 18 / 24", "Auto-refresh 15s"); right: `●` system status · version · time zone.
- **ActionRow**: when the page has changes to submit (forms, bulk edits, approval decisions, wizards) it appears **above** the StatusBar, and the StatusBar is unchanged. Height 40, background `panel`, top line `line-strong`, with a 1px `line` between it and the StatusBar. Left: `‖ N unsaved` (warn) `· N errors` (fail); right: Cancel (ghost) · secondary action (default) · primary action (primary, rightmost).
- A page must not create its own floating / fixed bottom button bar.
- A page writes the "page status" text through `useStatusBar(...)` (rendered by the AppShell's StatusBar); StatusBar and ActionRow are design components, and a page does not render the StatusBar directly.

---

## 5. Page templates

A new page **must** pick one of the following templates; a new template requires extending this section first and going through review.

| # | Template | Body | PageTabs | ActionRow | Typical pages |
|---|---|---|---|---|---|
| T1 | Overview | Single | — | — | Org home, Agent summary |
| T2 | List | Rail + Content | — | During bulk edits | Agents, knowledge bases, plugins, members |
| T3 | Detail | Content + Inspector | Yes | — | Agent, knowledge base, plugin details |
| T4 | Form | Centered | — | Always (submit actions) | Create / edit Agent |
| T5 | Settings | Rail (second-level navigation) + Centered | — | When there are changes | Org, environment, security, billing |
| T6 | Inbox | Rail + Content (+ Inspector) | — | During decisions | Human approval, alert handling |
| T7 | Playground | Content + Inspector | — | — | Trial-run an Agent in conversation, live trace on the right |
| T8 | Trace | Single (top: span waterfall, bottom: span detail) | — | — | Single run detail |
| T9 | Wizard | Centered + step bar | — | Always (Previous / Next) | First-time model, connector and plugin setup |
| T10 | Auth | No Shell, centered card + dither dot matrix on both sides | — | — | Sign in, password recovery, accept invitation, initialization |
| T11 | System status | Single centered | — | — | 404, 403, under maintenance, not enabled |
| T12 | Onboarding | Single centered checklist | — | — | New org, empty environment |

### 5.1 List (T2)
- Rail: faceted filters; each group has a title (muted) + checkbox items + counts (faint).
- Content = one DataTable (§6.6), whose toolbar, bulk bar and pagination all belong to the DataTable.
- Subordinate section (optional, at most one): below the main table with a 24 gap, an `h2` title + one DataTable listing secondary objects closely related to the main object and few in number (such as "Invitations" on the members page); it has no filters or PageHeader metrics of its own, and the create entry stays in the PageHeader. When the secondary objects need their own filters or are numerous, make a separate list page.
- PageHeader: title + total, metrics ≤4, secondary actions on the right + Create (primary).
- StatusBar page status: the number of filter results.

### 5.2 Detail (T3)
- PageHeader: `parent /` name + version (faint) + status; metrics ≤4; actions: Edit (default), Trial run (secondary), `⋯`.
- PageTabs: Summary · Runs · Config · Versions · Permissions · Audit (pick per object type), with counts following in faint.
- Content: card-style sections (1px `line` frame, section header h2 + actions on the right), 16 between sections.
- Inspector: grouped properties, group title small muted, key 8ch wide muted, value single line with ellipsis.

### 5.3 Form (T4)
- PageHeader: `parent /` Create X + draft badge; only auxiliary actions on the right (such as "Import from YAML").
- Anchor navigation: the current item has an accent left marker; a group containing errors gets a `●` (fail) suffix.
- Groups: a two-column grid `220px | 1fr`, group title (700) + description (small muted) on the left, fields on the right; groups are separated by a 1px `line` top line, with 20 padding above and below.
- Fields: label on top (required marked with an accent `*`, optional marked "Optional" in faint); control 28 high; help text and error message below (small); on error the border is `fail` and an actionable suggestion starts with `✗`.
- The ActionRow is always present: Cancel · Save draft (⌘S) · Publish.

---

## 6. Components

All components provide these states where applicable: default, hover, pressed, focus, disabled and loading, in both dark and light.

### 6.1 Button

| Variant | Default | Hover | Pressed | Purpose |
|---|---|---|---|---|
| primary | `accent` background, `on-accent` text, 700 | `accent-hover` background | `accent-press` background | The only primary action of a view |
| secondary | transparent background, 1px `accent` border and text | `accent-tint` background | accent @ 20% background | Secondary actions that need emphasis |
| default | transparent background, 1px `line` border, `ink` text | `line-strong` border + `hover` background | `line` background | Ordinary actions |
| ghost | no border, `muted` text | `hover` background + `ink` text | `line` background | Cancel, low priority |
| danger | transparent background, 1px `fail` border and text | fail @ 12% background | fail @ 20% background | Entry point of a dangerous action |
| danger-solid | `fail` background, `on-accent` text | — | — | Only in a dangerous-confirmation dialog, once the confirmation condition is met |

- Disabled: `faint` text, `line` border (primary gets a `line` background), `cursor: not-allowed`.
- Loading: a spinning character `⠿` before the label, width kept, no repeated clicks.
- Sizes 24 / 28 / 36, horizontal padding 8 / 12 / 16. A shortcut hint follows the label in the form `⌘S`.

### 6.2 Input / Select / Textarea / Stepper
- Height 28, padding 0 8, 1px `line` border, transparent background.
- Hover `line-strong` border; focus `accent` border + `0 0 0 1px accent` outer ring; error `fail` border; disabled `hover` background + `faint` text.
- Prefix / suffix use `faint` / `muted` (such as `>`, `⌘K`, `▾`).
- A Textarea with a character count shows `n / max` (faint) at the bottom right.
- Code-like input (prompts) uses an editing area with line numbers: the line-number column is `faint` + a right line.
- Stepper: `− value +`, with 28-wide buttons on both sides.
- Slider: a discrete block track (20 cells by default, cell width adaptive, 2 between cells, 8 high); the selected part is `accent` and the rest `line`; the thumb is a 4×16 `ink` vertical bar; keyboard ←→ by step, PageUp/PageDown by 10 steps; can be linked with a value input box on the right (8ch wide). When no value is set, the thumb is centered and the track is all `line`, so it doesn't pretend to be some value.
- Reset to default: when a field has been set by the user, a ghost small link "↺ Reset to default" (small) appears on the right of the label row; clicking clears the value and returns to the default display.

### 6.3 Checkbox / Radio / Switch / option card
- All square, 14×14. Checkbox checked: `accent` background + `on-accent` `✓`; indeterminate `–`. Radio checked: `accent` border + a 6×6 `accent` inner square.
- Switch: a 28×16 track + a 10×10 square thumb; on: `accent` track + `on-accent` thumb at the right.
- Option card (rich option of a single choice): 1px `line` border; selected `accent` border + `accent-tint` background.

### 6.4 Tabs / Segmented / Pagination
- Tabs: text + underline when selected (§2.3); hover `hover` background; disabled `faint`.
  - Count `count`: a small `faint` number after the name.
  - Badge `badge` (such as Inspector "Tasks 2/4"): 1px `line` border, small `muted`; when selected `line-strong` border + `ink` text.
  - Alert `alert` (such as "Runs" having something to approve): a small accent square `■` after the name, with screen-reader text "needs attention", so it doesn't rely on color alone.
- Segmented: adjacent buttons share borders, height 24; the selected one is outlined in the accent color.
- Pagination: `1–50 / 1,284` · N per page ▾ · `‹ Previous` page numbers `Next ›`; the current page is outlined in the accent color.

### 6.5 Badge / Kbd / Tooltip / metrics
- Badge: 1px `line` border, small, 6 left and right; the emphasis version is outlined in the accent color; the count version is `ink` background with `bg` text.
- Kbd: 1px `line` border + 2px bottom edge.
- Tooltip: `panel` background + `line-strong` border, small, 400ms delay.
- Up / down: `▲8.2%` (ok) / `▼1.1s` (fail).
- KeyValue: a key-value list (Inspector property groups, detail sections); key muted with a fixed 8ch width, value single line with ellipsis.

### 6.6 DataTable
Structure (top to bottom, in one 1px `line` frame): toolbar / bulk action bar → header → rows → pagination.

- Toolbar: search (`/` focuses), applied filters (default button style, with `✕`), clear all, sort, view switch, column settings. Height 40; the 24 / 28-high controls are vertically centered in it (padding 6 above and below, derived from the centering and not a free spacing value), and it has the same height as the bulk action bar so nothing jumps when one replaces the other in place.
- Frame: `framed` by default (1px `line` frame); when embedded in a Card or flush with the content area, use `framed={false}` to remove the frame.
- Bulk action bar: when ≥1 row is checked it **replaces the toolbar in place**, height 40, `panel` background, left "N selected" (700) + bulk actions (24 high), right "Deselect Esc". An accent border or background must not be used.
- Header: small, muted; the column being sorted is `ink` + `▼`/`▲`; a sortable column shows `↕` and a `hover` background on hover; bottom line `line`.
- Rows: default height 32 (compact 28, with thumbnail 44), cell padding 6 8, 1px `line` between rows.
- Alignment: numbers, durations and amounts are right-aligned; IDs and times are left-aligned; IDs and times use `muted`. An overlong single line is truncated with an ellipsis and the full text is shown on hover with a native `title` (a Tooltip per cell is too heavy).
- Row states (priority from high to low when they occur together): focus ring > selected > checked > hover > default.
  - Hover: `hover` background; the checkbox border turns `ink`.
  - Selected (opens the detail / Inspector): `accent-tint` background + a 2px accent bar on the left.
  - Checked: only the checkbox turns accent; the row background is unchanged.
  - Focus: 1px inner outline in the accent color.
  - Disabled / archived: the whole row is `faint` and cannot be checked.
- Inline menu `⋯`: ≤5 items, the dangerous item at the bottom and separated by a divider; while open, the `⋯` background is `line`. When a row has no available actions it shows no `⋯` (the cell stays, so column alignment doesn't change). The menu has `panel` background + `line-strong` border + `shadow-1`.
- Expanded row: `panel` background, indentation and a `└` leader, showing a summary (such as the first few steps of an execution trace).
- Empty states:
  - Loading: skeleton rows (`hover` / `line` colored bars), no spinner.
  - Empty (first time): pixel Logo (`line-strong`) + one sentence of explanation + the next primary action.
  - No results (caused by filters): `∅` + a description of the current filters + "Clear filters".
  - Error: `fail` frame, `✗ Failed to load` + error code · request ID + "↻ Retry".
- Keyboard: ↑↓ move focus, Space checks, ↵ opens, Esc deselects.
- The header is sticky; when scrolling horizontally the first column sticks to the left.

### 6.7 Overlays

Selection rules: the user needs to decide → Dialog; view / edit one object without leaving the list → Sheet; in-place options / filters → Popover / Menu; feedback on an operation result → Toast (a Dialog must not be used); creating something with more than 6 fields → a form page (T4).

- **Dialog**: width 480 / 640, `panel` background + `line-strong` border + `shadow-2` + `scrim`. Header (h2 title + close ✕) / body (padding 16) / footer (right-aligned: ghost Cancel + primary action, the primary action carries `↵`), with 1px `line` separating header and footer. Esc closes; focus is trapped and returned after closing. Default focus: on the primary action for an ordinary dialog, on Cancel for a dangerous dialog.
- **Dangerous confirmation**: `fail` frame, `fail` title; explains the consequences and recoverability; the object name must be typed, the confirm button is disabled until it matches, and is danger-solid once it matches.
- **Sheet**: slides out from the right, width 480 / 720, `panel` background + `line-strong` left line + `shadow-sheet`; no scrim by default (the list is still operable). Header: name + version + open in a new page `↗` + close `✕`; may contain Tabs; footer: actions. Closing with unsaved changes needs a second confirmation.
- **Links**: the design package is framework-agnostic; links in the TopBar navigation, the PageHeader parent, Tabs and Sheet are rendered through the `link` component of `DesignProvider` (default `<a>`); `apps/web` passes next-intl's `Link` to get client-side navigation and the locale prefix. Pages should not build `<a href>` themselves for in-site navigation.
- **Popover / Menu**: `panel` background + `line-strong` border + `shadow-1`; a filter Popover has a search `>` at the top and "Clear / Apply ↵" at the bottom; a hovered item gets a `hover` background. The trigger button is outlined in the accent color when open and holding a value.
- **Command palette (⌘K)**: width 560, input with a `>` prefix; group titles small faint; the current item has an `accent-tint` background + left marker; key hints at the bottom.
- **Toast**: stacked at the bottom right, `panel` background + `line-strong` border + `shadow-1`, a 2px status-color bar on the left (ok / accent / fail); success auto-dismisses after 4s; an error must be dismissed manually and may carry "View →"; a progress type carries a segmented progress bar.

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
- **Checklist**: each item is `glyph + text`. `pending` `□` `faint`; `in_progress` `▶` accent, the whole row gets an `accent-tint` background + a 2px accent bar on the left + 700, `aria-current="step"`; `completed` `✓` `ok`, text `faint` and struck through with `<s>`. Each item carries screen-reader status text (To do / In progress / Done).
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

1. **Package boundary**: `apps/web` may import UI components and templates only from `@capybara-hq/design`. The import rule is a **blacklist**: `@radix-ui/*`, `cmdk`, CSS-in-JS (`@emotion/*`, `styled-components`, `@stitches/*`, `@vanilla-extract/*`, `styled-jsx`), component libraries (`@mui/*`, `@chakra-ui/*`, `@mantine/*`, `@headlessui/*`, `antd`), `tailwindcss` / `tailwind-merge`, class-name utilities (`clsx`, `classnames`, `class-variance-authority`) and icon libraries (`lucide-react`, `react-icons`) must never be imported; `.css` may only import `@capybara-hq/design/styles.css`. The blacklist grows as new styling dependencies appear.
2. **Template enforcement**: every `page.tsx` under `apps/web/src/app` must render one of the §5 templates imported from `@capybara-hq/design` (aliases and namespace imports are recognized); the Shell layers are rendered only by templates. Two exemptions: the development catalog pages `app/[locale]/dev/**`; and pages that only handle 404 (containing no JSX and calling `notFound()` from `next/navigation`, such as `[...rest]/page.tsx`), whose page is rendered by the StatusPage in the same segment's `not-found.tsx`.
3. **Style ownership**: in `apps/web/src` there must be no `className` / `class` / `style` / `dangerouslySetInnerHTML` attributes (including spread props and `createElement` / `jsx` calls), `<style>` elements, `.css` files, or any color literal (`#hex`, `rgb()`, `hsl()`, `oklch()`, `color-mix()` and so on); layout inside a page may only use the design package's layout primitives (`Stack`, `Grid`, `Card`, `Text`). In `packages/design`, color literals are allowed only in `tokens.css`.
4. **Component catalog page**: `/dev/ui` renders every state of every component and every template page with fixed fake data, in both dark and light.
5. **Screenshot regression**: Playwright screenshots the catalog page and compares against the baseline, and any difference fails; the baselines checked in contain only the Linux version, generated by the `visual-update` workflow in a fixed Playwright Docker image (the CI `visual` job uses the same image); local (darwin) screenshots are gitignored and only for local comparison; updating a baseline requires attaching the diff images in the PR and getting confirmation.
6. **First acceptance**: a comparison page with the canvas baseline image on the left and the real screenshot on the right; the product owner confirms them one by one before the baseline is locked.
7. **Review checklist**: every UI PR is checked against this spec for template choice, accent color usage, status encoding and ActionRow rules.

Items 1–3 are checked by `pnpm check`, and every check has a violating-fixture test.

## 10. Change process
Adding a component, template or token: change this spec and the canvas first → review and confirm → implement in `packages/design` and `/dev/ui` → update the baseline screenshots. Pages must not invent new patterns ad hoc.
