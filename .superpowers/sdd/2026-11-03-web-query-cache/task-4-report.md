# Task 4 report: client gates, sign-out and org switch

Commit: 38f75303 feat(web): client-side gates and session reset on org switch and sign-out

## Built
- `lib/signed-out.ts`: shared `isSignedOut` (401 + `auth.*`); `lib/server/page.ts` re-exports it, `lib/server/query.ts` imports it from the shared module.
- `lib/query/workspace.ts` (use client): `useWorkspace`, `useAdmin`, `resetSession(qc, then)` (`await cancelQueries(); clear(); then()`, no await between clear and then).
- `lib/query/agents.ts`: `agentsQuery(orgId)`, key `keys.org(orgId).agents()` (new key), `orgConfig`.
- `components/SessionGuard.tsx`, mounted in `QueryProvider`: subscribes to the query cache; on an error event that is `isSignedOut`, hides the children (no error flash), then `resetSession(qc, () => router.replace(loginPathFor(path)))`. Uses `returnTo` via `loginPathFor` (ruling 1).
- Org switch and sign-out paths now go through `resetSession` before the existing mechanism, which is a full document navigation (`navigateBrowser`), not `router.refresh()`: AppFrame `openHome` (switchOrg, CreateOrgDialog and OrgChooser via `switchOrg`, LeaveOrgDialog via `onLeftOrg`), switchOrg's 401 path, `onLogout`, the cross-tab signed-out sync, and org deletion in `settings/organization/view.tsx` (uses `browserQueryClient()` because its tests render without a provider). LeaveOrgDialog and CreateOrgDialog needed no change themselves. `reload()` (`router.refresh()`) is untouched.
- Ruling 3a: `reviveDehydrated` recording and `noteClientPath` are no-ops when `typeof window === "undefined"`; HydrateCache comment fixed.
- Ruling 3b: `prefetchRoute` catches a rejecting `entry.then`, still runs the signed-out check; `RouteEntry.then` documented.

## TDD
- RED: `pnpm exec vitest run apps/web/test/query-gates.test.tsx` failed to import (modules missing): "Test Files 1 failed, no tests".
- GREEN: 11 passed. Minor-fix tests were run RED by stashing `server/query.ts` and `query/client.ts`: 3 failed ("recording is a no-op when run as the server", 2x "prefetchRoute's then"); with the fix 18 passed.
- Final: `pnpm exec vitest run apps/web/test` 80 files / 1467 tests passed; typecheck, `biome check apps/web`, `check:web-ui` clean.

## Notes / concerns
- `useAdmin` also returns `{ kind: "pending" }` while `/me` is not cached (the brief's type had only ok / noAccess); `useWorkspace` throws a readiness error other than signed-out (mirrors the server gate throwing to error.tsx).
- The late-read test passes even without `cancelQueries` (`clear()` destroys the query too); cancel is kept as the brief requires.
- `resetSession` is async now, so navigation happens one microtask later; `shell-ssr.test.tsx` cross-tab test was changed to `waitFor`. After `clear()` mounted observers did not re-render (frame stayed mounted in tests), so nothing repaints before the navigation.
- No test uses the real `/agents` page for the 401 case (it is not migrated; its server read would redirect); a probe component with `agentsQuery` is used.

## Fix round 1
- `defineQuery`'s `fn` now takes `{ signal }` (TanStack's query context; existing `() =>` loaders still fit).
- The late-answer test now uses probe reads defined with `defineQuery`: asserts the A read's signal is aborted when `qc.clear` runs (cancel before clear), mounts a B component with its own deferred read, resolves A late, checks via MutationObserver that "Alpha-row" never appears, that the cache holds only B's key, and that B's data paints.
- RED with `await qc.cancelQueries()` removed: `1 failed | 10 passed`, "expected false to be true" (abortedAtClear). GREEN restored: 11 passed. Full apps/web/test: all pass; typecheck and biome clean.
