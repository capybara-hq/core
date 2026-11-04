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

