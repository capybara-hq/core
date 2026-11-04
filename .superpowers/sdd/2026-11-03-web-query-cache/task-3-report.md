# Task 3 report: route table, layout prefetch, page states

Status: DONE (see the addendum: Q1 and Q2 resolved by controller rulings).
The (auth) layout needs a decision (Q1 below). There is also one deviation to confirm (Q2).

## Built

- `src/lib/query/routes.ts`: `RouteCtx`, `RouteEntry` (with `then?`), `ROUTES` and `UNKNOWN_ROUTE`.
  There is one entry per `page.tsx` under `(app)` and `(auth)`. That is **56** pages, not the 54
  the ruling says (52 under (app) including `[...rest]`, 4 under (auth)). Every entry has
  `queries: () => []` and `none: "pending migration"`, except `/[...rest]`, which has
  `none: "unknown route: 404"`. Patterns and `none` are string literals.
  `matchRoute(path, routes = ROUTES)` ranks segments static > `[param]` > `[...rest]`, from the
  left, and decodes params. The optional table argument exists only so a test can swap an entry.
- `src/lib/query/keys.ts`: area builders `account(id).me()` and `org(id).readiness()`,
  `.conversationGroups(view)`, `.inboxCount()`, `.extensionPages()`. The `"self"` exception is
  documented in the file.
- `src/lib/query/shell.ts`: `meQuery` (mine), `readinessQuery` (orgConfig),
  `conversationGroupsQuery(orgId, view = "default")` (live), `inboxCountQuery` (live, `{count, more}`)
  and `extensionPagesQuery` (orgConfig, `place: "page"` only).
- `src/lib/query/page-query.ts`: `PageState<T>` and `usePageQuery`.
  - A 404 is `notFound`, even when data is cached.
  - With data it is `ready` (`refreshing` = `isFetching`).
  - Another failure without data is `error`, carrying `code` and `retry` (which refetches).
  - Otherwise it is `loading`.
  - It passes `retryOnMount: retryOnMountOf(queryKey)`.
- `src/lib/query/client.ts` (ruling 2): `retryOnMountFor` is replaced by `isHydratedError(hash)`
  (non-consuming), `retryOnMountOf(key)` and `noteClientPath(pathname)`.
  - The first call to `noteClientPath` records the document path. A different path clears the set.
  - `QueryProvider` calls it during render, not in an effect. The new page's observers compute
    `retryOnMount` while they render, so the clear must have happened already. A parent renders
    before its children, and calling it again with the same path does nothing.
- `src/components/HydrateCache.tsx` (new, client component): `HydrationBoundary` with
  `useMemo(() => reviveDehydrated(state))`, so the revive runs only in the browser.
- `src/lib/server/query.ts`: `prefetchRoute(qc, path, session)`.
  - It returns `"unknown"` when nothing matches, or when the match is `[...rest]`.
  - It runs every query through `qc.prefetchQuery` in parallel, then runs `then`.
  - If any cached query failed with `isSignedOut`, it calls `redirect(loginPathFor(path))`.
- `src/lib/server/session.ts`: `getShell(qc = serverQueryClient(), alongside?)`.
  - It reads `/me` through `read(qc.fetchQuery(meQuery()))`.
  - It then starts `alongside` (the route prefetch) in the same `Promise.all` as readiness, groups,
    inbox and contributions.
  - Outcomes are unchanged: the header says unavailable / the kernel is unreachable →
    `unavailable`; a signed-out read → redirect; readiness failing → throw; a failed section →
    `null`. The failed query stays in `qc` and is dehydrated.
  - `getSession`, `orgReadiness`, `workspace()` and `admin()` are unchanged. `/me` is still one
    HTTP read per request through `cachedGet`.
- `src/app/(app)/layout.tsx`: takes one `qc`, then `getShell(qc, s => prefetchRoute(qc, path, s))`.
  The KernelStarting frame and the setup redirect are kept. The result is
  `<HydrateCache state={dehydrateFor(qc)}><AppFrame version/></HydrateCache>`.
- `src/components/shell/AppFrame.tsx`: `AppFrame({ version, children })` reads the shell queries
  with `useQuery`, and the existing frame body is now `ShellFrame`.
  - Each section passes its data to its existing hook's `initial`: `null` when the query failed,
    omitted when nothing is cached. The live polls and merges therefore behave as before.
  - When `router.refresh()` hydrates new data, the hooks get a new `initial` and merge it, as they
    did with new props.
  - Without `me` in the cache it renders nothing. That never happens on a document load.
- `test/support/shell.tsx`: `frameElement` / `renderFrame` keep their signatures. They now seed a
  query client from `ShellData` through `hydrate(reviveDehydrated(...))`, where a `null` section
  becomes a failed query with 500 `internal`. `update(next)` hydrates a newer state into the same
  client. All existing frame tests pass unchanged.
