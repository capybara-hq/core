# Task 8.4 report: process lifetime, cancellations, drain (B1–B4) — PARTIAL

Worktree `.claude/worktrees/perm-t8-4`, branch `perm/t8-4`, base `e6a08b949`. Not pushed, no PR.
All runs used `CAPYBARA_TEST_WORKERS=2 CAPYBARA_TEST_CONTAINER_STARTS=2`, small batches.
Logs: scratchpad `t84/` (`b3-red.log`, `b3-green.log`, `drain-red.log`, `drain-green.log`).

## Commits

| sha | Row | What |
|---|---|---|
| `3069b5d00` | B3 (+8.3 M6, deferred items) | fix(kernel): cancel revoked background tasks by their exact ref |
| `3ef9ae9e5` | lifecycle / drain (device) | feat(device): stage graceful drain over owned work |
| `473486522` | B3 gate | test(kernel): real org writer revokes only the affected background task |

## B3 — durable background revocation (kernel slice landed; B3 NOT complete, see fix round 1)

Changes (`3069b5d00`):
- `sandbox/operation-reconcile.job.ts`: the revoke worker branches on `backgroundStart` with a
  recorded `execution_ref`: exact stop through `BackgroundTaskStopper.stop(task,"revoked")` while
  the task row runs (5 s grace, finish/event through the existing finisher), else exact
  `background.stop` by the **intent's** recorded ref on the recorded generation via `ifRunning`
  (never resumes, never a newer instance, `ManagedInstanceMismatchError` on handle mismatch).
  Acknowledges only `stopped` / `already-exited` / an already-terminal task; `cancel-pending`,
  `lost`, not-running or replaced instance -> owed (`SandboxOperationOutcomeUnknownError` ->
  `deferRevocation`). A start revoked before its ref keeps the exact `revokeOperation`.
  New deps: `BackgroundTaskStore`, `BackgroundTaskStopper`; `MaintenanceModule` imports
  `BackgroundModule`.
- `sandbox/operation-intents.ts` `deferRevocation`: backoff 30 s doubling, cap 1 h (no 30 s spin
  for obligations only retirement can resolve).
- `sandbox/permission-call-grants.ts` `forExecution`: accepts `background-running` for
  `backgroundStart` (retried start of an acknowledged op reuses its recorded starting authority).
- `background/finish.ts` (8.3 M6 consumer): a managed **lost** finish retires a
  `background-running` intent to `revoked` (`outcome_unknown`) and owes
  `sandbox-operation-revoke-<op>` in the same transaction.
- `background/store.ts`: `byOperation`, `settleOwedCancel` (finished cancel-pending -> terminal when
  the exact stop is later established; finish/event untouched).
- Selectors: already used `isExecutionMethod` and `granted_hosts` provenance at platform/org/owner
  level (checked; no change needed). Host-provenance survival is now proven end to end below.

Gates (RED log `t84/b3-red.log`: 5 behavioural failures — `stops` empty / `revokeOperation` used,
intent stayed `background-running`, `forExecution` threw "no current admitted execution identity"):
- two real tasks, owner baseline host removed via the real `publishLocked` + `ownerPolicyRevokes`
  selector after launch-run completion: only the baseline task revoked; worker stops only its ref;
  sibling with an independent host addition keeps `background-running`/`acknowledged`; repeated
  delivery of both revokes stops nothing again.
- pending exact cancellation stays owed (`-1` deferral job), settles on later delivery.
- conversation hard delete (`DELETE FROM capybara.conversations`, cascades the task row): intent
  still owes and the worker stops by the intent ref (8.3 M6 cascade).
- lost supervision via the real poller -> intent revoked + revoke owed; device `lost` keeps it
  owed; later `stopped` acknowledges and settles the record `terminal` (status stays lost).
- retried start of an acknowledged op passes `forExecution`.
- `473486522`: real `OrgSettingsService.update({autoMode:"off"})` after run completion revokes
  only the Full task and owes only its job; worker stops only it (guard; passes on base selectors,
  the exact-stop half needs `3069b5d00`).
- Updated 8.2/8.3 tests whose expectations encoded the old behaviour (revokeOperation after ack;
  lost intent staying `background-running`): managed-launch x3, managed-consumers x3.

Verification: managed-launch 33/33; managed-consumers 38/38; permission-wiring +
permission-call-grants (3 files) 74/74 incl. consumers run; permission-lifetime.dual + poll +
background.http + tools/maintenance 53/53; `pnpm typecheck` clean; `pnpm check` all passed;
Biome clean on touched files; `pnpm test:unit` 129 files / 1457 tests passed (final).

## Lifecycle / drain (device, staged v3; protocol 2 untouched)

