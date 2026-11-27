# Plugin Full Pages (L2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task, with `wave-planned-subagent-development` on top. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a plugin build full pages (lists, a board, detail, settings) as L2 client components
from forwarded design components, with named data queries, page parameters, navigation and a
primary-navigation placement.

**Architecture:** The SDK and `plugin-client` gain the contract (`ctx.ui.query`, `usePluginQuery`,
`usePageParams`, `useNavigate`, `frame: "page"`, `nav`). The kernel adds one query route next to
the UI action route. The design system gains `Board` and `PrincipalPicker`; `plugin-client`
forwards templates and components; the web host implements the hooks, the page frame and nav pins.

**Tech Stack:** TypeScript, React 19, `@capybara-hq/design`, `@dnd-kit/core` + `@dnd-kit/sortable`,
TanStack Query (web), NestJS kernel, vitest + jsdom, Playwright visuals (Linux image).

**Spec:** `docs/superpowers/specs/2026-11-25-plugin-full-pages-design.md` (parent:
`2026-11-25-collaboration-design.md`).

## Global Constraints

- `CLIENT_API_VERSION` stays `1`: only additions; never change an existing forwarded prop.
- Every forwarded component: frozen minimal props in `packages/plugin-client/src/design.ts`,
  fake-host stand-in in `src/testing/index.ts`, entry in `tools/checks/src/plugin-client-api.ts`
  `DESIGN_SUBSET`, entry in `tools/checks/fixtures/plugin-client-props/compat.tsx`, the web's
  `apps/web/src/components/client-ext/host-api.ts`; then `pnpm gen:plugin-client`.
- Limits: query params ≤ 16 384 bytes, result ≤ 1 048 576 (`UI_LIMITS.componentQueryBytes`),
  query timeout 10 s; component action payload ≤ 65 536 (`UI_LIMITS.componentActionPayloadBytes`),
  view block payloads stay 2 000; page params ≤ 2 048 bytes; at most 3 plugin pages in primary nav.
- New design components follow writing-web-ui "Adding a component or template": spec §6 entry,
  tokens, reference blocks, implementation + jsdom tests, catalog page, `compare` acceptance,
  `ACCEPTED` entry, baselines via the `visual-update` workflow (never rendered locally).
- `apps/web` writes no styles; `@dnd-kit/*` is a dependency of `@capybara-hq/design` only.
- Changesets: `@capybara-hq/plugin-sdk` (minor), `@capybara-hq/plugin-client` (minor),
  `@capybara-hq/capybara` (patch).
- zh copy: 智能体, 平台; UI text through `apps/web/messages/{en,zh}.json` (design strings through
  `packages/design/src/i18n.ts`).

## Review Focus

1. **A plugin query that throws or hangs:** the component shows the design error state with retry;
   other components on the page keep working; no crash-budget hit. Task F2
   (`query error and timeout surface as status error`) and F6.
2. **Back/forward after params change:** the page re-renders with the URL's params, no stale
   query. Task F6 (`browser back restores params`).
3. **A drop into a locked column while offline / the action fails:** the card snaps back and the
   toast shows. Task F3 (`rejected move snaps back`).
4. **Huge lists:** a board with 500 cards stays responsive at compact. Task F3
   (`renders 500 cards without layout thrash`: one render pass, virtualized columns not required,
   but no per-card measurement on drag start).
5. **A member without access to the page opens a deep link:** the host's designed no-access state,
   no plugin query call. Task F6.

---

### Task F1: SDK and plugin-client contract

