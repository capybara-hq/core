# Task 8.5 report: legacy retirement and fail-closed reuse barrier — DONE_WITH_CONCERNS

Worktree `.claude/worktrees/perm-t8-5`, branch `perm/t8-5`, base `e2d24c679`. Not pushed, no PR.
Runs used `CAPYBARA_TEST_WORKERS=2 CAPYBARA_TEST_CONTAINER_STARTS=2`, small batches. Logs: scratchpad
`t85/` (`red.log`, `red2.log` gate-off RED, `red3.log` bind/dual RED, `green*.log`, `batch1-5.log`).

## Commit

`22617f83b` feat(kernel): legacy retirement freeze and fail-closed reuse barrier

## What landed (dormant: nothing publishes the freeze in production; protocol 2 untouched)

- **Migration 0148** (`IF NOT EXISTS`, expand-only): `legacy_launch_freeze` (one row, never removed);
  `background_tasks.legacy_dispatch` (`unknown` default — every pre-0148 row and any row of an old
  replica reads "may have dispatched"; new reservations write `reserved`; the freeze check writes
  `dispatched`); `device_retirement_obligations` keyed `(device_id, provider, instance_generation)`
  (`open` / `quarantined` / `resolved`, resolution only `provider-destroyed`); `device_retirement_members`
  (`legacy-task` by task id, `revoked-start` by operation id, `settled`); `device_instance_destructions`
  (provider-confirmed cloud destroys). No FKs to task/instance rows: pruning/cascade cannot remove an
  obligation. Partial indexes for the per-tick scans.
- **`sandbox/legacy-retirement.ts` `LegacyRetirementStore`** (+ `LegacyRetirementModule`, exported by
  `SandboxModule`): `freeze()` under the exclusive platform authority lock (`PermissionAuthorityLock`
  write/platform, the same lock the 6c publisher uses); `admitLegacyDispatch(org, task)` under the
  shared platform lock — refuses once frozen, else marks `dispatched` in the same transaction, so a
  committed freeze has flushed every earlier admission and none passes after; `scan()` /
  `scanUntilStable()`; gate helpers; `report()` for release gates (`retired` only when frozen and
  open = quarantined = unsettled = 0; unresolved rows listed with reason).
- **Enumeration** (only after the freeze for legacy rows): running with SID, running null-SID not
  `reserved`, stopping, `kill_pending` (terminal rows too), failed null-SID not `reserved` (possible
  dispatch). Generation = `sandbox_created_at`, else the live instance's for a null-SID row, else
  `unknown`. Provider `@local` for local devices. Rows untouched: no SID/PID/text becomes a ref.
  Revoked managed starts (8.4 handoff: `backgroundStart`, `revoked`, not acknowledged, ref present,
  recorded provider+generation not the *running* instance — suspended counts) are members too, frozen
  or not.
- **Legacy launch** (`tools/builtins/sandbox/bash.ts`): `admitLegacyDispatch` immediately before the
  launch exec, inside the lease, after the reservation (covers previously reserved rows). Wired in
  `BuiltinTools` (`SandboxToolDeps.legacyLaunch`, optional only for test stubs).
