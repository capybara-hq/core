# Background Bash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code style background commands. They consist of three parts:
- `Bash` with `run_in_background`, plus `TaskOutput` and `TaskStop`;
- a logged `background_task_finished` event that wakes an idle conversation;
- the properties panel's background section.

**Architecture:**
- **Launch.** A background task is one short exec that starts `setsid nohup …` in the sandbox. The task is tracked in `capybara.background_tasks`.
- **Polling.** A worker `@LockedInterval` polls running tasks through a new non-resuming `SandboxService.ifRunning`. Each status change and its model-visible event commit in one transaction.
- **Request building and waking.** Request building absorbs the event the way it absorbs an interjection. `ensureRun` treats an unconsumed event as a run boundary, which wakes an idle conversation.
- **Web.** The web reads tasks through new routes and draws them in `BackgroundTasks`.

**Tech Stack:** NestJS + Kysely (kernel), BullMQ, the sandbox@1 exec contract (unchanged), Next + TanStack Query (web), design package.

**Spec:** `docs/superpowers/specs/2026-11-05-background-bash-design.md`. Read it with this plan: section numbers below (§n) are the spec's.

## Global Constraints

- **No change to the sandbox@1 contract or the SDK API** (spec §6).
- **Model-facing text is English.** UI text is zh and en. Tool descriptions pass the tool design check.
- **Paths are relative to `/workspace`.** The launch exec runs with `cwd: "/workspace"`. Task files live in `.capybara/tasks/<id>.{sh,out,exit}`.
- **Ids:** `bt_` plus 6 lowercase base32 characters.
- **Limits and config:**
  - `sandbox.background.maxTasks` = 4, per sandbox (the root conversation).
  - `sandbox.background.maxSeconds` = 7200, clamped to `sandbox.limits.maxCommandSeconds`.
  - `sandbox.background.pollSeconds` = 10, hot.
  - `runtime.wakeOnBackgroundTask` = true, with an org override.
- **Event payload limits:** `background_task_finished` carries at most 20 last lines and at most 4000 characters. Its idempotency key is `background_task_finished:<taskId>`.
- **Tool parameters:**
  - `TaskOutput`: `block` defaults to true; `timeout` defaults to 30000 ms, max 600000, and never exceeds the run's time left; checks run every 2 s.
  - `TaskStop`: SIGTERM, then SIGKILL after 5 s, by session (`pkill -s <sid>`).
- **Wake rules:** the wake window is 60 s. A finish that lands inside the window schedules the delayed job `bg-wake-<conversationId>-<windowEnd>` on `cap-kernel-maintenance`.
- **Multi-replica rules (AGENTS.md):**
  - state lives in PG;
  - enqueues, notifies and Redis calls happen only after commit;
  - jobs are provided only under `WorkerModule`;
  - job ids contain no `:`.
- **Migrations:** the next free number after `git pull --rebase` (0070 at the time of writing). Every statement is `IF NOT EXISTS`. `check:applied-migrations` and the numbering checks must pass.
- **Replay:**
  - the zero-drift suites run before and after the request-building change (`packages/kernel/test/evals/reconstruct.test.ts`, `packages/kernel/test/tools/rename-compat.test.ts`);
  - a replay never starts, polls or stops a task.
- **Web:** pages use only design components (`check:web-ui`). Every new read goes through `defineQuery` and keys.
- **Commits:** Conventional Commits, body lines ≤ 100 characters. Kernel changes get a minor changeset; web and design changes get a patch.

## Review Focus

Untested by the task-level tests, most likely to bite first:

1. **A command containing quotes, `$`, newlines or a heredoc.** It must run byte for byte as written. Task 3 tests a command with all of these.
2. **A task whose output file grows to hundreds of MB.** `TaskOutput` and the panel must read only a bounded slice, never the whole file. Task 5 and Task 7 test a 20 MB output.
3. **Two replicas polling the same sandbox.** The `@LockedInterval` lock guarantees exactly one poll per tick, and the conditional update guarantees exactly one finish event. Task 4 has a dual-replica test.
4. **A finish landing while the run is between its last model call and `run_finished`.** The event must wake a run after this one. It must neither be lost nor be counted as consumed. Task 6 tests that timing.
5. **The person who started the launching run having left the org.** No wake; the event is still shown. Task 6 tests it.

---