**Files:**
- Modify: `packages/plugin-sdk/src/ui.ts` (`UiQueryArgs`, `UI_LIMITS.componentQueryBytes`, `componentActionPayloadBytes`, `pageParamsBytes`), `packages/plugin-sdk/src/ctx.ts` (`ui.query`), `packages/plugin-sdk/src/ui-slots.ts` (`org.page` props `params`), the manifest ui entry type (`frame?: "host" | "page"`, `nav?: "primary" | "more"`; only on `org.page`), `validateManifest` refusals
- Modify: `packages/plugin-client/src/{context.ts,hooks.ts,index.ts,types.ts,slots.generated.ts}` (`usePluginQuery`, `usePageParams`, `useNavigate`), `src/testing/index.ts` (fake host implementations: in-memory query table, params, navigate log)
- Generated: `packages/plugin-sdk/api/plugin-sdk.api.md`, `packages/plugin-client/api/plugin-client.api.md`, `apps/web/src/lib/client-host/api.generated.ts`, `slots.generated.ts`
- Test: `packages/plugin-sdk/test/ui-query.test.ts`, `packages/plugin-client/test/page-hooks.test.tsx`
- Create: `.changeset/plugin-full-pages-sdk.md`

**Interfaces:**
- Produces (SDK):

```ts
export interface UiQueryArgs extends OrgRenderArgs { query: string; params: JsonValue; signal: AbortSignal }
// ExtensionContext.ui
query(id: string, handler: (a: UiQueryArgs) => Promise<JsonValue>): void;
```

- Produces (plugin-client):

```ts
export function usePluginQuery<T = unknown>(query: string, params?: JsonValue, opts?: { staleMs?: number }):
  { data: T | undefined; status: "loading" | "ready" | "error"; error?: string; refetch(): void };
export function usePageParams(): Record<string, string>;
export type NavigateTarget =
  | { params: Record<string, string | null>; replace?: boolean }
  | { page: { id: string; params?: Record<string, string> } }
  | { conversation: string };
export function useNavigate(): (to: NavigateTarget) => void;
// useAction result gains: { view?; toast?; invalidate?: string[] }
// renderWithFakeHost options gain: { queries?: Record<string, (params: JsonValue) => unknown>; params?: Record<string, string> }
```

- [ ] **Step 1: failing tests**:

```ts
test("usePluginQuery resolves from the host and refetches on invalidate", async () => {
  const r = renderWithFakeHost(<Probe />, { queries: { items: (p) => [{ id: "1", p }] } });
  expect(await r.findByText('[{"id":"1","p":{"project":"CAP"}}]')).toBeTruthy();
  r.host.invalidate(["items"]); expect(r.host.queryCalls("items")).toBe(2);
});
test("useNavigate refuses targets outside the plugin", () => {
  const nav = renderHook(useNavigate, { host: fakeHost() }).result.current;
  expect(() => nav({ url: "https://x" } as never)).toThrow(/navigate target/);
});
test("manifest refuses frame on a slot other than org.page", () => {
  expect(validateManifest(m({ ui: [{ id: "p", slot: "conversation.panel", kind: "component", frame: "page" }] })).ok).toBe(false);
});
```

- [ ] **Step 2:** `pnpm exec vitest run packages/plugin-sdk/test/ui-query.test.ts packages/plugin-client/test/page-hooks.test.tsx` → FAIL.
- [ ] **Step 3:** implement; `pnpm gen:sdk-api && pnpm gen:plugin-client && pnpm gen:ui-slots`.
- [ ] **Step 4:** tests PASS; `pnpm check:sdk-api && pnpm check:plugin-client-api && pnpm check:ui-slots` → PASS.
- [ ] **Step 5: Commit** `feat(plugin-client): queries, page params and navigation for components`.

### Task F2: Kernel query route, limits, invalidation, inbox links

**Files:**
- Modify: `packages/kernel/src/ui/views.controller.ts` (`POST api/v1/orgs/:orgId/ui/query/:plugin/:id`, `@OrgAction("ui.use")`, `requireUser`), `packages/kernel/src/ui/ui.service.ts` (`query(orgId, principal, plugin, id, body)`: offered-contribution check, params ≤ 16 KB → 413 `ui.query_params_too_large`, result ≤ 1 MB → 502 `ui.query_result_too_large`, 10 s → 504 `ui.query_timeout`, handler error → 502 `ui.query_failed`), `packages/kernel/src/ctx/create-ctx.ts` (`ui.query` registration, gated by `permissions.ui.components` containing the id), `ui/invalidate` bus message carries `queries: true`, action payload limit per kind, `errors.ts`, `platform/exclusions.ts` (category `transport`, reason "the web's channel for plugin components; agents use the plugin's tools"), `platform/route-schemas.ts`
- Modify: `packages/kernel/src/inbox/inbox-items.service.ts` (from kernel plan C1; skip if C1 not merged yet and add in C1): plugin `link` must start with `/p/<plugin>/`
- Test: `packages/kernel/test/ui/component-query.http.test.ts`; uses `packages/testing/fixtures/extensions/fake-client-page/` (created here: `org.page` component `board` with `frame: "page"`, `nav: "primary"`, queries `items` / `slow` / `boom` / `huge`, action `move`)

