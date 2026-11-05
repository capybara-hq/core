# Web Query Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every web read goes through TanStack Query: the first load renders complete on the server from a prefetched cache, later navigations read the browser cache, and every template has a loading state shaped like its loaded page.

**Architecture:** A route table maps each page pattern to its first-paint queries. `(app)/layout.tsx` and a new `(auth)/layout.tsx` prefetch those queries once per document request and hydrate them. Shared layouts do not re-render on client navigation, so after the first load every read is a client `useQuery` against one per-tab `QueryClient`. Freshness classes decide what is refetched, and mutations invalidate the query keys they change. The conversation stream writes into the cache. Design templates get `loading` states, and each skeleton uses the same boxes as its loaded page.

**Tech Stack:** Next 16.4 App Router, React 19.3, `@tanstack/react-query` v5, next-intl, `@capybara-hq/design`, vitest + Testing Library, Playwright (e2e, visual), oxc-based `check:web-ui`.

**Spec:** `docs/superpowers/specs/2026-11-03-web-query-cache-design.md` (Q1–Q6). It amends `docs/superpowers/specs/2026-11-01-web-ssr-design.md`.

## Global Constraints

- Work on branch `fix/rc2-acceptance`, in the worktree `.claude/worktrees/fix-rc2-acceptance`.
- Add `@tanstack/react-query` to `apps/web` only, as an exact version: the newest 5.x published at least two weeks before install, and ≥ 5.40, so pending queries can be dehydrated.
- `apps/web` depends only on `@capybara-hq/design` among the `@capybara-hq/*` packages. `packages/design` takes no TanStack dependency: templates take a `loading` prop and know nothing about queries.
- `apps/web` writes no styles: no className, no style, no `.css` files, no color literals. Skeleton looks live in `packages/design`.
- There is no `loading.tsx` anywhere (`web-ssr-loading-file` stays). No Server Actions, no `cacheComponents`, no PPR.
- Freshness values are fixed, exactly: `mine` = `Infinity`, `orgConfig` = `30_000`, `live` = `30_000`, `events` = `Infinity`, `deployment` = `30_000`, `unclassified` = `0`.
- `gcTime` stays at TanStack's default. Refetch flags: `refetchOnWindowFocus: false`, `refetchOnMount: true`, `refetchOnReconnect: true`.
- Retries: none for any 4xx `ApiClientError`; at most 1 for `network`, `upstream_unavailable` and 5xx.
- Query keys start with `"org", orgId` or `"account", accountId` or `"deployment"`. They come only from `lib/query/keys.ts`.
- Org switch and sign-out run `queryClient.cancelQueries()` and then `queryClient.clear()` before they navigate.
- Next `staleTimes` is not configured. Next internal request headers (`RSC`, `Next-Router-State-Tree`) are never read.
- Status codes:
  - A missing object renders the not-found state inside the shell with HTTP 200.
  - An unknown route keeps `notFound()` and HTTP 404.
  - The kernel unavailable on a first load keeps the `KernelStarting` frame.
- UI text goes through i18n (zh and en). New code comments and test titles are in English.
- Commits follow Conventional Commits, with body lines ≤ 100 characters. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run vitest from the repo root: `pnpm exec vitest run <path>`.
- Visual baselines are generated only by the `visual-update` workflow. The design reference PNGs are rendered only by the `reference-update` workflow.

## Review Focus

1. **Org switch while a read of the old org is in flight.** A slow `/agents` read for org A resolves after the switch to org B. It must not paint, and it must not land in B's cache. This is pinned in Task 4 (`cancelQueries` before `clear`, with a deferred-promise test).
2. **Session expires during a client navigation.** A 401 `auth.*` that survives the refresh retry redirects to `/login?next=<path>` and clears the cache. No error state flashes first. This is pinned in Task 4 (the global `QueryCache.onError` test).
3. **An object deleted elsewhere while it is still cached.** On return, the stale cache paints and the background refetch answers 404. The view then switches to the not-found state; it must not keep showing the deleted object. This is pinned in Task 3 (`usePageQuery` test).
4. **Duplicate or out-of-order events on stream reconnect.** A catch-up overlaps the cached events. The events list must stay unique and ordered by `seq`. This is pinned in Task 10 (`appendEvents` test).
5. **Search-param pages.** For example `/trajectories?agent=x` → `?agent=y`. Each search-param set is its own cache entry. The previous filter's rows never show under the new filter. This is pinned in Task 13 (key includes the search params; render test).

---

## File map

| Path | Responsibility |
|---|---|
| `apps/web/src/lib/query/client.ts` | `makeQueryClient()`, browser singleton `browserQueryClient()`, defaults (retry, refetch flags, dehydrate errors) |
| `apps/web/src/lib/query/keys.ts` | the key factory (the only place that builds a `queryKey`) |
| `apps/web/src/lib/query/freshness.ts` | `FRESHNESS`, `type Freshness` |
| `apps/web/src/lib/query/define.ts` | `defineQuery()` (the only `queryOptions(` call), `useAppMutation()` |
| `apps/web/src/lib/query/page-query.ts` | `usePageQuery()` → `PageState<T>` (loading / ready / notFound / error) |
| `apps/web/src/lib/query/workspace.ts` | client `useWorkspace()` / `useAdmin()` gates from the cache |
| `apps/web/src/lib/query/routes.ts` | route table, `matchRoute()` |
| `apps/web/src/lib/query/<area>.ts` | query definitions per area (shell, conversation, agents, …) wrapping the `lib/<area>.ts` loaders |
| `apps/web/src/lib/server/query.ts` | `serverQueryClient()` (React `cache`), `prefetchRoute()`, `dehydrateFor()` |
| `apps/web/src/components/QueryProvider.tsx` | `"use client"` provider, the global error handler (signed out) |
| `apps/web/src/app/(auth)/layout.tsx` | new group layout: route prefetch for the auth pages |
| `packages/design/src/display/skeleton.tsx` | skeleton primitives shared by the templates |
| `packages/design/src/templates/*-page.tsx` | `loading` props per template |
| `tools/checks/src/web-ui.ts` + `fixtures/web-ui/query-*` | the `web-query-*` rules and their red fixtures |
| `apps/web/test/support/query.tsx` | `renderRouteWithCache()`, `renderRouteEmptyCache()` |
| `apps/web/e2e/query-cache.spec.ts` | the request-counting e2e of spec §9 |
| `apps/web/visual/skeleton-alignment.spec.ts` | skeleton boxes = loaded boxes |

