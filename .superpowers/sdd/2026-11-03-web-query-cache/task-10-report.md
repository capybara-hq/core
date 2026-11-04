# Task 10 report: Shell and conversation (`/chat`, `/chat/[conversationId]`)

Status: DONE_WITH_CONCERNS (all checks green; concerns below are judgement calls to confirm).

Commits (in ruling order, each with its tests, each green on web vitest + typecheck + biome +
check:web-ui):

| Step | Commit | Subject |
|---|---|---|
| (a) | 5b0c60ca | feat(web): the sidebar sections read their queries directly |
| (b) | fca5a6b7 | feat(web): conversation queries and appendEvents |
| (c) | 9eecebe9 | feat(web): the conversation stream writes into the cached log |
| (d) | 2116bfdb | feat(web): the conversation's pieces read their own queries |
| (e) | 26b94d78 | feat(web): the chat routes read from the cache the layout prefetched |

Final verification (at 26b94d78): `pnpm exec vitest run apps/web/test` 81 files / 1492 tests pass;
`pnpm --filter @capybara-hq/web typecheck` clean; `pnpm exec biome check apps/web` clean;
`pnpm check:web-ui` passed; `pnpm check` all checks passed; `tools/checks/test/web-ui.test.ts` 57 pass.
No Playwright, no Next build run (per instructions).

## What was built

### (a) Shell sidebar sections
- `AppFrame` split: `AppFrame` reads `me`; without an org it renders `ShellFrame` with
  `sections={null}` (static no-org values, `noOrgConversations`); with an org, `OrgFrame` builds
  readiness and the three sections from their queries and passes them to `ShellFrame`. No
  org-scoped query is built without an org (carried Task 3 note). `useSection` / `useShellQueries`
  (hook-local state seeded from queries) are gone.
