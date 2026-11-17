# Run fence: shared admission locks

Status: draft for maintainer review (short design). Source: design review 2026-11-16, finding
`run-fence-serializes-org` (medium), introduced by the execution-fencing fix c412cf39a.

## Problem

Every writable transaction inside a run claim runs the fence (`infra/database/transaction-host.ts`
→ `RunExecution.withClaim`, `runtime/run-execution.ts`): it takes `FOR NO KEY UPDATE` on the org
row, then on the root and current conversation rows, then compares `runs.execution_id`.
`FOR NO KEY UPDATE` holders exclude each other, so every event append, checkpoint write and tool
dispatch of every concurrent run in one org, and every org admin write that takes the org lock
(`orgs/org-lock.ts`: members, invitations, tokens, config), queue on one row. A large org's run
throughput is serialized.

## Approaches

| | What | Trade-off |
|---|---|---|
| **Chosen** | Admission takes `FOR KEY SHARE` on the org and root rows; deletion / offboarding take `FOR UPDATE` | Two lock modes that already exist; shares never conflict with each other |
| Advisory locks | `pg_advisory_xact_lock_shared(org)` for admission, exclusive for deletion | A second lock mechanism beside row locks; key hashing and ordering to maintain |
| Drop the org lock | Check `orgs.deleted_at` without a lock | Re-opens the race the fence closed (deletion committing between the check and the write) |

## Design

- `RunExecution.lockLiveConversation`: the org row and the root conversation row are read
  `FOR KEY SHARE` (they only need to stay undeleted for the transaction); the current
  conversation row keeps `FOR NO KEY UPDATE` (it serializes writes to that conversation's log,
  as today). The `execution_id` comparison is unchanged.
- Org deletion (`orgs.service.ts` soft delete) and offboarding take the org row `FOR UPDATE`
  (they conflict with every `FOR KEY SHARE` holder and wait for in-flight run transactions);
  conversation deletion takes the root row `FOR UPDATE`. Check every writer of
  `orgs.deleted_at` / `conversations.deleted_at` uses the exclusive mode.
- `OrgLock` (member / token / config writes) keeps `FOR NO KEY UPDATE`: it does not conflict with
  `FOR KEY SHARE`, so admin writes no longer wait for runs.
- Lock order stays org → root → conversation everywhere (documented next to `OrgLock`).
- Tests: a dual-replica test with two concurrent runs in one org appending events in parallel
  (both progress without waiting on each other: assert overlapping transaction windows through a
  test seam, no timing sleeps); org deletion during running runs still revokes them; an org admin
  write completes while a run transaction is open; no deadlock between deletion and appends.

## AGENTS.md rules touched

- **Multi-replica discipline: locks are `LockService` / `@WithLock`, never taken inside a
  transaction.** Unaffected: these are row locks inside the transaction (the existing fence), not
  distributed locks.
- **Writes run in `@Transactional()` methods.** Unchanged.
- **Tests: dual-replica tests live in the `container` project and join its checked-in list.**
  The new test does.
- Otherwise none: no contract, config or UI change.

## Left to the builder

- Whether checkpoint writes (`checkpointer.ts`, `requires_new`) need the root share at all.
- The exact test seam for observing overlapping transactions.
