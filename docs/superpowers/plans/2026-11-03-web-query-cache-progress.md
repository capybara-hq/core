# Web query cache: execution progress (handoff)

Temporary file: the execution ledger of `docs/superpowers/plans/2026-11-03-web-query-cache.md`,
committed so the work can continue on another machine. Delete it when the plan is finished
(Task 17's docs commit or the final review).

How to resume:

1. Run `superpowers:subagent-driven-development` on the plan. Its workspace
   (`.superpowers/sdd/2026-11-03-web-query-cache/`, git-ignored) does not exist on a new machine.
   Recreate it with the skill's `sdd-workspace` script, and copy the "Ledger" section below into its
   `progress.md`. Also copy the "Binding constraints and controller rulings" section into a
   `constraints.md` next to it, and hand that file to every implementer and reviewer.
2. Tasks with a `Task <N>: complete` line are done; do not re-dispatch them. Resume at Task 11.
3. Task briefs are re-extracted from the plan with the skill's `task-brief` script. Tasks 10–15
   share the recipe section "Page migration tasks (10–16): the recipe"; prepend it to each brief.
4. Carry the "carried to Task N" notes into that task's dispatch.

## Binding constraints and controller rulings

### Global constraints (from the plan)

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

### Review focus (from the plan)

1. **Org switch while a read of the old org is in flight.** A slow `/agents` read for org A resolves after the switch to org B. It must not paint, and it must not land in B's cache. This is pinned in Task 4 (`cancelQueries` before `clear`, with a deferred-promise test).
2. **Session expires during a client navigation.** A 401 `auth.*` that survives the refresh retry redirects to `loginPathFor(<path>)` (`/login?returnTo=<path>`; the plan's `next` was wrong) and clears the cache. No error state flashes first. This is pinned in Task 4 (the global `QueryCache.onError` test).
3. **An object deleted elsewhere while it is still cached.** On return, the stale cache paints and the background refetch answers 404. The view then switches to the not-found state; it must not keep showing the deleted object. This is pinned in Task 3 (`usePageQuery` test).
4. **Duplicate or out-of-order events on stream reconnect.** A catch-up overlaps the cached events. The events list must stay unique and ordered by `seq`. This is pinned in Task 10 (`appendEvents` test).
5. **Search-param pages.** For example `/trajectories?agent=x` → `?agent=y`. Each search-param set is its own cache entry. The previous filter's rows never show under the new filter. This is pinned in Task 13 (key includes the search params; render test).

---

### Controller rulings (binding)
- RouteEntry gains `then?(ctx: RouteCtx, qc: QueryClient): Promise<void>`, run by prefetchRoute after the first wave (for reads that depend on the first wave's answers).
- Route patterns in `lib/query/routes.ts` are string literals (the check parses them statically).
- `web-query-no-direct-read` flags calls, in `app/` and `components/`, of `src/lib` exports that perform a kernel read or write (functions whose body calls `apiFetch`, found by scanning `src/lib`), when the call is outside a `fn` passed to `defineQuery` / `useAppMutation`. Pure helpers and the SSE stream opener are allowed.
- `web-query-freshness` fails only object literals containing `queryKey` or `queryFn` outside `lib/query/define.ts`; `useQuery({ ...defined, enabled })` passes.
- `dehydrateFor` sets `shouldRedactErrors: () => false` and dehydrates an `ApiClientError` as `{ status, code, message }`.
- The Task 1 spike runs as a temporary Playwright e2e spec in the e2e harness, never committed.

## Ledger

```text
# SDD ledger — plan: docs/superpowers/plans/2026-11-03-web-query-cache.md
Spec: docs/superpowers/specs/2026-11-03-web-query-cache-design.md (reachable)
Start: 10ec3ebe

## Pre-flight scan
| Pair / task | Produces vs consumes | Found |
|---|---|---|
| T2→T3 | defineQuery, keys, serverQueryClient, dehydrateFor | consistent |
| T3→T4 | meQuery, readinessQuery → useWorkspace | consistent |
| T4→T10/T11 | agentsQuery (T4) reused | consistent (fixed before commit) |
| T3→T10–15 | RouteEntry vs recipe step 2 `then(qc)` | CONFLICT: RouteEntry has no `then` |
| T3→T5 | routes.ts patterns parsed statically | needs string-literal patterns |
| T5 no-direct-read vs T10–15 views | "any /lib/ value call outside fn" | CONFLICT: flags pure helpers (timeline, time, toolKeysOf) and the SSE stream helper |
| T5 freshness vs views | `useQuery({` inline object fails | CONFLICT: `useQuery({ ...q, enabled })` is a spread of a defineQuery result |
| T2 dehydrate | errors dehydrated | TanStack ≥5.6x redacts errors by default when dehydrating (shouldRedactErrors) — must set |
| T6→T7–9 | Skeleton primitives, PageHeader.loading | consistent |
| T7–9→T9b | dev/ui `-loading` and `-default` blocks share data-parts | consistent |
| T3/T10 | AppFrame (T3) vs nav/conversations refetch (T10) | disjoint files |
| T10/T16 | lib/server/conversation.ts removed in T10; page.ts helpers in T16 | consistent |
| T1 self | spike needs a signed-in browser | no credentials for subagents |
| T5 self | removes ssr-first-paint fixtures | their tests in web-ui.test.ts must go too |
| T17 self | push + workflow_dispatch | push to fix/rc2-acceptance authorized by user; workflows are part of approved plan |
| other tasks self | tests vs code vs files | consistent |

Ruling: RouteEntry gains `then?(ctx: RouteCtx, qc: QueryClient): Promise<void>`, run by prefetchRoute after the first wave — the recipe needs it for dependent reads — cost if wrong: one extra optional field.
Ruling: route patterns in routes.ts are string literals — T5 parses them statically — cost: none.
Ruling: web-query-no-direct-read flags calls, in app/ and components/, of lib exports that perform a kernel read or write (functions whose body calls apiFetch, computed by scanning src/lib), outside a fn passed to defineQuery/useAppMutation; pure helpers and the SSE stream opener are allowed — the plan's literal rule would flag every pure helper — cost if wrong: a loader wrapped in a non-apiFetch helper escapes the rule.
Ruling: web-query-freshness fails only object literals containing queryKey or queryFn outside lib/query/define.ts; `{ ...defined, enabled }` passes — spreads keep freshness from defineQuery — cost: none.
Ruling: dehydrateFor sets shouldRedactErrors: () => false and dehydrates only ApiClientError fields {status, code, message} — needed for §3.3 — cost: none (no secrets in kernel error messages shown to users already).
Ruling: T1 spike runs as a temporary Playwright e2e spec in the e2e harness (its own kernel and accounts), not against the user's dev stack — no credentials — cost: e2e stack is a production build, same router behaviour.
Task 1: BLOCKED round 1 — e2e web cannot start beside the user's dev web in the same apps/web (next dev lock); global-setup register() fails on Node 24.11 + Playwright 1.64 (worked around temporarily, reverted)
Ruling: rerun the spike in a temporary worktree (chore/layout-spike from fix/rc2-acceptance HEAD), removed afterwards with its branch — keeps the user's dev stack up — cost: a few minutes of install
Ruling: note the global-setup register() failure for Task 17 (e2e must run there); not fixed in the spike
Task 1: complete (no commits; spike in temp worktree, removed) — dev: client nav (link clicks to /agents/<id>, /chat/<id>; router.push to /trajectories, ?agentId=A, ?agentId=B, /settings/organization) re-ran the layout 0 times; router.refresh() exactly once
Ruling: the gate passes on the dev-server result; production link prefetch (absent in next dev) is verified in Task 17 against a production build (layout renders per client navigation and hovered link must be 0) — spec §3.1 asks for client navigations; if prefetch renders the layout, the fallback is disabling link prefetch, not reading Next internal headers — cost if wrong: Task 17 finds server reads on prefetch and links need prefetch={false}
Ruling: e2e environment notes for Task 17 — e2e needs its own worktree while a dev web runs (next dev lock); global-setup register() fails on Node 24.11.0 + Playwright 1.64.1 (ERR_INVALID_RETURN_PROPERTY_VALUE), workaround NODE_OPTIONS=--conditions=@capybara-hq/source; no Playwright browsers installed locally (channel "chrome" worked) — Task 17 fixes register() properly or documents it; cost: e2e not runnable locally otherwise
Task 2: review approved (spec ✅, 0 critical/important); controller-confirmed gap: global retryOnMount:false stops a failed query refetching on the NEXT view (spec §3.3 / R5: "its retry or the next navigation reads it") → fix round 1
Task 2: minor (deferred): define.ts casts queryOptions(...) as UseQueryOptions (hides type drift)
Task 2: minor (deferred): retryOnMount test asserts a flag, not observer behaviour (superseded by fix round 1 test)
Task 2: fix round 1/5 (3 addressed, 0 open; commits 11526632..f6b2947e)
Task 2: complete (commits 10ec3ebe..f6b2947e, review clean)
Ruling: retryOnMountFor's consume-once flag is not StrictMode-safe (reactStrictMode is on; double render/effects would consume it early). Task 3 changes it to a non-consuming check: hydrated error hashes stay recorded until the first client navigation (pathname change away from the document's path) clears the set; usePageQuery passes `retryOnMount: !isHydratedError(hash)` — StrictMode-safe and still "the next navigation reads it" — cost if wrong: a hydrated error re-mounted on the same path without navigation is not refetched (retry button still works)
Task 2: minor (deferred): hydratedErrors set is module-level; reviveDehydrated must only run in the browser (server set would leak)
Task 3: NEEDS_CONTEXT (commit 5f2cde8d covers all but (auth)/layout.tsx)
Ruling: (auth) prefetch — RouteCtx.me becomes `Me | null`; the (auth) layout reads no /me itself; entries that need it (login, invite) list `maybeMeQuery()` (key keys.account("self").maybeMe(), freshness mine) whose fn resolves null on 401 auth.*; prefetchRoute takes `{ signedOutRedirect: boolean }` (true in (app), false in (auth)) — login/invite already read /me today, setup/bind read nothing, so no new reads — cost if wrong: two me keys until sign-in (cleared by resetSession)
Ruling: unknown routes — layout calls notFound() only when no entry matches; /[...rest] keeps its in-shell 404 via the catch-all page (e2e/chat.spec.ts step 7) — matches today's behaviour — cost: none
Ruling: server-side queries use retry:false (first paint not delayed by a retry); usePageQuery keeps cached data when a background refetch fails with non-404 (stale-while-error) — accepted
Ruling: return path param is `returnTo` (loginPathFor), not `next` as the plan wrote — the plan was wrong, code is the authority; later briefs/tests use returnTo
Task 3: minor (deferred): repo-wide pnpm lint fails on packages/kernel and tools/release files untouched by this branch's web work — final review to check whether earlier kernel commits on this branch caused it
Task 3: complete (commits f6b2947e..4357b25a, review clean; 7 minors)
Task 3: minor (carried to Task 4): hydrated-error set and noteClientPath run during SSR too (client components render on the server) — module state shared across requests; add isServer early returns, fix HydrateCache.tsx comment
Task 3: minor (carried to Task 4): RouteEntry.then rejecting fails the whole layout with no shell — document "then only prefetches, never throws" and catch in prefetchRoute
Task 3: minor (deferred): AppFrame.tsx:96 doc line > 100 cols
Task 3: minor (carried to Task 10): AppFrame useSection/useShellQueries keep hook-local state seeded from the queries (double state, double read on reconnect) — Task 10 makes the sections read the queries directly
Task 3: minor (carried to Task 5): AppFrame uses orgId ?? "" with enabled:false — key check may flag; prefer not building the query without an org
Task 3: minor (deferred): (app)/layout.tsx carries the route match out of a callback and matches twice
Task 3: minor (carried to Task 17): no test from real layout dehydrated state → JSON → HydrateCache → AppFrame with zero fetch; Task 17's "reload paints complete" e2e covers it
Task 3: note (carried to Task 13): hydrated-error set clears on pathname change only; search-param-only navigation keeps it (trajectories filters)
Task 4: review approved with 1 Important (late-answer test does not pin cancelQueries nor show B) → fix round 1
Task 4: minor (deferred): sign-out race — a 401 refetch between logout() and resetSession lets SessionGuard replace to /login?returnTo=<page>, racing navigateBrowser("/login")
Task 4: minor (deferred): no test that onLogout/switchOrg/DeleteOrg go through resetSession (cache cleared)
Task 4: minor (deferred): useWorkspace/useAdmin unused until migrations; stray `void pathname;` in query-gates.test.tsx:916
Task 4: minor (deferred): reviveDehydrated doc line over-long; empty catch in prefetchRoute's then (no log)
Task 4: note: useAdmin also returns {kind:"pending"} while /me not cached — accepted (needed before me is cached)
Task 4: fix round 1/5 (1 addressed, 0 open; commits 38f75303..e5b9861d)
Task 4: complete (commits 4357b25a..e5b9861d, review clean)
Task 5: complete (commits e5b9861d..418e1810, review clean; QUERY_PENDING 126 entries: T10 25, T11 17, T12 17, T13 33, T14 26, T15 8)
Task 5: minor (deferred): page-read misses namespace imports of lib/server/*; no-direct-read misses readers passed by reference outside fn (onClick={remove}); undocumented
Task 5: minor (deferred): any web-query-* finding keeps a pending entry alive and silences other rules on that file (mirrors SSR_PENDING)
Task 5: note for migrations: write useAppMutation fn inline or pass the lib function by reference (a same-file const wrapper is flagged); remove QUERY_PENDING entries in the same commit as a file deletion
Ruling: visual/fidelity specs are run once for Tasks 6–9 in Task 9b, in a temporary worktree (a production next build in this worktree would collide with the user's dev web), with Chrome via channel "chrome" — cost if wrong: size-table rows of Tasks 6–9 stay unmeasured until 9b
Task 6: review Needs fixes — Important: (1) accidental §6.16.12 Question block role group→status edit in spec.md; (2) SkeletonText look differs from existing bars (plan text said line-box high on hover; controller said reuse §6.6/§6.13 look)
Ruling: SkeletonText = a slot exactly one line box of its type size high (keeps layout, Q6) holding a bar in the existing §6.6/§6.13 look (`space.3` high, `color.selected`, radius `sm`), vertically centred; SkeletonBox keeps control-height boxes on `selected` (controls keep their boxes, spec §7.1) — plan text and controller instruction both satisfied: no layout shift and one bar look — cost if wrong: bars thinner than the old hover rows on ListPage records (Task 9 checks ListPage)
Task 6: confirmed gap (Q6 no layout shift): below 640 px loaded actions/tabs are 40 px, placeholders stay control.default → in fix round 1
Task 6: minor (deferred): empty <h1> possible when loading without loading.title and title=""; standalone loading PageHeader has no live region; display:contents on role=status; title bar baseline vs h1 baseline unmeasured; group size rows duplicate text/box rows
Task 6: fix round 1/5 (3 addressed, 0 open; commits b13cbf8b..b94bcdd6)
Task 6: complete (commits 418e1810..b94bcdd6, review clean)
Task 6: minor (carried to Task 9): old Skeleton({rows}) and ObjectList/PendingState 12 px hover bars not reconciled with the one bar look
Task 6: minor (deferred): skeleton.test.tsx slices shell.css by first selector occurrence (brittle)
Task 7: review Needs fixes — Important: (1) Inbox loading rows outside the bordered ObjectList box, stray border-top after filters; (2) Detail inspector placeholder taller than loaded KeyValue (group title + gaps)
Ruling: InboxPage.loading takes `list?: "objects" | "records"` (default "objects"): "records" draws the DataTable loading state in the caller's table shape (rowHeight, framed) so the real /inbox and /admin/catalog/requests (DataTable dense, framed={false}) keep their box — load-bearing for Task 13/14 — cost if wrong: one more prop
Ruling: fix round also takes review minors 1 (/dev/ui -loading header must match the reference: loading.title true) and 2 (list required unless loading) — they are one-liners in the same files
Task 7: minor (deferred): skeleton.tsx JSDoc over-long line; no narrow or loading+empty template tests
Task 7: fix round 1/5 (5 addressed, 1 new open — double role=status in records loading; commits d3511d9b..320d6502)
Task 7: fix round 2/5 (3 addressed, 0 open; commits 320d6502..cd126041)
Task 7: complete (commits b94bcdd6..cd126041, review clean)
Task 7: minor (deferred): InboxPage doc comment line over-long (inbox-page.tsx:89); reference HTML has no records/filters blocks
Task 8: review Needs fixes — Important: flush FormSection (SwitchList) loads on the padded card (box change) → fix round 1
Task 8: minor (deferred): reference auth HTML dither columns empty vs real Dither in /dev/ui; settings-nav 200 / auth-card 400 literals without token paths (follows precedent); SkeletonText doc comment over-long; wizard Card title slot vs Card head line box unmeasured (no size row)
Task 8: fix round 1/5 (1 addressed, 0 open; commits 0c2bc36b..4c8cc17f)
Task 8: complete (commits cd126041..4c8cc17f, review clean)
Task 8: minor (deferred): 32x20 switch placeholder literal unasserted and not a token; r-switch-* reference classes unconfirmed in reference.css
Task 9: review Needs fixes — Critical: ListPage (and TracePage) swap SkeletonGroup vs fragment on loading toggle → whole page remounts, marketplace entries search loses focus while typing. Important: composer inert while thread loads looks enabled and drops focus; loading properties panel draws a Files section the loaded panel may not have
Ruling: while the thread loads, the composer stays fully mounted and focusable: the textarea stays editable (draft is local), only send is disabled through the composer's own disabled-send state; no `inert` — keeps focus and the box; Q6's "disabled" read as "cannot send" — cost if wrong: a person can type before the history paints (harmless; send waits)
Ruling: fix round also takes minor 1 — the loading right panel takes its real title from the caller (the open panel's id/title is known from the URL hash) and has no dead fullscreen button
Task 9: minor (deferred): page-level aria-busy wraps live interactive content (conversation title-only loading); list loading test compares only children[0]; skel/skelText helpers duplicated in reference sources
Task 9: fix round 1/5 (4 addressed, 0 open; commits a7bbb8ca..1ddfa071)
Task 9: complete (commits 4c8cc17f..1ddfa071, review clean)
Task 9: note (carried to Task 10): ConversationView/ComposerBar must pass the function form of ConversationPage.composer ({ sendDisabled }) — a plain node is never send-disabled while the thread loads (undocumented)
Task 9: minor (deferred): SkeletonGroup active=false leaves a display:contents wrapper div in the loaded DOM
Task 9b: review Needs fixes — Important: (1) one-way comparison (a region missing while loading passes); (2) VARIABLE_HEIGHT too wide (form-section-head, form-card) and y dropped for #1+ of a variable part
Task 9b: minor (deferred): IGNORED_PARTS drops icon/icon-button wholesale; page-header-description width fully exempt (no upper bound); conversation pair compares file-panel vs loading scenario
Task 9b: note: sidebar fidelity fails at 10ec3ebe too (force selector at=inbox matches nothing) — pre-existing, final review to triage
Task 9b: fix round 1/5 (2 addressed partially, 1 addressed; open: placeholder counts unchecked for fields/action slots/switch rows, broad button exemption; form-section-head exempt on a stretch reason; loading card 147 px not in a size row; commits f29c1409..014bbc3d)
Task 9b: fix round 2/5 (2 addressed, 1 open — field placeholders count-only hide a real Q6 shift: LoadingFields draws fixed 52 px vs loaded 72/74/134; commits 014bbc3d..c5ad15b2)
Ruling: FormSection/WizardPage/AuthPage `loading.fields: number | FieldShape[]`, FieldShape = { control?: "input"|"textarea"|"select"|"segmented"|…(the field controls that exist); help?: boolean; rows?: number; pair?: boolean }; LoadingFields renders the loaded field's own markup per shape; pages pass their static field layout (spec §7.1); field leaves COUNT_ONLY, form-section/form-card leave VARIABLE_HEIGHT once the fixtures pass shapes — load-bearing for Tasks 11–15 forms — cost if wrong: a wider prop
Task 9b: minor (deferred): `card > skeleton-box` → button alias is broad; FOLLOWS_HEIGHT compares the head with its own placeholder section only; no red runs for FOLLOWS_HEIGHT/bubble right edge/card alias
Task 9b: fix round 3/5 (1 addressed, 0 open; commits c5ad15b2..2bfe1b22)
Task 9b: complete (commits 1ddfa071..2bfe1b22, review clean)
Task 9b: note (carried to Tasks 11–15): pages pass static FieldShape[] (AgentForm instructions textarea rows: 6; Checkbox/Stack groups are not Fields — count or leave out); help is one fixed small line (wrapping help/error won't match); lone trailing pair renders full width
Task 10: review Needs fixes — Important: new conversation's title can stay "untitled" until the next view (changed:title lost between row GET and stream open; deleted test guarded it; e2e conversation-capabilities waits for the title on the same page)
Ruling: /chat puts agents, models, limits in `then` after readiness (setup reads no agents; first paint still complete) — accepted
Ruling: CONVERSATION_SIDE_KEYS includes the extension views (spec §6 lists them) — accepted
Ruling: catch-up heuristic "first new event after each open" — accepted as bounded (once per open); exclude seqs already appended by POST/merge is in fix round 1
Task 10: controller-confirmed gap (R1): router.refresh() (ErrorFrame retry, session.reload) re-hydrates eventsQuery and, if the server snapshot's dataUpdatedAt wins, replaces stream-appended events → in fix round 1
Task 10: minor (deferred): useInvalidateOn double subagents/usage GET on empty-cache navigation; uiViewQuery comment vs live freshness; ExtensionViewTab setQueryData in a useState initializer (Task 13 removes); signingOut module flag never reset; non-ApiClientError now fails the layout (above the shell); global sync notify in tests (no stream test on the default scheduler); NewConversation recent agent reads full default groups; tool info refetches all keys per new key; pending ApprovalCard/question cards still read in the browser on first paint (pre-existing)
Task 10: fix round 1/5 (3 addressed, 0 open; commits 26b94d78..3d705ee8)
Task 10: complete (commits 2bfe1b22..3d705ee8, review clean)
Task 10: minor (deferred): a send right after an away-return ends catch-up early (side keys of the away period not refreshed); deliveredOf cache subscription never unsubscribed (lives with the QueryClient)
```