### Task 1: Storage, config and the event type

**Files:**
- Create: `packages/kernel/src/migrations/0070_background_tasks.sql`
- Create: `packages/kernel/src/background/store.ts`
- Create: `packages/kernel/src/background/background.module.ts`
- Modify: `packages/kernel/src/config/schema.ts` (in `sandbox`: `background: { maxTasks, maxSeconds, pollSeconds }`; in `runtime`: `wakeOnBackgroundTask`); `docs/config.md` via `pnpm gen:config-docs`
- Modify: the org settings schema that holds `sandboxToolPolicy`: add `wakeOnBackgroundTask?: boolean`
- Modify: `packages/kernel/src/conversations/events.ts` (add `background_task_finished`)
- Test: `packages/kernel/test/background/store.test.ts`

**Interfaces:**
- Produces:
  - `type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped" | "timed_out" | "lost"`.
  - `type BackgroundTaskRow`, the camel-cased columns of spec §4.1:
    - `id`, `orgId`, `conversationId`, `sandboxConversationId`, `runId`, `callId`, `triggerAccountId`;
    - `description`, `command`, `sid`, `outputPath`;
    - `status`, `lostReason`, `exitCode`;
    - `startedAt`, `finishedAt`, `deadlineAt`;
    - `sandboxCreatedAt`, `killPending`, `readOffset`.
  - `@Injectable() BackgroundTaskStore` in `background/store.ts`, with these methods:
    - `insert(row: Omit<BackgroundTaskRow, "status" | "finishedAt" | "exitCode" | "lostReason" | "killPending" | "readOffset">): Promise<void>`
    - `get(id: string): Promise<BackgroundTaskRow | undefined>`
    - `runningIn(sandboxConversationId: string): Promise<BackgroundTaskRow[]>`
    - `countRunning(sandboxConversationId: string): Promise<number>`
    - `listFor(conversationIds: string[]): Promise<BackgroundTaskRow[]>`: newest first.
    - `finish(id: string, to: { status: Exclude<BackgroundTaskStatus, "running">; exitCode?: number | null; lostReason?: string; killPending?: boolean }): Promise<boolean>`: a conditional `running → to`. It returns false when the row was no longer running. It is `@Transactional({ propagation: "mandatory" })`.
    - `advanceOffset(id: string, to: number): Promise<void>`
    - `pendingKills(sandboxConversationId: string): Promise<BackgroundTaskRow[]>`
    - `clearKill(ids: string[]): Promise<void>`
    - `pruneFinished(before: Date): Promise<number>`: deletes non-running rows whose `finished_at` is before `before`, and returns the count.
  - **The event** `background_task_finished`, with payload:
    - `taskId`, `description`, `status`, `exitCode: number | null`, `elapsedMs`;
    - `lastLines: string` (≤ 4000 characters);
    - `outputPath`;
    - `reported: boolean`;
    - `lostReason?: string`.

- [ ] **Step 1: Write failing tests** in `store.test.ts` (real PG via the kernel test harness):
  - `insert` then `get` round-trips every field.
  - `countRunning` counts only `running` rows of that sandbox conversation.
  - `finish` from `running` returns true; a second `finish` returns false.
  - `listFor([parent, child])` returns rows newest first.
  - Deleting the conversation deletes its rows (FK `ON DELETE CASCADE`).
  - `pruneFinished` deletes old finished rows only, never a running one.
  - The events schema accepts a `background_task_finished` payload and rejects `lastLines` over 4000 characters.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/background/store.test.ts`. Expected: FAIL (the module is missing).
- [ ] **Step 3: Implement.**
  - Write the migration (spec §4.1 columns and both indexes, `IF NOT EXISTS`). FK on `conversation_id` and `sandbox_conversation_id` to `capybara.conversations(id) ON DELETE CASCADE`. `status` gets a CHECK constraint.
  - Write the store, the module and the config fields, each with `meta` descriptions (`.agents/skills/adding-config`). `pollSeconds` gets `hot: true`.
  - Add the event to the union. It is not model-visible yet: Task 6 renders it.
- [ ] **Step 4: Run** the store test and `pnpm check` (config docs, migrations, kernel conventions). Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): background task store, config and the finished event`.

### Task 2: Sandbox support: a non-resuming entry, kills after resume, the fake provider

