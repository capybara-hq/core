# Transactional Outbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. With more than five tasks, plan the waves with `wave-planned-subagent-development`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Work that must follow a commit becomes an outbox row written in the same transaction and delivered by a fast path plus one relay; the per-feature recovery sweeps, `kickRun` on reads and the op-first device policy order go.

**Architecture:** A `capybara.outbox` table, `OutboxService.add` (transaction mandatory), an `OutboxDispatcher` used by an `afterCommit` fast path and by a `@LockedInterval` relay on the worker role, dead letters in the super admin overview. Feature code moves its owed enqueues into its transactions part by part (7 PRs); device policy changes become intent → call → resolve with a resolver job.

**Tech Stack:** TypeScript, NestJS, Kysely on Postgres, BullMQ on Valkey, vitest, `@capybara-hq/testing` (`startTestKernel`, `createDualReplicaHarness`), `tools/checks` (`check:kernel-conventions`).

**Spec:** `docs/superpowers/specs/2026-11-12-transactional-outbox-design.md` (read it first; § numbers below refer to it).

## Global Constraints

- Queue names and job ids contain no `:`; every outbox job id is deterministic.
- Writes run in `@Transactional()` methods; `OutboxService.add` is `@Transactional({ propagation: "mandatory" })`.
- Only `infra/outbox/outbox.dispatcher.ts` calls Redis while holding a PG transaction, and only with outbox rows locked (spec §3.3); it carries a `kc-side-effect-in-tx` exception with that reason.
- Relay: `@LockedInterval` every 2000 ms, batch 500, provided only under `WorkerModule` (`kc-worker-only`).
- Backoff: 1 s doubling, capped at 300 s; dead letter after 20 attempts (`dead_at`).
- New job names `ensure-run`, `stop-tree`, `deliver-to-parent`, `device-op-resolve` go on `cap-kernel-maintenance`; `ensure-run` is written with `runAt = now + 30 s`.
- Usage rows only while the deployment has an enabled `usage.report` subscriber (cache 30 s, invalidated on `PLUGINS_CHANGED`).
- Device: last 100 op ids kept; feature flag `policyOpId`; no compatibility for devices without it.
- Latency budget: message-to-run-job-added p50 at most +5 ms (measured in Task 11).
- Migrations: plain SQL, `IF [NOT] EXISTS`, next free number at implementation time (0119 after main's 0119/0120 sandbox-tier migrations), applied files immutable; destructive statements carry the exemption comment.
- English for code, comments, test titles; UI text through i18n (en and zh; zh says 平台 / 超级管理员).
- Every PR that changes `@capybara-hq/kernel`, `plugin-sdk` or `device` adds a changeset; `pnpm gen:sdk-api` when the SDK API changes.
- Run single tests from the repo root: `pnpm exec vitest run <path>`. Before each PR: `pnpm verify`.
- Zero-drift fixtures (`packages/kernel/test/evals/reconstruct.test.ts`) pass before and after every part: nothing model-visible changes.

## Review Focus

1. **Redis unreachable while a member sends a message:** the send succeeds (201), the run starts once Redis is back, the member sees no error. Test in Task 8.
2. **Two messages to one idle conversation within milliseconds:** exactly one run starts for the first trigger and the second is absorbed or queued as today; no orphaned `queued` row. Test in Task 7.
3. **An approval decided while its run is still `running` (decision races `suspend`):** the run is never left `waiting` with a decided approval. Test in Task 9.
4. **An org deleted while it has pending outbox rows:** its rows go with it; no job runs afterwards for that org. Test in Task 2.
5. **A device disconnecting between the policy op and its resolve:** the network ask returns to `pending` with a reason, never stays `deciding`; the audit names the outcome. Test in Task 19.

---

## Part 1 (PR 1): the outbox

### Task 1: Outbox table and types

**Files:**
- Create: `packages/kernel/src/migrations/0119_outbox.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts` (add `OutboxTable`, register `outbox`)
- Test: `packages/kernel/test/migrations/0119-outbox.test.ts`

**Interfaces:**
- Produces: table `outbox` with the columns and indexes of spec §4 exactly; Kysely `OutboxTable` with `id: Generated<string>` (bigint as string, like other bigint ids), `queue`, `job_name`, `job_id`, `data: Json`, `run_at: Date | null`, `org_id: string | null`, `attempts: Generated<number>`, `next_attempt_at: Generated<Date>`, `last_error: string | null`, `dead_at: Date | null`, `created_at: Generated<Date>`.

- [ ] **Step 1: Write the failing test** `0119 creates outbox with a unique (queue, job_id) and a partial due index`: after migrating, `information_schema.columns` lists the 12 columns with the types above; inserting two rows with the same `(queue, job_id)` raises `23505`; `pg_indexes` has `outbox_due` with `WHERE (dead_at IS NULL)`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/migrations/0119-outbox.test.ts` → FAIL (relation "outbox" does not exist).
- [ ] **Step 3: Write the migration** with the SQL of spec §4 verbatim; add `OutboxTable` to `kernel-schema.ts`.
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Commit** `feat(kernel): the outbox table (migration 0119)`.

### Task 2: OutboxService and the job registry

**Files:**
- Create: `packages/kernel/src/infra/outbox/outbox.service.ts`, `packages/kernel/src/infra/outbox/registry.ts`, `packages/kernel/src/infra/outbox/outbox.module.ts` (global, exports `OutboxService`, `OutboxDispatcher`)
- Modify: `packages/kernel/src/kernel.module.ts` (import `OutboxModule`), `packages/kernel/src/orgs/orgs.service.ts:262` (org delete removes the org's rows)
- Test: `packages/kernel/test/infra/outbox.service.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // registry.ts
  export const OUTBOX_JOBS = { /* name → { queue: KernelQueueName; idempotent: string } */ } as const;
  export type OutboxJobName = keyof typeof OUTBOX_JOBS;
  export type KernelQueueName = (typeof KERNEL_QUEUE_NAMES)[number]; // from admin/health.service.ts; move the list to infra/queue/queue-names.ts and re-export
  // outbox.service.ts
  export interface OutboxJob<T> { queue: KernelQueueName; name: OutboxJobName; jobId: string; data: T; runAt?: Date; orgId?: string }
  export class OutboxService {
    @Transactional({ propagation: "mandatory" }) add<T>(job: OutboxJob<T>): Promise<boolean>; // true = inserted
  }
  ```
  `add` registers one `afterCommit(() => dispatcher.dispatchOwn(ids))` per transaction (Task 3), collecting the inserted ids in the transaction store.
- Registry entries are added by the task that introduces each job name; this task adds none except a test-only name registered from the test.

- [ ] **Step 1: Write the failing tests**
  - `add outside a transaction throws` (the `mandatory` propagation error).
  - `add inside a rolled-back transaction leaves no row`.
  - `a second add of the same (queue, jobId) returns false and keeps one row`.
  - `a conflicting add with different data throws in tests` (`NODE_ENV=test` path; production path logs `outbox job id reused with different data` at error).
  - `deleting an org removes its pending rows and keeps rows without org_id` (Review Focus 4).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/infra/outbox.service.test.ts` → FAIL.
- [ ] **Step 3: Implement** `OutboxService.add` (`INSERT … ON CONFLICT (queue, job_id) DO NOTHING RETURNING id`; on no row, read the stored `data` and compare with `isDeepStrictEqual`), the registry, the module; in `OrgsService` soft delete, `DELETE FROM outbox WHERE org_id = $1 AND dead_at IS NULL` in the same transaction.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(kernel): OutboxService.add in the caller's transaction`.

### Task 3: Dispatcher and fast path

**Files:**
- Create: `packages/kernel/src/infra/outbox/outbox.dispatcher.ts`
- Modify: `packages/kernel/src/overrides.ts` (seam `OUTBOX_DISPATCH_FAILS: () => boolean`), `tools/checks/src/kernel-conventions.ts` (a `kc-side-effect-in-tx` exception for the dispatcher, reason from Global Constraints)
- Test: `packages/kernel/test/infra/outbox.dispatcher.test.ts`

**Interfaces:**
- Consumes: `OutboxService` (Task 2), the 8 kernel queues via `getQueueToken(name)`.
- Produces:
  ```ts
  export class OutboxDispatcher {
    dispatchOwn(ids: readonly string[]): Promise<void>;          // fast path, never throws
    dispatchDue(limit: number): Promise<{ sent: number; failed: number; dead: number }>; // relay
  }
  export const OUTBOX_BACKOFF = { baseMs: 1000, capMs: 300_000, maxAttempts: 20 } as const;
  ```
  Both claim rows `FOR UPDATE SKIP LOCKED` (`dispatchOwn` by id; `dispatchDue` by `next_attempt_at <= now() AND dead_at IS NULL ORDER BY id LIMIT $1`), group by queue, `addBulk` with `{ jobId, delay: max(0, run_at - now) }` merged over `QUEUE_JOB_DEFAULTS`, delete sent rows, and on a queue error update `attempts`, `last_error`, `next_attempt_at = now + min(cap, base * 2^attempts)`, `dead_at` at 20. Redis calls time out after 2000 ms.

- [ ] **Step 1: Write the failing tests**
  - `the fast path adds the job and deletes the row after commit`.
  - `a delayed row is added at once with the remaining delay` (`run_at` = now + 30 s → job `delay` within 29–30 s).
  - `a failing queue keeps the row with attempts 1 and next_attempt_at about 1 s ahead` (seam `OUTBOX_DISPATCH_FAILS`).
  - `the 20th failure sets dead_at and dispatchDue skips it`.
  - `fast path and dispatchDue racing for one row add one job` (two concurrent calls, `SKIP LOCKED`).
  - `a duplicate add after a crash between add and delete is absorbed by the job id` (add job, abort before delete, dispatch again → one job).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/infra/outbox.dispatcher.test.ts` → FAIL.
- [ ] **Step 3: Implement** the dispatcher and the seam; wire `OutboxService.add`'s `afterCommit` to `dispatchOwn`.
- [ ] **Step 4: Run** → PASS; run `pnpm check:kernel-conventions` → passes with the new exception.
- [ ] **Step 5: Commit** `feat(kernel): dispatch outbox rows after commit, with backoff and dead letters`.

### Task 4: Relay on the worker role

**Files:**
- Create: `packages/kernel/src/infra/outbox/outbox.relay.ts` (`OutboxRelay`, `@LockedInterval("outbox-relay", () => 2000)` calling `dispatchDue(500)` until fewer than 500 come back or 10 rounds), `packages/kernel/src/infra/outbox/outbox-relay.module.ts`
- Modify: `packages/kernel/src/roles/worker.module.ts` (import the relay module)
- Test: `packages/kernel/test/infra/outbox.relay.test.ts`

**Interfaces:**
- Consumes: `OutboxDispatcher.dispatchDue` (Task 3).

- [ ] **Step 1: Write the failing test** `a row the fast path failed is delivered by the other replica's relay within one tick` (`createDualReplicaHarness`, replica A has `OUTBOX_DISPATCH_FAILS` true and no worker role; replica B is a worker; the job exists on its queue within 5 s).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/infra/outbox.relay.test.ts` → FAIL.
- [ ] **Step 3: Implement** the relay and wire it under `WorkerModule`.
- [ ] **Step 4: Run** → PASS; `pnpm check:kernel-conventions` (`kc-worker-only`) passes.
- [ ] **Step 5: Commit** `feat(kernel): the outbox relay on the worker role`.

### Task 5: Dead letters for the super admin

**Files:**
- Create: `packages/kernel/src/admin/outbox-dead.service.ts`, `packages/kernel/src/admin/outbox-dead.controller.ts`, `packages/kernel/src/platform/ops/outbox.ops.ts`
- Modify: `packages/kernel/src/admin/overview.service.ts` (attention source `outbox`), `apps/web` admin overview attention list (new item kind), `apps/web/messages/{en,zh}.json`, the Platform operation index
- Test: `packages/kernel/test/admin/outbox-dead.test.ts`, the parity test (`platform-parity.test.ts`) picks the routes up

**Interfaces:**
- Produces: `GET /api/v1/admin/outbox/dead` (super admin; `{ items: { id, queue, jobName, jobId, orgId, attempts, lastError, deadAt, createdAt }[] }`), `POST /api/v1/admin/outbox/dead/:id/retry` (clears `dead_at`, `attempts = 0`, `next_attempt_at = now()`), `DELETE /api/v1/admin/outbox/dead/:id`; audit `outbox.retried` / `outbox.discarded`; overview attention item `{ kind: "outbox_dead", count, oldestAt }`; Platform operations `admin.outbox.list-dead`, `admin.outbox.retry`, `admin.outbox.discard` built from the routes' schemas.
- UI copy (en / zh): "Background work that could not be queued" / "无法排入队列的后台任务"; "Retry" / "重试"; "Discard" / "丢弃".

- [ ] **Step 1: Write the failing tests** `a dead row appears in the overview attention list`, `retry makes it due again and the relay delivers it`, `discard deletes it and writes the audit`, `an org admin gets 403`, `retrying a row whose entity is gone runs a harmless job` (the test job's idempotency sentence is honoured).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/admin/outbox-dead.test.ts` → FAIL.
- [ ] **Step 3: Implement** service, controller (DTOs via `createZodDto`, `@SuperAdmin`), operations, overview source and the web item (design components only).
- [ ] **Step 4: Run** the test, `platform-parity.test.ts`, `pnpm check:platform-ops`, `pnpm check:i18n`, `pnpm check:web-ui` → PASS.
- [ ] **Step 5: Commit** `feat: dead outbox rows in the super admin overview`.

### Task 6: The checks

**Files:**
- Modify: `tools/checks/src/kernel-conventions.ts` (rules `kc-enqueue-via-outbox`, `kc-after-commit-hint`; a pending list with every current direct enqueue site from spec §8.1, each `reason: "moves to the outbox in PR <n>"`), `tools/checks/README.md`
- Create: `tools/checks/fixtures/kernel-conventions/kc-enqueue-via-outbox/*`, `…/kc-after-commit-hint/*`, `tools/checks/src/outbox-registry.ts` (every `OUTBOX_JOBS` entry has a non-empty `idempotent` and a processor case: a `case <NAME>_JOB` in some `@Processor` for its queue)
- Test: `tools/checks/test/kernel-conventions.test.ts`, `tools/checks/test/outbox-registry.test.ts`

**Interfaces:**
- `kc-enqueue-via-outbox`: in `packages/kernel/src` non-test files, a call to `.add(` / `.addBulk(` on a value typed or named as a BullMQ `Queue`, or to `jobs.enqueue(`, outside `infra/outbox/` and the exceptions (`ctx/queue.ts` extension queues; `infra/queue/add-job-once.ts` CLI). Message: "an owed job is added through OutboxService.add in the transaction that owes it (spec 2026-11-12-transactional-outbox §3)".
- `kc-after-commit-hint`: the same matcher inside the callback passed to `afterCommit(`. Message: "afterCommit is for hints; owed work goes to the outbox".

- [ ] **Step 1: Write the red fixtures and failing tests**: a fixture service calling `queue.add` after a transaction is reported; one calling it inside `afterCommit` is reported by both rules; `OutboxService.add` is clean; a stale pending entry (site already moved) is reported as `kc-stale-pending`.
- [ ] **Step 2: Run** `pnpm exec vitest run tools/checks/test/kernel-conventions.test.ts tools/checks/test/outbox-registry.test.ts` → FAIL.
- [ ] **Step 3: Implement** the rules and the registry check; fill the pending list from a run of the rule over today's code.
- [ ] **Step 4: Run** the tests and `pnpm check` → PASS.
- [ ] **Step 5: Commit** `feat(checks): owed enqueues go through the outbox`; add the changeset; `pnpm verify`; open PR 1 (state "full or diff" for the new rules: full, it is part of `check:kernel-conventions`).

## Part 2 (PR 2): run lifecycle

### Task 7: Run jobs through the outbox

**Files:**
- Modify: `packages/kernel/src/runtime/run-queue.ts` (`ensureRunIn` adds the run job through `OutboxService.add`; delete the read-back, `deleteQueued`, the 30 s orphan grace and the queued-without-job branch; registry entry for the run job names), `packages/kernel/src/runtime/run-jobs.ts`
- Test: `packages/kernel/test/runtime/run-queue-outbox.test.ts`

**Interfaces:**
- Produces: registry entries `run` (queue `cap-kernel-runs`) and `subagent-run` (`cap-kernel-subagent-runs`), idempotent: "the run worker starts only a run in `queued` state for this job's runId".

- [ ] **Step 1: Write the failing tests** `a message starts its run with the fast path disabled once the relay ticks`, `two messages within milliseconds start one run and leave no queued row without a job` (Review Focus 2), `ensureRun creates no run for a conversation with a live lock holder` (unchanged behaviour).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/run-queue-outbox.test.ts` → FAIL.
- [ ] **Step 3: Implement**; remove the moved site from the Task 6 pending list.
- [ ] **Step 4: Run** the test, `packages/kernel/test/runtime` and the zero-drift fixtures → PASS.
- [ ] **Step 5: Commit** `feat(kernel): a run's job is owed in the transaction that creates it`.

### Task 8: The ensure-run backstop

**Files:**
- Modify: `packages/kernel/src/runtime/maintenance.ts` (case `ENSURE_RUN_JOB` → `RunQueue.ensureRun`), `packages/kernel/src/runtime/run-queue.ts` (`export const ENSURE_RUN_JOB = "ensure-run"`, `ensureRunJobId(conv, seq) = \`ensure-run-${conv}-${seq}\``), the message transactions in `conversations/conversations.service.ts` (sites :461, :548, :1111, :1152), `conversations/queue.service.ts` (:161, :375, :443), `schedules/fire.ts:300`, `background/finish.ts:83`, `runtime/subagents/deliveries.ts:111`, and the run's terminal commit in `runtime/run-worker.ts`
- Test: `packages/kernel/test/runtime/ensure-run-backstop.test.ts`

**Interfaces:**
- Produces: registry entry `ensure-run` (maintenance), idempotent: "ensureRun decides from the conversation's state; with nothing unconsumed it is a no-op"; each site calls `outbox.add({ queue: MAINTENANCE_QUEUE_NAME, name: "ensure-run", jobId: ensureRunJobId(conv, seq), data: { conversationId }, runAt: new Date(Date.now() + 30_000), orgId })` inside its transaction, and still calls `ensureRun` after the commit.

- [ ] **Step 1: Write the failing tests** `a message whose direct ensureRun is skipped (crash seam) starts its run when ensure-run fires`, `ensure-run after the direct call already started the run adds nothing`, `a background task finishing wakes an unwatched chat parent with the direct path skipped`, `with Redis unreachable the send returns 201 and the run starts after Redis returns` (Review Focus 1; stop the Valkey container port, send, restore).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/ensure-run-backstop.test.ts` → FAIL.
- [ ] **Step 3: Implement** at each site.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(kernel): an ensure-run backstop owed with every message and wake`.

### Task 9: Resumes, timeouts and decisions in one transaction

**Files:**
- Modify: `packages/kernel/src/runtime/waits.ts` (`resume` and `scheduleTimeout` through the outbox; a new `resumeIn(runId)` with `propagation: "mandatory"` doing the conditional `waiting → queued` and the outbox add), `tools/approvals.service.ts` (`decideIn` calls `waits.resumeIn` after the decided row; lock order decided row → `runs`), `tools/questions.service.ts` (same), `conversations/conversations.service.ts:1265-1277` (replies)
- Test: `packages/kernel/test/runtime/decision-resume.test.ts`

**Interfaces:**
- Produces: `Waits.resumeIn(runId: string): Promise<"queued" | "still-running" | "other-wait-pending" | "not-waiting">`; registry entries `run-resume` (runs queue, job id `run-<conv>-resume-<waitId>`) and `wait-timeout` (maintenance, `runAt` = the wait's deadline), idempotent: "a resume starts only a `queued` run; a timeout acts only on a still-pending wait".

- [ ] **Step 1: Write the failing tests** `an approval decided with the fast path disabled resumes the run after the relay tick`, `an approval decided while the run is still running leaves it running and suspend does not wait` (Review Focus 3), `a wait timeout fires with the fast path disabled`, `a run with two pending approvals stays waiting after one decision`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/decision-resume.test.ts` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the test plus `packages/kernel/test/tools/approvals*` and `questions*` → PASS.
- [ ] **Step 5: Commit** `feat(kernel): decisions resume their run in the decision's transaction`.

### Task 10: Sub-agent dispatch, delivery and stops

**Files:**
- Modify: `packages/kernel/src/runtime/subagents/dispatch.ts:699,731` (child job via outbox), `runtime/subagents/deliveries.ts` (a child's terminal transaction writes its delivery, or a `deliver-to-parent` job when the parent's lock order forbids writing it there), the run terminal path (closes open `Agent` calls and adds `stop-tree` for fork children in the same transaction), the root delete path (adds `stop-tree`)
- Create: `packages/kernel/src/runtime/subagents/tree-jobs.ts` (`STOP_TREE_JOB = "stop-tree"`, `DELIVER_TO_PARENT_JOB = "deliver-to-parent"`, processors called from `MaintenanceProcessor`)
- Test: `packages/kernel/test/runtime/subagents/outbox-tree.test.ts`

**Interfaces:**
- Produces: registry entries `stop-tree` (idempotent: "stopping a stopped run is a no-op"), `deliver-to-parent` (idempotent: "the delivery's idempotency key is the child run id").

- [ ] **Step 1: Write the failing tests** `a dispatched child starts with the fast path disabled`, `a finished child's result reaches its parent with the fast path disabled`, `a parent finishing stops its fork child with the fast path disabled`, `deleting a root stops the tree with the fast path disabled`, `a parent's terminal transaction leaves no open Agent call`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/subagents/outbox-tree.test.ts` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the test and `packages/kernel/test/runtime/subagents` → PASS.
- [ ] **Step 5: Commit** `feat(kernel): sub-agent dispatch, delivery and stops are owed in their transactions`.

### Task 11: run-orphan-check, and the deletions

**Files:**
- Create: `packages/kernel/src/runtime/run-orphan-check.job.ts` (`@LockedInterval("run-orphan-check", () => 60_000)`, under `WorkerModule`)
- Modify: delete `kickRun` and its calls (`conversations/conversations.service.ts:378,1058,1075,1482`, `runtime/stream.controller.ts:146`), `RunQueue.repairOrphan` (moves into the job), the `Waits.sweep` passes listed in spec §8.2 and `WaitSweepJob` if `sweep()` is left empty (keep `sweepFinishedRuns` only if Step 1's test shows the terminal transaction does not cancel waits; then move that cancel into the terminal transaction instead and delete it too); `packages/testing` dual-replica teardown asserts zero queued orphans
- Test: `packages/kernel/test/runtime/run-orphan-check.test.ts`, `packages/kernel/test/runtime/latency.test.ts`

**Interfaces:**
- Produces: `RunOrphanCheck.check(): Promise<{ runningRepaired: number; queuedReadded: number }>`; `queuedReadded > 0` logs error `queued run without a job: the queue lost jobs` and adds overview attention `{ kind: "queue_lost_jobs" }`.

- [ ] **Step 1: Write the failing tests** `a worker killed inside onFailed leaves a running run that the check fails with run.orphaned and reports to its parent`, `a queued run whose job was removed from Redis is re-added and reported`, `GET events and opening SSE never change run state`, `a finished run has no pending waits` (decides the `sweepFinishedRuns` question), `message-to-run-job-added p50 grows by at most 5 ms` (100 sends before/after on the test stack; the before value is recorded from `main` in the test's comment).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/run-orphan-check.test.ts packages/kernel/test/runtime/latency.test.ts` → FAIL.
- [ ] **Step 3: Implement** the job; delete the code listed above; remove moved sites from the pending list.
- [ ] **Step 4: Run** `pnpm exec vitest run packages/kernel/test/runtime packages/kernel/test/conversations packages/kernel/test/evals/reconstruct.test.ts` → PASS.
- [ ] **Step 5: Commit** `refactor(kernel): one run-orphan-check; reads and sweeps no longer repair runs`; changeset; `pnpm verify`; PR 2.

## Part 3 (PR 3): usage and IM delivery

### Task 12: Usage reports

**Files:**
- Modify: `packages/kernel/src/runtime/usage-report.ts` (enqueue becomes `outbox.add` in the usage event's transaction; delete the per-replica handler skip, `UsageReportSweep`, the watermark), the sites `runtime/model-call.ts:368,519,1065`, `conversations/titles.ts:338,362`, `tools/builtins/web/extract.ts:313`, `models/embeddings.ts:313`
- Create: `packages/kernel/src/extensions/usage-subscribers.ts` (`UsageSubscribers.any(): Promise<boolean>`, PG read of enabled extensions whose permission manifest declares `usage.report`, cached 30 s, cleared on `PLUGINS_CHANGED`), migration `0120_drop_usage_report_sweep.sql` (drops the watermark table; exemption comment)
- Test: `packages/kernel/test/runtime/usage-report-outbox.test.ts`

- [ ] **Step 1: Write the failing tests** `a usage event is reported with the fast path disabled`, `no outbox row is written while no plugin subscribes`, `enabling a subscriber makes the next event owed within 30 s`, `an embedding's model_usage row is reported with the fast path disabled`, `a replica without the handler still owes the row and another replica delivers it`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/usage-report-outbox.test.ts` → FAIL.
- [ ] **Step 3: Implement**; delete the sweep and its tests.
- [ ] **Step 4: Run** the test and `packages/kernel/test/runtime/usage-report*.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(kernel): usage reports are owed with the usage they report`.

### Task 13: IM delivery

**Files:**
- Modify: `packages/kernel/src/channels/jobs.ts` (export `deliverJobId`, registry entry `deliver`), the append path in `conversations/event-log.ts` (when the conversation has a channel target, add the deliver job in the append's transaction), approvals / questions decision transactions and `RunControl.abortWaiting` (same, for channel conversations); `run.started` stays a hint
- Test: `packages/kernel/test/channels/outbox-delivery.test.ts`

**Interfaces:**
- Consumes: the channel target lookup the outbound already uses (`channel_deliveries` / the conversation's channel binding), read inside the transaction.

- [ ] **Step 1: Write the failing tests** `a reply in an IM conversation is delivered with the fast path disabled`, `an approval card updates in IM with the fast path disabled`, `a web-only conversation writes no outbox row on append`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/channels/outbox-delivery.test.ts` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the test and `packages/kernel/test/channels` → PASS.
- [ ] **Step 5: Commit** `feat(kernel): IM delivery is owed for channel conversations`; changeset; `pnpm verify`; PR 3.

## Part 4 (PR 4): catalog

### Task 14: Scope sync and owned-plugin cleanup

**Files:**
- Modify: `packages/kernel/src/catalog/scope-sync.ts` (`enqueueItem` / `enqueueOrg` become `outbox.add` with `propagation: "mandatory"`; delete `enqueueAll` at start), every caller of spec §8.1 (catalog-scope.service.ts :254, :341, :384, :989, :1032, :1078, :1098, :1107; plugin-upgrade.ts:967; owned-items.ts:517, :646; org-plugin-uploads.ts:120; orgs.service.ts:144; catalog-scope.service.ts:638), `catalog/owned-plugin-cleanup.ts` (delete the daily sweep), `.agents/skills/writing-migrations/SKILL.md` (a migration that changes owed state inserts outbox rows)
- Test: `packages/kernel/test/catalog/scope-sync-outbox.test.ts`

- [ ] **Step 1: Write the failing tests** `changing an item's scope converges every org with the fast path disabled`, `a new org gets the all-scope items with the fast path disabled`, `transferring an owned item with the fast path disabled cleans the old install up`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/catalog/scope-sync-outbox.test.ts` → FAIL.
- [ ] **Step 3: Implement**; remove the sites from the pending list.
- [ ] **Step 4: Run** the test and `packages/kernel/test/catalog` → PASS.
- [ ] **Step 5: Commit** `feat(kernel): scope syncs and cleanups are owed in their transactions`.

### Task 15: Platform components inside the import

**Files:**
- Modify: `packages/kernel/src/catalog/plugin-import.ts` (object-storage copies before the transaction, keyed by content digest; `platform.syncFromVersion` inside the import transaction; delete `syncPlatform`'s catch-and-retry and `PLATFORM_SYNC_RETRY_MS`)
- Delete: `packages/kernel/src/catalog/platform-migration.ts` and its job registration, `platform-migration-retry-*`
- Test: `packages/kernel/test/catalog/import-platform-atomic.test.ts`

- [ ] **Step 1: Write the failing tests** `a failure writing platform components rolls the import back`, `retrying the import after that failure succeeds and writes no duplicate objects`, `an imported item has its platform rows when the import returns`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/catalog/import-platform-atomic.test.ts` → FAIL.
- [ ] **Step 3: Implement**; delete the migration job and its tests.
- [ ] **Step 4: Run** `packages/kernel/test/catalog` → PASS.
- [ ] **Step 5: Commit** `refactor(kernel): platform components are written in the import's transaction`; changeset; `pnpm verify`; PR 4.

## Part 5 (PR 5): scheduled tasks, offboarding, devices

### Task 16: Scheduled fires

**Files:**
- Modify: `packages/kernel/src/schedules/scheduled-tasks.service.ts:1080`, `schedules/scan.job.ts:135` (fire job through the outbox in the tick's transaction; delete the repair half :202-280 and `rechecked_at` use), migration dropping `scheduled_task_runs.rechecked_at` if nothing else reads it (exemption comment)
- Test: `packages/kernel/test/schedules/fire-outbox.test.ts`

- [ ] **Step 1: Write the failing tests** `a scanned tick fires with the fast path disabled`, `run-now fires with the fast path disabled`, `a tick is fired once when the scan runs twice`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/schedules/fire-outbox.test.ts` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `packages/kernel/test/schedules` → PASS.
- [ ] **Step 5: Commit** `feat(kernel): scheduled fires are owed by the tick that schedules them`.

### Task 17: Offboarding and device destroys

**Files:**
- Modify: `packages/kernel/src/orgs/offboarding.ts` (run stops and device destroys as outbox jobs in the offboard transaction; delete `OffboardSweepJob`), `orgs/members.service.ts:204,233`, `orgs/directory-sync.ts:751`, `devices/devices.service.ts:457` (destroy job with id `device-destroy-<deviceId>`), `sandbox/jobs.ts:52` (deterministic id)
- Test: `packages/kernel/test/orgs/offboarding-outbox.test.ts`

**Interfaces:**
- Produces: registry entries `run-stop` (maintenance; idempotent: "stopping a finished run is a no-op"), `sandbox-destroy-for` (existing name; idempotent: "destroying a destroyed device is a no-op").

- [ ] **Step 1: Write the failing tests** `an offboarded member's running run stops with the fast path disabled`, `their devices are destroyed with the fast path disabled`, `deleting a device destroys its instance with the fast path disabled`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/orgs/offboarding-outbox.test.ts` → FAIL.
- [ ] **Step 3: Implement**; delete the sweep.
- [ ] **Step 4: Run** `packages/kernel/test/orgs packages/kernel/test/devices` → PASS.
- [ ] **Step 5: Commit** `feat(kernel): offboarding stops and device destroys are owed`; changeset; `pnpm verify`; PR 5.

## Part 6 (PR 6): device policy intents

### Task 18: Device protocol: op ids

**Files:**
- Modify: `packages/plugin-sdk/src/device-protocol.ts` (`policy` frame gains `opId: string`; new `policy-status` request `{ opId } → { outcome: "applied" | "refused" | "unknown-op", policy? }`; `hello` gains `recentOps: { opId, outcome }[]` (at most 100); feature flag `policyOpId`), `packages/device/src/server-ops.ts`, `packages/device/src/client.ts` (apply an op id at most once; keep the last 100 outcomes in `policy.json`'s sibling `ops.json`), `pnpm gen:sdk-api`, changesets for `@capybara-hq/plugin-sdk` and `@capybara-hq/device`
- Test: `packages/device/test/policy-op-id.test.ts`

- [ ] **Step 1: Write the failing tests** `a repeated opId is applied once and answered with the stored outcome`, `policy-status answers unknown-op for an id never seen`, `hello carries the last 100 outcomes, oldest dropped`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/policy-op-id.test.ts` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the test, `pnpm check:sdk-api`, `pnpm check:deps` → PASS.
- [ ] **Step 5: Commit** `feat(device): policy ops carry an op id applied at most once`.

### Task 19: Intent, call, resolve

**Files:**
- Create: migration `0119_device_policy_ops.sql` (`device_policy_ops`: `op_id text PRIMARY KEY`, `org_id`, `device_id`, `change jsonb`, `source text`, `actor_account_id`, `approval_id text NULL`, `status text CHECK (status IN ('pending','applied','refused','failed','offline','unknown'))`, `created_at`, `resolved_at`), `packages/kernel/src/local-devices/device-policy-intents.ts` (`DevicePolicyIntents.begin`, `.resolve`, `.resolveStale` for the `device-op-resolve` job, `.backfillFromHello`)
- Modify: `local-devices/device-policy.service.ts` (`apply` = `begin` tx → call with opId → `resolve` tx), `tools/approvals.service.ts` (`decideNetwork` uses the intent; the ask goes `deciding`; delete `auditLateAllow`), `local-devices/machines.ts` (hello → `backfillFromHello`; devices without `policyOpId` get the existing "update capybara-device" refusal), audit actions `device.policy_requested`, `device.policy_applied`, `device.policy_failed`, `device.policy_unknown`
- Test: `packages/kernel/test/local-devices/policy-intents.test.ts`

**Interfaces:**
- Consumes: Task 18 frames.
- Produces: registry entry `device-op-resolve` (maintenance, `runAt` = now + policy deadline + 30 s; idempotent: "resolving a resolved intent is a no-op").

- [ ] **Step 1: Write the failing tests** `an always-allow decision records the request before the device is called`, `a crash after the call is resolved by the job: applied → ask approved and audited`, `a device that disconnected before resolve leaves the ask pending with a reason and an unknown audit` (Review Focus 5), `the resolver never re-sends the change`, `hello reporting an unknown op as applied approves the still-pending ask`, `hello reporting it applied after the ask was withdrawn sends the inverse change as a new intent`, `a device without policyOpId is refused with the update message`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/local-devices/policy-intents.test.ts` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the test, `packages/kernel/test/local-devices`, `packages/kernel/test/tools/network*` → PASS.
- [ ] **Step 5: Commit** `feat(kernel): device policy changes record their intent before the call`; changesets; `pnpm verify`; PR 6.

## Part 7 (PR 7): close out

### Task 20: Empty the allowlist and update the rules

**Files:**
- Modify: `tools/checks/src/kernel-conventions.ts` (the pending list for `kc-enqueue-via-outbox` is empty; any left entry is moved or given a permanent exception with a reason), `AGENTS.md` (the "Multi-replica discipline" bullet text of spec §10, verbatim), `.agents/skills/writing-kernel-api/SKILL.md` (outbox section: owed vs hint test, `OutboxService.add`, registry, idempotency sentence, intent-first external calls), `tools/checks/README.md`, `docs/reviews` nothing (the next review records the fix)
- Test: `tools/checks/test/kernel-conventions.test.ts` (no pending entries remain for the two rules)

- [ ] **Step 1: Write the failing test** `kc-enqueue-via-outbox has no pending entries`.
- [ ] **Step 2: Run** `pnpm exec vitest run tools/checks/test/kernel-conventions.test.ts` → FAIL if anything is left.
- [ ] **Step 3: Move or except** the remaining sites; edit AGENTS.md and the skill.
- [ ] **Step 4: Run** `pnpm check` and `pnpm verify` → PASS.
- [ ] **Step 5: Commit** `docs: the outbox rule in AGENTS.md and the kernel API skill`; PR 7.
