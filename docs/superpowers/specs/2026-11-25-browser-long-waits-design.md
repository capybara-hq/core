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

// ToolCallContext.resume gains the round's outcome
resume?: { state: unknown; answer: FormAnswer | null;
  /** How the input round ended: the person answered, the watcher woke it, or the deadline passed. */
  outcome: "answered" | "woken" | "expired" };

// ctx.deviceAccess.request gains ifRunning; DeviceAccessErrorCode gains "not_running"
request(call, req: { service: string; body: Uint8Array; timeoutMs: number; ifRunning?: boolean })
```

- `call.resume` gains `outcome` (every resumed round has one; `cancelled` and `skipped` rounds never
  resume): `answered` with the person's answer, `woken` and `expired` with `answer: null`. The handler
  still asks its own source of truth first (for the browser: the daemon's latched watch), so a
  condition that held at the very deadline is a success whatever the outcome; `outcome` tells it what
  happened when the condition did not hold (the person ended it, the deadline passed, or the kernel
  woke it early: watcher failures, a missing watcher, a stopped device). The kernel's deadline may be
  shorter than the one asked (clamped to `tools.approvalTimeoutHours`): `expired` covers it, so the
  extension never needs to know the clamp.
- `ifRunning: true` on `request`: only a running instance with the service running answers; otherwise
  `DeviceAccessError` `not_running`, and nothing is resumed or started. Any handler may pass it (the
  browser's resumed wait does, §6.1); in a watcher's context the kernel forces it.
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
  `tool_result`, so no `DriftReason`), `isError: false` (ending a wait by writing is not a tool
  failure), display summary 等待因新消息结束 / Wait ended by your message.
- A cap on parked waits: at most `tools.maxWatchedWaitsPerAccount` (config, default 10) pending watched
  questions per run trigger account, checked in `askInput`; over it → error text `Too many waits are
  running for this user; end one, or finish and let a scheduled task check later.`
- Unattended runs (scheduled tasks, `fail` mode): a watched wait is allowed (it needs nobody); the
  card's end control simply goes unused. Unwatched input requests stay refused there. While such a run
  is parked, the task's later ticks are skipped as `overlap` (`schedules/fire.ts`), as for any long
  run; the writing-tools skill and the browser tool text say so.
- `runtime.maxRunSeconds` does not count the wait, as for any waiting run (the config text already
  says time spent waiting is not counted).

### 5.3 The `tool-watch` job

- Queue `cap-kernel-tool-watch` (new, its own worker so a slow device never delays the maintenance
  queue's wait timeouts and stop trees), concurrency `tools.watchConcurrency` (config, default 50: polls are I/O-bound), provided only under
  `WorkerModule`; listed in `KERNEL_QUEUES` and `KERNEL_QUEUE_NAMES` like every kernel queue. Job id
  `tool-watch-<questionId>` (no `:`), data `{ orgId, questionId, failures }` (`runJob` takes the org
  scope from `orgId`); registered in `OUTBOX_JOBS`.
- One run of the job:
  1. Read the question, its run and conversation (`// org-filter: questionId comes from the
     kernel-written job payload`). Not pending, or expired → done (the timeout job owns expiry).
  2. Resolve the tool from the question's `toolKey` on this replica and pass **the pipeline's own
     pre-call gate** (extracted from `ToolPipeline.execute` into one function both use: extension
     enabled in the org and loaded, the org's single-tool switch not off (`isToolOff`), the effective
     config valid (`needsConfig` otherwise)), and a registered watcher. Any refusal → `wake` now and
     the watcher is not called (the resumed call then gets the pipeline's own refusal text).
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
  is forced to `ifRunning` (`DeviceServices.request` with `ifRunning`, like the existing `ifRunning`
  ensure): a stopped instance or service rejects with `not_running`, which the browser's watcher
  answers with `settle` (§6.1). `ensureService` is refused in a watch scope.
- A watcher's request on a running instance counts as device use (it refreshes the instance's last
  use, as every service request does), so idle suspension does not end a parked wait's browser. The
  running-time limit still applies: `sandbox.limits.maxRunningMinutes` (default 120) suspends an
  instance even while in use, so **the effective bound of a wait is
  `min(tools.approvalTimeoutHours, the device's remaining running time)`**; past it the watcher gets
  `not_running` and the call ends honestly without resuming the device (§6.1). The person can end a
  wait from the card at any time.
- `wake` notifies the event log and emits `question.answered` (outcome `woken`) after its commit, as
  `answer` does, so the card refreshes over SSE and the IM card is updated.
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
  control: a required single-choice field with one value renders as one button (结束等待), not a
  radio plus submit. Status `woken` reads 等待已结束 / Wait ended; `expired` on a
  watched question reads 等待已超时 / Wait timed out. zh + en through i18n. A sub-agent's watched
  wait surfaces in the root as `subagent_waiting`, which gains `watch: true` so the root card renders
  the same wait card.
- IM: the channel card spec's question `state` gains `woken` (`packages/plugin-sdk/src/cards.ts`;
  the same name as the question status, one fact one name); `renderCardAsText` and the official channel
  plugins (`lark`, `slack`, `telegram`) label it 等待已结束 / Wait ended. The kernel sends `woken`
  only from the release that ships it; the channel plugins with the label are released and pinned
  first (they only gain a label; the order is in the plan).

