# Mobile and foldable layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. With 15 tasks, `wave-planned-subagent-development` governs the dispatch (wave table below).

**Goal:** The deployment's web is a first-class compact / medium / expanded and foldable experience,
installable as a PWA with a per-deployment name and icon, and it carries the Shell environment
contract the desktop client and a later mobile app shell fill in.

**Architecture:** All adaptation lives in `packages/design`: one size-class module drives CSS media
queries (the authority) and a post-hydration hook; the App Shell draws a bottom navigation and a
top bar on compact, the rail on medium, the collapsible full sidebar on expanded; templates take
their per-class form through a shared `ListDetail` primitive and container queries. apps/web adds
only routes (`/conversations`, `/me`, `app/manifest.ts`), nav data, a viewport export, foreground
resume and the `lib/shell.ts` adapter. The kernel gains the platform icon (table, routes, Platform
operations). The plugin-sdk carries the `CapybaraShell` types and the slots' `compact` field;
plugin-client gains `useSizeClass` / `useViewportSegments`. Push is out of scope (deferred).

**Tech Stack:** TypeScript, Next 16 (apps/web), React, CSS in `packages/design/src/styles`, Nest
kernel, Kysely / PostgreSQL, object storage (`StorageService.deployment()`), Vitest (design jsdom,
kernel integration), Playwright (visual and interaction specs, Linux baselines through the
`visual-update` workflow only).

**Spec:** [mobile layout](../specs/2026-11-19-mobile-layout-design.md). Read it whole before any
task, then the skills of the area a task touches:
[writing-web-ui](../../../.agents/skills/writing-web-ui/SKILL.md) (always, for design and web
tasks; it holds the "adding a component" flow and `check:web-ui`),
[writing-extension-ui](../../../.agents/skills/writing-extension-ui/SKILL.md) (Tasks 2, 13),
[writing-kernel-api](../../../.agents/skills/writing-kernel-api/SKILL.md) and
[writing-migrations](../../../.agents/skills/writing-migrations/SKILL.md) (Task 5),
[writing-object-store-providers](../../../.agents/skills/writing-object-store-providers/SKILL.md)
(Task 5). Before changing apps/web read `node_modules/next/dist/docs` (apps/web/AGENTS.md).

**Cross-plan dependency (desktop client plan, written in parallel).** The kernel config
`platform.name` (`CAPYBARA_PLATFORM__NAME`) and `GET /api/v1/meta` are implemented **only** by the
desktop plan (`docs/superpowers/plans/2026-11-19-desktop-client.md`, its "platform.name and
/api/v1/meta" task). Task 9 here consumes them and must not start before that task is merged.
In the other direction, the desktop plan's web tasks (the `device@1` / `signIn@1` / `notify@1`
accessors) build on this plan's Task 2 (the `CapybaraShell` types) and Task 11 (`lib/shell.ts`,
`useShellCapability`, `ShellEnvironmentScript`), and may use Task 5's icon route for the Dock icon.

## Global Constraints

- Size classes by window width only: compact `< 600`, medium `600–840`, expanded `≥ 841`. Media
  queries exactly `(max-width: 599px)`, `(min-width: 600px) and (max-width: 840px)`,
  `(min-width: 841px)`. The one fit threshold left is 1280 (inline right area), as
  `(min-width: 1280px)` / `(max-width: 1279px)`. No orientation, device model or user agent.
- Two width rules: the full sidebar from 841 (collapsible to the 48 rail by the person, cookie
  `cb-sidebar=rail`, ⌘\ / Ctrl+\); the right area inline from 1280, a sheet below.
- Short window: height `< 480` sets `data-short` on the shell (StatusBar hidden, path row dropped,
  bottom navigation icons without labels).
- Content minimum width `552` (was 560). `layout.sidebar` 256, `layout.sidebar-rail` 48,
  `layout.chat-min` 480, `layout.panel-min` 520 unchanged.
- Bottom navigation, exactly four items in this order: 会话 / Chats `/conversations`, 智能体 /
  Agents `/agents`, 收件箱 / Inbox `/inbox` (pending count), 我 / Me `/me`. No files page.
- apps/web writes no styles (`check:web-ui`); every per-class difference is design CSS; a page never
  branches on width, class or shell. First paint follows the window through CSS (server renders
  every variant; `useSizeClass()` returns `null` on the server and during hydration).
- `window.capybaraShell` is read only by `ShellEnvironmentScript` / `AppShell` (design) and
  `apps/web/src/lib/shell.ts`. Capability keys are `name@major`; an absent capability = the
  browser. Never the user agent.
- State tokens on the shell's `data-cap-state`, after hydration, in this order after the existing
  ones: `size=compact|medium|expanded`, `shell=desktop|mobile` (only when a shell is present).
- UI text in zh and en (apps/web `messages/{zh,en}.json`, design `src/i18n.ts`); zh says 平台 /
  超级管理员 / 智能体, never 企业 or the Latin `agent` (`pnpm check:i18n`). English comments
  (`pnpm check:english-comments --base origin/main`).
- Published packages get a changeset: `@capybara-hq/plugin-sdk` (Task 2), `@capybara-hq/plugin-client`
  (Task 13), `@capybara-hq/kernel` and `@capybara-hq/web` for user-visible changes (one changeset
  per task that changes them). SDK API changes run `pnpm gen:sdk-api`.
- Screenshot baselines are rendered only by the `visual-update` workflow (dispatched on the branch);
  never commit `*-darwin.png`. Reference PNGs only by `reference-update`.
- Push notifications are out of scope: no service worker, no notification tables, no
  `/account/notifications`.

## Review Focus

1. A desktop window resized from 1300 to 900 to 700 to 500 and back without a reload → the shell
   moves sidebar → rail → bottom navigation and back, the right area becomes a sheet below 1280 and
   a pushed page on compact, and the URL hash still holds the open right area (Task 10 Playwright
   case `resize keeps the right area`).
2. JavaScript off at 382 / 768 / 951 → the first paint already has the class's frame: no full
   sidebar on compact, no horizontal page scroll (Task 14 JS-off cases).
3. A deep link to a pushed page opened with no in-app history (from an IM card) → the top bar's
   back goes to the last linked `path` segment, never `history.back()` out of the app (Task 6 test
   `back without history goes up the path`).