**Files:**
- Modify: `packages/kernel/src/sandbox/sandbox.service.ts`
- Modify: `packages/kernel/test/fixtures/plugins/sandbox-fake/index.ts`, plus shims in `packages/kernel/test/fixtures/plugins/sandbox-fake/bin/{setsid,timeout,pkill,pgrep}`
- Test: `packages/kernel/test/sandbox/if-running.test.ts`, `packages/kernel/test/sandbox/sandbox-fake.test.ts`

**Interfaces:**
- Consumes: `BackgroundTaskStore.pendingKills` / `clearKill` (Task 1).
- Produces:
  - `SandboxService.ifRunning<T>(conversationId: string, instance: { createdAt: Date }, fn: (p: TaggedProvider, h: SandboxHandle, signal: AbortSignal) => Promise<T>): Promise<{ kind: "ran"; value: T } | { kind: "not_running" } | { kind: "other_instance" }>`. It takes a shared lease only when the row is `running` and `isInstance` matches `createdAt`, and it never creates or resumes a sandbox.
  - `SandboxService.currentInstance(conversationId): Promise<{ createdAt: Date } | null>`.
  - After any resume, under the exclusive lease and next to the existing `killAll`, it runs `pkill -KILL -s <sid>` for each `pendingKills` row of the resumed instance and calls `clearKill`. For another instance it calls `clearKill` without the exec.

- [ ] **Step 1: Write failing tests:**
  - `ifRunning` on a `suspended` row returns `not_running` and leaves the row `suspended`; no create or resume is called.
  - `ifRunning` with a stale `createdAt` returns `other_instance`.
  - `ifRunning` on a running instance runs `fn` under a shared lease and refreshes `last_used_at`.
  - With a `kill_pending` task of the current instance, a resume runs one kill exec naming its sid and clears the flag.
  - On sandbox-fake:
    - `setsid sh -c 'sleep 30' & echo $!` returns a pid, and `pgrep -s <pid>` finds the process;
    - `pkill -s <pid>` ends it;
    - `suspend` and `destroy` kill every process the instance started;
    - all of this also holds on darwin.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/sandbox/if-running.test.ts packages/kernel/test/sandbox/sandbox-fake.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The shims are small `#!/usr/bin/env node` scripts. `setsid` uses `child_process.spawn` with `detached: true` and prints nothing. `pgrep -s` / `pkill -s` find processes by session through a pid registry file the fake writes per instance.
  - The fake prepends its `bin` to `PATH` and records every spawned pid for `suspend` / `destroy`.
- [ ] **Step 4: Run** both files and `pnpm exec vitest run packages/kernel/test/sandbox`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): a non-resuming sandbox entry and kills of lost tasks after resume`.

### Task 3: Launching a background `Bash`

**Files:**
- Create: `packages/kernel/src/background/launch.ts`
- Modify: `packages/kernel/src/tools/builtins/sandbox/bash.ts` (schema, description paragraph, the background branch)
- Modify: `packages/kernel/src/tools/builtin-names.ts` (`MATCH_IGNORED_FIELDS` stays `description` only; add a comment that `run_in_background` is matched on purpose)
- Test: `packages/kernel/test/background/launch.test.ts`, `packages/kernel/test/tools/bash-background.test.ts`

**Interfaces:**
- Consumes: `BackgroundTaskStore.insert` / `countRunning`, and `SandboxService.currentInstance` (Tasks 1-2).
- Produces:
  - `newTaskId(): string`, which matches `/^bt_[a-z2-7]{6}$/`.
  - `launchScript(id: string, command: string, seconds: number): string`. It builds the shell that writes `.capybara/tasks/<id>.sh` from base64, then runs `setsid nohup sh -c 'timeout -s KILL <seconds> bash .capybara/tasks/<id>.sh; echo $? > .capybara/tasks/<id>.exit' > .capybara/tasks/<id>.out 2>&1 < /dev/null &`, then writes `$!` to `.capybara/tasks/<id>.sid` and prints it.
  - `startedText(id: string, description: string): string`. It returns spec §2.1's text exactly, with the path `/workspace/.capybara/tasks/<id>.out`.

- [ ] **Step 1: Write failing tests:**
  - `launchScript` round-trips a command containing `'`, `"`, `$HOME`, a backtick, a newline and a heredoc. On sandbox-fake, the task's `.out` holds exactly what the same command prints in the foreground.
  - A background call returns `startedText(...)` within 2 s while the command sleeps 30 s. It inserts a `running` row with `sid` set, the `deadlineAt` of the given `timeout`, and `sandboxCreatedAt`.
  - The fifth launch with 4 running gives the tool error `4 background tasks are already running; stop one with TaskStop or wait for one to finish`.
  - Without a sandbox the existing unavailable error applies.
  - `timeout` above `maxSeconds` is clamped, and the result says so.
  - A foreground `Bash` is unchanged: the existing bash tests pass.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/background/launch.test.ts packages/kernel/test/tools/bash-background.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The background branch runs `launchScript` as one exec under the call's shared lease (`inSandbox`) with `cwd: "/workspace"`, then inserts the row.
  - The exec's own `timeoutMs` is short: 30 s.
  - The description paragraph follows Claude Code's wording. It also mentions `TaskOutput` and `TaskStop`, and the fact that a task is lost when the sandbox is suspended (after `maxRunningMinutes`).