**Interfaces:**
- Consumes: F1 SDK types.
- Produces: response `{ data: JsonValue }`; bus message `{ type: "ui.invalidate", contribution, queries: true }` which the web maps to TanStack invalidation.

- [ ] **Step 1: failing tests**: `returns the handler's data for an offered component`; `404 when the contribution is not offered to the person`; `service token refused`; `413 on params over 16 KB`; `query error and timeout surface as status error` (`boom` → 502 `ui.query_failed`, `slow` → 504); `huge result → 502`; `component action accepts a 60 KB payload, a view block action still caps at 2 000`; `ctx.ui.invalidate publishes queries: true`.
- [ ] **Step 2–4:** FAIL → implement → PASS; `pnpm check:platform-ops && pnpm check:kernel-conventions`.
- [ ] **Step 5: Commit** `feat(kernel): component queries for plugin pages`.

### Task F3: Design `Board`

**Files:**
- Modify: `docs/design/spec.md` §6 (Board: anatomy, states idle / dragging / over / locked-over / empty / loading, sizes per class), `docs/design/tokens.json` (`board.column.width` 280, `board.gap` 12, `board.card.radius` = card radius) + `pnpm gen:tokens`, `docs/design/reference/src/board.html` (`data-ref-block="board-<state>"`)
- Create: `packages/design/src/display/board.tsx`, `packages/design/src/styles/board.css`, export from `display/index.ts`
- Modify: `packages/design/package.json` (`@dnd-kit/core`, `@dnd-kit/sortable`), `packages/design/src/i18n.ts` (`board.moveTo`, `board.pickedUp`, `board.movedTo`, `board.cancelled`, `board.locked`)
- Create: `apps/web/src/dev/catalog/board-page.tsx` (+ route entry)
- Modify: `apps/web/visual/accepted.ts` (after acceptance)
- Test: `packages/design/test/board.test.tsx`

**Interfaces:**
- Produces: `Board`, `BoardProps`, `BoardColumn`, `BoardCard` exactly as spec §6.

- [ ] **Step 1:** spec, tokens, reference blocks (review gate: the spec diff before implementation).
- [ ] **Step 2: failing tests**: `keyboard: space picks, arrow right moves to next column, space drops → onMove(id, col2, 0)`; `escape cancels without onMove`; `locked column shows its hint and still calls onMove`; `rejected move snaps back` (onMove rejects → card in original column); `canMove false refuses the drop`; `compact: no drag handles, Move to menu lists other columns`; `renders 500 cards without layout thrash` (one render, no `getBoundingClientRect` per card before drag); `announces pick/move/drop in a live region`.
- [ ] **Step 3:** implement with `DndContext` + `SortableContext` per column, `KeyboardSensor` + `PointerSensor` (activation distance 6 px); the compact structure (no drag, "Move to…" menu, snap scrolling) is a `ClassForms` compact form, never a CSS-only switch.
- [ ] **Step 4:** tests PASS; catalog page with every state light/dark; `COMPARE=board pnpm --filter @capybara-hq/web compare` in the Linux image, blind review, fix severe/moderate, add to `ACCEPTED`.
- [ ] **Step 5: Commit** `feat(design): Board`. Baselines: dispatch `visual-update` on the PR branch.

### Task F4: Design `PrincipalPicker`