## 6. The browser plugin (plugins)

### 6.1 Tool

`browser_wait` keeps one tool and one schema; the cap rises for waits with a condition:

- `timeoutMs` max `86_400_000` (24 h; the kernel bounds it further). Description: waits of 60 s or
  less run in the call; a longer wait needs a condition, parks the run and returns when the condition
  holds or the time passes, "without using turns: prefer one long wait over repeated short ones";
  "a long wait also ends when the device reaches its running limit (often 2 hours) or the input
  timeout; in a scheduled task it holds the task's next runs back".
- New conditions besides `text`, `ref`, `navigation`: `urlContains` (the active tab's URL contains the
  string) and `download` (`true`: the next download finishes saving into the workspace). At most one
  condition; more → ToolError. No condition and `timeoutMs > 60 s` → ToolError: `A wait longer than
  60000 ms needs a condition (text, ref, urlContains, navigation or download); to continue later
  without one, finish and let the user or a scheduled task start a new run.`
- `≤ 60 s`: unchanged path (`op: "wait"`), the new conditions included.
- `> 60 s`, first invocation: `watch_start` to the daemon (§6.2) with `watchId` = first 32 hex chars of
  `call.idempotencyKey` (stable across rounds, unique per logical call; the kernel always passes it,
  its absence is a ToolError), the condition, the active tab and `remainingMs` (the daemon computes
  its own absolute deadline with the device's clock, which may differ from the kernel's). Then
  return:

  ```ts
  { kind: "input_required",
    form: { title: <localized "The agent is waiting until …">, fields: [
      { key: "end", label: <结束等待 / End the wait>, schema: { type: "string", enum: ["end"] },
        required: true } ] },
    state: { watchId, startedAt, condition },
    watch: { deadlineMs } }
  ```

- Watcher (registered with the tool): `request({ op: "watch_poll", watchId }, ifRunning)` with a 4 s
  timeout;
  `met` / `ended` / `unknown` → `settle`; `pending` → `pending`; `DeviceAccessError` `not_running` →
  `settle` (the daemon or the instance stopped: the handler finds out); any other error → throw
  (counted by the kernel).
