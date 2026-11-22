# Responsive System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task, layered with the repo's `wave-planned-subagent-development` skill (the wave table below is its wave plan). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One responsive system from expanded to compact: the approved compact list pattern, one
object-actions model, a typed page contract (`ListPage.scope`, `Column.compact`), the
same-DOM / two-DOM rule through one helper, and guards, rolled out in phases 0–3.

**Architecture:** Everything structural lives in `packages/design` (templates, shell, components,
CSS); `apps/web` only declares data. Same DOM restyled by media / container queries by default;
where a structure differs per class, `ClassForms` renders both on the server, CSS shows one, and
only the matching one stays mounted after hydration. Sizes come from tokens (the
`fix/compact-control-sizes` rule), never literals.

**Tech Stack:** React 19, Next (apps/web), CSS in `packages/design/src/styles`, vitest + jsdom,
Playwright (`apps/web/visual`), oxc-based checks in `tools/checks`.

**Spec:** `docs/superpowers/specs/2026-11-22-responsive-system-design.md` (decisions D1–D10, §9).
Phase 0b implements the companion `docs/superpowers/specs/2026-11-22-mobile-interaction-model-design.md`
(its §12; decisions D1–D16 there, §13).
Read it before any task; section numbers below (§2.1 …) are that spec's.

## Decisions (maintainer 2026-11-22)

- **P1** Phase 0 ships as two PRs: system components (waves 1–2), then templates follow (waves 3–5).
- **P2** Template-only props (`PageHeaderProps.primaryForm`, `Tabs look`, `Segmented` / `Tabs`
  `chipsCompact`) are enforced by a check: rule `web-ui-template-only-props` in T0.4, proven red
  first and listed in `tools/checks/README.md`.
- **P3** An action sheet that holds a link stays the web sheet (links stay links: open in a new
  window, copy the address); a native shell's `menu@1` is used only for sheets without links.
- **P4** The responsive baselines are three widths (390 touch, 768, 1440) × two themes.

## Status after the merges of 2026-11-22 (read first)

Merged since this plan was written: #570, #572 (compact title bar, no path row), #575 (mobile sizes
under compact or touch), #579, #587 and #593 (back animation), #591 (bottom sheet look, design spec
§6.59), #596 (compact drawer, `ConversationList` §6.60, minimal `ActionSheet` / `actionSheetItems`
/ `useLongPress` §6.61, the list FAB as a CSS variant of the head's primary §6.62, `ScopeChips` +
`ListPage.scope` §6.63). Consequences:

- The **[sizes]** and **[title-bar]** dependencies are satisfied; those markers no longer block.
- **T0.3** becomes *absorb and verify*: `ActionSheet`, `actionSheetItems`, `useLongPress` exist;
  the task adds what is missing (the `ObjectActions` export, the native `menu@1` form for sheets
  without links per P3, the listed tests that do not exist yet) and changes nothing that works.
- **T0.12 is dropped**: the FAB is the head's primary restyled by CSS (§6.62, one DOM; `ListFab`
  was dropped in #596). T0.11's `primaryForm="fab"` means "the template's `data-fab` CSS form".