- [ ] **Step 4: Run** the two files, plus `packages/kernel/test/tools` for the tool design check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): Bash run_in_background starts a background task`.

### Task 4: Polling, finishing and stopping

**Files:**
- Create: `packages/kernel/src/background/poll.job.ts` (`BackgroundTaskPollJob`, provided in `roles/worker.module.ts`)
- Create: `packages/kernel/src/background/finish.ts` (`BackgroundTaskFinisher`)
- Create: `packages/kernel/src/background/stop.ts` (`BackgroundTaskStopper`)
- Modify: `packages/kernel/src/conversations/event-log.ts` (add `"background"` to `CONVERSATION_CHANGES`)
- Modify: `packages/kernel/src/runtime/run-worker.ts` (a sub-agent's run end stops its child conversation's tasks)
- Modify: the conversation delete path (stop the conversation's running tasks before its rows cascade)
- Test: `packages/kernel/test/background/poll.test.ts`, `packages/kernel/test/background/poll.dual.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces:
  - `BackgroundTaskFinisher.finish(task: BackgroundTaskRow, to: {...as Store.finish}, lastLines: string, reported: boolean): Promise<boolean>`. It is `@Transactional`: `Store.finish`, then `EventLog.append` of `background_task_finished` with key `background_task_finished:<id>`, in one transaction. `afterCommit` sends the `changed: "background"` frame and calls `BackgroundWake.onFinished(task.conversationId)` (Task 6; until then a no-op provider).
  - `BackgroundTaskStopper.stop(task: BackgroundTaskRow, why: "tool" | "person" | "subagent_end" | "conversation_deleted"): Promise<BackgroundTaskRow>`. It runs `pkill -TERM -s`, waits up to 5 s for `pgrep -s` to come back empty, then `pkill -KILL -s`, through `ifRunning`. It then finishes as `stopped` with the last 20 lines. If the sandbox isn't running it finishes as `lost` with `killPending: true`.
  - **Poll outcomes**, spec §4.3:
    - an exit file holding 0 → `completed`; any other code → `failed`, except 137 at or past `deadlineAt` → `timed_out`;
    - no exit file and no process → `lost`/`process_gone`;
    - `other_instance` → `lost`/`sandbox_recreated` (`killPending: false`);
    - `not_running` → `lost`/`sandbox_suspended` or `sandbox_gone` (`killPending: true` when suspended).

