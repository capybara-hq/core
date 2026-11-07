# Conversation history: load the latest part first, scroll up for earlier

- Date: 2026-11-07, during the phase 3 acceptance of the plugin and component management work.
- Status: implemented on `fix/acceptance`.
- Amends: the kernel events route (`GET …/conversations/:id/events`), the web query cache spec
  (`2026-11-03-web-query-cache-design.md` §5, §6: the events cache), `docs/design/spec.md` §5.4
  (Thread scrolling).
- Markers: **(decided)** is the maintainer's answer; **(designer's call)** is decided here and may be
  overturned in review.

## 1. Why

The conversation page reads the whole event log page by page (`listAllEvents`), caches all of it
and builds the timeline from all of it. A long conversation (hundreds of events: sub-agent
questions, approvals, deliveries) loads and renders everything before the first paint. The
maintainer approved "load the latest part first, scroll up to load earlier" **(decided)**.

## 2. Kernel API

`GET /api/v1/orgs/:orgId/conversations/:id/events` gains `before`, exclusive with `after`
(both → 400 `validation`); `after` is unchanged.

- `?before=<seq>&limit=<n>`: the page that ends right before `seq`; `?before=end&limit=<n>`: the
  log's last page. Answer `{ events, turnsBefore }`, events in ascending seq.
- **Turn-aligned (designer's call):** the page holds the last `limit` events before `before`,
  extended back so its first event is the log's first or the first event after a run's end
  (`run_finished` / `run_failed` / `run_aborted`). No run, tool group, sub-agent group or held
  interjection is then cut at the page's top edge. The extension goes back at most
  `EVENTS_TURN_EXTEND` (2000) events; a run longer than that starts mid-run (§4 says how that
  renders).
- `turnsBefore`: how many runs started (`run_started`, distinct `run_id`) before the page's first
  event, so the status bar's "Turn N" stays right without the earlier events.
- Same auth as the route today: `agents.use`, the owner only (`conversation.not_found` for anyone
  else), service tokens 403. Reading it kicks a stalled run like `after` does.

Seqs are allocated contiguously from 1 per conversation (`conversations.last_seq`), so a client
knows it holds the beginning when its first event has seq 1.

## 3. Web cache

- `eventsQuery` holds a **window**: `{ events, turnsBefore }`, a contiguous suffix of the log.
  Its read is `before=end&limit=200` (`HISTORY_PAGE`, events, not turns: a turn can be 3 events or
  300, and the kernel aligns to turns anyway). SSR prefetches the same read, so the first paint is
  the last page.
- `loadEarlierEvents(qc, …)` reads `before=<first seq>` and prepends (merge by seq,
  `turnsBefore` from the answer). It is an imperative cache merge like `catchUpEvents`, not a new
  query key: the window is one cached object the stream appends to.
- The stream (`/stream?after=`) and `catchUpEvents` append at the end as before; the resume point
  is still the window's last seq.
- `mergeHydratedEvents` unites the cached window and a later server render's by seq when they
  overlap or touch; when they are disjoint (a gap) the server's wins, so the window stays
  contiguous.
- `seedNewConversation` seeds a window from seq 1 (`turnsBefore: 0`).

## 4. Timeline

The builder runs over the window. Because pages start after a run's end, every rendered run is
whole. What can still reference an event above the window degrades as it does today for missing
data, never wrongly: a `subagent_finished` / `subagent_waiting` whose `Agent` call is above the
window updates no row (its `delivery` / wait entries still render on their own), a `retryOf` whose
failed run is above shows a plain bubble, a `background_task_finished` names its task by its own
description. A handed-back child's 「X 已完成」 entry (drawn from `subagent_finished` and named
by its report, commit 357c5215) waits for the report's page when the report is above the window
and the finish below it: `subagent_finished` alone cannot tell a handed-back completion from
another, so the entry is never guessed; once the page loads the timeline is rebuilt from the whole
window and the entry appears exactly once (an old log's `handedBack` delivery is still deduped).
A window that starts mid-run (only past the 2000-event cap) renders that run's events
without its start: rows without a model, no held interjections. Old logs render unchanged.

## 5. Readers of the window

| Reader | With a partial window |
|---|---|
| Thread, run status (`reduceChat`), working line, awaited message, stop | The current run is in the last page (turn-aligned): unchanged |
| Status bar "Turn N" | `turnsBefore` + the window's runs |
| Context % and model (`latestUsage` / `latestModel`) | The newest usage is in the last page: unchanged |
| Sub-agents list, usage with sub-agents, agent tree, composer agents chip, agent map | Read from the server (`/subagents`, `/usage`, `/agent-tree`) also when the window is partial (a dispatch may be above it); the map and chip show once the log or the list names a sub-agent; a `#agents` hash waits for the list before it is dropped |
| Background tasks section | Read (`/background`) also when the window is partial |
| Files, queue, sandbox, tool info | Already server reads, or keyed by what the window shows |
| Stop under way | Ends on a run end **after** the click (the newest end's seq), so prepending older ends never releases it |
| Sandbox status re-read in Context | On a new sandbox result (the newest one's seq), not on the count, which prepending changes |
| Connectors used (Context section) | The loaded part of the log; grows as earlier pages load (accepted: no server summary exists) |
| A sub-agent's panel (`SubagentPanel`) | Same window and the same top edge as the page; the task line and header come in when the beginning loads (the description names it meanwhile) |

## 6. Scrolling (design spec §5.4)

- `ConversationPage.history` (`{ state: "more" | "loading" | "start" | "failed"; onLoadEarlier }`)
  draws `ThreadHistory` at the top of the thread: `more` an observed sentinel plus a "Load earlier
  messages" link (keyboard and no-observer fallback), `loading` one placeholder turn,
  `failed` a fail divider with Retry, `start` the divider "Beginning of conversation". The page
  passes `start` only after it loaded earlier pages, so a short conversation shows no marker
  **(designer's call)**.
- The sentinel's `IntersectionObserver` uses the nearest scroller as its root with a 600 px top
  margin, and is re-created on every state change, so a page that still leaves the sentinel in
  range loads the next one.
- Anchoring: the scroller is a reversed column, so its scroll offset is measured from the bottom
  and content prepended at the top does not move what is visible; browsers with scroll anchoring
  keep it too. `useFollowBottom`'s fallback for browsers without anchoring now keeps the topmost
  visible item still (measured before and after the growth) instead of the distance from the top,
  which would have shifted the view on a prepend.

## 7. Not changed

The event log, replay and anything model-visible; the `after` route; the trajectory viewer; the
CLI.