- **T0.7** keeps only the segmented look of the head tabs; the chips half is done by `ScopeChips`,
  so `chipsCompact` is dropped (and with it from P2's template-only props).
- **T0.13** absorbs `ListPage.scope` (exists) and builds the rest: the compact bar, quick return,
  the one scroller, field filters in the Filter sheet. It no longer depends on T0.12.
- **T0.5** writes the remaining spec text; new design spec sections start at §6.64 (§6.59–§6.63
  are taken by the merged work).
- **T0b.3** generalises `ConversationList`'s infinite end (§6.60) instead of starting fresh;
  **T0b.6** and **T0b.8** no longer wait on branches. Phase 1's conversations page task (T1.6) is
  done by #596 and dropped.

## Global Constraints

- apps/web writes no styles and never reads the size class, pointer or shell (spec §4, §7).
- Width media queries only at 599 / 600 / 840 / 841 / 1280 (`design-breakpoint`); frame fits are
  container queries.
- Sizes from tokens: `touch.hit` 44, `touch.prominent` 52, `control.*`, `row.*`, `space.*`,
  `radius.md`, `radius.pill`; text fields ≥ 16 px on compact or touch.
- Grouped list row ≥ 64 with a lead (40 avatar + `space.3` × 2), ≥ 52 without.
- Long press: 500 ms, cancelled by movement over 10 px; context-menu event opens the same sheet.
- D1 secondary actions → top row "…" on compact; D2 non-list primary → full-width button under
  the title; D4 ≥ 4 tabs stay a scrolling tab row; D5 bulk hidden on compact; D6 no long press on
  inbox rows; D7 one scroller per pushed page; D8 super admin sizing-only; D9 medium keeps the
  expanded head; D10 count = first tab's count unless `header.count`.
- New UI text in zh and en (`check:i18n`); zh never 企业 or the Latin word for agent.
- Every new check proven red first with a fixture (`tools/checks/README.md` entry, full vs diff
  stated).
- Changesets: `@capybara-hq/design` and `@capybara-hq/capybara` for every phase PR that touches
  them. Visual baselines only via the `visual-update` workflow; never run it locally.
- Commits: Conventional Commits, body lines ≤ 100, ending
  `Co-Authored-By: Capybara <noreply@capybarahq.com>`.

## Dependencies on other lines

- **`fix/compact-control-sizes`** (size tokens under compact or touch): tasks marked **[sizes]**
  start after it is merged to `main` (rebase first); they read the tokens, never redefine them.
- **`fix/desktop-compact-title-bar`** (compact path row removed by CSS for every template; flat
  desktop title bar; edits `shell.css`, `shell-environment.css`, `conversation-page.css`,
  `title-bar.tsx`): tasks marked **[title-bar]** start after it is merged.
- Phase 0 starts with wave 1, which needs neither.

## Review Focus

- **A fast tap right after hydration** on a compact list: the pruned copy must not swallow it, and
  focus must not land in the hidden copy (T0.2 test `prunes without losing focus`).
- **Long press on a row link**: the release must not navigate, iOS must not show the link callout,
  a scroll gesture must not open the sheet (T0.3 tests `release after long press does not click`,
  `move cancels`).
- **Window resized across 600 with a sheet or a menu open**: the sheet closes or stays usable; no
  orphaned history entry (T0.3 test `closes when the form unmounts`).
- **Quick return on a short list** (content shorter than the screen): no jitter, the bar never
  hides (T0.13 test `short list never hides the bar`).
- **Back from a detail to a scrolled list**: scroll position and the scrolled-title state are
  restored together (T0.6 test `titleAway follows restored scroll`).

---

## Wave plan (phase 0)

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| T0.1 inventory script | — | `tools/checks/src/template-inventory.ts`, test | normal | 1 | batch |
| T0.2 `ClassForms` | — | `design/src/shell/class-forms.tsx`, `styles/class-forms.css`, `test/width.ts` | **judgment** | 1 | most capable, alone |
| T0.3 `ActionSheet` + `useLongPress` (absorb/verify #596) | — | `design/src/overlays/action-sheet.tsx`, `long-press.ts`, `overlays.css` (new block at end) | **judgment** | 1 | most capable, alone |
| T0.4 guards | — | `tools/checks/src/web-ui.ts`, `design-dual-render.ts`, fixtures, README | normal | 1 | batch |
| T0.5 spec text | — | `docs/design/spec.md`, mobile layout spec, `AGENTS.md` | normal | 1 | batch |
| T0.6 shell: actions, scrolled title, scroller hook | T0.2 [title-bar] | `shell-page.tsx`, `app-shell.tsx`, `floating-bar.tsx`, `shell/compact-scroll.ts`, `shell.css` | **judgment** | 2 | most capable, alone |
| T0.7 Tabs segmented + chips looks | — [sizes] | `display/tabs.tsx`, `display.css` | normal | 2 | batch |
| T0.8 CardGrid compact rows | T0.2, T0.3 [sizes] | `display/card-grid.tsx`, `card-grid.css` | **judgment** | 2 | most capable, alone |
| T0.10 DataTable row mapping | T0.2, T0.3 [sizes] | `table/*`, `table.css` | normal | 2 | batch |
| ~~T0.12 `ListFab`~~ | dropped (#596: FAB is a CSS form of the head primary, §6.62) | — | — | — | — |
| T0.9 ObjectRow compact rows | T0.2, T0.3 [sizes] | `display/object-list.tsx`, `templates.css` (object-row block), `touch.css` | normal | 3 | batch |
| T0.11 PageHeader compact form | T0.2, T0.6, T0.7 [title-bar] | `shell/page-header.tsx`, `shell.css` (head block) | normal | 3 | batch |
| T0.13 ListPage compact form | T0.6, T0.7, T0.8, T0.10, T0.11 | `templates/list-page.tsx`, `list-page.css`, `shell/body.tsx` | **judgment** | 4 | most capable, alone |
| T0.14 other templates | T0.6, T0.11 | `templates/frame.tsx`, detail / settings / overview / trace / form / wizard / status / inbox templates, `templates.css` | normal | 4 | batch |
| T0.15 catalog, fidelity, i18n, changesets | all above | `apps/web/src/dev/catalog/*`, `apps/web/visual/*`, `docs/design/reference/src/*`, `design/src/i18n.ts` | normal | 5 | batch |

No task touches a trust boundary, a migration, multi-replica state or a cross-tenant rule, so no
task is `high` by the repo's definition; the four **judgment** tasks (hydration, history and
scroll, touch input) are still reviewed alone on the most capable model because their failures
are invisible in jsdom.

Phase 0 ships as two PRs (P1): waves 1–2 ("system pieces", no visible change until used) and
waves 3–5 ("templates follow"). Phases 1–3 are one PR each.

---

## Phase 0: system pieces (design package and guards)

### Task T0.1: Inventory script

**Files:**
- Create: `tools/checks/src/template-inventory.ts`
- Test: `tools/checks/test/template-inventory.test.ts`
- Modify: `tools/checks/package.json` (script `inventory:templates`), `docs/superpowers/specs/2026-11-22-responsive-system-design.md` §6 (only if counts differ)

**Interfaces:**
- Produces: `inventoryTemplates(appDir: string): InventoryRow[]` with
  `type InventoryRow = { route: string; templates: string[]; variant?: "cards" | "objects" | "records"; tabs: number; filtersKind?: "segmented" | "tabs" | "fields"; dataTables: number; audience: "member" | "org-admin" | "super-admin" | "public" }`.

- [ ] **Step 1: Failing test** `lists one row per page.tsx with the templates its view and imported components draw`: on a fixture app dir (`tools/checks/fixtures/template-inventory/`: an `/agents` view with `ListPage variant="cards"` and a `Segmented` in `filters`, an `/admin/x` view importing a component that draws `DetailPage`), expect
  `[{ route: "/admin/x", templates: ["DetailPage"], audience: "super-admin", … }, { route: "/agents", templates: ["ListPage"], variant: "cards", filtersKind: "segmented", audience: "member", … }]`.
- [ ] **Step 2: Run** `pnpm exec vitest run tools/checks/test/template-inventory.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** with oxc: resolve `page.tsx` → `./view` → relative / `@/` component imports (one level of re-export), collect `<Template` JSX names; audience: `/admin/**` super-admin; the desktop-only route list from `apps/web/src/components/shell/nav.tsx` (`desktopOnly`) plus `/settings/**` org-admin; `(auth)` and `/s/` public; else member.
- [ ] **Step 4: Run** the test → PASS; run `pnpm --filter @capybara-hq/checks inventory:templates` on the real tree and compare with spec §6.5 (79 templated routes; M 26 / O 25 / S 28). If any count differs, correct spec §6 in the same commit and say so in the commit body.
- [ ] **Step 5: Commit** `chore(checks): inventory template use per route (#568)`.

### Task T0.2: `ClassForms` helper

**Files:**
- Create: `packages/design/src/shell/class-forms.tsx`, `packages/design/src/styles/class-forms.css`
- Modify: `packages/design/src/shell/index.ts`, `packages/design/src/index.ts`, `packages/design/test/width.ts` (export `renderAtClass`)
- Test: `packages/design/test/class-forms.test.tsx`

**Interfaces:**
- Produces:
  - `ClassForms(props: { compact: ReactNode; wide: ReactNode }): JSX.Element` — before hydration
    both, wrapped in `<div data-class-form="compact|wide" style="display: contents">` (CSS in a new
    `styles/class-forms.css`, imported from `index.css`, hides the other below / from 600) with `inert` on the
    copy CSS hides; after hydration only the copy matching `useSizeClass()` (`"compact"` vs
    medium / expanded).
  - `useClassForm(): "compact" | "wide" | null` (null before hydration).
  - test helper `renderAtClass(width: number, ui: ReactElement): RenderResult` (stubs
    `matchMedia` with `matchMediaFor(width)`, renders inside `DesignProvider locale="zh"`, flushes
    the hydration effect).

- [ ] **Step 1: Failing tests**: `server render holds both copies` (`renderToString` contains both
  `data-class-form` values); `after hydration at 390 only compact is mounted`; `after hydration at
  1440 only wide`; `crossing 600 swaps the copy` (fire the media listener); `the pre-hydration
  hidden copy is inert`; `prunes without losing focus` (focus a button in the shown copy before
  hydration completes; after prune `document.activeElement` is that same element).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/design/test/class-forms.test.tsx` → FAIL.
- [ ] **Step 3: Implement** on `useHydrated` + `useSizeClass`; the shown copy keeps its React
  identity across the prune (render both with stable keys `compact` / `wide`, drop only the other).
- [ ] **Step 4: Run** → PASS. Then `pnpm exec vitest run packages/design` → PASS.
- [ ] **Step 5: Commit** `feat(design): ClassForms, one way to render a structure per size class (#568)`.

### Task T0.3: `ActionSheet` and `useLongPress` (absorb and verify #596)

**Files:**
- Create: `packages/design/src/overlays/action-sheet.tsx`, `packages/design/src/overlays/long-press.ts`
- Modify: `packages/design/src/overlays/index.ts`, `packages/design/src/styles/overlays.css` (append one block), `packages/design/src/i18n.ts` (key `overlay.actions`: zh 操作, en Actions — the fallback title)
- Test: `packages/design/test/action-sheet.test.tsx`

**Interfaces:**
- Produces:
  - `type ObjectActions = { primary?: { label: string; href?: string; onSelect?(): void; loading?: boolean }; items?: MenuItem[] }` (exported from `overlays/index.ts`).
  - `actionSheetItems(a: ObjectActions): MenuItem[]` — primary first, then items; separators kept,
    a submenu flattened into its items; empty when nothing is actionable.
  - `ActionSheet(props: { open: boolean; onOpenChange(open: boolean): void; title: string; items: MenuItem[] }): JSX.Element` — on `BottomSheet`; rows `data-part="action-sheet-item"`, `touch.hit` high, `danger` → `data-tone="fail"`; a link row through `useDesignLink`; a pick closes, then runs.
  - Native (P3): with `useNative()?.menu` and no `href` item, the sheet opens as the platform's
    action sheet (`useNativeMenuTrigger`); with any link item it stays the web sheet, whose link
    rows keep link behaviour (a modified click or the system's link menu opens a new window or
    copies the address). Tests: `native menu used for a sheet without links`, `sheet with a link
    stays the web sheet in a native shell`.
  - `useLongPress(onLongPress: () => void, opts?: { enabled?: boolean }): { onPointerDown; onPointerMove; onPointerUp; onPointerCancel; onContextMenu; onClickCapture }` — 500 ms, 10 px; touch pointers only for the timer; `contextmenu` always (when enabled) with `preventDefault`; after a fired long press the next click in the element is cancelled.

- [ ] **Step 1: Failing tests**: `lists primary then menu items`; `danger item is in the fail tone`;
  `a pick closes the sheet then runs`; `link item navigates through the design link`;
  `long press opens after 500 ms` (fake timers, pointerType touch); `move cancels` (12 px);
  `contextmenu opens and prevents the browser menu`; `release after long press does not click`;
  `disabled hook does nothing and leaves contextmenu alone`; `closes when the form unmounts`
  (unmount the owner with the sheet open: no `history` entry left, `useOverlayHistory` cleaned).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/design/test/action-sheet.test.tsx` → FAIL.
- [ ] **Step 3: Implement**; CSS: rows padded `space.4` inline, `touch.hit` min-height, separators
  `line-soft`; `-webkit-touch-callout: none` is the caller's (T0.8/T0.9/T0.10).
- [ ] **Step 4: Run** → PASS; `pnpm check:i18n` → PASS.
- [ ] **Step 5: Commit** `feat(design): ActionSheet and long press for an object's actions (#568)`.

### Task T0.4: Guards

**Files:**
- Modify: `tools/checks/src/web-ui.ts` (rules `web-ui-size-branch`, `web-ui-filters-scope` with ratchet `SCOPE_PENDING`), `tools/checks/README.md`
- Create: `tools/checks/src/design-dual-render.ts` (wired into `pnpm check`), fixtures `tools/checks/fixtures/web-ui/size-branch.tsx`, `filters-scope.tsx`, `tools/checks/fixtures/design-dual-render/*`
- Test: `tools/checks/test/web-ui.test.ts`, `tools/checks/test/design-dual-render.test.ts`

**Interfaces:**
- `web-ui-size-branch`: in `apps/web/src` (not tests, not `src/dev/`), importing `useSizeClass`,
  `useMediaQuery`, `useTouch`, `SIZE_CLASS_QUERIES`, `TOUCH_QUERY`, or reading `window.matchMedia` /
  `innerWidth` fails; allowlist `SIZE_BRANCH_ALLOWED = [{ path, reason }]` seeded with
  `components/shell/AppFrame.tsx`, `components/client-ext/host-api.ts`,
  `components/extension-ui/ExtensionSlot.tsx`, `lib/client-host/api.generated.ts` (reasons from
  their current use).
- `web-ui-filters-scope`: a JSX `Segmented` or `Tabs` inside the value of `ListPage`'s `filters`
  (directly or through a same-file const / hook return) fails; `SCOPE_PENDING` lists
  `app/(app)/agents/view.tsx`, `app/(app)/admin/agents/templates/view.tsx`,
  `app/(app)/admin/connectors/templates/view.tsx`, `app/(app)/admin/plugins/market/view.tsx`
  (ratchet: a clean entry fails as stale).
- `web-ui-template-only-props` (P2): in `apps/web/src`, passing `primaryForm` to `PageHeader`
  (or inside a `header` object given to a template), or `look` to `Tabs` fails (`chipsCompact` was dropped: `ScopeChips`, §6.63); only `packages/design` templates set them. Red fixture
  `tools/checks/fixtures/web-ui/template-only-props.tsx`.
- `design-dual-render`: in `packages/design/src`, a function calling `useHydrated` and one of
  `useSizeClass` / `useMediaQuery(SIZE_CLASS_QUERIES.*)` / `useTouch` outside
  `shell/class-forms.tsx` fails; `DUAL_RENDER_PENDING` lists today's users (page-header, body,
  sidebar, app-shell, menu …) with a `max` count, to be emptied as tasks move them to `ClassForms`.

- [ ] **Step 1: Red fixtures + failing tests** for each rule (violation found, allowlisted file
  passes, stale pending entry fails).
- [ ] **Step 2: Run** `pnpm exec vitest run tools/checks/test/web-ui.test.ts tools/checks/test/design-dual-render.test.ts` → FAIL.
- [ ] **Step 3: Implement**; README entries: all four full on PRs (cheap source scans).
- [ ] **Step 4: Run** tests → PASS; `pnpm check` → PASS on the real tree.
- [ ] **Step 5: Commit** `feat(checks): keep size-class logic out of pages and in ClassForms (#568)`.

### Task T0.5: Spec text

**Files:**
- Modify: `docs/design/spec.md` (§4.2 compact head, §5.1–5.12 "Classes" rows per spec §3, §6.4
  segmented look and chips, §6.6 row mapping, §6.17 compact rows, §6.34 compact rows and action
  sheet, §6.56 scrolled title and `ShellPage.actions`, remaining new sections from §6.64; §6.59–§6.63 exist after #591 / #596),
  `docs/superpowers/specs/2026-11-19-mobile-layout-design.md` (§4.5 "Large list row" amended: the
  grouped list of a list page has one card and inset hairlines, maintainer decision 2026-11-22;
  §5.1 table rows), `AGENTS.md` (Web UI line: "pages never read the size class
  (`web-ui-size-branch`); a structure that differs per class goes through `ClassForms`").
- Size tables: `card-grid` `narrow` rows replaced by `object-card | narrow | height | 64`,
  `padding-top | space.3`, `padding-left | space.4`, `card-grid | narrow | border-top-left-radius |
  radius.md`, `card-grid | narrow | background-color | color.panel`; new state lists for
  `action-sheet` (`open`) and `list-fab` (`narrow`) with their size tables (rows `touch.hit`,
  `touch.prominent`, `radius.md`, `color.accent`).

- [ ] **Step 1:** write the text, each change marked "maintainer decision 2026-11-22".
- [ ] **Step 2: Run** `pnpm check` (spec-state and agent-docs checks) → PASS (new state lists may
  fail coverage until T0.15 adds their blocks: if so, add the state lists in T0.15 instead and say
  so here).
- [ ] **Step 3: Commit** `docs(design): the responsive system in the design spec (#568)`.

### Task T0.6: Shell: head actions, scrolled title, compact scroller [title-bar]

**Files:**
- Modify: `packages/design/src/shell/shell-page.tsx`, `app-shell.tsx`, `floating-bar.tsx`, `packages/design/src/styles/shell.css`
- Create: `packages/design/src/shell/compact-scroll.ts`
- Test: `packages/design/test/compact-scroll.test.tsx`, additions to `packages/design/test/compact-shell.test.tsx`

**Interfaces:**
- Produces:
  - `ShellPage.actions?: MenuItem[]` (merged after `ShellPage.menu` into the trailing "…";
    `href` items call `onNavigate(href)`, else `window.location.assign`).
  - `ShellPage.titleAway?: boolean` → `.cb-shell-column[data-title-away="true"]` and
    `FloatingBar` prop `title?: string` drawn centred (`data-part="floating-title"`), hairline
    `line-soft` under the strip; part of the registration key.
  - `useCompactScroll(scroller: RefObject<HTMLElement>, title: RefObject<HTMLElement>, bar?: RefObject<HTMLElement>): { titleAway: boolean; barHidden: boolean }` — compact only (no-op otherwise); `titleAway` when the title's bottom is above the scroller's top; `barHidden` when scrolling down past the bar's offset, false on any upward scroll or when content does not overflow; passive listener, one `requestAnimationFrame` per frame.
  - `useRegisterScrolledTitle(titleAway: boolean)` — registers `titleAway` on the page's layer.

- [ ] **Step 1: Failing tests**: `head actions join the overflow after the page menu`; `a link
  action navigates through onNavigate`; `titleAway draws the centred title and the hairline mark`;
  `no title while titleAway is false`; `useCompactScroll reports titleAway past the title`
  (stub `getBoundingClientRect`, dispatch `scroll`); `barHidden on scroll down, shown on scroll
  up`; `short content never hides the bar`; `titleAway follows restored scroll` (set `scrollTop`
  before mount, expect `titleAway` true on first effect); `no-op at 768`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/design/test/compact-scroll.test.tsx packages/design/test/compact-shell.test.tsx` → FAIL.
- [ ] **Step 3: Implement**; CSS under `(max-width: 599px)`: `.cb-floating-title` centred
  absolutely between lead and trailing (`body`, 500, ellipsis), `.cb-shell-column[data-title-away]::before`
  gets `border-bottom: 1px solid var(--cb-line-soft)`.
- [ ] **Step 4: Run** → PASS; `pnpm exec vitest run packages/design` → PASS.
- [ ] **Step 5: Commit** `feat(design): head actions and the scrolled title in the compact top row (#568)`.

### Task T0.7: Tabs segmented look and scope chips [sizes]

**Files:**
- Modify: `packages/design/src/display/tabs.tsx`, `packages/design/src/styles/display.css`
- Test: `packages/design/test/tabs-looks.test.tsx`

**Interfaces:**
- Produces: `Tabs` prop `look?: "underline" | "segmented-compact"` → `data-look`; with
  `segmented-compact` and 2–3 items, below 600 the tab list is a full-width segmented control
  (equal parts, `control.default` / `touch.hit`, selected on `selected`, counts kept), same DOM and
  roles. `Segmented` and `Tabs` prop `chipsCompact?: boolean` → `data-chips-compact`; below 600
  pills (`radius.pill`), selected `ink` ground with `bg` text, `space.2` gap, sideways scroll
  without scrollbar.

- [ ] **Step 1: Failing tests**: `segmented-compact keeps role tablist and writes data-look`;
  `four tabs do not take the segmented look` (`data-look` absent with 4 items); `chipsCompact
  writes data-chips-compact and keeps radiogroup`; CSS-rule tests with `parseCss` (as
  `narrow.test.tsx`): the 599 block gives `[data-look=segmented-compact] > .cb-tab` `flex: 1 1 0`
  and `[data-chips-compact] > .cb-seg` `border-radius: var(--cb-radius-pill)`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(design): segmented tabs and scope chips on compact (#568)`.

### Task T0.8: CardGrid compact rows and the action sheet [sizes]

**Files:**
- Modify: `packages/design/src/display/card-grid.tsx`, `packages/design/src/styles/card-grid.css`
- Test: `packages/design/test/card-grid-compact.test.tsx`

**Interfaces:**
- Consumes: `ClassForms` / `useClassForm` (T0.2), `ActionSheet`, `actionSheetItems`, `useLongPress` (T0.3).
- Produces: no API change. Below 600: one rounded card (`panel`, `line-card`, `radius.md`), rows
  `padding: space.3 space.4`, avatar 40, name 500, one muted line (description, else meta), state,
  `chevron-right` (`data-part="object-card-chevron"`, only with `href`), inset hairlines; buttons
  not mounted after hydration (CSS-hidden before); long press / contextmenu opens `ActionSheet`
  titled with the card's title; a card without actions keeps the browser context menu;
  `-webkit-touch-callout: none` on the row.

- [ ] **Step 1: Failing tests** (`renderAtClass`): `at 390 cards have no buttons`; `at 390 the
  chevron is drawn for a card with href`; `contextmenu opens the sheet with 开始会话 then the menu
  items`; `long press opens the same sheet`; `a card without primary or menu opens no sheet`;
  `at 1440 the card keeps its buttons and no contextmenu handling`; `skeleton rows sit in the same
  card at 390`; roving focus test still passes at 1440.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/design/test/card-grid-compact.test.tsx packages/design/test/card-grid.test.tsx` → FAIL.
- [ ] **Step 3: Implement** (buttons inside `ClassForms wide`; the row link stays the card's one link).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(design): card grids are grouped rows with an action sheet on compact (#568)`.

### Task T0.9: ObjectRow compact rows [sizes]

**Files:**
- Modify: `packages/design/src/display/object-list.tsx`, `packages/design/src/styles/templates.css` (object-row block only), `packages/design/src/styles/touch.css` (object-row block only)
- Test: `packages/design/test/object-list-compact.test.tsx`

**Interfaces:**
- Consumes: T0.2, T0.3. Produces: below 600, a row with `href` mounts no action / menu buttons
  (long press → ActionSheet from `action` + `menu`); a row without `href` keeps its one action
  button and loses only the ⋯ (its items go to the sheet).

- [ ] **Step 1: Failing tests**: `row with href has no buttons at 390`; `row without href keeps its
  action at 390`; `contextmenu opens action then menu items`; `1440 unchanged` (existing
  `object-list.test.tsx` passes).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(design): object rows without buttons on compact (#568)`.

### Task T0.10: DataTable row mapping [sizes]

**Files:**
- Modify: `packages/design/src/table/types.ts`, `packages/design/src/table/DataTable.tsx`, `packages/design/src/styles/table.css`
- Test: `packages/design/test/data-table-compact.test.tsx`

**Interfaces:**
- Produces: `Column.compact?: "title" | "subtitle" | "meta" | "trailing" | "hidden"`;
  `DataTableProps.compactLead?(row: T): ReactNode`. When any column declares `compact`, below 600
  rows are grouped rows (title = the `title` column or the first column; subtitle / meta joined
  with 「 · 」; at most one trailing; chevron when `onOpen`; long press → `rowMenu`); selection
  and bulk bar not mounted (D5). Without declarations: today's stacked rows.

- [ ] **Step 1: Failing tests**: `declared columns map to title subtitle trailing at 390`;
  `hidden column is not drawn at 390`; `undeclared table keeps stacked label value rows`;
  `selection checkboxes are not mounted at 390`; `contextmenu opens rowMenu items`;
  `two trailing columns throw in development` (as `assertHeader`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ existing
  `narrow.test.tsx`).
- [ ] **Step 5: Commit** `feat(design): DataTable rows by a declared mapping on compact (#568)`.

### Task T0.11: PageHeader compact form [title-bar]

**Files:**
- Modify: `packages/design/src/shell/page-header.tsx`, `packages/design/src/styles/shell.css` (head block)
- Test: `packages/design/test/page-header-compact.test.tsx`

**Interfaces:**
- Consumes: `ShellPage.actions` (T0.6), `Tabs look` (T0.7), `ClassForms` (T0.2).
- Produces: `PageHeaderProps.primaryForm?: "head" | "fab" | "block"` (set by templates, not
  pages; default `"head"`). Below 600, hydrated: no path nav; the title row carries the count
  (`count` ?? first tab's `count`, D10); secondary actions registered as `ShellPage.actions` when
  `useHasShell()` (else a head `more-horizontal` menu); `primaryForm="block"` draws the primary as
  a full-width button under the title; `"fab"` draws none (the head primary's `data-fab` CSS form, §6.62); tabs get
  `look="segmented-compact"`. Medium / expanded unchanged (D9).

- [ ] **Step 1: Failing tests**: `no path at 390`; `count falls back to the first tab's count at
  390`; `header.count wins`; `secondary actions go to the shell overflow at 390`; `block primary is
  full width under the title` (`data-form="block"`); `fab form draws no head primary at 390`;
  `768 and 1440 unchanged` (the existing `head-rhythm.test.tsx` passes).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(design): the compact page head (#568)`.

### Task T0.12: ListFab — DROPPED (#596 made the FAB a CSS form of the head primary, §6.62)

Kept for the record; do not implement.


**Files:**
- Create: `packages/design/src/shell/list-fab.tsx`, `packages/design/src/styles/list-fab.css` (imported from `index.css`)
- Test: `packages/design/test/list-fab.test.tsx`

**Interfaces:**
- Produces: `ListFab(props: { action: HeaderAction & { variant: "primary" } }): JSX.Element` —
  `data-part="list-fab"`, accessible name = label, `href` → design link else button, `plus` 24 (or
  the action's icon), `loading` / `disabled`; CSS: hidden from 600; fixed at `inset-inline-end:
  space.4`, `bottom: calc(var(--cb-inset-bottom) + space.4)`, `touch.prominent` square,
  `radius.md`, `accent` / `on-accent`, `shadow-float-touch`.

- [ ] **Step 1: Failing tests**: `link action renders a link named by its label`; `button action
  calls onSelect`; `loading disables it`; CSS rule test: `.cb-list-fab` `display: none` outside the
  599 block.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat(design): ListFab, a list page's primary on compact (#568)`.

### Task T0.13: ListPage compact form

**Files:**
- Modify: `packages/design/src/templates/list-page.tsx`, `packages/design/src/shell/body.tsx` (Filter sheet also holds `filters` field controls on compact)
- Create: `packages/design/src/styles/list-page.css`
- Test: `packages/design/test/list-page-compact.test.tsx`

**Interfaces:**
- Consumes: T0.6 `useCompactScroll`, `useRegisterScrolledTitle`; T0.7; T0.8; T0.10; T0.11
  `primaryForm` (the `data-fab` CSS form, §6.62).
- Produces: `ListPage` prop `scope?: { label: string; value: string; options: { value: string; label: string; count?: number }[]; onChange(v: string): void }` drawn as `Segmented` (wide, in the filters row) and `Segmented chipsCompact` (compact bar). Below 600: the template is the scroller; the compact bar (`data-part="list-compact-bar"`: search 44 filled, tabs, scope chips) is a direct child of the scroller, sticky with quick return from `barHidden`; `filters` (fields) move into the Filter bottom sheet; `ListFab` from the head's primary (none while the empty state carries it).

- [ ] **Step 1: Failing tests** (`renderAtClass`): `at 390 no path, FAB with 新建智能体, segmented
  tabs, scope chips, rows without buttons`; `contextmenu on a row opens the card's actions`;
  `empty state with primary means no FAB`; `one search input after hydration`; `field filters sit
  in the Filter sheet at 390`; `short list never hides the bar`; `at 768 and 1440 the head keeps
  its primary, tabs and Segmented scope`; `loading keeps the compact bar with dashes`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/design/test/list-page-compact.test.tsx` → FAIL.
- [ ] **Step 3: Implement**; `scope` and a `Segmented` passed through `filters` must not both be given (assert in development).
- [ ] **Step 4: Run** → PASS; `pnpm exec vitest run packages/design` → PASS.
- [ ] **Step 5: Commit** `feat(design): the compact list page (#568)`.

### Task T0.14: The other templates

**Files:**
- Modify: `packages/design/src/templates/frame.tsx` (`TemplateHead`: scroller + scrolled title for every pushed template), `detail-page.tsx`, `settings-page.tsx`, `overview-page.tsx`, `trace-page.tsx`, `form-page.tsx`, `wizard-page.tsx`, `status-page.tsx`, `inbox-page.tsx`, `packages/design/src/styles/templates.css`
- Test: `packages/design/test/templates-compact.test.tsx`

**Interfaces:**
- Consumes: T0.6, T0.11. Produces: below 600 each template is one scroller (D7) with
  `titleAway`; Detail / Settings / Overview pass `primaryForm="block"` (D2); in-page tabs take
  `look="segmented-compact"`; Status / Onboarding actions stack full width; Inbox rows: no long press
  (D6); Settings sub-nav stays sticky inside the scroller; ActionRows stay sticky.

- [ ] **Step 1: Failing tests**: per template at 390 `no path`, `title registered away after
  scroll`; `detail primary is a block button`; `settings sub-nav still sticky (data-sticky)`;
  `inbox row has no contextmenu handler`; `status actions stacked (data-stack)`; at 1440 the
  existing `head-rhythm.test.tsx`, `detail-page.test.tsx` pass unchanged.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat(design): every pushed template scrolls as one on compact (#568)`.

### Task T0.15: Catalog, fidelity, i18n, changesets

**Files:**
- Modify: `apps/web/src/dev/catalog/card-grid-blocks.tsx` (narrow block = rows), new blocks for
  `action-sheet-open`, `list-fab-narrow`, `apps/web/src/dev/catalog/templates/list.tsx` (a compact
  list example with scope), `docs/design/reference/src/card-grid.html` (narrow block redrawn) and
  new reference sources, `apps/web/visual/size-matrix.ts` consumers: a `responsive.spec.ts` with
  one page per template at 390 (touch emulation), 768, 1440, light and dark, plus the touch
  hit-size assertion (≥ 44 at 390 touch and ≥ 44 at 390 fine: maintainer decision 2026-11-22).
- Create: `.changeset/responsive-system-phase0.md` (`@capybara-hq/design` minor, `@capybara-hq/capybara` patch)

- [ ] **Step 1:** run `pnpm exec vitest run apps/web/test/box-in-box.test.tsx` and the design
  `box-in-box.test.tsx` with the new blocks → PASS (the grouped list is one box, rows are not).
- [ ] **Step 2:** `pnpm check` (i18n, ui-parts for new `data-cap-part`s if any, spec states) → PASS.
- [ ] **Step 3:** `pnpm verify` → PASS (visual specs skip locally; baselines come from
  `visual-update`, requested in the PR, not run).
- [ ] **Step 4: Commit** `test(web): catalog blocks and the responsive visual matrix (#568)`.

---

## Phase 0b: interaction model (one PR, after phase 0's second PR)

Spec: the interaction model doc §§ 2–9. The sheet standard (#591) and the drawer (#596) are merged. Waves: T0b.1, T0b.4, T0b.5, T0b.8, T0b.10 (wave 1, disjoint files); T0b.2, T0b.3, T0b.6, T0b.9
(wave 2); T0b.7, T0b.11 (wave 3). All `normal`; T0b.1 reviewed alone on
the most capable model (focus, history and the typed-name confirmation in a sheet).

### Task T0b.1: Dialog and DangerConfirm as sheets on compact (on the §6.59 sheet)
**Files:** `packages/design/src/overlays/dialog.tsx`, `overlays.css`; test `packages/design/test/dialog-compact.test.tsx`.
- [ ] Tests at 390: `Dialog renders as a bottom sheet with the sheet head`; `DangerConfirm puts the
  fail button full width above 取消`; `typed name still required`; `back closes it`; at 1440 the
  centred dialog unchanged. Implement through `ClassForms`; commit `feat(design): dialogs are sheets on compact (#588)`.

### Task T0b.2: Select as a picker sheet on compact (on the §6.59 sheet)
**Files:** `packages/design/src/controls/select.tsx`, test `select-compact.test.tsx`.
- [ ] Tests at 390: `opens a sheet with radio rows`; `over 10 options shows a search field`;
  `pick closes and calls onChange with selection haptic`. Implement; commit.

### Task T0b.3: Infinite scroll on compact lists
**Files:** `packages/design/src/display/list-sentinel.ts` (`useListSentinel(onLoadMore: () => void, opts: { hasMore: boolean; loading: boolean })`), `object-list.tsx`, `card-grid.tsx`, `table/DataTable.tsx` (prop `onLoadMore?`, `hasMore?`, `loadingMore?`), `tools/checks/src/web-ui.ts` rule `web-ui-load-more` + fixture.
- [ ] Tests: `sentinel in view calls onLoadMore once`; `no call while loading or without more`;
  `error shows an inline retry row`; desktop keeps the page's own load-more. Commit.

### Task T0b.4: Toasts at the bottom on compact
**Files:** `packages/design/src/overlays/toast.tsx`, `overlays.css`; test (CSS rule): the 599 block
puts `.cb-toast-region` at `bottom: calc(var(--cb-inset-bottom) + …)` above `--cb-keyboard-inset`. Commit.

### Task T0b.5: Scroll to input under the mobile query
**Files:** `packages/design/src/controls/inputs.tsx`, `shell/app-shell.tsx` (an inset-settled event); test `scroll-to-input.test.tsx`: `focus inside a scroller scrolls the field into view after the inset changes`; `no call on a fine pointer at 1440`. Commit.

### Task T0b.6: Pull to refresh in a native shell (interaction D4)
**Files:** `packages/design/src/display/pull-refresh.tsx` (`PullToRefresh({ onRefresh, children })`, active only with a native shell and touch), used by `InboxPage`, the conversations list, `NavDrawer` recents; test `pull-refresh.test.tsx`: `inactive in a browser`; `pull past threshold calls onRefresh with selection haptic`. Commit.

### Task T0b.7: Interaction guards
**Files:** `tools/checks/src/web-ui.ts` (rules `web-ui-overlay-primitive`, `useNative` added to `web-ui-size-branch`), `tools/checks/src/design-sheet-parts.ts`, fixtures, README.
- [ ] Red fixtures first; real tree clean; commit `feat(checks): overlays and sheet parts stay design primitives (#588)`.

### Task T0b.8: Haptic additions
**Files:** `packages/design/src/overlays/long-press.ts` (light on open), `pull-refresh.tsx` hook point; test in `haptics.test.tsx`. Commit.

### Task T0b.9: Duo: the primary goes to the strip pill
**Files:** `packages/design/src/shell/shell-page.tsx` (`ShellPage.primary?: { label: string; icon?: IconName; href?: string; onSelect?(): void }`), `templates/list-page.tsx` (register the primary with the shell and hide the `data-fab` form while `data-native-nav`); test `duo-primary.test.tsx`: `with nav@1 present the FAB form is hidden and the shell holds the primary`; `without nav@1 the FAB form is back`.
- [ ] Implement; commit `feat(design): the list primary joins the Duo strip (#588)`.

### Task T0b.10: Duo: `nav@1` action and account
**Files:** the shell environment types in `packages/design/src/native.ts` / `shell-environment.tsx`, the web adapter in `apps/web/src/components/shell/AppFrame.tsx` (allowlisted), `docs/superpowers/specs/2026-11-20-mobile-app-design.md` §5.2 (contract text); native side tracked in the clients repo.
- [ ] Tests with a fake shell: `set carries action (page primary or 新会话) and account`; `side from nav@1 is written as data-strip`; `onAction runs the primary`; `onAccount opens the account sheet`; `a strip selection closes the open sheet first`; `search item opens the palette`. Implement; commit.

### Task T0b.11: Duo: drawer entries, sheets and shots
**Files:** `packages/design/src/shell/nav-drawer.tsx`, `sidebar.tsx`, `account-sheet.tsx` (技能、连接器、设备… row while `nav@1`), `overlays/bottom-sheet.tsx` + `overlays.css` (panel inside `--cb-inset-right`, scrim full bleed), `apps/web/visual/duo.spec.ts` (outer list with the pill primary, outer sheet, inner list).
- [ ] Tests at 382 with `data-native-nav`: `no menu button`; `sheet panel ends at the strip inset`; `account sheet holds 技能、连接器、设备…`; with `data-strip="left"`: `sheet panel starts after the left inset`, `back button clears the left inset`; `a split side change keeps the open sheet and the scroll position (no remount)`; `without nav@1.side or a left inset the side is right`. `ShellEnvironmentScript` writes `data-strip` from `nav@1.side`, else the insets. Implement; commit.

## Phase 1: member pages (one PR)

Waves: T1.1–T1.4 disjoint (wave 1), T1.5 after them (wave 2). All `normal`, one batched review.

### Task T1.1: `/agents` declares its scope
**Files:** `apps/web/src/app/(app)/agents/view.tsx`, `tools/checks/src/web-ui.ts` (drop the entry from `SCOPE_PENDING`).
- [ ] Failing test in `apps/web/test/agents-page.test.tsx` (or the existing agents view test):
  `the 全部 / 我的 / 组织共享 choice is passed as ListPage scope` (at 390 three chips with
  `aria-checked`; at 1440 a Segmented).
- [ ] Replace the `filters` Segmented with `scope={{ label: t("filter"), value: filter, options, onChange }}`; run test + `pnpm check` → PASS; commit `feat(web): /agents declares its scope (#568)`.

### Task T1.2: Schedules row mapping
**Files:** `apps/web/src/app/(app)/schedules/view.tsx`, `apps/web/src/app/(app)/schedules/[id]/view.tsx`.
- [ ] Test at 390: list rows show name (title), next run (subtitle), state (trailing); the run
  table in `/schedules/<id>` shows time (title), result (trailing).
- [ ] Add `compact` roles; run → PASS; commit `feat(web): schedules declare their compact rows (#568)`.

### Task T1.3: Account tables row mapping
**Files:** `apps/web/src/app/(app)/account/grants/view.tsx`, `identities/view.tsx`, `notifications/view.tsx`.
- [ ] Test per page at 390: title = the app / identity / device name, trailing = the state or
  date; revoke / remove in `rowMenu` (if today a cell button only, add the `rowMenu` item).
- [ ] Implement, run, commit `feat(web): account tables declare their compact rows (#568)`.

### Task T1.4: Skill detail tables and reachability audit
**Files:** `apps/web/src/app/(app)/skills/[id]/view.tsx`, `apps/web/src/components/AgentList.tsx` (read only unless a gap), `connectors/[connectorId]/view.tsx`, `devices/[id]/view.tsx` (only where an action is missing).
- [ ] Test: every item of the connector and device cards' ⋯ menus exists on their detail page
  (`apps/web/test/actions-reachable.test.tsx`: render card + detail with fixtures, compare labels).
- [ ] Add missing detail actions and the skills tables' `compact` roles; run, commit `feat(web): row actions are on the detail pages (#568)`.

### Task T1.6: Conversations page — DONE by #596 (time groups, infinite end); dropped.

### Task T1.5: Member visual pages
**Files:** `apps/web/visual/responsive.spec.ts` (add agents, skills, connectors, schedules, conversations, inbox, account profile at 390 / 768 / 1440), `.changeset/responsive-system-phase1.md` (`@capybara-hq/capybara` patch).
- [ ] `pnpm verify` → PASS; ask for `visual-update` in the PR; commit `test(web): member pages in the responsive matrix (#568)`.

## Phase 2: org admin pages (one PR)

Waves: T2.1–T2.3 disjoint (one wave). Reachable only in a narrow desktop window (touch shows the
desktop-only notice), so tests use a fine pointer at 390.

### Task T2.1: Settings tables
**Files:** `apps/web/src/app/(app)/settings/members/view.tsx`, `tokens/view.tsx`, `schedules/view.tsx`, `audit/view.tsx`.
- [ ] Tests at 390: members (name title, role subtitle, state trailing), tokens (name, expiry
  trailing), schedules (task, owner, state), audit (action title, actor · time subtitle).
- [ ] Implement, run, commit `feat(web): org settings tables declare their compact rows (#568)`.

### Task T2.2: Extensions and trajectories
**Files:** `apps/web/src/app/(app)/extensions/view.tsx`, `trajectories/view.tsx`.
- [ ] Tests at 390: extension rows (display name title, capabilities subtitle, state trailing;
  the enable switch declared `trailing`, `interactive`); trajectories (agent title, status
  trailing; filters in the Filter sheet). Extensions keep the 7-tab scrolling row (D4).
- [ ] Implement, run, commit `feat(web): extensions and trajectories on compact (#568)`.

### Task T2.3: Evals tables
**Files:** `apps/web/src/app/(app)/evals/[setId]/view.tsx`, `evals/runs/[runId]/view.tsx`.
- [ ] Tests at 390; implement; run; commit `feat(web): eval tables declare their compact rows (#568)`.

## Phase 3: super admin (one PR, sizing only, D8)

### Task T3.1: Scope migrations and the strict guard
**Files:** `apps/web/src/app/(app)/admin/agents/templates/view.tsx`, `admin/connectors/templates/view.tsx`, `admin/plugins/market/view.tsx`, `apps/web/src/components/AdminComponents.tsx` (`useOwnerFilter` returns a `scope` value instead of a `filters` node), `tools/checks/src/web-ui.ts` (`SCOPE_PENDING` emptied and removed).
- [ ] Tests: the owner filter and the marketplace sources are `scope` (chips at 390, a secondary
  control at 1440); `pnpm check` passes with no pending entries.
- [ ] Implement, run, commit `feat(web): admin view choices are scopes (#568)`.

### Task T3.2: Sizing audit
**Files:** `apps/web/visual/responsive.spec.ts` (one admin list, detail, form page at 390 fine pointer: hit targets ≥ 44 (maintainer decision 2026-11-22), no horizontal page scroll).
- [ ] Add the assertions; `pnpm verify`; commit `test(web): super admin pages at 390 (#568)`.
  No row mappings (D8): admin tables keep the stacked fallback.

---
