# Messages during a run, and live drafts that survive a reload

- Date: 2026-11-07, during the phase 3 acceptance of the plugin and component management work.
- Status: implemented (plan `docs/superpowers/plans/2026-11-07-run-input-and-live-drafts.md`).
- Amends: AGENTS.md "Runtime" (queued messages), the web conversation page (composer, timeline,
  stream), `docs/design/spec.md` (composer, conversation timeline).
- Markers: **(decided)** is the maintainer's answer (2026-11-07); **(designer's call)** is decided here
  and may be overturned in review.

## 1. Why

Two things the maintainer met while trying the conversation page:

1. They sent "你能理解你自己吗？", then, while the reply was streaming, "哈哈" (queued by default), then
   pressed 立即发送. The "哈哈" bubble jumped **above** the reply it never saw. The kernel did the right
   thing (the message was absorbed at the next step, `model_call.request.absorbedUpToSeq`), but the
   timeline places user bubbles by `seq`, and the interjection's `seq` is lower than the
   `assistant_message` written when the step finished.
2. Two input modes (↵ queues for after the whole run, ⌘↵ interjects) are one more concept than
   Claude Code has: there, a message typed while the agent works is taken in before the next model
   request and the agent continues with it.
3. A reload, or leaving the conversation and coming back, loses the part of a streaming reply already
   shown: deltas are only published on the bus (`run-worker.ts` `sinkFor`) and never kept, so a
   reconnected viewer sees text resume mid-sentence until the step's `assistant_message` lands. The
   same happens when switching between two conversations that are both running.

## 2. Decisions

| # | Decision | Source |
|---|---|---|
| D1 | While a run is active, ↵ sends the message as an **interjection**: logged at once, taken in by the run before its next model request (as Claude Code does). There is no queue. | decided |
| D2 | ⌘↵ (Ctrl+↵) has no separate meaning any more; it sends like ↵. Stopping stays the stop button. | designer's call (the table offered "not needed, or stop then send"; a two-key stop is easy to hit by accident) |
| D3 | An interjection the run never takes in (the run's last model call was already under way and it ends with a final answer) starts the next run, as today (`model-call.ts` R31: "absorbed by a later step or triggers the next run"). | existing kernel behaviour |
| D4 | The timeline shows an interjection where the model took it in: below the step that was streaming when it was sent, before the step whose request absorbed it; until then it shows at the bottom as 待处理 (pending). Reload renders the same order from the log. | designer's call |
| D5 | Live drafts resume: on reconnect (reload, navigation back, switching conversations) a viewer receives the text and thinking already produced by every step still streaming, then the deltas from there on, without gaps or duplicates. | decided |

## 3. Kernel

### 3.1 Messages during a run (D1–D3)

- `POST …/conversations/:id/messages` already accepts a message while a run is active (it is logged and
  absorbed per R31). Nothing changes in the runtime or in replays: the log already records where each
  user message was taken in, so `reconstruct` and the zero-drift fixtures are unaffected.
- The queue goes away for new input (designer's call on the mechanics):
  - `POST …/queue` keeps working for older clients for one release but behaves as `POST …/messages`
    (an interjection when a run is active), answering the event; `GET …/queue` lists leftover items;
    `PATCH`, `DELETE`, `…/send` and `…/resume` keep working on leftovers so nothing is stranded.
  - Leftover queued rows are drained by the existing dispatcher after each run until empty; no
    migration deletes data (expand-only). The table and the routes are removed in a later release
    (contract step), recorded in the release notes.
  - AGENTS.md "Runtime" is updated: queued messages are replaced by interjections.
- A model / effort switch sent with an interjection is logged as today (`model_switched` just before
  it); the run in progress keeps its model, the switch applies from the next run (unchanged rule).

### 3.2 Live drafts (D5)

- The run worker keeps, per active run step, the draft produced so far in Redis
  (designer's call): key `run-draft:<runId>:<step>` holding `{ text, thinking }` appended in step with
  the published deltas, **coalesced** (written at most every 200 ms and at step end, so a fast model does
  not cost one Redis write per token), TTL 10 minutes refreshed on write, deleted when the step's
  `assistant_message` (or `step_reset`) is logged. Multi-replica: any replica's stream reads it.
- Every published `delta` already carries `offset` (characters of text before it in the step). A
  thinking delta gains the same `offset` for thinking.
- The SSE stream, on open, after its catch-up of logged events, sends one `event: draft` per step of an
  active run whose `assistant_message` is not logged yet: `{ runId, step, text, thinking }` from Redis,
  then forwards deltas as today. Deltas whose `offset` + length is ≤ the draft length are dropped by
  the client (already in the draft); a delta whose `offset` is beyond the draft (a gap: the snapshot
  was older than the coalescing window) makes the client ask for the draft again
  (`GET …/conversations/:id/runs/:runId/draft`, the same payload) before applying it.
- Access is the stream's (the viewer can read the conversation); the draft is model output the viewer
  will see in the log anyway, so it carries no new disclosure. Hooks never see drafts.

## 4. Web

- Composer: while a run is active, ↵ and ⌘↵ both send (D1, D2); the hint reads 「运行中发送的消息会在下一步交给智能体」
  / "Messages sent while it works reach it at its next step". The queue list, its edit / delete / send-now
  controls and the queue copy are removed; leftover queued items (D3 drain) show as pending bubbles until
  sent.
- Timeline (`apps/web/src/lib/timeline.ts`, the one builder): a user message with a `seq` above the
  absorbing step's `absorbedUpToSeq` is placed right before the first `model_call` whose
  `absorbedUpToSeq` covers it (D4); not yet absorbed and a run active → a pending bubble after the live
  draft; the run ended without absorbing it → it is the trigger of the next run, placed before it.
- Stream (`apps/web/src/lib/stream.ts`): handles `event: draft` (replaces the step's draft), drops
  covered deltas by `offset`, refetches the draft on a gap; a draft for a step already finalized in the
  log is ignored.
- The conversation page's stream stays open only while the page is shown (query cache spec §6); with
  D5 a viewer switching between two running conversations sees each draft complete on return.

## 5. Tests

- Kernel: draft written, coalesced, refreshed and deleted at step end / reset; `event: draft` on stream
  open for an active step and none for a finished one; the draft route's access; `POST …/queue` behaves
  as a message during a run; leftover queue items drain; dual-replica: a viewer on replica B gets the
  draft of a run on replica A.
- Web: timeline order for an interjection during a streaming step (sent before the reply's
  `assistant_message`, absorbed by the next request) on live and reload; pending bubble; ↵ during a run
  posts a message (no queue call); stream: snapshot then deltas, duplicates dropped, gap refetch.
- e2e: send during a streaming reply, reload mid-stream, the reply resumes without a gap; two running
  conversations, switch back and forth.
- Zero-drift replay fixtures unchanged (run before and after).

## 6. Not in scope

- Editing or recalling a message after it was sent.
- Showing other viewers' typing.
- Persisting drafts beyond their 10-minute TTL (a run that streams for longer keeps refreshing it).