- [ ] **Step 1: Write failing tests:**
  - **Completion and failure.** A task running `echo hi; exit 3` ends as `failed`, with exit 3 and `lastLines` holding `hi`, within one poll after it exits. Exactly one `background_task_finished` event is appended.
  - **Timeout.** `sleep 60` with `timeout: 1000` ends as `timed_out`.
  - **Gone process.** Killing the session from outside gives `lost`/`process_gone`.
  - **Suspension.** Suspending the sandbox gives `lost`/`sandbox_suspended` with `killPending`, and a later resume kills nothing alive.
  - **Rebuild.** A rebuilt sandbox gives `lost`/`sandbox_recreated`.
  - **Stop.** `stop(task, "person")` ends `sleep 300` within 6 s, as `stopped`.
  - **Sub-agent end.** A sub-agent's run end stops its child conversation's running task.
  - **Event and status in one transaction.** A thrown append rolls the status back to `running` (inject a failure through the store test seam).
  - **Dual replica** (`createDualReplicaHarness`): with both replicas polling for 30 s and one task finishing, there is exactly one finish event.
  - **Keep-alive.** A sandbox with a running task is not idle-suspended after `suspendAfterIdleMinutes` (fake clock); polls refresh `last_used_at`.
  - **Prune.** A daily `@LockedCron` (`background-task-prune`, in the same job class) calls `pruneFinished(now - tools.outputRetentionDays)`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/background`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **The poll exec.** One exec per sandbox reports `id exitcode alive` lines for all its running tasks: `test -f`, `cat`, `pgrep -s`.
  - **`lastLines`.** Read with `tail -n 20 .capybara/tasks/<id>.out`, cut to 4000 characters.
  - **The decorator.** `@LockedInterval("background-task-poll", (cfg) => cfg.sandbox.background.pollSeconds * 1000)`. The host class injects `lockService`, `log` and `config` (`kc-decorator-host`).
- [ ] **Step 4: Run** the folder, `pnpm check:kernel-conventions` and `pnpm exec vitest run packages/kernel/test/sandbox`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): poll, finish and stop background tasks`.

### Task 5: `TaskOutput` and `TaskStop`

**Files:**
- Create: `packages/kernel/src/tools/builtins/sandbox/task-output.ts`, `packages/kernel/src/tools/builtins/sandbox/task-stop.ts`
- Modify:
  - `packages/kernel/src/tools/builtin-names.ts`:
    - `BUILTIN.TaskOutput`, `BUILTIN.TaskStop`;
    - add both to `SANDBOX_TOOL_NAMES` and `BUILTIN_TOOL_NAMES`;
    - kinds `TaskOutput: "read"`, `TaskStop: "command"`;
    - neither goes in `SANDBOX_ASK_TOOL_NAMES`.
  - `packages/kernel/src/tools/builtins/sandbox/index.ts`.
  - `apps/web/src/lib/agents.ts` and `apps/web/src/lib/timeline.ts`: the web's copies of the names (`builtin-names.test.ts` checks them equal).
  - `packages/kernel/src/runtime/context/claude-tools.ts`: `TaskOutput -> TaskOutput, TaskStop -> TaskStop`.
- Test: `packages/kernel/test/tools/task-tools.test.ts`; update `packages/kernel/test/tools/builtin-names.test.ts`; `reconstruct.test.ts` keeps "an old snapshot keeps its old map text".

**Interfaces:**
- Consumes: the store and the stopper (Tasks 1 and 4).
- Produces:
  - **`TaskOutput`** takes `{ task_id: string; block?: boolean; timeout?: number }`. Its text holds the status line (`Status: running (2m05s)` / `Status: failed, exit code 3, after 4m12s`), then the output since `readOffset`, capped at `tools.outputSpillChars` and spilled by the pipeline beyond that. It then advances `readOffset` by the bytes returned.
  - **`TaskStop`** takes `{ task_id: string }`. Its text gives the final status and the last 20 lines. For a task that had already finished, the text says so and is not an error.
  - **Errors:**
    - an unknown id, or a task of another conversation: `No background task bt_x in this conversation`;
    - no sandbox: the existing unavailable error.
  - **Reporting.** When a finish is reported by one of these calls before the poller sees it, the finish goes through `BackgroundTaskFinisher.finish(..., reported: true)`.

- [ ] **Step 1: Write failing tests:**
  - Two `TaskOutput` calls on a task printing `a\n`, then `b\n` return `a` and then only `b`.
  - `block: true` on `sleep 3; echo done` returns after the task finishes, with `done` and `Status: completed`.
  - `block: true, timeout: 1000` on `sleep 30` returns after about 1 s with `Status: running`.
  - A 20 MB output returns at most `tools.outputSpillChars` characters plus the spill note. Memory stays bounded: the exec reads with `tail -c +<offset> | head -c <cap>`.
  - `TaskStop` on a running task returns `stopped`. On a completed task it returns the "already finished" text with `isError: false`.
  - A child conversation's task is invisible to the parent's `TaskOutput`.
  - The tool map snapshot of a new run reads `TaskOutput -> TaskOutput, TaskStop -> TaskStop`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/tools/task-tools.test.ts packages/kernel/test/tools/builtin-names.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both tools on the existing sandbox tool pattern: `inSandbox` for reads, `defaultPolicy: "allow"`, English descriptions of 20 characters or more, `keyArgs: ["task_id"]`.
