# Conversation Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Fix the eight confirmed conversation execution, deletion, selection and recovery defects.

**Architecture:** PG execution claims fence durable worker writes; unique Redis acquisitions cancel
in-flight work. Deletion owes stops transactionally. Recovery advances fairly and treats dead
run delivery as a visible failure. Existing event-log and tool uncertainty semantics remain.

**Tech Stack:** TypeScript, NestJS, Kysely/PostgreSQL, BullMQ/Valkey, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-15-conversation-reliability-design.md`.

## Global Constraints

- Reuse the current review worktree; preserve the original report; keep main on main.
- No applied migration edits, fixed sleeps, automatic uncertain-effect replay or scope expansion.
- All owed work is transactional outbox work. Org deletion cleanup carries no `org_id`.
- No new SDK contract or model-visible input; run zero-drift fixtures before and after context work.
- User clarified that maintainer review governs contribution, not repeated local execution approval.
- Execute natively in dependency order; no implementation delegation is needed.

## Review Focus

- Old acquisitions cannot renew/release a replacement of the same run (task 4).
- Stale code cannot delete a successor's checkpoints or emit terminal state (task 4).
- Org deletion cannot purge its own cleanup or allow a resumed child to start (task 5).
- Historical dead rows do not override a pending retry and cannot resurrect terminal runs (task 7).
- Duplicate message retry and auth revocation keep their existing behavior (tasks 2 and 3).

---

### Task 1: Reject truncated analysis as summary (finding 5)

**Files:** `packages/kernel/src/runtime/context/compaction.ts`,
`packages/kernel/test/runtime/context/compaction.test.ts`,
`packages/kernel/test/runtime/model-call.test.ts`.

**Interfaces:** `extractSummary(text: string): string` remains unchanged.

- [x] Add unit cases for unclosed analysis and summary-shaped draft text inside analysis; observe red.
- [x] Add real model-step case with `max_tokens` and >200 scratchpad characters; observe raw history
  wrongly replaced by `compaction_summary` before fixing.
- [x] Strip analysis through closing tag or EOF before searching for summary.
- [x] Run compaction and model-call test files and both zero-drift fixture files; require pass.

### Task 2: Authorized bounded SSE reconciliation (finding 6)

**Files:** `packages/kernel/src/runtime/stream.ts`, `packages/kernel/test/runtime/stream.test.ts`.

**Interfaces:** internal `enqueue(fn): Promise<void>` and `catchUp(maxPages?): Promise<void>`;
public stream contract unchanged.

- [x] Drop the final bus hint in a fake-clock stream test; observe no terminal event delivered.
- [x] After successful recheck, await a serialized `catchUp(1)` (500 events), retaining recheck gate.
- [x] Add page-bound and revoked-auth tests; verify no duplicated events and no unbounded backlog.
- [x] Run stream tests and later real Redis subscriber outage coverage where the existing harness fits.

### Task 3: Serialize partial selections and conversation deletion (findings 3–4)

**Files:** `conversations/conversations.service.ts`, `runtime/subagents/tree-jobs.ts`,
`test/runtime/model-switch.test.ts`, `test/conversations/archive.http.test.ts` (under kernel).

**Interfaces:** keep public `postUserMessage` and `remove` signatures. `postIn` returns either
written message/skips or latest selection for revalidation outside its transaction.

- [x] Gate resource resolution, commit a concurrent model switch, release effort-only message;
  observe lost model in HTTP regression.
- [x] Lock the conversation before message write, read log selection, compare validated snapshot;
  replan outside transaction on change, at most 3 attempts then actionable 409 conflict.
- [x] Verify duplicate-message behavior and deletion rejecting an already-authorized delayed send.
- [x] Gate deletion around the idle-root stop; send concurrently and prove root escape before fix.
- [x] Mark deletion before root stop; use includeSelf true for direct and owed deletion stop.
- [x] Run model-switch, archive, tree-jobs and queue tests.

### Task 4: Fence execution and cancel lease loss (finding 1)

**Files:** new `runtime/run-execution.ts` (claim scope + guard), new migration
`0135_run_execution_claim.sql`, `db/kernel-schema.ts`, `runtime/conversation-lock.ts`,
`runtime/run-worker.ts`, `runtime/loop.ts`, `runtime/langgraph-loop.ts`,
`conversations/event-log.ts`, `runtime/checkpointer.ts`, `runtime/run-finish.ts`,
`runtime/waits.ts`, `tools/pipeline.ts`, claim-sensitive subagent/tool transaction entry points,
and their modules/test helpers.

**Interfaces:** `ExecutionClaim { runId: string; conversationId: string; executionId: string }`;
`RunExecution.withClaim<T>(claim, live, fn: () => Promise<T>): Promise<T>` installs an ambient
transaction fence; `TransactionHost` applies it before writable root transactions. Explicit dispatch
checks use the same fence. Claim acquisition locks org, root/current conversation, then run, rejects
deleted state, and rechecks acquisition liveness after lock waits.
A stale claim throws `ExecutionRevoked` (internal interruption). Acquisition ids are UUIDs.

- [x] Inventory every worker mutation/dispatch and record its guard and lock order in the design.
- [x] Prove old same-run lease release/renew cannot affect replacement; distinct acquisition value
  preserves holder run-id queries, while releaseFor never revokes a live replacement by run id.
- [x] Pause old model, revoke lease/claim, resume after replacement; assert no stale tool or log write.
- [x] Add expand-only claim column and scoped claim provider. Carry claim through loop/checkpointer;
  guard append, checkpoint mutations, waits, dispatch and terminal transactions atomically.
- [x] Guard durable tool-start/dispatch and child creation; preserve started-without-result handling.
- [x] Abort in-flight signal on lease loss and classify revoked executions as interrupted. Suppress
  stale drafts, finish and checkpoint deletion; never clear successor state.
- [x] Run ownership/container regressions plus run-worker, loop, tools and checkpoint tests.

### Task 5: Durably stop deleted org work (finding 2)

**Files:** `orgs/orgs.service.ts`, org cleanup producer/processor, `runtime/run-queue.ts`,
`runtime/run-worker.ts`, `runtime/run-jobs.ts`, `runtime/subagents/dispatch.ts`,
`infra/outbox/registry.ts`, `runtime/maintenance-processor.ts`, related modules and tests.

**Interfaces:** idempotent platform-owned deleted-org cleanup job `{ orgId, byAccountId }`,
deterministic id `stop-org-<orgId>`; pages active chat/subagent conversations and background tasks.

- [x] Hold a run in model/tool/wait and delete its org with outbox fast path disabled. Assert durable
  stop survives purge and no new starts/resumes; verify pre-fix failure.
- [x] Owe cleanup after org-owned outbox purge, no `org_id`. Process bounded pages idempotently.
- [x] Add deleted-org gates to all execution entrances and recovery, respecting org/conversation
  lock order inventoried in task 4. Claim checks reject deleted state before dispatch.
- [x] Test API-only delete, worker recovery, queued/stalled/waiting children and repeated cleanup.

### Task 6: Fair orphan traversal (finding 7)

**Files:** `runtime/run-orphan-check.job.ts`, new scan cursor persistence migration/schema if needed,
`test/runtime/run-orphan-check.test.ts`.

**Interfaces:** shared PG cursor `{ since: string; runId: string } | null` for scheduler only;
`candidatePages` accepts a starting cursor and reports last inspected row/end. Diagnostic traversal
remains independent. Keep batch 500 and maximum 10 pages.

- [x] Seed 5,001 healthy runs before an orphan, run consecutive passes on distinct instances;
  observe unreachable orphan before fix.
- [x] Persist cursor under the existing job lock, advance even on healthy pages, reset at end.
  Preserve PG timestamp precision and bound every pass.
- [x] Verify persisted continuation and end-of-population reset in the boundary regression.
  Coverage limit: separate tests for removed cursor rows, insertion before cursor, and process
  restart were not added; keyset traversal does not require the referenced run to exist. The
  validation scope was narrowed explicitly during implementation, as recorded in the ledger.

### Task 7: Terminal exhausted delivery with explicit retry (finding 8)

**Files:** `runtime/run-orphan-check.job.ts`, `runtime/run-finish.ts`, `errors.ts`,
`test/runtime/run-orphan-check.test.ts`, outbox retry tests and transactional-outbox design.

**Interfaces:** delivery lookup distinguishes pending/dead/absent; pending takes precedence.
`run.delivery_failed` terminal error, normal RunFinish follow-up and attempted trigger consumed.

- [x] Exhaust a run's outbox delivery and assert failure; observe queued forever before fix.
- [x] Recheck state under conversation lock and distinguish concurrent pending retry/live job.
- [x] Finish queued dead delivery visibly; consume its trigger boundary, preserve dead audit row.
- [x] Test admin retry of terminal old job is no-op; explicit new user send starts a new run;
  pending retry wins over historical dead row and no automatic replay of failed message.

### Task 8: Final review and validation

**Files:** original report, patch changeset for `@capybara-hq/kernel`, this plan and design.

- [x] Record each finding's reproduction, fix, precise test evidence and remaining limitations.
- [x] Update checked-in unit/container membership for any new files, run focused tests and
  reconstruct/rename-compat zero drift after changes.
- [x] Self-review ownership/tenant/transaction/outbox invariants and run relevant custom checks.
- [x] Run `CAPYBARA_TEST_WORKERS=4 pnpm -s verify --json`; fix failures, report real blockers.
- [x] Prepare the verified Conventional Commit, changeset and preserved original report.

**Integration:** the user explicitly authorized pushing, opening a PR and merging through that PR
after required CI checks pass. GitHub records the subsequent integration status.
