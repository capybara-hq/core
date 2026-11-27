# Layered Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This line runs it with `wave-planned-subagent-development` (waves below).

**Goal:** From 600 up the shell has two planes (the sidebar and gutters on a ground, the page / conversation / right panel as paper on it, told apart by colour alone), the StatusBar is gone with its content relocated, and the sidebar and page head lose the chrome that repeats the sidebar.

**Architecture:** Token value changes in `docs/design/tokens.json`; layering in the shell's own stylesheets (`shell.css`, `conversation-page.css`, `templates.css`, `sidebar.css`); `StatusBar` / `useStatusBar` deleted from `packages/design` and the `status-bar` UI part from the SDK; a new `ContextMeter` beside the composer's send button; round / elapsed into the properties panel's Context section; version / time zone (and a not-ok system status) into the account menu. `apps/web` only rewires props.

**Tech Stack:** React 19, Next 16, plain CSS with design tokens, vitest (jsdom), Playwright (visual, reference, e2e).

**Spec:** `docs/superpowers/specs/2026-11-28-layered-shell-design.md` (approved 2026-11-28). Visual target: the "v10" prototype (`packages/design/src/styles/layering.css` + `AdminHead` in `shell/sidebar.tsx` on this branch until Task 6 deletes them; screenshots in the coordinator's scratchpad `shots/v10/`). The prototype's colour literals and CSS hiding are not to be kept.

## Global Constraints

- Token values (spec §1): light `sidebar #EDECE7`, light `bg #FDFDFC`; dark `sidebar #171716`, dark `hover rgba(255,255,255,0.04)`, dark `sidebar-active rgba(255,255,255,0.07)`; `panel` and dark `bg` unchanged; `preview-light` stays `#FAF9F6`.
- Paper from 600 up: inset `space.2` on top, end and bottom (start: the sidebar's edge), `radius.md`, `overflow: clip`, **no border, no shadow**. Content pad inside the paper `space.6`; compact keeps 16.
- Compact (below 600) unchanged.
- No colour literals, no `display: none` used to hide something the spec says is not rendered: elements the spec removes are not rendered.
- UI font unchanged; content max widths unchanged (`layout.content` 1120, `layout.chat` 720).
- `apps/web` writes no styles (`pnpm check:web-ui`).
- New copy in zh and en; zh never 企业 / Latin `agent`.
- English comments; Conventional Commits; commit body lines ≤ 100 chars; every commit ends with `Co-Authored-By: Capybara <noreply@capybarahq.com>` and carries `Refs #972`.
- Implementers stage only their own files (`git add <paths>`), never `-A` / `-a`.

## Decisions taken while planning (spec "left to the builder" and gaps)

- **Context meter threshold:** members cannot read the org's compaction settings (only `/admin/settings` reads them), so the meter turns `fail` at `COMPACTION_DEFAULTS.threshold` (80 %) from `apps/web/src/lib/compaction.ts`. No new kernel API.
- **System status source:** the product sets no shell-wide system status today; the account menu API takes an optional `status` (shown only when given, with a `fail` dot on the account row) and the web passes none. Version and time zone always go to the footer line.
- **Run state announcement:** the StatusBar's first item was the page's polite live region. The conversation page keeps a visually hidden `role="status"` element (`data-part="run-announce"`) with the run state text, so screen readers still hear idle / running / waiting / stopped / failed.
- **`status-bar` UI part** (`packages/plugin-sdk/src/ui-parts.ts`) is removed with its owner (pre-0.1.0). This changes the SDK's public API report (`UI_PART_NAMES`) → changeset on `@capybara-hq/plugin-sdk` (and `@capybara-hq/plugin-client` if its report changes). The spec's "Public API reports: not touched" missed this; the plan corrects it. Follow-up outside this repo: `plugins/theme-cyberpunk` has a dead `[data-cap-part~="status-bar"]` rule.
- **`layout.status-bar` token** is deleted; its two non-StatusBar uses (`templates.css` `--cb-segment-trail-block`, the Duo calc in `conversation-page.css`) drop the term.
- **Sub-agent panel footer** (a StatusBar with "上下文 N%") goes; the percentage joins the panel head's `meta` (`<duration> · 上下文 N%`).
- **Compact account sheet** keeps its footnote as is (compact unchanged).

## Review Focus

1. **Desktop drag regions:** every new filler (top gutter, title row) is an empty `.cb-drag-fill`; overlays and the resize handle are never covered by a drag region; a page without a path row still drags from its title row. Test in `drag-regions.test.tsx` (Task 6).
2. **A page with exactly 3 path segments** keeps its path row; 1 and 2 segments draw none at any width, and compact back still walks the path (from props). Tests in Task 6.
3. **Dark theme hover on the ground and on the paper** both visible (overlay tokens) and `check:tokens` contrast pairs still pass with the new `sidebar` / `bg` (Task 2).
4. **Conversation page with the right panel inline (≥1280) and as a side sheet (<1280)**: two papers `space.2` apart only when inline; sheet mode keeps one paper and the sheet over it; full-screen panel draws no paper of its own. Test in `conversation-shell.test.tsx` (Task 6) by CSS rule assertions.
5. **Short window (height < 480) and keyboard-open rules** that referenced `.cb-statusbar` are removed without leaving the ActionRow or the composer misplaced (Task 6 updates `narrow.test.tsx`, `keyboard-inset.test.tsx`).

---

## Wave plan

| Task | Depends on (interfaces) | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 Spec docs | – | `docs/design/spec.md`, mobile layout spec, writing-web-ui skill, `packages/design/test/spec-tables.test.ts` | normal | 1 | batch |
| 2 Tokens | – | `docs/design/tokens.json`, generated `tokens.css` / `tokens.ts` | normal (shell) | 1 | most capable |
| 3 Conversation parts | – | `conversation/context-meter.tsx` (new), `composer.tsx`, `panels.tsx`, `styles/context-meter.css` (new), `i18n.ts`, their tests | normal | 1 | batch |
| 4 Sidebar + account menu | – | `shell/sidebar.tsx`, `styles/sidebar.css`, `overlays/menus.tsx`, sidebar / menu tests | normal (shell) | 1 | most capable |
| 5 Reference set | spec of 1 | `docs/design/reference/src/**`, `apps/web/reference/*` | normal | 1 | batch |
| 6 Shell, page head, StatusBar removal | 3 (`context-meter.css` exists) | `shell/app-shell.tsx`, `shell/status-bar.tsx` (delete), `shell/page-header.tsx`, `shell/setup-page.tsx`, `shell/index.ts`, `templates/conversation-page.tsx`, `styles/{shell,shell-environment,conversation-page,templates,index,layering}.css`, shell tests | normal (shell, drag) | 1 | most capable |
| 7 UI part removal | 6 deletes the owner | `plugin-sdk/src/ui-parts.ts`, generated ui-parts files, `docs/guide/ui-parts.md`, API reports, `ui-parts.test.tsx`, changesets | normal | 1 | batch |
| 8 Web product | 3, 4, 6 | `apps/web/src/**` except `dev/`, `apps/web/messages/*`, `apps/web/test/*`, `apps/web/e2e/*` | normal | 2 | batch |
| 9 Catalog | 3, 4, 5, 6 | `apps/web/src/dev/catalog/**`, `apps/web/visual/accepted.ts`, `packages/design/src/fixtures/index.ts` | normal | 2 | batch |
| 10 Integration + acceptance | all | fixes anywhere, `.changeset/layered-shell.md` | – | 3 | coordinator + blind image reviewer |

Wave 1 tasks have disjoint files; tests across tasks may be red until wave 2 lands (e.g. the catalog still imports `StatusBar`). Each implementer runs its own tests and `pnpm typecheck` scoped to its package where it can; full green is Task 10's gate.

---

### Task 1: Spec docs

**Files:**
- Modify: `docs/design/spec.md` (§2.1, §2.5 layout row, §4, §4.1, §4.2, §4.3, §4.4, §4.7 short window, §5 template size tables' `status-bar` rows, §6.13, §6.16.2, §6.16.17)
- Modify: `docs/superpowers/specs/2026-11-19-mobile-layout-design.md` §4 table (StatusBar row → none on every class)
- Modify: `.agents/skills/writing-web-ui/SKILL.md` (drop `useStatusBar`; note the paper and the path rule)
- Modify: `packages/design/test/spec-tables.test.ts` (drop `status-bar` from its list)

- [ ] **Step 1:** Write the spec edits listed in the layered-shell spec's "Spec and doc changes". Concretely: colour table values (Global Constraints); delete the `layout.status-bar` token from the layout row; §4 describes ground + paper (inset `space.2`, `radius.md`, no border / shadow; conversation: two papers, resize handle in the gap); §4.1 org switcher name only, frameless, admin one-row head, no foot line; §4.2 "From 600 up the path row is not rendered when the path has two segments or fewer; the title row holds a drag filler"; §4.3 content pad `space.6` inside the paper; §4.4 becomes "ActionRow" only; delete `<!-- states: status-bar -->`, `<!-- size-table: status-bar -->` and every `| status-bar | … |` row in template size tables; size-class table row "StatusBar" deleted.
- [ ] **Step 2:** §6.16.2: append states `context-meter`, `context-meter-over` to `<!-- states: composer -->`; add size-table rows:

```
| composer-context-meter | context-meter | width | control.dense |
| composer-context-meter | context-meter | height | control.dense |
| composer-context-meter | context-meter | color | color.muted |
| composer-context-meter | context-meter-over | color | color.fail |
```

  and prose: a ring before send, shown once the conversation has usage, tooltip 「上下文已用 N%」 / "Context N% used", `fail` from the compaction threshold (80 % default).
- [ ] **Step 3:** §6.16.17: the Context section gains a "轮次 / Rounds" row (`第 N 轮 · 已用 <elapsed>`, part `context-rounds`) before the last run. §6.13: account menu head line (system status, only when not ok, with a `fail` dot on the account row) and footer line (version · time zone).
- [ ] **Step 4:** Run `pnpm exec vitest run packages/design/test/spec-tables.test.ts` — expect failures only where the catalog / ACCEPTED still lists status-bar (fixed by Task 9); `pnpm check:agent-docs` passes.
- [ ] **Step 5:** Commit `docs(design): spec for the layered shell and the removed status bar`.

### Task 2: Tokens

**Files:** Modify `docs/design/tokens.json`; regenerate `packages/design/src/styles/tokens.css`, `packages/design/src/tokens.ts`.

- [ ] **Step 1:** Change the values in Global Constraints; delete `layout.status-bar`. Do not touch `preview-light`.
- [ ] **Step 2:** `pnpm gen:tokens` then `pnpm check:tokens` — PASS (every contrast pair, including `muted` on `sidebar` and `ink` on `hover` over `panel`). If a pair fails, report it; do not change other token values.
- [ ] **Step 3:** `pnpm exec vitest run packages/design/test/touch-tokens.test.tsx packages/design/test/mobile-sizes.test.ts` — PASS (references to the deleted token are Task 6's).
- [ ] **Step 4:** Commit `feat(design): ground and paper token values`.

### Task 3: Conversation parts (context meter, composer, Context rounds)

**Files:**
- Create: `packages/design/src/conversation/context-meter.tsx`, `packages/design/src/styles/context-meter.css`, `packages/design/test/context-meter.test.tsx`
- Modify: `packages/design/src/conversation/composer.tsx`, `packages/design/src/conversation/panels.tsx`, `packages/design/src/conversation/index.ts`, `packages/design/src/i18n.ts`, `packages/design/test/composer.test.tsx`, the panels test file that covers `ContextSection`

**Interfaces — Produces:**
- `export function ContextMeter({ pct, over }: { pct: number; over?: boolean }): JSX.Element` — an SVG ring `control.dense` square, track `line`, arc `muted` (`fail` when `over`), `role="meter"`, `aria-valuemin 0`, `aria-valuemax 100`, `aria-valuenow pct` (clamped, rounded), `aria-label` = tooltip text, `data-part="composer-context-meter"`, `data-tone="fail"` when over, wrapped in the design `Tooltip`.
- `ComposerProps.context?: { pct: number; over: boolean }` — rendered immediately before the send / stop button; absent → nothing.
- `ContextSection` prop `rounds?: ReactNode` — a row labelled `t("props.rounds")`, part `context-rounds`, before the last run row.
- i18n keys: `composer.contextUsed` zh `上下文已用 {n}%` / en `Context {n}% used` (use the file's existing placeholder style); `props.rounds` zh `轮次` / en `Rounds`. Remove `sidebar.adminScope` (Task 4 stops using it).
- `context-meter.css` (Task 6 adds its import to `styles/index.css`).

- [ ] **Step 1: Failing tests** in `context-meter.test.tsx`: `renders a meter with aria-valuenow 43 and label 上下文已用 43%`; `clamps 140 to 100`; `over sets data-tone="fail"`; in `composer.test.tsx`: `context meter sits right before the send button` (its `nextElementSibling` chain reaches `[data-part="send"]` or the send button with no control between) and `no meter without context`; panels test: `rounds row renders with part context-rounds before the last run`.
- [ ] **Step 2:** Run them: FAIL.
- [ ] **Step 3:** Implement. Ring geometry from tokens only (stroke width 2, radius from the box); colours via `var(--cb-muted)` / `var(--cb-fail)` / `var(--cb-line)` in `context-meter.css`.
- [ ] **Step 4:** `pnpm exec vitest run packages/design/test/context-meter.test.tsx packages/design/test/composer.test.tsx <panels test>` PASS.
- [ ] **Step 5:** Commit `feat(design): composer context meter and the Context section's rounds row`.

### Task 4: Sidebar and account menu

**Files:** Modify `packages/design/src/shell/sidebar.tsx`, `packages/design/src/styles/sidebar.css`, `packages/design/src/overlays/menus.tsx`; tests in the existing sidebar and menu test files (`packages/design/test/sidebar*.test.tsx`, `menu*.test.tsx`).

**Interfaces — Produces:**
- `SidebarProps.account`: `{ name: string; avatarUrl?: string | null; menu: MenuItem[]; status?: { text: string; tone: "fail" }; footnote?: string }`.
- `Menu` (the dropdown used by the account row) gains `head?: ReactNode` and `foot?: ReactNode`: non-interactive rows (not focusable, not menu items) above the first item and below the last, `small` type, `muted` (`head` with a `fail` dot when the account status tone is fail).

- [ ] **Step 1: Failing tests:** `OrgSwitcher draws the org name only (no .cb-sidebar-org-meta)`; `admin full sidebar: one context block holding the shield, 管理后台 and a back link named 回到工作区 ~/<slug>`; `admin rail keeps the shield and back button`; `no scope line 整个部署 in the admin block`; `account status renders a fail dot on the account row and the status line at the top of the menu`; `footnote renders as the menu's last line`; `no status → no dot, no head line`; `sidebar.css: .cb-sidebar-foot has no border-top; from 600 up .cb-sidebar has no background and no border-right; .cb-sidebar-org has no border and no background, hover paints var(--cb-hover)`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement. Replace the prototype `AdminHead` with the real one (full sidebar), styled in `sidebar.css` with tokens: back link `height control.dense`, `padding 0 pad-dense-x`, `radius.sm`, `small` type, `muted`, hover `hover` + `ink`; `aria-label` / `title` `回到工作区 ~/<slug>`. Delete the org meta line and the admin scope line from the markup (not hidden by CSS). Rail form unchanged.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** Commit `feat(design): sidebar on the ground (name-only switcher, one-row admin head)`.

### Task 5: Reference set

**Files:** Modify `docs/design/reference/src/{fill.js,conversation.js,reference.css,index.html,sidebar.html,page-header.html,composer.html,property-section.html,template-*.html}` as needed; delete `docs/design/reference/src/status-bar.html`; modify `apps/web/reference/render.spec.ts`, `apps/web/reference/review-page.mjs` (drop `status-bar`).

- [ ] **Step 1:** The app frame (`r-app`): ground `--cb-sidebar` behind the sidebar and gutters, `r-main` as the paper (`space.2` inset top/end/bottom, `radius.md`, no border / shadow, `--cb-bg`), content pad `space.6`; conversation templates: main and inline panel as two papers `space.2` apart. Delete `statusBar()` and every footer use.
- [ ] **Step 2:** Sidebar fixture: org name only, frameless; admin state = one row with the dense back link; no foot line. Page head: the `title` state draws no path row; the `path` state keeps a 3-segment path.
- [ ] **Step 3:** Composer blocks `composer-context-meter` (43 %) and `composer-context-meter-over` (86 %); property-section `context` block gains the rounds row.
- [ ] **Step 4:** `pnpm --filter @capybara-hq/web reference:render` locally renders without error (look only; do not commit PNGs).
- [ ] **Step 5:** Commit `docs(design): reference set for the layered shell`.

### Task 6: Shell, page head and StatusBar removal

**Files:**
- Delete: `packages/design/src/shell/status-bar.tsx`, `packages/design/src/styles/layering.css`
- Modify: `packages/design/src/shell/{app-shell,page-header,index}.tsx|ts`, the SetupPage file (`git grep -l "export function SetupPage" packages/design/src`), `packages/design/src/templates/conversation-page.tsx`, `packages/design/src/styles/{shell,shell-environment,conversation-page,templates,index}.css`
- Test: `packages/design/test/{shell,drag-regions,conversation-shell,narrow,keyboard-inset,duo-edge,segments,browser-review-polish,colour,touch-tokens}.test.ts(x)` and the page-header tests

**Interfaces — Produces:**
- `AppShellProps`: `status` and `ownStatusBar` removed. `SetupPage`: `status` removed.
- `ConversationPageProps`: `status: ConversationStatus` removed (and the type); new `announce?: string` → `<span className="cb-sr-only" role="status" data-part="run-announce">{announce}</span>` inside the main column.
- No `StatusBar` / `StatusBarProps` / `useStatusBar` exports.
- `styles/index.css` imports `./context-meter.css` (Task 3) and no longer `./layering.css`.

- [ ] **Step 1: Failing tests:**
  - page head: `1 and 2 segments render no [data-part="path"] (server and expanded)`, `3 segments render the path`, `the title row holds exactly one .cb-drag-fill between the text and the actions`, `the titleless head without a path holds a .cb-drag-fill before its actions`.
  - shell: `no [data-part="status-bar"] anywhere (AppShell, ConversationPage, SetupPage)`, `the shell column's first child is an empty .cb-drag-fill.cb-shell-gutter`, `ConversationPage announce renders role=status with the text`.
  - CSS (via `test/css-rules.ts`): `@media (min-width: 600px)`: `.cb-shell` background `var(--cb-sidebar)`; `.cb-shell-main` background `var(--cb-bg)`, margin top/end/bottom `var(--cb-space-2)`, `border-radius: var(--cb-radius-md)`, no `box-shadow`, no `border`; conversation: `.cb-conv-main` and the inline `.cb-conv-panel:not([data-full])` are the papers, gap `var(--cb-space-2)`, the panel's `.cb-rpanel` has no start border; `.cb-template` `--cb-content-pad: var(--cb-space-6)` from 600 up, 16 below.
  - drag regions: the gutter filler and the title-row filler match `FILLER`; the existing "no container with controls drags" and "modal overlays carve out fillers" cases pass for them.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement following the v10 prototype's `layering.css` rules, moved into the owning stylesheets with tokens, and the spec §2/§3/§5:
  - `page-header.tsx`: `pathNode = form === "compact" || segments.length <= 2 ? null : navNode`; `<DragFill />` between `.cb-pageheader-text` and the actions (and before the actions in the titleless row); the gap-cancel margin rule in `shell.css` extends to `.cb-pageheader-row > .cb-drag-fill`.
  - top gutter: `<DragFill className="cb-shell-gutter" />` first in `.cb-shell-column`; `shell.css` from 600 up: column `position: relative`, gutter `position: absolute; inset-inline: 0; top: 0; height: var(--cb-space-2)`; below 600 not displayed (it has no paper above). It must not cover the conversation panel's resize handle (`z-index` below overlays, handle starts below the gutter).
  - remove every `.cb-statusbar` rule (shell, conversation-page, short window, keyboard-open, Duo) and the `--cb-layout-status-bar` terms; ActionRow stays at the bottom of the paper.
- [ ] **Step 4:** `pnpm exec vitest run --project design` PASS except tests that need Task 3/4/7 files (note them); `pnpm --filter @capybara-hq/design exec tsc --noEmit` (or `pnpm typecheck`) clean for the design package.
- [ ] **Step 5:** Screenshot `templates/list`, `templates/form`, `templates/conversation`, `pages/member-agents` with the coordinator's `shoot.mjs` (expanded, medium, compact; both themes) and compare with v10 yourself.
- [ ] **Step 6:** Commit `feat(design): layered shell, page head without a first-level path, no status bar`.

### Task 7: UI part removal

**Files:** Modify `packages/plugin-sdk/src/ui-parts.ts`; regenerate with `pnpm gen:ui-parts` (`packages/design/src/ui-parts.generated.ts`, `packages/plugin-client/src/ui-parts.generated.ts`, `docs/guide/ui-parts.md`); `pnpm gen:sdk-api`; `pnpm gen:plugin-client`; modify `packages/design/test/ui-parts.test.tsx`; create `.changeset/layered-shell-ui-parts.md`.

- [ ] **Step 1:** Delete the `status-bar` part entry and its name from the list; regenerate.
- [ ] **Step 2:** `ui-parts.test.tsx` expects no `status-bar`; `pnpm check:ui-parts`, `pnpm check:sdk-api`, `pnpm check:plugin-client-api` PASS.
- [ ] **Step 3:** Changeset bumping `@capybara-hq/plugin-sdk` (patch) and, only if its API report changed, `@capybara-hq/plugin-client` (patch): "Removes the `status-bar` UI part: the shell no longer draws a status bar." `pnpm check:api-changeset --base origin/main` PASS.
- [ ] **Step 4:** Commit `feat(plugin-sdk)!: remove the status-bar UI part` (no `!` if commitlint rejects pre-1.0 breaking markers; use `feat(plugin-sdk):`).

### Task 8: Web product

**Files:** `apps/web/src/components/shell/AppFrame.tsx`, `apps/web/src/app/(app)/inbox/view.tsx`, `apps/web/src/app/(app)/admin/inbox/view.tsx`, `apps/web/src/components/conversation/{ConversationView,ComposerBar,RightArea,PropertiesSections,SubagentPanel}.tsx`, `apps/web/messages/*` (if keys change), `apps/web/test/{conversation-page,inbox}.test.tsx`, `apps/web/e2e/{conversation-capabilities,tools}.spec.ts`.

**Interfaces — Consumes:** Task 3 (`context`, `rounds`), Task 4 (`account.status`, `account.footnote`), Task 6 (`announce`, removed `status` / `ownStatusBar`).

- [ ] **Step 1: Failing tests** (`conversation-page.test.tsx`): replace status-bar assertions with `the run state is announced in [data-part="run-announce"]` (idle / running / stopped / failed / waiting texts), `the composer shows the context meter at 43%`, `the meter is fail at 80%` (from `COMPACTION_DEFAULTS.threshold`), `no meter before any usage`, `the properties Context section shows 第 N 轮 · 已用 … in [data-part="context-rounds"]`. `inbox.test.tsx`: drop the `useStatusBar` mock and its cases (the head `count` already shows the pending number; keep or add an assertion on it).
- [ ] **Step 2:** Run `pnpm exec vitest run apps/web/test/conversation-page.test.tsx apps/web/test/inbox.test.tsx`: FAIL.
- [ ] **Step 3:** Implement: `ConversationView` passes `announce={statusText}`, `context={{ pct: contextPct, over: contextPct >= COMPACTION_DEFAULTS.threshold * 100 }}` to the composer when `contextPct !== null`, `rounds={<RunStatsText …/>}` (when `stats.turns > 0`) through `useRightAreaSlot` → `PropertiesSections` → `ContextSection`; `ComposerBar` forwards `context`. `AppFrame`: drop `status` / `ownStatusBar` props on `AppShell` and `SetupPage`; `account.footnote = [version, timeZone].filter(v => v !== "").join(" · ")`; keep the drawer's account sheet `status` unchanged (it still uses `statusPrompt`). `SubagentPanel`: no footer; meta gets ` · ${tc("contextPct", { n: pct })}` when `pct !== null`. Inbox views: delete `useStatusBar`.
- [ ] **Step 4:** e2e specs: `statusBar(page)` → `page.locator('[data-part="conv-main"] [data-part="run-announce"]')`; `tools.spec.ts` the same.
- [ ] **Step 5:** `pnpm exec vitest run --project web` PASS; `pnpm check:web-ui`, `pnpm check:i18n` PASS.
- [ ] **Step 6:** Commit `feat(web): rewire the status bar's content into the composer, properties and account menu`.

### Task 9: Catalog

**Files:** `apps/web/src/dev/catalog/**` (`components/shell.tsx`, `conversation-page-blocks.tsx`, `reference-blocks.tsx`, `routes.tsx`, `stress.tsx`, `templates/{detail,inbox,list,overview,trace}.tsx`, fixtures shells), `apps/web/visual/accepted.ts`, `packages/design/src/fixtures/index.ts`.

- [ ] **Step 1:** Delete the StatusBar row, `statusBarBlocks`, the `status-bar` route and its ACCEPTED entry; delete every `useStatusBar(...)` call; remove `status` / `ownStatusBar` from catalog `AppShell` / `ConversationPage` uses (give the conversation fixture an `announce`); drop `adminScope` from fixtures.
- [ ] **Step 2:** Add the composer RefBlocks `composer-context-meter` and `composer-context-meter-over` (same ids as Task 5) and a catalog row for both; give the property-section context block a rounds row; a catalog sidebar state with an account status (fail) and footnote.
- [ ] **Step 3:** `pnpm exec vitest run --project web` and `pnpm exec vitest run packages/design/test/spec-tables.test.ts` PASS; `pnpm check:web-ui` PASS.
- [ ] **Step 4:** Commit `feat(web): catalog for the layered shell`.

### Task 10: Integration and acceptance (coordinator)

- [ ] **Step 1:** `pnpm verify --fast`; then the changed tests (`pnpm exec vitest run <path>`); `pnpm check:web-ui`; `pnpm check:tokens`. Fix every failure in the owning task's files (dispatch a fixer per area).
- [ ] **Step 2:** `.changeset/layered-shell.md` bumping `@capybara-hq/capybara` (patch): the layered shell summary.
- [ ] **Step 3:** Screenshots (three classes × both themes) of `templates/conversation`, `templates/list`, `templates/form`, `pages/member-agents` and an admin page; compare with v10.
- [ ] **Step 4:** `COMPARE=sidebar,page-header,composer,property-section,template-list,template-form,template-conversation pnpm --filter @capybara-hq/web compare` inside `mcr.microsoft.com/playwright:v1.64.1-noble` against a local `next start`; blind image reviewer subagent on the PNG pairs with only the standard instruction; fix severe / moderate, repeat; list the minor ones.
- [ ] **Step 5:** Composer stays in `ACCEPTED` (state coverage includes the new states); push, open the PR (ready), run `visual-update` and `reference-update` on the branch, inspect the diff images against v10, get `ci-ok` green.
