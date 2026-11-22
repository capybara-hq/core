# Mobile interaction model

Status: **approved design** (maintainer decisions D1–D16, 2026-11-22, §13; plan phase 0b). Companion to
`2026-11-22-responsive-system-design.md` (the responsive system: templates per size class, the
page contract, same DOM vs two DOMs). That doc adapts **layout**; this one defines how the app
**behaves** on a phone: navigation and its layers, back, sheets, lists, primary actions, input and
keyboard, the top row and feedback. It folds in the decisions the maintainer took one by one on
2026-11-22 and proposes the rest.

Maintainer direction, 2026-11-22: 「不是无脑响应式适配，而是要有移动端的交互逻辑」— not
mindless responsive adaptation, a mobile interaction logic.

Scope: the compact class (< 600) on every pointer, and touch at any width where it says so. A
narrow desktop window gets the **same structure** as a phone but no gestures (§1.5). Medium and
expanded keep the desktop interaction model (responsive D9), with touch sizes on touch.

## 0. Principles

1. **Chat first.** The home is a new conversation; everything else is reached from the drawer
   and pushed on top. A phone is used to talk to agents, check the inbox and glance at lists; heavy
   configuration is desktop work (management pages are desktop-only on touch, mobile layout spec
   §4.6).
2. **Layers, one back.** Every screen is a stack of layers (page → pushed page → drawer → sheet).
   One back removes the topmost layer, whatever produced it (button, system back, edge swipe, Esc).
3. **Everything reachable without gestures.** A gesture (long press, swipe, pull) is a shortcut,
   never the only way: every action also exists on the object's detail page or in a visible
   control (responsive D3).
4. **One component per interaction.** Sheets, the drawer, action sheets, the top row, FAB, lists
   are design components; pages declare data and cannot build their own (§9).
5. **Platform conventions over invention.** iOS edge swipe and Android back work as the platform
   does; the web adds no edge gestures of its own.

## 1. Navigation model

### 1.1 Surfaces and layers

| Layer (bottom → top) | What | Opened by | Closed by |
|---|---|---|---|
| 0. Chat surface | `/` (new conversation, the home) or `/chat/<id>` | drawer pick, 新会话 | navigating away |
| 1. Pushed page | every other route; a ListDetail item; a conversation's right area (`#properties`, `#panel=…`, …) | a link | back |
| 2. Drawer | the compact navigation (§1.2) | the menu button on a chat surface | back, scrim, a pick, a drag to the start edge |
| 3. Sheet | bottom sheets: account, composer settings, filters, action sheets, pickers, confirmations | a control or a long press | back, scrim, close, drag down, a pick |
| (4. Sheet over sheet) | only a confirmation over an action sheet (§2.4) | a destructive pick | back |

Rules:

