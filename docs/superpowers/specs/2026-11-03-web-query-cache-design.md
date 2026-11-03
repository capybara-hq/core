# Web data through TanStack Query: server render once, then a client cache

Status: draft for review (2026-11-03)
Amends: `2026-11-01-web-ssr-design.md` (§1 principles 1–3, §9 checks, decision S1)

## 0. Why

During rc2 acceptance the web app felt slow on every page switch. Measured against a kernel whose
PostgreSQL and Redis are 37–120 ms away (a VPN), a conversation page took 2.3–3.5 s, `/agents`
1.2–1.5 s, `/admin/extensions` 3.8 s. The time is all in the server render: under the web-SSR
design every client navigation re-runs the page's server component, which reads everything again
from the kernel (`cache: "no-store"`) in up to four serial stages (`/me` → readiness → the page's
first batch → its second batch), and nothing is shown until the last one answers. Some data is also
read twice: the sidebar re-reads the conversation groups and the inbox count in the browser on every
path change, on top of the server shell (30 and 26 reads against 8 page loads in one sample).

The user's goal (2026-11-03): **what I see is current, but what has not changed is not requested
again.** Personal information, for example, changes only when I edit it or reload the page.

## 1. Decisions taken with the user

| # | Decision | Source |
|---|---|---|
| Q1 | Every network read of the web app goes through TanStack Query (`@tanstack/react-query` v5) | user 2026-11-03 |
| Q2 | Only the first load of a page (a document request: opening a URL, a reload) is rendered on the server with its data; later navigations inside the app are client-side and read from the query cache | user 2026-11-03 |
| Q3 | Data someone else or the system changes (an agent shared with me, a new approval in the inbox) may update at the next page switch; it need not appear live on the page I am looking at | user 2026-11-03 |
| Q4 | A client navigation to a page whose data is not in the cache shows the page's frame with skeletons while it loads | user 2026-11-03 |
| Q5 | All pages move in one change, not in phases | user 2026-11-03 |
| Q6 | Every template gets a designed loading state in this change, and each skeleton has the page's real structure (the same regions, rows and sizes the loaded page has), not a generic placeholder | user 2026-11-03 |

Q2 and Q4 replace web-SSR decision S1 ("every route decides its first paint on the server; browser
loading only after a person's action") and principle 3 ("no loading UI for navigation").

## 2. Goals, non-goals, anti-goals

Goals

- A first load paints complete, as today: no skeleton, no intermediate frame, no redirect after paint.
- Navigating back to a page seen within its freshness window issues **no** kernel read and paints at
  once from the cache.
- Navigating to a page whose data is stale paints the cached data at once and refreshes it in the
  background (stale-while-revalidate); to a page with nothing cached, the frame with skeletons.
- After my own change (a save, a delete, an org switch) every view of the changed data is current
  without a reload.
- One read per piece of data at a time: two components that need the same data share one request.

Non-goals

- Making the kernel faster. Per-request round trips (auth, membership) and serial queries inside
  endpoints are a separate change; this one removes repeated and serial reads from the web tier.
- Live push for data other than what already streams (the conversation SSE stream, its
  `event: changed` frames). Q3 accepts "at the next page switch".
- Caching across browser sessions (no persisted cache, no `localStorage`).
- Server Actions, `cacheComponents`, Partial Prerendering (still excluded, web-SSR §1.5).

Anti-goals (a failure even if it works)

- A first load that shows a skeleton or paints one frame then another (S1 still holds for document
  requests).
- Data of one org or one account showing under another after a switch or a sign-out.
- A view showing data older than my own last change to it.
- Hiding a stale read behind a long cache time to look fast: every class of data has an explicit
  freshness rule (§5), and an unknown class defaults to the shortest.

## 3. The shape

```
document request (open URL, reload)
  proxy ─► (app)/layout.tsx  [server]
             getShell(): session + shell reads, as today
             prefetchRoute(currentPath()): the page's queries, in parallel  ─┐
             <HydrationBoundary state={dehydrate(qc)}>                       │ one server render,
               <AppFrame> {children} </AppFrame>                             │ complete first paint
  page.tsx   [server, thin]: params → <View />  (no kernel read)            ─┘

client navigation
  Next fetches the RSC payload: layouts are not re-rendered (shared), page.tsx is thin
  View [client]: useQuery / useSuspenseQuery by key
     fresh in cache  → paint, no request
     stale in cache  → paint, refetch in background
     not in cache    → frame + skeletons, fetch from the browser (/api proxy)
```

### 3.1 Where the first-load prefetch happens

Next re-renders a shared layout only on a document request and on `router.refresh()`; on a client
navigation only the segments below it render. `(app)/layout.tsx` already relies on this (its
comment: "client navigations don't re-render the layout"). So the first-load prefetch lives in the
layout, keyed by the requested path, and a client navigation never triggers it:

- A **route table** (`lib/query/routes.ts`) maps each route pattern (`/chat/[conversationId]`,
  `/agents/[id]`, `/admin/extensions/[name]`, …) to the queries its first paint needs, as functions
  of the route params and search params. It is the one place that knows what a page reads first.
- `(app)/layout.tsx` (and the `(auth)` layouts for their pages) resolves `currentPath()` against the
  table, prefetches the matching queries in parallel with the shell reads, and wraps its children in
  one `HydrationBoundary`.
- `page.tsx` stays a server component (web-SSR keeps its `page` / `view` split and its checks) but
  reads nothing from the kernel; it passes route params to the client view.

This uses only stable Next APIs (layouts, the proxy's path header that `currentPath()` already
reads, `headers()`). Detecting a client navigation from Next's internal request headers (`RSC`,
`Next-Router-State-Tree`) is **not** used.

