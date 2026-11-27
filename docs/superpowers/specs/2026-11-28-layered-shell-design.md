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
   one level toward the middle too.
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

### 1. Colours (token values only, no new colour token)

| token | light | dark |
|---|---|---|
| `sidebar` (now also the shell ground from 600 up) | `#F3F2EE` → **`#EDECE7`** | `#111110` → **`#171716`** |
| `bg` (the paper) | `#FAF9F6` → **`#FDFDFC`** | `#0A0A0A` (unchanged) |
| `panel` (cards on the paper) | `#FFFFFF` (unchanged) | `#111110` (unchanged) |
| `hover` | overlay (unchanged) | `#171716` → **`rgba(255,255,255,0.04)`** |
| `sidebar-active` | overlay (unchanged) | `#1A1A18` → **`rgba(255,255,255,0.07)`** |

Dark `hover` and `sidebar-active` become overlays like the light ones, so they read on the ground and on
the paper alike (an opaque `#171716` hover would vanish on the new ground). The existing contrast pairs
must still pass (`check:tokens`); the light `bg` change also lightens every compact page, which is
intended (one paper colour). `preview-light` keeps `#FAF9F6` (an icon preview ground, not the page).

### 2. The shell from 600 up (`styles/shell.css`, `styles/conversation-page.css`)

- `.cb-shell` paints `sidebar`; the sidebar has no ground and no right line of its own.
- `.cb-shell-main` is the paper: `bg`, margin `space.2` on top, end and bottom (start: the sidebar's
  edge), `radius.md`, clipped, no border, no shadow.
- The conversation page: the main column and the inline right panel are two papers side by side,
  `space.2` apart; the shell main draws none itself. The panel's own start line goes; its resize handle
  sits in the gap.
- Inside a template `--cb-content-pad` is `space.6` (compact keeps 16).
- Compact (below 600): unchanged (full-bleed page, floating row).

### 3. Page head (`shell/page-header.tsx`)

- From 600 up the path row is not rendered when the path has two segments or fewer (scope / page);
  the title row starts the head. Compact already draws no path row. The `path` prop stays required:
  compact back and `web-ui-page-path` use it.
- The title row gains a `DragFill` between the title block and the actions (§5), so a page without
  a path row still has a drag area.
- Follow-up, not in this change: the path's segment labels are route slugs ("agents", "templates");
  showing page names belongs to the pages that build the path.

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

The gap between the two conversation papers is the panel's resize handle, not a drag region. The
macOS traffic lights and a Windows caption overlay keep using the shell's reserved start / end insets;
on Windows the head's actions keep clear of the end reserve.

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
- **Public API reports.** Not touched: the design package has no API report and
  `@capybara-hq/plugin-client` exports neither `StatusBar` nor `useStatusBar` (checked).
- **Language / i18n.** New copy (context meter tooltip, account menu status line) in zh and en; zh uses
  平台 / 超级管理员 / 智能体.
- **When a rule can be checked automatically, the check is the authority.** `check:tokens`,
  `check:web-ui` and the design tests cover the changes; no new check is needed.
