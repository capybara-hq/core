# Task 8.4 (part A) independent review: B3 exact background revocation, M6 consumer, staged drain

Reviewer: independent, read-only. Checkout `/Users/grant/Capybara/core/.claude/worktrees/perm-t8-4`
(branch `perm/t8-4`), range `e6a08b949..473486522` (commits `3069b5d00`, `3ef9ae9e5`, `473486522`;
18 files, +783/-33). I judged from the code against AGENTS.md (multi-replica discipline), the
writing-kernel-api, writing-sandbox-providers and writing-extensions skills, plan Phase 8.4 / B3 row
(8.5 not pre-empted) and the design ("Chosen lifetime model", "Lifetime distinctions"). I read the
author's `task-8-4-report.md` only after forming the findings below.

## Verdict: CHANGES_REQUIRED

The kernel B3 slice is correct and I found no Critical defect in it. Two small defects in the staged
drain contradict plan 8.4: retries of already-admitted native operations are refused while draining,
and the drain can report "pending" without timing out. The B3 gate evidence also falls short of the
plan's "actual writer→outbox→device proof", so B3 must not yet be recorded as complete. All three are
cheap to fix. The rest of the work is sound.

## Critical

None.

## Important

**I1. The drain refuses retries of admitted native, prepare and browse operations.**
`packages/device/src/staged-session.ts:51-64` (`REFUSED_WHILE_DRAINING`) and `:214-217`.
- The comment calls these "unsupervised native … operations", but they are supervised.
  `mac-operation-backend.ts:259-270` (`nativeMethods.run`) goes through `invoke` and then
  `supervisor.execute`, which runs `admit`. `admit` already refuses only fresh admissions while
  draining and lets a previous entry recover (`operation-supervisor.ts:515-532`).
- Failure scenario:
  1. A `writeFile` is dispatched and journalled on the device.
  2. The response is lost on a socket blip.
  3. The device starts draining.
  4. The kernel's same-identity retry (`sandbox.service.ts` `claimReconciliation`, then `invoke`)
     gets `unsupported` at the session layer.
  5. The kernel keeps the intent `started-or-unknown` (`sandbox.service.ts:1408-1416`), so nothing
     is corrupted. But the plan requires "retry/recovery of already admitted IDs" during drain, and
     here the outcome stays unknown for the whole drain. A timed-out drain is never reused, so it can
     stay unknown longer.
- Fix: remove the supervised ops from the set (`readFile`, `writeFile`, `stat`, `list`, `scan`,
  `prepare*`, `browse*`) and keep only truly unsupervised admissions (`create`). The supervisor's
  `admit` then gives the same "fresh refused, retry recovered" rule to every admitted kind. Replace
  the browse assertion in the staged test with two checks: a fresh browse is refused (by the
  supervisor) and a retried admitted native id is answered.

**I2. `drainStagedSession` can report "pending" without timing out.**
`staged-session.ts:91-108`.
- After `backend.lifecycle.settle(signal)` resolves, the code returns `drained:true` only if
  `state.running.size === 0`. Otherwise it falls through to `{drained:false, pending:{requests:N}}`.
- During drain the kernel keeps sending `backgroundStatus` and `backgroundReadOutput` (the poller,
  TaskOutput). One request still in flight when `settle` returns makes the drain report pending,
  although the signal never aborted.
- This breaks the contract that only a timeout reports pending. A caller that treats a non-drained
  report as final would keep a device that had fully drained out of service.
- Fix: loop until both are empty or the signal aborts. For example:
  `while (!signal.aborted) { await requests; await settle; if (running.size === 0 && ownership empty) return drained; }`.
  Add a test with a status request in flight at settle time.

**I3. The B3 gate evidence is short of the plan.** Plan B3 row: "actual writer→outbox→device
proof"; design: "real platform/org/policy writers and outbox consumers … through disconnect".
- The owner-selector test (`managed-launch.test.ts`, "the owner selector revokes only…") does not run
  the real owner writer. It calls `PermissionCeilingWrites.publishLocked` with `ownerPolicyRevokes`
  directly instead of `DevicePolicyService` / `machines.ts`.
- The scopes and `granted_hosts` in that test are hand-edited in SQL (`restrictTo`, the
  `granted_hosts` update) instead of produced by a real admission with an explicit host grant.
- Every test runs the consumer as `reconcileJob().revoke(id)`. None goes through outbox dispatch into
  `MaintenanceProcessor` in the worker role. That leaves the new `MaintenanceModule → BackgroundModule`
  DI wiring proven only by app boot.
- The provider is the in-test fake. Nothing covers a real device or staged session, a disconnect, or
  "restricted-only change leaves Full work" in the owner direction.
