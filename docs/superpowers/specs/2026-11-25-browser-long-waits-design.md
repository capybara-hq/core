# Browser long waits: a watched input wait that parks the run without model turns

Status: draft for maintainer review (2026-11-25). Issue: capybara-hq/plugins#207 (follow-up of the
browser use line, core#816, ruling R33). Repositories: capybara-hq/core (SDK, kernel, web),
capybara-hq/plugins (`browser`; the channel plugins `lark`, `slack`, `telegram` for one card state).
Parent spec: `2026-11-23-browser-use-design.md` (§9 said "`wait` with a long cap uses the same
mechanism" as the handoff; this spec designs it). The maintainer delegated the design decisions; each
is recorded as a ruling in §10.

## 1. Why

`browser_wait` is capped at 60 s (`WAIT_MAX_MS` in `plugins/browser/src/tools.ts`, `MAX_WAIT_MS` in
`daemon/actions.ts`), because the handler holds the run's worker, the conversation lock and one
service request for the whole wait. A longer wait ("until the export finishes", "until the order page
says Paid", "until the person finishes paying on their phone") costs one model turn per minute, burns
tokens and context, and dies with the replica.

The kernel already parks runs without model turns: a handler that returns `InputRequired` becomes a
`questions` row, the run goes `waiting` (`runtime/waits.ts`), and a person's answer, the deadline
(`wait-timeout` job) or a stop resumes or ends it, on any replica. What it lacks is a way for a
**condition outside the kernel** to settle the wait. This spec adds exactly that.

## 2. Goals, non-goals

Goals

1. A `browser_wait` longer than 60 s parks the run: no model turn, no worker held, no conversation
   lock held, survives replica restarts.
2. It resumes when the condition holds (text appears, element appears, URL contains a string, a
   navigation finishes, a download finishes), when the deadline passes, when the person ends the wait,
   or when the person sends a message (the existing skip).
3. The daemon in the device observes the condition and latches the event; the kernel learns it by
   polling the daemon through the existing service request path.
4. The kernel mechanism is generic (an extension tool's "watched input wait"), not browser-specific;
   the kernel never parses the browser protocol.

Non-goals

- A push channel from a device service to the kernel (§9: considered and rejected for now).
- Waits of 60 s or less change nothing: they stay in-call, without a card.
- A long wait without a condition (a sleep): the agent has scheduled tasks for "later"; a plain timed
  `browser_wait` stays capped at 60 s, so a device is never kept up just to sleep.

## 3. Terms

- **Watched input wait** (watched wait): an `InputRequired` with a `watch` part. Besides the person's
  answer and the deadline, the tool's **watcher** can settle it.
- **Watcher**: a function the extension registers with the tool; the kernel calls it every 10 s while
  the wait is pending; it answers `settle` or `pending`.
- **Watch** (daemon side): a condition armed in the browser daemon with an id; the daemon evaluates it
  continuously and latches the first outcome. Each poll is also the watch's heartbeat.
- **Woken**: the question status of a watched wait the watcher settled.

## 4. Shape

```
 browser_wait (timeoutMs > 60 s, one condition)
   1st invocation ── daemon: watch_start {watchId, condition, deadline} ── returns InputRequired+watch
                                                                         │
 kernel: question row (expires_at = deadline) + outbox: tool-watch-<qid> │ run → waiting
                                                                         ▼
 tool-watch job (worker role, every 10 s) ── watcher(state) ── daemon: watch_poll {watchId}
        pending → re-delay                     settle → question woken → run resumed
                                                                         │
   2nd invocation (resume) ── daemon: watch_end {watchId} ── tool result (met / timeout / ended)
```

## 5. Kernel and SDK (core)

### 5.1 SDK contract

```ts
export interface InputRequired {
  kind: "input_required";
  form: InputForm;
  state?: unknown;
  /**
   * A watched wait: besides the person's answer and the deadline, the tool's registered watcher may
   * settle it. deadlineMs is bounded by tools.approvalTimeoutHours.
   */
  watch?: { deadlineMs: number };
}

/** What a watcher gets: the call's context as the handler got it, without resume, plus the state. */
export interface ToolWatchContext extends Omit<ToolCallContext, "resume"> {
  state: unknown;
}
export type ToolWatcher = (ctx: ToolWatchContext) => Promise<"settle" | "pending">;

// ctx.tools
register(spec: ToolSpec, handler: ToolHandler, opts?: { watch?: ToolWatcher }): void;

// DeviceAccessErrorCode gains "not_running" (only a watcher's request gets it, §5.3)
```

- `call.resume` is unchanged: `{ state, answer }`, with `answer` the person's answer when they ended
  the wait from the card, and `null` when the watcher settled it or the deadline passed. The handler
  decides the outcome by asking its own source of truth (for the browser: the daemon's latched watch),
  never by how it was woken (a condition that held at the very deadline is still a success).
- A watcher must be cheap: the kernel aborts it after `TOOL_WATCH_TIMEOUT_MS` (5 s) through
  `ctx.signal`, which counts as a failure.
- A watcher is called only while the question is pending, never twice at once for one wait, never
  after the wait settled. `reportBlockedHosts` calls made in it are dropped (no call result carries
  them; the resumed handler reports them).

### 5.2 Questions

- `QuestionsService.ask` takes the watch: `expires_at = now() + least(deadlineMs, approvalTimeoutHours)`;
  the spec JSON keeps `watch: true`; `question_asked` gains `watch: true` (display only, the web draws
  a wait card, §5.5). In the same transaction it owes the first `tool-watch` job through the outbox
  (`runAt = now + 10 s`), as the suspend owes `wait-timeout`.
- New status `woken` (migration widening `questions_status_check`, as `0108_question_skipped.sql`
  did). `QuestionsService.wake(questionId)` in its own transaction: conversation row lock, then the
  question row (`FOR UPDATE`, D7 order); still pending and not expired → `status = 'woken'`,
  `answered_at = now()`, `question_answered { outcome: "woken", answer: null, byAccountId: null }`,
  then `RunResume.resumeIn(runId, questionId)` in the same transaction. Anything else → no-op.
  A run still `running` (the first poll raced the suspend) is resumed by the suspend's re-check, as
  for an early answer (`Waits.suspend` → `isSettled` sees a non-pending question).
- The pipeline's `processCall` already resumes a non-pending, non-skipped round with `answer: null`
  for anything but `answered`: `woken` needs no change there. `askInput` gains two checks: a `watch`
  from a tool without a registered watcher → error text
  `Tool <key> asked for a watched wait but registers no watcher.`; `deadlineMs` not a positive finite
  number → the invalid-form text family.
- A watched wait skipped by the person's message gets its own kernel-written result (the
  `INPUT_SKIPPED_TEXT` wording is about input that was never requested here):
  `WAIT_SKIPPED_TEXT = "The user sent a message while this wait was running, which ended it; read the
  message below and continue. Call the tool again only if the wait is still needed."` (a logged
  `tool_result`, so no `DriftReason`).
- Unattended runs (scheduled tasks, `fail` mode): a watched wait is allowed (it needs nobody); the
  card's end control simply goes unused. Unwatched input requests stay refused there.
- `runtime.maxRunSeconds` does not count the wait, as for any waiting run (the config text already
  says time spent waiting is not counted).

### 5.3 The `tool-watch` job

- Queue `cap-kernel-tool-watch` (new, its own worker so a slow device never delays the maintenance
  queue's wait timeouts and stop trees), concurrency 10, provided only under `WorkerModule`. Job id
  `tool-watch-<questionId>` (no `:`), data `{ orgId, questionId, failures }` (`runJob` takes the org
  scope from `orgId`); registered in `OUTBOX_JOBS`.
- One run of the job:
  1. Read the question, its run and conversation (`// org-filter: questionId comes from the
     kernel-written job payload`). Not pending, or expired → done (the timeout job owns expiry).
  2. Resolve the tool from the question's `toolKey` on this replica: an extension tool whose
     extension is enabled in the org and loaded, with a watcher. Otherwise → `wake` now (the resumed
     call then gets the pipeline's ordinary unavailable-tool result).
  3. Build the `ToolWatchContext` as the pipeline builds a handler's context (trigger account from
     `runs.trigger_account_id`, owner from `conversations.account_id`, role, source, agent, the same
     `callId` and `idempotencyKey`, the effective org config), plus a call scope marked `watch` with
     the run facts, so `ctx.deviceAccess` resolves the conversation's device and applies the owner
     rule as in a call.
  4. Call the watcher with `AbortSignal.timeout(5 s)`. `settle` → `wake`. `pending` → reset
     `failures`, `job.moveToDelayed(now + 10 s)` + `DelayedError` (the existing pattern of
     `wait-timeout`). A throw → `failures + 1`; at 3 consecutive failures → `wake` (the resumed handler
     reports what is wrong); else re-delay.
- **A watcher never resumes or starts anything.** In a `watch` call scope, `ctx.deviceAccess.request`
  runs only on a running instance with the service running (`DeviceServices.request` with
  `ifRunning`, like the existing `ifRunning` ensure); otherwise it rejects with `DeviceAccessError`
  `not_running`, which the browser's watcher answers with `settle` (§6.1). `ensureService` and the
  other scope-less calls are refused in a watch scope.
- A watcher's request on a running instance counts as device use (it refreshes the instance's last
  use, as every service request does), so idle suspension does not end a parked wait's browser. The
  wait's deadline bounds it (at most `tools.approvalTimeoutHours`, default 24 h), and the person can
  end it from the card. Without that use, the device would suspend and the watch be lost.
- No in-process state: everything is the question row and the job. Two replicas cannot double-wake:
  `wake` is conditional on `pending` under the row lock, and BullMQ runs one job id once at a time.

### 5.4 Replay and the event log

- Model-visible input stays inside tool results (the resumed handler's, or `WAIT_SKIPPED_TEXT`);
  `question_asked` / `question_answered` are not model-visible (`runtime/context/build.ts` skips
  them). No `DriftReason`.
- Full-run replay (`RecordedToolPipeline`) returns the recorded result and never creates questions
  or polls. Step replay is unaffected.
- `question_answered.outcome` gains `woken`: the event union in the kernel, the web
  (`apps/web/src/lib/conversations.ts`, `trajectories.ts`) and the trajectory builder
  (`evals/trajectory.ts`).

### 5.5 Web and IM

- Web `QuestionCard`: a question with `watch: true` renders as a wait: the form's title (the
  extension's localized text, e.g. 智能体正在等待：页面出现“支付成功”), the deadline, and the form's
  control (the browser's: 结束等待). Status `woken` reads 等待已结束 / Wait ended; `expired` on a
  watched question reads 等待已超时 / Wait timed out. zh + en through i18n.
- IM: the channel card spec's question `state` gains `woken` (`packages/plugin-sdk/src/cards.ts`;
  the same name as the question status, one fact one name); `renderCardAsText` and the official channel
  plugins (`lark`, `slack`, `telegram`) label it 等待已结束 / Wait ended. The kernel sends `woken`
  only from the release that ships it; the channel plugins with the label are released and pinned
  first (they only gain a label; the order is in the plan).

## 6. The browser plugin (plugins)

### 6.1 Tool

`browser_wait` keeps one tool and one schema; the cap rises for waits with a condition:

- `timeoutMs` max `86_400_000` (24 h; the kernel bounds it to `tools.approvalTimeoutHours` anyway).
  Description: waits of 60 s or less run in the call; a longer wait needs a condition, parks the run
  and returns when the condition holds or the time passes, "without using turns: prefer one long wait
  over repeated short ones".
- New conditions besides `text`, `ref`, `navigation`: `urlContains` (the active tab's URL contains the
  string) and `download` (`true`: the next download finishes saving into the workspace). At most one
  condition; more → ToolError. No condition and `timeoutMs > 60 s` → ToolError: `A wait longer than
  60000 ms needs a condition (text, ref, urlContains, navigation or download); to continue later
  without one, finish and let the user or a scheduled task start a new run.`
- `≤ 60 s`: unchanged path (`op: "wait"`), the new conditions included.
- `> 60 s`, first invocation: `watch_start` to the daemon (§6.2) with `watchId` = first 32 hex chars of
  `call.idempotencyKey` (stable across rounds, unique per logical call; the kernel always passes it,
  its absence is a ToolError), the condition, the active tab and `deadline` (absolute ISO). Then
  return:

  ```ts
  { kind: "input_required",
    form: { title: <localized "The agent is waiting until …">, fields: [
      { key: "end", label: <结束等待 / End the wait>, schema: { type: "string", enum: ["end"] },
        required: true } ] },
    state: { watchId, deadline, condition },
    watch: { deadlineMs } }
  ```

- Watcher (registered with the tool): `request({ op: "watch_poll", watchId })` with a 4 s timeout;
  `met` / `ended` / `unknown` → `settle`; `pending` → `pending`; `DeviceAccessError` `not_running` →
  `settle` (the daemon or the instance stopped: the handler finds out); any other error → throw
  (counted by the kernel).
- Resume: `runRequest({ op: "watch_end", watchId })` (with `ensureService`, as every handler request):
  - `met` → result: page line plus `Waited <duration>: <condition> (<detail, e.g. the download's path>).`
  - `ended` with reason `dialog` → result: `The page opened a dialog while waiting.` plus the dialog
    line (`2026-11-25-browser-dialogs-and-touch-design.md` §5).
  - `ended` with reason `tab_closed` → ToolError: `The tab being watched was closed; check the tabs
    with browser_tabs.`
  - `pending` (not met) and `call.resume.answer?.end` set → ToolError: `The user ended the wait before
    <condition>; ask the user how to continue.`
  - `pending` and past the deadline → ToolError timeout text as today's: `<condition> did not happen
    within <duration>. Check the page with browser_snapshot, then retry or call browser_wait.`
  - `unknown` (the daemon restarted or dropped the watch) → one immediate check of the condition (a
    0 ms `op: "wait"`); met → success as above; otherwise ToolError: `The browser restarted while
    waiting; the condition does not hold now. Call browser_wait again if still needed.`
  - The takeover note (`userControlledSince`) comes with the reply as for every tool (§9 of the parent
    spec), so a person who drove the browser during the wait is reported.

### 6.2 Daemon

- `ToolRequest` gains
  `{ op: "watch_start"; watchId; tabId; condition: WaitCondition; deadline: string }`,
  `{ op: "watch_poll"; watchId }`, `{ op: "watch_end"; watchId }`, where
  `WaitCondition = { text } | { ref } | { urlContains } | { navigation: true } | { download: true }`.
  `ToolReply` (ok) gains `watch?: { state: "pending" | "met" | "ended" | "unknown"; reason?: "dialog" |
  "tab_closed" | "deadline"; at?: string; detail?: string }`.
- Watch ops are bookkeeping, not agent input: allowed while the person holds control (the person may be
  the one making the condition true), not serialized behind agent actions, and they do not drop a
  pending handoff (`DaemonState.dropHandoff` is for agent tool requests).
- `watch_start` is idempotent per `watchId`. It binds to the tab given, evaluates the condition
  continuously (builder's call: Playwright `waitFor` with the remaining time, or a 500 ms check loop)
  and latches the first outcome with its time: `met`, or `ended` (a held dialog opened on the tab, per
  the dialogs spec; the tab closed; or the deadline passed). A download watch is met by the first download started after the
  watch and saved into the workspace (detail: its path).
- `watch_poll` returns the latched state and is the watch's heartbeat; `watch_end` returns it and
  forgets the watch; an unknown id answers `unknown`.
- **Heartbeat**: a watch not polled for `WATCH_HEARTBEAT_MS` (2 min, 12 missed polls) is dropped. A
  pending watch keeps the daemon from its idle stop only while it is polled. So a watch whose run was
  stopped, skipped by a message or lost with an aborted first round costs at most 2 minutes, and a
  kernel outage longer than that ends in `unknown` → the handler's immediate check (honest, never
  stuck).
- At most `MAX_WATCHES` (16) watches; a 17th start drops the oldest latched one, else the oldest.
- Viewers: `state.waiting?: { label: string; until: string }` (the newest pending watch) so the panel's
  status line reads 智能体：等待页面出现“…”（至 15:30） instead of showing an idle browser.

## 7. Multi-replica and failure cases

| Case | Behaviour |
|---|---|
| Replica dies mid-wait | Nothing is in memory: question row + `tool-watch` job + `wait-timeout` job. |
| Poll fires before the run reached `waiting` | `wake` settles the question; the suspend's re-check resumes. |
| Answer, wake and timeout race | All lock the question row; the first wins, the others are no-ops. |
| Plugin disabled or upgraded mid-wait | Watcher missing on poll → wake → the resumed call hits the pipeline's unavailable-tool result (or the new version's handler, which finds the watch by id). |
| Device suspended, destroyed or daemon stopped | The watcher's request gets `not_running` (never resumes the device) → settle → handler's `ensureService` + `watch_end` → `unknown` → immediate check. |
| Run stopped | `cancelPendingIn` cancels the question; the next poll sees it settled and ends; the daemon drops the watch after 2 min without polls. |
| Person sends a message | Skip with `WAIT_SKIPPED_TEXT`, handler not called; the watch is dropped after 2 min. |
| Taken over during the wait | Polls continue; the result carries the takeover note. |
| Workers down for more than 2 min | The daemon drops the watch; the next poll gets `unknown` → settle → immediate check. |

## 8. Security

- The watcher runs with the same identity and checks as the tool call (owner rule, device scope,
  extension enabled in the org); a poll cannot reach another device or conversation, and it can
  neither start a service nor resume an instance.
- No new route, no new permission: a watched wait is still the extension's own tool call.
- The question form is the extension's, rendered by the kernel's validated form path; the watch adds
  no model-controlled text to the card beyond what a form title already allows.

## 9. Approaches considered

- **Watched input wait polled by a kernel job (chosen)**: reuses questions, waits, resume, skip,
  stop, cards, timeouts; one migration, one queue, one SDK addition; the kernel stays protocol-blind.
  Cost: up to 10 s from the condition holding to the resume (against a wait of over a minute), one
  small request every 10 s per parked wait.
- **Push from the daemon** (a device-to-kernel event channel): instant, no polling; needs a new upward
  path through every provider (dial-in, docker, e2b) and a kernel endpoint to authenticate service
  events. Too much for a wait whose minimum is a minute. Rejected; the daemon's latch makes a later
  switch to push a transport change only.
- **Long-poll from the job** (a 25–50 s request that returns when the condition holds): instant, but
  holds a worker slot per wait and a relay slot per local device. Rejected.
- **A new wait kind next to `approval` / `input` / `subagents`**: duplicates the question machinery
  (rows, timeout, skip, stop, cards, web). Rejected.
- **End the run and wake it later** (as background tasks do): loses the call's pairing (the model would
  see a finished `browser_wait` and a later system note). The issue asks for a suspension. Rejected.
- **Loop inside the handler**: holds the worker and the conversation lock, dies with the replica.
  Rejected (it is the 60 s cap's reason).
- **Extension-chosen poll interval**: no second user; a kernel constant is simpler. Rejected (R3).
- **Mapping `woken` to the IM card's `answered`**: shows "answered" for something nobody answered.
  Rejected for a real card state (R7).

## 10. Rulings (designer, delegated by the maintainer)

- R1 Reuse `InputRequired` + questions with a `watch` part rather than a new wait kind.
- R2 The kernel polls a registered watcher; no device-to-kernel push.
- R3 Poll interval a kernel constant of 10 s; watcher timeout 5 s; 3 consecutive failures wake the call.
- R4 Waits ≤ 60 s stay in-call; only longer waits park (no card for quick waits).
- R5 The handler decides the outcome from the daemon's latched watch, never from how it was woken.
- R6 New question status `woken` (honest audit) instead of reusing `answered` / `expired`.
- R7 The IM question card gains state `woken`; channel plugins ship the label before the kernel emits it.
- R8 Watched waits are allowed in unattended runs.
- R9 A dedicated queue `cap-kernel-tool-watch` (concurrency 10), not the maintenance queue.
- R10 A watcher's request never resumes or starts anything (`not_running`), but counts as device use
  on a running instance; the deadline bounds the device's uptime.
- R11 The person ends a wait through a one-choice form (结束等待); a message also ends it, with its own
  `WAIT_SKIPPED_TEXT`.
- R12 New conditions `urlContains` and `download`; a dialog or a closed tab ends a watch.
- R13 Watch id = first 32 hex chars of `idempotencyKey`; the daemon keeps at most 16 watches.
- R14 Polls are the watch's heartbeat: 2 min without one drops it.
- R15 A wait over 60 s needs a condition; no long sleeps.

## AGENTS.md rules touched

- **Tools**: `InputRequired` gains `watch` and `ctx.tools.register` an optional watcher; the
  writing-tools skill's InputRequired section documents the watched wait, its limits, `woken` and
  `WAIT_SKIPPED_TEXT`.
- **Multi-replica discipline**: new queue `cap-kernel-tool-watch` (no `:`), deterministic job id
  `tool-watch-<questionId>`, owed through the outbox in the ask's transaction and registered in
  `OUTBOX_JOBS`, consumed only under `WorkerModule`; no in-process state; wake under the D7 lock order.
- **Migrations**: one migration widening `questions_status_check` with `woken` (the style of 0108);
  no new `org_id` table.
- **Runtime and replay**: no new model-visible input outside tool results; `question_answered`
  outcome `woken` is not model-visible, so no `DriftReason`; replay-evals skill notes it.
- **Device access**: watcher polls go through `ctx.deviceAccess.request` under the owner rule, never
  resume or start anything, and count as device use on a running instance.
- **Channels**: the question card state gains `woken`.
- **Public API reports**: SDK changes (`InputRequired.watch`, `ToolWatcher`, `register` options,
  `DeviceAccessErrorCode` `not_running`, card state `woken`) need `pnpm gen:sdk-api` and a changeset
  on `@capybara-hq/plugin-sdk`.
