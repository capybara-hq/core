# Mobile and foldable layout, and the shell environment

- Date: 2026-11-19, written against `origin/main` at `5f6c3541a`.
- Status: draft for maintainer review.
- Related: the design spec (`docs/design/spec.md`, the only UI spec: §4 App Shell, §4.3 the
  phone rules, §5 templates, §6.13 Sidebar, §6.16 conversation components, §7.3 state tokens),
  the writing-web-ui and writing-extension-ui skills, UI slots
  (`2026-11-08-ui-slots-design.md`), client extensions (`2026-11-09-client-extensions-design.md`),
  the web order (`2026-10-31-web-order-design.md`), the transactional outbox
  (`2026-11-12-transactional-outbox-design.md`), and the desktop client
  (`2026-11-07-desktop-client-design.md`, being rewritten on `docs/desktop-client`), which fills
  in the **Shell environment** of §9 for its Electron shell.
- Markers: **(decided)** is a maintainer decision of 2026-11-19; **(designer's call)** is decided
  here and open to review. Unmarked text restates current code, AGENTS.md or the design spec.

## 1. Why

Capybara's UI exists exactly once: the web app a deployment serves (`apps/web` on
`packages/design`). People increasingly reach it from a phone (to approve a call, answer a
question, read a finished result), from a tablet, from a foldable, and soon through two native
shells: a desktop client (Electron) and a mobile app (Capacitor), both living in a future
`capybara-hq/clients` repository (`apps/desktop`, `apps/mobile`, `packages/shell`).

Phone work so far (PR #121, the 2026-11-09 acceptance) made the existing pages *survive* below
640 px: stacked tables, 40 px tap targets, a pinned composer above the iOS keyboard. This spec
makes the web a **first-class mobile and foldable experience** and defines the one contract the
native shells fill in, so that no shell ever draws UI of its own beyond its start page.

### 1.1 Three lines of work (decided)

1. **This spec: the core layout.** Size classes, the App Shell per class, templates that adapt,
   slots that declare their compact form, mobile specifics, foldables and an installable PWA.
2. **The desktop client** (Electron): draws nothing but an address entry page, loads the
   deployment's web, and offers native capabilities through the Shell environment (§9).
3. **A mobile app later** (Capacitor): the same, on iOS and Android.

**No React Native (decided).** Self-hosted deployments run different kernel versions; a UI
bundled in a store build would skew against them, while a web loaded from the deployment never
skews. And everything plugins bring to the UI (schema views, embeds, client extensions L2 / L3,
themes, the HTML render, file previewers) is web-only.

## 2. Goals, non-goals, anti-goals

Goals:

- One layout model for every window: **size classes by window width** (§3), with a phone, a
  tablet, an unfolded foldable, a split-screen app and a narrowed desktop window all being just a
  class.
- The App Shell draws a different frame per class (§4); templates declare their per-class form
  (§5); pages do not change.
- The four places people use on the go are optimized: the conversation, approvals, notifications
  (the inbox) and files (§6). Admin pages are usable on a phone through the templates, not
  specially designed (§5.3).
- Mobile specifics are solved once, in the shell and the templates: the keyboard, scroll pinning
  of streaming output, long threads, follow-finger sheets, safe areas, background stream loss
  (§7).
- Foldables, including the iPhone Duo, by progressive enhancement (§8).
- A **Shell environment** contract for native shells (§9), shared with the desktop spec.
- An installable PWA with a per-deployment name and icon (§10). Push notifications are
  **deferred to a later design** (decided 2026-11-19); §10.3 records what is already decided as
  its input.
- Verification per class and per template, with real-device widths (§11).

Non-goals:

- A native UI of any kind (React Native, SwiftUI, Compose). The shells' only own page is the
  address entry page.
- Specially designed admin pages for phones. They work through the templates.
- Offline use. The web needs its deployment.
- Push notifications (deferred, §10.3).
- The desktop shell's own behavior (connecting the machine as a device, the tray, updates): the
  desktop spec.
- Layout by device model, user agent or orientation.

Anti-goals (a failure even if it works):

- A page under `apps/web` that branches on the window width, the class or the shell. Adaptation
  is the design package's.
- User-agent sniffing anywhere in the web, for layout or for shell detection.
- A first paint that draws the wrong class and then jumps after hydration.
- A shell that grants a page a native capability it did not declare, or performs a dangerous one
  without a native confirmation.

## 3. Size classes (decided)

The layout class follows the **window width** in CSS px (Material window size classes):

| Class | Window width | Typical windows |
|---|---|---|
| `compact` | < 600 | Phones in portrait, the iPhone Duo outer display (382), a narrow split screen |
| `medium` | 600–840 | Tablets in portrait, unfolded foldables in portrait, a phone in landscape at the low end |
| `expanded` | ≥ 841 | Tablets in landscape, the iPhone Duo inner display in landscape (951), desktops |

Never by orientation, device model or user agent. A foldable opening or closing, entering split
screen or a desktop window being narrowed is just a class change, handled by CSS live, without a
reload and without losing state (the URL hash keeps the right area, §5.4).

### 3.1 How the class reaches the code (designer's call)

- **CSS is the authority.** Every structural difference between classes is a media query in
  `packages/design/src/styles/*.css` with the class widths as the only breakpoints:
  `(max-width: 599px)`, `(min-width: 600px) and (max-width: 840px)`, `(min-width: 841px)`. The
  design package exports them once (`SIZE_CLASS_QUERIES` in `shell/size-class.ts`), next to the
  sidebar's queries today (`SIDEBAR_RAIL_QUERY` / `SIDEBAR_DRAWER_QUERY` in `shell/sidebar.tsx`,
  which they replace). A check (§11.4) rejects any other `max-width` / `min-width` number in the
  design CSS, except the one fit threshold of §3.3 (1280), named in one list.
- **JS reads it after hydration.** `useSizeClass(): "compact" | "medium" | "expanded" | null`
  (`null` on the server and during hydration, like `useMediaQuery` today). Where a component's
  tree differs by class, the server render draws every variant and CSS shows one (the pattern
  the sidebar's full and rail panels and the conversation's inline right area already use,
  writing-web-ui "First paint follows the window through CSS"); after hydration only the matching
  variant renders.