- Resume: `request({ op: "watch_end", watchId }, ifRunning)`, **without** `ensureService`: a resumed
  wait never resumes the device or starts a new browser just to find the page gone.
  - `not_running` → ToolError: `The device stopped while waiting (it was suspended or reached its
    running limit); the page state is gone. Call browser_wait again if still needed.`
  - `met` → result: page line plus `Waited <duration>: <condition> (<detail, e.g. the download's path>).`
  - `ended` with reason `dialog` → result: `The page opened a dialog while waiting.` plus the dialog
    line (`2026-11-25-browser-dialogs-and-touch-design.md` §5).
  - `ended` with reason `tab_closed` → ToolError: `The tab being watched was closed; check the tabs
    with browser_tabs.`
  - not met (`pending`, or `ended` with reason `deadline`), by `call.resume.outcome`:
    `answered` → ToolError `The user ended the wait before <condition>; ask the user how to
    continue.`; `expired` or `ended/deadline` → ToolError timeout text as today's with the elapsed
    time: `<condition> did not happen within <elapsed>. Check the page with browser_snapshot, then
    retry or call browser_wait.`; `woken` → ToolError `The wait was interrupted after <elapsed>
    before <condition> (the browser service could not be checked). Call browser_wait again if still
    needed.` (no automatic re-arm: R16).
  - `unknown` (the daemon dropped or lost the watch while running) → one immediate check of the
    condition (a 0 ms `op: "wait"`, `ifRunning`); met → success as above; otherwise ToolError: `The
    browser lost track of the wait; the condition does not hold now. Call browser_wait again if still
    needed.`
  - The takeover note (`userControlledSince`) comes with the reply as for every tool (§9 of the parent
    spec), so a person who drove the browser during the wait is reported.

### 6.2 Daemon

- `ToolRequest` gains
  `{ op: "watch_start"; watchId; tabId; condition: WaitCondition; remainingMs: number }`,
  `{ op: "watch_poll"; watchId }`, `{ op: "watch_end"; watchId }`, where
  `WaitCondition = { text } | { ref } | { urlContains } | { navigation: true } | { download: true }`.
  `ToolReply` (ok) gains `watch?: { state: "pending" | "met" | "ended" | "unknown"; reason?: "dialog" |
  "tab_closed" | "deadline"; at?: string; detail?: string }`.
- Watch ops are bookkeeping, not agent input, and run in their own handler (like the handoff ops):
  allowed while the person holds control (the person may be the one making the condition true), not
  serialized behind agent actions, they do not drop a pending handoff (`DaemonState.dropHandoff` is
  for agent tool requests), and **`watch_start` / `watch_poll` neither take the hand-back note
  (`takeHandbackNote`) nor splice the `unreported` notes**, so those reach the resumed handler's
  `watch_end` reply (which does take them) instead of being lost to a poll whose reply the kernel
  discards.
- `watch_start` is idempotent per `watchId`. It binds to the tab given, evaluates the condition
  continuously (builder's call: Playwright `waitFor` with the remaining time, or a 500 ms check loop)
  and latches the first outcome with its time: `met`, or `ended` (a held JS dialog (confirm, prompt,
  beforeunload) opened on the tab, per the dialogs spec; a non-blocking `auth` dialog or a closed alert
  does not end it; the tab closed; or the deadline passed). A download watch is met by the first download started after the
  watch and saved into the workspace (detail: its path).
- `watch_poll` returns the latched state and is the watch's heartbeat; `watch_end` returns it and
  forgets the watch; an unknown id answers `unknown`.
- **Heartbeat**: a watch not polled for `WATCH_HEARTBEAT_MS` (10 min, below the daemon's 15 min idle
  stop) is dropped. A pending watch keeps the daemon from its idle stop only while it is polled. So a
  watch whose run was stopped, skipped by a message or lost with an aborted first round costs at most
  10 minutes, an ordinary rolling deploy or a poll backlog does not lose watches, and a longer kernel
  outage ends in `unknown` → the handler's immediate check (honest, never stuck).
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
| Device suspended (by the person, idle or `maxRunningMinutes`), destroyed, or daemon stopped | The watcher's request gets `not_running` (never resumes the device) → settle → the resumed handler's `ifRunning` `watch_end` gets `not_running` too → "the device stopped while waiting"; nothing is resumed. |
| Tool switched off or config invalid in the org mid-wait | The job's gate refuses → wake without calling the watcher → the pipeline's own refusal text. |
| Kernel deadline clamp shorter than the asked one | The question expires at the clamp → `outcome: "expired"` → timeout text with the elapsed time. |
| Run stopped | `cancelPendingIn` cancels the question; the next poll sees it settled and ends; the daemon drops the watch after 10 min without polls. |
| Person sends a message | Skip with `WAIT_SKIPPED_TEXT`, handler not called; the watch is dropped after 10 min. |
| Taken over during the wait | Polls continue without taking the hand-back note; `watch_end`'s reply carries it. |
| Workers down or polls backlogged for more than 10 min | The daemon drops the watch; the next poll gets `unknown` → settle → immediate check. |

## 8. Security

- The watcher runs with the same identity and passes the same pre-call gate as the tool call (owner
  rule, device scope, extension enabled, tool not switched off, valid effective config); a poll cannot
  reach another device or conversation, and it can neither start a service nor resume an instance.
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
  (Concurrency is config `tools.watchConcurrency`, default 50, after review I4.)
- R4 Waits ≤ 60 s stay in-call; only longer waits park (no card for quick waits).
- R5 The handler checks the daemon's latched watch first (met wins whatever woke it); when not met,
  the new `resume.outcome` (`answered` / `woken` / `expired`) tells it what happened (review I1).
- R6 New question status `woken` (honest audit) instead of reusing `answered` / `expired`.
- R7 The IM question card gains state `woken`; channel plugins ship the label before the kernel emits it.
- R8 Watched waits are allowed in unattended runs.
- R9 A dedicated queue `cap-kernel-tool-watch` (concurrency from config, default 50), not the
  maintenance queue.
- R10 A watcher's request and the resumed wait's `watch_end` never resume or start anything
  (`ifRunning`, `not_running`), but count as device use on a running instance; the effective bound is
  `min(approvalTimeoutHours, the device's remaining running time)` (review I2).
- R11 The person ends a wait through a one-choice form (结束等待); a message also ends it, with its own
  `WAIT_SKIPPED_TEXT`.
- R12 New conditions `urlContains` and `download`; a dialog or a closed tab ends a watch.
- R13 Watch id = first 32 hex chars of `idempotencyKey`; the daemon keeps at most 16 watches.
- R14 Polls are the watch's heartbeat: 10 min without one drops it (review I4; 2 min made deploys
  visible).
