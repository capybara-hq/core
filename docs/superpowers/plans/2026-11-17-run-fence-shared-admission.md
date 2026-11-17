# Run Fence Shared Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Concurrent runs of one org and org admin writes no longer queue on the org row.

**Architecture:** The run fence reads the org and root conversation rows `FOR KEY SHARE`; deletion and offboarding take them `FOR UPDATE`; the current conversation row and the `execution_id` check are unchanged.

**Tech Stack:** TypeScript, Kysely/PostgreSQL row locks, vitest (container project for dual-replica).

**Spec:** `docs/superpowers/specs/2026-11-17-run-fence-shared-admission-design.md`

> **Task 1 is superseded** by the revised spec (review found `FOR KEY SHARE` on the org row
> unsound; see the spec's "Rejected" section). What shipped instead: the run loop's hot-path writes
> outside a tool step (event appends, `StepLog` writes, checkpoints, the suspend) open with
> `@Transactional({ admission: "shared" })` and are admitted with a shared org advisory lock
> (`XactLock.admitOrgShared`), the org row read unlocked, the root and current conversation rows
> `FOR NO KEY UPDATE`; every other fenced transaction, every tool step (`withExclusiveAdmission`),
> the claim and the terminal write stay exclusive (org row `FOR NO KEY UPDATE`). Org deletion and
> offboarding take the exclusive advisory lock first (`OrgLock.lockForRemoval`), then `OrgLock`;
> nothing locks the org row `FOR UPDATE`, and a shared transaction takes no org-level lock
> (`assertNotSharedAdmission`). The steps below are kept as the record of the first attempt.

## Global Constraints

- Lock order org → root → conversation everywhere.
- `OrgLock` keeps `FOR NO KEY UPDATE`.
- Every writer of `orgs.deleted_at` and of a root `conversations.deleted_at` takes the row `FOR UPDATE` first.
- No fixed sleeps; the dual-replica test joins the container list.

## Review Focus

- Org deletion while two runs write: both runs end revoked, no deadlock (Task 1 test).
- Conversation deletion during a run's tool dispatch: the dispatch is refused, the run settles (Task 1 test).
- A super admin offboarding a member while that member's run writes (Task 1 test).
- An org admin changes a member's role while runs are writing: the write returns without waiting (Task 1 test).
- Checkpoint writes (`requires_new`) inside a claim still see the fence (Task 1 test).

---

### Task 1: Shared admission locks

**Files:**
- Modify: `packages/kernel/src/runtime/run-execution.ts` (`lockLiveConversation`: org and root `.forKeyShare()`, current conversation `.forNoKeyUpdate()`), `packages/kernel/src/orgs/orgs.service.ts` (deletion: org row `FOR UPDATE`), offboarding service (org row `FOR UPDATE` — find it with `git grep -n offboard packages/kernel/src`), conversation deletion (`packages/kernel/src/runtime/run-deletion.ts` / conversations service: root row `FOR UPDATE`), `packages/kernel/src/orgs/org-lock.ts` (doc comment: the lock modes and order)
- Test: `packages/kernel/test/runtime/run-fence-shared.dual.test.ts` (container list), additions to `packages/kernel/test/runtime/queued-abort.test.ts`

**Interfaces:**
- Consumes: `RunExecution.withClaim`, the existing pause seams (`pauseAt`) and `beforeEnsureRun` hooks in test helpers.
- Produces: no API change.

- [ ] **Step 1:** Dual-replica test: two runs in one org on two replicas hold their fence transactions open at a seam simultaneously (both reach the seam before either is released — proves no mutual exclusion); an org admin role change completes while both are held; release; both finish. Second case: org deletion while both are held waits, then both runs end revoked (`run_aborted.reason: org_deleted`), no deadlock error. Third: conversation deletion during dispatch.
- [ ] **Step 2:** Run `CAPYBARA_TEST_WORKERS=2 pnpm exec vitest run packages/kernel/test/runtime/run-fence-shared.dual.test.ts`; expect FAIL (second run blocks at the org row).
- [ ] **Step 3:** Change the lock modes; audit every `deleted_at` writer for orgs and root conversations and take `FOR UPDATE` first; document the modes in `org-lock.ts`.
- [ ] **Step 4:** Run the new test, `queued-abort.test.ts`, `run-orphan-check.test.ts`, the m-segment dual tests, `pnpm test:unit`, typecheck, `pnpm check`.
- [ ] **Step 5:** Changeset (`@capybara-hq/kernel`, `@capybara-hq/capybara` patch); commit `fix(kernel): run fence takes shared admission locks`.