- **The shell element carries the class** as the state token `size=compact|medium|expanded` in
  `data-cap-state` (after hydration, like `sidebar=`), so plugin CSS (L3) can follow it without
  its own media queries, and client extensions read it with a hook (§5.6).
- **No client hints.** `Sec-CH-Viewport-Width` exists only in Chromium; the server never guesses
  the class.

### 3.2 A short window (decided)

Width decides the class; height only trims chrome. A window **shorter than 480 px** (a phone in
landscape, the iPhone Duo at its shortest reported height, 368) sets `data-short` on the shell:
the StatusBar hides, the PageHeader drops its path row (the back button keeps the way up, §4.1),
and the bottom navigation (compact only) shows icons without labels. This is not orientation:
a short desktop window gets the same.

### 3.3 Two width rules (decided)

The whole width layout is two rules beside the classes:

1. **The full sidebar from 841** (the expanded class). The person can collapse it to the rail
   and expand it again (a toggle in the sidebar head; ⌘\ / Ctrl+\). The choice is remembered in a
   cookie (`cb-sidebar=rail`, designer's call), which the app layout reads like the theme cookie,
   so the first paint draws the chosen form and nothing jumps.
2. **The inline right area from 1280.** The conversation's right area (properties or one right
   panel) sits beside the thread from 1280; below that, in every class, it opens as a sheet (a
   side sheet on medium and expanded, a pushed page on compact, §5.4). 1280 is the one fit
   threshold left in the design CSS. Between 841 and 1279 the thread keeps the width the sidebar
   leaves it (585 at 841 with the full sidebar, above `layout.chat-min` 480).

Compared with today: 640 becomes 600, the 960 drawer becomes the medium rail and the compact
bottom navigation, and below 1280 the sidebar no longer turns into the rail by itself (only by
the person's toggle).

## 4. The App Shell per class (decided, details designer's call)

| | compact | medium | expanded |
|---|---|---|---|
| Navigation | **Bottom navigation** (4 items, §4.2) | **Navigation rail**: today's icon rail (`layout.sidebar-rail`, 48), the conversations behind a rail button (§4.3) | **The full sidebar**, collapsible to the rail by the person (§3.3) |
| Page | Full screen; deeper pages are **pushed** (bottom nav hidden, back in the bar) | One pane, or list-detail two panes when both fit (§5.2) | Today's layouts (§4.3 of the design spec) |
| Sidebar content (org switcher, more, account, admin entry) | The **Me** tab (a full page) and bottom sheets | Rail popovers, as today's rail | As today |
| Right area (conversation) | A full-screen page pushed over the conversation (§5.4) | A side sheet with a follow-finger dismiss | Inline from 1280, a side sheet below (§3.3) |
| Drawer menu bar | Replaced by the **top bar** (§4.1) | None (the rail holds the menu) | None |
| StatusBar | Hidden (its system status moves to the Me page) | Shown | Shown |
| ActionRow | Sticky at the bottom, above the safe area | As today | As today |

### 4.1 Compact: top bar and push model (designer's call)

- **Tab roots and pushed pages.** A route is a *tab root* when it is the target of a bottom-nav
  item (§4.2); every other route is *pushed*. The shell knows the nav items, so no page declares
  its depth. Tab roots show the bottom navigation; pushed pages hide it and show a **back
  button** in the top bar.
- **The top bar** (one row, `row.roomy`, today's drawer bar's place): back (pushed pages) or
  nothing (tab roots), the page title, and at the end search (the command palette) and the page's
  overflow menu. Back goes to the previous in-app history entry when there is one, else to the
  **last linked segment of the page's `path`** (every page head has a path, `web-ui-page-path`
  enforces it), so a deep link opened from a notification still has a way up.
- **Transitions.** A push slides in from the end edge, a pop slides back (CSS view transitions
  where the browser has them, an instant swap otherwise; nothing under `prefers-reduced-motion`).
  The left edge is left to the browser's own swipe-back (iOS Safari, Android back gesture):
  the web adds no edge gesture of its own.
- **The keyboard hides the bottom navigation** (`data-keyboard="open"`, §7.1).

### 4.2 Bottom navigation items (decided)

Four items, defined once in the shell (`AppShell` takes them; apps/web passes the same `useNav`
data it passes the sidebar). There is **no files page in this design** (decided): files are
reached from their conversation (§5.5). Against the real navigation
(`apps/web/src/components/shell/nav.tsx`: the new conversation as home, 智能体, 技能, 连接器, 定时任务
as primary, the inbox as a brand-row button, devices / plugins / extensions / channels / evals /
settings under 更多), the inbox is where approvals and notices wait:

