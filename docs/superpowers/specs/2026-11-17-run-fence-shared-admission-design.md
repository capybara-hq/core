# Run fence: shared admission for hot-path writes

Status: revised after review of the first implementation (the `FOR KEY SHARE` design below under
"Rejected"). Source: design review 2026-11-16, finding `run-fence-serializes-org` (medium),
introduced by the execution-fencing fix c412cf39a.

## Problem

Every writable transaction inside a run claim runs the fence (`infra/database/transaction-host.ts`
→ `RunExecution.withClaim`, `runtime/run-execution.ts`): it takes `FOR NO KEY UPDATE` on the org
row, then on the root and current conversation rows, then compares `runs.execution_id`.
`FOR NO KEY UPDATE` holders exclude each other, so every event append, checkpoint write and tool
dispatch of every concurrent run in one org, and every org admin write that takes the org lock
(`orgs/org-lock.ts`: members, invitations, tokens, config), queue on one row. A large org's run
throughput is serialized.

## Rejected: `FOR KEY SHARE` on the org row

The first implementation admitted every fenced transaction with `FOR KEY SHARE` on the org row
(deletion `FOR UPDATE`). Review found it unsound:

- **It breaks the global lock order for more than `OrgLock`.** A fenced transaction holds its
  conversation rows and then locks org-level rows; with the org row only key-shared, offboarding
  (org `FOR NO KEY UPDATE` → membership → agents → the member's conversations) gets past the org
  row and the two wait for each other (40P01). Confirmed paths: an Agent dispatch (parent
  conversation, then the agents `FOR SHARE`), the first sandbox tool call creating the default
  device (org and membership `FOR SHARE`, `DevicesService.insertDefault`), a skill-change decision
  (`OrgLock` → agents → conversation `FOR UPDATE`). An opt-in "org write admission" for the known
  paths cannot be trusted to cover every one.
- **Org deletion `FOR UPDATE` blocks foreign key checks** (`FOR KEY SHARE`) against the org: e.g.
  rejecting a pending upload (`catalog_items FOR UPDATE` → an `org_notices` insert) deadlocks with
  the deletion waiting for that catalog item in `OwnedItems.onOrgDeleted`.
- **Row locks do not queue fairly**: a stream of key-share holders starves a `FOR UPDATE` waiter.
- The root conversation row must stay `FOR NO KEY UPDATE` anyway: a sub-agent's handback appends
  to its parent (the root at depth 1) under `FOR UPDATE`, so two siblings holding the root shared
  deadlock upgrading it.

## Design

Two admission modes, chosen per transaction:

- **Exclusive (the default)**: unchanged from today, the org row `FOR NO KEY UPDATE`, then the
  root and the current conversation `FOR NO KEY UPDATE`. Every fenced transaction that does not
  ask for shared admission, and **every transaction inside a tool step** (the `tools` node of the
  loop around `ToolPipeline.runStep`, and a skill fork's dispatch: `withExclusiveAdmission`, an
  `AsyncLocalStorage` scope that overrides a shared request). Tool code takes org-level locks after
  the conversation rows (`OrgLock`, agents, memberships, devices); only the org row first keeps it
  in the order offboarding and the decisions use, so tool steps stay serialized per org. The run
  claim (`RunExecution.claim`) and the run's terminal write (`RunFinish.finish`) stay exclusive
  too (see "Left exclusive").
- **Shared**: a transaction opened with `@Transactional({ ..., admission: "shared" })` (a new
  `TransactionOptions` field the fence receives) is admitted with
  `pg_advisory_xact_lock_shared(hashtext('capybara.org-admission'), hashtext(org_id))`
  (`XactLock.admitOrgShared`); the org row is then read without a lock (a new statement under READ
  COMMITTED sees a committed deletion), and the root and current conversation rows are locked
  `FOR NO KEY UPDATE` as before. Used only by the run loop's own hot-path writes outside a tool
  step: `EventLog.append` (its own transaction), the `StepLog` writes (model output, usage, hook
  denials, `model_call` with its tool specs), the checkpoint writes (`KyselyCheckpointSaver`) and
  the suspend (`Waits.suspendIn`). These lock only the conversation rows of the run's tree, run
  rows of the same tree and rows of their own; nothing org-level.
- **Org deletion and offboarding** take the exclusive `pg_advisory_xact_lock` on the same key
  first in their transaction (`OrgLock.lockForRemoval`; `Offboarding.offboard` takes it too, a
  no-op when its caller already did), then `OrgLock` (`FOR NO KEY UPDATE`) as before. The org row
  is never locked `FOR UPDATE`: the deletion's `deleted_at` update is a no-key update, so foreign
  key checks against the org are never blocked. Heavyweight locks queue in order, so once the
  deletion waits, new shared admissions queue behind it: it waits only for the hot-path writes
  already admitted. `lockForRemoval` refuses to run inside a fenced transaction.
- **Global lock order**: org admission lock → org row → root conversation → conversation
  (documented on `OrgLock` and `RunExecution`).
- **No awaited nested fenced transaction.** A claim never opens a nested fenced `requires_new`
  transaction and waits for it while its outer fenced transaction is open: the inner one would wait
  for the outer's root row (and, behind a queued deletion, for the admission lock) on another
  connection, which PostgreSQL cannot detect as a deadlock. The root row lock already made such
  nesting a hang before this change, so no working path does it; an instrumented run of the
  runtime, orgs, schedules, platform, conversations, tools, subagents, background, evals, devices,
  sandbox, skills and git suites found none. The checkpointer's `requires_new` writes are called
  by LangGraph between nodes, outside any transaction.

## Left exclusive

- **The terminal write** (`RunFinish.finishIn`): besides the conversation and run rows it locks
  the scheduled task row and task run (`ScheduledTaskRunTracker.onRunFinished`), the run's
  approvals and questions and the queue, rows that `OrgLock` holders (schedule writes, the fire
  job's claim) lock in their own order. Once per run, so serializing it per org costs little;
  making it shared would need that order audited first.
- **The claim** (`RunExecution.claim`, unfenced): once per run start.

## Tests

`packages/kernel/test/runtime/run-fence-shared.dual.test.ts` (container list), two replicas, one
run slot each. The seam is a test agent loop (`AGENT_LOOP_FACTORY`) running a per-conversation
script inside the claim; waits target the specific blocked backend (`pg_blocking_pids` of a
holder pid the script reports, and the waiting statement's text), no sleeps.

- Two runs' hot-path transactions are inside admission at once (both hold the admission lock
  shared, on two replicas); an org admin write completes meanwhile.
- Beside a run's open tool-step transaction, another run's real `EventLog.append` and checkpoint
  write complete; the same checkpoint write inside `withExclusiveAdmission` waits for the org row.
- Org deletion waits for admitted hot-path writes (blocked on the advisory lock), then revokes both
  runs (`run_aborted.reason: org_deleted`, next fenced write `execution revoked`).
- Org deletion completes while two runs relay hot-path writes so one always holds the admission
  lock (bounded by the loop's own write count: both runs end revoked before the bound).
- Rejecting a pending upload's lock order (catalog item `FOR UPDATE`, then an org notice insert)
  during org deletion: no 40P01.
- Offboarding a member while their run is in a tool step that then takes an Agent dispatch's locks
  (agents `FOR SHARE`) or the first default device's (org and membership `FOR SHARE`): offboarding
  waits at the org row, completes without 40P01, the run is stopped.
- Conversation deletion during a hot-path write waits and revokes.
- `waits-dual.test.ts`'s guard (a fenced Platform org write vs offboarding) holds unchanged.

## AGENTS.md rules touched

- **Multi-replica discipline: locks are `LockService` / `@WithLock`, never taken inside a
  transaction.** Unaffected: the admission lock is a transaction-scoped advisory lock taken through
  `XactLock` (like `pg_advisory_xact_lock` elsewhere), not a distributed lock.
- **Tests: dual-replica tests live in the `container` project and join its checked-in list.**
  The new test does.
- Otherwise none: no contract, config or UI change.