**Files:**
- Modify: `docs/design/spec.md` §6, `docs/design/reference/src/principal-picker.html`
- Create: `packages/design/src/controls/principal-picker.tsx`, `styles/principal-picker.css`; export
- Create: `apps/web/src/dev/catalog/principal-picker-page.tsx`
- Test: `packages/design/test/principal-picker.test.tsx`

**Interfaces:**
- Produces: `PrincipalPicker`, `PrincipalPickerProps`, `PrincipalOption` as spec §7.

- [ ] **Step 1:** spec + reference blocks (states: closed, open, searching, grouped, multi, disabled option, empty, loading).
- [ ] **Step 2: failing tests**: `typing filters by name and calls onSearch`; `groups people and agents under headings when groups`; `multiple keeps the popover open and toggles ids`; `disabled option cannot be chosen`; `compact opens a bottom sheet`; `Enter chooses the active option`.
- [ ] **Step 3:** implement from `Popover` + the composer picker's list pieces (`PickerItem`, `picker-groups.ts`); compact via `ClassForms` → `BottomSheet`.
- [ ] **Step 4:** PASS; catalog; compare; `ACCEPTED`.
- [ ] **Step 5: Commit** `feat(design): PrincipalPicker`.

### Task F5: Forward templates and components through `plugin-client`