---

### Task 1: Spike: shared layouts do not re-run on client navigation

This task is throwaway and is not committed. It is a gate: if the result is negative, stop and report to the user before doing any other task (spec §3.1).

**Files:**
- Temporary only: `apps/web/src/app/(app)/layout.tsx`. Add a `console.log("LAYOUT", await currentPath())` and revert it afterwards.

- [ ] **Step 1:** Start the dev stack (`pnpm dev:kernel`, `pnpm dev:web`). Sign in, open `/agents` as a document request, and confirm `LAYOUT /agents` appears in `/tmp/capybara-dev-web.log`.
- [ ] **Step 2:** Click through `/agents` → `/agents/<id>` → `/chat/<id>` → `/trajectories?agent=<a>` → `/trajectories?agent=<b>`.
  Expected: no new `LAYOUT` line.
- [ ] **Step 3:** Trigger one `router.refresh()`, for example a save on `/settings/organization`.
  Expected: exactly one new `LAYOUT` line.
- [ ] **Step 4:** Revert the log line (`git checkout -- apps/web/src/app/\(app\)/layout.tsx`). Record the result in the PR description draft, `/private/tmp/claude-501/-Users-grant-Capybara-core/437af9d4-1202-42df-baf1-cdba60333527/scratchpad/query-spike.md`.

### Task 2: Query foundation

**Files:**
- Modify: `apps/web/package.json` (dependency `@tanstack/react-query`, exact).
- Create:
  - `apps/web/src/lib/query/{client,keys,freshness,define}.ts`
  - `apps/web/src/lib/server/query.ts`
  - `apps/web/src/components/QueryProvider.tsx`