- The org test (real `OrgSettingsService.update`) is a good real-writer proof for the Full direction.
- Fix: keep B3 open in the ledger until at least:
  - the real owner writer and the real org network writer each run with an independently granted
    host;
  - one revocation runs end to end through the outbox relay and `MaintenanceProcessor`;
  - one revocation crosses disconnect and reconnect.
  The author's report lists most of this under "Not done". The issue is the label "B3 done for the
  kernel slice".

## Minor

- **M1. The `forExecution` relaxation is tested only by a direct call.**
  `permission-call-grants.ts:352-361`; test "a retried start of an acknowledged operation…".
  - The relaxation is safe:
    - it keeps the method, scope, input, admission-hash and host-provenance checks;
    - a revoked intent is still refused;
    - the device dedupes by operation id and hash, so no second process can start;
    - `grantsWithin` re-applies current limits.
  - The kernel itself never re-dispatches a `background-running` start
    (`sandbox.service.ts:1324, 1395`). The case it serves is a concurrent dispatcher that has already
    passed claim when the other one acknowledges. No test drives that race through `invoke`.
  - Without the relaxation, that racer would get `forbidden` and keep the intent unknown (not
    refused), so the risk is low. Add the race test when B3's real-device gate lands.
- **M2. Unresolvable obligations retry hourly forever.** These are lost tasks on a replaced or
  deleted instance, or a deleted device (`SandboxService.require` throws). The 1 h cap bounds the
  rate, but the jobs never end until 8.5 retirement consumes them. The author's 8.5 interface note
  states this correctly. Record it in the 8.5 handoff as a release-gate item ("unresolved obligations
  reported honestly"), not as debt to forget.
- **M3. Concurrent revoke deliveries are not serialised** (`-<id>`, `-<id>-<attempt>`,
  `-<id>-expired` may overlap across replicas). This is safe: `claimStop` serialises the stopper
  path, the provider's stop claims a single winner, and `acknowledgeRevocation` /
  `settleOwedCancel` are conditional and idempotent. The loser only produces an extra deferral. No
  change is needed; a comment would help.
- **M4. Drain test coverage.**
  - The drain tests prove refusal of fresh starts and exec, retry of an admitted start, waiting on an
    acknowledged worker whose start RPC ended, and a timeout report that is never reused.
  - Nothing proves the drain waits on a pending exact cancellation, an open collector without a
    worker, or dirty persistence. The "cannot settle" test aborts with `workers: 1` still owned.
  - Add one case per ownership class (the code handles them, see below).

## Checks that passed

- **Exact revoke worker** (`operation-reconcile.job.ts:154-235`).
  - A `backgroundStart` with a ref takes the exact path; a ref-less one keeps `revokeOperation`.
  - A running task is stopped through `BackgroundTaskStopper.stop(task,"revoked")`, which runs
    `stopManaged`: exact ref, `onManagedInstance`, `ifRunning` on the recorded `createdAt`, and a
    handle id check. The grace is `MANAGED_STOP_GRACE_MS` = 5000. `ifRunning` never resumes and
    returns `other_instance` for a newer generation.
  - Without a running row, the intent's own ref is checked against `operation_id` and
    `instance_generation`, then `p.background.stop` runs on the recorded generation with the same
    guards.
  - Acknowledgement happens only on:
    - a task that becomes `terminal` (a verified stop or exit);
    - an already-`terminal` row;
    - a device answer of `stopped` or `already-exited`.
  - These keep the obligation owed and deferred: a running row after the stop (pending, or a claim
    held elsewhere), `cancel-pending`, `lost`, `not_running` (including suspended) and
    `other_instance`.
  - Backoff is 30 s × 2^(n-1), capped at 1 h. `reconcile_attempt` gives every deferral a
    deterministic, colon-free job id.
- **Affected-task-only selection.**
  - `publishLocked` candidates include `background-running`.
  - The org selector spares restricted work when Full is turned off: `needsFullCeiling`, then
    host / `granted_hosts` provenance (only when the network is open).
  - The owner selector spares Full work on a restricted-only change (`ownerPolicyRevokes`: full
    returns `mode !== "auto"`) and keeps independently granted hosts.
  - The two-task tests show the sibling stays `background-running` / `acknowledged` with no job and
    no stop, and a duplicate delivery stops nothing.
- **M6 consumer** (`finish.ts:99-118`).
  - A managed lost finish changes `background-running` to `revoked` (`outcome_unknown`) and adds
    `sandbox-operation-revoke-<op>` in the same `@Transactional` as the finish and event. The intent
    row is locked first.
  - This does honour "retains an independent pending obligation". The obligation now lives on the
    intent (`state='revoked' AND revoke_acknowledged=false`), backed by a durable outbox job, not on
    the cascading task row.
  - Leaving active revocation selection is correct: the exact cancellation is already owed, and
    nothing may reuse the authority.
  - Cascade safety verified:
    - `sandbox_operation_intents` (0140/0143) has no foreign key to conversations, runs or tasks
      (only `permission_grant_id` → `permission_call_grants`, which is not deleted on conversation
      delete);
    - nothing in `src` deletes from `sandbox_operation_intents`;
    - only `payload_chunks` cascade from the intent;
    - `expirePayload` clears `input` but keeps `execution_ref` and `instance_generation`, which is
      all the exact stop needs.
  - Test "a hard-deleted conversation keeps the exact cancellation owed" proves it with a raw
    `DELETE`.
  - After a verified stop, `settleOwedCancel` moves the lost row to `terminal` without touching its
    finish or event, so pruning can then remove it. This closes the "then terminal, then pruning"
    part of 8.3 M6.
- **The six changed 8.2/8.3 expectations are legitimate, not weakening.**
  - managed-consumers ×3: the lost intent moves from `background-running` to `revoked`, unacknowledged
    and owed. This is the intended M6 change and a stronger obligation.
  - managed-launch "revoke after ack": `revokeOperation` is replaced by an exact stop by the launched
    ref, plus an acknowledgement assertion that is new. Equally exact, and it is what B3 requires.
  - managed-launch "deletion": exactly one stop (the deletion's); the owed revoke is acknowledged
    because the row is `terminal`, and `revoked == []`. It now also asserts the acknowledgement.
  - managed-launch "racing ACK": `[op, op]` becomes `revokeOperation` before the ref plus an exact
    stop by the ref after it. This is more precise than before.
  - The supervisor "concurrent stops" test was rewritten. Its old completion signal
    (`onLiveChanged(false)`) is now deliberately delayed while a cancellation is owed. The new
    assertions check that the watcher stays on, which is the 8.4 requirement.
- **Staged drain behaviour** (apart from I1 and I2).
  - `beginDrain` is permanent for the process.
  - Fresh admissions are refused with `unsupported`. The kernel turns that into a pre-admission
    refusal for a fresh start and keeps a dispatched one unknown, never failed.
  - A retry of an admitted id returns the same ref.
  - Status, read, tail, stop and revoke are served.
  - `settle` waits for:
    - live and fault owners, via `completion` and `finished`, independent of the start RPC;
    - cancellations;
    - spools plus in-flight reads;
    - control writes plus dirty controls (retried once per drain, no write loop, and no busy-wait
      when only failed persistence remains).
  - On abort, `DrainPendingError` is thrown with the ownership snapshot. "Drained" is never decided
    from `running.size === 0` alone.
  - `notifyOwned` keeps the owner watcher on while `cancellations` is non-empty.
  - Protocol 2 is untouched:
    - `client.ts` only re-exports the dormant seam;
    - the supervisor's `draining` flag defaults to false;
    - the `onLiveChanged` widening is on a v3-only backend.
- **Drain RED/GREEN.** The RED was API absence, as the author says. The GREEN tests do test
  behaviour: refusal versus retry, no cancellation issued, a drain that is not done while the
  acknowledged worker runs, completion after `finish()`, the timeout report and the non-reuse.
  The gaps are in I1, I2 and M4.
- **Multi-replica discipline.**
  - No in-process timers or state were added.
  - Owed work goes through the outbox inside the writing transaction, with deterministic job ids.
  - The revoke consumer runs only under `MaintenanceModule` (worker role).
  - No lock is taken inside a transaction.
- **8.5 is not pre-empted.** There is no retirement, quarantine or new-generation clearing. Lost or
  replaced obligations stay owed.

## mac-operation-backend failure ("Unsupported runtime bundle")

I verified it independently on base `e6a08b949`. I made a temporary detached worktree in the
scratchpad, linked to perm-t8-4's `node_modules`; `plugin-sdk` is unchanged in the range.
`packages/device/test/mac-operation-backend.test.ts` gives 1 failed / 13 passed, with the identical
error `initial stat: Error: Unsupported runtime bundle` in "prepares a missing conversation subtree
through the real descriptor helper". The failure exists on base and is environmental. The diff does
not cause it.

## Test runs (head `473486522`, CAPYBARA_TEST_WORKERS=2, CAPYBARA_TEST_CONTAINER_STARTS=2)

| Files | Result |
|---|---|
| kernel `background/managed-launch` + `background/managed-consumers` | 71/71 passed |
| kernel `sandbox/permission-wiring` + `background/permission-lifetime.dual` | 31/31 passed |
| device `operation-supervisor` + `staged-session` | 32/32 passed |
| device `mac-operation-backend` | 13/14 (1 pre-existing failure, same on base) |

I did not run the full `pnpm verify` or `test:unit`; the author reports both green.

## Re-review round 1 (`473486522..b1f7a038c`)

Scope: one commit, 5 files, +505/-173. Source change only in `packages/device/src/staged-session.ts`;
the rest are tests. Read-only on `perm/t8-4`. I reproduced the REDs myself in a temporary detached
worktree in the scratchpad (since removed), reverting only the fixed source there.

### Verdict: APPROVE (for this part of 8.4; B3 itself remains open, correctly recorded)

| Finding | Status | Evidence |
|---|---|---|
| I1 | Fixed | `REFUSED_WHILE_DRAINING` is now `{"create"}` only. Native, prepare and browse ops reach `admit`, which refuses fresh ids and recovers admitted ones. New staged test: a journalled `writeFile` retried during drain returns ok with no new launch; a fresh write gets `unsupported` /draining/. **RED reproduced:** with the old `staged-session.ts` this test fails. |
| I2 | Fixed | `drainStagedSession` now loops until the request table and the backend ownership are empty at the same time; only abort or a `settle` failure ends it as pending. New test holds a `backgroundStatus` in flight while ownership empties: the drain stays open, then reports `drained:true`. **RED reproduced:** the old code gives `{drained:false, pending:{requests:1}}` with no timeout. |
| M4 | Done | Three supervisor guard tests: a pending exact cancellation after the worker is gone; an output read in flight after the task ended; dirty control persistence, retried once and then waited for. They pass on the existing code, as expected for guards. Each one asserts that the drain is still open before the release, so they are meaningful. |
| I3 | Fixed for the owner (v2) and org writers | The SQL-edited selector tests are replaced by two worker-role `poll.test.ts` cases with real admissions through `managedTaskFixture.launchAnother`. The admissions themselves record `granted_hosts` (`[]` for the baseline task, `[HOST]` for the approved network ask), and Full is chosen with displayed consent through `PermissionFacts.scope` and `PermissionProfilesService.set`. The writers are real: `MachinesService.recordPolicy` and `OrgSettingsService.update({autoMode:"off"})`. Delivery is real: `drainOutbox`, then the worker's `MaintenanceProcessor`. Only the affected task ends `stopped/terminal` (one exact stop); its sibling stays `running/acknowledged` and `background-running`. **RED reproduced:** with the base `operation-reconcile.job.ts` and `maintenance.ts`, both tests fail as `running` instead of `stopped`, so the old worker acknowledged through `revokeOperation` without stopping. This is a behavioural RED, not a wiring one. |
| M1 | Done | Invoke-driven race through the real `LocalDeviceProvider.stagedOperations` adapter (fake transport only): dispatcher A stalls after its claim, its holder goes unknown, recovery acknowledges, then A is released. **RED reproduced:** without the relaxation the device receives 1 start, not 2 ("expected 1 to be 2"). The author notes that the tool result and the task/intent state are the same either way; the only effect is that the late idempotent retry reaches the device with its recorded authority. That is accurate and acceptable. |

Report: section "B3" now reads "kernel slice landed; B3 NOT complete". "Fix round 1" lists the
remaining B3 gates:
- the B2-format owner writer (`DevicePolicyService`, version-2 report), including a restricted-only
  owner change that keeps unrelated Full work;
- revocation across disconnect and reconnect against a real device or staged session;
- the platform writer (`permission-config-publication`) end to end through the worker.

M2 is carried as an 8.5 release-gate item and M3 needs no change. Both are agreed.

### Remaining findings (Minor, none blocking)

- **R1.** In the owner test, the baseline `device_machines.local_policy` and the approved network
  `approvals` row are inserted by SQL rather than produced by the owner's report path and the
  approval decision flow. The admission that consumes them is real, so the provenance evidence holds.
  When the B2 gate lands, its writer test should produce both through their real writers.
- **R2.** `drainStagedSession` also ends as pending when `settle` throws a non-abort error (the
  `catch { break; }`). Today `settle` only throws `DrainPendingError` on abort, so this is latent.
  Narrowing the catch, or rethrowing anything that is not a `DrainPendingError`, would make the
  "only a timeout reports pending" rule structural.

### Test runs (head `b1f7a038c`, CAPYBARA_TEST_WORKERS=2, CAPYBARA_TEST_CONTAINER_STARTS=2)

| Files | Result |
|---|---|
| device `staged-session` + `operation-supervisor` | 37/37 passed |
| kernel `background/poll` + `background/managed-launch` | 61/61 passed |
| RED: staged I1/I2 against old `staged-session.ts` | 2 failed / 8 passed (as intended) |
| RED: poll B3 pair against base reconcile job + maintenance | 2 failed (running ≠ stopped) |
| RED: M1 race without the `forExecution` relaxation | 1 failed (device starts 1 ≠ 2) |

"Unsupported runtime bundle" failures were not considered, as instructed: the coordinator reports
they are fixed on the primary branch in 614325137 (bundle version 2). This corrects my earlier
"environmental" reading, which was based only on the failure being the same on base.