- [ ] **Step 4: Run** those tests, `reconstruct.test.ts`, `rename-compat.test.ts` and `pnpm check:terms`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): TaskOutput and TaskStop`.

### Task 6: The model sees finishes, and finishes wake idle conversations

**Files:**
- Modify: `packages/kernel/src/runtime/context/build.ts` (absorbable events: `user_message` and `background_task_finished`; render the latter as a system message)
- Modify: `packages/kernel/src/runtime/run-worker.ts` (`pendingUserMessages` → `pendingAbsorbable`, returning both types)
- Modify: `packages/kernel/src/runtime/langgraph-loop.ts` (the consumed rule)
- Modify: `packages/kernel/src/evals/run-replay.ts` (feed recorded finishes at their absorbing step; seed a wake run from its boundary event)
- Modify: `packages/kernel/src/runtime/run-queue.ts` (`ensureRunIn`: a boundary is the newest unconsumed `user_message` **or** wake-eligible `background_task_finished`; `run_started.trigger`)
- Create: `packages/kernel/src/background/wake.ts` (`BackgroundWake`: `onFinished`, the 60 s window, the delayed job)
- Test: `packages/kernel/test/background/wake.test.ts`, `packages/kernel/test/runtime/absorb-background.test.ts`; run the zero-drift suites

**Interfaces:**
- Consumes: the `background_task_finished` event (Task 1) and `BackgroundTaskFinisher` (Task 4).
- Produces:
  - `renderBackgroundFinished(p: EventPayload<"background_task_finished">): string`. For `reported: false`, it returns spec §2.4's text exactly. For `reported: true`, it returns `Background task <id> ("<description>") <status>; already reported.`
  - `BackgroundWake.onFinished(conversationId: string): Promise<void>`. It checks the wake rules of spec §3 and either calls `RunQueue.ensureRun` or schedules `bg-wake-<conversationId>-<windowEnd>`.
  - `run_started.payload.trigger?: "message" | "background_task"`. It defaults to `"message"`, so it is display only and old logs need no change.
  - **The wake run's trigger account** is the task's `triggerAccountId`. When that account can no longer send to the conversation, there is no wake: the event stays unconsumed until the next message.

- [ ] **Step 1: Run the zero-drift suites first** and record that they pass:
  `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts`.
- [ ] **Step 2: Write failing tests:**
  - **Mid-run finish.** During a run (model-fake script with two tool steps), a finish appended between steps is in the next request as a system message right after the tool results. `consumed_seq` passes it at `run_finished`.
  - **Finish during the last model call.** A finish appended during the last model call is in no request. After `run_finished`, a wake run starts with `trigger: "background_task"` and its first request contains it. *(Review Focus 4.)*
  - **Waiting run.** A finish while the run waits for an approval is absorbed after the resume.
  - **Idle conversation.** A finish wakes a run attributed to the task's trigger account.
  - **Two finishes in the window.** Two finishes 5 s apart give one wake run that sees both. A third finish 10 s after that wake started schedules `bg-wake-…` and runs at the window's end.
  - **No wake for:** a sub-agent's task; a paused queue; `runtime.wakeOnBackgroundTask: false`; the org override set to false; a trigger account removed from the org *(Review Focus 5)*. In each case the event is logged and nothing runs.
  - **`reported: true`** is absorbed like any other event, never wakes and renders as the short line.
  - **A person's stop** (`stoppedBy: "person"` on the event, fix round 1) never wakes; the next run absorbs it.
  - **Step replay** of a call after a finish rebuilds the same request with zero drift.
  - **Full-run replay** of a run that absorbed a finish feeds it at the same step and starts no task.
- [ ] **Step 3: Run** the new tests. Expected: FAIL.
- [ ] **Step 4: Implement.** Generalize the existing interjection placement in `build.ts`, the "inline" and "deferred" placement by `absorbedBy`, from `user_message` to the absorbable set. Don't write a second mechanism.
- [ ] **Step 5: Run** the new tests and the zero-drift suites again. Expected: PASS, with zero drift on every existing fixture.
- [ ] **Step 6: Commit** `feat(kernel): finished background tasks reach the model and wake idle conversations`.

### Task 7: HTTP routes

**Files:**
- Create: `packages/kernel/src/background/background.controller.ts`
- Modify: the error code registry: `background_task.not_found` 404, `background_task.output_unavailable` 409
- Modify: the audit actions: `background_task.stopped`
- Test: `packages/kernel/test/background/background.http.test.ts`

**Interfaces:**
- Consumes: the store and the stopper.
- Produces:
  - `GET /api/v1/orgs/:orgId/conversations/:id/background-tasks` → `{ tasks: BackgroundTaskView[] }`. `BackgroundTaskView` is:
    - `id`, `conversationId`, `subagentId: string | null` (the child conversation, or null for the conversation's own task);
    - `description`, `command`, `status`, `exitCode`, `lostReason`;
    - `startedAt`, `finishedAt`.
  - `POST …/background-tasks/:taskId/stop` → `{ task: BackgroundTaskView }`.
  - `GET …/background-tasks/:taskId/output?tail=<bytes ≤ 65536>` → `{ text: string; truncated: boolean; source: "live" | "event" }`. A finished task whose sandbox isn't running answers with the event's `lastLines` (`source: "event"`). Otherwise the response is 409.

- [ ] **Step 1: Write failing tests:**
  - **Visibility and listing.** Rows include a sub-agent's tasks with `subagentId`. A guest without access gets 404. The visibility is the conversation's own.
  - **Who may stop.** The people who may stop a run may stop a task; anyone else gets 403. A stop writes the audit row.
  - **Output size.** `tail` above 65536 is a 400. A 20 MB output returns 64 KiB with `truncated: true`. *(Review Focus 2.)*
  - **Suspended sandbox.** The finished task gets `source: "event"`; the running one gets 409.
  - **SSE.** A finish emits a `changed: "background"` frame on the stream.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/background/background.http.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `createZodDto` and `@ZParam` / `@ZQuery`, following `.agents/skills/writing-kernel-api`.
- [ ] **Step 4: Run** the test and `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): background task routes`.

### Task 8: Design: task rows and the output panel

**Files:**
- Modify: `packages/design/src/conversation/subagents.tsx` (`BackgroundTasks` accepts task rows and nesting)
- Create: `packages/design/src/conversation/task-output-panel.tsx`
- Modify: `packages/design/src/i18n.ts`, the conversation styles, `docs/design/spec.md` (the background section: state list, size table), `apps/web/visual/accepted.ts`, and the /dev/ui reference blocks
- Test: `packages/design/test/background-tasks.test.tsx`

**Interfaces:**
- Produces:
  - `type BackgroundItem`, a union of:
    - `{ kind: "task"; id: string; description: string; status: BackgroundTaskStatus; startedAt: number; finishedAt?: number; exitCode?: number | null; nested?: boolean }`;
    - today's sub-agent item, with an optional `tasks: BackgroundItem[]`.
  - `BackgroundTasks({ items, now, onStop, onOpen, completedLabel })`.
  - `TaskOutputPanel({ description, command, status, elapsed, text, source, onStop })`.
  - **State list for `background-task`:** `running`, `done`, `failed`, `stopped`, `lost`, `nested`.
  - **Copy:**
    - zh: 已完成 / 失败 / 已停止 / 已超时 / 已丢失 / 停止「{name}」 / 输出不可读（沙箱已暂停）;
    - en: Done / Failed / Stopped / Timed out / Lost / Stop {name} / Output unavailable (sandbox suspended).

- [ ] **Step 1: Write failing tests:**
  - A running task row has a spinner, the description, the elapsed time and a stop button named after it.
  - A failed row has the fail mark and no spinner.
  - A nested row is indented under its sub-agent.
  - "N completed" counts finished tasks and sub-agents together and opens the newest.
  - The panel shows the command in mono and the text in a `CodeBlock`. `source: "event"` shows the unavailable note above the last lines.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/design/test/background-tasks.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** with existing tokens only. Add the spec rows, the /dev/ui blocks for every state, and the `accepted.ts` entry.
- [ ] **Step 4: Run** `pnpm exec vitest run packages/design apps/web/test/catalog.test.tsx` and `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(design): background task rows and the task output panel`.

### Task 9: Web: the section, the panel, tool rows and the thread notice

**Files:**
- Modify: `apps/web/src/lib/conversations.ts` (API calls), `apps/web/src/lib/query/conversation.ts` (`backgroundTasksQuery`, `taskOutputQuery`), `apps/web/src/lib/query/keys.ts`
- Modify: `apps/web/src/components/conversation/BackgroundSection.tsx`, `PropertiesSections.tsx`, `RightArea.tsx` (`#bg-<taskId>` target)
- Modify: `apps/web/src/components/conversation/useConversation.ts` (the `changed: "background"` handler)
- Modify: `apps/web/src/lib/timeline.ts` (background labels on Bash, the TaskOutput and TaskStop rows, a notice row for `background_task_finished`)
- Modify: `apps/web/messages/{zh,en}.json`
- Test: `apps/web/test/background-section.test.tsx`, `apps/web/test/timeline-background.test.ts`

