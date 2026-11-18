# Task 8.2 report: durable launch identity and genuinely authorized artifacts

Status: DONE_WITH_CONCERNS. Commit `6429c8099` on `perm/t8-2` (worktree
`/Users/grant/Capybara/core/.claude/worktrees/perm-t8-2`, based on `a5185eb77`). Not pushed, no PR.
Nothing is activated: the protocol-2 SID launch stays the Bash tool's active background path. The
managed path is the exported, dormant `runInBackgroundManaged` (bash.ts) on the operation facade.

## What was built

- **Migration `0143_background_launch_identity.sql`** (plain SQL, `IF [NOT] EXISTS`, no edits to
  0001–0142):
  - Intents: the state CHECK gains `background-running`. New `execution_ref jsonb` column. Its
    CHECK allows a ref only on `backgroundStart` and requires it in `background-running`.
  - `background_tasks`: new `launch_state` column, default `legacy`, with states
    `legacy|pending|dispatched|acknowledged|cancel-pending|terminal`.
  - Reservation columns: `operation_id`, `input_digest`, `run_execution_id`, `task_tag`,
    `instance_id`, `instance_provider[_version]`, `instance_generation`, `profile_revision`,
    `ceiling_revision`, `permission_grant_id`, `network_authority`, `working_root`,
    `retain_until`, `execution_ref`, `cancel_requested_at`.
  - CHECKs: a managed reservation requires `operation_id`, `working_root`, `retain_until` and an
    absolute `output_path`. Every dispatched-or-later state requires all identity fields. A ref
    only from `acknowledged` on, and `acknowledged` requires one.
  - Unique indexes on `operation_id` and on `(run_id, call_id)` for managed rows.
  - `db/kernel-schema.ts` is updated to match.
- **Reservation** (`BackgroundTaskStore.reserveManaged`):
  - Runs under the existing root launch XactLock and `maxTasks` count, inside the held session.
  - Persists the task id, the stable operation id (`operationIdFor(run, call, 0)`), the working
    root, the absolute artifact path, the deadline and `retain_until`.
  - A retry of the same run call gets its persisted row back unchanged, so the start input and its
    hash stay stable and no second slot is taken.
- **Dispatch binding** (`SandboxOperationIntents.claimDispatch` → `bindBackgroundDispatch`):
  - In the same transaction as admitted→dispatching, a conditional UPDATE binds the reservation's
    identity fields from the intent and scope: input hash, run claim, task tag, instance and
    generation, revisions, grant id and network authority.
  - It only binds a row that is `pending`, running, not claimed by a live stop, and whose
    working root, artifact and retention match the start input.
  - On a mismatch nothing dispatches: the intent is revoked (`outcome_unknown=false`), and a row a
    stop had claimed settles as `stopped`.
- **Acknowledgement** (`acknowledgeBackground`):
  - Takes the authority XactLock first, then intent `FOR UPDATE`, then task `FOR UPDATE`.
  - Validates the typed ref: `parseSandboxExecutionRef`, plus matching operation id, generation
    and handle id; it rejects a ref that conflicts with one already recorded.
  - Normal case: intent → `background-running` with the ref, task → `acknowledged`. It never
    calls foreground `complete` and does not require the launching run to be running.
  - If a writer revoked the intent first, or a stop claimed the task: the ref is attached, the
    intent stays revoked, the task becomes `cancel-pending`, and an exact `sandbox-operation-revoke`
    is enqueued through the outbox.
  - `complete()` refuses a successful backgroundStart. A typed pre-effect `$failure`
    terminal-fails the dispatched task in the same transaction.
- **Facade** (`held-operations.ts`, `sandbox.service.ts` runAs):
  - `backgroundStart` is offered only when the provider has `background` and the support report
    says `background: true`.
  - `assertManagedArtifactAdmitted` runs before the provider is called.
  - A recorded `background-running` intent returns its ref without dispatching again.
  - An ack failure leaves the outcome unknown under the same identity.
- **Recovery** (`SandboxOperationReconcileJob.recoverBackground`):
  - Takes a task-specific durable claim (`execution_id = recovery-<uuid>`), never a run's or a
    holder's token.
  - Replays the recorded scope and recorded input through `ifRunning` on the exact recorded
    generation only (no resume, no other instance), then acknowledges.
  - Any failure defers a new deterministic reconcile attempt while `retain_until` holds.
- **Artifact** (`launch.ts`): the path is `${workingRoot}/.capybara/tasks/${taskId}.out` from the
  trusted session working root. Before any effect it must be:
  - a normalized absolute path in the exact placement;
  - free of any `.git` component;
  - inside a scoped write root (the device scope used by Full access is allowed);
  - with a valid retention deadline.

  Otherwise it is a `SandboxScopeDeniedError`: no fallback, no added root or grant. The output
  path appears in model text only after acknowledgement.