- **Gate** (`SandboxService.retireIncarnations`, called in `ensure` right after the fence bump, before
  the lost-files/provider-switch checks, resume, rebuild, create, `killLeftovers`/`killAll` and the
  downgrade). `enter` never takes the shared path while the device has an unresolved obligation and
  re-checks after taking a shared lease. Per obligation: current incarnation (provider + exact
  generation, status running/suspended/creating) → cloud: whole-instance `destroy` (no resume, no
  `killAll`/`killTagged`, file system kept), record destruction, fenced `destroyed`, resolve, then the
  use creates fresh; local: quarantine. Not current → resolved only by a recorded confirmed destroy of
  exactly it (or the existing destroy path's `destroyed` row of exactly it with no `prev_handle`), else
  quarantine. Every obligation is tried; any left → `device.unavailable` (existing code, no new i18n).
  Failed destroy / provider not loaded → attempts/last_error, obligation stays open.
- `destroyRow` (inactivity, device delete, reset) records confirmed destruction for cloud providers only;
  `recordDestruction` refuses internal providers.
- **`LocalInstanceBindings.bind`** refuses (`InstanceBindingError`) with any unresolved obligation
  before sending anything (the B4 seam).
- **`SandboxService.retireLegacy(deviceId)`**: one `tryExclusive`, same gate → `clear|unavailable|busy`.
- **`background/retire-legacy-tasks.job.ts` `RetireLegacyTasksJob`** (`@LockedInterval` 60 s,
  WorkerModule): scanUntilStable; up to 10 due devices (backoff 30 s doubling, cap 1 h) through
  `retireLegacy`; settles members of resolved obligations (`acknowledgeRevocation` +
  `settleOwedCancel`; legacy rows: `clearKill`). Task finish/event stays with the poller/finisher.
- Skill `writing-sandbox-providers` paragraph; changeset `legacy-retirement-barrier.md` (kernel patch).

## Gates (RED → GREEN)

RED = same tests with the gate, shared-path check, freeze check and bind check neutralized (behavioural):
use resolved instead of `device.unavailable`; suspended case showed `resume` + **`killAll`** instead of
`destroy` + `create`; worker settled nothing; bind sent the RPC; launch marked `reserved` and the
frozen launch started. `test/background/protocol-upgrade.test.ts` (9, integration):
- pre-upgrade SID / null-SID / stopping / kill_pending (terminal) / failed-possibly-dispatched rows
  enumerated only after the freeze; `reserved` and completed rows not; no ref conversion; idempotent
- freeze refuses a reserved dispatch, marks an admitted one
- cloud destroy failure: use, withPreparation and retireLegacy all unavailable, obligation open with
  attempts, only `destroy` tried; then confirmed destroy → fresh instance, same fs handle, recorded
- suspended: `destroy` then `create`, never `resume`/`killAll`
- local: quarantined; reset (local no-op destroy) and a new generation never clear; local
  `recordDestruction` refused
- offline: obligation survives `pruneFinished` of its task row and re-scans; report `retired:false`
- reused handle with changed generation: not destroyed, quarantined; only a recorded destroy of
  exactly the old generation clears it
- 8.4 handoff: stale-generation revoked start stays quarantined/unacknowledged, the destroyed one is
  acknowledged by the worker; worker destroys a cloud incarnation and settles its kill_pending member
`protocol-upgrade.dual.test.ts` (3, container list): worker on replica A + 5 acquisitions on B → old
incarnation destroyed exactly once, never reused, fresh created after; failing destroy keeps both
replicas out; freeze on A fences 12 concurrent admissions on B (members == admitted set).
`bash-background.test.ts` +2 (dispatched mark before exec; reservation made before the freeze refused,
no launch exec, row `failed`/`reserved`). `instance-bindings.test.ts` +1 (bind refused, nothing sent).

## Verification

Focused: protocol-upgrade 9/9, dual 3/3, bash-background 20/20 (incl. 2 new), instance-bindings 20/20,
migrations; sandbox (service, if-running, lifecycle, instance, providers-per-device, limits,
concurrent(+dual), mode-limits, sandbox.dual, permission-wiring) + background (store, poll,
managed-launch, managed-consumers, launch, background.http, poll.dual, permission-lifetime.dual) +
kernel.test, kernel-cli, apps/capybara admin-grant, builtin-names, tools/maintenance: all green
(~400 tests). `pnpm typecheck` clean; `pnpm check` all passed; Biome clean on touched files;
`pnpm test:unit` 132 files / 1476 passed.

## Concerns / not done (honest status)

1. **No drain through a still-owned legacy executor.** The kernel has no exact live ownership of a
   SID task (only the SID, which is not authority), so legacy work is never drained: cloud =
   whole-instance destroy, local = quarantine. A local machine with any legacy row whose processes may
   live on becomes permanently `device.unavailable` after the freeze; no trusted OS-instance-replacement
   evidence producer exists and no operator resolution path was added (would need a design decision).
2. **Cloud incarnations replaced before 8.5 deploy** without a `destroyed` row of exactly them (e.g.
   rebuilt after `gone`, or reset) quarantine their devices too. Conservative by design; release
   gates will show them via `report()`.
3. **Conservative enumeration of failed null-SID rows** (any not `reserved`, incl. ordinary launch
   failures of new code before the freeze, and `launch_abandoned`) — may quarantine/destroy more than
   strictly needed.
4. **Old unfenced replicas** are not detected: the freeze fences only replicas running this code. The
   operator must stop/drain older replicas first (their rows still read `unknown` and are picked up by
   the per-tick re-scan, but their dispatch is not refused). Freeze publication has no CLI/route yet
   (nothing activated); `report()` has no CLI/route surface — both belong to the 8.6 activation runbook.
5. **Not gated:** `ifRunning` (legacy poller, legacy TaskStop SID kill, managed reconcile retry
   start, revoke worker exact stop, staged browse). Legacy SID stop/poll removal stays 8.6.
6. Revoked starts on a merely **suspended** same-generation instance become obligations, so the next
   use destroys that cloud instance (files kept) rather than resuming it (plan: never execute legacy
   work on resume). Managed path is dormant, so no production effect now.
7. A member whose managed task row is still `running`/`cancel-pending` after its incarnation was
   destroyed stays unsettled until the poller finishes the task (retried each tick).
8. The job scans revoked starts every tick even before the freeze (indexed, normally empty).

## Boot-ID evidence (user decision on concern 1)

Commit `2256b2447` feat: boot-ID evidence settles local legacy retirement obligations. Still dormant
(nothing publishes the freeze); device wire stays protocol 2 (the v2 hello gains an optional field).

- **SDK:** optional `DeviceHello.bootId` (shared by the v3 hello), `DEVICE_BOOT_ID_RE`,
  `isDeviceBootId`. A malformed value is dropped by the parser. Ran `gen:sdk-api`; changeset
  `device-boot-identity.md` covers sdk, device and kernel.
- **Device:** `src/boot-id.ts` reads the boot identity once per process. Linux:
  `/proc/sys/kernel/random/boot_id`. macOS: `sysctl -n kern.bootsessionuuid`, else
  `kern.boottime` as `boottime-<sec>.<usec>`. Nothing is sent when unreadable or malformed. It is
  sent on the active v2 hello (`ConnectOptions.bootId` lets tests inject a value or `null`) and the
  staged v3 hello.
- **Kernel, migration 0148 extended (still unapplied, used only by this branch):**
  - `device_machine_boots(machine_id FK, boot_id, seq bigserial, first_seen_at)` and
    `device_machines.boot_id` (the machine's current boot).
  - Obligations gain `boot_machine_id` / `boot_id`; `resolution` gains `host-rebooted`.
- **Recording (`LegacyRetirementStore.recordBoot`):**
  - It is called only from `MachinesService.recordHello`, which the gateway reaches only after
    credential authentication and the device-lease claim, with the machine row locked. A revoked or
    unknown machine is ignored.
  - A boot first seen for the machine becomes its current boot.
  - A boot seen before a later one (stale or replayed) is ignored.
- **Obligation creation:** a local obligation stores the device's active machine and its last
  reported boot (null if none). A new member found on an obligation that was resolved
  `host-rebooted` reopens it against the current boot.
- **Resolution (`settleRebooted`):** a local obligation resolves when the stored machine's current
  boot was first seen after the stored boot (same machine credential only). It runs on every
  recorded new or current boot, and at the start of the gate, so a scan that raced the hello
  still resolves on the next acquisition. A null stored boot never resolves.
- **Errors:**
  - A local device whose remaining obligations can all be cleared by a restart answers
    `device.restart_required` (503, newly registered): "Background work started by an earlier
    version may still be running on this computer. Restart this computer to finish the upgrade,
    then try again." Web en/zh copy is in `errors.device.restart_required`.
  - Otherwise the answer stays `device.unavailable`. That covers an unknown stored boot, where a
    restart cannot help, and cloud cases.
  - `report()` lists `bootKnown` for each unresolved obligation.

**RED** (`t85/boot-red.log`, recording, gate settle and restart error disabled; device bootId
removed from the hello): 4 failures. The client hello had no `bootId`; the obligation stored
`boot_id: null`; the replayed boot was not recorded; an unexpected quarantine timing came from the
worker tick, so the test now accepts open or quarantined for "never resolved".

**GREEN:**
- 3 tests merged into `local-device-gateway.test.ts` (the test-portfolio check forbids a
  3-test app file), over the real gateway WebSocket:
  - later boot of the same machine → resolved `host-rebooted`, `retireLegacy` clear; same boot →
    still unresolved, use answers `device.restart_required`; replayed earlier boot → current boot
    unchanged;
  - no stored boot → never resolves, use answers `device.unavailable`;
  - bogus credential refused with 401; revoked machine: credential refused, late `recordHello` not
    recorded; a new machine credential reporting another boot is no evidence.
- device `boot-id.test.ts` 3 tests; client test +1; SDK `device-protocol.test.ts` +1.

**Verification:**
- gateway, machines and owner-report suites 41/41.
- protocol-upgrade, staged-session and device client 62/62.
- device suite + SDK device-protocol 693 passed, 1 skipped.
- SDK device-protocol 43/43.
- `pnpm typecheck` clean; `pnpm check` all passed; Biome clean.
- `pnpm test:unit` 132 files / 1476 passed.

**Concerns:**
- (Superseded by the ruling below: evidence is the OS instance, not the credential.)
- A device program that never reports `bootId` (older builds) leaves its local obligations
  quarantined for good (`device.unavailable`).
- Authenticity rests on the authenticated machine credential: a compromised device program could
  claim a reboot. This is the same trust level as the owner report.

### Ruling: the evidence is the OS instance, not the credential

Commit `a69a43c31` fix(kernel): boot evidence follows the OS instance, not the machine credential.

- **New rule (`settleRebooted`):** a local obligation resolves (`host-rebooted`) when any current
  (non-revoked) machine of the device has recorded a boot different from the obligation's stored
  boot.
  - A new credential reporting the same boot is the same computer, not restarted: the device stays
    blocked with `device.restart_required`. A re-login after a restart resolves the obligation.
  - Guard: a boot that a machine of the device had already reported by the time the stored boot
    was first seen counts as an older boot, never as evidence. A replay through another credential
    therefore changes nothing.
  - Revoked machines stay ignored. A boot replayed on the same machine still changes nothing (its
    current boot moves only to a boot first seen). An obligation with no stored boot never resolves.
  - `boot_machine_id` is kept as a record only.
- **Tests (in `local-device-gateway.test.ts`):** 4 boot-evidence tests.
  - Kept: later boot resolves, same boot stays blocked, replayed earlier boot ignored; no stored
    boot never resolves.
  - Unauthenticated, revoked and replay test, now with an older boot replayed through the new
    credential.
  - New: re-login with the same boot stays blocked (`device.restart_required`); re-login with a
    different boot resolves and `retireLegacy` returns `clear`.
- **RED:** with the previous same-machine rule, the re-login-after-restart case stayed quarantined
  (`t85/relogin-red.log`).
- **GREEN:** `local-device-gateway.test.ts` + protocol-upgrade 34/34; `pnpm check` all passed;
  `pnpm test:unit` 1476 passed; Biome clean. The skill paragraph and the changeset were updated.
- **Remaining concerns:** concerns 2 and 3 above stand. Also, a re-login on a different computer
  reports a different boot and resolves the obligation by design, even though the old computer may
  still run legacy processes. This is accepted by the ruling.

## Fix round 1 (independent review CHANGES_REQUIRED)

Commit `2c19aef61` fix(kernel): legacy retirement review round 1 (C1, I1, I2, minors).

**RED** (`t85/fr1-red.log`): the round's tests, run against the previous source of the 11 changed
files, gave 11 behavioural failures.
- C1: `hasUnresolved` false with an unenumerated late row.
- I1: legacy `ifRunning` ran on an obligated incarnation.
- I2: no recorded dispatch generation; a historical null-SID row was keyed to the current
  instance.
- M3: the boot-time fallback was used.
- M4: no destruction record after a previous-provider retire.
- Boot cases on the M2 path.
- One cascade in the gateway file.

**GREEN:** protocol-upgrade (12), dual (3), gateway incl. 4 boot tests (25), bash-background (20),
device boot-id (3) and if-running together pass 71/71.

| Finding | Change | Test |
|---|---|---|
| C1 | `freeze()` publishes, then runs `scanUntilStable()` before it returns. `hasUnresolved` counts a not-yet-member candidate (legacy rows once frozen, revoked starts) as unresolved. The gate runs `scanUntilStable(5, device)` under the exclusive lease before reading obligations. Once frozen, `killPendingTasks` returns at once: no SID kill, no `clearKill`. | Freeze with no worker scan: rows exist → members immediately. A late row of an old replica after the freeze → `hasUnresolved` true, use refused, nothing touched, the row becomes a member and keeps `kill_pending`. |
| I1 | `ifRunning` takes `{createdAt, exactRef?}`; without `exactRef` it throws `RetirementPendingError` while the device is unresolved. Affected callers: legacy TaskStop SID, the poller, TaskOutput, `tasks.service` and `withBrowse`. Exact-ref callers (`onManagedInstance`, the revoke worker's exact stop) pass. `asShared(…, gated)` re-checks under the lease before the fence bump and `killTagged`. The managed reconcile *start* retry stays gated. | `ifRunning` on an obligated incarnation is refused with `fn` not run; with `exactRef` it runs. |
| I2/M6 | `admitLegacyDispatch(org, task, {provider, generation})` is read via `currentInstance()` under the launch's shared lease into the new 0148 columns `legacy_dispatch_provider/_generation`. The scan generation is `sandbox_created_at` → admitted generation → `unknown` (never the current instance). Provider: local → `@local`; else the admitted provider; else the instance row's only when it is that incarnation; else `unknown`. `unknown` counts as not local in the error choice. | The bash launch records `dispatched sandbox-fake <current gen>` before exec. A historical null-SID row → `(unknown, unknown)` obligation. An admitted row keys its obligation to the admitted generation. |
| M1 | On reopening a `host-rebooted` obligation, the boot is read after the obligation's `FOR UPDATE`. | (race; not separately tested) |
| M2 | A hello without `bootId` → `clearBoot` (boot_id NULL). | Gateway: a hello without a boot clears it. |
| M3 | macOS uses only `kern.bootsessionuuid`; the `kern.boottime` fallback is removed (SDK doc and changeset updated). | Device test: boot time alone → no `bootId`. |
| M4 | `retire()` records the confirmed destroy with the retired row's generation (the `prev_handle` retry has no generation and records nothing). | A previous provider's incarnation destroyed by inactivity is recorded. |
| M5 | Gate destroy signal: `opSignal` + `SWEEP_OP_TIMEOUT_MS` + the job's signal (`retireLegacy(deviceId, signal)`). A timeout counts as a failure (obligation kept). | (not separately tested) |
| M7 | `RetirementPendingError extends ApiError`; `instanceof` replaces the message-prefix check. | Used by the I1 test. |
| M8 | The scan states the index predicate `(status='running' OR kill_pending OR sid IS NULL)` as its own conjunct; the index adds `device_id IS NOT NULL`. | (no EXPLAIN run) |

**Controller rulings applied:**
- Broad enumeration is kept.
- A local obligation with no stored boot answers `device.replace_required` (503, registered, web
  en/zh copy): "Delete this device and connect the computer again as a new device." A new
  device has a new id, so a deleted device's obligations never block it. They still keep
  `report().retired` false (honest).
- The error is chosen as: any cloud, unknown or failed obligation → `device.unavailable`; else any
  local one with an unknown boot → `device.replace_required`; else `device.restart_required`.
- The suspended-cloud destroy is accepted as fail-closed.

**Cutover order** (also documented in the sandbox skill):
1. Ship the device build that reports `bootId`.
2. Check `LegacyRetirementStore.report().localWithoutBoot`: local devices (not deleted) with legacy
   candidate rows whose active machine has no recorded boot. Wait until it is empty, or accept
   that those devices will answer `device.replace_required`.
3. Publish the freeze. Its own scan runs before it returns.

**8.6 follow-up:** a suspended cloud instance with a revoked managed start should resume under the
exclusive lease, exact-cancel the revoked ref with confirmation, then downgrade. Today it is
destroyed whole (siblings end lost, files kept).

**Other test updates:**
- `if-running`, `sandbox-helpers` and `working-root` stubs now include `currentInstance().provider`.
- The local protocol-upgrade tests now expect `device.replace_required`.
- The 8.4-handoff test: the gate now enumerates the device itself, so the use after the destroy
  is refused before the worker runs.
- The worker test now expects `added: 0`, because the freeze enumerates.
- The gateway boot tests' hello helper now waits on `roots` being written, since the gateway's
  connect-time touch moves `last_seen_at` early.

**Verification:**
- Affected suites (sandbox service/lifecycle/instance/providers/concurrent(+dual),
  managed-launch/consumers, poll, store, tools/sandbox, instance-bindings, machines): 388/390 in
  one loaded batch. Load average was about 60.
  - `poll.test` "stopping a child waiting for approval" failed in that batch and passed on rerun:
    29/29 in `poll.test` + `sandbox-tools` together.
  - `sandbox-tools` failed with timeouts in the batch and passed alone: 31/31.
- `pnpm typecheck` clean; `pnpm check` all passed; Biome clean on touched files.
- `pnpm test:unit`: the first run had 1 failure under load; the rerun passed 132 files / 1476.
- The unit failure in the loaded run was not captured; the rerun was clean.

## Fix round 2 (re-review round 1 rulings)

Commit `971dce894` fix(kernel): legacy retirement re-review round 1 (unknown cloud, abandoned, flake).

**RED** (`t85/fr2-red.log`): the 7 new tests, run against the previous store, gate, job, migration,
schema and errors, all failed.
- The gate answered `device.unavailable`, not `device.recreate_required`.
- The `cloudUnknown` and `abandoned` report fields were undefined.
- `runOnce().abandoned` was undefined.
- A failed destroy left the obligation quarantined instead of open.

**GREEN:**
- protocol-upgrade 19/19.
- dual, gateway (25, incl. R1-m1), bash-background, if-running and instance-bindings green in the
  same run.
- Batch (sandbox service/lifecycle/instance/providers, concurrent.dual, managed-consumers, poll,
  protocol-upgrade.dual, gateway): 175/175.
- `pnpm typecheck` clean; `pnpm check` all passed; Biome clean; `pnpm test:unit` 132 / 1476 passed.

### R1-I1 — options (b) + (a)
- **Resolution (option b).** A cloud obligation whose provider or generation is `unknown`
  resolves (`provider-destroyed`) only when all of these hold:
  1. It was recorded at or after the freeze (`created_at >= frozen_at`).
  2. The device's instance row exists and keeps no `prev_handle`.
  3. The current incarnation is destroyed with confirmation. Either the gate destroys a live one
     whole (running, suspended or creating with a handle) with its own provider, records it and
     fences it `destroyed`, or the row is already `destroyed` with a recorded destruction of
     exactly its generation.
- **Otherwise** it is quarantined with a precise reason:
  - before the freeze;
  - no instance record;
  - an earlier provider's instance may exist;
  - no confirmed destruction of the current one.
- **Answer.** The device answers `device.recreate_required` (503, registered; en/zh copy: "...can
  no longer be verified as destroyed. Delete this device and create it again.").
  - The same copy now covers every non-current cloud incarnation without a recorded destruction
    (replaced, or a reused handle with a new generation): nothing promises that destruction will
    clear those.
  - `device.unavailable` (whose copy promises a retry) is kept only for a destroy that failed or a
    provider that is not loaded; the obligation stays `open`.
  - Precedence: failed → `unavailable`; then cloud-permanent → `recreate_required`; then
    `replace_required`; then `restart_required`.
- **Pre-check (option a).** `report().cloudUnknown` lists `{deviceId, prevHandle, noInstance}`:
  cloud devices (not deleted) with legacy candidate rows whose key would be `unknown`. Devices with
  `prevHandle` or `noInstance` will need recreating.
- **Tests:**
  - resolve: a live instance is destroyed then a fresh one created, with the destruction recorded;
  - `prev_handle` → `recreate_required`, nothing destroyed;
  - recorded before the freeze (a revoked start with an unreadable generation) →
    `recreate_required`;
  - no instance record → `retireLegacy` returns unavailable, use answers `recreate_required`;
  - failed destroy → `device.unavailable`, obligation stays open.
- **Existing tests updated:**
  - The late old-replica row (provider unknown) is now retired by destroying the current
    incarnation before use; its member and kill mark are kept.
  - The reused-handle and stale revoked-start cases now expect `recreate_required`.

### Deleted devices: `abandoned`
- **Schema (0148, still unapplied):** state CHECK adds `abandoned`; new column `abandoned_at`, with
  CHECK `(state = 'abandoned') = (abandoned_at IS NOT NULL)`; the partial index is now
  `state IN ('open','quarantined')`.
  - Every unresolved filter in the store now reads `state IN ('open','quarantined')`, so an
    abandoned obligation is never quarantined, resolved by boot, re-tried or reopened.
- **Sweep.** Each worker tick, `LegacyRetirementStore.abandonDeleted()` handles every unresolved
  obligation whose device row is missing or has `deleted_at` set.
  - With a recorded confirmed destruction of exactly its incarnation, it resolves
    `provider-destroyed`.
  - Otherwise it becomes `abandoned`, keeping its boot, reason and members.
  - Its members stay unsettled, and `kill_pending` stays as the record.
- **Report.**
  - `abandoned` and `abandonedMembers` are counted separately; `unsettledMembers` counts only
    resolved obligations.
  - `abandonedList` gives device, provider, generation, local, `bootKnown` and `abandonedAt`.
  - `retired` excludes abandoned obligations; `cleanRetirement = retired && abandoned == 0`.
- **Release gate.** It passes on `retired`. When `abandoned > 0` it requires an explicit operator
  acknowledgement of: "N old incarnations were abandoned with their devices; legacy processes may
  still run on those computers; no device can reuse them". This is documented in the sandbox skill.
- **Tests:**
  - A deleted local device is abandoned: kill mark kept, `retired` true, `cleanRetirement` false,
    `abandonedMembers` 1, `unsettledMembers` 0, and a second tick changes nothing.
  - A deleted cloud device after `destroyDevice` (destruction recorded) resolves
    `provider-destroyed`, and `cleanRetirement` is true.

### R1-m1
The gateway test "hello then a relayed exec round-trip" now waits for the hello's record
(`roots IS NOT NULL`) before reading `mode`. The lease claim, and so `held()`, comes before
`recordHello`.

### Cutover order (updated, also in the skill)
1. Ship the boot-reporting device build.
2. Wait until `report().localWithoutBoot` and `report().cloudUnknown` are empty, or accepted
   (accepted devices will answer `replace_required` / `recreate_required`).
3. Publish the freeze, which scans before it returns.
4. Gate the release on `retired`, with the operator acknowledgement above when `abandoned > 0`.

### Remaining concerns
- **No instance row.** A cloud device whose instance row is missing (for example reset before
  activation) cannot resolve an `unknown` obligation even when its last incarnation was destroyed
  with confirmation, because the record cannot be tied to it. It answers `recreate_required` and is
  listed in `cloudUnknown` with `noInstance`.
- **Provider `gone` counts as evidence.** The (b) rule accepts an incarnation that became
  non-current through a provider `gone` answer, per the reviewer's reasoning; that transition is
  not separately recorded.