**Interfaces:**
- Consumes: Task 7 routes, Task 8 components.
- Produces:
  - **`backgroundTasksQuery(orgId, conversationId)`:** freshness `"live"`. It is enabled once the log has a `Bash` call with `run_in_background: true` or a `background_task_finished` event, and it is invalidated on `changed: "background"`.
  - **`taskOutputQuery(orgId, conversationId, taskId)`:** refetches every 2 s while the task is running and stops once it isn't.
  - **The section** merges tasks and sub-agents into `BackgroundItem[]`. A sub-agent's tasks are nested under it while it runs.
  - **Timeline:**
    - a background `Bash` row shows `后台运行` / `In background` after its description and links `#bg-<id>`;
    - the finished event is a one-line notice, `后台任务「{description}」{status} · 退出码 {code}`, which opens the task.

- [ ] **Step 1: Write failing tests:**
  - **Section rows and stop.** The section renders a running task and a sub-agent with a nested task. Stop POSTs `…/stop` and the row turns `stopped` after the `changed` frame.
  - **Panel opening.** Clicking a task opens `#bg-<id>`.
  - **Panel polling.** The panel polls output while running and stops polling once finished.
  - **Panel with a suspended sandbox.** A 409 shows the unavailable note.
  - **Timeline.** It labels a background Bash row and renders the notice row.
  - **No browser read on first paint.** The section is not read until the log shows a background task.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/background-section.test.tsx apps/web/test/timeline-background.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** through `defineQuery`, keys and `useAppMutation`, with no styles in `apps/web`.