- R15 A wait over 60 s needs a condition; no long sleeps.
- R16 A wait woken early without the condition ends with an "interrupted" result; no automatic re-arm
  (the model decides whether to wait again; a re-arm would hide a broken device behind more rounds).
- R17 The watcher passes the pipeline's own pre-call gate (one extracted function), not a copy.
- R18 At most `tools.maxWatchedWaitsPerAccount` (default 10) pending watched waits per account.
- R19 Watch ops never take the hand-back note or the unreported notes; `watch_end` does.
- R20 The daemon gets `remainingMs`, never an absolute deadline (device clocks differ).
- R21 A parked unattended wait holds back the task's later ticks (`overlap`); documented, not clamped
  (the kernel cannot know a cron task's interval in general, and the person chose the wait).

## AGENTS.md rules touched

- **Tools**: `InputRequired` gains `watch` and `ctx.tools.register` an optional watcher; the
  writing-tools skill's InputRequired section documents the watched wait, its limits, `woken` and
  `WAIT_SKIPPED_TEXT`.
- **Multi-replica discipline**: new queue `cap-kernel-tool-watch` (no `:`, in `KERNEL_QUEUES`), deterministic job id
  `tool-watch-<questionId>`, owed through the outbox in the ask's transaction and registered in
  `OUTBOX_JOBS`, consumed only under `WorkerModule`; no in-process state; wake under the D7 lock order.
- **Migrations**: one migration widening `questions_status_check` with `woken` (the style of 0108);
  no new `org_id` table.
- **Runtime and replay**: no new model-visible input outside tool results; `question_answered`
  outcome `woken` is not model-visible, so no `DriftReason`; replay-evals skill notes it.
- **Device access**: watcher polls go through `ctx.deviceAccess.request` under the owner rule, never
  resume or start anything, and count as device use on a running instance.
- **Channels**: the question card state gains `woken`.
- **Config**: new kernel fields `tools.watchConcurrency` and `tools.maxWatchedWaitsPerAccount`
  (adding-config: `docs/config.md` regenerated).
- **Public API reports**: SDK changes (`InputRequired.watch`, `ToolWatcher`, `register` options,
  `ToolResume.outcome`, `request` option `ifRunning`, `DeviceAccessErrorCode` `not_running`, card
  state `woken`) need `pnpm gen:sdk-api` and a changeset
  on `@capybara-hq/plugin-sdk`.
