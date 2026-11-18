# Task 8.5 independent review: legacy retirement and the fail-closed reuse barrier

Reviewed: `perm/t8-5`, `git diff e2d24c679 a69a43c31` (22617f83b, 2256b2447, a69a43c31). I judged
from the code first and read the author's report afterwards. Read-only: no edits, commits or stash.

## Verdict: CHANGES_REQUIRED

Most of the work is sound. The freeze is published under the exclusive platform authority lock,
and admission takes the shared platform lock, so the race is closed for replicas running this code
(the dual test proves it). Obligations have no FKs and outlive pruning. A cloud destruction is
recorded only after the provider's destroy resolves, and only for exactly that incarnation. Local
destroys and new generations never resolve anything. The boot-ID rule matches the controller
ruling. The migration is expand-only and idempotent. Protocol 2 is unchanged apart from an
additive optional field. Nothing publishes the freeze in production.

One fail-open gap remains: the inline gate depends on the worker having already enumerated. The
plan explicitly forbids that ("its absence cannot bypass the inline gate"). A second gap is that
the `ifRunning` paths keep using SID authority and admitting new work on incarnations that are
under obligation.

## Critical

### C1. Between the freeze and the worker's first scan, the gate is open, and the legacy SID killer erases rows from the enumeration
- `sandbox/legacy-retirement.ts:199` `scan()` is called only by `RetireLegacyTasksJob`
  (`background/retire-legacy-tasks.job.ts:91`). The inline gate (`sandbox.service.ts:2377`
  `retireIncarnations`, `:1563/:1580` `hasUnresolved`) reads only obligation rows that already
  exist.
