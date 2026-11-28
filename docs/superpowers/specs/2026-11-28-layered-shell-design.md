# Layered shell: ground and paper, no status bar

Status: approved by the maintainer (2026-11-28). Visuals settled on the prototype branch
`feat/ui-layering-prototype` (screenshots "v10"; the prototype is `packages/design/src/styles/layering.css`
plus `AdminHead` in `shell/sidebar.tsx`), reviewed with the maintainer step by step on 2026-11-27/28.

## Intent

The workspace reads as one flat sheet of text: sidebar, page and right panel share one ground and are
told apart by hairlines only. This change gives the shell two planes: a **ground** (the sidebar, the
gutters) and the **paper** (the page, the conversation, the right panel) lying on it, told apart by
colour alone; removes the status bar; and trims the chrome that repeats what the sidebar already says.
Components, spacing, sizes and type are unchanged: only the shell's layering, a few colour values and
three pieces of chrome change.

## Decisions (maintainer, 2026-11-27/28)

1. Reuse the existing components, spacing scale and sizes; no hand-drawn look.
2. From 600 up the page is a surface on the ground, inset by `space.2`, `radius.md`, **no border, no
   shadow** (a shadow on the warm ground drew a grey fringe; the edge is the colour step alone).
3. **One colour rule for both themes:** the paper has the most contrast with the text (lightest in the
   light theme, darkest in the dark theme); the ground steps toward the middle; cards on the paper step
   one level toward the middle too (in light a grey card between the paper and the ground, never a white
   card on the paper); what floats over the paper (menus, popovers, dialogs, sheets, the palette,
   tooltips, toasts, the composer) is `raised`, one step lighter than the cards in both themes; form
   controls sit on `field` (white in light, clear in dark) so they read on a grey card. Amended
   2026-11-28 (card step, maintainer review of the prototype `proto/card-step`).