- **Store guards**:
  - `failAbandonedLaunches` only settles `legacy` and managed `pending` rows, never dispatched
    ones.
  - `markStarted` and `failLaunch` only touch `legacy` rows.
  - `failManagedPreEffect` only settles `pending` rows; a null ref is never treated as proof that
    nothing launched.
- **Ceiling writes** (`permission-ceiling-writes.ts`): `publishLocked` also selects
  `background-running` at the platform, org and device levels and marks such a task
  `cancel-pending`. At the root (profile-only) level it does not, so a profile change leaves
  started tasks' starting authority alone.

## Gates: RED/GREEN

All gate tests are in `packages/kernel/test/background/managed-launch.test.ts` (integration, 15
tests). They run through the real Bash managed branch, `SandboxService` held operations, intents,
outbox and store, with a provider that owns executions by exact operation id.

**RED was not written first.** I implemented before writing the tests. To get real RED evidence
afterwards, I weakened the guard behind each gate (13 mutations; script kept in the scratchpad
`red/run.sh`). Every mutation made its gate test fail. Every mutation was then reverted, and all
tests are GREEN on the committed tree.

| Gate | Test | RED mutation (failed) | GREEN |
|---|---|---|---|
| Lost start ack → one launch, same files/ref | "a lost start acknowledgement launches once…" | reserve ignores the persisted call row (fails on the unique operation index) | ✓ |
| Recovery after the launching run ended | "recovers a lost acknowledgement after the launching run ended" | reconcile marks unknown instead of recovering | ✓ |
| Unreachable instance stays uncertain | "an unreachable instance keeps the uncertainty durable…" | — (exercises the deferral) | ✓ |
| Same operation, changed input rejects | "the same operation with changed input…" (tool level and facade level) | command-change check removed | ✓ |
| Stale invocation | "a stale invocation launches nothing…" | pre-effect settle skipped | ✓ |
| Cancellation race: stop before dispatch | "a stop claimed before dispatch…" | stop-claim condition dropped from the binding | ✓ |
| Cancellation race: stop during start | "a stop claimed during an in-flight start…" | stop-claim check in ack disabled | ✓ |
| Pre-ack owner narrowing | "owner narrowing before the acknowledgement…" (also the real revoke job → `revokeOperation`) | revoked intent treated as live | ✓ |
| Post-ack: profile-only vs. owner narrowing | "acknowledged authority survives a profile-only change…" | root level also revokes | ✓ |
| Reservation cap | "the reservation cap refuses…; a retry takes no second slot" | count check removed | ✓ |
| Max task duration | "clamps the task to the background maximum duration…" | clamp removed | ✓ |
| Project outside the workspace; workspace and tmp not writable | "places the artifact under a project outside the workspace…" (scope `writeRoots == [project]`, no `/work` or `/tmp` anywhere in the start) | reservation uses the workspace instead of the working root | ✓ |
| Denied or swapped artifact parents → zero launches | "a denied or swapped artifact parent launches nothing…" (no grants, a single intent, unchanged scope) | dispatched-task terminal failure removed | ✓ |
| No abandoned-sweep of dispatched launches | "an abandoned pending reservation fails, but a dispatched launch is never failed" | launch_state filter removed | ✓ |
| Full reservation persisted before dispatch | "persists the full reservation before dispatch…" | — | ✓ |

Kernel-side artifact admission has its own pure unit test,
`test/background/managed-artifact.test.ts` (4 tests, added to `unit-tests.json`). It covers paths
outside the write roots (including a shared-prefix sibling), a caller-chosen path,
non-normalized roots, `.git`, retention, and the device scope.

## Commands and counts (from the worktree root, `CAPYBARA_TEST_WORKERS=4`)

- `pnpm exec vitest run packages/kernel/test/background packages/kernel/test/sandbox/permission-wiring.test.ts packages/kernel/test/tools/permission-policy.test.ts packages/kernel/test/sandbox/operation-scopes.dual.test.ts`:
  14 files, 175/175 passed.
- `pnpm exec vitest run packages/kernel/test/background/poll.dual.test.ts packages/kernel/test/sandbox/operation-scopes.dual.test.ts`:
  8/8 passed.
- `pnpm test:unit`: 127 files, 1388/1388 passed.
- `pnpm typecheck`: clean.
- `pnpm check`: all checks passed, including migrations, outbox registry, test portfolio and
  kernel conventions.
