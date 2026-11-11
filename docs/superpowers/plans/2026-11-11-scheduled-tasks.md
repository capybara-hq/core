# Scheduled Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members (and agents, with approval) create cron or one-off scheduled tasks that run an
agent as the creator, in the creator's time zone, into a new conversation, a fixed conversation or a
channel chat's current conversation, without being blocked by approvals.

**Architecture:** A new kernel domain `packages/kernel/src/schedules/` owns three tables, a
`@LockedCron` scanner that turns due ticks into task runs exactly once, and a maintenance-queue fire
job that posts a marked `user_message` (new conversation, or through the conversation queue). The
marker sets `runs.scheduled_task_run_id`, which makes the run (and its descendants) unattended; the
policy check then consults the task's grants and the org's `unattendedAsk`. HTTP, Platform
operations, four builtin tools and web pages sit on one `ScheduledTasksService`.

**Tech Stack:** NestJS + Fastify, Kysely on PostgreSQL, BullMQ, `cron` 4.4 (`CronTime`), zod,
vitest, Next + TanStack Query, `@capybara-hq/design`.

**Spec:** `docs/superpowers/specs/2026-11-11-scheduled-tasks-design.md` (read it before any task;
section numbers below are the spec's).

## Global Constraints

- AGENTS.md applies in full; skills to read per task are named in each task.
- Migration file: `packages/kernel/src/migrations/0113_scheduled_tasks.sql`, plain SQL,
  `IF [NOT] EXISTS`, schema `capybara`, expand-only.
- BullMQ job ids contain no `:`; the fire job id is `sched-fire-<taskRunId>` on the maintenance
  queue (`MAINTENANCE_QUEUE_NAME`).
- Writes in `@Transactional()`; enqueues, bus publishes and `KernelEvents` emits in `afterCommit`.
- The scanner is `@LockedCron("* * * * *", { name: "scheduled-task-scan" })`, provided only under
  `WorkerModule`.
- Every new route: a Platform operation or an exclusion with a reason (`pnpm check:platform-ops`).
- Model-facing text English; UI copy through i18n zh + en; zh says 定时任务 and 智能体.
- Tool keys `ScheduleCreate`, `ScheduleUpdate`, `ScheduleList`, `ScheduleDelete` (no dots).
- Org setting defaults (spec §9): `enabled true`, `minIntervalMinutes 60`, `maxTasksPerMember 20`,
  `maxTasksPerOrg 200`, `maxRunsPerHour 60`, `defaultExpiryDays null`, `catchUpWindowMinutes 60`,
  `unattendedAsk "fail"`, `pauseAfterFailures 5`, `forbiddenTools []`.
- Platform config (spec §9): `schedules.minIntervalFloorMinutes` 5, `schedules.maxTasksPerMemberCap`
  100, `schedules.maxTasksPerOrgCap` 2000, `schedules.maxRunsPerHourCap` 600 (caps are *plan
  call*; the floor is the spec's).
- Jitter: `jitter_seconds = fnv1a32(taskId) mod min(floor(0.1 × intervalSeconds), 300)`; `once`
  tasks 0.
- Minimum interval check: smallest gap among the next 50 fire times.
- Replay: run the zero-drift fixture tests (`reconstruct.test.ts`, `rename-compat.test.ts`) before
  and after Task 4.
- Run a single test from the repo root: `pnpm exec vitest run <path>`.

## Review Focus

- A task whose creator was removed from the org between scan and fire must not run (fire job
  re-checks membership, Task 6 test `skips and pauses when the creator left the org`).
- DST: `30 2 * * *` in `America/New_York` on the spring-forward day fires 0 times, on the
  fall-back day once (Task 2 test `dst gaps and repeats`).
- A person typing in a `conversation`/`chat` target while a tick fires: the tick waits in the queue
  and the person's run stays attended (Task 6 test `tick waits behind a person's run`).
- An org lowering `maxTasksPerMember` below a member's count: existing tasks keep running, new ones
  are refused (Task 5 test `lowered limit refuses new tasks only`).
- A task whose agent tool's `spec_hash` changed after the trial: handled as missing grant, not
  allowed (Task 7 test `stale spec hash is a missing grant`).

---

## Wave plan

- Wave 1 (parallel, disjoint files): Task 1, Task 2, Task 3.
- Wave 2: Task 4 (runtime / replay; review alone on the most capable model), Task 5.
- Wave 3: Task 6 (multi-replica firing; review alone), Task 7 (trust boundary; review alone).
- Wave 4 (parallel): Task 8, Task 9, Task 10, Task 11.
- Wave 5: Task 12 (web), Task 13 (end-to-end and dual-replica).

---

### Task 1: Schema, migration and store

Skills: `writing-migrations`.

**Files:**
- Create: `packages/kernel/src/migrations/0113_scheduled_tasks.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts` (new table interfaces; `RunsTable`,
  `ConversationsTable`, `ConversationQueueTable` columns)
- Create: `packages/kernel/src/schedules/types.ts`, `packages/kernel/src/schedules/store.ts`,
  `packages/kernel/src/schedules/store.module.ts`
- Test: `packages/kernel/test/schedules/store.test.ts`, migration test in
  `packages/kernel/test/migrations/` (follow the existing pattern)

**Interfaces:**
- Produces (types.ts):
  ```ts
  export type ScheduleTrigger =
    | { kind: "cron"; expr: string; timeZone: string }
    | { kind: "once"; at: string /* local ISO date-time, no offset */; timeZone: string };
  export type ScheduleMode = "new" | "conversation" | "chat";
  export interface ScheduleChat { connectionId: string; chatId: string; chatType: "dm" | "group" }
  export type ScheduleStatus = "active" | "paused" | "ended";
  export type SchedulePauseReason = "creator" | "admin" | "failures" | "creator_inactive"
    | "agent_gone" | "target_gone" | "conversation_gone" | "org_disabled" | "expired";
  export type TaskRunStatus = "pending" | "running" | "completed" | "failed" | "skipped";
  export type TaskRunSkipReason = "missed" | "overlap" | "rate_limited" | "queue_paused"
    | "removed" | "device_offline" | "creator_inactive" | "agent_gone" | "target_gone"
    | "conversation_gone" | "org_disabled";
  export interface ScheduledTask { id; orgId; accountId; agentId; name; prompt; trigger: ScheduleTrigger;
    mode: ScheduleMode; conversationId: string | null; chat: ScheduleChat | null; model: string | null;
    effort: string | null; deviceId: string | null; status: ScheduleStatus;
    pauseReason: SchedulePauseReason | null; pausedBy: string | null; nextRunAt: Date | null;
    jitterSeconds: number; expiresAt: Date | null; consecutiveFailures: number;
    createdAt: Date; updatedAt: Date }
  export interface TaskRun { id; taskId; orgId; scheduledFor: Date; firedAt: Date | null; trial: boolean;
    conversationId: string | null; runId: string | null; status: TaskRunStatus;
    skipReason: TaskRunSkipReason | null; error: string | null; missingGrants: string[] }
  export interface ScheduleMarker { taskId: string; taskRunId: string; scheduledFor: string; trial: boolean }
  ```
- Produces (store.ts, `ScheduledTaskStore`, `@Injectable`, every method takes `t: KernelSchemaDb`
  first so callers choose the transaction): `insertTask`, `getTask(t, orgId, id)`,
  `updateTask(t, id, patch)`, `softDelete(t, id)`, `listForAccount(t, orgId, accountId)`,
  `listForOrg(t, orgId)`, `countActive(t, orgId, accountId?)`,
  `lockDue(t, now, limit): ScheduledTask[]` (`FOR UPDATE SKIP LOCKED`),
  `insertRun(t, run): TaskRun | null` (null on the unique conflict),
  `updateRun(t, id, patch)`, `latestNonTerminalRun(t, taskId)`, `countFiredSince(t, orgId, since)`,
  `listRuns(t, taskId, limit)`, `listGrants / addGrant / removeGrant(t, taskId, …)`,
  `findGrant(t, taskId, toolKey, specHash, connectorId): boolean`.

- [ ] **Step 1:** Write the migration: tables `scheduled_tasks`, `scheduled_task_runs`,
  `scheduled_task_grants` exactly as spec §4 (plus `chat jsonb`, `mode` check
  `'new','conversation','chat'`); `UNIQUE (task_id, scheduled_for) WHERE NOT trial`; partial index
  `(next_run_at) WHERE status = 'active' AND deleted_at IS NULL`; columns
  `runs.scheduled_task_run_id text`, `conversations.scheduled_task_id text`,
  `conversation_queue.schedule jsonb` (the marker, nullable).
- [ ] **Step 2:** Write `store.test.ts`: `insertRun twice for the same tick returns null the second
  time`; `lockDue skips rows locked by another transaction`; `trial runs do not collide with a
  scheduled tick`; `findGrant ignores a different spec hash`.
- [ ] **Step 3:** Run `pnpm exec vitest run packages/kernel/test/schedules/store.test.ts`; expect FAIL.
- [ ] **Step 4:** Implement the schema types and store.
- [ ] **Step 5:** Run the test and the migration tests; expect PASS. `pnpm typecheck`.
- [ ] **Step 6:** Commit `feat(kernel): scheduled task tables and store`.

### Task 2: Schedule math

**Files:**
- Create: `packages/kernel/src/schedules/schedule-math.ts`
- Test: `packages/kernel/test/schedules/schedule-math.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function validateTrigger(t: ScheduleTrigger, now: Date):
    { ok: true } | { ok: false; code: "schedule.invalid_cron" | "schedule.invalid_time_zone" | "schedule.once_in_past" };
  export function minGapMinutes(t: ScheduleTrigger, from: Date): number | null; // null for once
  export function jitterSeconds(taskId: string, t: ScheduleTrigger, from: Date): number;
  export function nextTick(t: ScheduleTrigger, after: Date): Date | null; // before jitter; null when a once task is past
  export function dueTicks(t: ScheduleTrigger, lastTick: Date, now: Date, catchUpWindowMinutes: number):
    { fire: Date | null; missed: Date[] };
  ```
  `dueTicks` returns the latest tick ≤ now inside the window as `fire` and every older tick since
  `lastTick` as `missed` (spec §6 step 1). Uses `CronTime` from `cron` with the trigger's zone;
  `isTimeZone` from `src/time-zone.ts`.

- [ ] **Step 1:** Write the tests: `rejects a 6-field expression`; `rejects an unknown zone`;
  `0 9 * * * in Asia/Shanghai is 01:00Z`; `dst gaps and repeats` (spring-forward 0 fires, fall-back
  1 fire for `30 2 * * *` America/New_York); `minGapMinutes of */15 is 15`; `jitter is stable per
  id and ≤ 300 s and ≤ 10 % of the interval`; `dueTicks after a 3 h outage on an hourly task fires
  the latest and reports 2 missed`; `dueTicks drops a tick older than the window`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat(kernel): schedule math for scheduled tasks`.

### Task 3: Org settings and platform bounds

Skills: `adding-config`.

**Files:**
- Modify: `packages/kernel/src/orgs/settings.service.ts` (`OrgSettingsSchema`,
  `OrgSettingsPatchSchema`)
- Modify: `packages/kernel/src/config/schema.ts` (`schedules` group), regenerate `docs/config.md`
- Create: `packages/kernel/src/schedules/effective-settings.ts`
- Test: `packages/kernel/test/schedules/effective-settings.test.ts`, the existing org settings tests

**Interfaces:**
- Produces:
  ```ts
  export const ScheduledTasksSettingsSchema: z.ZodType<ScheduledTasksSettings>; // spec §9 fields, defaults, .catch
  export interface EffectiveScheduleSettings extends ScheduledTasksSettings {} // clamped
  export function effectiveScheduleSettings(org: ScheduledTasksSettings, bounds: ScheduleBounds): EffectiveScheduleSettings;
  export async function readScheduleSettings(db: KernelSchemaDb, config: KernelConfigService, orgId: string): Promise<EffectiveScheduleSettings>;
  ```
  `OrgSettingsSchema.scheduledTasks` defaults to the spec §9 values; lenient parse.

- [ ] **Step 1:** Tests: `defaults match spec §9`; `minInterval below the floor is clamped to 5`;
  `counts above the caps are clamped`; `an invalid stored value falls back to the default`; PATCH
  of `scheduledTasks` round-trips through the org settings route (extend the existing settings
  HTTP test).
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement; `pnpm gen:config-docs` (or the repo's doc
  generator named in `adding-config`). **Step 4:** Run; PASS. **Step 5:** Commit
  `feat(kernel): scheduled task org settings`.

### Task 4: The schedule marker through the runtime

Skills: `replay-evals`, `writing-kernel-api`. Review alone on the most capable model.

**Files:**
- Modify: `packages/kernel/src/conversations/events.ts` (`user_message.schedule?: ScheduleMarker`,
  not model-visible; `run_started.trigger` gains `"schedule"`)
- Modify: `packages/kernel/src/conversations/message-context.ts` (`readMessageContext` input
  `timeZoneOverride?: string`, highest priority)
- Modify: `packages/kernel/src/conversations/queue.ts` (`dispatchQueuedIn` copies
  `conversation_queue.schedule` into the `user_message`)
- Modify: `packages/kernel/src/conversations/conversations.service.ts` (accept `schedule` and
  `timeZoneOverride` on the create-with-message and queue-add paths, internal callers only; not on
  the HTTP DTOs)
- Modify: `packages/kernel/src/runtime/run-queue.ts` (`ensureRunIn`: set
  `runs.scheduled_task_run_id` from the trigger message's marker; inherit it for sub-agent runs and
  for wake runs whose waking event came from an unattended run, same lineage as `budget_run_id`)
- Modify: `packages/kernel/src/runtime/run-worker.ts` (`run_started.trigger = "schedule"`)
- Modify: `packages/kernel/src/runtime/context/build.ts` (render a marked message with the header
  `[Scheduled task "<name>", run for <local time>]` from fields in the log: the marker gains
  `taskName` and `localTime` strings, fixed at write time)
- Create: `packages/kernel/src/schedules/unattended.ts`
- Test: `packages/kernel/test/schedules/marker.test.ts`; run
  `packages/kernel/test/evals/reconstruct.test.ts` and `rename-compat.test.ts`

**Interfaces:**
- Consumes: `ScheduleMarker` (Task 1; this task adds `taskName: string; localTime: string`).
- Produces:
  ```ts
  // unattended.ts
  export async function unattendedTaskRunOf(db: KernelSchemaDb, runId: string):
    Promise<{ taskRunId: string; taskId: string; trial: boolean } | null>;
  ```
  Internal option on `ConversationsService.createWithMessage` and `ConversationQueueService.add`:
  `{ schedule?: ScheduleMarker; timeZoneOverride?: string }`.

- [ ] **Step 1:** Run the zero-drift tests; record PASS.
- [ ] **Step 2:** Tests in `marker.test.ts`: `a marked first message sets runs.scheduled_task_run_id`;
  `a person's message in the same conversation starts a run without it`; `a sub-agent run inherits
  it`; `a background-task wake of an unattended run inherits it`; `a wake whose event came from an
  attended run does not`; `timeZoneOverride beats the account setting and lands in run_context`;
  `a queued marked item dispatches with its marker`; `the header renders from the log only` (change
  the task's name after the run; the rebuilt request is unchanged).
- [ ] **Step 3:** Run; FAIL. **Step 4:** Implement. **Step 5:** Run the new tests and the zero-drift
  tests; PASS. **Step 6:** Commit `feat(kernel): schedule marker on messages and runs`.

### Task 5: ScheduledTasksService (CRUD, limits, roles, grants)

Skills: `writing-kernel-api`.

**Files:**
- Create: `packages/kernel/src/schedules/scheduled-tasks.service.ts`,
  `packages/kernel/src/schedules/schedules.module.ts`, `packages/kernel/src/schedules/errors.ts`
- Modify: `packages/kernel/src/orgs/roles.ts` (`schedules.use`: member, `schedules.manage`: admin;
  both in `HUMAN_ONLY`), the error code registry
- Test: `packages/kernel/test/schedules/service.test.ts`

**Interfaces:**
- Consumes: store (Task 1), schedule math (Task 2), `readScheduleSettings` (Task 3).
- Produces (`ScheduledTasksService`):
  ```ts
  create(orgId: string, accountId: string, input: CreateTaskInput, browserTimeZone?: string): Promise<ScheduledTask>;
  update(orgId: string, accountId: string, id: string, patch: UpdateTaskInput): Promise<ScheduledTask>; // creator only
  pause(orgId, actor: { accountId: string; role: OrgRole }, id): Promise<ScheduledTask>;   // creator or schedules.manage
  resume(orgId, actor, id): Promise<ScheduledTask>;
  remove(orgId, actor, id): Promise<void>;
  get(orgId, actor, id); list(orgId, actor, { all?: boolean });
  runs(orgId, actor, id, limit?): Promise<TaskRun[]>;
  addGrants(orgId, accountId, id, grants: GrantInput[]); removeGrant(orgId, accountId, id, toolKey);
  pauseFor(t, taskId, reason: SchedulePauseReason, by: string | null): Promise<void>; // used by Tasks 6, 8
  ```
  `CreateTaskInput = { agentId, name, prompt, trigger: { kind: "cron"; expr } | { kind: "once"; at },
  timeZone?, mode, conversationId?, chat?, model?, effort?, deviceId?, grants?: GrantInput[] }`;
  `GrantInput = { toolKey: string; connectorId?: string }` (the service resolves the current
  `spec_hash`). Error codes: `schedule.not_found`, `schedule.invalid_cron`,
  `schedule.invalid_time_zone`, `schedule.once_in_past`, `schedule.interval_too_short`,
  `schedule.limit_reached`, `schedule.disabled`, `schedule.target_invalid`,
  `schedule.grant_not_allowed`, `schedule.forbidden`.
- `expires_at` at create: `now + defaultExpiryDays` for a cron task when the org sets it, else the
  input's, else null.
- Time zone at create (spec §5): `input.timeZone ?? account.time_zone ?? browserTimeZone ??
  org.timeZone ?? "UTC"`.
- `chat` validation (spec §8): the connection is active and its agent is `agentId`; `dm` needs a
  `channel_threads` row (archived allowed) with `account_id = accountId` and that `chat_id`; `group`
  needs such a row for the group and the connection's `features.threads`.
- Grant validation (spec §7): the creator could approve with scope `always` (no `requiredRole`
  above their role), the tool is not in `forbiddenTools`, not fixed-ask, not `SkillWrite`.
- Audit events `schedule.created / updated / paused / resumed / deleted / grants_changed`;
  admin actions carry the admin as actor.

- [ ] **Step 1:** Tests: `creates with the account zone, else the browser zone`; `refuses an
  interval below the org minimum`; `lowered limit refuses new tasks only`; `guest cannot create`;
  `admin lists, pauses, deletes others' tasks`; `admin cannot update another's task`
  (`schedule.forbidden`); `chat target must be the creator's DM with that connection`; `refuses a
  forbidden or role-escalated tool as a grant`; `once in the past is refused`; `resume recomputes
  next_run_at from now`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit
  `feat(kernel): scheduled tasks service`.

### Task 6: Scanning and firing

Skills: `writing-kernel-api`, `writing-channels` (thread binding). Review alone on the most capable
model.

**Files:**
- Create: `packages/kernel/src/schedules/scan.job.ts` (`ScheduledTaskScanJob`, `@LockedCron`),
  `packages/kernel/src/schedules/fire.ts` (`ScheduledTaskFirer`), `packages/kernel/src/schedules/job-ids.ts`,
  `packages/kernel/src/schedules/run-tracker.ts`
- Modify: `packages/kernel/src/runtime/maintenance.ts` (dispatch `SCHED_FIRE_JOB = "sched-fire"`),
  `packages/kernel/src/roles/worker.module.ts`, `packages/kernel/src/channels/threads.ts` (export a
  helper to find-or-bind a DM thread inside a transaction)
- Test: `packages/kernel/test/schedules/fire.test.ts`, `packages/kernel/test/schedules/scan.dual.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5; `createWithMessage` / queue-add options from Task 4.
- Produces:
  ```ts
  export const SCHED_FIRE_JOB = "sched-fire";
  export const schedFireJobId = (taskRunId: string) => `sched-fire-${taskRunId}`;
  ScheduledTaskFirer.fire(taskRunId: string): Promise<void>;          // idempotent on run status
  ScheduledTasksService.runNow(orgId, accountId, id, { trial: boolean }): Promise<TaskRun>; // added here
  ScheduledTaskRunTracker.onRunFinished(runId: string, outcome: "completed" | "failed" | "aborted"): Promise<void>;
  ```
- Scan (spec §6): per due task, `dueTicks` → one `skipped`/`missed` run for the missed ticks (if
  any), `insertRun` for `fire`, `next_run_at = nextTick + jitter` (or `ended` for a fired `once`
  task or past `expires_at`), enqueue in `afterCommit`.
- Fire checks in this order, each a `skipped` run with the reason; the "lasting" ones also
  `pauseFor`: org disabled (`org_disabled`, pause), creator inactive / not a member (pause), agent
  gone or not visible (pause), conversation gone (pause), connection inactive (`target_gone`,
  pause), overlap (`latestNonTerminalRun`), rate limit (`countFiredSince(1 h) ≥ maxRunsPerHour`),
  device offline, queue paused.
- `new`: `createWithMessage` with `create_request_id = taskRunId`, marker, `timeZoneOverride`,
  `conversations.scheduled_task_id`.
- `conversation`: queue-add with marker (client message id `sched-<taskRunId>`).
- `chat`, `dm`: in one transaction find the live thread (`findThread` with thread key
  `dm:<creator's external id on the connection>`, from `identities` by the connection's source);
  if none, create the conversation, `insertThread`, upsert `channel_deliveries` with
  `{ chatId, chatType: "dm" }`; then queue-add. `group` is Task 8.
- Run tracking: subscribe to the existing run-terminal path (where `run_finished` / `run_failed` /
  `run_aborted` are written) and call `onRunFinished` for runs with `scheduled_task_run_id`;
  `aborted` counts as `completed`; failures update `consecutive_failures` and pause at
  `pauseAfterFailures`. A queued item removed by a person marks the task run `skipped`/`removed`.

- [ ] **Step 1:** Tests (`fire.test.ts`): `new mode creates one conversation per tick`; `a retried
  fire job does not create a second conversation`; `skips and pauses when the creator left the org`;
  `overlap skips while the previous run waits`; `rate limit skips without pausing`; `tick waits
  behind a person's run` (conversation mode); `dm chat reuses the live thread`; `dm chat after /new
  creates and binds a new conversation, and a later inbound reply lands in it`; `once task ends
  after its run`; `five failures pause the task`; `run now does not move next_run_at`.
- [ ] **Step 2:** Test (`scan.dual.test.ts`, dual-replica helper): `two replicas fire one run per
  tick`; `three hours of downtime produce one fired and one skipped run`.
- [ ] **Step 3:** FAIL. **Step 4:** Implement. **Step 5:** PASS. **Step 6:** Commit
  `feat(kernel): fire scheduled tasks`.

### Task 7: Unattended policy and trial grants

Skills: `writing-tools`, `writing-connectors` (connection_required, elicitation). Review alone on
the most capable model.

**Files:**
- Modify: `packages/kernel/src/tools/policy.ts` (`createDecidePolicy`: unattended branch),
  `packages/kernel/src/tools/pipeline.ts` (`PolicyContext.unattended?: { taskId; taskRunId; trial;
  unattendedAsk; forbiddenTools }`, filled once per run), the `AskUserQuestion` builtin,
  the `connection_required` and elicitation paths, `packages/kernel/src/tools/approvals.service.ts`
  (trial approvals → task grants)
- Test: `packages/kernel/test/schedules/unattended-policy.test.ts`

**Interfaces:**
- Consumes: `unattendedTaskRunOf` (Task 4), `ScheduledTaskStore.findGrant / addGrant /
  updateRun` (Task 1), `readScheduleSettings` (Task 3).
- Produces: `export const UNATTENDED_ASK_ERROR = (tool: string) => \`This scheduled run cannot ask
  for approval; the task's owner can add ${tool} to the task's approved tools.\``;
  `export const UNATTENDED_QUESTION_ERROR = "No one is present in this scheduled run; decide with
  the information you have, or state the open question in your final answer."` (both in
  `schedules/unattended.ts`).
- Rules (spec §7), for an unattended, non-trial run: tool in `forbiddenTools` → deny; `SkillWrite`
  → treated as `ask` even when it would allow; on `ask`: a task grant with the current `spec_hash`
  → allow (never for fixed-ask); else `unattendedAsk = "fail"` → refuse with
  `UNATTENDED_ASK_ERROR`, append the tool key to `missing_grants`; `"wait"` → today's approval.
  `AskUserQuestion` → `UNATTENDED_QUESTION_ERROR` in `fail`; `connection_required` → error +
  `connection:<connectorSlug>` in `missing_grants`; elicitation → declined. Trial runs are
  attended: every approval the creator grants (any scope, not role-escalated) is also added as a
  task grant.

- [ ] **Step 1:** Tests: `granted ask runs`; `ungranted ask fails and records missing_grants`;
  `wait mode creates an approval for the creator`; `forbidden tool is denied even with a grant`;
  `SkillWrite on a private agent is refused`; `fixed-ask tool is never covered`; `stale spec hash is
  a missing grant`; `sub-agent of a scheduled run uses the task's grants`; `AskUserQuestion does not
  wait`; `missing personal connection is recorded`; `trial approvals become task grants`;
  `role-escalated trial approval is not kept`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit
  `feat(kernel): unattended policy for scheduled runs`.

### Task 8: Group threads and delivery failures

Skills: `writing-channels`.

**Files:**
- Modify: `packages/kernel/src/schedules/fire.ts` (group branch), `packages/kernel/src/channels/outbound.ts`
  (after the first post of a run whose conversation has a pending group binding, write
  `channel_threads` with thread key = the returned `messageId`; on `ChannelSendError.reason`
  `target_gone` / `auth`, pause the task of the run's `scheduled_task_run_id`)
- Test: `packages/kernel/test/schedules/channel-delivery.test.ts`

**Interfaces:**
- Consumes: `ScheduledTasksService.pauseFor` (Task 5), the firer (Task 6).
- Group runs: a new conversation per run with `channel_deliveries.target = { chatId, chatType:
  "group" }` and a pending-binding marker (column or jsonb on `channel_deliveries`; builder's
  choice, expand-only migration `0110_…` if needed).

- [ ] **Step 1:** Tests (with `startFakeTelegram` / fake Lark): `group run binds the thread at its
  first post and a reply in that thread continues it`; `target_gone pauses the task with
  target_gone`; `dm delivery posts the run's answer to the fake Telegram chat`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit
  `feat(kernel): scheduled task channel delivery`.

### Task 9: Inbox items

**Files:**
- Modify: `packages/kernel/src/inbox/inbox.service.ts` (new item kind `schedule_attention`:
  `{ taskId, name, reason: SchedulePauseReason | "missing_grants", missing?: string[] }`, for the
  creator only), the producers in `ScheduledTasksService.pauseFor` and the tracker
- Test: `packages/kernel/test/inbox/schedule-attention.test.ts`

- [ ] **Step 1:** Tests: `a paused task shows in its creator's inbox with the reason`; `pause by the
  creator shows nothing`; `admin pause names the admin`; `missing grants show the tool keys`;
  `resuming clears the item`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit
  `feat(kernel): inbox items for scheduled tasks`.

### Task 10: HTTP routes and Platform operations

Skills: `writing-kernel-api` (Platform operations section).

**Files:**
- Create: `packages/kernel/src/schedules/schedules.controller.ts`, `schedules.schemas.ts`,
  `packages/kernel/src/platform/ops/schedules.ops.ts`
- Modify: `packages/kernel/src/platform/route-schemas.ts`, `PlatformOpsModule`
- Test: `packages/kernel/test/schedules/schedules.http.test.ts`; `platform-parity.test.ts` must pass

**Interfaces:**
- Routes under `/api/v1/orgs/:orgId/schedules` (spec §10): `GET /` (`?all=true` needs
  `schedules.manage`), `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`, `POST /:id/pause`,
  `POST /:id/resume`, `POST /:id/run` (`{ trial?: boolean }`), `GET /:id/runs`,
  `GET /:id/grants`, `POST /:id/grants`, `DELETE /:id/grants/:toolKey`. `@OrgAction("schedules.use")`
  except admin listing. Create reads the browser zone from the request body field `timeZone`
  only when the account has none (same rule as Task 5).
- Operations `schedules.list / get / create / update / delete / pause / resume / run / runs /
  grants.list / grants.add / grants.remove`; confirm class `read` for reads, `personal` for writes,
  `rememberable: false` for `delete`.

- [ ] **Step 1:** Tests: one happy path per route; `403 for a guest`; `404 for another org`;
  `admin ?all=true`. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, plus
  `pnpm check:platform-ops` and `platform-parity.test.ts`. **Step 5:** Commit
  `feat(kernel): scheduled tasks API`.

### Task 11: Builtin tools

Skills: `writing-tools`.

**Files:**
- Create: `packages/kernel/src/tools/builtins/schedules.ts`
- Modify: `packages/kernel/src/tools/builtin-names.ts` (add to `BUILTIN`, `BUILTIN_TOOL_NAMES`,
  `AGENT_BUILTIN_NAMES`, `BUILTIN_TOOL_KINDS`, `CHILD_REMOVED_TOOLS` for sub-agents),
  `apps/web/src/lib/agents.ts`, `apps/web/src/lib/timeline.ts`,
  `packages/kernel/src/tools/builtins/builtin-tools.ts`, the R3 fixed-ask key list
  (`ScheduleCreate`, `ScheduleUpdate`)
- Test: `packages/kernel/test/tools/schedule-tools.test.ts`; `builtin-names.test.ts`

**Interfaces:**
- `ScheduleCreate { name, prompt, cron?: string, runAt?: string, mode: "new" | "here",
  approvedTools?: string[] }` — `here` = a `chat` task for the conversation's chat when it has
  `channel_deliveries` (DM), else `conversation`; zone from the run's `run_context`; approval
  summary shows name, schedule, zone, target and tools. `ScheduleUpdate { id, …same optional }`.
  `ScheduleList {}` → the creator's tasks (id, name, schedule, zone, status, next run).
  `ScheduleDelete { id }`, allow, own tasks only.
- Errors: map the service codes to English actionable text.

- [ ] **Step 1:** Tests: `ScheduleCreate asks and the created task matches the approved input`;
  `here in an IM DM creates a chat task`; `here in a web conversation creates a conversation task`;
  `an unattended run cannot create a task` (fixed ask + `fail` → refused); `ScheduleDelete refuses
  another member's task`. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:**
  Commit `feat(kernel): schedule tools`.

### Task 12: Web pages

Skills: `writing-web-ui`.

**Files:**
- Create: `apps/web/src/app/(app)/schedules/{page.tsx,view.tsx}`,
  `apps/web/src/app/(app)/schedules/new/{page.tsx,view.tsx}`,
  `apps/web/src/app/(app)/schedules/[id]/{page.tsx,view.tsx}`,
  `apps/web/src/app/(app)/settings/schedules/{page.tsx,view.tsx}`,
  `apps/web/src/lib/schedules.ts`, `apps/web/src/lib/query/schedules.ts`
- Modify: nav (`components/shell/nav.tsx`), `components/settings-nav.ts` (admin item), the
  conversation header ("Started by the scheduled task <name>"), the inbox item renderer, i18n
  catalogs (zh, en)
- Test: route tests with `renderRouteWithCache` / `renderRouteEmptyCache` per page

**Interfaces:**
- Consumes: Task 10 routes.
- `/schedules`: `ListPage` + `DataTable` (name, agent, schedule in words with zone, status, next run,
  last result). `/schedules/new` and `/schedules/[id]`: `FormPage` with `FormSection`s per spec
  §10, a schedule preset picker that writes cron, approved tools picker, run history table, actions
  "Run now", "Trial run", pause / resume, delete. `/settings/schedules`: the §9 settings form and
  all tasks (admin). Members without `schedules.use` (guests) see the designed no-access state.

- [ ] **Step 1:** Tests: each page renders from cache and empty cache; guest sees the no-access
  state; admin settings saves the §9 fields; `pnpm check:web-ui`, `pnpm check:i18n`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit
  `feat(web): scheduled tasks pages`.

### Task 13: End-to-end and replay

**Files:**
- Test: `packages/kernel/test/schedules/e2e.test.ts`, a replay fixture in
  `packages/kernel/test/evals/`

- [ ] **Step 1:** Tests with `model-fake`: `a daily task to a Telegram DM posts its answer and a
  reply continues the same conversation`; `a scheduled run reconstructs with zero drift`;
  `a trial run collects a grant and the next scheduled run uses it without asking`.
- [ ] **Step 2:** Run; fix what fails in the owning task's files.
- [ ] **Step 3:** `pnpm verify`; expect all required checks green.
- [ ] **Step 4:** Commit `test(kernel): scheduled tasks end to end`; add a changeset for
  `@capybara-hq/capybara` (images change).
