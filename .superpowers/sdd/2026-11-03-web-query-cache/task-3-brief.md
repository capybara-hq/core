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