- `pnpm check:applied-migrations --base a5185eb77`: passed.
- Biome on all touched files: 0 errors, 0 warnings.

Adjusted existing tests: `store.test.ts` (the round-trip includes the new legacy fields) and
`permission-wiring.test.ts` (the reconcile job constructor takes `SandboxService`).

## Files

`.changeset/durable-background-launch-identity.md` (kernel patch); `packages/kernel/src/`:
`migrations/0143_background_launch_identity.sql`, `db/kernel-schema.ts`, `background/launch.ts`,
`background/store.ts`, `sandbox/held-operations.ts`, `sandbox/operation-intents.ts`,
`sandbox/operation-reconcile.job.ts`, `sandbox/permission-ceiling-writes.ts`,
`sandbox/sandbox.service.ts`, `tools/builtins/sandbox/bash.ts`, `tools/builtins/sandbox/common.ts`;
tests listed above.

## Limitations, concerns and deferrals

1. **RED ordering.** RED came from post-hoc mutation, not from writing the tests first (see above).
2. **Cancel-pending is never settled to terminal (→ 8.3/8.4).** The existing revoke worker calls
   `revokeOperation(op id)`. The spec's background branch, an exact `background.stop` with
   grace/pending outcomes, plus the `stopped` finish event, belong to the 8.4 revoke worker and the
   8.3 stop/finish consumers. `cancel-pending` tasks stay `running`, so they keep counting against
   `maxTasks`, which is conservative.
3. **The existing poller and stop paths do not track managed rows (→ 8.3).** They use the SID:
   they skip managed rows (`sid` null) and a stop only claims them. Exact-ref status, read and stop
   for acknowledged tasks, and retention pruning that keeps uncertain records (dispatched or
   cancel-pending rows stay `running`, so they are not pruned today) are 8.3.
4. **Org/platform selectors only on the existing generic paths (→ 8.4).** `background-running`
   joins the `publishLocked` selection only at platform, org and device level. Host-provenance-aware
   selectors, independent host additions surviving baseline removal, and real writer→outbox→device
   proof belong to 8.4. Deletion and sub-agent cleanup of managed tasks are also 8.4.
5. **No dual-replica race test.** The recovery claim vs. the in-call retry, and ack vs.
   publishLocked, are serialized by the authority XactLock and intent/task row locks, and are tested
   in-process only. A container test of the cross-replica recovery race is recommended in the
   8.3/8.4 dual suite.