Changes (`3ef9ae9e5`):
- `exec/operation-supervisor.ts`: `ownership()` {workers (live + fault owners), cancellations,
  collectors (open spools + in-flight reads), persistence (control writes + dirty controls)};
  `beginDrain()` (process-lifetime, never cleared); `admit` refuses **fresh** admissions with
  `SandboxPermissionUnsupportedError` while retries of admitted ids keep recovering; `settle(signal)`
  waits for ownership to empty (dirty controls retried once per drain, no write loop) and throws
  `DrainPendingError{pending}` on abort. The owner watcher (`onLiveChanged`) now stays on while an
  exact cancellation settles (`notifyOwned`).
- `exec/mac-operation-backend.ts`: `lifecycle {beginDrain, ownership, settle}`.
- `staged-session.ts` (+ re-export in `client.ts`): `state.draining`; running entries carry `done`;
  draining refuses native/prepare/browse/create with typed `unsupported`; exec/backgroundStart go to
  the supervisor; status/read/tail/stop/revoke/policy always served. `drainStagedSession(state,
  backend, signal)` -> `{drained:true}` only after requests and backend ownership settle, else
  `{drained:false,pending:{requests,...ownership}}`; never reused.
- Already true at base and kept: after `worker.ready` a background start's RPC signal is detached
  (finished/cancelled start RPC never kills the task); pre-ack abort -> entry `unknown`.