| Item | Target | Notes |
|---|---|---|
| 会话 / Chats | `/conversations` (new compact list route, §5.4) | The conversations grouped by agent, as the sidebar's section; a "new" action to `/` |
| 智能体 / Agents | `/agents` | The cards page as today |
| 收件箱 / Inbox | `/inbox` | With the pending count badge (the brand row's count today) |
| 我 / Me | `/me` (new compact page) | Account, org switcher, the 更多 items the role sees, personal settings, the admin entry for super admins, system status, sign out; drawn by the shell from the sidebar's data |

技能 / 连接器 / 定时任务 are reached from
Me (and from the agents' pages), as 更多 items are on the sidebar.

### 4.3 Medium: the rail (designer's call)

Today's rail, unchanged in look, gains one button: **conversations**, which opens the
conversations list as a side sheet over the content (a pane beside a conversation when the
window has two segments, §8). The account row's popover holds the org switcher and 更多, as the
rail's does today. The content minimum width (`560`, design spec §4.3) drops to **552**
(600 − the 48 rail), so the narrowest medium window fits; at 841 the full sidebar leaves 585, so
expanded needs nothing more. The conversation's `layout.chat-min` (480) fits both.

### 4.4 Expanded

Today's shell with the full sidebar from 841 and the person's collapse toggle (§3.3), and the
shell environment insets (§9.3).

## 5. Templates per class (decided: templates declare it, pages do not change)

`apps/web` writes no styles, so all adaptation is in `packages/design`. Each template documents
its per-class form in the design spec §5 (a new "Classes" row per template); this table is the
target.

### 5.1 The template table

| Template | compact | medium | expanded |
|---|---|---|---|
| `ListPage` (objects / cards / records) | Single column; rows compact (§4.3 today), cards one per row, records stacked; facet rail behind a "Filter" button and bottom sheet | Cards two per row; facet rail as a Filter sheet | As today |
| `DetailPage` | Pushed; facts first, PageTabs scroll; band head stacks | As today, one column | As today |
| `FormPage` | Single column (labels above fields), **sticky ActionRow** above the safe area | Labels above fields | As today (label column) |
| `SettingsPage` | Sub-nav as the sticky sideways row (maintainer decision 2026-11-09, kept) | Sub-nav stacked above content (today's < 960 form) | As today |
| `WizardPage` | Single column, step bar as "2 / 4" text, sticky previous / next | As today | As today |
| `InboxPage` | **Two-level stack**: the list is the page, an item is pushed full screen with its decision buttons sticky at the bottom | **List-detail**: two panes when both fit (list 320 + detail ≥ 360), else the stack | Rail + content + inspector, as today |
| `ConversationPage` | §5.4 | §5.4 | As today |
| `TracePage` | Waterfall full width; a span is pushed as its own screen | Waterfall, detail below | As today |
| `OverviewPage` | StatCards 2 × 2, sections stacked | StatCards in a row of up to 4 | As today |
| `AuthPage`, `StatusPage`, `OnboardingPage` | Full width with 16 gutters, safe areas | Centered | As today |
| `SetupPage` | Bottom navigation replaced by the steps as a pushed list (the setup home is the tab root) | Rail with the steps | As today |
| `SharedFilePage` | Top bar compact (name, download), the file full screen | As today | As today |

### 5.2 List-detail (decided: collapses to a two-level stack on compact)

A **list-detail** region is any template part that shows a list beside the open item: the
InboxPage rail and inspector, `Grid columns="list-detail"` (the agent page's prompt files), the
TracePage waterfall and detail, a record list with its Sheet (the 扩展 pages), the conversations
list and a conversation (medium, §4.3). The design package gives them one behavior
(designer's call: one `ListDetail` primitive the templates use, never a page):

- **compact**: list first; choosing an item pushes the detail full screen (URL state as each
  template has it today: a query parameter or hash), back returns to the list at its scroll
  position.
- **medium**: two panes when the container is at least list + detail minimum wide (each template
  names its minimums), else the compact stack. Measured with a container query on the template
  frame, not the window, so the rail and a second segment count correctly.
- **expanded**: as today.
- **two viewport segments** (§8): the list in the first segment, the detail in the second.

### 5.3 Admin pages (decided)

Usable on phones through the templates, not specially designed: every admin page is a template
above, so it inherits the compact form. Acceptance is "no horizontal page scroll, every action
reachable" (§11.3), not a phone design review.

### 5.4 The conversation page (optimized)

Builds on the 2026-11-09 phone rules (design spec §4.3, §5.4, §6.16.2), which stay:
the pinned composer, the keyboard inset, the options bottom sheet, touch focus rules, the new
conversation's greeting and agents row.

- **compact**
  - `/chat/<id>` is a pushed page: title bar with back (to `/conversations`), the title, and an
    overflow menu holding properties, the agent map and the conversation actions.
  - The **right area becomes a pushed full-screen page** over the conversation, keyed by the same
    URL hash as today (`#properties`, `#panel=…`, `#file=…`, `#output=…`, `#subagent=…`,
    `lib/right-area.ts`), so back closes it and a reload keeps it. A bottom sheet was considered;
    a right panel's content (a file preview, an embed, the agent map) needs the full screen, and a
    hash-backed push gives back-button behavior for free (designer's call).
  - Approval, question and connect blocks in the thread keep their actions within the thread
    width (no row wider than the window), buttons at 40 px.
  - `/conversations` (new route, designer's call under the maintainer's 2026-11-19 "whatever is
    reasonable on phones") is a `ListPage` of the sidebar's conversation groups (the same query
    as the sidebar, `conversationGroupsQuery`, with its search and 加载更多), with a "new" action
    to `/`. It is the compact bottom navigation's Chats tab and linked from nowhere else; the
    medium rail button opens the same list as a sheet without a route. It **renders at every
    class and never redirects by width**: the server cannot know the width, so a width redirect
    would run after hydration and flash, and a link someone shares must not depend on the
    sender's window. On expanded it is simply the same list the sidebar shows. `/` stays the new
    conversation and the home (maintainer decision 2026-11-07).
- **medium**: the thread centered as today; the right area a side sheet (`layout.panel` or the
  window less 48, whichever is smaller) with follow-finger dismiss (§7.4); conversations in the
  rail's sheet.
- **expanded**: as today (the right area inline from 1280, §3.3).

### 5.5 Approvals, inbox and files (optimized)

- **Inbox / approvals**: the InboxPage compact stack (§5.1); an item's screen puts the decision
  (allow once / allow for the session / deny, the scope picker) in the sticky bottom row; a
  decision pops back to the list and the next item is one tap. A link to an approval
  (`/chat/<id>#approval=<id>`, from the inbox, an IM card or later a notification) opens the
  conversation scrolled to the approval card, because the approval reads best in its context.
- **Files**: a file opened from a conversation is the pushed right-area page (§5.4) with the
  previewer full screen and share / download in its top bar; the file preview plugin's embeds
  get the full width; the HTML render (`HtmlDocumentFrame`) keeps its sandbox. The properties
  page's Files section is the compact list of a conversation's files.

### 5.6 Extension slots and client extensions (decided: slots declare their compact form)

Each slot in `UI_SLOTS` (`packages/plugin-sdk/src/ui-slots.ts`) gains a required field
`compact: "kept" | "drawer" | "hidden"` (designer's call on the values per slot):

| Slot | `compact` | Meaning on compact |
|---|---|---|
| `conversation.panel` | `drawer` | Opens as the pushed right-area page (§5.4) |
| `conversation.properties.section` | `kept` | In the properties page, in its anchor order |
| `conversation.tool-result.card` | `kept` | Inline in the thread at thread width |
| `conversation.empty` | `kept` | Above the new conversation's composer |
| `conversation.composer.frame` | `kept` | Must keep rendering `children` once (the options button lives there) |
| `file.preview` | `kept` | Full screen in the pushed file page |
| `org.page`, `platform.page` | `kept` | Full pushed pages (reached from Me) |
| `agent.detail.section`, `org.settings.section` | `kept` | Stacked in their page |
| `shell.brand` | `hidden` | No sidebar on compact; the built-in mark heads the Me page |
| `shell.overlay` | `kept` | Must stay `pointer-events: none` and clear of the bottom nav and safe areas |

- `drawer` means "the slot's content moves into a sheet or pushed page"; `hidden` means the slot
  is not rendered on compact. A **contribution may narrow** its slot's form in its manifest
  (`ui.<contribution>.compact`, `kept` → `drawer` → `hidden`), never widen it (designer's call).
- Adding the field changes the catalog contract: the slot versions stay (the field is additive
  for plugins), `pnpm gen:ui-slots` regenerates `docs/guide/ui-slots.md` and the web's copy, and
  `check:ui-slots` covers it.
- **Client extensions read the class**: `@capybara-hq/plugin-client` gains `useSizeClass()`
  (the host's value, `null` before hydration) and `useViewportSegments()` (§8). Plugin CSS uses
  the `size=` state token (§3.1). Both are additive to `CLIENT_API_VERSION` 1; the generated
  copies (`check:plugin-client-api`) follow.

## 6. What "optimized" means for the four places

Conversation, approvals, notifications (the inbox) and files get, beyond the template forms:
real-device acceptance at 382 and 390 (§11), touch-specific interaction tests (sheet drags,
keyboard, scroll pinning), and a maintainer hands-on review on a phone before the phase closes.
Other pages get the automated compact rule set only.

## 7. Mobile specifics (decided list, solutions designer's call)

### 7.1 Keyboard

- **Viewport meta** (none is set today; Next's default is `width=device-width, initial-scale=1`):
  the root layout exports Next's `viewport` with `viewportFit: "cover"` and
  `interactiveWidget: "resizes-content"`, and `themeColor` per scheme from the tokens. Chromium on
  Android then shrinks the layout viewport for the keyboard, so `100dvh` follows; iOS ignores
  `interactive-widget`, and the existing `visualViewport` handling in `AppShell`
  (`--cb-keyboard-inset`, `data-keyboard="open"`, `keyboardInset` in `shell/pointer.ts`) stays
  the iOS path. Pinch zoom stays (no `maximum-scale`).
- **Input pinned above the keyboard**: generalized from the conversation page to every template
  with a sticky bottom row (FormPage's ActionRow, the inbox decision row): they pad by
  `--cb-keyboard-inset` the same way.
- **iOS 100vh**: already solved (`100dvh` on the shell, PR #121); no `vh` for full-height boxes
  in new design CSS (the check of §11.4 flags `100vh`).
- The bottom navigation and the StatusBar hide while the keyboard is open.

### 7.2 Streaming output and scroll pinning

The thread already follows the bottom while the reader is within 48 px of it
(`templates/follow-bottom.ts`, native `overflow-anchor` where available). On mobile:

- The keyboard opening or closing, the top bar hiding and a sheet closing are **resizes, not
  scrolls**: a reader at the bottom stays at the bottom (the follow state is decided before the
  resize and reapplied after).
- A "latest" button (an icon button above the composer, end side) appears when the reader is
  away from the bottom and new content arrives; one tap scrolls to the bottom and resumes
  following.

### 7.3 Long threads (decided)

No windowing today. Step one is CSS-only: thread items get `content-visibility: auto` with a
`contain-intrinsic-size` from their last measured height, which keeps the DOM (find in page,
screen readers, the scroll anchoring above) and skips layout and paint off screen. Real
windowing (only mounting visible items) comes only if a measurement shows it is needed: on a
mid-range phone (Chromium's 4× CPU throttling as the CI stand-in) with a 2 000-item recorded log,
opening the conversation takes more than 1 s to paint its latest items, or streaming a reply
produces main-thread long tasks over 100 ms. Windowing must then keep follow-bottom,
anchor-to-item (`#approval=`) and find-in-page behavior.

### 7.4 Follow-finger sheets and drawers

Bottom sheets (the composer's options sheet `cb-bsheet`, filter sheets, the account sheet) and
side sheets (the medium right area and conversations list) track the finger:

- Drag from the handle or the head; drag from the body only when its scroll is at the top
  (bottom sheets) so content scrolling never fights the gesture.
- Release past 40 % of the sheet's size or above a velocity threshold dismisses; else it springs
  back. Pointer events with `touch-action` on the handle; no gesture library in apps/web (it is
  design code).
- Escape, the scrim and the close button still close; focus returns as today
  (`overlays/focus-return.ts`). Under `prefers-reduced-motion` the sheet still drags but snaps
  without animation.
- Full-page transitions are reserved for pushes (§4.1).

### 7.5 Safe areas, notch and home indicator

With `viewport-fit=cover` the shell pads by `env(safe-area-inset-*)`: the top bar by `top`, the
bottom navigation, a sticky ActionRow and the pinned composer by `bottom` (the home indicator),
both sides by `left` / `right` in landscape (the notch). The design package defines one set of
tokens, `--cb-inset-top|right|bottom|left` =
`max(env(safe-area-inset-*), var(--cb-shell-inset-*, 0px))`, so a native shell's own chrome
(§9.3) and the OS insets combine in one place. Nothing hardcodes a device's inset.

### 7.6 Background stream loss: resume from the event log

Mobile browsers suspend background pages and drop their EventSource. The event log is the
single source of truth, so resuming is reading it:

- On `visibilitychange` to visible, `pageshow` (back-forward cache) and `online`, the web checks
  each open stream and reopens a closed one **from the cached last seq** (the stream already
  resumes from a seq and sends the current draft after the catch-up, `lib/stream.ts`,
  `lib/live-drafts.ts`), and invalidates the `live` freshness class (inbox, conversation groups,
  files). Today the web has no visibility handling at all (no `visibilitychange` listener in
  `apps/web/src`); this is new.
- Telling the person about what happened while the page was away is the job of notifications,
  deferred to a later design (§10.3); IM channels do it today for conversations bound to them.

## 8. Foldables, including the iPhone Duo (decided)

Apple's iPhone Duo (announced 2026-09-09, on sale 2026-10-23; passport-style, 5.4" outer and 7.6"
inner displays, iOS 27). Safari 27.1 reports viewport widths 382–951 and heights 368–902 CSS px;
the outer display in portrait is 382 wide, the inner in landscape 951. So the outer display is
**compact**, the inner landscape **expanded**, the inner portrait **medium**: the size classes
cover it with no device code.

WebKit (Safari 27.1, https://webkit.org/blog/18486/webkit-features-for-safari-27-1/) ships, as
developer previews behind feature flags:

- the **Device Posture API**: the `device-posture` media query, `navigator.devicePosture`
  (`folded` / `continuous`) and its `change` event;
- the **Viewport Segments API**: the `horizontal-viewport-segments` /
  `vertical-viewport-segments` media queries, `env(viewport-segment-*)` and
  `window.viewport.segments`.

WebKit recommends responsive layout plus feature detection, never user-agent sniffing. Content
does not yet extend behind the outer display's side controls, and Apple has not decided how
`viewport-fit=cover` behaves there; WKWebView support for either API is not stated (it matters for
the Capacitor shell: open question 1).

The design:

- **Progressive enhancement inside the design shell.** `useViewportSegments()` returns the
  segments when `window.viewport?.segments` exists and holds two, else `null`; CSS uses the
  segment media queries and `env(viewport-segment-*)` guarded by `@supports` / `@media`. No API
  means a single screen, the default.
- **Two segments**: two-pane templates (the list-detail regions of §5.2, the conversation with
  its right area or with the conversations list) split **along the segment boundary**, each pane
  in one segment, and no content sits on the hinge (the gap between segments is padding). A
  template with nothing to split stays in one segment's width, centered in the first, never
  straddling the hinge with text.
- **No special layout for the `folded` posture.** Posture is not read for layout; it is only a
  hint the shell may expose to client extensions later.
- **Android foldables** follow the same rules (Chromium ships the same APIs); the classes cover
  the rest.
- Safe areas on the outer display come from `env(safe-area-inset-*)` whatever Apple decides
  (§7.5); nothing assumes content behind the side controls.

## 9. Shell environment (decided; the desktop spec references this section)

The contract between the web a deployment serves and any native shell that loads it (the desktop
client, the mobile app). The desktop spec fills in its capabilities; this section owns the shape,
the versioning, the security rule and how the web uses it.

### 9.1 Shape

A native shell injects one global, **only into the top frame of the deployment's origin** (the
exact origin of the profile the shell loaded):

```ts
interface CapybaraShell {
  /** The envelope version; bumped only on an incompatible change of this shape. */
  readonly version: 1;
  /** Which shell: drives nothing but the shell attributes of §9.3. */
  readonly kind: "desktop" | "mobile";
  /** The operating system, for platform conventions only (traffic lights, back gesture). */
  readonly platform: "macos" | "windows" | "linux" | "ios" | "android";
  /** The shell's own version, for reports and diagnostics; never parsed for features. */
  readonly shellVersion: string;
  /**
   * CSS px the shell's own chrome covers at each edge of the web view, beyond the OS safe areas
   * (macOS traffic lights with `titleBarStyle: hiddenInset`, a native title bar overlay).
   */
  readonly insets: { top: number; right: number; bottom: number; left: number };
  /**
   * The rectangle the shell's window controls occupy over the web view, in CSS px from the web
   * view's top-left corner (macOS traffic lights, a Windows caption-button overlay at the right);
   * null when there are none or they are hidden (fullscreen). Modelled on Window Controls
   * Overlay's `titlebar-area-*`. Optional: a shell without overlaid controls omits it.
   */
  readonly controls?: { x: number; y: number; width: number; height: number } | null;
  /** Capabilities by `name@major` (as extension points are named, `channel@1`). */
  readonly capabilities: Readonly<Record<string, object>>;
  /**
   * Insets, controls or capabilities changed (fullscreen hides the traffic lights; a capability
   * appears after load). Returns unsubscribe.
   */
  on(event: "change", listener: () => void): () => void;
}

declare global {
  interface Window {
    capybaraShell?: CapybaraShell;
  }
}
```

- The identifier is `window.capybaraShell` and the section name is "Shell environment"; both are
  fixed so the desktop and mobile specs can refer to them. The old desktop draft's
  `window.capybaraDesktop` is replaced by it.
- The type lives in `@capybara-hq/plugin-sdk` (types only, `shell-environment.ts`): it is a
  public contract shared with `capybara-hq/clients` (`packages/shell` implements it), and
  plugin-sdk is the package that imports nothing from Capybara (designer's call).
- **`controls` versus `insets`** (designer's call): `insets` reserves whole bands at the edges;
  `controls` says exactly where the window controls sit inside the top band, so the AppShell
  keeps that rectangle clear (the sidebar head starts after it, the top bar's leading or
  trailing items move aside) without hard-coding Apple's traffic-light width or assuming a
  Windows overlay on the right. The design CSS reads it only through tokens (§9.3); a shell that
  reports `controls` may still report a `top` inset for the band height. `data-shell-platform`
  stays for platform conventions only (back gesture, title placement), never for geometry.

### 9.2 Capabilities and versioning

- A capability is an object of functions under a key `name@major`, e.g. `device@1`. Additive
  changes (a new optional function or field) keep the key; an incompatible change is a new key
  (`device@2`), and a shell may offer both while deployments upgrade. The web uses the highest
  major it knows and **treats an absent capability as the browser** (the page behaves exactly as
  in a browser). Unknown keys are ignored.
- **Detection is by capability, never by user agent or `kind`**: `capybaraShell?.capabilities["device@1"]`.
  `kind` and `platform` only choose shell attributes (§9.3), never features.
- Web versions skew against shell versions in both directions (self-hosted deployments upgrade
  on their own schedule): the envelope `version` and the capability keys are what make that
  safe. A new capability needs no web change to be ignored and no shell change to be absent.
- **The registry of names** (each defined by the spec named, functions and confirmations there):

  | Capability | Owner | Purpose |
  |---|---|---|
  | `device@1` | Desktop spec | "Connect this machine" as a local device; status of this machine's device |
  | `notify@1` | Desktop spec | OS notifications while the shell runs; a click focuses the conversation |
  | `openExternal@1` | Desktop spec | Open an http(s) URL in the system browser |
  | `signIn@1` | Desktop spec (§6.5 there) | `start()`: sign in through the system browser (`/apps/authorize`, PKCE, back through the app's `capybara://auth/callback` scheme; `features.appSignIn` in `/api/v1/meta`). Offered by the desktop shell and by the later mobile app shell, which reuses the same flow (an `ASWebAuthenticationSession` / Custom Tabs style browser session returning through its scheme) |
  | `chrome@1` | This spec | The web tells the shell its scheme and background token so native chrome (status bar, window background, title bar overlay) matches the theme: `setAppearance({ scheme, background })` |

  Which shells offer `chrome@1`: the **desktop shell** always (window background and title bar
  follow the theme, desktop spec §7.3); the **mobile shell** later, only if it needs the native
  status bar's appearance (the web's `theme-color` and `black-translucent` status bar may be
  enough in a WebView). Without it the native chrome keeps the shell's defaults.

  A new capability is added here (name, owner) by the spec that defines it.

### 9.3 How the web uses it (no flash, no styles in apps/web)

- **Before the first paint.** The design package exports `ShellEnvironmentScript` (a tiny inline
  script the root layout renders in `<head>` with the request's CSP nonce, as the import map's
  script carries it today). It reads `window.capybaraShell` (Electron's preload and Capacitor's
  document-start user script run before any page script) and sets on `<html>`:
  `data-shell="desktop|mobile"`, `data-shell-platform="<platform>"` and the CSS properties
  `--cb-shell-inset-top|right|bottom|left`, and from `controls` the properties
  `--cb-shell-controls-x|y|width|height` (unset when `controls` is absent or null). No shell: nothing is set. The server render never
  depends on the shell, so hydration cannot mismatch (`<html>` already has
  `suppressHydrationWarning`).
- **The AppShell** subscribes to `change` after hydration and updates the same attributes and
  properties (fullscreen, a moved title bar), and sends `chrome@1.setAppearance` on theme
  changes.
- **Design CSS does the rest**, under `[data-shell]` selectors: the insets join the safe areas in
  `--cb-inset-*` (§7.5), and the controls rectangle in `--cb-shell-controls-*` decides which
  leading or trailing space the top bar and sidebar head keep clear (the traffic lights on macOS,
  a caption overlay on Windows) with no platform-specific widths in CSS; window
  **drag regions** (`app-region: drag`) on the sidebar head, the drawer bar / top bar and the
  conversation title bar, with `app-region: no-drag` on every interactive element inside them.
  Desktop-specific choices beyond that (which region drags, how wide) are the desktop spec's,
  realized in design CSS.
- **Features** that use a capability live in one small adapter in apps/web
  (`lib/shell.ts`: typed accessors returning `undefined` without the capability), so a page asks
  "can I connect this machine" and never reads `window.capybaraShell` itself. The adapter reads
  capabilities **reactively**: a `useShellCapability(key)` hook subscribes to `on("change")`
  (through `useSyncExternalStore`, `undefined` on the server and during hydration), because a
  shell may add a capability after the page loaded (the desktop offers `device@1` only once it
  has read the deployment's `/api/v1/meta`) or remove one; a page never caches a one-time read. A check
  (`web-shell-access`, §11.4) rejects other reads of the global in apps/web.
- **`data-cap-state`** gains `shell=desktop|mobile` (after hydration) for plugin CSS.

### 9.4 Security rule

- The shell injects the global **only into the top frame on the deployment's exact origin**, and
  re-checks **every call** natively against the calling frame's origin (Electron:
  `event.senderFrame`; Capacitor: the plugin bridge's origin check). Frames never get it:
  extension embeds under `/plugin-ui`, the sandboxed HTML render, file previewers, any other
  origin a navigation reaches (an SSO identity provider).
- A remote page gets **only the declared capabilities**. Nothing generic (no `invoke(name)`,
  no file system, no shell commands, no credentials).
- **Anything dangerous is confirmed natively** by the shell, in UI the page cannot draw or click:
  connecting the machine as a device, opening a file, anything that widens what the machine
  allows. A capability never returns a secret (a device credential, a sign-in token).
- **User activation and one dialog at a time.** A capability call that needs a native
  confirmation is refused unless the page has a transient user activation at the moment of the
  call (`navigator.userActivation.isActive`, checked by the shell's injected code before it
  forwards the call), so a page cannot raise native dialogs on its own. A shell shows **at most
  one native dialog at a time per profile and origin**; further confirming calls fail with
  `busy` until it is answered. This applies to every confirming capability alike, in the desktop
  and the mobile shell; the desktop's `device@1` (connect, resume, a widening ceiling request) is
  the first.
- Client extensions (L2 / L3) run in the page with full trust (client extensions spec §9.6), so
  they can reach the global like the web can. This is accepted: approval is governance, and the
  native confirmation is the barrier for anything dangerous. `@capybara-hq/plugin-client` does
  not re-export the shell.

## 10. PWA and notifications (decided: an installable PWA now, push deferred)

### 10.1 What exists today

- The kernel has **no push or notification model**. People learn about events through the
  web's inbox (`/inbox`, `InboxService`: pending approvals for the current user, catalog
  requests, schedule attention, org notices for admins) and the conversation stream.
- **IM channels are the mobile notification path today**: a conversation bound to a channel
  thread gets its approval and question cards and its results in the chat
  (`channels/outbound.ts`, `channels/cards.ts`), and scheduled tasks deliver to a chat. A
  conversation started on the web notifies nobody.

### 10.2 The PWA (decided; details designer's call)

- **Manifest** from a Next metadata route (`app/manifest.ts`), served by the deployment, so the
  installed app's **name and icon are per deployment (decided)**: name and short name from the
  kernel config `platform.name` (`CAPYBARA_PLATFORM__NAME`, introduced by the desktop spec,
  PR #407, and read through `GET /api/v1/meta`), "Capybara" when unset; the icons from the
  platform icon setting (§10.2.1); `display: "standalone"`, `start_url: "/"`, `scope: "/"`,
  `theme_color` / `background_color` from the platform default theme's tokens. The document
  `<title>` default and the `apple-mobile-web-app-title` follow the same name.
- iOS: `appleWebApp` metadata (capable, `black-translucent` status bar with the safe areas of
  §7.5).
- **No service worker in this design** (designer's call): installability rests on the manifest
  (Safari's Add to Home Screen needs none). If a browser's install criteria require one, a worker
  with no fetch handler and no caching is added; a cached UI would skew against the
  deployment's kernel, exactly what loading from the deployment avoids. Push will bring its own
  worker with its later design.
- **Install** is the browser's own (Chrome's install prompt, Safari's Add to Home Screen); the
  Me page offers a short how-to on iOS.

#### 10.2.1 The platform icon (designer's call)

- **Where**: the super admin's deployment settings, `/admin/settings` 外观, beside the platform
  default theme: a 「应用图标 / App icon」 section with a preview on light and dark grounds,
  upload, and 恢复默认 / Restore default. Org admins cannot change it (one installed app per
  deployment).
- **What is uploaded**: an **app icon**, a square PNG of exactly 512 × 512 (required), and
  optionally a **maskable** variant, a 512 × 512 PNG whose subject stays inside the central 80 %
  safe zone (Android launchers crop it to their shape), and an **SVG favicon**. Each at most
  1 MB; the kernel checks the PNG header's size and the type (no image library: nothing is
  resized). Without a maskable variant the manifest lists the app icon with purpose `any` only.
- **Stored** in object storage under the kernel's `deployment/` prefix, with a row in PG
  (`capybara.platform_icons`: purpose, object key, SHA-256, updated at); served by a public
  route `GET /api/v1/platform/icon/<purpose>?v=<sha256>` with an immutable cache (the hash in the
  URL changes on upload).
- **Uses**: the manifest's icons (512, and the maskable one), the `apple-touch-icon` (iOS scales
  the 512), the favicon when the active theme sets none (a theme's `logo.favicon` still wins for
  the tab), and the desktop shell as a consumer if it wants one (its start page, `/api/v1/meta`,
  the Dock icon at runtime; the desktop spec decides).
- **Default**: the Capybara icon set shipped with the web (app, maskable, monochrome SVG).

### 10.3 Notifications (deferred)

Push notifications get their own later design (maintainer decision 2026-11-19). What is already
decided, as its input (one line each, no mechanism):

- **Four categories**: *waiting for you* (an approval, question or connect request awaiting the
  person: `approval_requested`, `question_asked`); *agent replies* (a run ends completed or
  failed in a conversation the person is not viewing: `RunFinish.finishIn`); *task status* (a
  background task or background sub-agent finishes or fails: `background_task_finished`,
  `subagent_finished`); *scheduled tasks* (a task run finishes or fails:
  `ScheduleRunTracker.onRunFinished`).
- **Per-category opt-out per person**: each person chooses, per category, whether to receive
  push.
- **No deduplication with IM**: a channel card and a push may both arrive for the same event.
- **No official push relay** run by Capybara.
- **The official mobile app has no native push**; native push exists only in an enterprise's own
  fork of the clients repository, with its own credentials (§10.4).

### 10.4 Official apps and forks (decided)

- **Capybara publishes only the official desktop app and the official mobile app shell**, with
  the fixed Capybara name and icon. There is no supported white-label product. The clients
  repository is open source; an enterprise that wants its own brand forks it and publishes its
  own build in the stores itself. The fork keeps the brand (app name, icons, bundle id /
  application id) in one place in the clients repository (`packages/shell` brand config,
  designer's call), so a fork changes one file and its assets.
- **Sign-in in the mobile app shell** reuses the desktop's system-browser flow (`signIn@1`,
  §9.2): the same kernel routes, PKCE and an app scheme registered in `auth.appRedirectUris`.

## 11. Verification (decided)

### 11.1 Visual baselines per class per template

The screenshot suite (`apps/web/visual/`, rendered only by the `visual-update` workflow) gains a
width matrix for every template's catalog page, dark and light:

| Width | Why |
|---|---|
| 382 | iPhone Duo outer display, portrait (real-device sample; the Duo simulator ships with Xcode 27.1) |
| 390 | The existing phone width |
| 768 | Medium (a tablet in portrait) |
| 951 | iPhone Duo inner display, landscape (expanded at its smallest real width) |
| 1440 | The existing desktop width |

Heights use the simulator's reported sizes for the Duo samples (recorded in the spec file of the
test when added), 844 for 390, 1024 for 768, 900 for 1440. The short-window form (§3.2) gets one
baseline at 844 × 390.

### 11.2 Reference set and fidelity

New per-class states (the bottom navigation, the top bar, the pushed page, the list-detail stack,
the sheets' drag states) go through the design spec's change process (§10 of the design spec):
state lists, size tables, reference blocks, the blind side-by-side review, `ACCEPTED`.

### 11.3 The compact rule set

- **Playwright** (`apps/web/visual/compact.interaction.spec.ts`, designer's call): for every
  template's catalog page at 382 and 390, with JavaScript on and off (the first paint, as the
  writing-web-ui skill requires): no horizontal page scroll
  (`scrollingElement.scrollWidth <= innerWidth`); every interactive element has a 40 × 40 hit
  area; the primary action is reachable without horizontal scrolling; nothing is covered by the
  bottom navigation at the end of a scroll; text fields are at least 16 px on a coarse pointer.
- **jsdom** (`findCompactViolations` in `@capybara-hq/design/reference`, next to
  `findNestedBoxes`): structural rules on the rendered DOM: no action reachable only by hover,
  `title` or a context menu; every icon-only control has an accessible name; a list-detail region
  in its compact form has a back control.
- **Segments**: `useViewportSegments` and the segment split are unit-tested with a fake
  `window.viewport.segments` and `matchMedia`; a Chromium run with display-feature emulation is
  added if it proves stable; the Duo simulator check is manual and part of P2's acceptance.

### 11.4 Static checks (designer's call)

- `design-breakpoint`: a width media query in `packages/design/src/styles` uses only the class
  widths or a named fit threshold (§3.3); no `100vh` for full-height boxes.
- `web-shell-access`: `window.capybaraShell` is read only in `apps/web/src/lib/shell.ts` and the
  design package.
- `check:ui-slots` covers the new `compact` field.

## 12. Phases (designer's call)

- **P1: shell, templates, keyboard, conversation.** Size classes and the breakpoint migration
  (640 / 960 / 1280 → 600 / 841 / 1280 per §3.3, the sidebar collapse toggle), the compact
  bottom navigation, top bar
  and push model, the medium rail, `/conversations` and `/me`, the template forms of §5.1, the
  conversation, inbox and files (§5.4, §5.5), the viewport meta and safe areas, the keyboard
  generalization, scroll pinning, follow-finger sheets, foreground resume (§7.6), the visual
  matrix and the compact rule set.
- **P2: slots, client extensions, foldables, shell environment.** The `compact` slot field and
  manifest narrowing, `useSizeClass` / `useViewportSegments` in plugin-client, the `size=` and
  `shell=` state tokens, the segment-aware split, the Shell environment (`ShellEnvironmentScript`,
  insets, drag regions, `chrome@1`, `lib/shell.ts`) in time for the desktop client.
- **P3: PWA.** The manifest with `platform.name` and the platform icon setting. Push
  notifications follow in their own design (§10.3).

## 13. Changes by package

- `packages/design`: size classes, `useSizeClass`, `useViewportSegments`, the bottom navigation,
  top bar, push transitions, `ListDetail`, follow-finger sheets, per-class template forms,
  `ShellEnvironmentScript`, inset tokens, drag regions, `findCompactViolations`; the design spec
  §4, §5, §6.13, §6.16 and §7.3 updated first.
- `apps/web`: the viewport export, `/conversations`, `/me`, the nav data for the bottom
  navigation, `lib/shell.ts`, foreground resume, the manifest, the 应用图标 settings section,
  i18n (zh and en).
- `packages/plugin-sdk`: `compact` on `UiSlotSpec`, the manifest narrowing, the
  `CapybaraShell` types.
- `packages/plugin-client`: `useSizeClass`, `useViewportSegments`.
- `packages/kernel`: the platform icon (table, upload and public routes) and its migration.
- `tools/checks`: `design-breakpoint`, `web-shell-access`, the slot field in `check:ui-slots`.

## 14. Facts in the code that differ from the decisions

Recorded so review sees them; the design above resolves each.

1. **Breakpoints**: the design package uses 640 (phone), 960 (drawer) and 1280 (rail, right area
   as a Sheet), in 23 + 4 + 3 media queries and in `SIDEBAR_RAIL_QUERY` /
   `SIDEBAR_DRAWER_QUERY`; the decision is 600 / 841 for the classes and the two rules of §3.3
   (full sidebar from 841, inline right area from 1280).
2. **The drawer**: below 960 the sidebar is a drawer from a menu bar, holding the full nav and the
   conversations; the decision replaces it with the bottom navigation (compact) and the rail
   (medium).
3. **The rail below 1280**: today the sidebar turns into the rail by itself below 1280; the
   decision keeps the full sidebar from 841 and makes the rail the person's choice there. The
   right area's sheet below 1280 is unchanged.
4. **Content minimum width 560** (design spec §4.3) does not fit a 600 window beside the 48 rail;
   lowered to 552 (§4.3).
5. **No files page and no notifications page** in the workspace: the decision keeps it that way
   (no files item), and the inbox is the notifications page. §4.2.
6. **Settings sub-nav on phones** is a decided sideways-scrolling row (2026-11-09), not a
   list-detail stack; kept.
7. **No viewport meta** beyond Next's default and **no visibility handling** in the web; safe
   areas are used only by the composer's bottom sheet.
8. **No push or notification model** in the kernel; this design keeps it so (push deferred,
   §10.3).
9. **The desktop draft on `origin/docs/desktop-client`** still names its bridge
   `window.capybaraDesktop` with `notify` and `openExternal` as plain functions; the rewrite
   adopts `window.capybaraShell` and the capability keys of §9.2.

## 15. Open questions

Neither blocks this design; both are answered at the mobile app shell / real-device stage.

1. **WKWebView** support of the Device Posture and Viewport Segments APIs (the Capacitor shell):
   unknown until Apple says; the design degrades to one screen without them.
2. **`viewport-fit=cover` on the iPhone Duo outer display**: Apple has not decided; we follow
   `env()`. Revisit when Safari ships the behavior.

Settled since the first draft and moved out of this list: long threads (§7.3) and the
short-window trim (§3.2) (decided); the lock-screen text moved to the later push design (§10.3).

## AGENTS.md rules touched

- **Web UI.** Kept and extended: pages still write no styles; every per-class form lives in
  `packages/design` templates and the shell; new pages (`/conversations`, `/me`) use templates,
  `defineQuery` reads and `useAppMutation` writes; first paint follows the window through CSS. New checks `design-breakpoint` and
  `web-shell-access` join `check:web-ui` / `tools/checks/README.md`.
- **Extension UI.** `UI_SLOTS` gains `compact` per slot (`pnpm gen:ui-slots`, `check:ui-slots`);
  embeds and the HTML render never get the shell global; embed tokens unchanged.
- **SDK public API.** `UiSlotSpec.compact`, the manifest narrowing and the `CapybaraShell` types:
  `pnpm gen:sdk-api` and a changeset bumping `@capybara-hq/plugin-sdk`;
  `useSizeClass` / `useViewportSegments` in `@capybara-hq/plugin-client` with its changeset and
  `check:plugin-client-api`.
- **Dependency direction.** apps/web still depends only on `@capybara-hq/design` and implements
  plugin-client's interface; the shell contract types live in plugin-sdk, which imports nothing.
- **Multi-replica discipline.** Nothing new lives in process memory: the sidebar choice is a
  cookie, the platform icon is in object storage and PG; push, the one owed-work feature, is
  deferred.
- **Migrations.** One new expand-only table in schema `capybara` (`platform_icons`).
- **Kernel.** The platform icon routes (upload for super admins, public read) with
  `createZodDto` DTOs and registered error codes, in an existing or a small new module.
- **Platform tool.** The icon upload route gets a Platform operation or an exclusion with a reason
  (a file upload from the settings page); the public read route is `@Public` and excluded.
- **Extensions / plugins.** Untouched.
- **Config.** No new kernel config; `platform.name` comes from the desktop spec.
- **Object storage.** The platform icon lives under the kernel's `deployment/` prefix.
- **Language / i18n.** New UI text in zh and en (平台 / 超级管理员 / 智能体); model-facing text
  untouched.
- **Tests.** New visual and Playwright specs, design jsdom tests, and kernel integration tests for
  the platform icon routes (integration, the default list).
- **CSP.** `ShellEnvironmentScript` carries the request nonce; no new script source.
- New area rule to add to AGENTS.md: "**Mobile and shells:** layout follows size classes by window
  width only (compact < 600, medium 600–840, expanded ≥ 841), adapted in design templates and the
  shell, never in pages; native shells are detected only through `window.capybaraShell`
  capabilities, never the user agent; dangerous shell capabilities are confirmed natively."