4. A page script calling a shell capability that needs a confirmation without a user gesture, or
   twice at once → refused / `busy` is the shell's job, but the web must never call one outside an
   event handler (Task 11 test: `lib/shell.ts` confirming accessors throw when called during
   render).
5. The super admin uploads a 512 × 512 file that is not a PNG (a renamed JPEG, an SVG with
   script as "app") or a 513 × 512 PNG → refused with an actionable error, nothing stored; the
   public route serves only stored PNG / SVG with `Content-Type` fixed by purpose and
   `X-Content-Type-Options: nosniff`, SVG with a sandbox CSP (Task 5 tests).

---

## File map

| Path | Change | Task |
|---|---|---|
| `docs/design/spec.md`, `docs/design/reference/src/**` | per-class rules, new components' states and size tables, reference blocks | 1 |
| `packages/plugin-sdk/src/shell-environment.ts` (new), `ui-slots.ts`, `ui.ts`, `index.ts`, `api/plugin-sdk.api.md`, `docs/guide/ui-slots.md`, `apps/web/src/lib/ui-slots.generated.ts` | shell types, slot `compact`, contribution `compact` | 2 |
| `tools/checks/src/web-shell-access.ts` (new), fixtures, tests, `tools/checks/README.md` | `web-shell-access` | 3 |
| `packages/design/src/shell/size-class.ts` (new), `sidebar.tsx`, `app-shell.tsx`, `body.tsx`, `page-header.tsx`, `src/styles/*.css` (breakpoints), `tools/checks/src/design-breakpoint.ts` (new), `apps/web/src/app/(app)/layout.tsx`, `components/shell/AppFrame.tsx` | size classes, migration, collapse | 4 |
| `packages/kernel/src/themes/platform-icon*.ts` (new), migration, `platform/ops/*`, `platform/exclusions.ts`, `themes.module.ts` | platform icon | 5 |
| `apps/web/src/app/manifest.ts` (new), `app/layout.tsx` (metadata, icons), `(app)/admin/settings/view.tsx`, `components/AppIconSection.tsx` (new), `lib/query/admin.ts`, `proxy.ts`, messages | manifest, icon settings | 9 |
| `packages/design/src/shell/bottom-nav.tsx`, `top-bar.tsx`, `me-panel.tsx` (new), `app-shell.tsx`, `shell.css`, `i18n.ts`; `apps/web/src/components/shell/nav.tsx`, `AppFrame.tsx`, `(app)/conversations/*`, `(app)/me/*`, `lib/query/routes.ts`, messages, `dev/catalog/shell-fixture.tsx` | compact shell | 6 |
| `packages/design/src/layout/list-detail.tsx` (new), `templates/*.tsx`, `styles/templates.css`, `dev/catalog/templates/*` | templates per class | 7 |
| `packages/design/src/overlays/sheet.tsx`, `overlays/drag.ts` (new), `styles/overlays.css`, `dev/catalog/overlays.tsx` | follow-finger sheets | 8 |
| `packages/design/src/templates/conversation-page.tsx`, `follow-bottom.ts`, `styles/conversation-page.css`, `dev/catalog/conversation-page-blocks.tsx` | conversation per class | 10 |
| `packages/design/src/shell/shell-environment.tsx` (new), `styles/shell-environment.css` (new), `styles/base.css` (inset tokens), `app-shell.tsx`; `apps/web/src/app/layout.tsx` (viewport, script), `lib/shell.ts` (new), `lib/stream.ts`, `components/conversation/useConversation*` | viewport, safe areas, foreground resume, shell environment | 11 |
| `packages/design/src/shell/segments.ts` (new), `layout/list-detail.tsx`, `styles/templates.css`, `styles/conversation-page.css` | foldables | 12 |
| `packages/plugin-client/src/hooks.ts`, `index.ts`; `apps/web/src/components/client-ext/host-api.ts`, `components/extension-ui/*`, `packages/kernel/src/ui/registry.ts`, `ui.schemas.ts` | slots compact, client hooks | 13 |
| `apps/web/visual/*.spec.ts`, `apps/web/visual/compact.interaction.spec.ts` (new), `apps/web/visual/accepted.ts`, `packages/design/src/reference/compact.ts` (new) | verification | 14 |
| `.agents/skills/writing-web-ui/SKILL.md`, `writing-extension-ui/SKILL.md`, `AGENTS.md` | docs, area rule | 15 |

## Wave plan

Shared files are owned by one task per wave: apps/web `messages/{zh,en}.json` (Task 6 in wave 3,
Task 9 in wave 4), design `src/i18n.ts` (Task 6 in wave 3; later tasks in their own waves),
`packages/design/src/shell/app-shell.tsx` (Tasks 4, 6, 11 in waves 2, 3, 5), catalog registration
(`apps/web/src/dev/catalog/index.tsx` / `routes.tsx`: only Task 6 registers a new file; other
tasks add states to the existing catalog file of their area), `apps/web/visual/accepted.ts` (Task 14
only).

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 Design spec and reference blocks | — | `docs/design/**` | normal | 1 | maintainer reviews the spec diff (gate for waves 2+ design work) |
| 2 SDK: shell types, slot and contribution `compact` | — | plugin-sdk, generated slot docs | normal | 1 | batched |
| 3 `web-shell-access` check | — | tools/checks | normal | 1 | batched |
| 4 Size classes, breakpoint migration, sidebar collapse | 1 | design shell + styles, `design-breakpoint` check, app layout cookie | normal | 2 | batched |
| 5 Platform icon (kernel) | — | kernel themes module, migration, Platform ops | **high** (public route serving uploaded content, super-admin upload) | 2 | alone, most capable |
| 6 Compact shell: bottom nav, top bar, push model, `/conversations`, `/me` | 1, 4 | design shell, apps/web nav / routes / messages | normal | 3 | batched |
| 7 Templates per class and `ListDetail` | 1, 4 | design templates, templates.css | normal | 3 | batched |
| 8 Follow-finger sheets | 1, 4 | design overlays | normal | 3 | batched |
| 9 PWA manifest and icon settings | 5, **desktop plan: platform.name + /api/v1/meta** | apps/web manifest, admin settings, proxy matcher, messages | **high** (proxy matcher: an unauthenticated path) | 4 | alone |
| 10 Conversation per class, scroll pinning, long threads | 6, 7, 8 | design conversation page | normal | 4 | batched |
| 11 Viewport, safe areas, foreground resume, Shell environment | 2, 3, 6 | design shell env, root layout, `lib/shell.ts`, stream | **high** (shell bridge detection and origin rules) | 5 | alone, most capable |
| 12 Foldables (segments) | 7, 10 | design segments, list-detail, conversation css | normal | 5 | batched |
| 13 Slots compact on the web, client hooks | 2, 6, 12 | plugin-client, host-api, extension-ui, kernel ui registry | normal | 6 | batched |
| 14 Verification matrix, compact rule set, acceptance | 4–12 | apps/web/visual, design reference | normal | 6 | batched |
| 15 Skills and AGENTS.md | all | `.agents/skills`, AGENTS.md | normal | 7 | batched |


