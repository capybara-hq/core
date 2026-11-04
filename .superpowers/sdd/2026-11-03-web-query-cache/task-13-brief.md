### Page migration tasks (10–16): the recipe

Each migration task converts the listed pages with the same steps, and each page is its own commit:

1. **Queries:** `lib/query/<area>.ts` gets one `defineQuery` per kernel read the page makes, wrapping the existing `lib/<area>.ts` loader. Add the key builders to `keys.ts`. Freshness comes from the table in the task; anything not listed uses the spec §5 table.
2. **Route entry:** replace the page's `none: "pending migration"` with `queries(ctx)` returning the first-paint queries, i.e. what `page.tsx` reads today. These are the server reads listed in the task.
   - A read that depends on another read's answer moves into the view as a dependent `useQuery` (`enabled`), unless the task says otherwise. Examples: tool info from events, members only when an event names another account.
   - The layout then prefetches only the first wave, and the dependent read paints from the cache on the first load only if the entry's `queries` can compute it. Otherwise, add a `then(qc)` step to the entry that runs after the first wave.
3. **page.tsx:** no reads. It returns `<View params={…} />`, typed with the route params.
4. **view.tsx:**
   - Gate with `useWorkspace` / `useAdmin`, passing the same `min` / `setup` the page used.
   - Read data with `usePageQuery`, and pass the template's `loading` shape while it is `loading`.
   - `notFound` renders the same component as the segment's `not-found.tsx`.
   - `error` renders the existing error state, with `retry`.
   - Secondary sections (`section(...)` / `optional(...)` today) are their own queries with their own section states (R5: a hydrated error is not refetched on mount).
5. **Mutations:**
   - Each `apiFetch` / `lib` mutation call becomes `useAppMutation` with `invalidates` naming the keys whose answer the mutation changes.
   - Use `setQueryData` instead when the response is the new object.
   - Remove `router.refresh()` there, unless the mutation changes the layout's decisions (org, readiness, sign-in), which Task 4 already covers.
   - Remove `useServerState` / `useLoad` from the file.
6. **Polling:** replace any hand-written `setInterval` / `setTimeout` poll with `refetchInterval`, using the same period as today.
7. **Tests:** convert the page's test from `renderRoute` to `renderRouteWithCache`, and keep its assertions. Add two cases:
   - `"<page>: a first render from the hydrated cache makes no browser read"`: `stubApi` gets zero GET calls.
   - `"<page>: an empty cache shows the template's loading state, then the data"`: assert `aria-busy` is present, then the data, then `aria-busy` is absent.
   For a page with mutations, add `"<mutation> invalidates <keys>"`, asserting the refetch call.
8. Remove the page's `QUERY_PENDING` entries, then run `pnpm check:web-ui` and `pnpm exec vitest run apps/web/test/<file>`.
   Expected: both clean.

### Task 13: Settings, evals, trajectories, inbox, extension pages

| Page | First-paint queries | Freshness |
|---|---|---|
| `/settings/organization`, `/settings/sandbox` | org settings | `orgConfig` |
| `/settings/members` | members, invitations | `orgConfig` |
| `/settings/models` | models, org purposes | `orgConfig` |
| `/settings/extensions` | org extensions, org file previewers | `orgConfig` |
| `/settings/plugins` | plugin installs | `orgConfig` |
| `/settings/tokens` | service tokens | `mine` |
| `/evals`, `/evals/new` | agents, eval sets | `orgConfig` |
| `/evals/[setId]`, `/evals/[setId]/run` | eval set, agent, runs / model purposes, models | `orgConfig`; runs `live` |
| `/evals/[setId]/cases/[caseId]` | eval case, eval set, members | `orgConfig` |
| `/evals/runs/[runId]` | eval run (`live`, `refetchInterval` while running), set, result rows page | as given |
| `/trajectories` | agents, trajectories (search params in the key) | `orgConfig`; list `live` |
| `/trajectories/[conversationId]` | trajectory (`lib/server/trajectory.ts` reads), members | `live` |
| `/inbox` | inbox, skill change per item shown | `live` |
| `/p/[plugin]/[id]` | ui contributions, ui view (locale in the key) | `orgConfig`; view `live` |

- Remove `lib/server/trajectory.ts`.
- Extra test (Review Focus 5): `"trajectories: a new agent filter never shows the previous filter's rows"`. Render `?agent=a` from the cache, navigate to `?agent=b` with a deferred stub, and assert that no row of `a` is visible while `b` loads (the loading state shows).