6. **Recovery may pre-empt a slow dispatcher.** Recovery claims a `dispatching` intent only once
   its deadline has passed. A dispatcher still in flight then fails its ack with an unknown
   outcome, and recovery acknowledges the same ref; there is still exactly one launch.
   Recovery retries every 30 s with no attempt cap, only until `retain_until` (bounded retries are
   8.5's concern).
7. **Spool helper not exercised (8.1 dependency).** Device-side exclusive/no-follow artifact
   creation is the accepted 8.1 spool helper. The kernel tests model a provider denial for a
   swapped parent and check zero launches; they do not run the device helper.
8. **Managed task id is random.** A pruned task row means a retry of the same call gets a new id;
   its changed input hash is then refused by the intent identity check (no relaunch), but the
   retry gets an error rather than the original task.
9. **Not touched.** No 8.3/8.4 surface needed widening. Protocol stays v2, nothing is activated,
   and there was no dev stack, no credentials and no plugins-repo change.

## Fix round 1 (independent review CHANGES_REQUIRED)

This round followed RED first. I wrote the 11 new or changed tests before touching any source and
ran them against `6429c8099`. All 11 failed for the intended reason (log kept in the scratchpad at
`red/round1-red.log`), and all are GREEN after the fixes. I then confirmed the three key guards by
mutation: removing any one of them turns its test RED again.
- The preflight assert in `held-operations.ts` → the facade refusal test fails.
- Putting back the exclusion of acknowledged tasks from the revoking set → the deletion test fails.
- The recovery checks in the reconcile job → the "recovery never starts outside its roots" test
  fails.

### I1. Deletion revokes acknowledged tasks
- `publishLocked` now selects `background-running` at every level; the root-level exclusion is
  gone. Profile changes still do not revoke, because their writer only bumps the root epoch and
  never calls `publishLocked`.
- I removed the synthetic `narrow(root)` test. It is replaced by two tests through the real
  writers:
  - `ConversationsService.remove` revokes the acknowledged task's intent, the task becomes
    cancel-pending, and the exact revoke is owed and reaches `revokeOperation`.
  - `PermissionProfilesService.set` leaves the intent `background-running`, including after the
    launching run has completed.

### I2. Artifact and runtime checks before any dispatch state, and in recovery
- `OperationDispatch` gained a `preflight` step. `runAs` runs it after admission and **before**
  `claimDispatch`. For a managed start it is `checkManagedStart`: the artifact check
  (`assertManagedArtifactAdmitted`) plus `assertPermissionSupport`.
- A typed refusal there is recorded as a pre-effect failure (`refusePreDispatch`). The intent
  becomes `completed` with the `$failure`, the reservation becomes `failed/terminal`, and no
  dispatch state is ever written.
- Recovery runs the same `checkManagedStart` before `background.start`.
- New facade-level test, with only the project root writable (neither `/work` nor `/tmp`): zero
  provider calls, the task is never bound (`run_execution_id` null), the intent is completed, and
  no grant is added.

### I3. Recovery only takes over starts its dispatcher gave up on
- `claimBackgroundRecovery` takes only `started-or-unknown` rows. A `dispatching` row (live
  holder, or one not yet proven dead) is only checked again later.
- If the task was claimed by a stop, or is no longer a running dispatched task, recovery never
  starts it. The intent is revoked with `outcome_unknown=true`, the exact revoke (operation
  tombstone) is owed, and the task becomes cancel-pending.
- Before starting, recovery also checks that the current provider name and version match the
  recorded ones (M3).
- The test provider's dedupe is now concurrency-safe: a second start of an in-flight operation
  joins the first instead of launching again.
- New race tests, using barriers and real PG locks, no sleeps:
  - Reconcile fires while the first start is blocked in the provider: exactly one start call, one
    launch, and the tool reports success with no false "unconfirmed".
  - Stop claimed before the ref, then reconcile: no new start, revoke owed, and the revoke reaches
    `revokeOperation`.

### I4. Bounded recovery and a terminal state at expiry
- **Backoff.** Retries back off from 30 s, doubling up to 1 h, and never run past `retain_until`.
- **Typed refusals:**
  - From the provider during recovery: settled as a pre-effect failure (`settleBackgroundRefusal`;
    the provider owns the identity, so a launched operation would have returned its ref).
  - From the kernel checks during recovery: these cannot prove the first dispatch had no effect,
    so the task is abandoned (`lost/launch_unknown`) with the revoke owed.
- **At intent retention expiry** (`abandonBackgroundLaunch`): a task with no ref becomes
  `lost` / `terminal` / `launch_unknown`, which frees its `maxTasks` slot. The intent is revoked
  with `outcome_unknown=true` and the revoke stays owed. A reservation that never dispatched
  settles as a pre-effect failure instead.
- Tests: refusal settles as failure with no further recovery job; backoff delays are ≥30 s then
  ≥60 s, with a changed provider version leading to no start; expiry frees the slot
  (`countRunning` is 0) and the owed revoke runs.

### Minor findings
- **M1.** `failManagedPreEffect` now settles a reservation only when the failing claim is still
  the run's current execution. A stale replica leaves the reservation `pending`, and the current
  claim's retry launches once from it (the test was rewritten for this).
- **M2.** Attaching a ref to an already-revoked intent resets `revoke_acknowledged=false`, so the
  exact revoke runs again (new test).
- **M3.** Provider name and version check in recovery (see I3).
- **M4.** The `.git` check is case-insensitive (unit test with `.GIT`).
- **M5.** `operation-intents.ts` imports the one exported `STOP_CLAIM_TTL_MS` from
  `background/store.ts`; the duplicate constant is gone.

### M6. Carried forward to 8.3/8.4, not fixed here
- The revoke worker still calls `revokeOperation`, not an exact `background.stop` branch (8.4).
- `BackgroundTaskStopper` claims managed rows that have no SID and returns without stopping them
  (8.3).
- `tasks.service.readLive` reports acknowledged managed rows as "starting" (8.3).
- Nothing moves a `cancel-pending` task that has a ref to a terminal state (8.3/8.4). Without a
  ref, retention expiry now settles it.
- The `PermissionCallGrants` admitted-grant lookup excludes `background-running` (8.4 selectors).

Fix round 1 commit: `72395058d` (on top of `6429c8099`). Verification: background + operation-scopes.dual +
permission-wiring/policy + operation-authority/scopes/authority-lock/call-grants: 18 files, 209/209; managed-launch 24/24 +
managed-artifact 4/4; `pnpm test:unit` 1388/1388; `pnpm typecheck` clean; `pnpm check` all passed;
`check:applied-migrations --base a5185eb77` passed; Biome clean on touched files (0 new warnings). Migration 0143 unchanged in
this round.