Builder to verify first (a spike, before converting pages): that with Next 16.4 a client navigation
between two pages under `(app)` does not re-run `(app)/layout.tsx`, including for dynamic segments
and search-param changes, and that `router.refresh()` does. If it does not hold, stop and come back:
the fallback (prefetch in `page.tsx` and accept server reads on navigation) does not meet Q2.

### 3.2 Decisions on the server that move to the client on navigation

Under web-SSR the server decided redirects, not-found, role gates and the frame before every paint.
On a document request it still does (the layout reads the session and readiness, the page's
prefetch reveals a 404). On a client navigation the client decides, from the cache:

- **Role gate**: `me` (memberships, enterprise admin) is always in the cache after the first load;
  a view renders `<NoAccess />` from it, as the server did.
- **Not found**: a query answering 404 renders the not-found state of that page (the same component
  `not-found.tsx` uses).
- **Setup redirect** (org not ready): from the cached readiness, the client navigates to `/` with
  `router.replace` before painting the page.
- **Signed out** (`auth.*` 401 after the refresh retry `lib/api.ts` already does): redirect to the
  sign-in page with the return path, and clear the cache.

### 3.3 Failed reads on a first load (my call)

A layout cannot hand a failure to the `not-found.tsx` / `error.tsx` of its own segment (they sit
below it), and `prefetchQuery` neither throws nor dehydrates a failed query by default. So:

- The server dehydrates failed queries too (`shouldDehydrateQuery` also accepts `status ===
  "error"`), with the kernel code; the view renders the page's error or not-found state from the
  query, inside the App Shell, on the first paint. The client does not refetch a dehydrated error on
  mount (`retryOnMount: false` for it); the page's retry action or the next navigation does.
- A **missing object** (a conversation, agent or extension that answers 404) is therefore a 200
  page showing the not-found state in the shell. An **unknown route** (no route-table match) keeps
  `notFound()` and its HTTP 404 (`e2e/chat.spec.ts` keeps that assertion; an assertion of 404 for a
  missing object moves to the not-found state).
- Web-SSR R5 holds: a secondary read that failed on the first load draws its section's error state
  and is not read again on mount; its retry or the next view reads it.
- The kernel unavailable on a first load still gives the `KernelStarting` frame (the layout's
  `getShell()`, unchanged).

## 4. The query layer

- One `QueryClient` per browser tab (module singleton), one per server request (React `cache()`),
  as the TanStack Query Next.js guide recommends. The provider is mounted in the root layout.
- **Query keys** come from one key factory (`lib/query/keys.ts`); every key starts with its scope:
  `["org", orgId, …]`, `["account", accountId, …]`, `["deployment", …]` (enterprise admin). No
  ad-hoc key arrays in views (a check, §8).
- **Query functions** are the existing loaders in `lib/*.ts` (they already run on both sides through
  `ApiTransport`), wrapped by `queryOptions(...)` definitions next to them (`lib/query/*.ts`), so the
  server prefetch and the client hook use the same options object.
- Server reads keep the per-request dedupe of `lib/server/kernel.ts` (`cachedGet`); the server query
  client prefetches through the same transport.
- Errors stay `ApiClientError` with the kernel code; views show the same error states as today.
- Retries: no automatic retry for 4xx; one retry for network errors and 5xx (the kernel-unavailable
  frame keeps its own retry loop).