---

### Task 1: Design spec and reference blocks

**Files:**
- Modify: `docs/design/spec.md` §2.5 (`layout.content-min` 552), §4 (shell per class table, the
  bottom navigation, top bar, push model, collapse toggle, `data-short`), §4.1, §4.3 (breakpoints
  rewritten to the classes; the existing phone rules move under compact, 640 → 600, 960 removed,
  the rail below 1280 removed), §5 (a "Classes" row per template from spec §5.1), §5.4 (compact
  right area as a pushed page), §6.7 (sheet drag states), §6.13 (rail on medium, collapse),
  §7.3 (`size=`, `shell=` tokens); new component sections `BottomNav`, `TopBar`, `ListDetail`,
  `MePanel` with `<!-- states: -->` lists and `<!-- size-table: -->` tables
- Modify: `docs/design/tokens.json` (`layout.content-min: 552`, `layout.bottom-nav: 56`,
  `layout.top-bar` = `row.roomy`), then `pnpm gen:tokens`
- Create: `docs/design/reference/src/` blocks `bottom-nav-{default,active,badge,short}`,
  `top-bar-{root,pushed,overflow}`, `list-detail-{compact-list,compact-detail,two-pane}`,
  `me-panel-{member,admin,super-admin}`, `sheet-{dragging,settling}`

- [ ] **Step 1:** Write the spec diff with the exact values of Global Constraints. State lists:
  `bottom-nav`: `default`, `active`, `badge`, `short`; `top-bar`: `root`, `pushed`, `overflow`;
  `list-detail`: `compact-list`, `compact-detail`, `two-pane`; `me-panel`: `member`, `admin`,
  `super-admin`; `sheet`: add `dragging`, `settling`. Size tables reference `tokens.json` paths only
  (`bottom-nav` item height `layout.bottom-nav`, tap target 40, label `type.micro`; `top-bar`
  height `row.roomy`, buttons 40).
- [ ] **Step 2:** Add the reference blocks (`data-ref-block="<component>-<state>"`) from
  `@capybara-hq/design/fixtures`.
- [ ] **Step 3:** Run `pnpm gen:tokens && pnpm check:tokens && pnpm check:agent-docs` — clean.
- [ ] **Step 4:** Commit `docs(design): size classes, compact shell and per-class templates`.
  Push and ask the maintainer to review the spec diff; waves 2+ design tasks start after approval.
  Then dispatch the `reference-update` workflow on the branch for the PNGs.

### Task 2: SDK shell types, slot and contribution `compact`

**Files:**
- Create: `packages/plugin-sdk/src/shell-environment.ts`
- Modify: `packages/plugin-sdk/src/ui-slots.ts` (`UiSlotSpec.compact`, one value per slot),
  `packages/plugin-sdk/src/ui.ts:48-62` (`UiContribution.compact?`), `src/index.ts`
- Regenerate: `api/plugin-sdk.api.md` (`pnpm gen:sdk-api`), `docs/guide/ui-slots.md` and
  `apps/web/src/lib/ui-slots.generated.ts` (`pnpm gen:ui-slots`)
- Create: `.changeset/mobile-sdk-shell-compact.md` (`"@capybara-hq/plugin-sdk": minor`)
- Test: `packages/plugin-sdk/test/ui-slots.test.ts`, `packages/plugin-sdk/test/shell-environment.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export type CompactForm = "kept" | "drawer" | "hidden";
  // UiSlotSpec: compact: CompactForm;  UiContribution: compact?: CompactForm;
  export function effectiveCompact(slot: CompactForm, contribution?: CompactForm): CompactForm;
  export interface CapybaraShell { /* exactly spec §9.1: version: 1; kind; platform; shellVersion;
    insets; controls?: {x,y,width,height} | null; capabilities: Readonly<Record<string, object>>;
    on(event: "change", listener: () => void): () => void; */ }
  export const SHELL_CAPABILITIES: readonly { key: string; owner: string }[]; // spec §9.2 registry:
  // device@1, notify@1, openExternal@1, signIn@1 (desktop spec), chrome@1 (this spec)
  ```
  Slot values exactly as spec §5.6: `conversation.panel` `drawer`, `shell.brand` `hidden`, every
  other slot `kept`.