- `test/support/query.tsx`:
  - `renderRouteWithCache(path, routes, opts)`: `/me`, `prefetchRoute` and the page run against
    `serverRoutes`. The cache is dehydrated through JSON, and the page is rendered inside
    `HydrateCache`. It returns the server calls and the client.
  - `renderRouteEmptyCache(path, routes, opts)`: an empty cache, with `stubApi` for the browser.
    A page that is not migrated still gets its server reads from the same routes.
  - Both load the page through `matchRoute` plus a dynamic import of
    `app/(app|auth)/<pattern>/page.tsx`.

## Decisions taken (please confirm)

1. **No retries for server reads.** `getShell` and `prefetchRoute` pass `retry: false`.
   `fetchQuery` inherits the client's retry function, so a 5xx or network error would otherwise
   wait about 1 s before the first paint, and `getShell` would read twice. That would change its
   "exact outcomes". This complies with the "at most 1" rule.
2. **Background refetch failure in `usePageQuery`.** When the refetch fails with anything other
   than a 404 and data is cached, the state stays `ready` with the stale data. The brief does not
   cover this case.
3. **Signed-out check scope.** `prefetchRoute` checks every query in the cache for a signed-out
   error, not only the route's own queries. A signed-out shell read redirects to the same place
   anyway.
4. **Disabled shell queries without an org.** `AppFrame` builds the section queries with
   `orgId ?? ""` and `enabled: false`. Task 5's key check might flag the `""`.

## Questions

- **Q1 ((auth) layout, ruling 6).** `prefetchRoute` requires `session: { me: Me; orgId }` and
  `RouteCtx.me: Me`. The (auth) pages (login, setup, invite, bind) are public, so a visitor has no
  `me`. Reading `/me` in the (auth) layout would add a kernel read to every login and setup load
  that is not there today (a 401 for a signed-out visitor). I left the layout out. Options:
  - (a) `RouteCtx.me: Me | null` for every entry.
  - (b) A separate public context or prefetch for (auth) entries, without `me`.
  - (c) Read `/me` optionally in the (auth) layout and prefetch only when signed in.

  All four (auth) entries prefetch nothing today, so any of these is a small change.
- **Q2 (notFound).** The brief says the layout calls `notFound()` for `"unknown"`. A `notFound()`
  thrown in `(app)/layout.tsx` is caught above the layout, so the 404 renders without the App
  Shell. That would break `e2e/chat.spec.ts` step 7, which expects HTTP 404, `StatusPage` 404 and
  the main navigation for `/nope`.

  What I did instead: the layout calls `notFound()` only when `matchRoute` finds no entry at all,
  which cannot happen under (app). For `[...rest]` it renders, and the catch-all page throws
  `notFound()` itself, which keeps the 404 inside the shell. `prefetchRoute` still returns
  `"unknown"` for both.

## TDD evidence

RED for `query-routes.test.ts`, written before the implementation:
```
$ pnpm exec vitest run apps/web/test/query-routes.test.ts
  import { usePageQuery } from "../src/lib/query/page-query";  (module not found)
 Test Files  1 failed (1)   Tests  no tests
```
RED for the new layout tests. The current tests were run against the HEAD `(app)/layout.tsx` and
`session.ts`, which were restored afterwards:
```
$ pnpm exec vitest run apps/web/test/app-layout.test.tsx
 × the layout prefetches the shell and the route in one parallel wave
 × a signed-out read during prefetch redirects to login with the path
 × a failed shell section is dehydrated with its code; the page still renders
 Tests  3 failed | 4 passed (7)
```
GREEN:
```
$ pnpm exec vitest run apps/web/test/query-routes.test.ts apps/web/test/app-layout.test.tsx apps/web/test/query-foundation.test.ts
 Tests  all passed (9 in app-layout, 5 in query-routes, 11 in query-foundation)
$ pnpm exec vitest run apps/web/test
 Test Files  78 passed (78)   Tests  1449 passed (1449)     (was 77 / 1433)
$ pnpm --filter @capybara-hq/web typecheck   -> clean
$ pnpm exec biome check apps/web             -> clean
$ pnpm check:web-ui                          -> Web UI rules check passed
```
`pnpm lint` (the whole repo) reports errors in files this diff does not touch, under
`packages/kernel/test/*`, `create-zod-dto.ts` and `tools/release/test/workflow.test.ts`.

Test notes:
- `query-routes.test.ts` and `query-foundation.test.ts` carry `// @vitest-environment jsdom`: as
  `.ts` files they would otherwise run in node, and they render hooks.
- The signed-out test asserts `/login?returnTo=%2Fagents`, which is what `loginPathFor` produces.
  The brief wrote `?next=`.
- The parallel-wave and signed-out tests mock the routes module so that `/agents` has an agents
  query. ROUTES itself keeps `/agents` pending, as ruling 5 requires.

