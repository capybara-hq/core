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

### Task 10: Shell and conversation (`/chat`, `/chat/[conversationId]`)

**Files:**
- Modify:
  - `components/shell/{nav,conversations,AppFrame}.tsx`
  - `components/conversation/{useConversation.ts,useQueue.tsx,FilePanel.tsx,RightArea.tsx,PropertiesSections.tsx,SubagentPanel.tsx,ExtensionBlocks.tsx,ComposerBar.tsx}`
  - `app/(app)/chat/**`
- Create: `lib/query/conversation.ts`
- Remove: `lib/server/conversation.ts` (its pieces become queries)
- Test:
  - `test/conversation-page.test.tsx`
  - `test/chat-panel.test.tsx`
  - `test/chat-files.test.tsx`
  - `test/composer-skills.test.tsx`
  - `test/nav.test.tsx`
  - `test/stream.test.ts`
  - new `test/conversation-cache.test.tsx`

**Interfaces:**
- Produces, in `lib/query/conversation.ts`:
  - `conversationQuery(orgId, id)`: `live`.
  - `eventsQuery(orgId, id)`: `events`, via `listAllEvents`.
  - `queueQuery`, `filesQuery`, `sandboxQuery`, `subagentsQuery`, `usageQuery`: `live`.
  - `toolInfoQuery(orgId, id, keys: string[])`: `orgConfig`, with the keys sorted in the key.
  - `invocableSkillsQuery(orgId, agentId)`, `contributionsQuery(orgId)`, `connectorsQuery(orgId)`, `attachmentLimitsQuery(orgId)`, `modelsQuery(orgId)`: all `orgConfig` (`agentsQuery` comes from Task 4). Later tasks reuse `modelsQuery` / `connectorsQuery`.
  - `appendEvents(qc, orgId, id, events: ConversationEvent[]): { added: number }`. It merges into the cached list by `seq`: no duplicates, ascending order, and the number of new events is returned.
  - `CONVERSATION_SIDE_KEYS(orgId, id)`: the keys invalidated after a catch-up that delivered events: queue, files, sandbox, subagents, usage, conversation row, and tool info prefix.
- Route entries:
  - `/chat/[conversationId]`: conversation, events, agents, models, queue, contributions, files, sandbox, connectors, limits. The `then` step computes tool info, sub-agents and usage, members, and invocable skills from the events and conversation.
  - `/chat`: agents, groups, models, limits.

Behaviour:
- `useConversation` reads `eventsQuery` and keeps `reduceChat` as a `select`-free reducer over the cached list (my call: reduce in a `useMemo` keyed by the list identity plus the delta buffer).
- The stream opens from the cached last seq. Each event goes through `appendEvents`. `event: changed` frames invalidate the matching key instead of bumping counters.
- On reopen, if the catch-up `added > 0`, invalidate `CONVERSATION_SIDE_KEYS`. Otherwise those keys follow their freshness class.
- The sidebar's groups and inbox count: on each `usePathname()` change, `qc.refetchQueries({ queryKey, stale: true, type: "active" })` (spec §6 "Persistent components"). The current per-path-change refetch in `nav.tsx:173-193` and `conversations.tsx:246` is removed.

Extra tests, beyond the recipe:
- `"appendEvents ignores seqs it already holds and keeps order"`: the cached seqs are [1,2,3] and the input is [3,2,4,6,5]. The result is [1,2,3,4,5,6] and `added === 3`. This is Review Focus 4.
- `"returning within 30 s with no new event reads only the stream"`: mount A from the cache, unmount, and mount again at fake time +10 s. The fake EventSource delivers nothing. `stubApi` calls are exactly one stream open, `…/stream?after=<last seq>`.
- `"returning with a new event refetches the side pieces"`: the catch-up delivers one event, and one GET each for queue, files, sandbox and conversation follows.
- `"a changed frame for files invalidates only files"`.
- `"sidebar refetches stale groups on path change and not fresh ones"`.

