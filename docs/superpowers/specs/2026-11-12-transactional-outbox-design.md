# Transactional outbox: work that must follow a commit

- Date: 2026-11-12, written against `origin/main` at `7cb12115f`.
- Status: draft for maintainer review.
- Source: design review `docs/reviews/2026-11-12-2-design-review.md`, findings
  `post-commit-followups-no-outbox` (high, second time) and `device-op-before-record` (high, new);
  it also removes the cause of `catalog-import-heal-job` and part of
  `client-heuristics-for-server-order`.
- Related: AGENTS.md "Multi-replica discipline"; `.agents/skills/writing-kernel-api` (transactions,
  `afterCommit`, `@LockedInterval`, `WorkerModule`); subagents (`2026-10-26-subagents-design.md`
  §7.5), agent map (`2026-11-06-agent-map-design.md` §5), scheduled tasks, network asks
  (`2026-11-12-network-ask-to-allow-design.md`), plugin component management (§6 platform
  components).
- Markers: **(designer's call)** is decided here and may be overturned in review. Items without a
  marker restate current code.

## 1. Why

AGENTS.md says enqueues, bus publishes and Redis calls happen in `afterCommit`, never inside the
transaction. That keeps Redis out of Postgres locks, but it leaves a window: the process can die (or
Redis can refuse) after the commit and before the side effect. Nothing durable records that the side
effect was owed, so every feature that needs one has grown its own recovery:

| Recovery today | What it recovers | Where |
|---|---|---|
| Orphan grace (30 s), read-back of the job, `deleteQueued`, `kickRun` on SSE open / event reads | a run row committed whose job was never added | `runtime/run-queue.ts:55,165-233`; `conversations/conversations.service.ts:378,1058,1075,1482`; `runtime/stream.controller.ts:146` |
| `Waits.sweep`, nine passes every 10 min, one-day lookbacks | lost resumes, timeouts, child enqueues, deliveries to parents, parked messages, fork stops, tree stops, open `Agent` calls | `runtime/waits.ts:201-223` |
| Usage report sweep with a watermark, every minute | lost `usage-*` jobs | `runtime/usage-report.ts:774` |
| Scheduled task scan repair (re-enqueue after 10 min, give up after 60) | lost `sched-fire-*` jobs | `schedules/scan.job.ts:28-31,202-280` |
| Offboard sweep, every 10 min | lost run stops and device destroys after offboarding | `orgs/offboarding.ts:534` |
| Owned plugin cleanup, daily | lost cleanup jobs | `catalog/owned-plugin-cleanup.ts:101` |
| Scope sync `enqueueAll`, worker start only | ~14 lost scope-sync enqueues; **no periodic repair at all** | `catalog/scope-sync.ts:46,172,592` |
| Platform migration, every start and daily | platform component rows written after the import committed | `catalog/plugin-import.ts:1665-1715`, `catalog/platform-migration.ts` |

The recoveries have gaps that the review found: a lost chat run enqueue becomes a **failed** run
(`run.orphaned`) instead of a requeued one; a lost scope sync waits for the next worker restart; a
lost wake for a chat parent nobody is viewing is never repaired; GET requests mutate run state; and
each new feature (scheduled tasks was the latest) adds another sweep. The network ask feature also
inverted the order for an external effect: the device is widened first and the decision is recorded
afterwards (`tools/approvals.service.ts:614-735`, `local-devices/device-policy.service.ts:92-106`),
so a crash leaves a widened device with no kernel audit.

One mechanism replaces all of this: **what must follow a commit is written in the same transaction,
and one relay delivers it.**

## 2. Goals, non-goals, anti-goals

Goals:

1. A job that must follow a commit is never lost: it is a row in the same transaction, and it is
   delivered at least once after the commit, whatever replica dies when.
2. One relay is the only recovery path for lost post-commit work. The per-feature recovery sweeps
   listed in §8 are deleted, and so are `kickRun` on read paths and the orphan grace.
3. An external effect whose record matters (a device policy change) is recorded as an intent before
   it is attempted and resolved afterwards, never the other way round.
4. No added latency on the interactive path: sending a message starts its run as fast as today.
5. The rule is checked, not remembered (§10).

Non-goals:

- Recovering from Redis losing data (no AOF, a flushed instance). The kernel assumes BullMQ's
  Redis is durable; `run-orphan-check` (§8.3) reports when that assumption broke for runs and
  re-adds their jobs, but nothing tries to be a general second delivery path.
- Exactly-once execution. Delivery is at least once; every job delivered through the outbox is
  idempotent (most already are, by deterministic job id and state checks).
- Extensions' own queues (`ctx.queue`): extensions have no access to the kernel transaction. A
  `ctx.outbox` can follow if a plugin needs it.
- Replacing BullMQ, the kernel bus, or the in-process `KernelEvents`.
- Hints (SSE wakeups, cache evictions, channel connection nudges): their loss is harmless or bounded
  by a TTL; they stay in `afterCommit`.

Anti-goals (a failure even if it works):

- The relay becoming a generic event-sourcing framework, or a second scheduler.
- A per-feature "outbox kind" with its own table and sweep: one table, one relay.
- A Postgres round trip added to every event append for conversations that need nothing from it.

## 3. The model

### 3.1 Two kinds of post-commit work

| Kind | Examples | Where it goes |
|---|---|---|
| **Owed work**: losing it leaves state wrong | run jobs, resumes, wait timeouts, child runs, deliveries to parents, wakes, usage reports, scope syncs, cleanups, scheduled fires, run stops and device destroys of offboarding, IM delivery for conversations with a channel target | the outbox |
| **Hints**: losing them is harmless or bounded | bus publishes for SSE, `publishChanged`, cache evictions, `PLUGINS_CHANGED` (the 60 s reconcile stays), session-revocation markers, in-process nudges | `afterCommit`, as today |

The test for a new side effect: *if the process dies right after the commit, is anything wrong
until someone notices?* Yes → outbox. No → hint.

### 3.2 Owed work is a row

`OutboxService.add(job)` inserts a row into `capybara.outbox` with the queue, job name, data,
deterministic job id and an optional `runAt`. It requires a transaction
(`@Transactional({ propagation: "mandatory" })`); calling it outside one is a programming error.
The row commits or rolls back with the business write.

### 3.3 Delivery: fast path plus relay

- **Fast path.** `add` also registers an `afterCommit` hint that asks the local `OutboxDispatcher`
  to deliver the rows this transaction wrote, right after the commit, on whatever replica role wrote
  them (it is a producer, not a consumer, so the api role may do it). It claims the rows with
  `SELECT … FOR UPDATE SKIP LOCKED`, adds the jobs to BullMQ, and deletes the rows in the same short
  transaction. This keeps today's latency. The hint starts the dispatch detached and returns at once
  (the commit's caller never waits on Redis). It never queues behind an outage: it skips the pass,
  leaving the rows to the relay, when a kernel queue's Redis connection is not ready (checked without
  waiting), or when 4 fast-path passes already run in the process (a local resource bound, no shared
  state). So a Redis outage cannot take the PG pool.
- **Relay.** A `@LockedInterval` job under `WorkerModule` (every 2 s, **designer's call**) claims due
  rows (`next_attempt_at <= now()`, not dead; never by `run_at`, see delayed jobs) in batches of 500
  with `SKIP LOCKED` and does the same. It is the only backstop: whatever the fast path did not deliver (a crash, Redis down) it
  delivers on its next tick.
- **Redis calls inside the claim transaction.** The dispatcher adds the BullMQ jobs while holding row
  locks on outbox rows only (never on business rows), then deletes the rows and commits. This is the
  one sanctioned exception to "no Redis inside a transaction", and it lives in one file. A crash
  after the add and before the commit leaves the rows; the next attempt adds again, which BullMQ
  ignores while the job id exists, and which the job's own idempotency covers after it was removed.
  The adds of one pass share one 2000 ms deadline, so a claim transaction holds its locks and its
  pool connection for about 2 s at most; after the first queue fails or times out, the pass fails
  the queues left without trying them.
- **Delayed jobs.** `runAt` in the future becomes a BullMQ `delay` computed at dispatch
  (`max(0, runAt - now)`). Rows are dispatched as soon as they are written, not at `runAt`, so BullMQ
  stays the timer (**designer's call**: the relay never becomes a scheduler).

### 3.4 Failures and dead letters

A failed add increments `attempts`, records `last_error` and sets `next_attempt_at` with exponential
backoff (1 s doubling, capped at 5 min). After 20 attempts (**designer's call**) the row stays with
`dead_at` set and is reported in the super admin's overview as a system attention item
(`admin/overview.service.ts`), with the queue, job name, error and age; a Platform operation retries
or discards it. Nothing is dropped silently.

### 3.5 Idempotency contract

Every job name added through the outbox declares in its processor how a duplicate is harmless (a
state check, an idempotency key, a deterministic id). The registry of outbox job names (§5) carries
that sentence; a job name without it fails the check.

## 4. Schema

Migration `0119_outbox.sql` (number at implementation time), schema `capybara`:

```sql
CREATE TABLE IF NOT EXISTS outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue text NOT NULL,
  job_name text NOT NULL,
  job_id text NOT NULL,
  data jsonb NOT NULL,
  run_at timestamptz,
  org_id text,                       -- for the overview and for org deletion; NULL for platform work
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  dead_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- one pending row per job: a second add of the same job before delivery is a no-op; a dead row
-- does not count, so it never blocks the same job owed again
CREATE UNIQUE INDEX IF NOT EXISTS outbox_job_uniq ON outbox (queue, job_id) WHERE dead_at IS NULL;
CREATE INDEX IF NOT EXISTS outbox_due ON outbox (next_attempt_at) WHERE dead_at IS NULL;
```

`add` uses `ON CONFLICT (queue, job_id) WHERE dead_at IS NULL DO NOTHING RETURNING id` and returns
whether it inserted. The unique index is partial (ruling R8): a dead row is not owed work, so it
never blocks a new owed job with the same id, and the conflict lookup ignores dead rows too.
A conflict means the same job is already owed; the job ids are built so that a conflict always
carries the same data (a run job id names the conversation and its trigger seq, and one active run
per conversation is a unique index, so two different runs cannot share it). As a guard, a conflict
whose stored `data` differs throws in tests and logs an error in production (**designer's call**).
Rows are deleted on delivery, so the table stays small; `dead_at` rows are the only ones that stay.

A SQL migration that changes state which owes work (a scope it rewrites, for example) inserts the
outbox rows itself in the same migration (**designer's call**; the writing-migrations skill says so).
This replaces the "covers a migrated scope" role of `enqueueAll`.

## 5. API

```ts
// infra/outbox/outbox.service.ts
interface OutboxJob<T> {
  queue: KernelQueueName;          // one of the 8 kernel queues
  name: OutboxJobName;             // from the registry below
  jobId: string;                   // deterministic, no ':'
  data: T;
  runAt?: Date;
  orgId?: string;
}
class OutboxService {
  @Transactional({ propagation: "mandatory" })
  add<T>(job: OutboxJob<T>): Promise<void>;
}
```

`infra/outbox/registry.ts` lists every `OutboxJobName` with its queue and its idempotency sentence
(§3.5). Feature code keeps its job-id helpers (`runJobId`, `waitTimeoutJobId`, …); only the add moves.

New job names this design introduces, all on `cap-kernel-maintenance` (**designer's call**):
`ensure-run` (calls `RunQueue.ensureRun`), `stop-tree` (stops a run's fork children or a deleted
root's tree), `deliver-to-parent` (a finished child's delivery when it is not written in the child's
terminal transaction), `device-op-resolve` (§7), `run-orphan-check` (§8.3).

## 6. Run lifecycle

The run path is the largest user of recovery today, so it is spelled out.

- **Starting a run.** The decision `ensureRunIn` makes (new run row) and the outbox row for its job
  commit together. The read-back of the job, `deleteQueued` on a failed add and the "queued without
  a job" orphan test are deleted: a queued run always has its job owed.
- **Sending a message.** The message transaction also writes an `ensure-run` outbox job
  (`ensure-run-<conv>-<seq>`) with `runAt = now + 30 s` (**designer's call**: a backstop, not a
  second immediate call), and the request still calls `ensureRun` right after the commit as today.
  When the job fires it is a cheap no-op if a run for that trigger exists or the message was
  consumed; it starts the run when the process died in between. The worker therefore does not
  repeat every request's `ensureRun` at once. Same for the other "commit, then `ensureRun`" paths:
  queue service sends, scheduled fire (`schedules/fire.ts:300`), background task finish
  (`background/finish.ts:83`), sub-agent deliveries (`runtime/subagents/deliveries.ts:111`) and a
  run's terminal commit (the post-job `ensureRun` that starts parked messages).
- **Resumes and timeouts.** `Waits.resume` writes `waiting → queued` and its resume job in one
  transaction; `scheduleTimeout` writes the wait and its `wait-timeout-*` job (with `runAt`) together.
- **Decisions resume in their own transaction (designer's call).** A decision (`approvals`,
  `questions`, conversation replies) does the state transition itself: in the decision transaction
  it locks the run row after the decided row (lock order: decided row, then `runs`), and when the run
  is `waiting` with no other pending wait it sets `queued` and adds the run's resume job to the
  outbox. When the run is still `running` (the decision raced `suspend`), nothing more is written:
  `suspend`'s existing re-check (`runtime/waits.ts:225-232`) sees the decided wait and does not
  suspend. So the transition is never outside a transaction and no extra job hop exists. The
  in-process `approval.decided` / `question.answered` events stay as hints for IM cards; the IM card
  update itself is owed (§8.1, IM delivery).
- **Sub-agents.** `commitDispatch` writes the child run and its job together. A child's terminal
  transaction writes its delivery to the parent (or a `deliver-to-parent` job) and the parent's
  `ensure-run` job. A run's terminal transaction closes its open `Agent` calls and writes
  `stop-tree` jobs for fork children; deleting a root writes the `stop-tree` job in the delete
  transaction.
- **Reads never write.** `kickRun` is removed from SSE open and event reads.
- **Replica death during a run** is not post-commit work, and it keeps a repair. BullMQ's stalled
  detection re-delivers a run job up to `MAX_STALLED_COUNT = 3` (`runtime/run-worker.ts:58`); run jobs
  are `attempts: 1, removeOnFail: true` (`runtime/run-jobs.ts:37`) and the failure is written by the
  in-process `onFailed` (`run-worker.ts:220-228`). When stalls run out, or the process dies inside
  `onFailed`, the run stays `running` with no job. Today the orphan test in `ensureRun`
  (`run-queue.ts:786-796`), `kickRun` on reads and the sub-agent `repairOrphan` /
  `sweepSubagentOrphans` catch it. This design keeps that repair but gives it one home: the
  `run-orphan-check` (§8.3), a locked periodic job that fails such a run with `run.orphaned`, delivers
  a child's failure to its parent and starts the conversation's next run. Read paths no longer do it.
  The "queued without a job" half of the orphan test is deleted: the outbox makes it impossible.

## 7. External effects: intent first

For an external call whose effect must match a record (today: device policy ops; later anything of
the same shape), the order becomes:

1. **Intent transaction.** Write the intent (`device_policy_ops` row: op id, device, change, source,
   actor, `status = pending`), an audit row `device.policy_requested`, the dependent state (a network
   ask goes to `deciding`), and an outbox job `device-op-resolve-<opId>` with `runAt = now + deadline
   + grace`.
2. **Call.** Send the op with its op id. The device applies an op id at most once and answers a
   repeat with the stored result (device protocol change: `policy` frames carry `opId`; the device
   keeps the last 100 op ids, **designer's call**).
3. **Resolve transaction.** Record the outcome (`applied` / `refused` / `offline`), the audit row
   `device.policy_applied` or `…_failed`, the new summary, and the dependent state (the ask
   `approved`, or back to `pending` with the reason).
4. **Resolver job.** When step 3 did not happen (crash), the resolver never re-sends the change (a
   late widening after the ask may have been withdrawn is not allowed, **designer's call**). It asks
   a connected device for the op id's outcome with a read-only `policy-status` frame: applied →
   finalize as step 3; not applied → `failed`, the ask back to `pending` with the reason, audit
   `device.policy_failed`. A device that is not connected → `unknown`, the ask back to `pending`,
   audit `device.policy_unknown`.
5. **Backfill on hello.** The device's hello carries the outcomes of its last op ids. An intent left
   `unknown` that the device reports applied is finalized then: status `applied`, audit
   `device.policy_applied` (with "confirmed late"), and the ask, if it is still `pending`, is
   approved; if it was withdrawn or expired meanwhile, the kernel sends the inverse change as a new
   intent (**designer's call**).
6. **Old devices.** Pre-0.1.0, no compatibility: policy ops require a new device feature flag
   `policyOpId`; a device without it gets the existing "update capybara-device" refusal for policy
   changes (the same path as devices without `policyOp` today).

This replaces `auditLateAllow` and the "op first, record after" order in `decideNetwork` and
`DevicePolicyService.apply`.

## 8. What moves, what is deleted, what stays

### 8.1 Moves to the outbox

| Site today | Outbox job |
|---|---|
| `runtime/run-queue.ts:216` | run job of the created run |
| `runtime/waits.ts:388` (`resume`), `:1225` (`scheduleTimeout`) | resume job; timeout job with `runAt` |
| `runtime/subagents/dispatch.ts:699,731` | child run job |
| `runtime/subagents/deliveries.ts:111`, `background/finish.ts:83`, terminal commits | `ensure-run` of the woken conversation |
| `tools/approvals.service.ts:597`, `tools/questions.service.ts`, `conversations/conversations.service.ts:1265-1277` | resume job written with the decision |
| `conversations/conversations.service.ts:461,548,1111,1152`, `conversations/queue.service.ts:161,375,443`, `schedules/fire.ts:300` | `ensure-run` job with the message |
| `runtime/model-call.ts:368,519,1065`, `conversations/titles.ts:338,362`, `tools/builtins/web/extract.ts:313`, `models/embeddings.ts:313` | `usage-*` job written with the usage event / `model_usage` row, **only while the deployment has at least one enabled `usage.report` subscriber** (**designer's call**). "Has a subscriber" is read from PG (installed, deployment-enabled extensions whose permission manifest declares the hook), cached per replica for 30 s and invalidated on `PLUGINS_CHANGED`. This replaces today's per-replica "do I have a handler" skip (`runtime/usage-report.ts:133-139`), which depended on the sweep. Events written while no plugin subscribed are not reported later: a subscription starts when the plugin is enabled. |
| IM delivery: `ChannelJobs` reacts to five in-process events (`channels/jobs.ts:90-97`) and adds `deliver-<conv>-<last_seq>` | For a conversation with a channel target, these transactions add the conversation's deliver job to the outbox (**designer's call**): an event append, an approval decision, a question answer and a wait stop. No "IM-visible" classifier is needed: the deliver job already re-reads the log and decides what to send, as today. `run.started` stays a hint (the run's first append covers it). Conversations without a channel target write nothing. |
| `catalog/catalog-scope.service.ts:254,341,384,989,1032,1078,1098,1107`, `catalog/plugin-upgrade.ts:967`, `catalog/owned-items.ts:646`, `catalog/org-plugin-uploads.ts:120`, `orgs/orgs.service.ts:144` | scope-sync jobs |
| `catalog/owned-items.ts:517`, `catalog/catalog-scope.service.ts:638` | owned-plugin cleanup |
| `schedules/scheduled-tasks.service.ts:1080`, `schedules/scan.job.ts:135` | `sched-fire-*` |
| `orgs/offboarding.ts:394,433` (via `members.service.ts:204,233`, `directory-sync.ts:751`) | stop-run and device-destroy jobs |
| `devices/devices.service.ts:457` | device destroy (gains a deterministic id) |
| `local-devices/machines.ts:325,343` | `stop` frame stays a hint; the revocation itself is enforced by `revoked_at` on every reconnect and frame (verify, §11) |

`catalog/plugin-import.ts` additionally writes the platform component rows inside the import
transaction (object-storage copies happen before the commit, keyed by content so a retry is
idempotent); this is the fix the review proposed for `catalog-import-heal-job`, done here because
it removes the last user of the platform-migration retry.

### 8.2 Deleted

- `RunQueue`: orphan grace, read-back of the added job, `deleteQueued`, the queued-without-job
  branch of the orphan test; the running-without-job branch and `repairOrphan` move into
  `run-orphan-check` (§8.3); `kickRun` and its read-path calls.
- `Waits.sweep` passes: `sweepOverdue`, `sweepSubagentOrphans` (its running half moves into
  `run-orphan-check`), `sweepOpenAgentCalls`,
  `sweepForkChildrenOfFinished`, `sweepTreesOfDeletedRoots`, `sweepUndelivered`,
  `sweepParkedMessages`, `sweepStuckRuns`. `sweepFinishedRuns` goes too once the terminal
  transaction cancels the run's waits (verify at implementation; keep only if a real expiry remains).
- `UsageReportSweep` and its watermark table (`usage_report_sweep`), after the outbox covers every
  usage source.
- The repair half of `ScheduledTaskScan` (the scan stays).
- `OffboardSweepJob`; the daily `OwnedPluginCleanup.sweep`; `PluginScopeSync.enqueueAll` at start;
  `PlatformMigration` and the `platform-migration-retry-*` path.
- `auditLateAllow` and the op-first order in `decideNetwork` / `DevicePolicyService.apply`.

### 8.3 Stays

- Real periodic work: the scheduled-task scan, sandbox suspend / destroy of idle instances, storage
  purge, background poll and prune, drift scan, marketplace refresh, directory scan, expiry cleanups,
  gateway check, plugins reconcile (bus loss and real drift).
- **`run-orphan-check` (designer's call).** One `@LockedInterval` every minute over runs with
  neither a BullMQ job nor a conversation lock holder for over 60 s:
  - `running` → failed `run.orphaned`, a child's failure delivered to its parent, the conversation's
    next run started (the repair §6 keeps, for a replica that died while running);
  - `queued` → a canary: with the outbox this must never happen; it logs an error and shows in the
    overview as "the queue lost jobs" (Redis durability broke), and re-adds the job so the run is not
    stuck. Both counts are reported.

## 9. Multi-replica and ordering

- No in-process state: rows are in PG, the dispatcher holds nothing between calls.
- The fast path and the relay may race for the same rows; `SKIP LOCKED` gives each row to one of
  them, and a duplicate add is absorbed by the job id.
- No ordering is promised between jobs (BullMQ promises none today either); features that need an
  order keep encoding it in state checks, as now.
- An org's deletion deletes its pending outbox rows in the same transaction (`org_id`), except rows
  of the deletion's own cleanup work, which carry no `org_id` (**designer's call**).

## 10. Enforcement

- `check:kernel-conventions` gains `kc-enqueue-via-outbox`: in `packages/kernel/src` (non-test), a
  BullMQ `add` / `addBulk` / `jobs.enqueue` is allowed only in `infra/outbox/*` and in an explicit
  allowlist with a reason per entry (a job enqueueing its own retry from inside its processor with no
  DB write; the CLI's `addJobOnce`). Red fixture first.
- `kc-after-commit-hint`: an `afterCommit` callback may not call an enqueue (the same matcher), so
  owed work cannot slip back into a hint.
- The outbox registry check: every `OutboxJobName` has a processor and an idempotency sentence.
- AGENTS.md "Multi-replica discipline", the line on writes becomes: "Writes run in
  `@Transactional()` methods. Work that must follow the commit is an outbox row written in the same
  transaction (`OutboxService.add`); `afterCommit` is only for hints whose loss is harmless (bus
  publishes for SSE, cache evictions). An external call whose effect must match a record writes its
  intent first." The writing-kernel-api skill gets the details.

## 11. Testing

- Unit: `OutboxService.add` outside a transaction throws; rollback drops the row; conflict is a
  no-op; backoff and dead-lettering.
- Crash injection (a named test seam in `overrides.ts`, `outboxDispatchFails`): for each moved site
  in §8.1, the business write commits, the fast path fails, and the job still runs after the relay
  tick, on the other replica of `createDualReplicaHarness`.
- Run lifecycle: message → run with the fast path disabled; resume after a decision with the fast
  path disabled; a child's delivery and the parent's wake with the fast path disabled; GET event
  reads never change run state.
- Device intents: crash after the call and before the resolve transaction → the resolver finalizes,
  the audit exists, the ask is not left `deciding`; a repeated op id is applied once (device test).
- Zero-drift fixtures (`reconstruct.test.ts`) run before and after: nothing model-visible changes.
- `run-orphan-check` finds zero `queued` orphans across the whole kernel test suite (an assertion in
  the dual-replica harness teardown); a test kills a worker inside `onFailed` and sees the running
  orphan repaired.
- Latency: the message path gains exactly the outbox inserts in the message transaction and one
  claim transaction (select, delete, commit) after it. PR 2 measures message-to-run-job-added on the
  test stack before and after and reports it; the budget is +5 ms at p50 (**designer's call**).

## 12. Rollout (one PR each, in order)

1. Outbox table, service, dispatcher, relay, dead letters in the overview, registry, the checks
   (with the allowlist holding every current direct enqueue, each marked "moves in PR n").
2. Run lifecycle (§6) and `run-orphan-check`, deleting the run-queue orphan code, `kickRun` and the
   `Waits.sweep` passes.
3. Usage reports and IM delivery; delete the usage sweep.
4. Catalog: scope sync, cleanups, platform rows inside the import; delete `enqueueAll`, the cleanup
   sweep and the platform migration.
5. Scheduled tasks, offboarding, device destroys; delete the scan repair and the offboard sweep.
6. Device intents (§7) with the device protocol change (plugin-sdk frames, `capybara-device`).
7. Empty the allowlist; AGENTS.md and skill text.

Each PR removes its rows from the check's allowlist; the allowlist is empty at the end.

## 13. Risks

- **Hot path cost.** One insert per owed job inside existing transactions; the IM delivery row is
  written only for channel conversations. Measured in §11.
- **Dispatcher holding a PG transaction across a Redis call.** Bounded: only outbox rows are locked,
  batches are capped, and a Redis timeout (2 s) aborts the claim.
- **Idempotency gaps** in jobs that assumed single delivery: the registry sentence forces the
  question per job; the review of PR 1 checks each.
- **Deleting sweeps that also covered a bug we did not know about.** The canary and the overview's
  dead letters make what the sweeps used to hide visible instead.

## 14. Designer's calls (for review)

1. Relay interval 2 s, batch 500.
2. Dispatch as soon as written; BullMQ `delay` stays the timer.
3. 20 attempts, then dead letter in the overview with retry / discard operations.
4. `ensure-run` outbox job written with every message and terminal commit, delayed 30 s as a
   backstop, plus the direct call.
5. IM deliver job owed for channel conversations on append, decision, answer and wait stop; the job
   decides what to send; `run.started` stays a hint.
6. Usage jobs owed only while the deployment has a `usage.report` subscriber (PG, cached 30 s).
7. Decisions do the `waiting → queued` transition in their own transaction.
8. Device keeps the last 100 op ids; the resolver never re-sends; hello backfills `unknown` intents,
   and a late-confirmed change whose ask was withdrawn is reverted by a new intent.
9. Policy ops require a new device feature flag `policyOpId` (no compatibility for older devices).
10. `run-orphan-check` every minute: repairs running orphans, reports and re-adds queued ones.
11. Org deletion deletes its pending rows, except its own cleanup work.
12. A job-id conflict with different data throws in tests and logs in production.
13. Migrations that change state owing work insert the outbox rows themselves.
14. New job names on `cap-kernel-maintenance`.
15. Latency budget +5 ms p50 on message-to-run-job-added.