New tests:
- query-routes: every page matches exactly one entry and vice versa; static segments win; an
  unknown path → `[...rest]` → `"unknown"`; `usePageQuery` goes from stale data to a 404 →
  `notFound`; `usePageQuery` goes loading → error with code → retry → ready.
- query-foundation (ruling 2):
  - Neither a first mount nor a same-path re-mount refetches.
  - After a path change, a mount refetches.
  - In StrictMode, `renderHook` makes no refetch.
- app-layout:
  - One parallel wave, using a deferred gate: `/me` first, then the other 5 start before any
    answers; the dehydrated keys are checked.
  - A signed-out prefetch redirects.
  - A failed section and a 404 for the page's object are dehydrated with their codes.
  - An unknown path renders.
  - An unavailable kernel gives KernelStarting.
  - Both route helpers are covered.

## Files

Created:
- apps/web/src/lib/query/routes.ts
- apps/web/src/lib/query/page-query.ts
- apps/web/src/lib/query/shell.ts
- apps/web/src/components/HydrateCache.tsx
- apps/web/test/query-routes.test.ts
- apps/web/test/support/query.tsx

Modified:
- apps/web/src/lib/query/keys.ts
- apps/web/src/lib/query/client.ts
- apps/web/src/components/QueryProvider.tsx
- apps/web/src/lib/server/query.ts
- apps/web/src/lib/server/session.ts
- apps/web/src/app/(app)/layout.tsx
- apps/web/src/components/shell/AppFrame.tsx
- apps/web/test/support/shell.tsx
- apps/web/test/app-layout.test.tsx
- apps/web/test/query-foundation.test.ts

Not created: apps/web/src/app/(auth)/layout.tsx (Q1).

## Self-review / concerns

- In tests, `serverQueryClient()` is not memoized because React `cache` is a no-op outside RSC. The
  layout therefore creates `qc` once and passes it to `getShell` and `prefetchRoute`. In production
  React `cache` returns the same client anyway.
- `RouteEntry.queries` returns `UseQueryOptions<unknown, ApiClientError>[]`. A typed `defineQuery<T>`
  is not assignable to that without `defineQuery<unknown>` or a cast, because of variance. Later
  tasks will run into this. Loosening the type may be worth considering.
- A failed section that a `router.refresh()` dehydrates does not replace cached success data:
  TanStack's hydrate compares `dataUpdatedAt`. The sidebar keeps its rows, which is close to
  today's behaviour (the hook kept loaded rows for the same org).

## Addendum: controller rulings applied (commit 4357b25a)

Q1 was resolved with option (a), refined. Q2 was confirmed as built. `retry: false`, keeping stale
data on a failed refetch, the 56 pages and `returnTo` were all accepted.

- `RouteCtx.me` is now `Me | null`.
- `keys.account("self").maybeMe()` and `keys.deployment().authSources()` are new keys.
- `maybeMeQuery()` is in `lib/query/shell.ts`, with freshness `mine`. It resolves to `null` on a
  401 `auth.*` and throws on anything else.
- `authSourcesQuery()` is in the new file `lib/query/auth.ts`, with freshness `deployment`. Its
  data is `sources`, the same thing the login page reads today.
- Route entries:
  - `/login` lists `[authSourcesQuery(), maybeMeQuery()]`, the same two reads its `page.tsx` makes.
  - `/invite/[token]` lists `[maybeMeQuery()]`.
  - `/setup` and `/bind/[token]` stay with no queries.
  - Typed queries are widened with a small `q()` cast in `routes.ts`, because of the variance
    concern noted above.
- `prefetchRoute(qc, path, session, opts = { signedOutRedirect: true })`. The `(auth)` layout
  passes `false`.
- New file `apps/web/src/app/(auth)/layout.tsx`. It runs `prefetchRoute` with
  `{ me: null, orgId: null }` and wraps the page in `<HydrateCache>`. It has no shell and reads no
  `/me` of its own. It calls `notFound()` only when no route matches. `login/layout.tsx` and
  `setup/layout.tsx` are unchanged.
- New test file `apps/web/test/auth-layout.test.tsx`:
  - A `/login` render prefetches the auth sources and maybeMe, and a 401 `/me` does not redirect
    (maybeMe is `null`).
  - When signed in, maybeMe is the account.
  - A 500 from `/me` is dehydrated as an error and does not redirect.
  - `/setup` and `/bind` read nothing.

RED: run against the HEAD `routes.ts`, the new tests fail: 3 failed, 1 passed (4). The routes file
was then restored.

GREEN:
```
$ pnpm exec vitest run apps/web/test/query-routes.test.ts apps/web/test/app-layout.test.tsx \
    apps/web/test/query-foundation.test.ts apps/web/test/auth-layout.test.tsx
 Test Files  4 passed (4)   Tests  28 passed (28)
$ pnpm exec vitest run apps/web/test
 Test Files  79 passed (79)   Tests  1453 passed (1453)
web typecheck: clean; biome check apps/web: clean; pnpm check:web-ui: passed
```
