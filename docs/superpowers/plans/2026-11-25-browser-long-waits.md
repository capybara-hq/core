# Browser long waits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `browser_wait` longer than 60 s (with a condition) parks the run as a watched input wait
(no model turns, no worker held) and resumes when the daemon's watch latches the condition, the person
ends it, or the deadline passes.

**Architecture:** `InputRequired` gains a `watch` part and `ctx.tools.register` an optional watcher.
The kernel stores the wait as a `questions` row (deadline as `expires_at`), owes a `tool-watch` job
through the outbox, and the job polls the watcher every 10 s on the worker role; `settle` wakes the
question (new status `woken`) and resumes the run through the existing `RunResume`. A watcher's device
requests never resume or start anything. The browser plugin arms a watch in its daemon; its watcher
polls it (the poll doubles as the watch's heartbeat).

**Tech Stack:** NestJS kernel, BullMQ, Kysely/PG, `@capybara-hq/plugin-sdk`, Next web, the `browser`
and channel plugins, vitest (kernel integration tests with testcontainers).

**Spec:** `docs/superpowers/specs/2026-11-25-browser-long-waits-design.md`. Read it before any task.

## Global Constraints

- The kernel never parses the browser protocol; the watcher is the only extension code the job runs.
- Multi-replica: no timers or in-process maps in kernel or extension code (the daemon inside the
  device may keep timers); queue `cap-kernel-tool-watch`, job id `tool-watch-<questionId>`, no `:`;
  the first job owed through `OutboxService.add` in the ask's transaction and listed in `OUTBOX_JOBS`;
  consumers only under `WorkerModule`; question writes lock the conversation row, then the question
  row (D7).
- Constants: `TOOL_WATCH_INTERVAL_MS = 10_000`, `TOOL_WATCH_TIMEOUT_MS = 5_000`,
  `TOOL_WATCH_MAX_FAILURES = 3`; a missing watcher (extension off, unloaded, upgraded without one)
  wakes at once. Deadline: `least(watch.deadlineMs, tools.approvalTimeoutHours)`.
- In a watch call scope `ctx.deviceAccess.request` runs only on a running instance with the service
  running (`not_running` otherwise) and refreshes last use; `ensureService` is refused there.
- Waits ≤ 60 s stay in-call, unchanged and cardless; a longer wait needs a condition.
- No new model-visible input outside tool results; no `DriftReason`.
- Applied migrations immutable; the new migration follows `0108_question_skipped.sql`.
- SDK public API change: `pnpm gen:sdk-api` + changeset bumping `@capybara-hq/plugin-sdk`; kernel
  change: changeset on `@capybara-hq/kernel`; plugins: changesets per plugin.
- Kernel conventions (`pnpm check:kernel-conventions`): `@Inject` on every constructor parameter,
  one module per concern, config through `KernelConfigService`.
- UI text zh + en through i18n; zh says 智能体; apps/web writes no styles (`pnpm check:web-ui`).
- Tool texts English and actionable; tool keys without dots.
- New unit / container tests join `packages/kernel/test/unit-tests.json` / `container-tests.json` in
  the same commit; integration is the default.
- Comments in English (`pnpm check:english-comments --base origin/main`).
- Release order: channel plugins with the `woken` label (Task 8) are released and pinned before a
  kernel that emits `woken` reaches a deployment.

## Review Focus

1. **Answer, wake and timeout at the same instant**: exactly one settles the question, one
   `question_answered`, one resume. → Task 2 test `wake, answer and expire race: one wins`; Task 3
   container test `two workers poll one wait: one wake`.
2. **Poll before the run reached `waiting`**: the run still resumes once. → Task 3 test
   `a settle before the suspend resumes through the re-check`.
3. **A watcher touching a suspended device**: it must not resume it. → Task 3 test
   `watch scope request on a suspended device rejects not_running and resumes nothing`.
4. **Plugin disabled while a wait is parked**: the wait wakes at once and the call gets the
   unavailable-tool result, no stuck run. → Task 3 test `missing watcher wakes the call`.
5. **A message from the person during the wait**: `WAIT_SKIPPED_TEXT`, no handler call, no later
   wake. → Task 2 test `skipped watched wait is never woken`; Task 4 test `skip text of a watched wait`.

---

## Waves

| Wave | Tasks | Repo | Review |
|---|---|---|---|
| 1 | 1 | core | SDK contract; own review (public API) |
| 2 | 2, 4 | core | 2 own review on the most capable model (questions, migration, lock order); 4 batched |
| 3 | 3 | core | own review on the most capable model (multi-replica, queue, call identity, device access) |
| 4 | 5, 7 | core / plugins | disjoint; batched review (7 needs no SDK change) |
| 5 | 8 | plugins | channel labels; released and pinned before the kernel release (after the SDK rc) |
| 6 | 6 | plugins | after the core release carrying Tasks 1–5; own review |
| 7 | 9 | both | acceptance and release |

---

### Task 1: SDK contract: watched input waits

**Repo:** core

**Files:**
- Modify: `packages/plugin-sdk/src/tool.ts` (`InputRequired.watch`, `ToolWatchContext`, `ToolWatcher`)
- Modify: `packages/plugin-sdk/src/ctx.ts` (`tools.register(spec, handler, opts?)`; `DeviceAccessErrorCode` + `not_running` with TSDoc "only a watcher's request")
- Modify: `packages/plugin-sdk/src/cards.ts` (question card `state` + `woken`; `renderCardAsText` label "Wait ended")
- Modify: `packages/kernel/src/ctx/create-ctx.ts` (`RegisteredTool` gains `watch?: ToolWatcher`; `register` checks `typeof opts.watch === "function"` and keeps it as frozen as the handler)
- Modify: `packages/kernel/src/tools/registry.ts` (`watcher(source): ToolWatcher | undefined` next to `handler(source)` :497)
- Modify: SDK API report (`pnpm gen:sdk-api`), `.changeset/<name>.md` (plugin-sdk, kernel)
- Test: `packages/kernel/test/extensions/ctx-tools.test.ts` (integration); `packages/plugin-sdk` card text test (existing `cards` test file)

**Interfaces:**
- Produces:
  ```ts
  export interface InputRequired { kind: "input_required"; form: InputForm; state?: unknown;
    watch?: { deadlineMs: number } }
  export interface ToolWatchContext extends Omit<ToolCallContext, "resume"> { state: unknown }
  export type ToolWatcher = (ctx: ToolWatchContext) => Promise<"settle" | "pending">;
  tools.register(spec: ToolSpec, handler: ToolHandler, opts?: { watch?: ToolWatcher }): void;
  ToolRegistry.watcher(source: ResolvedTool["source"]): ToolWatcher | undefined
  ```

- [ ] **Step 1: Failing tests:** `register keeps a watcher and the registry returns it`;
  `register refuses a non-function watch` (throws at setup with a clear message);
  `a builtin or connector source has no watcher`; `renderCardAsText labels a woken question`.
- [ ] **Step 2:** `pnpm exec vitest run <test files>` → FAIL.
- [ ] **Step 3:** Implement; TSDoc on each new type as in spec §5.1.
- [ ] **Step 4:** Rerun → PASS; `pnpm gen:sdk-api`; `pnpm typecheck`.
- [ ] **Step 5:** Commit `feat(sdk): watched input waits for extension tools`.

---

### Task 2: Questions: watch, `woken`, wake

**Repo:** core

**Files:**
- Create: `packages/kernel/src/migrations/0184_question_woken.sql` (next free number at implementation time):
  ```sql
  -- Watched input waits (browser long waits spec §5.2): a watcher settles the question as `woken`.
  ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_status_check;
  ALTER TABLE questions ADD CONSTRAINT questions_status_check
    CHECK (status IN ('pending', 'answered', 'skipped', 'expired', 'cancelled', 'woken'));
  ```
- Create: `packages/kernel/src/tools/tool-watch-queue.ts` (no Nest deps: `TOOL_WATCH_QUEUE = "cap-kernel-tool-watch"`, `TOOL_WATCH_JOB = "tool-watch"`, `toolWatchJobId`, `ToolWatchJobData = { orgId; questionId; failures }`, the three constants)
- Modify: `packages/kernel/src/tools/questions.service.ts` (`QuestionAskInput.watch?: { deadlineMs }`; `askIn` sets `expires_at` from `least(deadlineMs, hours)`, stores `watch: true` in the spec JSON, adds `watch: true` to `question_asked`, owes the first `tool-watch` job; new `wake(questionId)` / `wakeIn`; outcome and status unions gain `woken`)
- Modify: `packages/kernel/src/infra/outbox/registry.ts` (`OUTBOX_JOBS` entry `tool-watch`: queue, `processedIn` the Task 3 processor, idempotent: "deterministic job id per question; the job re-reads the question and acts only while it is pending", `removeOnComplete: true`)
- Modify: `packages/kernel/src/conversations/events.ts` (`question_asked.watch?: true`, `question_answered.outcome` + `woken`)
- Modify: `packages/kernel/src/infra/events/kernel-events.ts` (`question.answered` outcome + `woken`)
- Modify: `packages/kernel/src/evals/trajectory.ts` (outcome union)
- Modify: `packages/kernel/src/runtime/waits.ts` (confirm `isSettled` treats any non-pending question, `woken` included, as settled)
- Test: `packages/kernel/test/tools/questions-watch.test.ts` (integration; one app per file)

**Interfaces:**
- Consumes: `OutboxService.add` (`infra/outbox/outbox.service.ts`), `RunResume.resumeIn` (`runtime/run-jobs.ts`), `lockConversationOf` (`questions.service.ts`).
- Produces: `QuestionsService.wake(questionId: string): Promise<{ outcome: "woken" | "settled" }>`.

- [ ] **Step 1: Failing tests:**
  - `ask with watch sets expires_at to the deadline and owes tool-watch` — outbox row with job id `tool-watch-<id>`, `runAt ≈ now + 10 s`, data has `orgId`; `question_asked.payload.watch === true`.
  - `deadline is bounded by approvalTimeoutHours` — `deadlineMs` 48 h with config 24 h → `expires_at ≈ now + 24 h`.
  - `wake settles a pending question and resumes the waiting run` — status `woken`, `question_answered { outcome: "woken", byAccountId: null, answer: null }`, run `queued`, resume job owed.
  - `wake, answer and expire race: one wins` — the three concurrently on a due question; exactly one effective outcome, one `question_answered`.
  - `skipped watched wait is never woken` — `skipPendingIn` then `wake` → `settled`, no event.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (`wakeIn` under conversation lock → question `FOR UPDATE`; conditional on `pending` and `expires_at > now()`; `// org-filter: questionId comes from the kernel-written tool-watch job payload`).
- [ ] **Step 4:** Rerun → PASS; `pnpm check:org-filter`; `pnpm check:kernel-conventions`; `pnpm check:outbox-registry`.
- [ ] **Step 5:** Commit `feat(kernel): watched questions and the woken status`.

---

### Task 3: The `tool-watch` job and the watch call scope

**Repo:** core

**Files:**
- Create: `packages/kernel/src/tools/tool-watch.processor.ts` (`@Processor(TOOL_WATCH_QUEUE, { concurrency: 10 })`, every job inside `runJob` with the data's `orgId` as its org scope)
- Create: `packages/kernel/src/tools/tool-watch.service.ts` (`poll(job, token)`: read, resolve watcher, build context, call, wake / re-delay / count failures)
- Create: `packages/kernel/src/tools/tool-watch.module.ts` (`QueueModule.registerQueue(TOOL_WATCH_QUEUE)` + the processor; imported only by `WorkerModule`)
- Modify: `packages/kernel/src/roles/worker.module.ts` (import `ToolWatchModule`)
- Modify: `packages/kernel/src/tools/pipeline.ts` (export the handler-context builder of `execute` :3359 as `extensionCallContext(...)` so the job builds the identical `ToolCallContext`)
- Modify: `packages/kernel/src/tools/call-scope.ts` (`CallScope.watch?: true`; `attachCallScope(ctx, facts, { watch })`)
- Modify: `packages/kernel/src/device-access/device-access.service.ts` (watch scope: `request` → `DeviceServices.request(..., { ifRunning: true })`, `not_running` on a stopped instance or service; `ensureService` refused with a plain error)
- Modify: `packages/kernel/src/sandbox/device-services.ts` (`request` option `ifRunning`: uses the running instance only, refreshes last use, never resumes; reuse the `ifRunning` path of `ensure` / `status`)
- Modify: `packages/testing/fixtures/extensions/fake-tools-ui/src/index.ts` (a `wait` tool: first call returns `InputRequired` with `watch`; watcher returns `settle` when `ctx.kv` holds `go` for the state's key, throws on `fail`, else `pending`; resume returns `met` / `not met`)
- Modify: the device-fake fixture's echo service test helper if needed for the suspended-device case
- Modify: `packages/kernel/test/container-tests.json` (the dual-replica test)
- Test: `packages/kernel/test/tools/tool-watch.test.ts` (integration), `packages/kernel/test/tools/tool-watch-dual.test.ts` (container), `packages/kernel/test/device-access/device-access.test.ts` (watch scope cases)

**Interfaces:**
- Consumes: Task 1 `ToolRegistry.watcher`; Task 2 `QuestionsService.wake`, `tool-watch-queue.ts`; `isExtensionEnabled`; the effective config resolution the pipeline uses for extension calls.
- Produces: `DeviceServices.request(use, name, body, timeoutMs, signal, opts?: { ifRunning?: boolean })`.

- [ ] **Step 1: Failing tests** (model-fake scripts the call to `fake-tools-ui__wait`):
  - `pending watcher re-delays and keeps the run waiting` — two polls observed, run `waiting`, no model call.
  - `settle wakes the question and the run finishes with the tool result` — kv `go`; result `met`; one model turn after resume.
  - `deadline passes without settle` — short deadline; `wait-timeout` expires it; result `not met`.
  - `three failures wake` — kv `fail`; after the third failed poll the question is `woken`.
  - `missing watcher wakes the call` — extension disabled in the org while parked → woken → the pipeline's unavailable-tool text.
  - `a settle before the suspend resumes through the re-check` — a test seam delays the suspend; one resume.
  - `watcher gets the call's identity` — `callId`, `idempotencyKey`, `accountId`, `ownerAccountId`, `conversationId` equal the handler's.
  - `watched wait in an unattended fail-mode run is allowed` (with Task 4).
  - device-access: `watch scope request on a suspended device rejects not_running and resumes nothing`; `watch scope request on a running device refreshes last use`; `watch scope ensureService is refused`.
  - Container: `two workers poll one wait: one wake`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement per spec §5.3 (`job.moveToDelayed(Date.now() + TOOL_WATCH_INTERVAL_MS, token)` + `throw new DelayedError()`; `job.updateData` for `failures`; a watcher's `reportBlockedHosts` lands in the throwaway watch scope that nothing reads).
- [ ] **Step 4:** Rerun → PASS (`pnpm exec vitest run packages/kernel/test/tools/tool-watch.test.ts`; the container test in the `container` project).
- [ ] **Step 5:** Commit `feat(kernel): poll tool watchers for watched input waits`.

---

### Task 4: Pipeline rules for watched waits

**Repo:** core

**Files:**
- Modify: `packages/kernel/src/tools/pipeline.ts` (`isInputRequired` :885 and the `input_required` mapping :3500 carry `watch`; `askInput` :3312: `watch` without a registered watcher → `Tool <key> asked for a watched wait but registers no watcher.`, invalid `deadlineMs` → invalid-form text, pass `watch` to `questions.ask`; the unattended `fail` branch :1902 keeps outcomes with `watch`; `skippedResult` :284 gives `WAIT_SKIPPED_TEXT` for a question whose spec has `watch`)
- Test: `packages/kernel/test/tools/pipeline.test.ts`, `packages/kernel/test/tools/questions-skip.test.ts`

- [ ] **Step 1: Failing tests:** `watched wait without watcher is an error result`;
  `invalid deadline is an error result`; `unattended fail mode keeps a watched wait`;
  `unattended fail mode still refuses an unwatched input request`; `skip text of a watched wait`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5:** Commit `feat(kernel): pipeline rules for watched input waits`.

---

### Task 5: Web and IM rendering; skills and replay notes

**Repo:** core

**Files:**
- Modify: `apps/web/src/lib/conversations.ts` (`question_asked.watch?: true`; outcome + `woken`), `apps/web/src/lib/trajectories.ts` (outcome union)
- Modify: `apps/web/src/components/QuestionCard.tsx` (wait card when `watch`: title, deadline, the form's control; `woken` → 等待已结束 / Wait ended; `expired` on a watched question → 等待已超时 / Wait timed out)
- Modify: `apps/web/messages/zh.json`, `apps/web/messages/en.json`
- Modify: `packages/kernel/src/channels/outbound.ts` (`question_answered` :1153 passes `woken` as the card state)
- Modify: `.agents/skills/writing-tools/SKILL.md` (InputRequired section: watched waits, watcher rules, `not_running`, `woken`, `WAIT_SKIPPED_TEXT`, unattended), `.agents/skills/replay-evals/SKILL.md` (a woken wait and its skip text: in the log, no `DriftReason`), `.agents/skills/writing-channels/SKILL.md` (card state `woken`)
- Test: `apps/web/test/tool-cards.test.tsx` (QuestionCard cases), `packages/kernel/test/channels/outbound.test.ts` (question card cases), `packages/kernel/test/evals/reconstruct.test.ts` (case `a woken watched wait rebuilds byte for byte`)

- [ ] **Step 1: Failing tests:** web `wait card shows the deadline and the end control`, `woken reads Wait ended`;
  IM `woken question updates the card to state woken`; replay `a woken watched wait rebuilds byte for byte`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; `pnpm check:web-ui`, `pnpm check:i18n`.
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5:** Commit `feat(web): watched wait cards`.

---

### Task 6: Browser plugin: long `browser_wait`

**Repo:** plugins (after the core release carrying Tasks 1–5; bump the SDK with the repo's single-instance override)

**Files:**
- Modify: `plugins/browser/src/tools.ts` (`WAIT` spec: `timeoutMs` max 86_400_000, `urlContains`, `download`, description; handler split ≤ 60 s / > 60 s; register with `{ watch }`)
- Create: `plugins/browser/src/wait.ts` (long-wait handler, watcher, resume outcome mapping per spec §6.1)
- Modify: `plugins/browser/src/i18n.ts` (wait form title per condition, 结束等待 / End the wait)
- Modify: `plugins/browser/README.md`, `.changeset/<name>.md` (browser)
- Test: `plugins/browser/test/tools.test.ts` (fake `deviceAccess`)

**Interfaces:**
- Consumes: Task 7 daemon ops; SDK `InputRequired.watch`, `ToolWatcher`, `DeviceAccessError` `not_running`.
- Produces: `WAIT_INLINE_MAX_MS = 60_000`, `WAIT_MAX_MS = 86_400_000`, `WATCH_POLL_TIMEOUT_MS = 4_000`; `watchIdOf(call) = call.idempotencyKey.slice(0, 32)`.

- [ ] **Step 1: Failing tests:**
  - `wait of 60 s stays in-call` (one `wait` request, no InputRequired).
  - `long wait arms a watch and returns a watched InputRequired` (`watch_start` body, `watch.deadlineMs`, form with `end`).
  - `long wait without a condition is a ToolError`; `two conditions are a ToolError`.
  - `watcher maps pending / met / ended / unknown / not_running`; `watcher never calls ensureService`.
  - `resume: met → result with duration and detail`; `ended dialog → dialog line`; `tab_closed → ToolError`;
    `user ended → ToolError`; `past deadline → timeout ToolError`; `unknown watch after restart checks once`.
- [ ] **Step 2:** `pnpm exec vitest run plugins/browser/test/tools.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun → PASS; `capybara-plugin check` (tool design check).
- [ ] **Step 5:** Commit `feat(browser): long waits park the run`.

---

### Task 7: Browser daemon: watches

**Repo:** plugins

**Files:**
- Modify: `plugins/browser/daemon/protocol.ts` (`WaitCondition`, `watch_start` / `watch_poll` / `watch_end`, `ToolReply.watch`, `state.waiting`, `MAX_WATCHES = 16`, `WATCH_HEARTBEAT_MS = 120_000`; short `wait` gains `urlContains` / `download`)
- Modify: `plugins/browser/daemon/actions.ts` (watch registry: arm per tab, evaluate, latch, end on dialog / tab close / deadline; heartbeat drop; download watch hook in `onDownload`; `waitOp` :1235 new conditions)
- Modify: `plugins/browser/daemon/state.ts` (a polled pending watch keeps the daemon from its idle stop)
- Modify: `plugins/browser/daemon/main.ts` (watch ops bypass the takeover refusal and `dropHandoff`)
- Modify: `plugins/browser/daemon/viewer.ts` (`state.waiting`), `plugins/browser/ui-src/panel/panel.ts` + `i18n.ts` (status line)
- Test: `plugins/browser/test/daemon/tools.test.ts`, `plugins/browser/test/daemon/state.test.ts`, `plugins/browser/test/panel/panel.test.ts`

- [ ] **Step 1: Failing tests:**
  - `watch latches text that appears after the start` (a test page adds the text after a click the test triggers).
  - `watch on urlContains`, `watch on navigation`, `watch on download saves and reports the path`.
  - `dialog on the watched tab ends the watch with reason dialog`; `closing the tab ends it with tab_closed`; `deadline ends it`.
  - `watch_start is idempotent per id`; `watch_poll of an unknown id is unknown`; `watch_end forgets`.
  - `a watch without a poll for 2 minutes is dropped` (fake clock); `a polled watch keeps the daemon from its idle stop`.
  - `watch ops run while taken over and keep the pending handoff`.
  - `a 17th watch drops the oldest latched one`.
  - panel `status line shows the waiting label and time`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun → PASS; the repo's verify.
- [ ] **Step 5:** Commit `feat(browser): daemon watches for long waits`.

---

### Task 8: Channel plugins: the `woken` question card state

**Repo:** plugins (after the SDK rc of Task 1)

**Files:**
- Modify: `plugins/lark/src/cards.ts` (state labels :83 / :120 and colours :139: `woken` → "Wait ended" / 等待已结束, grey)
- Modify: `plugins/slack/src/blocks.ts` (labels :80 / :116)
- Modify: `plugins/telegram/src/*` (only if it labels states itself; otherwise it uses `renderCardAsText`)
- Modify: changesets per plugin; SDK bump with the single-instance override
- Test: each plugin's card test file (a `woken` question card renders its label)

- [ ] **Step 1:** Failing tests per plugin. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(channels): woken question cards`; the main session releases and pins these before the kernel release that emits `woken`.

---

### Task 9: Acceptance and release

**Repo:** both

- [ ] **Step 1:** Core PR(s) for Tasks 1–5 green; Task 8 released and pinned; then the main session releases core (SDK and kernel rc).
- [ ] **Step 2:** Plugins PR for Tasks 6–7 against the released SDK; green; browser rc released.
- [ ] **Step 3:** Dev stack, docker device: ask the agent to "wait until the page at <local test page> says Done (it flips after 3 minutes)". Expected: one `browser_wait` call, the run `waiting`, the wait card with 结束等待, no model turns for 3 minutes, resume within ~10 s of the flip, result `Waited 3 min …`.
- [ ] **Step 4:** Same with a download that takes 2 minutes; with 结束等待 pressed mid-wait; with a message sent mid-wait (skip text); with the kernel restarted mid-wait; with the device suspended from the device page mid-wait (`not_running` → honest result, device not resumed by polls).
- [ ] **Step 5:** Local device (`device-local`): one long wait end to end; a Lark conversation shows the wait card and its `woken` state.
- [ ] **Step 6:** Record results in the PR description; close plugins#207 with the release note.
