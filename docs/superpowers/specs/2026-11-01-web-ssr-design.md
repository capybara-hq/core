# Web: server-decided first paint

Status: draft (acceptance round 3, user decisions 2026-11-01)

Related: `docs/superpowers/specs/2026-10-31-web-order-design.md` (the shell, frames, setup layout,
roles), `docs/design/spec.md` (design system).

## 0. Why

During acceptance the user kept seeing intermediate states: the logo, then a jump to `/setup`; a
half-drawn shell after creating an org, then the setup layout; skeletons that do not match the page
that replaces them. The cause is structural: 55 of the 57 pages are client components that render
first and fetch in the browser (`useLoad` + `apiFetch`), behind `AppFrame`, which itself fetches
`/me` and the readiness in the browser.

The user's rule (2026-11-01): **every route, every layout and every page decides on the server what
it shows before the user sees anything.** The only browser loading states allowed are the ones a
person triggers after the page is shown (the next page of a table, typing in a search, opening a
dialog). Use Next.js's own server rendering the way the official documentation recommends.

The setup layout also becomes a left / right layout like the shell (user, 2026-11-01): a person
should find the actions in one place in both layouts.

## 1. Principles

1. **Server components fetch; client components interact.** A route's `page.tsx` and its layouts are
   server components. They read the session and the page data from the kernel and render a client
   view with the data as props. The client view never fetches its first-paint data.
2. **One decision before the first byte of the page.** Redirects (`redirect()`), not-found
   (`notFound()`), the frame (shell, setup, org chooser), role gates and load failures are all
   decided on the server. A browser never paints a state and then replaces it.
3. **No loading UI for navigation.** No `loading.tsx` anywhere: on a client navigation Next keeps the
   current page until the next one's server payload is ready, so the old page stays until the new
   one is complete. The clicked link shows a subtle pending state (`useLinkStatus`).