- [ ] **Step 1: Failing tests.** `ui-slots.test.ts`: `it("every slot declares a compact form")`
  iterates `UI_SLOT_IDS` and expects `uiSlot(id).compact` in the three values; the two named
  values above. `effectiveCompact("kept","hidden") === "hidden"`, `effectiveCompact("hidden","kept")
  === "hidden"` (never widen), `effectiveCompact("drawer", undefined) === "drawer"`. A contribution
  with `compact: "sideways"` is dropped by the existing contribution validation with a reason
  naming the field. `shell-environment.test.ts`: `expectTypeOf<CapybaraShell["version"]>().toEqualTypeOf<1>()`
  and `SHELL_CAPABILITIES.map(c => c.key)` equals the five keys.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/ui-slots.test.ts packages/plugin-sdk/test/shell-environment.test.ts` — FAIL.
- [ ] **Step 3: Implement** (order of narrowing `kept < drawer < hidden`; types only in
  `shell-environment.ts`, plus the registry constant).
- [ ] **Step 4: Run** the tests — PASS; `pnpm gen:ui-slots && pnpm gen:sdk-api && pnpm check:ui-slots && pnpm check:sdk-api && pnpm check:sdk-api-changeset && pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(sdk): shell environment types and compact forms for UI slots`.

### Task 3: `web-shell-access` check

**Files:**
- Create: `tools/checks/src/web-shell-access.ts`, fixtures under `tools/checks/fixtures/web-shell-access/{ok,violation}/`
- Modify: the `check:web-ui` runner that lists rules, `tools/checks/README.md` (rule, runs by diff
  on PRs like the other web-ui rules)
- Test: `tools/checks/test/web-shell-access.test.ts`

- [ ] **Step 1: Failing test** (red first): the violation fixture reads `window.capybaraShell` and
  `globalThis.capybaraShell` in `apps/web/src/app/x/view.tsx` → two findings with rule id
  `web-shell-access`; the same reads in `apps/web/src/lib/shell.ts` and in `packages/design/src/shell/shell-environment.tsx` → none; a test file → none.
- [ ] **Step 2: Run** `pnpm exec vitest run tools/checks/test/web-shell-access.test.ts` — FAIL.
- [ ] **Step 3: Implement** on the same AST walker the other web-ui rules use (member access whose
  property is `capybaraShell` on `window` / `globalThis` / `self`).
- [ ] **Step 4: Run** the test — PASS; `pnpm check:web-ui` clean on the tree.
- [ ] **Step 5: Commit** `feat(checks): web-shell-access`.

### Task 4: Size classes, breakpoint migration, sidebar collapse

**Files:**
- Create: `packages/design/src/shell/size-class.ts`, `tools/checks/src/design-breakpoint.ts` + fixtures + test
- Modify: `packages/design/src/shell/sidebar.tsx` (drop `SIDEBAR_RAIL_QUERY` / `SIDEBAR_DRAWER_QUERY`;
  rail on medium, full on expanded unless collapsed), `app-shell.tsx` (`size=` token, `data-short`,
  `collapsed` / `onCollapsedChange`), `body.tsx`, `page-header.tsx`, `shell/index.ts`, every
  `packages/design/src/styles/*.css` media query (23 × 639 → 599, 4 × 959 and the 1279 rail rules
  rewritten to the class queries, 1280 kept only for the right area)
- Modify: `apps/web/src/app/(app)/layout.tsx` (read `cb-sidebar` cookie), `apps/web/src/components/shell/AppFrame.tsx` (pass it; write the cookie on change through `document.cookie` in an event handler, path `/`, one year)
- Test: `packages/design/test/size-class.test.tsx` (new), update `sidebar-layout.test.ts`, `shell.test.tsx`, `narrow.test.tsx`; `tools/checks/test/design-breakpoint.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SizeClass = "compact" | "medium" | "expanded";
  export const SIZE_CLASS_QUERIES: Record<SizeClass, string>; // exact queries of Global Constraints
  export const INLINE_RIGHT_AREA_QUERY = "(min-width: 1280px)";
  export const SHORT_WINDOW_QUERY = "(max-height: 479px)";
  export function useSizeClass(): SizeClass | null;
  export function sizeClassOf(width: number): SizeClass;
  // AppShellProps gains: collapsed?: boolean; onCollapsedChange?(collapsed: boolean): void;
  ```

- [ ] **Step 1: Failing tests.** `sizeClassOf(599) === "compact"`, `600 → "medium"`, `840 →
  "medium"`, `841 → "expanded"`; `useSizeClass()` is `null` in a server render
  (`renderToString`) and the matching class after hydration with a stubbed `matchMedia`; the shell's
  `data-cap-state` ends with `size=medium` after hydration at 700; `data-short` set with
  `(max-height: 479px)` matching; at 1000 with `collapsed` the sidebar renders the rail and the
  toggle button `aria-pressed="true"`, ⌘\ toggles and calls `onCollapsedChange(false)`.
  `design-breakpoint.test.ts`: a fixture CSS with `@media (max-width: 639px)` and one with `100vh`
  → two findings; the class queries and `1279px` / `1280px` → none.
- [ ] **Step 2: Run** `pnpm exec vitest run --project design packages/design/test/size-class.test.tsx` and the check test — FAIL.
- [ ] **Step 3: Implement**; migrate the CSS. Every server-rendered variant keeps the "draw both,
  CSS shows one" pattern (sidebar full + rail).
- [ ] **Step 4: Run** `pnpm vitest run --project design`, `pnpm exec vitest run tools/checks/test/design-breakpoint.test.ts`, `pnpm check:web-ui`, `pnpm check` (the new rule passes on the migrated tree), `pnpm typecheck`.
- [ ] **Step 5:** Changeset `@capybara-hq/web: patch` ("layout follows size classes; the sidebar can be collapsed"). Commit `feat(design): size classes, breakpoint migration and a collapsible sidebar`.

### Task 5: Platform icon (kernel) — high risk, review alone

**Files:**
- Create: `packages/kernel/src/migrations/<next>_platform_icons.sql` (`capybara.platform_icons`:
  `purpose text primary key check (purpose in ('app','maskable','favicon'))`, `object_key text not null`,
  `sha256 text not null`, `content_type text not null`, `updated_at timestamptz not null default now()`;
  `IF NOT EXISTS`)
- Create: `packages/kernel/src/themes/platform-icon.service.ts`, `platform-icon.controller.ts`,
  `platform-icon-public.controller.ts`, `platform-icon.schemas.ts`
- Modify: `themes.module.ts`, `packages/kernel/src/errors.ts` (codes), `platform/ops/` (two
  operations), `platform/exclusions.ts` (the public read)
- Create: `.changeset/platform-icon.md` (`@capybara-hq/kernel: minor`)
- Test: `packages/kernel/test/themes/platform-icon.test.ts` (integration, default list)

**Interfaces:**
- Produces (routes):
  - `GET /api/v1/admin/platform/icons` → `{ icons: { purpose, url, sha256, updatedAt }[] }` (super admin)
  - `PUT /api/v1/admin/platform/icons/:purpose` body `{ contentType: "image/png" | "image/svg+xml", dataBase64: string }` → the icon view (super admin, `@Transactional`; object written first, then the row; the old object deleted through the outbox)
  - `DELETE /api/v1/admin/platform/icons/:purpose` → 204 (restore default)
  - `GET /api/v1/platform/icon/:purpose?v=<sha256>` `@Public` → bytes; 404 when unset (the web then uses its default set)
  - Platform operations `platform.icons.set`, `platform.icons.clear`, `platform.icons.list` built from the route schemas; exclusion for the public GET, category `transport`, reason "Public image delivery for the manifest and favicons".
- Error codes: `platform_icon.invalid_type`, `platform_icon.invalid_size` (message names the required 512 × 512), `platform_icon.too_large` (1 MiB), `platform_icon.storage_unavailable`.

- [ ] **Step 1: Failing tests.** A super admin `PUT app` with a 512 × 512 PNG → 200, `GET admin/platform/icons` lists it, the public GET with the returned `v` serves the same bytes with `Content-Type: image/png`, `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`; a JPEG body declared as PNG → `invalid_type`; a 513 × 512 PNG → `invalid_size`; 1 MiB + 1 → `too_large`; `favicon` with `image/svg+xml` served with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`; `app` with SVG → `invalid_type`; an org owner (not super admin) → 403; a second `PUT` replaces and the old object is deleted after the outbox runs; `DELETE` then public GET → 404; the parity test lists the two operations and the exclusion.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/themes/platform-icon.test.ts` — FAIL.
- [ ] **Step 3: Implement.** PNG check by the signature and the IHDR width / height bytes (no image
  library); SVG check: parses as XML with an `<svg>` root, `favicon` only. Keys under
  `StorageService.deployment()` as `platform-icons/<purpose>-<sha256>.<ext>`.
- [ ] **Step 4: Run** the test, `pnpm check:platform-ops`, `pnpm exec vitest run packages/kernel/test/platform/platform-parity.test.ts`, `pnpm check:kernel-conventions`, `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(kernel): platform icon setting`.

### Task 6: Compact shell, `/conversations`, `/me`

**Files:**
- Create: `packages/design/src/shell/bottom-nav.tsx`, `top-bar.tsx`, `me-panel.tsx`
- Modify: `packages/design/src/shell/app-shell.tsx` (bottom nav + top bar on compact; the drawer bar
  and drawer removed), `shell/index.ts`, `styles/shell.css`, `src/i18n.ts` (`shell.back`,
  `shell.more`, `nav.me`), `dev/catalog/shell-fixture.tsx` and the catalog registration
- Modify: `apps/web/src/components/shell/nav.tsx` (`useNav` returns `bottom: BottomNavItem[]`),
  `AppFrame.tsx`, `apps/web/src/lib/query/routes.ts` (two entries)
- Create: `apps/web/src/app/(app)/conversations/{page,view}.tsx` (`ListPage variant="objects"` over
  `conversationGroupsQuery`, 加载更多 through `moreGroupsQuery`, primary action 新会话 → `/`),
  `apps/web/src/app/(app)/me/{page,view}.tsx` (`OverviewPage` with `MePanel` fed from the same nav,
  org and account data as the sidebar)
- Modify: `apps/web/messages/{zh,en}.json` (`nav.chats`, `nav.me`, `conversations.*`, `me.*`)
- Test: `packages/design/test/bottom-nav.test.tsx`, `top-bar.test.tsx` (new), `shell.test.tsx`;
  `apps/web/test/conversations-page.test.tsx`, `me-page.test.tsx` (new)

**Interfaces:**
- Consumes: `useSizeClass`, `SIZE_CLASS_QUERIES` (Task 4).
- Produces:
  ```ts
  export type BottomNavItem = { id: "chats" | "agents" | "inbox" | "me"; label: string; href: string;
    icon: IconName; count?: number; countMore?: boolean };
  // AppShellProps gains: bottomNav: BottomNavItem[]; path?: PathSegment[] (for back);
  export function backTarget(path: { href?: string }[], hasInAppHistory: boolean): "history" | string;
  export function MePanel(p: MePanelProps): JSX.Element; // account, org switcher, more items, admin entry, system status, sign out
  ```

- [ ] **Step 1: Failing tests.** Bottom nav renders exactly four links in the Global Constraints
  order with `aria-current="page"` on the active one and the inbox badge `99+` above 99; it is in
  the server markup and hidden by CSS outside compact (assert the `data-part="bottom-nav"` element
  exists in `renderToString`); hidden while `data-keyboard="open"` and on pushed routes (a route
  not among the four hrefs shows the top bar's back button instead); `backTarget([{href:"/agents"},{}], false) === "/agents"`
  (`back without history goes up the path`), `backTarget(…, true) === "history"`. apps/web: the two
  pages' "first render from the hydrated cache makes no browser read" and "empty cache shows the
  loading state, then the data" cases; `/me` lists 更多 items by role (guest sees none of the
  admin items; super admin sees the admin entry).
- [ ] **Step 2: Run** `pnpm vitest run --project design packages/design/test/bottom-nav.test.tsx packages/design/test/top-bar.test.tsx` and `pnpm exec vitest run apps/web/test/conversations-page.test.tsx apps/web/test/me-page.test.tsx` — FAIL.
- [ ] **Step 3: Implement.** Push transitions with the View Transitions API when present
  (`document.startViewTransition`), none under reduced motion.
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm typecheck`.
- [ ] **Step 5:** Changeset `@capybara-hq/web: minor`. Commit `feat(design,web): compact bottom navigation, top bar and the chats and me pages`.

### Task 7: Templates per class and `ListDetail`

**Files:**
- Create: `packages/design/src/layout/list-detail.tsx`
- Modify: `packages/design/src/layout/index.tsx`, `templates/{list,detail,form,settings,wizard,inbox,trace,overview,auth,status,onboarding,setup,shared-file}-page.tsx` as spec §5.1 needs, `body.tsx` only if the inspector moves into `ListDetail`, `styles/templates.css`, `dev/catalog/templates/*`
- Test: `packages/design/test/list-detail.test.tsx` (new), updates to `detail-page.test.tsx`, `inbox-page` / template tests, `head-rhythm.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function ListDetail(p: {
    list: ReactNode; detail: ReactNode | null; // null = nothing open
    onBack(): void; listMin: number; detailMin: number; label: string;
  }): JSX.Element;
  ```
  Two panes when the frame's container width ≥ `listMin + detailMin` (container query on
  `data-part="list-detail"`), else the stack; InboxPage `listMin` 320 / `detailMin` 360; Trace
  waterfall / detail; `Grid columns="list-detail"` uses it.

- [ ] **Step 1: Failing tests.** `ListDetail` with `detail={null}` shows the list; with a detail in
  stack form it renders a back button named by `shell.back` that calls `onBack`, and the list keeps
  its scroll position on return (scrollTop restored); FormPage on compact: the ActionRow carries
  `data-sticky="true"` and pads by `--cb-keyboard-inset`; WizardPage compact step bar reads `2 / 4`.
- [ ] **Step 2: Run** `pnpm vitest run --project design packages/design/test/list-detail.test.tsx` — FAIL.
- [ ] **Step 3: Implement** spec §5.1 per template; Settings keeps the 2026-11-09 compact row.
- [ ] **Step 4: Run** `pnpm vitest run --project design`, `pnpm check:web-ui`, `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(design): per-class templates and the ListDetail primitive`.

### Task 8: Follow-finger sheets

**Files:**
- Create: `packages/design/src/overlays/drag.ts`
- Modify: `overlays/sheet.tsx`, the composer's bottom sheet (`conversation/composer-options.tsx`),
  `styles/overlays.css`, `dev/catalog/overlays.tsx`
- Test: `packages/design/test/sheet-drag.test.tsx` (new)

**Interfaces:**
- Produces: `export function useDragDismiss(opts: { axis: "y" | "x"; size: () => number; onDismiss(): void; scroller?: RefObject<HTMLElement> }): { handleProps: HTMLAttributes<HTMLElement>; state: "idle" | "dragging" | "settling" }` — dismiss past 40 % of `size()` or velocity above 0.5 px/ms.

- [ ] **Step 1: Failing tests** with synthetic pointer events: a 50 % drag dismisses; a 20 % slow drag
  settles back (`data-state="settling"` then `idle`); a drag starting in a body with `scrollTop > 0`
  does nothing; Esc and the scrim still close and focus returns; reduced motion: no transition
  class.
- [ ] **Step 2: Run** `pnpm vitest run --project design packages/design/test/sheet-drag.test.tsx` — FAIL.
- [ ] **Step 3: Implement** (pointer capture, `touch-action: none` on the handle only).
- [ ] **Step 4: Run** the design project and `pnpm check:web-ui`.
- [ ] **Step 5: Commit** `feat(design): follow-finger sheets`.

### Task 9: PWA manifest and icon settings — high risk, review alone

**Depends on:** Task 5 and the desktop plan's `platform.name` + `/api/v1/meta` task (merged).

**Files:**
- Create: `apps/web/src/app/manifest.ts`, `apps/web/src/components/AppIconSection.tsx`
- Modify: `apps/web/src/app/layout.tsx` (`generateMetadata`: title default from meta `name`,
  `appleWebApp`, `icons` pointing at the kernel icon URLs with the web's default set as fallback),
  `apps/web/src/app/(app)/admin/settings/view.tsx` (the 应用图标 section after the theme),
  `apps/web/src/lib/query/admin.ts` + `keys.ts` (`platformIconsQuery`, freshness `deployment`),
  `apps/web/src/proxy.ts` matcher (exclude `manifest\.webmanifest$` and the default icon files so
  a signed-out browser can read them), default icons under `apps/web/src/app/` (`icon-512.png`,
  `icon-maskable-512.png`, existing `icon.svg`), messages `{zh,en}.json` (`appIcon.*`)
- Test: `apps/web/test/manifest.test.ts`, `apps/web/test/app-icon-section.test.tsx`, `apps/web/test/proxy.test.ts` (case added)

**Interfaces:**
- Consumes: `GET /api/v1/meta` → `{ name: string | null, … }` (desktop plan); Task 5 routes.
- Produces: `manifest()` → `{ name, short_name, start_url: "/", scope: "/", display: "standalone", theme_color, background_color, icons }`.

- [ ] **Step 1: Failing tests.** With meta `name: "Example Corp"` and an uploaded `app` + `maskable`
  icon, `manifest()` has that name and two icons (`purpose: "any"` and `"maskable"`, 512 × 512, the
  `?v=` URLs); with `name: null` and no icons: `"Capybara"` and the default set; colors are the
  built-in theme's `bg` token values for dark (`theme_color` / `background_color`). Proxy: a
  signed-out request for `/manifest.webmanifest` is not redirected to `/login`; `/admin/settings`
  still is. AppIconSection: upload of a 512 PNG calls `PUT …/icons/app` and invalidates
  `platformIconsQuery`; a kernel `platform_icon.invalid_size` shows its copy; 恢复默认 calls
  `DELETE`; the mutation invalidates the key (the "invalidates" case).
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/manifest.test.ts apps/web/test/app-icon-section.test.tsx apps/web/test/proxy.test.ts` — FAIL.
- [ ] **Step 3: Implement**; the file input reads the file with `FileReader` and sends base64.
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm typecheck`.
- [ ] **Step 5:** Changeset `@capybara-hq/web: minor`. Commit `feat(web): PWA manifest with the platform name and icon`.

### Task 10: Conversation per class, scroll pinning, long threads

**Files:**
- Modify: `packages/design/src/templates/conversation-page.tsx`, `templates/follow-bottom.ts`,
  `styles/conversation-page.css`, `dev/catalog/conversation-page-blocks.tsx`
- Test: `packages/design/test/conversation-shell.test.tsx`, `follow-bottom.test.tsx`, `right-panel-full.test.tsx`; `apps/web/visual/conversation.interaction.spec.ts` (cases added; runs in CI, baselines via `visual-update`)

**Interfaces:**
- Consumes: `useDragDismiss` (Task 8) for the medium side sheet; `useSizeClass` (Task 4).
- Produces: `ConversationPage` takes no new prop: the right area becomes a pushed page on compact
  (`data-right="pushed"`), a side sheet below 1280, inline from 1280; a `LatestButton` inside the
  template.

- [ ] **Step 1: Failing tests.** Follow state survives a resize: at bottom, shrinking the scroller
  by 300 px (keyboard) keeps it at bottom; away from bottom, new content shows the latest button,
  tapping it scrolls to bottom and resumes following; thread items carry
  `content-visibility: auto` and a `contain-intrinsic-size` from their last measured height
  (style attribute set after first measure); compact: opening `#properties` renders the right area
  full-screen with a back control that clears the hash. Playwright: `resize keeps the right area`
  (1300 → 900 → 500 → 1300 with `#properties` open), `no horizontal page scroll` at 382, 600, 840,
  841, 1279.
- [ ] **Step 2: Run** `pnpm vitest run --project design packages/design/test/follow-bottom.test.tsx packages/design/test/conversation-shell.test.tsx` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the design project; `pnpm --filter @capybara-hq/web visual conversation.interaction` locally (darwin, comparison only).
- [ ] **Step 5: Commit** `feat(design): conversation per size class, latest button and lighter long threads`.

### Task 11: Viewport, safe areas, foreground resume, Shell environment — high risk, review alone

**Files:**
- Create: `packages/design/src/shell/shell-environment.tsx` (`ShellEnvironmentScript`, the
  inline script string `SHELL_ENVIRONMENT_SCRIPT`, `useShellEnvironment`), `styles/shell-environment.css`
  (imported with `layer(design)`)
- Modify: `packages/design/src/styles/base.css` (`--cb-inset-top|right|bottom|left` =
  `max(env(safe-area-inset-*), var(--cb-shell-inset-*, 0px))`, used by the top bar, bottom nav,
  sticky ActionRow, composer), `shell/app-shell.tsx` (subscribe to `change`, `shell=` token,
  `chrome@1.setAppearance({ scheme, background })` on theme change), `shell/index.ts`
- Modify: `apps/web/src/app/layout.tsx` (`export const viewport = { width: "device-width",
  initialScale: 1, viewportFit: "cover", interactiveWidget: "resizes-content", themeColor: [...] }`;
  render `<ShellEnvironmentScript nonce={x-nonce} />` first in `<head>`)
- Create: `apps/web/src/lib/shell.ts`
- Modify: `apps/web/src/lib/stream.ts` and the conversation stream hook (reopen on
  `visibilitychange` → visible, `pageshow`, `online`; invalidate the `live` freshness keys)
- Test: `packages/design/test/shell-environment.test.tsx` (new), `keyboard-inset.test.tsx`;
  `apps/web/test/shell-adapter.test.ts`, `apps/web/test/stream-resume.test.ts` (new)

**Interfaces:**
- Consumes: `CapybaraShell` (Task 2), `web-shell-access` (Task 3).
- Produces:
  ```ts
  // design
  export function ShellEnvironmentScript(p: { nonce?: string }): JSX.Element;
  // apps/web/src/lib/shell.ts
  export function useShellCapability<T extends object>(key: string): T | undefined;
  export function shellCapability<T extends object>(key: string): T | undefined; // event handlers only
  ```
  The script sets on `<html>`: `data-shell`, `data-shell-platform`, `--cb-shell-inset-*`,
  `--cb-shell-controls-x|y|width|height` (unset when `controls` absent / null). It does nothing
  when `window.capybaraShell` is missing, `version !== 1`, or `window !== window.top`.

- [ ] **Step 1: Failing tests.** Script: with no global → `<html>` untouched; with
  `{ version: 1, kind: "desktop", platform: "macos", insets: {top: 28,…}, controls: {x: 8, y: 6, width: 64, height: 16} }`
  → `data-shell="desktop"`, `--cb-shell-inset-top: 28px`, `--cb-shell-controls-width: 64px`; with
  `version: 2` → untouched; inside an iframe (`window.top !== window`) → untouched. AppShell: a
  `change` that sets `controls: null` removes the controls properties; theme switch calls
  `chrome@1.setAppearance` once with the new scheme. `useShellCapability("device@1")` is
  `undefined` in the server render, `undefined` before the shell adds it, the object after a
  `change` event, and unsubscribes on unmount. `shellCapability` called during a render throws
  (`calls a shell capability outside an event handler`). Stream: a closed EventSource and a
  `visibilitychange` to visible reopens from the cached last seq and invalidates the inbox and
  groups keys; an open one is left alone.
- [ ] **Step 2: Run** `pnpm vitest run --project design packages/design/test/shell-environment.test.tsx` and `pnpm exec vitest run apps/web/test/shell-adapter.test.ts apps/web/test/stream-resume.test.ts` — FAIL.
- [ ] **Step 3: Implement.** The script is a fixed string (no interpolation of page data); the
  root layout reads `x-nonce` from `headers()`. No new script source in the CSP.
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui` (incl. `web-shell-access`), the CSP tests in
  `apps/web/test` (`proxy` / `headers`), `pnpm typecheck`.
- [ ] **Step 5:** Changeset `@capybara-hq/web: minor`. Commit `feat(design,web): safe areas, foreground resume and the shell environment`.

### Task 12: Foldables (viewport segments)

**Files:**
- Create: `packages/design/src/shell/segments.ts`
- Modify: `layout/list-detail.tsx`, `styles/templates.css`, `styles/conversation-page.css`, `shell/index.ts`
- Modify: `tools/checks/src/design-breakpoint.ts` (allow the segment media queries) and its test
- Test: `packages/design/test/segments.test.tsx` (new)

**Interfaces:**
- Produces: `export type ViewportSegment = { x: number; y: number; width: number; height: number };`
  `export function useViewportSegments(): ViewportSegment[] | null;` (`null` without the API, with
  one segment, on the server and during hydration). Two-pane regions set `data-segments="2"` and
  CSS places panes with `env(viewport-segment-*)` under `@media (horizontal-viewport-segments: 2)`
  / `(vertical-viewport-segments: 2)`.

- [ ] **Step 1: Failing tests** with a fake `window.viewport = { segments: [a, b] }` and a
  `matchMedia` stub: `useViewportSegments()` returns both; a `resize` with one segment → `null`;
  `ListDetail` with two horizontal segments renders two panes even below `listMin + detailMin` and
  sets `data-segments="2"`; without `window.viewport` → `null` and unchanged layout.
- [ ] **Step 2: Run** `pnpm vitest run --project design packages/design/test/segments.test.tsx` — FAIL.
- [ ] **Step 3: Implement** (no posture reads).
- [ ] **Step 4: Run** the design project, `pnpm check` (`design-breakpoint` accepts the segment queries: add them to its allowed list in this task).
- [ ] **Step 5: Commit** `feat(design): split two-pane templates along viewport segments`.

### Task 13: Slots compact on the web, client hooks

**Files:**
- Modify: `packages/kernel/src/ui/registry.ts`, `ui.schemas.ts` (resolved contributions carry
  `compact: effectiveCompact(slot.compact, contribution.compact)`), `apps/web/src/components/extension-ui/ExtensionSlot.tsx`
  (compact `hidden` → not rendered on compact; `drawer` → handed to the slot owner's pushed page /
  sheet), `apps/web/src/components/client-ext/host-api.ts`, `packages/plugin-client/src/hooks.ts`,
  `src/index.ts`; `pnpm gen:plugin-client`
- Create: `.changeset/plugin-client-size-class.md` (`@capybara-hq/plugin-client: minor`, `@capybara-hq/kernel: patch`)
- Test: `packages/kernel/test/ui/contributions-compact.test.ts` (integration), `apps/web/test/extension-slot-compact.test.tsx`, `packages/plugin-client/test/hooks.test.tsx`

**Interfaces:**
- Consumes: `effectiveCompact`, `CompactForm` (Task 2); `useSizeClass` (Task 4); `useViewportSegments` (Task 12).
- Produces: plugin-client `useSizeClass(): "compact" | "medium" | "expanded" | null` and `useViewportSegments(): { x; y; width; height }[] | null`, read from the host; `CLIENT_API_VERSION` stays 1.

- [ ] **Step 1: Failing tests.** Kernel: a `fake-tools-ui` contribution to `org.page` with
  `compact: "hidden"` is served with `compact: "hidden"`; to `shell.brand` with `compact: "kept"`
  stays `hidden`. Web: at compact a `hidden` contribution renders nothing and a `kept` one renders;
  `shell.overlay` keeps `pointer-events: none`. plugin-client `/testing` fake host returns the
  values it is given.
- [ ] **Step 2: Run** the three test files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm check:plugin-client-api`, `pnpm check:ui-slots`, `pnpm check:web-ui`, `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(web,plugin-client): compact forms for extension slots and the size class hook`.

### Task 14: Verification matrix, compact rule set, acceptance

**Files:**
- Create: `packages/design/src/reference/compact.ts` (`findCompactViolations`), export from `reference/index.ts`; `apps/web/visual/compact.interaction.spec.ts`
- Modify: `apps/web/visual/catalog.spec.ts`, `admin-overview.spec.ts`, `head-rhythm.spec.ts` (width matrix `[382, 390, 768, 951, 1440]`, heights per spec §11.1, the 844 × 390 short form), `apps/web/visual/accepted.ts` (the new components)
- Test: `packages/design/test/compact-violations.test.tsx` (new)

- [ ] **Step 1: Failing tests.** `findCompactViolations` on fixtures: an action shown only on
  `:hover` (a `data-hover-only` control), an icon-only button without an accessible name, a
  compact list-detail without a back control → three findings; the real templates rendered at
  compact → none. Playwright `compact.interaction.spec.ts`: for every template catalog page at 382
  and 390, JS on and off: `scrollingElement.scrollWidth <= innerWidth`, every interactive element
  has a ≥ 40 × 40 hit box, the primary action is in the viewport after vertical scroll, the last
  item is not under the bottom nav, text fields ≥ 16 px under a coarse pointer
  (`hasTouch: true`).
- [ ] **Step 2: Run** `pnpm vitest run --project design packages/design/test/compact-violations.test.tsx` — FAIL; then PASS after implementing.
- [ ] **Step 3: Accept** each new component per writing-web-ui "Adding a component" step 4:
  `COMPARE=bottom-nav,top-bar,list-detail,me-panel,sheet pnpm --filter @capybara-hq/web compare`
  in the Linux Playwright image, blind image review by a subagent, fix severe and moderate, add to
  `ACCEPTED`; `pnpm --filter @capybara-hq/web visual fidelity`.
- [ ] **Step 4: Baselines:** dispatch `visual-update` on the branch; attach the diffs to the PR.
- [ ] **Step 5: Manual** on the Xcode 27.1 iPhone Duo simulator (outer 382 portrait, inner 951
  landscape, partly folded with segments if the developer preview flags are on) and an Android
  phone: conversation, inbox approval, file preview; record in the PR.
- [ ] **Step 6: Commit** `test(web,design): size class visual matrix and the compact rule set`.

### Task 15: Skills and AGENTS.md

**Files:**
- Modify: `.agents/skills/writing-web-ui/SKILL.md` (classes, the two width rules, compact shell,
  `ListDetail`, sheets, `lib/shell.ts`, `web-shell-access`, `design-breakpoint`; the old "Phones
  (below 640)" bullets rewritten), `.agents/skills/writing-extension-ui/SKILL.md` (slot `compact`,
  contribution narrowing, the client hooks), `AGENTS.md` Rules by area (the spec's new
  "Mobile and shells" rule, with "expanded ≥ 841")
- Modify: `tools/checks/README.md` if Tasks 3 / 4 left wording to settle

- [ ] **Step 1:** Edit; run `pnpm check:agent-docs`, `pnpm lint`.
- [ ] **Step 2: Commit** `docs: mobile layout rules in the skills and AGENTS.md`.
- [ ] **Step 3:** Whole-branch final review (most capable model), then `pnpm verify`.

---

## Gaps in the spec found while planning (decided here, flag in review)

1. **Manifest behind the sign-in proxy**: `apps/web/src/proxy.ts`'s matcher would redirect a
   signed-out `/manifest.webmanifest` to `/login`; Task 9 excludes it and the default icons
   (high-risk review because it widens the unauthenticated surface).
2. **`/me` needs a template** (`web-ui-template`): `OverviewPage` with a design `MePanel` (Task 6).
3. **Contribution narrowing**: the spec says "manifest (`ui.<contribution>.compact`)"; the field
   lives on the SDK's `UiContribution` (`compact?`), which is how contributions are declared
   (Task 2).
4. **Manifest colors**: a theme is CSS; `theme_color` / `background_color` use the built-in theme's
   token values, not a plugin theme's (Task 9).
5. **Icon upload as JSON base64** so the Platform tool can mirror it (`platform.icons.set`), in line
   with the platform web parity line, instead of a multipart route with an exclusion (Task 5).
6. **Root layout nonce**: the root layout does not read `x-nonce` today; Task 11 adds it for
   `ShellEnvironmentScript`.