- [ ] **Step 4: Run** `pnpm exec vitest run apps/web/test` and `pnpm check:web-ui`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): the background section, task output panel and timeline rows`.

### Task 10: Docs, changesets, e2e

**Files:**
- Modify:
  - `AGENTS.md`: the Tools bullet (background Bash, TaskOutput, TaskStop), the multi-replica bullet (the poller), and the Sandboxes bullet.
  - `.agents/skills/writing-tools/SKILL.md`, `.agents/skills/writing-sandbox-providers/SKILL.md` (providers need `setsid`, `timeout`, `pkill -s` and `pgrep -s`), `.agents/skills/replay-evals/SKILL.md` (absorbable events).
  - `docs/superpowers/specs/2026-10-29-tool-naming-claude-code-design.md`: mark the `run_in_background` non-goal as superseded by the new spec.
  - `docs/superpowers/specs/2026-11-05-background-bash-design.md`: the status line.
- Create: `.changeset/background-bash.md` (kernel minor, web patch, design patch)
- Create: `apps/web/e2e/background-task.spec.ts`
- Modify: `tools/ci/test-plugins.json` if the e2e spec loads model-fake in a new way

- [ ] **Step 1: Write the e2e spec.**
  - Model-fake script: Bash `sleep 3; echo ready` with `run_in_background: true`, then a reply.
  - Expectations:
    - the section shows the running task;
    - the panel shows `ready` after it finishes;
    - the thread shows the finished notice;
    - a wake run's reply appears without a person's message.
- [ ] **Step 2: Run** `pnpm --filter @capybara-hq/web e2e -- e2e/background-task.spec.ts` in a worktree with no dev server. Expected: PASS.
- [ ] **Step 3: Update the docs and the changeset.** Then run `pnpm verify`. Expected: everything that runs locally passes; the CI-only jobs are skipped.
- [ ] **Step 4: Commit** `docs: background Bash in AGENTS.md and the skills; e2e`.