- A **drawer only opens from a chat surface** (the menu button lives there); a pushed page has
  back instead. A sheet may open over the drawer (the account sheet: maintainer, kept in #570) and
  over any page.
- At most **two overlays** at once (drawer + sheet, or sheet + confirmation). A pick in a sheet
  over the drawer that navigates closes both, then navigates from the page's own history entry
  (spec §6.52 "A pick navigates from the page's own entry").
- A pushed page never opens the drawer; to switch sections the person goes back to a chat surface
  or uses search (the drawer's search opens the command palette).

### 1.2 The drawer (approved 2026-11-22; implemented by `feat/compact-drawer-conversations`)

Top to bottom, on the `panel` ground, scrolling vertically only (#570):

1. **Top row**: the search pill (opens the command palette; a button, not a field) and the
   **新会话** button beside it (round, accent: the drawer's compose entry).
2. **Nav card**: one grouped card (the sheet group look, §2.1) of rows 收件箱 (badge: the pending
   count), 智能体, 定时任务 (not for a guest), 「技能、连接器、设备…」 (opens a drawer level).
3. **Recent conversations by time**: groups 今天 / 昨天 / 本周 / 更早 (not by agent as on the
   desktop sidebar), each row the title, the agent as a muted line, and the state (running,
   waiting for you, failed) as a trailing mark; 全部会话 at the end (the conversations page).
4. **Account row** (sticky foot): avatar, name, org → the **account sheet** over the drawer.

The drawer level (技能、连接器、设备…) replaces the list inside the panel with a back row; back
returns to the list (spec §6.52, kept).

### 1.3 Back semantics

| Input | Effect |
|---|---|
| Floating back button | closes the top overlay if any, else pops the pushed page (in-app history entry, else the path's last linked segment, else `/`) |
| Android system back / browser back | same: each overlay holds one history entry on a compact touch window (Decision 25), so back closes it first |
| iOS edge swipe (Safari, the mobile shell) | the browser's own back: same history, so the same effect; the browser animates it and the app does not animate again (`hasUAVisualTransition`; #587 removes the second slide after a view transition) |
| Esc (keyboard) | closes the top overlay; never pops a page |
| A narrow desktop window | the floating back button and Esc only; overlays push **no** history entries on a fine pointer (spec §6.52), so the browser back navigates pages only |

Animations: a push slides in from the end edge, a pop back (`motion.push`, `ease.push`), once
(#587); moves between chat surfaces never slide; reduced motion: none.

### 1.4 Compose entry points

The new conversation is reachable in one tap from every top-level place:

- the home itself (it is the new conversation);
- the drawer's 新会话 button (§1.2);
- the conversations page's **FAB** (新会话, responsive doc §2.5);
- an agent row's action sheet / the agent page's primary 开始会话 (a new conversation with the
  agent picked).

Not on pushed pages in general (no global compose FAB): the FAB belongs to a list page's own
primary.

### 1.5 Narrow desktop window

Same structure (chat surface + drawer + pushed pages + sheets, the flat compact title bar in the
desktop shell, #572), but: no long press (right click opens the action sheet), no pull to refresh,
no drag-to-dismiss requirement (drag works with a mouse but is not needed), overlays push no
history entries, hover states kept.

## 2. Sheets, pushed pages and inline expansion

### 2.1 The sheet standard (approved 2026-11-22; `fix/sheet-close-focus-ground`)

- Grab handle; head: **centred title**, a **30 px circle close** at the end (`hover` ground, `x`
  16), **no hairline** under the head.
- Body: **grouped cards** (design spec §6.59, #591; `SheetGroup`: rows on the `hover` ground, `radius.sm`, a ground not a
  box; separators `line-soft` inset to the text column), `touch.sheet-inset` from the edges and
  between groups; **52 high rows** (`SheetRow`: icon column, label, optional muted value or
  control or chevron; centred / danger variants); `SheetFootnote` for a muted note.
- **Quiet focus** on open: the focus a sheet moves on open has no ring unless the last input was
  a key (#570 `quiet-focus`).
- Every bottom sheet composes these parts; no sheet draws its own rows (account sheet, composer
  settings, filter sheet, action sheet, pickers, confirmations).

### 2.2 When a sheet, a pushed page or an inline expansion

| Use | When | Examples |
|---|---|---|
| **Inline expansion** | the content belongs to the row and is short (≤ ~5 lines); the person compares rows | a tool group's detail, a Disclosure, an approval's network facts |
| **Bottom sheet** | a short, modal choice or a few settings about the current context, done in one step; the page underneath stays the context | account, composer settings, filters, action sheets, pickers, a confirmation |
| **Pushed page** | it has its own identity (an address, a back target), scrolls long, holds forms with a submit, or has its own actions | an object's detail, a form, the conversation's right area, a ListDetail item, the setup steps |

Rule of thumb: if it needs its own URL or an ActionRow, it is a pushed page; if it closes after
one choice, a sheet. **Dialogs** (centred modals) are not used on compact except the command
palette: what is a Dialog on the desktop is a bottom sheet on compact (same component, drawn per
class: `Dialog` gains a compact sheet form, responsive doc §5 two-DOM case "interaction differs").

### 2.3 Action sheets (long press / right click)

The `ActionSheet` (responsive doc §2.4; design spec §6.61, minimal form from #596): titled with the object's name, the object's primary
first then its menu items, 52 rows in one group, destructive items in `fail` in their own last
group. Opened by long press (500 ms, < 10 px) on touch or the context-menu event; never on inbox
rows (responsive D6). Sheets that hold links stay web sheets; `menu@1` only without links (plan P3).

### 2.4 Destructive confirmation

On compact a destructive action confirms in a **sheet**, not a centred dialog: the title (「删除
"研究助手"？」), one sentence of consequence, the destructive button full width in `fail`, 取消
under it; a typed name when the desktop asks for one (the same `DangerConfirm` contract drawn as a
sheet). Opened over an action sheet it replaces it (the action sheet closes first; one overlay).

### 2.5 Pickers

A choice from a list (model, agent, org, language, time zone) is a **sheet with a radio list**
(`SheetOptionList` in a `SheetGroup`), searchable when it has more than ~10 options (a search
field pinned at the sheet's top). Date and time use the platform's native inputs on touch.
Selects on compact open this sheet instead of a dropdown.

## 3. Lists

| Behaviour | Decision / proposal |
|---|---|
| Grouped rows, no buttons in rows | decided (responsive doc §2.3) |
| Time-grouped conversation lists | **approved** (drawer recents and the conversations page: 今天 / 昨天 / 本周 / 更早) |
| Filter chips for the view choice | decided (responsive doc §2.2) |
| **Infinite scroll** | decided (D6): lists with cursors load the next page when the last rows come into view (an `IntersectionObserver` sentinel in the list component), with a skeleton row while loading and an inline retry row on error; no 「加载更多」 button rows on compact. Desktop keeps its pagination / load-more. |
| Long press actions | decided (responsive doc §2.4) |
| **Swipe actions** | decided (D3): **none for now**. Reasons: they compete with the iOS edge swipe and horizontal scrolling chips; they hide actions (principle 3 needs a visible equivalent anyway); the only strong candidate (archive a conversation) is one long press away. Revisit with real use (Q3). |
| **Pull to refresh** | decided (D4) per surface: **yes** on the inbox, the conversations page and the drawer's recents in a native shell only (the browser's own pull-to-reload already exists in mobile Safari / Chrome and must not be doubled); **no** elsewhere: lists stay fresh through the query cache and SSE. |
| Empty | the page EmptyState, centred in the remaining height, its action full width (one primary per screen: no FAB then) |
| Loading | skeleton rows in the list's own card (never a spinner page); the head and compact bar real |
| Error | the list's place says so with 重试 (full width); the head stays; a toast only for an action's failure |

## 4. Primary actions

| Page | Primary on compact | Decided |
|---|---|---|
| List page | FAB (bottom end) | yes (§2.1 of the responsive doc) |
| Detail / settings / overview | full-width button under the title | responsive D2 |
| Form / wizard / a settings section | sticky ActionRow, primary full width at the bottom | yes (spec §4.4) |
| Conversation | the composer's send | — |
| Sheet | full-width button at the sheet's bottom (a filter sheet's 应用, a confirmation) | yes |

Secondary actions: the top row's "…" (responsive D1). Never two filled buttons side by side on compact.

## 5. Input and keyboard

- **Composer on phones**: the floating pill (attach, input, send / stop) above the bottom inset
  and the keyboard; the settings chip above it opens the composer settings sheet. Its touch form
  now follows the **width** too (#575: compact or touch), so a narrow desktop window gets it.
- **Keyboard avoidance**: `AppShell` writes `--cb-keyboard-inset` from `visualViewport` (spec
  §4.3); the composer and sticky ActionRows sit above it; the status bar hides while it is open;
  the document never scrolls.
- **Scroll to input**: a focused field inside a scroller is scrolled into view above the keyboard
  inset (`scrollIntoView({ block: "nearest" })` after the inset settles); a design
  behaviour of `Input` / `Textarea` under the mobile query, not page code.
- **16 px rule**: text fields ≥ 16 px under the mobile query (#575 extends it from touch to
  compact).
- **Tap does not focus**: a tap that only chooses something never moves focus into a text field
  on touch (spec §4.3, kept).
- **Safe areas**: `--cb-inset-*` (OS insets combined with shell chrome) pad the floating row,
  drawer, sheets, ActionRow, composer and FAB (spec §4.7).
- **Return key**: in the composer on touch, return inserts a newline and the send button sends
  (D5; on a hardware keyboard Enter sends as on the desktop).

## 6. The top row

| Environment (compact) | Top row |
|---|---|
| Browser / mobile shell | the **floating row**: round floating buttons (menu or back, the conversation's title pill, "…"), content scrolls under a solid strip |
| Desktop shell with window controls | the **flat title bar** (#572): one row as high as the controls, ghost buttons, plain title that drags the window, hairline under it |
| A scrolled pushed page | the page title centred in the row with a hairline (responsive doc §2.6) |

"…" holds: the page's overflow + the head's secondary actions (responsive D1); in the flat bar also the
conversation's title menu items (#572).

## 7. Feedback

- **Haptics** through the shell's `haptics@1` (no-op in a browser): `selection` on segment / select
  changes, `light` on send and attach, `success` on an approval, `warning` on a destructive
  confirmation (today's set) plus `light` when a long press opens an action sheet, and
  `selection` when pull to refresh triggers.
- **Toasts on phones** (D2): **bottom**, above the composer / FAB / ActionRow and the bottom
  inset, full width minus 16 gutters, one at a time (today they sit at the top, under the floating
  row and the notch). Swipe down or wait to dismiss; an undo action in the toast where the action
  is reversible (archive) instead of a confirmation.
- **Destructive confirmation**: a sheet (§2.4); reversible actions prefer undo over confirm.
- **Pending navigation**: the link pending mark (kept) plus the push animation starts only when
  the next page is ready (no blank pushed page).

## 8. Gestures summary

| Gesture | Where | Notes |
|---|---|---|
| Tap | everywhere | opens a row's item |
| Long press / right click | object rows (not inbox) | action sheet |
| Drag down | sheets | dismiss past 40 % or by velocity |
| Drag to the start edge | the drawer panel | dismiss |
| iOS edge swipe / Android back | system | back (§1.3) |
| Horizontal scroll | chips, scrolling tab rows, wide code blocks | never hijacked |
| Pull down | inbox, conversations, recents in a native shell | refresh (§3) |
| Swipe on a row | — | none (§3) |
| Pinch | everywhere | page zoom kept (no `maximum-scale`) |

## 9. Consistency guard

| Interaction | Owned by (design) | Enforced by |
|---|---|---|
| Layers and back | `AppShell`, `useOverlayHistory`, `Drawer`, `BottomSheet` | jsdom back tests (`overlay-history`, `compact-shell`); new rule `web-ui-overlay-primitive`: apps/web may not use Radix dialog / popover primitives directly |
| Sheet look | `BottomSheet` + `SheetGroup` / `SheetRow` / `SheetFootnote` | new design check `design-sheet-parts`: a `BottomSheet` body in design code renders rows only through the sheet parts |
| Action sheets, long press | `ActionSheet`, `useLongPress` | `design-dual-render` + jsdom tests per row component |
| Dialog → sheet on compact | `Dialog`, `DangerConfirm` compact form | jsdom test at 390 per overlay |
| Pickers | `Select` compact sheet form | jsdom test |
| Lists (infinite scroll, groups, states) | `ObjectList`, `CardGrid`, `DataTable`, new `useListSentinel` | `web-ui-load-more` (new): no 「加载更多」 button rows passed as list children; pages pass `onLoadMore` |
| Primary placement | templates (`primaryForm`), the head primary's FAB form (design spec §6.62) | `web-ui-template-only-props` (plan P2) |
| Top row | `FloatingBar`, flat bar CSS | drag-regions and compact-shell tests |
| Toasts | `ToastProvider` | CSS rule test |
| Haptics | the components above call `useHaptics` | pages may not call `useNative()` (`web-ui-size-branch` extended to `useNative`, allowlist `AppFrame`) |
| Hit sizes | tokens (#575) | `responsive.spec.ts` hit-size assertion (plan P4) |

## 10. iPhone Duo: the strip (maintainer direction 2026-11-22)

### 10.1 What is already decided (mobile app spec §6.1, §8; layout spec §8)

- The Duo's **right** edge is a **strip** the system reserves (always the right edge with one app in
  the foreground, on both displays; mirrored only for the left app of an inner-display split,
  §10.7): it shows the status (time, location,
  Wi-Fi) at its top and an app may float its own controls in it. In the app (Capacitor shell) the
  WebView runs **edge to edge under the strip**; content and controls stay left of it, padded by
  `--cb-inset-right` (the strip arrives as `env(safe-area-inset-right)`, or `insets.right` when
  the WebView does not report it).
- The shell hosts the WebView in a `UITabBarController` whose **vertical system tab bar** the OS
  places in the strip, on both displays: 对话, 收件箱 (badge), 智能体, 定时任务, and on the outer
  display a native **menu button** at the top that opens the web's drawer. `nav@1` exists exactly
  while the window has a strip (`data-native-nav` before first paint); the web then draws no menu
  button and drops those sections from its drawer / rail / sidebar.
- Displays: the **outer** display (382 wide) is compact; the **inner** display is medium in
  portrait and expanded in landscape (951). (The request called them "outer (wide) / inner
  (narrow)"; the specs and the visual shots have it the other way round, outer = the narrow phone
  form, inner = the wide one. This doc follows the specs.)
- Browser and PWA on the Duo: no strip access; the outer display is the ordinary phone layout, the
  inner display the rail / sidebar.

### 10.2 The model on Duo: the strip pill is the navigation

Apple's own App Store on the Duo puts the **account avatar under the status** and its tab bar as a
**floating vertical pill in the strip** (Today, devices, explore, bag, search), over the content's
edge, on both displays. Ours follows it:

| Strip, top to bottom | Item | Behaviour |
|---|---|---|
| under the status | **account avatar** (the person's `Avatar`, circle) | opens the account sheet (§10.4) |
| pill, first item | **primary action**, accent-filled: the page's FAB action when the page has one (新建智能体, 新建定时任务…), else **新会话** | runs the action; the web draws no FAB while the pill carries it |
| pill | 对话 | `/` (the home; `/chat/…` and `/conversations` mark it current) |
| pill | 收件箱 (badge) | `/inbox` |
| pill | 智能体 | `/agents` |
| pill | 定时任务 (not for a guest) | `/schedules` |
| pill, last item | 搜索 | opens the command palette |

- **No hamburger on Duo.** The pill is the navigation on both displays; the drawer's remaining
  content (recent conversations, 全部会话, 「技能、连接器、设备…」) is reached from 对话 (the
  conversations page holds the recents) and from the account sheet (技能、连接器、设备… joins it as
  a row, as the inner display's account popover already does). This retires the outer display's
  native menu button of mobile app spec §6.1 (D12).
- **Pushed pages** keep their floating back button at the top start; the floating row's "…" stays
  at the top end, left of the strip (it never moves into the strip: page overflow is page content).
- **Selecting a section from the strip** closes any open overlay first (as back would), then
  navigates to the section root without a slide (mobile app spec §6.1).

### 10.3 The primary action and the FAB

The list FAB and the conversations page's 新会话 FAB **do not sit at the bottom end on Duo**: they
would collide with the strip pill's area and with the thumb that reaches the pill. While `nav@1`
is present, the template registers its primary with the shell and hides the head primary's FAB form (design
spec §6.62); the
shell sends it to the strip as the pill's **top item, accent-filled** (label = the action's label,
icon = `plus` or the action's own). A page without a primary leaves 新会话 there. Detail pages keep
their full-width primary under the title (responsive D2): the pill's top item then stays 新会话.

Contract change (`nav@1`, minor version, mobile app spec §5.2):
`set({ items, current, action: { id: string; label: string; icon: "plus" | "square-pen" }, account?: { name: string; avatarUrl?: string | null; initial: string; badge?: number } })`,
plus `onAction(cb)` and `onAccount(cb)`; `menu` and `onMenu` leave the contract (no menu button,
D12). **Lockstep** (amended 2026-11-22, final review of phase 0b): the shell's minor version ships
with or before the web that sends this shape; before 0.1.0 there is no older-shell path (no
compatibility layer, AGENTS.md "Before 0.1.0"), so the web sends this shape to every `nav@1`. The
web calls `set` on route and primary changes.

### 10.4 Sheets, drawer, scrim, menus and the keyboard with the strip

- **The strip is native and stays on top**: web overlays cannot cover it. The **scrim** runs edge
  to edge under the strip (the WebView's whole width), so the page behind dims uniformly; the
  **sheet panel** spans the content width only (inside the strip side's inset, `--cb-inset-right` or
  `--cb-inset-left`), so its rows, close
  button and footer never sit under the pill. The pill stays tappable while a sheet is open; a tap
  there closes the sheet, then acts (§10.2).
- **Drawer**: not used on Duo while the strip shows (no hamburger). Without `nav@1` (browser, PWA)
  the ordinary drawer applies.
- **Action sheets / long press**: open as `menu@1` native menus where plain (anchored at the row);
  web action sheets (with links) as above, inside the content width.
- **Keyboard**: the composer and sticky ActionRows stay clear of the strip (the strip side's `--cb-inset-*`)
  and above `--cb-keyboard-inset`; the strip does not move with the keyboard.
- **Toasts** (bottom, §7): within the content width, clear of the strip.

### 10.5 Outer and inner display

| | Outer (382, compact) | Inner portrait (medium) / landscape 951 (expanded) |
|---|---|---|
| Strip | avatar + pill (primary, 对话, 收件箱, 智能体, 定时任务, 搜索) | the same pill |
| Web navigation | none of its own: floating back on pushed pages, "…" | rail or sidebar with only the recent conversations and the new-conversation entry dropped too (the pill has both); search moves to the pill |
| Primary | pill top item (no FAB) | head's primary button (medium / expanded head, responsive D9); the pill's top item stays 新会话 |
| Two segments (inner landscape with a hinge) | — | list-detail split along the segment boundary (layout spec §8), the strip beyond the outer segment |
| Overlays | sheet in the content width, scrim full bleed | side sheets left of the strip |

### 10.6 Detection and fallback

- Only through the shell: `nav@1` in `window.capybaraShell.capabilities` (offered exactly while
  the window has a strip), the reported `insets` and `env(safe-area-inset-right)`, and the viewport
  segments API. Never the user agent or a device model (`web-shell-access`).
- **Browser and PWA** on the Duo: no strip, no pill; the outer display is the ordinary compact
  model (menu button, drawer, FAB at the bottom end padded by `--cb-inset-right` if Safari ever
  reports the strip as an inset), the inner display the ordinary rail / sidebar.
- A shell that loses the strip (a scene resize) withdraws `nav@1` with `change`; the web brings
  back its menu button, drawer sections and FAB on the next render, with no reload.

### 10.7 The strip's side: right, except the left app of a split

Facts (maintainer, 2026-11-22):

- With **one app in the foreground** the strip, and so the pill and the avatar under the status,
  is **always on the right**, on the outer display and on the inner display.
- The **outer display cannot split**.
- Only in **split screen on the inner display** does each app keep its strip on its outer edge:
  the app on the **left** puts it on the **left** edge, the app on the right on the right edge (as
  Apple's own apps do).

So the default is right, and the only mirrored case is the left app of an inner-display split.

- **Mechanism**: the side still comes only from what the shell reports, never from the UA or a
  device model: a reported strip side (`nav@1` field, D16: `side: "left" | "right"`, sent with
  the capability and updated with the envelope's `change`), else the inset that carries the strip
  (`env(safe-area-inset-left|right)` / `insets.left|right`). Without either the side is right.
  `ShellEnvironmentScript` writes `data-strip="left|right"` on `<html>` before first paint.
- **In the mirrored case** (left app of a split): the OS places the pill and the avatar on the
  left; the web's parts placed relative to the strip follow the side: the sheet panel and toasts
  sit inside `--cb-inset-left`, the scrim stays full bleed, the content and the floating row are
  padded by both insets (as always). The floating back button stays at the top start (clear of
  the left strip through `--cb-inset-left`) and "…" at the top end; they do not swap.
- **The drawer**: not drawn while the strip shows (§10.2). Where it is drawn (browser, PWA, a
  shell without a strip) it opens from the leading edge as everywhere else *(D15)*.
- **A live split change** (inner display only: the app moves from the left half to the right, or a
  split ends): the shell sends `change` with the new side / insets; `data-strip` and the inset
  properties update and CSS moves everything in the same frame. **No remount**: the page, scroll
  positions, open sheets, the composer's draft are kept (the side is presentation only, read by
  CSS, never a React key). The pill itself is native and moved by the OS.

## 11. In-flight work mapped to the model

| Work | State (2026-11-22) | Model section |
|---|---|---|
| #569 responsive system design + plan | merged | companion |
| #570 drawer and sheets: no sideways scroll, one column, quiet open focus | merged | §1.2, §2.1 |
| #572 flat compact title bar in the desktop shell; no path row on compact | merged | §6, §1.5 |
| #575 mobile control sizes at compact or touch; touch forms follow width | merged | §5, §9 hit sizes |
| #579 CJK Markdown emphasis | merged | not interaction (display correctness on phones) |
| #587 back slides once after a view transition | merged | §1.3 |
| #591 one bottom sheet look (quiet round close, no hairline, groups, 52 rows) and the regrouped account sheet: design spec §6.59 | merged | §2.1 |
| #593 compact back settles on the route commit | merged | §1.3 |
| #596 compact drawer and the conversations page by time: `ConversationList` (§6.60, time sections, long press, infinite end), minimal `ActionSheet` + `actionSheetItems` + `useLongPress` (§6.61), the list FAB as a **CSS variant of the head's primary** (§6.62, one DOM; `ListFab` dropped), `ScopeChips` + `ListPage.scope` (§6.63) | merged | §1.2, §2.3, §3, §4 |

Design spec section numbers after these merges: §6.59 bottom sheet, §6.60 ConversationList,
§6.61 ActionSheet, §6.62 list FAB, §6.63 ScopeChips.

## 12. Changes to the responsive plan

`docs/superpowers/plans/2026-11-22-responsive-system.md` gains a **phase 0b "interaction model"**
(between phase 0's two PRs and phase 1), tasks:

| Task | What | Depends on |
|---|---|---|
| T0b.1 | `Dialog` / `DangerConfirm` compact sheet form on the §6.59 sheet (§2.2, §2.4; D1) | — (#591 merged) |
| T0b.2 | `Select` compact picker sheet, searchable over ~10 options (§2.5) | — |
| T0b.3 | Infinite scroll for ObjectList / CardGrid / DataTable compact forms, generalising `ConversationList`'s end (§6.60) into `useListSentinel`; `web-ui-load-more` guard (§3; D6) | phase 0 T0.8–T0.10 |
| T0b.4 | Toasts at the bottom on compact, above composer / FAB / ActionRow (§7; D2) | — |
| T0b.5 | Scroll-to-input under the mobile query (§5) | — (#575 merged) |
| T0b.6 | Pull to refresh in a native shell for inbox / conversations / recents (§3; D4) | — (#596 merged) |
| T0b.7 | Guards `web-ui-overlay-primitive`, `design-sheet-parts`, `useNative` in `web-ui-size-branch` (§9) | T0.4 |
| T0b.8 | Haptic additions (long press opens a sheet, refresh) (§7) | — (`useLongPress` exists, #596) |
| T0b.9 | Duo: the head's primary (the §6.62 FAB form) goes to the strip pill while `nav@1` is present: `ShellPage.primary`, the FAB form hidden (§10.3; D10, D14) | T0.6 |
| T0b.10 | Duo: `nav@1` minor version (`action`, `account`, `side`, `onAction`, `onAccount`; `menu` and `onMenu` removed in the final review, lockstep), web adapter, overlays close before a strip selection (§10.2–10.4, §10.7; D11, D12, D16) | mobile app line (clients repo for the native side) |
| T0b.11 | Duo: drawer / rail / sidebar drop the pill's entries; 技能、连接器、设备… in the account sheet; sheet panel inside the strip side's inset, scrim full bleed; `data-strip`; `duo.spec.ts` shots (§10.4–10.7; D13, D15) | T0b.10 |

Phase 0b's Duo tasks need the native side in the clients repo (the mobile app line) (decisions D10–D16).

Phase 1 gains: the inbox gets pull to refresh in a native shell (T0b.6). The conversations page's
time groups and infinite scroll shipped in #596. The plan file is updated in this PR with these tasks.

## 13. Decisions (maintainer 2026-11-22)

All sixteen open questions of the review draft were answered as recommended:

- **D1** Every desktop Dialog is a bottom sheet on compact (one modal form on phones).
- **D2** Toasts sit at the bottom on phones, above the composer / FAB / ActionRow.
- **D3** No swipe actions on rows for now; long press covers them.
- **D4** Pull to refresh only in a native shell, on the inbox, the conversations page and the
  drawer's recents; the browser keeps its own pull-to-reload.
- **D5** Return in the composer on touch inserts a newline; the button sends; a hardware keyboard
  keeps Enter to send.
- **D6** Infinite scroll replaces load-more rows on compact; the desktop is unchanged.
- **D7** Reversible actions (archive, leave) offer undo in a toast instead of a confirmation;
  delete keeps its confirmation sheet.
- **D8** Pushed pages never open the drawer (no menu button on them).
- **D9** Drawer recents are grouped by time on compact; the desktop sidebar stays by agent.
- **D10** On the Duo the page's primary (else 新会话) is the strip pill's top item, accent-filled;
  no FAB there.
- **D11** The Duo strip: the avatar under the status; the pill holds the primary, 对话, 收件箱,
  智能体, 定时任务, 搜索; 技能 / 连接器 / 设备 live in the account sheet.
- **D12** No hamburger on the Duo: the native menu button at the top of the strip is retired; this
  **amends mobile app spec §6.1** (a pointer is added there); recents are reached through 对话.
- **D13** With the strip, the scrim runs full bleed, the sheet panel stays in the content width,
  and the pill stays live (a tap closes the sheet, then acts).
- **D14** On the Duo's inner display the primary stays the head's button (medium / expanded head)
  and the pill's top item stays 新会话.
- **D15** Where the drawer is drawn, it opens from the leading edge, also in an inner-display split.
- **D16** `nav@1` reports the strip's `side`; the insets are the fallback; right when nothing is
  reported (one app in the foreground is always right; only the left app of an inner-display split
  is left).

## AGENTS.md rules touched

- **Mobile and shells**: layout and interaction follow size classes by window width and touch by
  the pointer query, adapted in design templates, overlays and the shell, never in pages
  (`design-breakpoint`, `web-shell-access`); native capabilities (haptics, `menu@1`) only through
  `window.capybaraShell` via the design's native handlers. Addition made with phase 0b: "pages
  never call `useNative()`; overlays are design primitives (`web-ui-overlay-primitive`)".
- **Web UI**: pages stay template + design components; new guards extend `check:web-ui`. No other
  change.
- **Language**: new copy (confirmation sheet, pull to refresh, retry rows) through zh and en
  (`check:i18n`). No change.
- **When a rule can be checked automatically, the check is the authority**: each new guard ships
  with a red fixture. No change.