4. **Mutations go through the existing `/api` proxy; the server re-renders afterwards.** After a
   mutation that changes what the server decided (current org, readiness, a list), the client calls
   `router.refresh()` inside a transition: the pressed control shows its pending state, the page
   stays as it is, and the new server payload replaces it in one step. Small local changes (one
   row's new value) may update local state from the mutation's response instead.
5. **Stable Next APIs only.** `redirect`, `notFound`, `cookies`, `headers`, `React.cache`,
   `error.tsx`, `not-found.tsx`, Proxy, `useLinkStatus`, `router.refresh`. Not used:
   `forbidden()` / `unauthorized()` (experimental `authInterrupts` in 16.4), Partial Prerendering /
   `cacheComponents`, Server Actions (mutations stay on the kernel HTTP API through `/api`), streaming
   fallbacks (`<Suspense>` with a skeleton) for first-paint data.
6. **Enforced by checks** (§9): a rule that can be checked is checked, proven red first.

## 2. Request pipeline

```
browser ──► server.mjs (peer address, object-store proxy)
        ──► Proxy (src/proxy.ts): locale prefix · session renewal · sign-in gate
        ──► layouts + page (server components): session, shell data, page data from the kernel
        ──► client views hydrate with the same data; live updates start
```

### 2.1 Proxy (`src/proxy.ts`)

Runs for every page request (matcher: everything except `/api`, `/plugin-ui`, `/_next`, `/dev`, and
paths with a file extension). In order:

1. **Legacy locale prefix** (unchanged): `/zh/...`, `/en/...` → 308 to the path without it.
2. **Session renewal.** When the request has no `cap_at` but has `cap_rt`, the proxy calls
   `POST {kernel}/api/v1/auth/refresh` with that cookie (and the trusted peer address,
   `lib/peer.ts`).
   - **200**: the new cookies go both ways. The request continues with the new `cap_at` in its
     `cookie` header (`NextResponse.next({ request: { headers } })`), and the response carries the
     kernel's `Set-Cookie` headers unchanged.
   - **Concurrent requests** in one web process share one refresh: single flight keyed by
     `sha256(cap_rt)`. The result is kept for `REFRESH_RACE_GRACE_MS` (30 s, the kernel's own
     window), so prefetches and parallel tabs that arrive with the same old token reuse the same
     new pair. This is a per-process cache of a pure function of the token, not shared state:
     another replica may refresh the same token.
   - **`auth.refresh_race`** (another web replica won): answer 307 to the same URL with a marker
     cookie `cap_retry=1` (Max-Age 10). By then the browser has the winner's cookies. A request that
     already carries the marker gives up and continues signed out; the marker is cleared on the next
     successful request.
   - **Any other kernel error** (`auth.refresh_invalid`, a disabled account): continue signed out and
     clear both cookies on the response.
   - **Network error or 5xx**: continue without changing cookies and mark the request
     `x-cap-session: unavailable`. The server data layer then renders the "kernel unavailable" state
     (§2.3) instead of sending the person to sign in.
3. **Sign-in gate** (an optimistic cookie check, as the Next docs recommend). A protected route
   without `cap_at` after step 2 redirects (307) before any rendering:
   - to `/setup` when the kernel says the deployment needs its first admin (`GET /api/v1/setup`),
   - else to `/login?returnTo=<path+query>`.

   The route list lives in one module, `lib/routes.ts` (public: `/login`, `/setup`, `/invite/*`,
   `/bind/*`), imported by the proxy and by client code that needs it.
4. The proxy sets `x-cap-path` (path + query) on the forwarded request, for server code that needs
   the current URL (a `returnTo`).

The proxy is only a gate. Server components still verify everything through the kernel: a `cap_at`
that is present but revoked gets 401 there and redirects to sign-in (§2.3).

### 2.2 Kernel: the refresh cookie on Path=/

Today `cap_rt` is `Path=/api/v1/auth`, so page requests never carry it and the server cannot renew
an expired session. Change (user decision 2026-11-01): `REFRESH_COOKIE_PATH = "/"`. The cookie stays
`HttpOnly`, `SameSite=Strict` and host-only. It now reaches the web tier on page requests too; the
web tier already proxies every `/api` request.

**Migration**: browsers still hold the old `Path=/api/v1/auth` cookie. On `/api/v1/auth/*` requests
they send both, the more specific path first.
- `setSessionCookies` and `clearSessionCookies` also clear the legacy-path cookie.
- The refresh endpoint reads the first `cap_rt` that verifies (it tries each value the `cookie`
  header carries) instead of the first one parsed.
- A browser that has only the legacy cookie and an expired `cap_at` is sent to sign in once after the
  upgrade: page requests never carry the legacy cookie. This is a pre-1.0 release candidate, so a
  one-time sign-in is accepted and stated in the release note rather than kept alive with a
  client-side renewal page.

### 2.3 Server data layer

- **`lib/server/kernel.ts`** (`import "server-only"`): `serverTransport(path, init)` fetches
  `kernelUrl() + path`.
  - **Forwarded headers**: the incoming `cookie` header and the trusted peer address as
    `x-forwarded-for` (`trustedPeer(await headers())`). Also `accept-language` and `x-request-id`
    when present.
  - **Reads only**: anything other than `GET` throws, because the server never mutates.
  - **No caching**: `cache: "no-store"`. Per-request deduplication comes from `React.cache` around
    GETs: a layout and a page that both read `/me` make one call.
- **Isomorphic loaders**: the `lib/*.ts` loaders (`listAgents`, `getMe`, …) stay as they are, and
  `apiFetch` gets a transport seam.
  - In the browser it fetches `/api/...` as today, with its refresh-and-retry fallback.
  - On the server it calls the registered server transport. The root layout imports
    `lib/server/register.ts`, which calls `setApiTransport(serverTransport)`.
  - Client bundles never import `next/headers`.
  - Server-side, a 401 is not retried (the proxy already renewed).
- **Errors** (`lib/server/page.ts`):
  - `401 auth.*` → `redirect(loginPathFor(x-cap-path))`.
  - `404` (any `*.not_found` code) → `notFound()`.
  - Anything else, including `x-cap-session: unavailable`, a 502 and network errors → throw.
    `error.tsx` draws the failure (§5).
  - A page that tolerates a failing optional read (the overview's members, skills and connectors
    when a role is refused) catches it explicitly with `optional(promise)`, which resolves to `null`.
- **Context helpers**:
  - `getSession()` → `{ me, org: { id, slug, name, role } | null }`.
  - `getShell()` → the shell data of §3.1.
  - `workspace({ min?, setup? })`: the gate every workspace page calls first. It returns
    `{ me, orgId, role }`, or decides for the page:
    - no current org → the org chooser frame (§3.2);
    - setup and the route is not a setup route → `redirect("/")`;
    - below `min` → returns a `noAccess` marker. The page then renders `<NoAccess need={min} />`
      on the server and fetches nothing.
  - `admin()`: the same for the admin console (enterprise admins only).

## 3. The shell

### 3.1 What the `(app)` layout reads

`app/(app)/layout.tsx` awaits `getShell()` and renders `<AppFrame initial={shell}>`. The shell data
is read in parallel:

| Data | Endpoint | Notes |
|---|---|---|
| `me` | `GET /api/v1/me` | always |
| readiness | `GET /orgs/:o/readiness` | when there is a current org |
| sidebar conversations | `GET /orgs/:o/conversations/groups` (the sidebar's default params) | when there is a current org |
| pending count | `GET /orgs/:o/inbox` (count and `truncated` only) | when there is a current org |
| extension pages | `GET /orgs/:o/ui/contributions` (`place: "page"`) | when there is a current org |

A failure of the last three draws that section's own error state (the conversation list's "加载失败
· 重试", no count, no extension group). `me` or readiness failing fails the request (`error.tsx`).

`AppFrame` becomes props-driven:
- **No browser fetch on mount.** No `RequireSession` skeleton, no `PendingState` frame, no
  `sessionStorage` readiness marks (`cap.ready.*` and `clearReadyMarks` are removed).
- **Mirrors the props.** Client state is seeded from `initial` and replaced whenever the server
  sends new props (`router.refresh()`, an org change). Live updates continue from the seeded state:
  the 30 s polling of the conversation groups and the pending count, the `cap:conversations-changed`
  event and window focus.
- **Frame choice is synchronous** from the props and `usePathname()`, so it is right at first paint:
  1. the org chooser, when there is no current org (outside `/admin`);
  2. the setup frame, when the org is not ready and the route is a setup route (§4);
  3. otherwise the shell.

  `/admin/*` always draws the admin context.

### 3.2 Session-changing actions

| Action | Kernel call | Then |
|---|---|---|
| Switch org | `PUT /me/current-org` | `router.push("/")` and `router.refresh()` in one transition. The org menu item shows pending; the current page stays until the new org's home is ready. |
| Create org | `POST /orgs`, then `PUT /me/current-org` | the same. The dialog's submit stays pending until the new frame (usually setup) replaces the page. |
| Leave org | `POST /orgs/:o/leave` | switch to another org, or show the chooser, with the same transition. |
| Delete org (owner) | `DELETE /orgs/:o` | the same. |
| Sign out | `POST /auth/logout` | full navigation to `/login`, then the cross-tab broadcast. |
| Sign in / set up | `POST /auth/login`, `POST /setup` | full navigation to `returnTo`, then the cross-tab broadcast. |
| Readiness-changing work (create or delete an agent, enable a model provider) | its own call | `router.refresh()` |

**Cross-tab sync** (borrowed from octok's `auth-sync`): signing in, signing out and switching org
broadcast on a `BroadcastChannel("capybara-session")`, with a `storage`-event fallback.
- A tab that receives sign-in or sign-out does a full navigation to `/`, which resets client state.
- A tab that receives an org switch does `router.push("/")` plus `router.refresh()`: the current org
  belongs to the session, which tabs share.

While the setup frame is shown, the setup home re-reads readiness with `router.refresh()`: every
30 s, on window focus, and from its 刷新 button. This lets a member see the shell appear once an
admin has finished.

### 3.3 Status bar and pending navigation

The status bar is unchanged. Pending navigation: the design system's `Link` uses `useLinkStatus` and
marks itself `data-pending`. Sidebar items, object rows, tabs and breadcrumbs then show a 2 px
`accent` underline animation (reduced motion: a static underline) while their navigation is pending.

## 4. The setup frame, left / right

The setup layout (web-order spec §3.8) keeps its scope and role rules but moves into the shell's
geometry:

```
┌────────────────┬────────────────────────────────────────┐
│ ▣ CAPYBARA     │ acme / 开始之前                          │
│ [Acme ▾]       │ 开始之前                                  │
│                │ 还差几步才能开始对话                       │
│ ◆ 开始之前      │                                         │
│ ✓ 配置模型      │  checklist card · 已完成 1 / 2            │
│ ○ 创建 agent    │  可以稍后再做                             │
│   可以稍后再做   │                                         │
│ ○ 连接渠道      │                                         │
│ ○ 邀请成员      │                                         │
│                │                                         │
│ 管理后台        │                                         │
│ grant     ☼ ☾  │                                         │
├────────────────┴────────────────────────────────────────┤
│ grant@acme:~/setup                      v0.1.0 · UTC+8  │
└─────────────────────────────────────────────────────────┘
```

**Sidebar** (`context: "setup"`):
- the brand row without the search and inbox icons;
- the org switcher, as in the work context;
- then the steps as navigation:
  - 开始之前 (the setup home);
  - the required steps;
  - a "可以稍后再做" group label, then the optional steps;
- at the bottom, the admin entry (enterprise admins) and the account row with the theme.

There is no conversation section. Rail and drawer behave as in the shell.

Each step item has a state mark (an `Icon`, never a character):

| State | Mark | Item |
|---|---|---|
| done | `check` | `success` tone; still a link |
| to do | `circle` | a link |
| waiting | `clock` | the reason as its second line (e.g. "等待管理员配置模型"); not a link |
| current | | the current-page highlight of the shell |

Steps per role, taken from the existing table:

| Step | Enterprise admin | Org admin | Member | Guest |
|---|---|---|---|---|
| 配置模型 | link `/admin/extensions` | waiting: "需要部署管理员配置模型服务" | waiting: "等待管理员配置模型" | same as member |
| 创建 agent | link `/agents/new`; before a model: waiting "先配置模型" | same | same | waiting: "等待管理员创建 agent" |
| 连接渠道 (optional) | when also org admin: `/channels/new` | `/channels/new` | — | — |
| 邀请成员 (optional) | when also org admin: `/settings/members` | `/settings/members` | — | — |
| 安装插件 (optional) | when also org admin: `/catalog` | `/catalog` | — | — |
| 我的连接 (optional) | — | — | `/account/connections` | — |

**Content area**: the shell's content area with the page head (path, title) and the content width.
- The setup home (`/`, `/chat`): path `<slug> / 开始之前`, h1 开始之前, the checklist card and the
  why-blocked notice with 刷新. This is the current `SetupHome` content without its own frame.
- A step page renders exactly as in the shell (its own template). The "← 开始之前" back link is
  dropped: the sidebar is the way back.

**Design system**: `SetupPage` (T13) is redrawn as sidebar + content area + status bar. `Sidebar`
gains `context: "setup"` and a `steps` prop. `docs/design/spec.md` §5.5 (T13) and §6.13 (sidebar)
are updated with the size table, the state list (step states, rail, drawer), the reference block and
the catalog entry, all through the normal component flow.

**Server side**: `workspace({ setup })` takes the route's setup class:
- `"home"` for `/` and `/chat`;
- `"step"` for the step pages of web-order §3.8;
- omitted for everything else, which redirects to `/` while the org is not ready.

The frame itself is chosen in `AppFrame` from the same readiness (§3.1).

## 5. Errors, not found, no access

- **`app/(app)/error.tsx`** (client, required by Next) renders `StatusPage kind="maintenance"`:
  加载失败 with the error's short text and 重试. 重试 runs `reset()` inside `startTransition` after
  `router.refresh()`. A kernel that is unavailable shows "后端服务暂不可用" in the same frame.
  `app/global-error.tsx` covers a failing root layout. `(auth)` gets its own `error.tsx` in the auth
  layout.
- **Not found**: `notFound()` from the page, drawn by the existing `app/(app)/not-found.tsx` inside
  the shell.
- **No access**: `workspace({ min })` / `admin()` return the marker, and the page renders
  `<NoAccess need=… />` itself (the existing `StatusPage kind="no-access"`). A 403 from the kernel
  for a role-allowed page is an error (`error.tsx`), since roles are already checked up front.
- **Kernel starting** (the 503 seen during acceptance): Proxy and server reads fail with network
  errors. `error.tsx` shows "内核正在启动…" for the upstream codes (`upstream_unavailable`, network
  errors), and retries itself with `router.refresh()` every 3 s for up to 60 s before it shows the
  manual 重试.

## 6. Pages

### 6.1 The pattern

```
app/(app)/agents/page.tsx      server: gate, read, render the view
app/(app)/agents/view.tsx      "use client": the template and the interaction
```

```tsx
// page.tsx
export default async function AgentsPage() {
  const ws = await workspace({});
  if (ws.noAccess) return <NoAccess need={ws.need} />;
  const agents = await listAgents(ws.orgId);
  return <AgentsView orgId={ws.orgId} initial={agents} />;
}
```

- **Params and query come from the server props** (`params`, `searchParams`), never from
  `window.location`. A client view that needs a live query value uses `useSearchParams()`. That is
  safe because every page is dynamic, so it needs no `Suspense` boundary.
- **URL state is server state.** Tabs or filters kept in the query string are navigations
  (`router.replace` in a transition). The server re-reads and the old list stays, dimmed through
  the transition's pending flag, until the new one arrives. Purely local filtering of an already
  loaded list (the agents tab and name filter) stays client-side.
- **`useLoad(load, deps, { initial })`**: with `initial` the state starts `ready` and nothing is
  fetched on mount. It fetches only when `deps` change after mount (a client-side param change) or
  on `reload()`. Without `initial`, `useLoad` is for user-triggered loads only (a dialog's contents,
  a wizard step), and `check:web-ssr` rejects it in a view's first-paint path (§9).
- **Props refresh.** `useServerState(initial)` returns `[value, set]` and resets to the new
  `initial` when the server sends one. Views use it for data they also update locally after a
  mutation.
- **Pagination.** The first page is read on the server. "Load more" and later pages load in the
  browser with skeleton rows at the end of the list (`ListPage`'s `loadingMore`). This applies to
  the trajectories, the admin accounts, the eval run results after the first 200, and the sidebar's
  group "更多".
- **Live data** starts from the server snapshot: SSE `after=<last seq>`, the polling's
  `updatedSince`, the UI stream.
- **User-triggered loads remain client-side**:
  - dialogs (reassign owner, add to eval set, plugin upgrade preview);
  - wizard steps after input (channel schema after picking a plugin, the eval estimate);
  - search-as-you-type (marketplace entries);
  - the conversation's right panel, whose open state lives in the URL hash by rule (AGENTS.md), so
    the server never sees it. It opens with its own loading state, as a click would.

### 6.2 The conversation page

`/chat/[conversationId]` reads, in parallel:
- the conversation;
- every event page (500 each, as `listAllEvents` does);
- the agents and the models;
- the queue;
- the sub-agents and the usage;
- the tool info for the tool keys in the events;
- the UI contributions (title-bar icons and properties sections);
- the sandbox status;
- the invocable skills for the composer.

The view mounts with all of it, then opens the stream at the last `seq`.

`/chat` (a new conversation) reads the agents, the most recent agent and the models. The `?agent=`
preset comes from `searchParams`.

### 6.3 Inventory and batches

Every route in the inventory moves to the pattern. Batches follow the plan's tasks:

1. home, `/chat`, `/chat/[id]`, `/inbox`;
2. agents, skills, connectors, catalog, channels;
3. settings, account;
4. the admin console;
5. evals, trajectories, `/p/[plugin]/[id]`;
6. the auth pages:
   - `/login` reads `returnTo` and `error` from `searchParams`, and redirects a signed-in visitor to
     `returnTo`;
   - `/setup` keeps its server-provided status;
   - `/invite/[token]` and `/bind/[token]` read their token preview on the server.

## 7. What changes for tests

- **Client views** are tested by rendering them with `initial` props: no `stubApi` for first-paint
  reads. Mutations still use `stubApi`.
- **Server pages** are tested with a stub server transport (`test/support/server.tsx`):
  - `setApiTransport(routes)`, then `await Page({ params, searchParams })`, then render the result;
  - every page test asserts that the first render has no loading text, no skeleton and no browser
    fetch, using a `stubApi` that throws on any call during the first render;
  - redirects, `notFound()` and the no-access marker are asserted from the thrown Next errors or the
    returned element.
- **Proxy** (node tests): renewal succeeds; same-process concurrency (one kernel call); other-replica
  race (307 with marker, then gives up); invalid refresh (cookies cleared); kernel down (marked
  unavailable, cookies kept); gate redirects (`/setup`, `/login?returnTo=`).
- **Kernel**: the cookie path, the legacy-path clearing, and reading the first verifying `cap_rt`
  among duplicates.
- **e2e**:
  - a page opened with an expired access cookie renders signed in, with no sign-in redirect;
  - creating an org goes straight to the setup frame, with no shell in between (Playwright waits for
    navigation and asserts no `data-template="AppShell"` frame was ever painted, using a
    MutationObserver probe);
  - the existing specs keep passing.
- **Visual**: new setup-frame baselines and state coverage for the sidebar's setup context.

## 8. Docs

- AGENTS.md "UI" rule: page = server `page.tsx` (gate + reads) + client view (template), no
  `loading.tsx`, no first-paint fetch in the browser.
- `.agents/skills/writing-web-ui`: the pattern, `workspace()`, `useLoad({ initial })`,
  `useServerState`, the exceptions list, the test helpers.
- Web-order spec §3.8: the setup frame is now left / right, and its "Deciding the layout" paragraph
  is replaced by §3.1 here.

## 9. Checks (`check:web-ui`, red first)

| Rule | What fails |
|---|---|
| `web-ssr-loading-file` | any `loading.tsx` under `apps/web/src/app` |
| `web-ssr-client-page` | a `page.tsx` under `(app)` or `(auth)` with `"use client"` (exceptions listed with reasons; none planned) |
| `web-ssr-first-paint` | in a `view.tsx`: a `useLoad(` call without `initial`, or a `useEffect` that calls a `lib/*` loader, unless the line carries `// ssr-exempt: <reason>` |
| `web-ssr-location` | `window.location.search` / `.pathname` read during render or in a `useState` initializer in `apps/web/src/app` (use `searchParams` / `usePathname`) |
| `web-ui-template` (changed) | a server `page.tsx` that renders a view must import it from `./view`, and that view must use a page template |

These are cheap text scans of `apps/web/src`, so they run in full on every PR as part of
`pnpm check`.

## 10. Out of scope

- Streaming a page in parts (`Suspense` fallbacks).
- Server Actions.
- Moving the right panel from the hash to the query.
- Self-registration and the org rename discussed in the same session.

## 11. Decisions

| # | Decision | Source |
|---|---|---|
| S1 | Every route decides its first paint on the server; browser loading only after a person's action | user 2026-11-01 |
| S2 | The setup layout is left / right with the steps in the sidebar | user 2026-11-01 |
| S3 | `cap_rt` moves to `Path=/` so the web tier can renew sessions on page requests | user 2026-11-01 |
| S4 | Stable Next APIs only; mutations stay on the `/api` proxy; `router.refresh()` after mutations that change server decisions | this spec |
| S5 | Cross-tab session sync on sign-in, sign-out and org switch | this spec, after octok `auth-sync` |
