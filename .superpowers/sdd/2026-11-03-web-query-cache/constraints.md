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

## Controller rulings (binding)
- RouteEntry gains `then?(ctx: RouteCtx, qc: QueryClient): Promise<void>`, run by prefetchRoute after the first wave (for reads that depend on the first wave's answers).
- Route patterns in `lib/query/routes.ts` are string literals (the check parses them statically).
- `web-query-no-direct-read` flags calls, in `app/` and `components/`, of `src/lib` exports that perform a kernel read or write (functions whose body calls `apiFetch`, found by scanning `src/lib`), when the call is outside a `fn` passed to `defineQuery` / `useAppMutation`. Pure helpers and the SSE stream opener are allowed.
- `web-query-freshness` fails only object literals containing `queryKey` or `queryFn` outside `lib/query/define.ts`; `useQuery({ ...defined, enabled })` passes.
- `dehydrateFor` sets `shouldRedactErrors: () => false` and dehydrates an `ApiClientError` as `{ status, code, message }`.
- The Task 1 spike runs as a temporary Playwright e2e spec in the e2e harness, never committed.