Gates (RED `t84/drain-red.log`: API absent — `beginDrain`/`drainStagedSession` not functions; the
behaviour has no older equivalent in v3): drain after start RPC ended waits for the acknowledged
task, refuses a fresh start/exec and a browse, serves status and a retry of the admitted id, no
cancel issued; timeout reports `{requests:0,workers:1,collectors:1,...}`, stays draining, stop still
served; repeated cancellation delivery with an unestablishable cancel stays `cancel-pending` (2
attempts). Adjusted "concurrent stops retain the claimed winner" (it used `onLiveChanged(false)` as
"worker removed"; now asserts the watcher stays on while the cancellation is owned and turns off
after). operation-supervisor + staged-session 32/32. mac-operation-backend: 1 failure
"prepares a missing conversation subtree…" = **pre-existing on base** ("Unsupported runtime
bundle", environment), not caused here. tsc/test typecheck clean, `pnpm check` passed.

## Not done (remaining 8.4 scope)

- **B4** entirely: `packages/device/src/exec/runtime-manifest.ts` verifier and
  `packages/device/tools/runtime-manifest.ts` generator; kernel durable per-device generation
  high-water + `awaiting-device` binding record (new migration from **0145**, none written);
  `bindInstance` RPC (device + kernel local coordinator); unbound-hello kernel handling; Machines
  runtime report writer; first-unprobed-Full -> create -> bind consent stability tests.
- **B2** entirely: version-2 local policy `ownerCeiling` + locked conversion, `owner-report.json`
  sequence sidecar, `capybara-device ceiling show|set`, kernel persistence of the authenticated
  report (hello/policy/result/backfill), `PermissionFacts`/browse/preview/admission split of
  `needsFullCeiling` into Full execution vs broad reach, web narrowing-only, device read view.
- **B1** entirely: `devices.fullAccess` config, `devicesFullAccess` deployment setting, org
  `fullAccess`, cloud `ownerCeiling`/`outerNetwork` snapshot, 6c projection v2 via the existing
  publisher, `capybara config migrate-permissions`, SQL migration.
- Lifecycle wiring into production: the CLI/`commands/{start,drain,stop}` and active client are v2;
  the staged drain is dormant until 8.6. Machine stop/revocation cancelling exact owners and
  awaiting settlement in the device process, "stop while output credit starved", "quiet worker with
  another blocked journal", "disconnected owner edit", real sub-agent path for managed tasks
  (deletion path covered by an existing real-writer test) are not yet gated.

## Interface left for 8.5 (M6)

Retirement candidates = `sandbox_operation_intents` with `method='backgroundStart'`,
`state='revoked'`, `revoke_acknowledged=false`, `execution_ref IS NOT NULL` whose recorded
`instance_generation`/provider no longer matches a running `device_instances` row (the revoke worker
defers them forever with 1 h backoff). The intent has no conversation FK, so it survives task-row
cascade; `background_tasks` rows stay `cancel-pending` (pruning keeps them). 8.5's retirement
obligation should consume these (quarantine or provider-confirmed destroy) and then call
`acknowledgeRevocation` + `BackgroundTaskStore.settleOwedCancel`; it must not clear them on a new
generation alone. Ref-less dispatched starts keep the existing `abandonBackgroundLaunch` path.

## Concerns

- A lost finish now changes the intent to `revoked` (was: kept `background-running`). Revocation
  writers therefore no longer select it, which is fine because the exact revoke is already owed;
  reviewers should confirm this reading of "retains an independent pending obligation".
- Device drain RED is API-absence, not a behavioural failure of an earlier implementation.
- No dev stack, credentials or plugins repo used. No SDK API change (no gen:sdk-api needed).
  Changesets: `exact-background-revocation.md` (kernel), `staged-device-graceful-drain.md` (device).

## Fix round 1 (review `task-8-4a-independent-review.md`, CHANGES_REQUIRED)

Commit `b1f7a038c` on top of `473486522`. Logs in scratchpad `t84/`: `fr1-red-drain.log`,
`fr1-red-m1.log`, `fr1-red-i3.log`, `fr1-check.log`.

| Finding | Change | RED -> GREEN |
|---|---|---|
| I1 | `REFUSED_WHILE_DRAINING` keeps only `create`; native/prepare/browse reach the supervisor, whose `admit` refuses only fresh ids. | New staged test: a journalled `writeFile` (answer lost) retried during drain returns ok with no new launch; a fresh write is refused `unsupported` /draining/. RED: the retry got the session-level refusal. The graceful-drain test now checks a fresh write is refused by the supervisor; a fresh browse in this fixture is refused earlier by restricted support, so it was not a drain proof. |
| I2 | `drainStagedSession` loops (requests, then `settle`) until requests and ownership are empty together; pending only when the signal aborts. | New staged test: `backgroundStatus` held in flight while the task finishes and ownership empties; drain stays open, then `drained:true` after the status answers. RED: `{drained:false,pending:{requests:1}}` without timeout. |
| M4 | Supervisor tests per ownership class. | Pending exact cancellation with the worker gone; output read in flight after the task ended (`read` barrier); dirty control persistence (append fault -> failed control write -> retried once by `settle`, held, released). All pass on the existing code (guards; the code already handled them). |
| I3 | Replaced the SQL-edited selector tests in managed-launch with two tests in the worker-role `background/poll.test.ts` (a separate 2-test file tripped `test-small-app-file`). (a) Owner baseline host vs an approved network ask (`approvals` row, kind network, scope once): real admission records `granted_hosts` [] vs [host]; real `MachinesService.recordPolicy({mode:"auto",allowedDomains:[]})` (the v2 owner writer) revokes only the baseline task; `drainOutbox` + the worker's `MaintenanceProcessor` acknowledge it, only that task is stopped (terminal), the granted sibling keeps running. (b) Full with displayed consent (`PermissionFacts.scope` -> `PermissionProfilesService.set`) vs a later restricted task; real `OrgSettingsService.update({autoMode:"off"})` -> only the Full task is revoked and stopped through the worker. | RED with base `operation-reconcile.job.ts` + `maintenance.ts`: the baseline task stayed `running/cancel-pending` (revokeOperation acknowledged, no exact stop). GREEN 2/2. |
| M1 | Invoke-driven race through the real `LocalDeviceProvider.stagedOperations` adapter (fake transport): dispatcher A stalls after its claim; its holder is declared unknown; recovery acknowledges; A is released. | RED without the relaxation: the device received 1 start, not 2 (A got `forbidden` from `forExecution`). Observed: the tool result and task/intent state are identical with and without it (the facade recovers the recorded result), so the relaxation's only effect is that the late dispatcher's idempotent retry reaches the device with its recorded authority. |

**B3 status: still open.** Remaining B3 gates:
- the B2-format owner writer (version-2 owner report / `DevicePolicyService`) and the full
  restricted-only owner change keeping unrelated Full work through it. The v2 `Machines.recordPolicy`
  path is now proven; the B2 path does not exist yet.
- a revocation that crosses disconnect and reconnect against a real device or staged session.
- platform-writer (`permission-config-publication`) end-to-end through the worker (only org and
  owner writers are proven end to end).

M2 (unresolvable obligations retry hourly until 8.5) is a release-gate item for the 8.5 handoff:
unresolved obligations must be reported honestly. M3 (concurrent revoke deliveries overlap safely)
needs no change.

Verification: staged-session 10/10; operation-supervisor 27/27 (drain filter 5/5);
managed-launch + managed-consumers 72/72 (with the old outbox file at the time); poll.test 29/29;
`tsc -b` and the test tsconfig clean; `pnpm check` all passed; Biome clean on touched files.
Pre-existing, environmental and unchanged: device `mac-operation-backend` "prepares a missing
conversation subtree…" and `background-output` "ordinary authorized native Read…" both fail with
"Unsupported runtime bundle". The second was verified failing on base `e6a08b949` in a temporary
detached worktree, which was then removed.