- `useConversationGroups(orgId: string, …)` reads `conversationGroupsQuery(orgId, search)` directly
  (one key per view: `"default"` or the JSON of archived/q/state, `groupsViewKey`),
  `refetchInterval` 30 s, `placeholderData` keeps the previous filter's rows of the same list and
  org. More / More groups are `qc.fetchQuery` of `moreConversationsQuery` / `moreGroupsQuery`; the
  paged rows stay local (`paged`, stamped with the first page's `dataUpdatedAt`) and merge into a
  newer first page with the existing `mergeRefresh`. Rename / archive / delete are `useAppMutation`
  invalidating `conversationGroupsAll()`; archive / delete drop the row at once (cache + paged)
  before the invalidation.
- `usePendingApprovals(orgId)` = `inboxCountQuery` + `refetchInterval` 30 s, `refresh` invalidates;
  `useExtensions(orgId, locale)` = `extensionPagesQuery`.
- Persistent refetch (ruling 7): `OrgFrame` effect on `usePathname()` changes runs
  `qc.refetchQueries({ queryKey, stale: true, type: "active" })` for `conversationGroupsAll()` and
  `inboxCount()`. Old per-path code in `nav.tsx` and `conversations.tsx` removed, as was the focus
  reload (spec §5 `refetchOnWindowFocus` off).
- Sign-out race (Task 4 note): `markSigningOut()` / `isSigningOut()` in `lib/query/workspace.ts`;
  `onLogout` marks first, `SessionGuard` ignores 401s while signing out. Test added.
- `logout` / `setCurrentOrg` / `createOrg` / `leaveOrg` are `useAppMutation`; `LeaveOrgDialog` reads
  `membersQuery` (new `lib/query/members.ts`).
- Interim (removed in (c)): the window event `cap:conversations-changed` invalidated the groups.

### (b) `lib/query/conversation.ts`
`conversationQuery` (live), `eventsQuery` (events, `listAllEvents`), `queueQuery`, `filesQuery`,
`sandboxQuery`, `subagentsQuery`, `usageQuery` (live), `toolInfoQuery` (orgConfig, keys sorted in
the key, batched by 100), `invocableSkillsQuery(orgId, agentId, conversationId?)` (the snapshot's
`mine ? id : undefined` and the `conversation.not_found` fallback), `contributionsQuery`,
`connectorsQuery` (raw `{ connectors }`), `attachmentLimitsQuery`, `modelsQuery` (raw
`{ providers }`), `appendEvents` (merge by seq, fast path for newer, returns `{ added }`, no-op
when the log is not cached), `CONVERSATION_SIDE_KEYS`. Keys added under
`keys.org(o).conversation(id).*` plus org-level builders.
In (d)/(e) it also got: `toolOutputQuery`, `toolOutputSizeQuery`, `filePreviewersQuery`,
`filePreviewQuery`, `fileTextQuery`, `approvalQuery`, `questionQuery`, `connectorQuery`,
`connectorPromptsQuery`, `connectorResourcesQuery`, `conversationFollowUps` (the `then` list).
`lib/query/ui.ts`: `uiViewQuery` and `refreshUiViews` (coalesced refresh).

### (c) `useConversation`
- Reads `eventsQuery` and `conversationQuery` from the cache. `reduceChat` stays:
  `base = useMemo(reduceChat(initial, events: cachedList), [list])`, then
  `useMemo(reduceChat(base, deltas: buffer))`; deltas are the per-frame buffer (pruned when their
  step is finalized or run closed); sub-agent progress is a small local reducer. No local copy of
  events (ruling 2/3).
- Stream opens from the cached last seq (bounded by what the stream delivered: per-QueryClient
  `WeakMap`, so a POSTed seq 9 never makes a reopen skip 4..8); each event goes through
  `appendEvents`; sends / queued sends / send-now append their event.
- `changed`: title/selection → row (title also groups), queue → queue, files → files,
  archived/deleted → groups (deleted → `/chat`). Run-phase change → groups. The window event and
  `notifyConversationsChanged` are deleted.
- Reopen rule: per open, the first appended event with `added > 0` invalidates
  `CONVERSATION_SIDE_KEYS` once; an open without events reads nothing.
- `send`, `stop`, rename are `useAppMutation`.
- Interim (removed in (d)/(e)): counters bumped for not-yet-migrated pieces; the page seeded row +
  log from its snapshot.

### (d) The other pieces
Queue (`useQueue`: query + 5 mutations invalidating the queue), files and contributions
(RightArea), sandbox and connectors (ContextSection; sandbox invalidated on new sandbox tool
results), sub-agents and usage (`lib/subagents.ts`, enabled once dispatched, invalidated on
`subagent_*` counts / stale progress), tool info (`lib/tool-info.ts`, `keepPreviousData`), skills /
prompts / resources (ComposerBar: `qc.fetchQuery` on menu open, fresh on a person's action),
limits and uploads (`use-draft-files`), members and output sizes (Thread), approval + decide
(ApprovalCard; decide sets the approval, still calls `session.refreshPending`), question answer,
child question, connector check, file previewers / preview / text, archived output, sub-agent
stop, sub-agent row check, embed tokens (mutation), UI actions (mutation), extension views
(`useExtensionViews` over `useQueries`; cards out of view are `paused` → disabled).
`ensureSession` calls carry `// query-exempt:` reasons (session refresh, not a read).
`/p/[plugin]/[id]/view.tsx` (Task 13's page) minimally adapted to the new `useExtensionViews` /
`refreshUiViews` API (its server `view` still seeds the cache).
Right-area loading (ruling 6): `RightAreaSlot.loading` = `{ title: Files }` for a file while files
load, `true` for a panel / properties while contributions (or files) load.

### (e) Routes, pages, views
- `/chat/[conversationId]` entry: `queries` = conversation, events, agents, models, queue,
  contributions, files, sandbox, connectors, limits; `then` = `conversationFollowUps` from
  `qc.getQueryData` (tool info by sorted keys, sub-agents + usage only when dispatched, members only
  when another account stopped a run, invocable skills by the conversation's agent).
- `/chat` entry: see concern 2.
- `page.tsx` files read nothing. `ChatView`: `useWorkspace()`; `usePageQuery(conversationQuery)`:
  `notFound` → `(app)/not-found.tsx`'s component (HTTP 200), `error` → `ErrorFrame` with retry.
  `ConversationPage.loading`: `thread` while events load, `title` while the row loads,
  `rightArea` from the slot; the composer uses the function form (`{ sendDisabled }`).
  `NewChatView`: `useWorkspace({ setup: "home" })` + readiness gate.
- `createConversationWithMessage` is a mutation invalidating the groups.
- `lib/server/conversation.ts` deleted.
- `prefetchRoute` now throws a query error that is no `ApiClientError` (the old "a fetch bug
  propagates" behaviour, test kept).

## TDD evidence
RED runs (implementation temporarily broken, then restored; outputs kept in the scratchpad):
- (a) path-change refetch removed + guard check removed: `sidebar refetches stale groups on path
  change and not fresh ones` ×, `a 401 read while the sign-out is pending leaves the navigation to
  the sign-out` × → GREEN after restore (24/24).
- (b) dedupe removed: `appendEvents ignores seqs it already holds and keeps order` ×, `appends newer
  events in order…` × → GREEN 5/5.
- (c) catch-up condition and resume bound broken: `a catch-up that delivers an event invalidates
  the side keys, once per open` ×, `a stream given up reopens after what it delivered…` × → GREEN.
- (e) loading not passed / send not blocked: `chat page: an empty cache shows the template's
  loading state, then the data` × → GREEN.
GREEN: full web suite 1492/1492 at HEAD.

New tests: `test/conversation-cache.test.tsx` (16: appendEvents ×3, keys ×2, hook-level stream/
return/catch-up/changed/resume ×5, page-level: hydrated first render no browser read; empty cache
loading → data; returning within 30 s reads only the stream; returning with a new event refetches
queue/files/sandbox/row; a changed frame for files reads only files; deleting a queued message
invalidates the queue). `test/shell-ssr.test.tsx` (+3: stale/fresh path-change refetch, same path
reads nothing, sign-out race). Converted: `sidebar-conversations.test.tsx` (QueryClient harness),
`conversation-page.test.tsx` (sidebar notices via invalidation spy, catch-up rule, not-found state in
the shell, `/chat` via `renderRouteWithCache`), `composer-skills`, `chat-panel`, `extension-slots`;
`support/conversation.ts` `renderChatRoute` now uses `renderRouteWithCache`; `support/render.tsx`
renders every page inside a query client (`testQueryClient`, `currentPageClient`);
`support/query.tsx` prefetches readiness like `getShell`; `test/setup.ts` makes TanStack notify
synchronously in tests.

## QUERY_PENDING entries removed (all 25 Task 10 entries)
app/(app)/chat/[conversationId]/page.tsx, app/(app)/chat/page.tsx, components/ApprovalCard.tsx,
ConnectCard.tsx, CreateOrgDialog.tsx, LeaveOrgDialog.tsx, QuestionCard.tsx, SessionFilePreview.tsx,
conversation/{ComposerBar, ConversationView, FilePanel, NewConversation, PropertiesSections,
RightArea, SubagentPanel, SubagentWait, Thread, useConversation, useQueue}, extension-ui/{EmbedTab,
ExtensionViewTab}, shell/{AppFrame, conversations, nav}, use-draft-files.ts.

## Files
Added: `apps/web/src/lib/query/conversation.ts`, `apps/web/src/lib/query/members.ts`,
`apps/web/src/lib/query/ui.ts`, `apps/web/test/conversation-cache.test.tsx`.
Deleted: `apps/web/src/lib/server/conversation.ts`.

## Self-review and concerns
1. **Catch-up window**: an SSE stream has no "caught up" marker, so "the catch-up delivered
   events" is implemented as "the first new event of each open": an idle open followed later by a
   live event also invalidates the side keys once. Cheap, but please confirm.
2. **`/chat` entry deviates from the brief's list**: `queries` = groups only; agents, models and
   limits are in `then`, after `fetchQuery(readiness)` (shared with the shell's read), and only for
   a ready org — the existing test "while the org is in setup, the page renders nothing" asserts no
   agents read. The recent agent now comes from the sidebar's default groups query instead of a
   separate `?perGroup=1&limit=1` read.
3. **`CONVERSATION_SIDE_KEYS` adds the conversation's extension views** to the brief's list (spec §6
   names "extension views" among the pieces).
4. **Focus refetch removed** for the sidebar groups and the conversation contributions (spec §5);
   their tests changed to invalidation. A missed `changed: title` before the stream opened no
   longer reaches the title bar until the row is stale (Q3); that test was removed.
5. **Tool info**: one query per (sorted) key set; a new tool key re-reads the whole set (previous
   answer kept meanwhile) instead of the old incremental per-key fetch.
6. **Skills**: the composer never reads skills on mount (prefetched by `then` on a first load);
   opening the `/` menu and a `skill.not_invocable` refusal read them fresh (`staleTime: 0`), as the
   tests require.
7. **`extensionPagesQuery` and `contributionsQuery` read the same endpoint under two keys** (two
   reads when both are cold). Merging them would change the shell's dehydrated shape; left as is.
8. **Test-only**: `notifyManager.setScheduler(cb => cb())` in `test/setup.ts`, so stream events
   emitted inside `act` render before assertions; `testQueryClient` sets `retryDelay: 0`.
9. `useWorkspace` (Task 4) still builds `readinessQuery(orgId ?? "")` with `enabled: false`; the
   carried note was AppFrame's, which is fixed; useWorkspace left untouched.
10. The conversation's error state uses `ErrorFrame`, whose retry also calls `router.refresh()`.
11. The "mapper bug propagates" half of the R5 test was removed: the members mapper it exercised no
    longer exists (the query keeps the raw answer).
12. `/p/[plugin]/[id]/view.tsx` was touched (API change of `useExtensionViews`); its server read
    is still Task 13's.
13. Stream-resume bookkeeping (`deliveredBy` WeakMap per QueryClient) is module state written only
    in effects (browser only).
14. Intermediate commits (c) and (d) carried interim seeding of the snapshot into the cache
    (removed in (e)); each commit was green on its own.

---

# Fix round 1 (commit 3d705ee8 `fix(web): titles and events survive a late stream and a refresh`)

## Changes
1. **Late title** (`useConversation.ts`): `onOpen` reads the row once per mount when the cached
   row's `title === null` (invalidates `row()`); a named conversation reads nothing on open.
2. **Events never replaced by a hydrate** (`lib/query/conversation.ts` `mergeHydratedEvents`,
   `components/HydrateCache.tsx`): before `HydrationBoundary`, every dehydrated conversation-log
   entry whose key the cache already holds gets the cached and the server lists merged by seq, so
   a newer `dataUpdatedAt` can only add events. `eventsQuery` doc: never refetched wholesale while
   cached; hydrations merge.
3. **Catch-up and resume point** (`useConversation.ts`): the catch-up flag is a ref; a send
   (`postMessage`) or a `merge` (queued send / send-now) ends the current open's catch-up, so the
   events answering a person's own send trigger no side-key round. `deliveredOf(qc)` subscribes once
   per client to the query cache: a non-manual `success` of a conversation's events query (a whole
   read, e.g. after gc) drops that conversation's resume point, so the next open resumes at the
   log's end.

## Tests (`test/conversation-cache.test.tsx`, +6; `conversation-page.test.tsx` 1 adjusted)
- `a title generated before the stream opened appears without a navigation` (row read once,
  reconnect reads nothing more)
- `returning to a named conversation within 30 s with no new event reads nothing but the stream`
  (renamed/converted to a named row; the page-level return test already used a named row)
- `an older server list never drops what the stream appended` ([1..5] + hydrate [1..3] newer →
  [1..5]); `a longer server list adds its new events` ([1..5] + [1..6] → [1..6])
- `a person's own send after an idle open is no catch-up: no side keys are read`
- `a return after the log was dropped (gc) resumes after the log read whole, not the old point`
- conversation-page `an open of a named conversation that delivers no event reads nothing outside
  the log` (was untitled; an untitled one now reads its row once, by design)

RED (each fix reverted at once): 4 of the new tests failed (older-server-list, late title, own send,
gc resume); GREEN after restore: 21/21.

## Commands and output
- `pnpm exec vitest run apps/web/test/conversation-cache.test.tsx` → 21 passed
- `pnpm exec vitest run apps/web/test` → Test Files 81 passed, Tests 1497 passed
- `pnpm --filter @capybara-hq/web typecheck` → clean
- `pnpm exec biome check apps/web` → no fixes, clean
- `pnpm check:web-ui` → Web UI rules check passed