4. The content keeps its maximum width on every page type (centered, white space on both sides).
5. Inside the paper the page pads by `space.6` (the paper's inset already separates it).
6. A first-level page (scope / page) draws no path row; deeper pages keep it.
7. Sidebar: the org switcher shows the org's name only and draws no box; the admin context is one row
   (管理后台 and 「← 回到工作区」); no line above the account row; nothing framed on the ground.
8. The StatusBar is removed on every class.

## Facts this design builds on (origin/main, 2026-11-28)

- Tokens come from `docs/design/tokens.json` (`pnpm gen:tokens`); the file also lists contrast pairs
  that `check:tokens` enforces (`muted` on `sidebar`, `ink` on `hover` over `panel`, …).
- Light: `bg #FAF9F6`, `panel #FFFFFF`, `sidebar #F3F2EE`, `hover`/`sidebar-active` are dark overlays.
  Dark: `bg #0A0A0A`, `panel #111110`, `sidebar #111110`, `hover #171716`, `sidebar-active #1A1A18`
  (opaque).
- The shell (`shell/app-shell.tsx`, `styles/shell.css`) is Sidebar | column (floating row, main, the
  StatusBar); the conversation page draws its own StatusBar inside its main column
  (`styles/conversation-page.css`). Compact has no StatusBar already (design spec §4.4, mobile layout
  spec §4); its system status, version and time zone are in the account sheet (§6.55).
- `useStatusBar(text)` has two product callers (the inbox pending counts, org and admin); the rest are
  catalog demos.
- `PageHeader` row 1 is the path (required by `web-ui-page-path`; the compact back walks it); the
  desktop drag filler of a page lives in that row (`.cb-pageheader-path > .cb-drag-fill`).
- Template content widths: `layout.content` (1120) for page frames and the ActionRow frame,
  `layout.chat` (720) for the thread.

## Design

### 1. Colours (token values; one new colour token, `field`)

| token | light | dark |
|---|---|---|
| `sidebar` (now also the shell ground from 600 up) | `#F3F2EE` → **`#EDECE7`** | `#111110` → **`#171716`** |
| `bg` (the paper) | `#FAF9F6` → **`#FDFDFC`** | `#0A0A0A` (unchanged) |
| `panel` (cards on the paper) | `#FFFFFF` → **`#F9F8F5`** | `#111110` (unchanged) |
| `panel-2` (half a step from the paper toward `panel`) | `#FCFBF9` → **`#FBFAF8`** | `#0E0E0D` (unchanged) |
| `raised` (what floats over the paper) | `#FFFFFF` (unchanged; now also menus, dialogs, sheets, palette, tooltips, toasts) | `#141413` (unchanged; same) |
| `field` (new: the ground of a form control) | **`#FFFFFF`** | **`rgba(0,0,0,0)`** (clear, as before) |
| `fail` | `#C8302A` → **`#C42E28`** | `#FF5C52` (unchanged) |
| `hover` | `rgba(26,26,24,0.04)` → **`rgba(26,26,24,0.045)`** | `#171716` → **`rgba(255,255,255,0.04)`** |
| `sidebar-active` | overlay (unchanged) | `#1A1A18` → **`rgba(255,255,255,0.07)`** |
| `selected` | overlay (unchanged) | `#1F1F1D` → **`#21211F`** |

Dark `hover` and `sidebar-active` become overlays like the light ones, so they read on the ground and on
the paper alike (an opaque `#171716` hover would vanish on the new ground). Two values follow from
the `check:tokens` separation rules on the new ground (implementation, 2026-11-28): the light `hover`
overlay goes from 0.04 to 0.045 (hover on the darker sidebar stays above the 2.5 floor), and the dark
`selected` lightens one step so it still stands further from the ground than hover. The existing contrast pairs
must still pass (`check:tokens`); the light `bg` change also lightens every compact page, which is
intended (one paper colour). `preview-light` keeps `#FAF9F6` (an icon preview ground, not the page).

**Card step (amendment, 2026-11-28).** The light `panel` was lighter than the paper, so a card (the tool
box above all) vanished on it. It now steps toward the middle like dark's: `#F9F8F5`, 1.5 OKLab
lightness below the paper and 3.7 above the ground; `panel-2` is re-derived half a step between paper
and panel, so code and io inside a card are a slightly lighter inset in light as they are a darker one in
dark. Overlays move from `panel` to `raised` (`.cb-menu`, `.cb-popover`, `.cb-cmenu`, `.cb-cmm`,
`.cb-dialog`, `.cb-sheet`, `.cb-bsheet`, `.cb-drawer`, `.cb-palette`, `.cb-tooltip`, `.cb-trend-tip`,
`.cb-toast`, `.cb-skip-link`, `.cb-conv-latest`, and an unframed table inside a dialog or sheet), so they
stay one step lighter than the cards in both themes. Controls get the new `field` ground
(`.cb-input`, `.cb-select`, `.cb-textarea`, `.cb-stepper`, the `.cb-segmented` track, checkbox and
radio boxes): white in light, clear in dark (dark is unchanged); the compact filled search fields keep
their filled ground. Light `fail` darkens one step so it keeps 4.5:1 on `selected` over the grey
card. New `check:tokens` pairs: ink, muted and disabled on `field` over `panel`; ink on hover and
selected over `raised`, fail and disabled on `raised`; hover and selected separation on `raised`. The
steps themselves (panel between paper and ground, panel-2 between paper and panel, raised above panel)
are a test of the built-in values (`packages/design/test/layering-steps.test.ts`), not token pairs:
the token pairs also bind themes, and a theme need not layer like the built-in palette.

**Themes and `field`.** A theme scheme that leaves out a token takes the built-in value, but the
built-in light `field` is white only because the built-in cards are grey. So a scheme that recolours
`panel` without naming `field` gets clear fields (`themeSchemeFallbacks` in the SDK, used by
`mergeThemeSchemes` and the kernel's theme stylesheet): its controls look as they did before `field`
existed. A theme author who wants filled controls names `field` in each scheme; the readability check
then holds ink, muted and disabled on it over the theme's panel. Existing themes (theme-cyberpunk, dark
only, recolours `panel`) render unchanged and still pass the readability check.

### 2. The shell from 600 up (`styles/shell.css`, `styles/conversation-page.css`)

- `.cb-shell` paints `sidebar`; the sidebar keeps its own `sidebar` ground (the same colour, so it
  reads as the ground in the shell and drawn alone) and has no right line.
- `.cb-shell-main` is the paper: `bg`, margin `space.2` on top, end and bottom (start: the sidebar's
  edge), `radius.md`, clipped, no border, no shadow.
- The conversation page: the main column and the inline right panel are two papers side by side,
  `space.2` apart; the shell main draws none itself. The panel's own start line goes; its resize handle
  sits in the gap.
- Inside a template `--cb-content-pad` is `space.6` (compact keeps 16).
- Compact (below 600): unchanged (full-bleed page, floating row).
- **The rail-drop band (desktop shell, #1046).** Where the window's start controls reach past the
  rail (`--cb-shell-rail-drop`, the macOS traffic lights 92 wide beside the 48 rail), the rail's
  form (medium, or collapsed on expanded; `--cb-shell-paper-drop`) has the top row as one band of
  ground across the whole window, and the band holds the paper's first row after the lights and the
  band's sidebar toggle: the conversation title bar, or a deeper page's path row (with its filler).
  The conversation title bar is the band's whole row (maintainer decision 2026-11-28): its end group
  (panel, files, tasks, plugins toggles) sits at the window's end edge, above the inline right
  panel's paper when it is open, and its end padding keeps clear of an end reserve. The paper's
  colour, and the inline right panel's paper, start at the band's bottom edge (the controls'
  bottom), and the next row (the thread, the title row) starts on it. **Optical centring (maintainer
  decision 2026-11-28, both bands):** the row is centred on the controls, and the paper starts where
  its icons lie as far above the paper as below the window's top edge; with controls from the
  window's top edge that is the controls' bottom, which the paper never starts above (48-high
  caption buttons: their square hover grounds end where the paper starts; the macOS lights, 14 high,
  lie 17 below the top and 17 above the paper; a 28 control 10 and 10). It replaced the `space.2`
  gap below the band (16 above a glyph, 24 below it). A first-level page has no path row: its band
  holds only the lights and the toggle. Nothing moves in the DOM (no portal or slot): the row stays
  its paper's first row and keeps the top-row rules (height and centring on the controls, start
  after the toggle, end clear of an end reserve); the paper's box starts at the window's top edge,
  transparent, and its colour is a layer below the band. The full sidebar (the lights over its brand
  row), compact and a banner are unchanged.
- **The end-controls band (desktop shell, #1065).** Where the shell reports its window controls on
  the end side (the Windows / Linux caption overlay, 138 × 48 at the window's top-right edge), the
  same band is drawn in every form from 600 up, beside the full sidebar too: the top row is ground
  at the controls' height (`--cb-shell-row-end`, which feeds `--cb-shell-paper-drop`), the paper's
  first row (the conversation title bar with its breadcrumb and end group, right-aligned and clear
  of the controls; a deeper page's path row) sits in it beside the caption buttons, and the papers
  (the conversation's and the inline right panel's, a page's) start at its bottom edge (optical
  centring, above) with one top edge, so nothing jumps when the panel opens or closes and the
  system's square hover and close grounds always lie on the ground. The band holds only what the
  conversation band holds, a path row and the panel toggles (maintainer decision 2026-11-28,
  #1096): a first-level page's head (the large title, its actions, the tabs) stays in the paper as
  on macOS, `space.5` below the band, and its band holds the caption buttons alone, as the rail's
  form on macOS holds the lights and the toggle. **Start and end differ by
  maintainer decision (2026-11-28):** start controls (the macOS traffic lights) keep the band to the
  rail's form, and beside the full sidebar the paper keeps its first row (the lights sit over the
  sidebar's brand row, not over a paper). It is keyed on the reported rectangle alone; without
  controls (a browser) and below 600 (the flat title bar) nothing changes.
- **The band's search field (maintainer decision 2026-11-28).** Wherever the window's top row is a
  band of ground (the start controls' band in the rail's form, the end controls' band in every form
  from 600 up), the band's centre holds a search field so the band never looks empty: it looks like
  an input (the field ground, a `line` border, `radius.sm`, `control.default` high, the search icon
  and 搜索 / Search in `muted`), sits at the centre of the band's free span on the controls' row (from
  the paper's start edge, after the sidebar or the rail, to the caption buttons or the window's end
  inset; not the window's centre, which lies left of the span beside the full sidebar, and not after
  the path row, so it never moves as the path's length changes), has an accessible name (搜索或执行命令),
  keyboard focus with the 1px inset ring and `aria-keyshortcuts` Ctrl/⌘ K, is no drag region, and
  opens the command palette exactly as the sidebar's search button does. While it shows, the
  sidebar's (or the rail's) search button gives way to it. It is never drawn on a conversation
  (`/chat/<id>`), whose band row (path, title, panel toggles) is full, and it hides (the button
  comes back) wherever it would come within 12 px of the band row's content (a path or title, a path
  row, the panel toggles, the band's sidebar toggle), the sidebar or the window controls, measured
  again on resize and on every page change. Without a band (macOS beside the full sidebar, a
  browser, compact, a banner, a frame without a palette such as the setup frame) nothing changes.
- **A first-level head beside the full sidebar (maintainer decision 2026-11-28).** A head without a
  path row reserves the window's top row only where controls reach into the content column (end
  controls, or start controls past the visible sidebar: `--cb-shell-head-row`); beside the full
  sidebar, where the lights lie over the sidebar, it starts `space.5` into the paper as in a
  browser, and the paper's top gutter is `space.2` (the title row's filler drags the window).

### 3. Page head (`shell/page-header.tsx`)

- From 600 up the path row is not rendered when the path has two segments or fewer (scope / page);
  the title row starts the head. Compact already draws no path row. The `path` prop stays required:
  compact back and `web-ui-page-path` use it.
- **Header tabs are one level (maintainer decision 2026-11-28).** A head whose tabs are routes (each
  tab its own page) is one place: every tab's route stands at the level of the head's first tab
  (`headPath`: the segments a tab's route adds to the first tab's route go), so no tab of such a
  head draws a path row (`/admin/connectors/templates`, `/admin/agents/templates`,
  `/admin/plugins/market`, `/admin/plugins/pending` like their first tabs). A truly deeper page (an
  item's detail, an upload or import wizard, a create form, the marketplace sources page) has no
  such tabs and keeps its path row.
- The title row gains a `DragFill` between the title block and the actions (§5), so a page without
  a path row still has a drag area; in the desktop shell the head's top padding above the title row
  drags too (a filler laid over the padding, as high as it, scrolling with the head; maintainer
  decision 2026-11-28), so every page drags along its top and no control lies under a filler.
- **Names, not URL slugs (maintainer decision 2026-11-28).** The path's segments are the places'
  names, the sidebar's and the tabs' (`管理后台 / 连接器 / 模板`, `Admin console / Connectors /
  Templates`; the admin scope is 管理后台, no longer `/admin`), translated through the `path`
  messages (apps/web `usePathWord`); object names stay as they are.

### 4. Sidebar (`shell/sidebar.tsx`, `styles/sidebar.css`)

- `OrgSwitcher`: the name line only (the `~/<slug> · <role>` line goes; the switch menu keeps both);
  no border and no ground; hover shows `hover`. The rail form is unchanged.
- Admin context, full sidebar: one block, the shield, 管理后台 and a dense link 「← 回到工作区」 at its end
  (`control.dense` high, `pad-dense-x`, `radius.sm`, `small` type; `aria-label`/`title` carry
  「回到工作区 ~/<slug>」). The rail keeps today's shield and back button. `ContextBlock`'s scope line
  (整个部署 · /admin) goes.
- `.cb-sidebar-foot` loses its top line.

### 5. Desktop drag regions (`styles/shell-environment.css`)

Existing rules hold: only dedicated empty fillers and the controls band drag, never a container with
controls, every overlay is no-drag. Added:

- the paper's top gutter (`space.2` of ground above it) is a filler across the content column;
- the page head's title row filler (§3); the path row filler stays for deeper pages;
- the conversation title bar, the right panel's head and the sidebar brand row keep theirs.
- in the rail-drop band (§2) the band's rows keep their fillers (the title bar's, the path row's;
  the title bar's runs over the inline panel, whose box starts below the band); over a first-level page the gutter is the
  band's whole height; the controls area (`.cb-shell-band`) covers the
  lights; the toggle and the rows' controls are no-drag, and every overlay stays no-drag.

The gap between the two conversation papers is the panel's resize handle, not a drag region. The
macOS traffic lights and a Windows caption overlay keep using the shell's reserved start / end insets;
on Windows the head's actions keep clear of the end reserve. The background the page reports to
`chrome@1.setAppearance` (the Windows caption overlay's colour) is the ground (`sidebar`) from 600 up
and the page (`bg`) below it, the colour at the window's top edge in each class.

### 6. Removing the StatusBar

`StatusBar`, its CSS, its reference blocks, size table and states, and `useStatusBar` are deleted
(pre-0.1.0: no compatibility layer). What it showed moves:

| it showed | now |
|---|---|
| `<login>@<org>:~/<path>` | dropped (the URL and the path row say it) |
| page status (inbox pending count) | the inbox page head's `count` and the sidebar badge, which already show it |
| conversation: round, elapsed | the properties panel's Context section (§6.16.17) |
| conversation: idle / running / failed | the composer (stop button), the process block and the failed card, as today |
| conversation: context used % | a small context meter beside the composer's send button (a ring, `control.dense`, `muted`; tooltip 「上下文已用 43%」; `fail` tone past the compaction threshold) |
| system status | shown only when not ok: a `fail` dot on the account row, and the status line at the top of the account menu (as the compact account sheet does) |
| version, time zone | the account menu's footer line (as the compact account sheet) |

The ActionRow is unaffected: it stays fixed at the bottom of the paper (from 600 up) and sticky above
the safe area on compact. §4.4 keeps the ActionRow and loses the StatusBar.

### 7. Size classes

| | compact | medium | expanded |
|---|---|---|---|
| Ground / paper | none (full-bleed paper) | rail on the ground, one paper | sidebar on the ground, one paper (two on a conversation with the panel inline from 1280) |
| Right area | pushed page | side sheet over the paper | inline paper from 1280, side sheet below |
| Path row | none | first level hidden | first level hidden |
| StatusBar | none | none | none |

### 8. Not in this change

- UI font roles (sans vs Sarasa mono for chrome): open, its own comparison and decision.
- The composer ＋ / / / @ menus and the file library (their own specs:
  `2026-11-27-file-library-design.md`, composer menus to come).
- Path labels as page names (§3).

## Spec and doc changes

- `docs/design/spec.md`: §2.1 colour values; §4 shell (two planes, paper inset, no border / shadow);
  §4.1 sidebar trims; §4.2 path row rule and the title-row filler; §4.3 content pad inside the paper;
  §4.4 StatusBar removed; §6.13 sidebar; §6.55 unchanged (compact already carries status there); the
  context meter added to §6.16.2 (composer) with its states and size table.
- `docs/superpowers/specs/2026-11-19-mobile-layout-design.md` §4 table: StatusBar "Shown" → none on
  every class.
- Reference set (`docs/design/reference/src/`): shell, sidebar, page head, status bar (removed),
  composer (context meter) blocks redrawn; rendered by the `reference-update` workflow; visual
  baselines by `visual-update`.
- `writing-web-ui` skill: drop `useStatusBar`; note the paper and the path rule.

## Tests (outline)

- Design (jsdom): `PageHeader` renders no path row at two segments from 600 up and keeps it at three;
  the title row holds one `DragFill`; `OrgSwitcher` has no meta line; the admin head's back link keeps
  its accessible name; the context meter's states; no `StatusBar` export (API report).
- `drag-regions.test.tsx`: the new fillers are empty elements; overlays carve them out.
- `check:tokens`: the changed values pass every contrast pair.
- Card step: `layering-steps.test.ts` holds the built-in steps (panel between paper and ground,
  panel-2 between paper and panel, raised above panel); the field fallback is tested in the SDK
  (`mergeThemeSchemes`) and the kernel (`renderThemeCss`).
- Size matrix and compact violation suites: unchanged pages still pass at the three classes.
- Visual baselines and the reference compare (blind reviewer) per the writing-web-ui acceptance steps.

## Left to the builder

- Exact context meter thresholds (the compaction threshold the kernel already exposes), copy wording,
  and whether the account row's fail dot reuses the existing status dot component.

## AGENTS.md rules touched

- **Web UI.** Page = template + design components holds; all changes are in `packages/design` (tokens,
  shell, page head, sidebar, composer); `apps/web` only loses its two `useStatusBar` calls. One box is
  enough: the paper is the shell, not a box pages draw. Columns by count unchanged.
- **Mobile and shells.** Layout still follows the size classes in the shell and templates; compact is
  unchanged; desktop drag regions stay dedicated empty fillers (`web-shell-access`, the drag-region
  test); dangerous shell capabilities untouched.
- **Public API reports.** The design package has no API report and `@capybara-hq/plugin-client`
  exports neither `StatusBar` nor `useStatusBar`, but removing the `status-bar` UI part and the new
  theme token values change `@capybara-hq/plugin-sdk`'s report (`UI_PART_NAMES`, `THEME_TOKENS`):
  `pnpm gen:sdk-api` plus a changeset bumping the SDK (found while building).
- **Language / i18n.** New copy (context meter tooltip, account menu status line) in zh and en; zh uses
  平台 / 超级管理员 / 智能体.
- **When a rule can be checked automatically, the check is the authority.** `check:tokens`,
  `check:web-ui` and the design tests cover the changes; no new check is needed.