**Files:**
- Modify: `packages/plugin-client/src/design.ts` (names + frozen props for the spec §3 table), `src/index.ts`, `src/testing/index.ts` (stand-ins; `DataTable`, `Tabs`, `Dialog`, `Board`, `PrincipalPicker`, `Input`, `Textarea` get behaving stand-ins), `tools/checks/src/plugin-client-api.ts` (`DESIGN_SUBSET`), `tools/checks/fixtures/plugin-client-props/compat.tsx` (all new names + `Select`), `apps/web/src/components/client-ext/host-api.ts` (`HOST_DESIGN`; forwarded templates wrap the design template and prepend the host's scope crumbs from context)
- Generated: `apps/web/src/lib/client-host/api.generated.ts`, `packages/plugin-client/api/plugin-client.api.md`
- Test: `packages/plugin-client/test/design-forward.test.tsx`, `tools/checks/test/plugin-client-api.test.ts` (red twin for a drifted `DataTable` prop)

**Interfaces:**
- Consumes: F3 `BoardProps`, F4 `PrincipalPickerProps`.
- Produces: forwarded props are subsets: e.g.

```ts
export interface DataTableProps<R> { columns: { id: string; title: string; width?: number; render?: (row: R) => ReactNode; sort?: boolean }[];
  rows: R[]; rowKey: (row: R) => string; onOpen?: (row: R) => void; sort?: { id: string; dir: "asc" | "desc" }; onSort?: (s: { id: string; dir: "asc" | "desc" }) => void;
  empty?: ReactNode; loading?: boolean; pagination?: { page: number; pageSize: number; total: number; onPage(p: number): void } }
export interface ListPageProps { header: { title: string; path?: string[]; actions?: ReactNode }; toolbar?: ReactNode; children: ReactNode }
export interface DetailPageProps { header: { title: string; path?: string[]; actions?: ReactNode }; tabs?: { id: string; label: string }[]; tab?: string; onTab?(id: string): void; facts?: { label: string; value: ReactNode }[]; loading?: boolean; children: ReactNode }
```

  (Write the remaining subsets from each design component's props, dropping `className`, `style`,
  refs and host-internal render props; the compat fixture proves each subset assignable.)

- [ ] **Step 1: failing tests**: every name in `DESIGN_SUBSET` renders through the fake host; compat fixture fails before the web entries exist (`pnpm check:plugin-client-api` red).
- [ ] **Step 2–4:** implement → `pnpm gen:plugin-client` → `pnpm check:plugin-client-api && pnpm typecheck` PASS.
- [ ] **Step 5: Commit** `feat(plugin-client): forward page templates and data components`.

### Task F6: Web host: page frame, params, navigation, queries

**Files:**
- Modify: `apps/web/src/app/(app)/p/[plugin]/[id]/page.tsx` (read `searchParams`), `view.tsx` (`frame: "page"` → render `ExtensionSlot` without `DetailPage`, inside a template-count guard; pass `params`), `apps/web/src/components/extension-ui/ExtensionSlot.tsx` (`SlotArgs` for `org.page` gains `params`), `apps/web/src/components/client-ext/{host-api.ts,ClientComponentBlock.tsx}` (`usePluginQuery` → `defineQuery`-style TanStack query keyed `["plugin-query", plugin, id, query, params]`; bus `ui.invalidate` with `queries` → `invalidateQueries`; `useNavigate` → `router.push/replace` limited to the spec's targets; `usePageParams` from search params), `apps/web/src/lib/query/` (keys, freshness class `live`)
- Create: `apps/web/src/components/extension-ui/template-guard.tsx` (counts forwarded templates rendered under a `page` frame; throws in dev/test when ≠ 1; logs in prod)
- Test: `apps/web/test/plugin-page-frame.test.tsx` (with `fake-client-page` client bundle)

- [ ] **Step 1: failing tests**: `frame page renders without DetailPage and with scope crumbs`; `two templates throw in tests`; `params round-trip: navigate({params}) updates the URL and usePageParams`; `browser back restores params`; `navigate to a conversation opens /chat/<id>`; `query error and timeout show the error state with retry, other components unaffected`; `deep link without access shows the no-access state and calls no query`.
- [ ] **Step 2–4:** FAIL → implement → PASS; `pnpm check:web-ui && pnpm check:web-api-parity`.
- [ ] **Step 5: Commit** `feat(web): full plugin pages`.

### Task F7: Navigation placement

**Files:**
- Modify: `packages/kernel/src/orgs/settings.service.ts` (`navigation.pluginPages: { contribution: string; section: "primary" | "more" }[]`, max 3 primary → 400 `org_settings.nav_primary_limit`), settings schemas + Platform op for the setting (operation mirrors the settings route as today)
- Modify: `apps/web/src/components/shell/nav.tsx` (`useExtensions` splits by effective section: admin choice, else the contribution's `nav` suggestion, primary capped at 3 in manifest order), `apps/web/src/components/AppFrame.tsx` (pass primary plugin pages), `packages/design/src/shell/sidebar.tsx` (`SidebarContext` gains `primaryExtensions` rendered after built-ins), org settings navigation section `apps/web/src/app/(app)/settings/navigation/` (page + view; FormPage with one section), i18n
- Test: `packages/kernel/test/orgs/navigation-settings.test.ts`, `apps/web/test/nav-plugin-pages.test.tsx`

- [ ] **Step 1: failing tests**: `suggested primary appears in primary nav`; `admin moves it to more`; `fourth primary refused`; `member cannot edit navigation settings`; `compact drawer shows the same split`.
- [ ] **Step 2–4:** FAIL → implement → PASS; visuals for sidebar change via `visual-update`.
- [ ] **Step 5: Commit** `feat: plugin pages in the primary navigation`.

### Task F8: Docs and skills

**Files:**
- Modify: `.agents/skills/writing-extension-ui/SKILL.md` (full pages: `frame`, queries, params, navigation, forwarded templates, the one-template rule), `.agents/skills/writing-web-ui/SKILL.md` (forwarding a design component checklist incl. `compat.tsx`), `docs/superpowers/specs/2026-11-09-client-extensions-design.md` (§4.2 forwarded list, §5.2 queries; written back), `AGENTS.md` Extension UI line
- [ ] **Step 1:** edit; `pnpm verify --fast` → PASS.
- [ ] **Step 2: Commit** `docs: plugin full pages`.

## Waves

| Wave | Tasks | Review |
|---|---|---|
| 1 | F1, F3, F4 (disjoint: SDK/client vs design files) | F1 alone (public contract); F3 + F4 batched |
| 2 | F2, F5 | F2 alone (new kernel route, auth guard) |
| 3 | F6, F7 | batched |
| 4 | F8 | — |

Runs alongside the kernel plan's PR B / PR C (disjoint files except `ui.service.ts` and the
inbox link rule, which F2 adds only once C1 exists). One PR for F1–F8, or F3/F4 split out if the
visual acceptance lags.