## 5. Freshness: what stays cached how long

My call where the user gave the principle but not the numbers; each class is one constant in
`lib/query/freshness.ts`, so it can be tuned in one place.

| Class | Examples | `staleTime` | Made current by |
|---|---|---|---|
| Mine, changed only by me | `me`, my memberships, preferences, my tokens, my identities | `Infinity` | invalidation after my mutation; reload |
| Org configuration | agents, models, connectors, skills, extensions, members, org settings, catalog | 30 s | invalidation after a mutation; refetch on the next view once stale |
| Live state | inbox count, conversation groups, sandbox status, queue, files of a conversation | 30 s | invalidation; SSE `changed` frames where they exist; next view once stale |
| A conversation's events | events of `/chat/[id]` | `Infinity` | the SSE stream appends to the cached list; reconnect catches up from the last seq (as today) |
| Deployment (admin) | deployment config, installed extensions, marketplaces | 30 s | invalidation after a mutation |
| Unclassified | anything not listed | 0 | (default; a check forbids leaving a query unclassified, §8) |

`gcTime` stays at TanStack's default (5 min): data unused for 5 minutes is dropped and the next view
fetches it.

Refetch triggers: `refetchOnWindowFocus` off (Q3: the next page switch is enough, and focus refetch
would re-read every mounted query); `refetchOnMount` on (stale data refreshes on the next view);
`refetchOnReconnect` on.

## 6. Mutations and invalidation

- Mutations stay on the kernel HTTP API through `/api` (web-SSR S4), now as `useMutation`.
- Every mutation names the keys it invalidates on success (`onSuccess: invalidate(keys.org(orgId)
  .agents())`), or updates the cache from the response (`setQueryData`) where the response is the
  new state.
- `router.refresh()` after a mutation (26 files today) is replaced by invalidation. It stays only
  where a mutation changes what the **layout** decided (current org, readiness, signing in or out),
  and there the cache is cleared too.
- **Org switch** and **sign-out** clear the whole cache (`queryClient.clear()`), then navigate, so
  nothing of the old org or account can paint.
- A conversation's SSE stream writes into the cache (`setQueryData` on its events key) instead of a
  component-local reducer seeded once; the reducer that turns events into the timeline stays, reading
  from the cached list. `event: changed` frames invalidate the matching keys (queue, files, sandbox,
  title) instead of bumping local counters.
