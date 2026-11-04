# Task 5 report: check:web-ui query rules

Status: DONE (commit 418e1810, not pushed).

## Rules built (tools/checks/src/web-ui.ts)
- web-query-no-direct-read: `kernelReaders()` scans `src/lib/**` (not `server`, `query`, tests) for exported
  functions whose body (or a same-file function it calls) calls `apiFetch`. Flags calls of those (named or
  namespace imports, `@/` and relative specs resolved) in `"use client"` files under `app/` and in ALL files
  under `components/`, outside the `fn` of `defineQuery` / `useAppMutation`; flags `useLoad(` /
  `useServerState(` / `apiFetch(` anywhere there. Mutations in event handlers are flagged.
  `// query-exempt: <reason>` mirrors `ssr-exempt` (empty reason fails).
- web-query-keys: array literal (through `as const` etc.) as `queryKey` property or as `key:` of `defineQuery`,
  outside `lib/query/keys.ts`.
- web-query-freshness: object literal with `queryKey` / `queryFn` outside `lib/query/define.ts`. Refinement:
  the argument of `invalidateQueries` / `cancelQueries` / `removeQueries` / `resetQueries` / `refetchQueries` /
  `isFetching` / `getQueriesData` / `setQueriesData` is a filter, not a definition, and is exempt.
  `useQuery({ ...defined, enabled })` passes.
- web-query-page-read: server page.tsx under (app)/(auth) calling a kernel-reading lib export or any value
  imported from `lib/server/*` except pure helpers (isKernelUnavailable, isSignedOut, currentPath, PATH_HEADER,
  dehydrateFor, prefetchRoute, serverQueryClient). This covers read/section/optional/workspace/admin.
- web-query-route-table: parses `lib/query/routes.ts` `pattern:` literals; every page needs an entry, `none: ""`
  fails. Skipped when routes.ts is absent (older fixtures have none).
- web-query-stale-pending + `QUERY_PENDING` (ratchet, 4th param of `checkWebUi`, mirrors `SSR_PENDING`).
- web-ssr-first-paint, its helpers (`libLoaders`, `localFunctions`, `hasInitial`) and 4 fixtures removed.

## TDD
RED: `pnpm exec vitest run tools/checks/test/web-ui.test.ts` -> `Tests 12 failed | 45 passed (57)` (new rule
tests, `QUERY_PENDING is not iterable`).
GREEN after implementation: `Tests 57 passed (57)`.
Fixtures: query-direct-read, query-key-literal, query-no-freshness, query-page-read, query-route-missing,
query-ok (incl. a query-exempt line), query-pending-stale.

## Verification
- `pnpm check:web-ui`: "Web UI rules check passed" (before QUERY_PENDING: 237 page-read + 194 no-direct-read
  findings across 126 files; no keys / freshness / route-table findings).
- `pnpm check`: all checks passed. `pnpm exec vitest run tools/checks`: 21 files, 248 tests pass.
- `pnpm exec biome check tools/checks apps/web`: clean. `tsc -p tools/checks --noEmit`: clean.

## QUERY_PENDING: 126 entries
Task 10: 25, Task 11: 17, Task 12: 17, Task 13: 33, Task 14: 26, Task 15: 8.
Components assigned to the lowest task among their importers (iterated). Reason format
"pending migration: Task N"; a test asserts each reason names a task.
AppFrame.tsx (Task 10): flagged only for direct `setCurrentOrg` / `logout`; the `orgId ?? ""` shell queries
(`enabled: false`) are NOT flagged by any rule (they go through defineQuery spreads), so no rule was loosened;
its reason still names Task 10.

## Files
tools/checks/src/web-ui.ts, tools/checks/test/web-ui.test.ts, tools/checks/fixtures/web-ui/query-*,
AGENTS.md (CI and checks: new bullet; first-paint wording removed from the SSR bullet),
.github/workflows/ci.yml (check list comment).

## Concerns
- A lib function passed by reference (`onClick={deleteThing}`) is not a call and is not caught; only calls are.
- Readers are detected one level of same-file indirection only; a lib function that calls another lib file's
  reader without touching apiFetch itself is missed.
- `components/` is scanned regardless of "use client" (hooks like useConversation.ts have no directive).
- AGENTS.md line 74 and `.agents/skills/writing-web-ui/SKILL.md` (lines ~129-140, "web-ssr-first-paint",
  ssr-exempt for live loads) still describe the old first-paint convention; left for the docs task.