- Modify: `apps/web/src/app/layout.tsx` (wrap `DesignRoot`'s children in `<QueryProvider>`).
- Test: `apps/web/test/query-foundation.test.ts`

**Interfaces:**
- Produces:
  - `FRESHNESS` and `type Freshness = keyof typeof FRESHNESS`.
  - `keys.account(accountId: string)`, `keys.org(orgId: string)` and `keys.deployment()`. Each returns an object of key builders, and every key is `readonly unknown[]`. The base keys are `keys.org(o).all` = `["org", o]`, `keys.account(a).all` = `["account", a]` and `keys.deployment().all` = `["deployment"]`. Area builders are added by the tasks that use them, always `[...all, "<area>", ...rest]`.
  - `defineQuery<T>(o: { key: readonly unknown[]; fn: () => Promise<T>; freshness: Freshness }): UseQueryOptions<T, ApiClientError>`. It is built with `queryOptions`, with `staleTime: FRESHNESS[o.freshness]`.
  - `useAppMutation<V, R>(o: { fn: (v: V) => Promise<R>; invalidates: (v: V, r: R) => (readonly unknown[])[]; onSuccess?: (r: R, v: V) => void })`. It is `useMutation`, and `onSuccess` awaits `invalidateQueries` for each listed key before calling the caller's `onSuccess`.
  - `makeQueryClient(): QueryClient` and `browserQueryClient(): QueryClient` (a module singleton in the browser, a new client on the server).
  - `serverQueryClient(): QueryClient` (React `cache`, so one client per request).
  - `dehydrateFor(qc: QueryClient): DehydratedState`. It includes queries with `status === "error"`, and stores each error as `{ status, code, message }`, so the client can rebuild an `ApiClientError`.

- [ ] **Step 1:** Write failing tests in `query-foundation.test.ts`:
  - `"freshness classes have the spec's values"`: `expect(FRESHNESS).toEqual({ mine: Infinity, orgConfig: 30_000, live: 30_000, events: Infinity, deployment: 30_000, unclassified: 0 })`.
  - `"every key starts with its scope"`: `keys.org("o1").all` equals `["org","o1"]`, `keys.account("a1").all` equals `["account","a1"]`, and `keys.deployment().all` equals `["deployment"]`.
  - `"defineQuery maps freshness to staleTime"`: `defineQuery({ key: keys.org("o").all, fn, freshness: "orgConfig" }).staleTime === 30_000`.
  - `"no retry for 4xx, one retry for network and 5xx"`: call `makeQueryClient().getDefaultOptions().queries.retry`.
    - With `(0, new ApiClientError(404,"x","x"))` it returns `false`.
    - With `(0, new ApiClientError(503,"x","x"))` it returns `true`.
    - With `(1, …503)` it returns `false`.
    - With `(0, new ApiClientError(0,"network","x"))` it returns `true`.
  - `"refetch flags"`: `refetchOnWindowFocus === false`, `refetchOnMount === true`, `refetchOnReconnect === true`.
  - `"a failed query is dehydrated with its kernel code and is not retried on mount"`:
    1. A query rejects with `ApiClientError(404,"conversation.not_found","…")`.
    2. Run `dehydrateFor(qc)`, then `hydrate` it into a fresh client.
    3. The query's state is `status === "error"`, and `error.code === "conversation.not_found"`.
    4. `retryOnMount` is false for it.
- [ ] **Step 2:** Run `pnpm exec vitest run apps/web/test/query-foundation.test.ts`.
  Expected: FAIL (the modules do not exist).
- [ ] **Step 3:** Install the dependency (`pnpm --filter @capybara-hq/web add -E @tanstack/react-query@<version>`). Implement the modules.
  - `QueryProvider` calls `browserQueryClient()` and renders `QueryClientProvider`.
  - The error rebuild on hydrate uses `hydrate`'s `defaultOptions.deserializeData`, or a `queryCache` `onSuccess`-free mapping. The builder picks; the test pins the result.
- [ ] **Step 4:** Run the test again.
  Expected: PASS. Then run `pnpm --filter @capybara-hq/web typecheck`.
  Expected: no errors.
- [ ] **Step 5:** Commit: `feat(web): TanStack Query client, key factory and freshness classes`.

### Task 3: Route table, layout prefetch and page states

**Files:**
- Create:
  - `apps/web/src/lib/query/routes.ts`
  - `apps/web/src/lib/query/page-query.ts`
  - `apps/web/src/lib/query/shell.ts`
  - `apps/web/src/app/(auth)/layout.tsx`
  - `apps/web/test/support/query.tsx`
- Modify:
  - `apps/web/src/lib/server/query.ts` (`prefetchRoute`)
  - `apps/web/src/lib/server/session.ts` (`getShell` fetches through the server query client)
  - `apps/web/src/app/(app)/layout.tsx`
  - `apps/web/src/components/shell/AppFrame.tsx` (reads the shell queries, not `initial`)
- Test:
  - `apps/web/test/query-routes.test.ts`
  - `apps/web/test/app-layout.test.tsx` (extend)

**Interfaces:**
- Consumes: everything from Task 2.
- Produces:
  - `interface RouteCtx { params: Record<string, string>; search: URLSearchParams; me: Me; orgId: string | null }`.
  - `interface RouteEntry { pattern: string; queries(ctx: RouteCtx): UseQueryOptions<unknown, ApiClientError>[]; none?: string }`. Here `pattern` uses the app-dir form, e.g. `/chat/[conversationId]`, and `none` is the reason an entry prefetches nothing.
  - `ROUTES: readonly RouteEntry[]`.
  - `matchRoute(path: string): { entry: RouteEntry; params: Record<string, string>; search: URLSearchParams } | null`. Static segments win over dynamic ones; `[...rest]` matches last.
  - `prefetchRoute(qc: QueryClient, path: string, session: { me: Me; orgId: string | null }): Promise<"ok" | "unknown">`.
    - It runs all matched queries in parallel with `qc.prefetchQuery`.
    - It returns `"unknown"` when nothing matches; the layout then calls `notFound()`.
    - When any query failed with a signed-out error (`isSignedOut`), it redirects to `loginPathFor(path)`.
  - Shell queries in `lib/query/shell.ts`:
    - `meQuery()`: key `keys.account("self").me()`, freshness `mine`.
      `me` is read before the account id is known, so `"self"` is the documented exception. The check in Task 5 allows this one literal.
    - `readinessQuery(orgId)`: `orgConfig`.
    - `conversationGroupsQuery(orgId, view = "default")`: `live`.
    - `inboxCountQuery(orgId)`: `live`.
    - `extensionPagesQuery(orgId)`: `orgConfig`.
  - `type PageState<T> = { kind: "loading" } | { kind: "ready"; data: T; refreshing: boolean } | { kind: "notFound" } | { kind: "error"; code: string; retry(): void }`.
  - `usePageQuery<T>(o: UseQueryOptions<T, ApiClientError>): PageState<T>`. A 404 maps to `notFound` even when stale data is cached, because the latest answer wins.
  - Test helpers in `test/support/query.tsx`:
    - `renderRouteWithCache(path: string, routes: Routes, opts?)`: runs the layout prefetch against `serverRoutes`, dehydrates, renders the page inside `HydrationBoundary`, and returns the server calls.
    - `renderRouteEmptyCache(path, routes, opts?)`: renders with an empty cache and `stubApi` for the browser reads.

- [ ] **Step 1:** Write failing tests:
  - `"every page.tsx under (app) and (auth) matches exactly one route entry"`: walk `apps/web/src/app/(app)` and `(auth)` for `page.tsx`, turn each directory into its pattern, and check `matchRoute` finds that pattern's entry.
  - `"static segments win"`: `matchRoute("/agents/new").entry.pattern === "/agents/new"`, and `matchRoute("/agents/a1").params.id === "a1"`.
  - `"an unknown path under (app) resolves to [...rest]"`. The entry `/[...rest]` maps to `"unknown"` in `prefetchRoute`, which leads to a 404.
  - `"usePageQuery: stale data then a 404 is notFound"`: hydrate data for `["org","o","agents","a1"]`, stub a 404 for the refetch, and expect the state to go from `ready` to `notFound`.
  - `"the layout prefetches the shell and the route in one parallel wave"`: in `app-layout.test.tsx`, a document render of `/agents` makes the `/me` read first, then readiness, groups, inbox, contributions and agents. Assert the order with the call list: everything after `/me` starts before any of them answers (a deferred stub).
  - `"a signed-out read during prefetch redirects to login with the path"`: assert `redirect` was called with `/login?next=%2Fagents`.
- [ ] **Step 2:** Run `pnpm exec vitest run apps/web/test/query-routes.test.ts apps/web/test/app-layout.test.tsx`.
  Expected: FAIL.
- [ ] **Step 3:** Implement `routes.ts`, starting with one entry per existing page: `queries: () => []` and `none: "pending migration"`. Then implement `prefetchRoute`, `usePageQuery`, the shell queries and the test helpers.
  - `(app)/layout.tsx`: `getShell()` keeps its decisions (unavailable, setup redirect) but reads through `serverQueryClient().fetchQuery(...)`. `prefetchRoute` runs in the same `Promise.all` as the shell reads after `/me`, and the children are wrapped in `<HydrationBoundary state={dehydrateFor(qc)}>`.
  - `(auth)/layout.tsx` does the same, without the shell.
  - `AppFrame` reads the shell queries with `useQuery`.
- [ ] **Step 4:** Run the tests.
  Expected: PASS. Then run `pnpm exec vitest run apps/web/test`.
  Expected: no regressions, because pages still read on the server for now.
- [ ] **Step 5:** Commit: `feat(web): route table and first-load prefetch in the layouts`.

### Task 4: Client gates, sign-out and org switch

**Files:**
- Create: `apps/web/src/lib/query/workspace.ts`, `apps/web/src/lib/query/agents.ts` (first entry:
  `agentsQuery(orgId)`, key `keys.org(orgId).agents()`, `orgConfig`; Tasks 10–11 add to the file).
- Modify:
  - `apps/web/src/components/QueryProvider.tsx` (the global `QueryCache.onError`)
  - the org switcher and sign-out callers (`components/shell/AppFrame.tsx`, `components/LeaveOrgDialog.tsx`, `components/CreateOrgDialog.tsx`, the account menu)
- Test: `apps/web/test/query-gates.test.tsx`

**Interfaces:**
- Produces:
  - `useWorkspace(opts?: { min?: "guest" | "member" | "admin"; setup?: "home" | "step" }): Workspace | { kind: "pending" }`. `Workspace` is the same union as `lib/server/session.ts`. It reads `meQuery` and `readinessQuery` from the cache. When the org is not ready and `setup` is unset, it calls `router.replace("/")` and returns `pending` until then.
  - `useAdmin(): { kind: "ok"; me: Me } | { kind: "noAccess"; need: "enterprise" }`.
  - `resetSession(qc: QueryClient, then: () => void): Promise<void>`. It runs `await qc.cancelQueries()` and `qc.clear()`, then calls `then()`.
- [ ] **Step 1:** Write failing tests:
  - `"a member below admin gets noAccess admin"`.
  - `"an org that is not ready redirects to / unless the page is a setup route"`.
  - `"a 401 auth.* on a client query redirects to /login?next=<path> and clears the cache"`: render `/agents` with an empty cache, stub `GET …/agents` → 401 `auth.required` and `POST /api/v1/auth/refresh` → 401. Expect `router.replace` to be called with `/login?next=%2Fagents`, `qc.getQueryCache().getAll()` to be empty, and no error state in the DOM at any point (check after each `await`).
  - `"org switch drops a read of the old org that answers late"`: start `agentsQuery("A")` with a deferred promise and call `resetSession`. Switch the current org to B, then resolve A's promise. `qc.getQueryData(keys.org("A").agents())` is `undefined`, and no A row is in the DOM.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Every org switch and sign-out path goes through `resetSession`. The `router.refresh()` calls in those paths stay, because the layout must decide again (spec §6).
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(web): client-side gates and session reset on org switch and sign-out`.

### Task 5: `check:web-ui` query rules (red first) with a pending ratchet

**Files:**
- Modify: `tools/checks/src/web-ui.ts`
- Create fixtures under `tools/checks/fixtures/web-ui/`:
  - `query-direct-read/`
  - `query-key-literal/`
  - `query-no-freshness/`
  - `query-page-read/`
  - `query-route-missing/`
  - `query-ok/`
  - `query-pending-stale/`
- Remove fixtures: `ssr-first-paint*`
- Test: `tools/checks/test/web-ui.test.ts`

**Interfaces:**
- Produces: `QUERY_PENDING: readonly { path: string; reason: string }[]`, a list of `app/(app)/**/page.tsx` and `view.tsx` paths not converted yet. It starts as every page except `[...rest]`. Each migration task removes its entries, and Task 17 asserts it is empty.

The rules, with their messages naming the spec section:

| Rule | Fails when |
|---|---|
| `web-query-no-direct-read` | in a `"use client"` file under `app/` or `components/`: a call of a `/lib/` value import outside a function passed as `fn` to `defineQuery` / `useAppMutation` (`fn`), or any `useLoad(` / `useServerState(` / `apiFetch(` call |
| `web-query-keys` | a `queryKey` property, or a `key:` passed to `defineQuery`, whose value is an array literal, anywhere outside `lib/query/keys.ts` (the literal `"self"` me key lives in keys.ts) |
| `web-query-freshness` | `queryOptions(` / `useQuery({` with an inline object outside `lib/query/define.ts` (all queries go through `defineQuery`, whose type requires `freshness`) |
| `web-query-page-read` | a server `page.tsx` that calls a `/lib/` loader, `read(`, `section(`, `optional(`, `workspace(` or `admin(` |
| `web-query-route-table` | a `page.tsx` whose pattern has no `ROUTES` entry, or whose entry has `none: ""` (no reason) |
| `web-query-stale-pending` | a `QUERY_PENDING` path that no longer violates (the list only shrinks) |

`web-ssr-first-paint` is removed. `web-ssr-client-page`, `web-ssr-location`, `web-ssr-view-value-import` and `web-ssr-loading-file` stay.

- [ ] **Step 1:** Add one red fixture per rule and one green fixture (`query-ok`). Write the tests `"<rule> flags its fixture"` and `"query-ok passes"` in `web-ui.test.ts`, each asserting the rule id and line.
- [ ] **Step 2:** Run `pnpm exec vitest run tools/checks/test/web-ui.test.ts`.
  Expected: the new tests FAIL.
- [ ] **Step 3:** Implement the rules. The route-table rule parses `lib/query/routes.ts` statically, reading the `pattern:` string literals. Findings under `QUERY_PENDING` paths are suppressed, the same way `SSR_PENDING` worked.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then run `pnpm check:web-ui`.
  Expected: clean, with every unconverted page covered by `QUERY_PENDING`.
- [ ] **Step 5:** Update the CI notes: the `check:web-ui` bullets in `AGENTS.md` "CI and checks" and in the comments in `.github/workflows/ci.yml`. The new rules run in full on PRs: they are cheap text and AST scans, part of `pnpm check`.
- [ ] **Step 6:** Commit: `feat(checks): web-query rules for the query cache`.

### Task 6: Skeleton primitives and the header loading state

**Files:**
- Create: `packages/design/src/display/skeleton.tsx` (export it from `display/index.ts`).
- Modify:
  - `packages/design/src/shell/page-header.tsx` (`loading`)
  - `packages/design/src/styles/display.css`
  - `docs/design/spec.md` (new §6.29 Skeleton; the §4.2 PageHeader loading state and size table)
  - `docs/design/reference/src/page-header.html` (a `page-header-loading` block)
  - `apps/web/src/app/dev/ui/...` (reference blocks)
- Test:
  - `packages/design/test/skeleton.test.tsx`
  - `packages/design/test/spec-tables.test.ts` (runs on the new tables as is)

**Interfaces:**
- Produces:
  - `SkeletonText({ width, size }: { width: "30%" | "45%" | "55%" | "70%" | "100%" | number; size?: "body" | "small" | "title" })`. It is one bar with the height of that type size's line box, the `hover` ground and radius `sm`.
  - `SkeletonBox({ part, height?, width? })`: a control-sized block, the `selected` ground.
  - `SkeletonGroup({ label, children })`: `aria-busy`, with a hidden "正在加载 / Loading" (i18n). Nested groups announce once.
  - `PageHeaderProps.loading?: { title?: boolean; actions?: number; tabs?: number }`. A title that is not known yet is a `title`-size bar of 30%. Known actions and tabs render for real. `actions` / `tabs` give the slot count when unknown.
- Reduced motion: none of these animate, in any mode (no shimmer at all, which also satisfies spec §7.1).

- [ ] **Step 1:** Write failing tests:
  - `"SkeletonText takes the line box of its type size"`: compare the measured height with the `type.<size>` line height via the tokens.
  - `"one busy announcement per group"`.
  - `"PageHeader loading keeps the actions it knows"`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/design/test/skeleton.test.tsx`.
  Expected: FAIL.
- [ ] **Step 3:** Implement. Write §6.29 with its state list (`text`, `box`, `group`) and size table, and add the `loading` state to PageHeader's state list and size table.
- [ ] **Step 4:** Run the tests and `pnpm exec vitest run packages/design/test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(design): skeleton primitives and the page header loading state`.

### Tasks 7–9: Template loading states

All three tasks follow the same flow, per template:

1. A failing render test in `packages/design/test/templates-loading.test.tsx`: `"<Template> loading draws the frame and no children"`, plus the cases listed below.
2. The `loading` prop.
3. A spec §5 state list `loading`, and a size-table row per skeleton part, with the same values as the loaded parts.
4. A `<template>-loading` block in `docs/design/reference/src/template-<name>.html`.
5. The `/dev/ui/reference/template-<name>` blocks `loading` and `default`, built from the same fixture so the boxes can be compared.
6. Add `template-<name>` to `apps/web/visual/accepted.ts`.
7. Pass `pnpm exec vitest run packages/design/test`.
8. Commit `feat(design): <template> loading state`.

Shape rule for every template (spec §7.1): every region of the loaded page keeps its box.
- Text becomes `SkeletonText`, and controls become `SkeletonBox` of their control height.
- A repeat count the page passes in is used as given. Otherwise it is the template's default, which is written in its spec section.
- A region whose content is passed in for real (`children` with data) renders for real. Only regions flagged as loading become skeletons.

**Task 7: `DetailPage`, `OverviewPage`, `InboxPage`**
- `DetailPage.loading?: { inspector?: boolean; blocks?: number }`. Header via `PageHeader.loading`, real tabs (they are static per page). The content is `blocks` card-shaped blocks (default 2), and the inspector is a skeleton only if `inspector`.
  - Extra test: `"tabs stay real while loading"`.
- `OverviewPage.loading?: { stats?: number; sections?: number }`. Defaults: stats 4, sections 2.
- `InboxPage.loading?: { rows?: number }`. The rail renders for real (filters are static), and the list has `rows` 64 px rows (default 4).

**Task 8: `FormPage` / `FormSection`, `SettingsPage`, `WizardPage`, `AuthPage`**
- `FormSection.loading?: { fields: number }`: the title and description stay real. Each field is a label `SkeletonText` 30% plus a `SkeletonBox` at the control height, in the same widths as the loaded field.
  - The page passes its static section list, so sections whose data is ready render for real.
- `FormPage.loading?: boolean`: the `ActionRow` stays with its buttons disabled.
  - Extra test: `"loading form keeps the action row with disabled buttons"`.
- `SettingsPage`: the sub-nav is always real. The content takes `FormSection` / `ListPage`-style loading from its children; no own prop beyond `loading?: { sections: { fields: number }[] }` for the common case.
- `WizardPage.loading?: { fields: number }`: the step bar is real.
- `AuthPage.loading?: { fields: number }`: the card frame and dither stay. The spec §7.1 list omits AuthPage, but its rule ("every template a page under `(auth)` uses") covers it.

**Task 9: `ConversationPage`, `TracePage`, `ListPage` check**
- `ConversationPage`:
  - `loading?: { thread?: boolean; title?: boolean; rightArea?: boolean }`.
  - The thread skeleton is three turns: a user bubble bar right-aligned at 45%, then two prose bars at 100% and 70%, all in the thread width.
  - The composer always renders for real, disabled while `thread` is loading.
  - The title bar has a title bar at 30% and real icons.
  - A right panel whose data is missing draws its own panel skeleton, which already exists in §6.16 (`loading` state); reuse it.
  - Extra test: `"composer keeps its box while the thread loads"`.
- `TracePage.loading?: { spans?: number }`: stats slots, then `spans` waterfall rows (default 6) at the row height. The detail panel is a skeleton.
- `ListPage`: check the existing `loading` against the shape rule, including the header tabs' "–" counts. Change it only if a box differs, and add a test `"list loading boxes equal loaded boxes"`. The same check runs in Task 9b.

### Task 9b: Skeleton alignment visual spec

**Files:**
- Create: `apps/web/visual/skeleton-alignment.spec.ts`.

- [ ] **Step 1:** Write the spec. For every template in a new list `LOADING_TEMPLATES` (exported from `accepted.ts`):
  1. Open `/dev/ui/reference/template-<name>`.
  2. For each `data-part` present in both the `-loading` and `-default` blocks, compare `boundingBox()` relative to the block: x, y and width within ±1 px.
  3. Height is compared for every part whose loaded height is fixed by the size table. The list `VARIABLE_HEIGHT` names the parts that are exempt (prose bodies).
  - Run it in both themes.
- [ ] **Step 2:** Run it locally against a template still missing a part (temporarily remove one part from the Detail skeleton) and see it fail. Restore, then run `pnpm --filter @capybara-hq/web visual -- skeleton-alignment`.
  Expected: PASS (layout only; no screenshot comparison here).
- [ ] **Step 3:** Add the spec to the `visual` job's list in `ci.yml` (by diff, same inputs as the other visual specs), and update the `visual` row in `AGENTS.md`.
- [ ] **Step 4:** Commit: `test(web): skeleton boxes equal the loaded page's boxes`.

### Page migration tasks (10–16): the recipe

Each migration task converts the listed pages with the same steps, and each page is its own commit:

1. **Queries:** `lib/query/<area>.ts` gets one `defineQuery` per kernel read the page makes, wrapping the existing `lib/<area>.ts` loader. Add the key builders to `keys.ts`. Freshness comes from the table in the task; anything not listed uses the spec §5 table.
2. **Route entry:** replace the page's `none: "pending migration"` with `queries(ctx)` returning the first-paint queries, i.e. what `page.tsx` reads today. These are the server reads listed in the task.
   - A read that depends on another read's answer moves into the view as a dependent `useQuery` (`enabled`), unless the task says otherwise. Examples: tool info from events, members only when an event names another account.
   - The layout then prefetches only the first wave, and the dependent read paints from the cache on the first load only if the entry's `queries` can compute it. Otherwise, add a `then(qc)` step to the entry that runs after the first wave.
3. **page.tsx:** no reads. It returns `<View params={…} />`, typed with the route params.
4. **view.tsx:**
   - Gate with `useWorkspace` / `useAdmin`, passing the same `min` / `setup` the page used.
   - Read data with `usePageQuery`, and pass the template's `loading` shape while it is `loading`.
   - `notFound` renders the same component as the segment's `not-found.tsx`.
   - `error` renders the existing error state, with `retry`.
   - Secondary sections (`section(...)` / `optional(...)` today) are their own queries with their own section states (R5: a hydrated error is not refetched on mount).
5. **Mutations:**
   - Each `apiFetch` / `lib` mutation call becomes `useAppMutation` with `invalidates` naming the keys whose answer the mutation changes.
   - Use `setQueryData` instead when the response is the new object.
   - Remove `router.refresh()` there, unless the mutation changes the layout's decisions (org, readiness, sign-in), which Task 4 already covers.
   - Remove `useServerState` / `useLoad` from the file.
6. **Polling:** replace any hand-written `setInterval` / `setTimeout` poll with `refetchInterval`, using the same period as today.
7. **Tests:** convert the page's test from `renderRoute` to `renderRouteWithCache`, and keep its assertions. Add two cases:
   - `"<page>: a first render from the hydrated cache makes no browser read"`: `stubApi` gets zero GET calls.
   - `"<page>: an empty cache shows the template's loading state, then the data"`: assert `aria-busy` is present, then the data, then `aria-busy` is absent.
   For a page with mutations, add `"<mutation> invalidates <keys>"`, asserting the refetch call.
8. Remove the page's `QUERY_PENDING` entries, then run `pnpm check:web-ui` and `pnpm exec vitest run apps/web/test/<file>`.
   Expected: both clean.

### Task 10: Shell and conversation (`/chat`, `/chat/[conversationId]`)

**Files:**
- Modify:
  - `components/shell/{nav,conversations,AppFrame}.tsx`
  - `components/conversation/{useConversation.ts,useQueue.tsx,FilePanel.tsx,RightArea.tsx,PropertiesSections.tsx,SubagentPanel.tsx,ExtensionBlocks.tsx,ComposerBar.tsx}`
  - `app/(app)/chat/**`
- Create: `lib/query/conversation.ts`
- Remove: `lib/server/conversation.ts` (its pieces become queries)
- Test:
  - `test/conversation-page.test.tsx`
  - `test/chat-panel.test.tsx`
  - `test/chat-files.test.tsx`
  - `test/composer-skills.test.tsx`
  - `test/nav.test.tsx`
  - `test/stream.test.ts`
  - new `test/conversation-cache.test.tsx`

**Interfaces:**
- Produces, in `lib/query/conversation.ts`:
  - `conversationQuery(orgId, id)`: `live`.
  - `eventsQuery(orgId, id)`: `events`, via `listAllEvents`.
  - `queueQuery`, `filesQuery`, `sandboxQuery`, `subagentsQuery`, `usageQuery`: `live`.
  - `toolInfoQuery(orgId, id, keys: string[])`: `orgConfig`, with the keys sorted in the key.
  - `invocableSkillsQuery(orgId, agentId)`, `contributionsQuery(orgId)`, `connectorsQuery(orgId)`, `attachmentLimitsQuery(orgId)`, `modelsQuery(orgId)`: all `orgConfig` (`agentsQuery` comes from Task 4). Later tasks reuse `modelsQuery` / `connectorsQuery`.
  - `appendEvents(qc, orgId, id, events: ConversationEvent[]): { added: number }`. It merges into the cached list by `seq`: no duplicates, ascending order, and the number of new events is returned.
  - `CONVERSATION_SIDE_KEYS(orgId, id)`: the keys invalidated after a catch-up that delivered events: queue, files, sandbox, subagents, usage, conversation row, and tool info prefix.
- Route entries:
  - `/chat/[conversationId]`: conversation, events, agents, models, queue, contributions, files, sandbox, connectors, limits. The `then` step computes tool info, sub-agents and usage, members, and invocable skills from the events and conversation.
  - `/chat`: agents, groups, models, limits.

Behaviour:
- `useConversation` reads `eventsQuery` and keeps `reduceChat` as a `select`-free reducer over the cached list (my call: reduce in a `useMemo` keyed by the list identity plus the delta buffer).
- The stream opens from the cached last seq. Each event goes through `appendEvents`. `event: changed` frames invalidate the matching key instead of bumping counters.
- On reopen, if the catch-up `added > 0`, invalidate `CONVERSATION_SIDE_KEYS`. Otherwise those keys follow their freshness class.
- The sidebar's groups and inbox count: on each `usePathname()` change, `qc.refetchQueries({ queryKey, stale: true, type: "active" })` (spec §6 "Persistent components"). The current per-path-change refetch in `nav.tsx:173-193` and `conversations.tsx:246` is removed.

Extra tests, beyond the recipe:
- `"appendEvents ignores seqs it already holds and keeps order"`: the cached seqs are [1,2,3] and the input is [3,2,4,6,5]. The result is [1,2,3,4,5,6] and `added === 3`. This is Review Focus 4.
- `"returning within 30 s with no new event reads only the stream"`: mount A from the cache, unmount, and mount again at fake time +10 s. The fake EventSource delivers nothing. `stubApi` calls are exactly one stream open, `…/stream?after=<last seq>`.
- `"returning with a new event refetches the side pieces"`: the catch-up delivers one event, and one GET each for queue, files, sandbox and conversation follows.
- `"a changed frame for files invalidates only files"`.
- `"sidebar refetches stale groups on path change and not fresh ones"`.

### Task 11: Home, agents, skills, channels

Pages, with the reads that become queries:

| Page | First-paint queries | Freshness |
|---|---|---|
| `/` | overview, agents, connectors, groups, inbox, members, models, skills | `orgConfig`, groups / inbox `live` |
| `/agents` | agents | `orgConfig` |
| `/agents/new` | agent form (`loadAgentForm` pieces: models, skills, connectors, purposes…) | `orgConfig` |
| `/agents/[id]` | agent, agent form pieces, channels | `orgConfig` |
| `/skills`, `/skills/[id]` | skills / skill | `orgConfig` |
| `/channels`, `/channels/new`, `/channels/[id]` | agents, channels, org extensions / channel, channel schema | `orgConfig` |

- Remove `lib/server/agent-form.ts`; its reads become `agentFormQueries(orgId)` in `lib/query/agents.ts`, returning the list of the form's queries.
- The skeleton of the agent form passes its static section list (identity, model, skills, connectors, sub-agents, channels) with each section's field count.

### Task 12: Connectors, org catalog, account

| Page | First-paint queries | Freshness |
|---|---|---|
| `/connectors`, `/connectors/[connectorId]`, `/connectors/install` | connectors / connector / catalog install | `orgConfig` |
| `/catalog`, `/catalog/[itemId]`, `/catalog/[itemId]/install` | org catalog / item / catalog install | `orgConfig` |
| `/account/connections` | connectors, connector per connection | `mine` |
| `/account/grants` | tool grants | `mine` |
| `/account/identities` | auth sources (`orgConfig`), identities (`mine`) | as given |

- Remove `lib/server/catalog.ts`.
- Polling of the install status becomes `refetchInterval`, with today's period.
- The display-name edit (account menu) uses `setQueryData(meQuery().queryKey, response)`. This is the e2e case in Task 17.

### Task 13: Settings, evals, trajectories, inbox, extension pages

| Page | First-paint queries | Freshness |
|---|---|---|
| `/settings/organization`, `/settings/sandbox` | org settings | `orgConfig` |
| `/settings/members` | members, invitations | `orgConfig` |
| `/settings/models` | models, org purposes | `orgConfig` |
| `/settings/extensions` | org extensions, org file previewers | `orgConfig` |
| `/settings/plugins` | plugin installs | `orgConfig` |
| `/settings/tokens` | service tokens | `mine` |
| `/evals`, `/evals/new` | agents, eval sets | `orgConfig` |
| `/evals/[setId]`, `/evals/[setId]/run` | eval set, agent, runs / model purposes, models | `orgConfig`; runs `live` |
| `/evals/[setId]/cases/[caseId]` | eval case, eval set, members | `orgConfig` |
| `/evals/runs/[runId]` | eval run (`live`, `refetchInterval` while running), set, result rows page | as given |
| `/trajectories` | agents, trajectories (search params in the key) | `orgConfig`; list `live` |
| `/trajectories/[conversationId]` | trajectory (`lib/server/trajectory.ts` reads), members | `live` |
| `/inbox` | inbox, skill change per item shown | `live` |
| `/p/[plugin]/[id]` | ui contributions, ui view (locale in the key) | `orgConfig`; view `live` |

- Remove `lib/server/trajectory.ts`.
- Extra test (Review Focus 5): `"trajectories: a new agent filter never shows the previous filter's rows"`. Render `?agent=a` from the cache, navigate to `?agent=b` with a deferred stub, and assert that no row of `a` is visible while `b` loads (the loading state shows).

### Task 14: Admin console

| Page | First-paint queries | Freshness |
|---|---|---|
| `/admin` | admin overview | `deployment` |
| `/admin/accounts`, `/admin/orgs` | accounts / orgs, deployment settings | `deployment` |
| `/admin/settings` | deployment settings | `deployment` |
| `/admin/models` | admin models, admin purposes | `deployment` |
| `/admin/extensions`, `/admin/extensions/[name]`, `/admin/extensions/install` | admin extensions, extension config | `deployment` |
| `/admin/catalog`, `/admin/catalog/[itemId]`, `/admin/catalog/import`, `/admin/catalog/requests` | catalog items, marketplaces, item, staged import, deployment requests | `deployment` |
| `/admin/marketplaces`, `/admin/marketplaces/entries` | marketplaces, entries | `deployment` |

- Gate with `useAdmin()`.
- The extension upgrade flow (`/admin/extensions/install?upgrade=<name>`) is covered by `e2e/admin-extensions.spec.ts` and `e2e/extension-config-form.spec.ts`; both must pass unchanged in Task 17.

### Task 15: Auth pages

| Page | First-paint queries | Freshness |
|---|---|---|
| `/login` | me (optional: signed out is a normal answer), auth sources | `mine` / `deployment` |
| `/invite/[token]` | me | `mine` |
| `/bind/[token]`, `/setup` | none: `none: "no kernel read before the form"` | — |

- `(auth)/layout.tsx` prefetches them, and the existing `login/layout.tsx` and `setup/layout.tsx` keep their own concerns.
- After a successful sign-in, call `resetSession` and then navigate, so no cache from a previous account survives.

### Task 16: Remove the old read paths

**Files:**
- Remove:
  - `lib/use-load.ts`, `lib/use-server-state.ts`
  - `read` / `section` / `optional` from `lib/server/page.ts`. Keep `currentPath`, `isSignedOut` and `isKernelUnavailable`.
  - `workspace` / `admin` from `lib/server/session.ts`, except what the layouts use.
- Modify: `tools/checks/src/web-ui.ts` (`QUERY_PENDING` must be `[]`; keep the mechanism, like `SSR_PENDING`).
- [ ] **Step 1:** Run `grep -rn "useLoad\|useServerState\|router.refresh()" apps/web/src`.
  Expected: only the `router.refresh()` calls in the paths Task 4 listed.
- [ ] **Step 2:** Run `pnpm check:web-ui`, `pnpm --filter @capybara-hq/web typecheck` and `pnpm exec vitest run apps/web/test`.
  Expected: all clean.
- [ ] **Step 3:** Commit: `refactor(web): remove the server-first read helpers`.

### Task 17: e2e, docs, changeset

**Files:**
- Create: `apps/web/e2e/query-cache.spec.ts`.
- Modify:
  - `apps/web/e2e/chat.spec.ts` (the 404 for a missing conversation becomes the not-found state with 200; the unknown route keeps its 404)
  - `apps/web/e2e/ssr.spec.ts`
  - `AGENTS.md` ("UI" rule, CI table)
  - `.agents/skills/writing-web-ui/SKILL.md`
  - `docs/superpowers/specs/2026-11-01-web-ssr-design.md` (top note)
  - the spec's status line, to "implemented"
- Create: `.changeset/web-query-cache.md` (`@capybara-hq/web`: minor).

- [ ] **Step 1:** Write the e2e cases of spec §9, counting `/api` GETs with `page.on("request")`:
  - `"back to a conversation within 30 s reads only its stream"`: the only request for A is `…/stream?after=<n>`.
  - `"after 30 s it paints at once and refreshes in the background"`: use `page.clock` to advance 31 s. A's content is visible before the first background GET answers (hold it with `page.route`).
  - `"editing my display name updates the sidebar without a reload or a second /me"`.
  - `"switching org never shows the old org"`: a MutationObserver probe, as in `ssr.spec.ts`.
  - `"a reload paints complete with no skeleton"`: there is no `[aria-busy=true]` in the first paint (check in `DOMContentLoaded`).
  - `"a client navigation to an uncached page shows the template's loading state"`: hold `GET …/agents/<id>` and assert `[aria-busy=true]` inside the FormPage.
- [ ] **Step 2:** Run `pnpm --filter @capybara-hq/web e2e`.
  Expected: every spec PASSES, including the existing ones unchanged except the 404 assertion moved in `chat.spec.ts`.
- [ ] **Step 3:** Write the docs:
  - `AGENTS.md` "UI": page = thin server `page.tsx` + client view; first load from the route prefetch, navigation from the query cache; keys, freshness and `defineQuery`; no `loading.tsx`.
  - The skill: the query layer, the recipe of Tasks 10–16 condensed, the test helpers, and the template loading props.
  - The web-SSR spec note pointing to this spec for §1.1–1.3, §9 and S1.
- [ ] **Step 4:** Run `pnpm verify`.
  Expected: every required check passes locally.
- [ ] **Step 5:** Commit: `test(web): request-counting e2e for the query cache; docs`. Push `fix/rc2-acceptance`.
- [ ] **Step 6:** Trigger `visual-update` and `reference-update` on `fix/rc2-acceptance` for the new loading-state baselines and reference PNGs (`gh workflow run visual-update.yml -f branch=fix/rc2-acceptance`, and the same for `reference-update.yml`). Review the PNGs. Then push an empty commit to rerun CI, because the bot's commit does not trigger checks.
