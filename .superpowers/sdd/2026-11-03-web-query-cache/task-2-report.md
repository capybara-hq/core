# Task 2 report
Built lib/query/{client,keys,freshness,define}.ts, lib/server/query.ts, components/QueryProvider.tsx, layout wrap, test. Dependency @tanstack/react-query 5.104.5 (newest 5.x before 2026-10-20).
RED: `pnpm exec vitest run apps/web/test/query-foundation.test.ts` failed (modules missing). GREEN: 6/6 pass; apps/web/test 77 files/1433 tests pass; web typecheck, pnpm lint, check:web-ui clean.
Decisions/concerns:
- `retryOnMount` is an observer option; a hydrated query cannot carry it (hydrate defaultOptions are QueryOptions). So makeQueryClient sets `retryOnMount: false` as a client default. Side effect: any failed query (not only hydrated) is not auto-retried on remount; retry must be explicit/invalidate.
- Client rebuild: exported `reviveDehydrated(state)` in lib/query/client.ts; HydrationBoundary must be given `state={reviveDehydrated(state)}`.
- dehydrateFor maps ApiClientError to a plain {status,code,message}; other errors stay as TanStack redacts-off raw.
- keys.* typed as { all: readonly unknown[] } so later tasks can extend.

## Fix round 1
- Removed global `retryOnMount: false`. Added module-level set in lib/query/client.ts filled by `reviveDehydrated`; exported `retryOnMountFor(queryHash): boolean` (false once per recorded hash, then true; call once per mount).
- Fixed dehydrateFor doc (no pending), split long doc line.
- Tests (QueryObserver behaviour): hydrated error not refetched on first mount; refetched on next mount; browser failure refetched on next mount; dehydrated error keeps its code.
- `pnpm exec vitest run apps/web/test/query-foundation.test.ts`: 9 passed. typecheck and lint clean.