- **Returning to a conversation** (my call): the stream is open only while the page is shown. On
  return it reopens from the cached last seq; that catch-up is the event log, not a snapshot read,
  and is always made. The other pieces (queue, files, sandbox, sub-agents, extension views, the
  conversation row) follow their freshness class: within 30 s they come from the cache; when the
  catch-up delivers any event, or they are stale, they are invalidated and refetched. This replaces
  the unconditional re-read on every stream open (web-SSR R5's "open catches up"): a `changed`
  frame missed while away for less than 30 s with no event in between shows at the next view after
  that (Q3).
- **Persistent components** (the sidebar's conversation groups, the inbox count) stay mounted across
  navigations, so `refetchOnMount` never fires for them: they refetch their stale queries on each
  path change explicitly (`invalidate` only when stale).

## 7. What changes in the web tier

- New: `lib/query/` (client, keys, freshness, query options per area, route table, hydration
  helpers), the provider in the root layout.
- `(app)/layout.tsx` and the `(auth)` layouts: route prefetch + `HydrationBoundary`.
- Every `page.tsx`: no kernel reads; params to the view. The server helpers in `lib/server/*`
  (`loadConversationSnapshot`, agent form, catalog, trajectory) become query option sets the route
  table uses.
- Every `view.tsx`: data from `useQuery` / `useSuspenseQuery`; `useLoad`, `useServerState` and the
  hand-written loaders in effects (sidebar groups, inbox count, conversation snapshot pieces) are
  removed. Skeletons come from the templates' loading states (§7.1).
### 7.1 Template loading states (Q6)

Today only `ListPage` (with `DataTable` skeleton rows) has a loading state. This change designs one
for every template a page under `(app)` / `(auth)` uses: `ConversationPage`, `DetailPage`,
`FormPage`, `SettingsPage`, `TracePage`, `InboxPage`, `OverviewPage`, `WizardPage` (and checks
`ListPage` against the same rule).

- Each skeleton has the loaded page's structure: the same frame (sidebar, header, title bar, right
  area), the same regions in the same places, rows and blocks at the loaded sizes from the size
  tables, so the switch from skeleton to data moves nothing (no layout shift). Text becomes bars,
  controls keep their boxes, counts and actions keep their slots.
- Where the shape depends on data (how many sections a form has, how many fields), the page passes
  the shape it knows statically (the route's section list, the form's field layout) to the template;
  a template guesses nothing it cannot know, and an unknown repeat count uses the template's
  documented default.
- Parts whose data is already cached render for real; only the missing parts are skeletons (e.g.
  the sidebar never skeletons after the first load, a conversation whose events are cached but whose
  files are not skeletons only the files panel).
- Flow per template: design spec state list (`loading`) and size table in `docs/design/spec.md`,
  the component in `packages/design`, `/dev/ui/reference/<template>` showing the state, an entry in
  `apps/web/visual/accepted.ts`, fidelity coverage, then baselines through `visual-update`. Reduced
  motion: no shimmer animation, static bars.
- `PendingState` stays for in-place loading after a person's action; it is not the navigation
  skeleton.

### 7.2 Router and links

- `useLinkStatus` pending on links stays: it now covers the short RSC fetch.
- Next's client router cache (`staleTimes`) is left at its default (dynamic 0): the query cache is
  the one cache; two caches with different lifetimes would show different ages of the same data.

## 8. Checks (`check:web-ui`, red first; full on every PR, cheap text scans)

Replaced or added, each with a red fixture:

| Rule | What fails |
|---|---|
| `web-ssr-first-paint` (removed) | — replaced by the two rules below |
| `web-query-no-direct-read` | in `apps/web/src/app` or `components`: a `lib/*` loader called outside a `queryOptions` / `queryFn` / `mutationFn`, `useLoad(`, or `apiFetch(` in a view |
| `web-query-keys` | a `queryKey:` that is not built by the key factory |
| `web-query-freshness` | a `queryOptions` without a freshness class from `lib/query/freshness.ts` |
| `web-query-page-read` | a server `page.tsx` calling a kernel loader or `read(` (pages read nothing; the route table does) |
| `web-query-route-table` | a `page.tsx` under `(app)` / `(auth)` with no route-table entry (an entry may list no queries, with a reason) |
| `web-ssr-loading-file` (kept) | any `loading.tsx` (skeletons come from the query state inside the view's template) |

## 9. Testing

- Unit: key factory scoping, freshness classes, route-table matching (every page pattern resolves),
  invalidation lists of each mutation.
- Page tests (`apps/web`): a first render with a hydrated cache shows no skeleton (as today's
  assertion); a render with an empty cache shows the template's skeleton, then the data.
- e2e (Playwright, counting `/api` GETs):
  - open `/chat/A`, navigate to `/chat/B`, back to `/chat/A` within 30 s with nothing new in A: on
    the way back the only request for A is its stream (`…/stream?after=<last seq>`), no snapshot GET
    (events, queue, files, sandbox, tools, skills), and A paints at once;
  - after 30 s the same navigation paints at once and issues the background GETs;
  - edit my display name: the sidebar's account row updates with no reload and no `/me` GET besides
    the invalidation's one;
  - switch org: nothing of the old org is visible at any frame (MutationObserver probe, as the
    web-SSR e2e does);
  - a first load (reload) paints with no skeleton (the existing web-SSR assertion).
- Visual: a baseline of each template's loading state (§7.1) and a fidelity case that the
  skeleton's regions sit at the loaded page's positions (measure skeleton and loaded page, same
  boxes within the size table's tolerance).

## 10. Docs to update

- AGENTS.md "UI" rule (page = server `page.tsx` + client view; first load on the server, navigation
  from the query cache, no `loading.tsx`).
- `.agents/skills/writing-web-ui`: the query layer, key factory, freshness classes, route table,
  invalidation, the test helpers.
- `docs/design/spec.md`: the loading state and its sizes for every template (§7.1).
- `2026-11-01-web-ssr-design.md`: a note at the top pointing here for §1.1–1.3, §9 and S1.

## 11. Left to the builder

- File layout inside `lib/query/`, naming of the option sets, whether views use `useQuery` with the
  hydrated data or `useSuspenseQuery` with Suspense boundaries for the skeletons.
- Which existing loaders merge or split to fit one query each.
- Whether the conversation timeline reducer reads the cached events directly or through `select`.
- The exact order of converting pages inside the one change (Q5 only requires that it ships whole).
- `(auth)` has no group layout today: add one for the route prefetch, or prefetch in its two
  existing layouts.
- Existing polling (eval runs, extension install status) becomes `refetchInterval`.
- Unsent drafts and other per-view input stay component-local, not in the query cache.