- **Failure scenario:** the freeze commits. Before the next worker tick (up to 60 s), or for as
  long as no worker replica runs, a device with legacy rows has no obligation yet.
  - The device takes the ordinary path: `hasUnresolved` is false, so a suspended cloud instance
    is resumed (`killAll`), the shared path is entered, and so on.
  - After a resume or a fresh create, `killPendingTasks` (`sandbox.service.ts:2181-2230`)
    SID-kills `kill_pending` rows of that instance. It then `clearKill`s all of them, including
    rows of other incarnations ("Tasks of another instance have no process here and are only
    cleared").
  - Once the flag is cleared, a terminal SID row no longer matches the scan predicate
    (`legacy-retirement.ts:217ff`: `kill_pending` or running). The incarnation it names is never
    recorded as an obligation.
- **What the plan requires:**
  - The legacy freeze, then enumeration under it, then no use.
  - A stored SID alone is never authority.
  - The worker's absence cannot bypass the inline gate.
- **Fix:** make enumeration part of the gate.
  - Once frozen, `retireIncarnations` (and the shared fast-path check) first runs a per-device
    scan of legacy rows and revoked starts, or treats "frozen and the device has a candidate row
    with no member" as unresolved.
  - `freeze()` (or the activation runbook entry point it will become) runs `scanUntilStable()`
    before returning.
  - After the freeze, `killPendingTasks` must not run, and must not clear flags. Those rows
    belong to the obligations.
  - Add a test: freeze, run no scan, then use the device. The device must be refused, or retired
    through the gate. The `kill_pending` row must still be a member afterwards.

## Important

### I1. `ifRunning` is ungated: SID signalling and a new staged admission still reach incarnations under obligation
- `sandbox.service.ts:867` `ifRunning` takes a shared lease on any `running` row without the
  obligation check. Its callers and what they do:
  - Legacy `TaskStop`: `background/stop.ts:249` `termScript` plus `killSession` by SID.
  - Legacy poller and `TaskOutput`: `background/poll.job.ts:266`, `tasks.service.ts:303`, and
    `tools/builtins/sandbox/task-output.ts:218`. These run new execs on the old incarnation.
  - `withBrowse` (`sandbox.service.ts:1030`): a new staged admission (`admitBrowse`/`claimBrowse`).
- **Failure scenario:**
  - A cloud device has an open obligation on its running incarnation.
  - Holders of `ifRunning` take shared leases repeatedly. The worker's single `tryExclusive`
    returns `busy`, but those holders keep signalling processes by stored SID. The plan says:
    "A stored SID alone is not authority to signal a process".
  - The staged browse is admitted on that incarnation as "new admission".
- **Fix:**
  - When the device has an unresolved obligation, `ifRunning` refuses the legacy SID callers
    (treat it as `not_running` / unavailable; the task then ends lost once the incarnation is
    destroyed). It also refuses `withBrowse`.
  - Keep exact-ref managed drains allowed: `onManagedInstance` status/stop, and the revoke
    worker in `operation-reconcile.job.ts`.
  - The skill sentence "`ifRunning` (polls, stops) is not gated" should state that split.
- Smaller instance of the same problem: on the shared path, `asShared` runs `killTagged` of dead
  holders (`sandbox.service.ts:1668`) before the post-lease obligation re-check (`:1580`). Move
  the re-check before `killTagged`.

### I2. A legacy null-SID row's generation is guessed from the instance current at scan time
- `legacy-retirement.ts:261-268`: with `sandbox_created_at` NULL, the generation is the live
  instance's `created_at`, which can be an incarnation made long after the dispatch.
- **Failure scenario:**
  - A failed or `launch_abandoned` dispatched row ran on incarnation A.
  - A was replaced, for example after a provider switch whose `retire()` failed and kept
    `prev_handle`.
  - The obligation names B. B is destroyed needlessly, and A is never recorded.
  - The no-reuse property happens to hold, because a replaced incarnation is not resumed. But
    the obligation is not keyed by the "exact old instance incarnation" the plan requires.
- **Fix:**
  - `admitLegacyDispatch` records the instance generation it admits for. It runs under the
    launch's shared lease, so `currentInstance()` is exact there.
  - Historical rows that `0148` marks `unknown` fall back to `unknown` instead of the current
    instance. Alternatively, document the guess as a deliberate over-approximation and record it
    in the release report.

## Minor

- **M1. Reopening an obligation can store a stale boot** (`legacy-retirement.ts:349, 380-391`).
  - `currentBoot()` is read before the obligation row is locked `FOR UPDATE`. A concurrent hello
    that resolved it with B2 can therefore be reopened with B1. The next "current" hello then
    resolves it again against a member dispatched in B2.
  - Only an unfenced old replica can produce such a member, so this is narrow.
  - Fix: read the boot after the `forUpdate`.
- **M2. A hello without `bootId` leaves `device_machines.boot_id` unchanged**
  (`local-devices/machines.ts:355`).
  - A downgraded client running in a later boot keeps the stale earlier boot as current. A later
    upgraded hello then "proves" a restart that did not happen after its launches.
  - Fix: set `boot_id = NULL` on a hello without one.
- **M3. The macOS `kern.boottime` fallback is not a stable boot identity**
  (`packages/device/src/boot-id.ts:55`).
  - macOS shifts `kern.boottime` when the wall clock is stepped, so it can change without a
    reboot and give false restart evidence.
  - Fix: drop the fallback. No `bootId` means the obligation never resolves, which already
    fails closed.
- **M4. Confirmed destroys in `retire()` are not recorded** (previous-provider destroy and the
  `prev_handle` retry, `sandbox.service.ts:2762`).
  - Obligations on those incarnations stay quarantined even after their destroy is confirmed.
  - Only `destroyRow` and the gate record destructions (`:2874`, `:2089ff`).
  - Fix: record in `retire()` on success, with the generation of the incarnation it retires.
- **M5. Worker boundedness: the gate's provider `destroy` has no timeout**
  (`sandbox.service.ts:2089`, signal `opSignal(held)`).
  - The job does not pass its `signal` into `retireLegacy`
    (`retire-legacy-tasks.job.ts:95`), so one hung provider stalls the tick for up to the
    15-minute run-lock TTL.
  - Fix: `AbortSignal.any([..., AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS)])` plus the job
    signal.
- **M6. A non-current obligation records the current instance's provider**
  (`legacy-retirement.ts:269-274`: `r.instance_provider ?? "unknown"`).
  - After a provider switch, it names the wrong provider, so `destructionRecorded` can never
    match it.
- **M7. `isRetirementPending` matches on the message prefix** (`sandbox.service.ts:~468`).
  - Brittle. Use a dedicated error subclass or a marker.
- **M8. The partial index predicate does not match the scan's WHERE**
  (`0148:79-81` vs `legacy-retirement.ts:233-238`).
  - Low impact while the table is small; confirm with `EXPLAIN`.

## Assessments requested

- **Suspended cloud instance with a revoked managed start (author's concern 6).** Destroying the
  whole instance instead of resuming it is acceptable and fail-closed:
  - The plan allows terminating the old incarnation before reuse.
  - Today's resume does `killAll` anyway, which 8.6 removes.
  - Exact stop is never available on a suspended instance (`stop.ts`: "never resumed for a
    stop").
  - Cost: unaffected sibling managed tasks on that suspended instance end lost (the files are
    kept).
  - For 8.6/9, consider resume under the exclusive lease, then exact cancel of the revoked ref
    with confirmation, then downgrade. That preserves siblings. Record this as a follow-up, not a
    blocker.
- **Boot-ID evidence against the ruling:**
  - Evidence is recorded only after credential authentication and the device-lease claim, inside
    `recordHello`'s transaction, with the machine row locked.
  - Revoked machines are ignored in both `recordBoot` and `settleRebooted`.
  - The same boot through a new credential does not resolve. Older or replayed boots, including
    through a new credential, are rejected by the seq guard. I checked it: `seen.seq <= min(seq of
    the obligation's boot)` across all of the device's machines, revoked ones included.
  - Boot history cascades only with device or org hard deletes, and there the device is gone.
  - Unknown stored boots never resolve, and there is no manual override.
  - The different-computer consequence matches the ruling: the old computer's processes cannot
    touch the new incarnation.
  - Remaining trust: the device program self-reports, which is the owner-report trust level and
    accepted. M2 and M3 are the residual holes.
- **Freeze:**
  - Correct for this code. `freeze()` uses an exclusive platform xact lock, and admission uses
    shared platform plus shared org locks with the mark in the same transaction.
  - A stale unfenced replica is documented as must-drain. Its rows default to `unknown` and are
    rescanned each tick.
  - It is the only legacy launch path (`bash.ts`). The admission is checked inside the shared
    lease, immediately before the exec, for every reservation.
- **Enumeration:**
  - Covered: running with a SID; running and null-SID rows that are dispatched or unknown;
    stopping (`stopping_at` with status running); `kill_pending` rows including terminal ones;
    failed rows that may have dispatched; suspended and offline instances; revoked starts on any
    non-running generation.
  - No SID or PID is converted.
  - Breadth consequence (author's concern 3): every historical null-SID row (`unknown`) becomes
    an obligation. Every local device that ever had a failed background launch will need a
    restart, or stays unavailable for good if it never reported a boot. The controller should
    accept this knowingly, or narrow it (I2 fix plus a time bound).
- **Cloud resolution:**
  - Only destruction confirmed by the provider for exactly that generation counts, followed by a
    fenced `destroyed` before fresh creation.
  - A failed destroy keeps the obligation (`noteFailure`) and the answer is unavailable.
  - Destroy is idempotent per the SDK contract, so a crash between the destroy and the record is
    retried safely.
- **Release report:** honest. `retired` requires the freeze plus zero
  open/quarantined/unsettled. Note that obligations of hard-deleted local devices keep `retired`
  false for good, which is correct reporting.
- **Worker:**
  - `@LockedInterval` under `WorkerModule`.
  - Bounded: 10 devices per tick, 100 settles per tick.
  - Backoff of 30 s doubling, capped at 1 h. `busy` is retried every tick.
  - No `LockService` inside transactions. Lease, then xact lock in admission, consistent with
    freeze. See M5.
- **Migration 0148:**
  - `IF NOT EXISTS` throughout, with `DROP CONSTRAINT IF EXISTS` before the CHECK.
  - Expand-only; no FKs on obligations or destructions; partial indexes.
  - `device_machine_boots` cascades with the machine.
  - Acceptable.
- **Dual test:** meaningful. Worker against acquisitions across replicas: destroyed once, fresh
  created after, never reused. Failing destroy keeps both replicas out. Freeze against 12
  concurrent admissions: members equal the admitted set exactly.
- **Nothing is activated:** there is no production caller of `freeze()`. Effects already live:
  - `legacy_dispatch` marks;
  - destruction records;
  - the job's revoked-start scan, which is empty while managed is dormant;
  - one extra query per `enter`.

## Tests run (CAPYBARA_TEST_WORKERS=2 CAPYBARA_TEST_CONTAINER_STARTS=2)

- `protocol-upgrade.test.ts`, `protocol-upgrade.dual.test.ts`, device `boot-id.test.ts`, SDK
  `device-protocol.test.ts`: 4 files, **58/58 passed**.
- `local-device-gateway.test.ts`, `instance-bindings.test.ts`, `bash-background.test.ts`,
  `builtin-names.test.ts`, device `client.test.ts`: 5 files, **120/120 passed**.
- None of these covers C1 (freeze with no scan) or I1 (`ifRunning` under an obligation).

## Re-review round 1

Scope: `git diff a69a43c31 2c19aef61` (perm/t8-5), read-only. I checked each fix against the code,
then read the "Fix round 1" section of the author's report.

### Verdict: APPROVE, with one Important design item for the controller (R1-I1) and the `abandoned` treatment (below)

Neither item reopens a reuse hole. Both fail closed. R1-I1 is about availability and honest
operator reporting, so it can be settled by a ruling plus a small follow-up in this same branch
before the freeze is wired. It does not need another full review cycle.

### Confirmed fixed

- **C1:**
  - `freeze()` is now `publishFreeze` (its own `requires_new` transaction, exclusive platform
    lock) followed by `scanUntilStable()` outside the transaction.
  - `hasUnresolved` treats as unresolved any obligation, any revoked-start candidate, and
    (once frozen) any legacy candidate that is not yet a member.
  - `retireIncarnations` starts with `scanUntilStable(5, id)` under the exclusive lease.
  - `killPendingTasks` returns before reading rows once frozen: no SID kill and no `clearKill`.
  - Tested: freeze with no worker, and a late row from an old replica.
- **I1:**
  - Without `exactRef`, `ifRunning` throws `RetirementPendingError` before taking a lease. Under
    the lease, `asShared(..., gated)` re-checks before the fence bump and `killTagged`.
  - Only `onManagedInstance` and the revoke worker's exact stop pass `exactRef: true`.
  - Refused: the legacy poller, TaskStop, TaskOutput, `tasks.service`, `withBrowse`, and the
    managed reconcile start retry.
  - The poller's thrown error is caught by its per-device loop and retried each tick. The task
    ends lost once the incarnation is destroyed. That works, but it logs a warning every tick
    (cosmetic).
  - The `enter` shared path now uses the gated `asShared`.
- **I2/M6:**
  - The provider and generation come from `currentInstance()`, read inside `inSandbox` (the
    launch's shared lease), and are written to `legacy_dispatch_provider/_generation` in the
    admission transaction. The generation is checked by regex and a CHECK constraint.
  - Scan priority: `sandbox_created_at`, then the admitted generation, then `unknown`. The
    provider is `@local`, else the admitted provider, else the instance's provider only when it
    is that incarnation, else `unknown`.
  - Editing 0148 is allowed: it is unapplied and still idempotent.
- **M1:** after `FOR UPDATE`, the reopened obligation uses the freshly read boot.
- **M2:** a hello without a `bootId` calls `clearBoot`.
- **M3:** the `kern.boottime` fallback is removed.
- **M4:** `retire()` records the destroy with the retired row's generation. The `prev_handle`
  retry has no stored generation and still records nothing. An obligation on that incarnation
  stays quarantined. That is acceptable: it fails closed, and it is listed below.
- **M5:** the destroy is bounded by `SWEEP_OP_TIMEOUT_MS` and the job's signal. A timeout counts
  as a failure and the obligation is kept.
- **M7:** detection uses the `RetirementPendingError` subclass.
- **M8:** the scan states the index predicate verbatim, and the index adds `device_id IS NOT
  NULL`.
- **Controller rulings:**
  - `device.replace_required` (503, registered) has en/zh copy. The zh text avoids 企业 and the
    Latin word `agent`.
  - Error precedence: any cloud, `unknown` or failed obligation gives `unavailable`; else a local
    obligation without a boot gives `replace_required`; else `restart_required`. This is
    consistent: `unknown` is no longer treated as local, through `isInternalProvider`.
  - `report().localWithoutBoot` exists.
  - The cutover order is documented in the skill and the report.

### R1-I1 (Important, design): historical cloud rows now key `(unknown, unknown)` and make the device permanently unavailable, with no pre-check
- Location: `legacy-retirement.ts` scan (`legacy_dispatch_generation ?? "unknown"`, provider
  `"unknown"`); the gate's quarantine branch.
- **Scenario:**
  - Every pre-0148 legacy row with a NULL SID that is not `reserved` reads `unknown`. That
    includes every launch that ever failed (`failLaunch` after a provider error or a non-zero
    launch exit).
  - Such a row on a cloud device becomes an `(unknown, unknown)` obligation.
  - `unknown` can never match `destructionRecorded` or `destroyedHere`. The device answers
    `device.unavailable` for good.
  - Its copy says "becomes usable once its provider confirms the old instance destroyed", which
    is false for this case. There is no recovery other than deleting the device.
  - `report().localWithoutBoot` warns about the local equivalent before the freeze, but nothing
    warns about this cloud case.
  - My round-0 I2 suggested this fallback. Its cost on cloud devices is larger than that note
    implied.
- **Honest options for the controller:**
  - **(a) Keep it.** Add a pre-check list `cloudUnknown` (cloud devices with such candidates),
    give this quarantine its own copy ("delete this device and create it again"), and make that
    a cutover step next to `localWithoutBoot`.
  - **(b) Resolve a cloud `unknown` obligation on evidence that covers every incarnation the
    device could have had.** The kernel keeps one instance row per device, and an incarnation
    stops being current only through a kernel destroy (idempotent; "succeeds when it does not
    exist"), a provider `gone`, or a retained `prev_handle`. So `unknown` resolves when all three
    hold:
    - the current incarnation is destroyed and the destroy is confirmed;
    - the row has no `prev_handle`;
    - the obligation was recorded after the freeze.

    The same rule would also clear author concern 2: cloud incarnations replaced before 0148.

  I recommend (b). It is still provider-confirmed evidence; only the bookkeeping that 0148 lacks
  is missing. If the controller rejects it, then (a) as a minimum.

### R1-m1 (Minor, test flake): `local-device-gateway.test.ts` "hello then a relayed exec round-trip"
- In my batch it failed once (`row.mode` null at :588) and passed on rerun (25/25).
- The test reads the hello's record after a relay exec without waiting for `recordHello`. The
  claim, and so `held()`, precede the record. The extra `clearBoot` query widens the window.
- This is the same race the author already fixed in the boot `hello()` helper. Wait on `roots IS
  NOT NULL` here too. AGENTS: fix flakes.

### Open point: obligations of deleted local devices
**Recommended treatment.** Add a fourth state, `abandoned`, distinct from `resolved`. It is never
evidence of termination and is never re-opened by reuse.
- **How a row gets there:**
  - Devices are soft-deleted (`deleted_at`) and hard-deleted through org cascades, and
    obligations have no FKs.
  - So a worker sweep, not the delete path, moves to `abandoned` every unresolved obligation
    whose `devices` row is missing or has `deleted_at` set.
  - It records `abandoned_at` and the last `reason`, and keeps `boot_id` and the members.
  - A cloud device deleted through `destroyDevice` already records its confirmed destroy. The
    sweep should first try `destructionRecorded`, and resolve as `provider-destroyed` when it
    matches. Only the rest is abandoned.
- **Why that is safe:** device ids are never reused, so no kernel path can ever acquire that
  incarnation again. The no-reuse invariant the barrier protects holds.
- **What it does not claim:** that the old processes ended. They may still run on that computer,
  for example after a `replace_required` delete-and-reconnect, per the ruling.
- **Report:**
  - Add `abandoned: number` and `abandonedList` (device, provider, generation, local/cloud,
    `bootKnown`, `abandoned_at`).
  - `retired` becomes frozen, `open == 0`, `quarantined == 0` and unsettled `== 0`, with
    `abandoned` excluded.
  - Add a separate boolean `cleanRetirement = retired && abandoned == 0`.
- **Release gate:** it should pass on `retired`, but require the operator to acknowledge a
  non-zero `abandoned`, shown with the honest text: "N old incarnations were abandoned with their
  devices; legacy processes may still run on those computers; no device can reuse them".
- **Members:** leave the members of abandoned obligations unsettled (`kill_pending` stays as the
  record). Report them in their own count, not in `unsettledMembers`, so they do not block
  `retired`.
- Migration: extend the 0148 state CHECK while it is unapplied.

### Tests (CAPYBARA_TEST_WORKERS=2 CAPYBARA_TEST_CONTAINER_STARTS=2)
- Files: protocol-upgrade, protocol-upgrade.dual, if-running, bash-background,
  local-device-gateway, device boot-id, sandbox-helpers, working-root.
- Result: 124/125. The one failure is R1-m1 above. Rerunning local-device-gateway alone gave
  25/25.
