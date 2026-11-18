# Task 8.2 independent review — durable launch identity and genuinely authorized artifacts

Reviewer: independent (read-only). Checkout `/Users/grant/Capybara/core/.claude/worktrees/perm-t8-2`
(branch `perm/t8-2`), range `a5185eb77..6429c8099` (one commit, 17 files, +1985/−22).
Judged from code against AGENTS.md, writing-kernel-api / writing-migrations / writing-sandbox-providers /
writing-tools, plan Phase 8.2 + B3 row, design §"Artifact location decision" and §B3.

## Verdict: CHANGES_REQUIRED

The core happy-path machinery is sound: the reservation is persisted under the launch xact lock before
dispatch; the dispatch binding is a conditional PG transition inside the same `claimDispatch`
transaction that moves the intent to `dispatching`; acknowledgement writes intent + task atomically
under the admit lock with consistent intent→task row-lock order; a revoked intent is never
resurrected; retries reuse the persisted reservation and the stable operation id/input hash; the
migration is expand-only and correct; protocol 2 remains active and the managed branch is unwired.
No double launch is possible *from the kernel alone* under the SDK idempotency contract.

However, four defects sit squarely in this phase's trust/persistence scope (revocation selection,
recovery bypassing the artifact gate, recovery racing a live dispatcher / ignoring stops, and
unbounded-then-stuck uncertainty), and one key gate is not actually pinned by any test.

## Findings

### Critical

None.

### Important

**I1. Root-level exclusion of `background-running` removes conversation-deletion revocation, not a
"profile-only" change.** `packages/kernel/src/sandbox/permission-ceiling-writes.ts:114` excludes
`background-running` whenever `level === "root"`. The only real root-level *revoking* writer is
`ConversationsService.markDeleted` (`conversations/conversations.service.ts:872-876`, predicate
`conversationId === rootId || intent.conversation_id === conversationId`); the other root caller
(`devices/conversation-devices.ts:326`) passes `revoke=false`. Conversation profile changes do not
call `publishLocked` at all — they bump the root epoch directly
(`conversations/permission-profiles.service.ts:172`), which only stales pending admissions.
Failure scenario (once activated): user deletes a conversation tree with an acknowledged managed task;
the intent stays `background-running`, no revoke job is owed, `BackgroundTaskStopper.stop`
(`background/stop.ts:98`) returns immediately for a `sid`-less row, and the eventual hard delete
cascades the `background_tasks` row (0070 `ON DELETE CASCADE`), leaving live device authority with no
kernel row to stop it. This contradicts design §B3 ("Explicit sub-agent/deletion policies retain their
intended task selection"). The test "acknowledged authority survives a profile-only change"
(`test/background/managed-launch.test.ts:710`) uses a synthetic `publishLocked(root, revoke=true)` that
no production profile writer performs, so it pins the wrong behaviour.
Fix: drop the level-based exclusion (or make it an explicit caller opt-out flag that no current caller
sets); keep profile changes non-revoking by virtue of their writer. Replace the synthetic test with the
real writers: a real profile change leaves `background-running` live; real `ConversationsService.remove`
revokes it and owes the exact cancellation.

**I2. Lost-ack recovery dispatches without the kernel artifact gate (and without the support gate).**
`packages/kernel/src/sandbox/operation-reconcile.job.ts:56-66` calls `p.background.start(h, scope, input)`
directly on the raw tagged provider. `assertManagedArtifactAdmitted` runs only inside the held closure
(`sandbox/held-operations.ts:152`), *after* `claimDispatch` has committed `dispatching`/`dispatched`
and after `permissionSupport`. Failure scenario: the dispatcher is aborted or its process dies between
the `claimDispatch` commit and the assert (lease loss / run cancel → abort → non-typed error →
`unknown()` → `started-or-unknown`). The reconcile job at the admission deadline then sends a start whose
artifact was never checked against the recorded write roots and whose `support.background` /
profile support was never verified. Only the provider's own "validate outputPath inside the scope"
stands between this and an artifact outside admitted write roots.
Fix: in `recoverBackground` run `assertManagedArtifactAdmitted(scope, input)` and the same
`permissionSupport` checks as `createHeldOperations` before `background.start`; on a typed pre-effect
refusal settle via `complete($failure)` (see I4). Better: move the artifact assert ahead of
`claimDispatch` (it depends only on the recorded scope and input), so no dispatch state is written for a
start the kernel itself would refuse.

**I3. Recovery races a live dispatcher and ignores stop claims.** The first reconcile job is enqueued at
`admit` with `runAt: r.deadline` (`operation-intents.ts:459-466`), and the deadline is at most 30 s after
`pending` (`tools/builtins/sandbox/common.ts:749`). `claimBackgroundRecovery` (`operation-intents.ts:~707`)
accepts `state IN ('dispatching','started-or-unknown')` without any evidence that the dispatching holder
is gone, steals `execution_id`, and re-sends `background.start`.
Failure scenarios: (a) a start that is merely slow (>~30 s on a congested or reconnecting device) is
re-dispatched concurrently by the maintenance worker; the original dispatcher's acknowledgement is then
rejected (`live` false, `operation-intents.ts:~657`) and the model is told the start was unconfirmed
while it is in fact running. Safety now rests entirely on the device deduplicating two *concurrent*
in-flight starts of one operation id — a stronger property than the SDK's "retries return the same
reference", and one the test fake does not have (its `start` awaits `beforeEffect` between the
`launched.get` check and `launched.set`, so concurrent starts would launch twice). (b) A TaskStop claimed
on a `dispatched` row (stop before ref) does not stop recovery: recovery launches the command (if the
original never reached the device) and only then turns it into `cancel-pending` — a launch after the stop.
Fix: recover only rows the dispatcher itself moved to `started-or-unknown`, or `dispatching` rows whose
holder lease token is provably dead (as `revokeHolders` does); before re-dispatch, check the task row —
if stop-claimed / not `dispatched`, revoke the intent (`revoked`, `outcome_unknown=true`) and owe the
exact `revokeOperation` (tombstone) instead of starting. Add a test where reconcile fires while the first
start is blocked in the provider, with a fake whose dedupe is concurrency-safe, asserting one launch and
no false "unconfirmed" report; and a stop-before-ref + reconcile test asserting zero starts and an owed
revoke.

**I4. Unbounded fixed-cadence retry ends in a permanently stuck `running` task.** `recoverBackground`
swallows every error (`operation-reconcile.job.ts:81`) and `deferBackgroundRecovery`
(`operation-intents.ts:~733-751`) re-enqueues every 30 s with no backoff until the intent's
`retain_until` (admission deadline + 1 day ⇒ ~2,900 attempts, each taking a shared lease / RPC when the
device is up). Even a typed pre-effect refusal from the provider is retried the whole day. After
`retain_until`, `claimBackgroundRecovery` returns null and nothing settles anything: the task row stays
`status='running'`, `launch_state='dispatched'` forever (`failAbandonedLaunches` excludes it,
`store.ts:~378`), still counted by `countRunning` (`store.ts:497`). After `maxTasks` such outcomes the
root conversation can never launch a background task again, and the UI shows phantom running tasks.
Is the unbounded retry acceptable? A bounded-by-retention retry is acceptable in principle; a fixed 30 s
cadence with no terminal state is not.
Fix: exponential backoff with a cap; settle a typed provider refusal as pre-effect failure
(`complete($failure)` → task `failed/terminal`); at retention expiry move the task to a terminal
`lost`-style status (`launch_unknown`) *and* revoke the intent with `outcome_unknown=true` so an exact
`revokeOperation` tombstone stays owed (the uncertainty obligation must survive, the slot must not).
Test: expiry path frees the slot and leaves an owed revoke.

### Minor

**M1. A stale replica can fail the current replica's reservation.** `runInBackgroundManaged`
(`tools/builtins/sandbox/bash.ts:534`) calls `failManagedPreEffect(task.id, …)` on any start error while the
row is `pending`, including a stale-claim denial. With two executions of the same call (old claim on A,
reclaimed on B), A's stale denial can settle the shared `pending` reservation before B binds, so B reports
"not started". Safe (zero launches) but a spurious failure of the legitimate retry. Fix: record the
reserving `execution_id` and settle only when it matches the failing invocation's claim, or let only the
current claim settle.

**M2. `-ack` revoke is a no-op once revocation was acknowledged.** The revoked branch of
`acknowledgeBackground` enqueues `sandbox-operation-revoke-<id>-ack` but leaves `revoke_acknowledged`
untouched; `revokeOnce` returns early when it is true (`operation-reconcile.job.ts:94`). Safe given the
SDK tombstone contract (`revokeOperation` tombstones before cancelling owned work), but the kernel never
records cancellation evidence for the attached ref and the task stays `cancel-pending` forever. Either
reset `revoke_acknowledged=false` when attaching a ref, or document that the 8.3/8.4 consumer owns
settling `cancel-pending`.

**M3. Recovery does not compare the current provider name/version with the recorded intent.**
`ifRunning` only matches `created_at`; add `provider`/`provider_version` equality with
`claimed.provider`/`claimed.provider_version` before calling `start`.

**M4. `.git` check is case-sensitive** (`background/launch.ts:234`). A `.GIT` component passes on
case-insensitive macOS file systems. Working roots come from the trusted resolver, so low risk; compare
case-insensitively.

**M5. `STOP_CLAIM_TTL_MS` is duplicated** (`operation-intents.ts:~194`) from the background store's claim
TTL; export one constant to avoid drift.

**M6. Carry-forward (not 8.2 defects, record them for 8.3/8.4):** the revoke worker still uses
`revokeOperation`, not an exact `background.stop` branch (design §B3); `BackgroundTaskStopper` claims and
returns for `sid`-less managed rows without stopping them; `tasks.service.readLive` reports managed
acknowledged rows as "starting"; nothing transitions `cancel-pending` to terminal;
`PermissionCallGrants` admitted-grant lookup (`permission-call-grants.ts:355`) excludes
`background-running`.

## Requested checks

| Item | Result |
|---|---|
| Launch twice (lost ack + retry on another replica) | Retry goes through `claimReconciliation` with a new claim, same id/hash; single launch relies on SDK idempotency. OK. |
| Launch after revocation / narrowing | Revoked intent blocks `claimBackgroundRecovery` and `admit`; a revoke racing ack yields `cancel-pending` + owed revoke, never `background-running`. OK. Launch after **stop** via recovery: I3. |
| Recovery racing a slow dispatcher | Not guarded: I3. |
| Retry recomputing identity/hash/grant | Reservation reused unchanged; `pending()` returns non-pending rows as recorded; `assertIdentity` enforces method/hash/generation. OK. |
| Authority resurrected after revoke | No path moves `revoked` back. OK. |
| Artifact outside roots / `..` / `.git` / tmp fallback / implicit grant | Normal path OK (no fallback, no grant, placement fixed, normalized). Recovery bypass: I2. Case: M4. Symlink/collision is device-side (simulated only). |
| `outputPath` before ack | Only `managedStartedText` after `acknowledged`; error texts omit the path. OK. |
| Migration 0143 | `IF [NOT] EXISTS` throughout; old inline check's implicit name `sandbox_operation_intents_state_check` matches 0140; existing rows default `legacy` and satisfy every new check; no edits to 0001–0142; expand-only. `check:migrations` and `check:applied-migrations --base a5185eb77` pass. OK. |
| Lock ordering / LockService in transactions | Xact locks only inside `requires_new` transactions; intent→task row order in bind/ack/complete/ceiling writes; leases (`ifRunning`, held session) are outside transactions. OK. |
| Recovery job ids / queue | `sandbox-operation-reconcile-<op>-recover-<n>`, `sandbox-operation-revoke-<op>-ack` on `cap-kernel-maintenance`; no colons, deterministic. OK. Unbounded cadence: I4. |
| Ceiling revocation selects exactly affected tasks | Platform/org/device predicates unchanged and include `background-running`; root exclusion is wrong: I1. |
| Existing SID consumers ignore managed rows | `recordStarted`, `failAbandonedLaunches`, poller (`sid IS NOT NULL`), resume kill (SID regex) ignore them. Stop/read are not correct for managed rows but the path is dormant (M6). |
| Active wire v2, managed path unwired | `DEVICE_PROTOCOL_VERSION = 2`; `runInBackgroundManaged` has no production caller; local provider `background` only on `stagedOperations`. OK. |

## Test quality

Tests were written after the code; I checked whether they pin the Phase 8.2 proposed gates:

- Lost ack → one launch, stable files/ref: pinned (retry and recovery tests).
- Same operation, changed input: pinned (tool-level and facade-level).
- Pre-ack owner narrowing, stale invocation, cancellation races: pinned, but narrowing uses a synthetic
  `narrow()` instead of real writers (design §B3 requires real writers → outbox), see I1.
- Reservation cap, max duration: pinned.
- Selected project outside workspace, workspace/tmp not writable: only the **positive** placement is
  integration-tested. Nothing exercises the kernel refusal through the facade: removing the
  `assertManagedArtifactAdmitted(scope, input)` call at `held-operations.ts:152` would keep every test
  green (the fake provider never validates `outputPath`; `managed-artifact.test.ts` tests the function in
  isolation). Add an integration case with a scope whose write roots exclude the working root, asserting
  zero provider calls, a settled task and no grant.
- Denied/swapped artifact parent: simulated by a provider-thrown denial; acceptable for the kernel side.
- Missing: recovery racing an in-flight dispatcher (I3), stop-before-ref + recovery (I3), retention
  expiry (I4), recovery with an unadmitted artifact (I2), real deletion writer (I1). The test fake's
  dedupe is not concurrency-safe, so it cannot detect concurrent duplicate dispatch.

Dual-replica now? Every race here is serialized by PG row locks / xact locks and the design keeps no
in-process state, so a same-process concurrent test is sufficient for 8.2's gates (I3's race test is
required now). The real writer→outbox→worker→device proof across replicas belongs to
`permission-lifetime.dual.test.ts` in 8.3/8.4 as planned.

## What I ran (at 6429c8099)

- `CAPYBARA_TEST_WORKERS=4 pnpm exec vitest run packages/kernel/test/background packages/kernel/test/sandbox/operation-scopes.dual.test.ts`
  — 12 files, **116 passed**.
- `CAPYBARA_TEST_WORKERS=4 pnpm exec vitest run packages/kernel/test/sandbox/{operation-authority,operation-scopes,permission-authority-lock,permission-call-grants,permission-wiring}.test.ts`
  — 5 files, **49 passed**.
- `pnpm typecheck` — pass.
- `pnpm check:migrations` — pass; `pnpm check:applied-migrations --base a5185eb77` — pass.
- No dev stack, no credentials, no edits to the reviewed worktree.

---

# Re-review round 1 — `6429c8099..72395058d`

Scope: the fix commit only (10 files, +722/−120), read-only. Verdict: **APPROVE**. Two minor
residuals remain (R1, R2). Neither blocks this dormant phase; both should be closed before 8.6 activation.

## Original findings

| # | Status | Where | Would the new test fail without the fix? |
|---|---|---|---|
| I1 deletion revocation | **Resolved** | `sandbox/permission-ceiling-writes.ts:106-116` now selects `background-running` at every level. | Yes. "deleting the conversation through the real writer…" calls the real `ConversationsService.remove`; under the old root exclusion the intent stays `background-running`. The profile test now uses the real `PermissionProfilesService.set`, which only bumps the epoch. |
| I2 artifact gate in recovery | **Resolved** | `held-operations.ts` `checkManagedStart` (artifact, then `assertPermissionSupport`) runs as a facade `preflight` before `claimDispatch` (`sandbox.service.ts:1327-1359`; refusal → `refusePreDispatch` settles intent `completed`, task `failed`). Recovery runs the same check (`operation-reconcile.job.ts:~105`). | Yes. The facade test asserts `run_execution_id: null` (the old post-claim assert bound the row first) and zero provider calls (removing the check entirely gives one call). The recovery test with an out-of-roots recorded scope would otherwise launch once. |
| I3 race / stop | **Resolved** for the reconcile path | `claimBackgroundRecovery` (`operation-intents.ts:~713-746`) takes over only `started-or-unknown`; `dispatching` is deferred (`reconcile.job.ts reconcileBackground`). A stop-claimed or non-dispatched task is never started: intent `revoked`/`outcome_unknown`, `-recover` revoke owed, task `cancel-pending`. The test fake now joins concurrent starts. | Yes. The race test asserts one provider call (the old code claimed `dispatching` and issued a second start). The stop-before-ref test asserts zero launches and an owed revoke. |
| I4 retry / stuck slot | **Resolved** | `deferBackgroundRecovery` uses 30 s × 2^(n−1), capped at 1 h and at `retain_until`. At expiry `abandonBackgroundLaunch` moves a ref-less dispatched or cancel-pending task to `lost/launch_unknown` (slot freed) and revokes the intent with `outcome_unknown`, owing the revoke. An acknowledged task (`background-running`, ref set) is left untouched. A typed provider refusal during recovery settles as a pre-effect failure (`settleBackgroundRefusal`). | Yes. Backoff (second delay ≥ 59 s), expiry (`countRunning` 0 plus owed revoke) and the typed-refusal test (no `-recover-` job) all fail on the old code. |
| M1 stale replica | **Resolved** | `background/store.ts:~262-270`: `failManagedPreEffect` requires `runs.execution_id = executionId`. `bash.ts:534` passes the claim. | Yes. The rewritten stale test expects the row to stay `pending`, and the current claim's retry to launch once. |
| M2 `-ack` no-op | **Resolved** | `acknowledgeBackground` resets `revoke_acknowledged=false` when it attaches a ref. | Yes ("a ref attached after an acknowledged revocation…" expects two `revokeOperation` calls). |
| M3 provider identity | **Resolved** | `reconcile.job.ts` compares the instance provider and the registered entry's version with the recorded ones. | Yes (version-change half of the backoff test: one provider call). |
| M4 `.git` case | **Resolved** | `launch.ts:234-235`, plus a unit case. | Yes. |
| M5 TTL duplicate | **Resolved** | `STOP_CLAIM_TTL_MS` is imported from `background/store.ts`. | Refactor only, no test needed. Typecheck passes and there is no import cycle at runtime (suite green). |

## Checks the coordinator asked for

- **Revoking `background-running` at every level.** Only the root branch changed. The device, org and
  platform selections are the same predicates as at `6429c8099`. The only revoking root-level writer
  is deletion, whose predicate (`conversationId === rootId || intent.conversation_id === conversationId`)
  revokes the whole tree on root deletion and only the deleted child's intents on a sub-agent
  deletion, so siblings survive. Profile changes never call `publishLocked`; the real-writer test shows
  they survive. `commitHandle` revokes only when the roots change. Restricted-only owner, org and platform
  edits revoke through `ownerPolicyRevokes` and the host-coverage predicates, the same as before. Making
  those selectors exact (Full versus restricted, independent host additions) is 8.4's job per the B3 row.
  Nothing that should survive is newly revoked.
- **Takeover only from `started-or-unknown`.** This is right for the first-dispatch path: the dispatcher
  moves the intent to `started-or-unknown` itself, through `unknown()` after an error or a failed ack. A
  dead dispatcher left in `dispatching` is moved by holder cleanup (`revokeHolders` → revoked, revoke
  owed) or, at worst, abandoned at expiry. Both are bounded. See R1 for the retry path.
- **Backoff and expiry.** The slot is freed (`status='lost'`), the intent becomes `revoked` with
  `outcome_unknown=true` and `revoke_acknowledged=false`, and a revoke job is enqueued.
  `reconcileBackground` also calls `revoke()` straight away. The revoke worker keeps its existing
  owed-retry, so the tombstone obligation survives. Live acknowledged authority is never dropped at
  intent expiry.
- **Recovery abandons on a kernel-check refusal.** This is conservative and correct. A
  `SandboxScopeDeniedError` from `checkManagedStart` during recovery cannot prove that the first dispatch
  had no effect, so the code gives up re-sending, frees the slot as `lost` and keeps the exact revoke
  owed. An unsupported runtime (`SandboxPermissionUnsupportedError` in the check phase) defers with
  backoff instead, which is right. Since preflight now runs before every dispatch, a check-phase denial
  is reachable only for rows whose recorded scope or input differs from what preflight saw, such as rows
  from before the fix or tampered rows. Only a start-phase typed provider refusal is settled as a
  failure; this relies on the SDK rule that a launched operation returns its ref.

## Residual (minor, non-blocking for dormant 8.2)

**R1. The same-call retry path can still overlap a scheduled recovery.** `claimReconciliation`
(`operation-intents.ts:~1000`) sets `started-or-unknown` and a new `execution_id` *before* the retrying
dispatcher calls the provider. If the admission-deadline reconcile job fires during that call,
`claimBackgroundRecovery` takes over a live dispatch. The result is two concurrent same-id starts, safe
under the SDK's exact-ownership contract and now modelled by the fake, and a spurious "may have started"
report to the retrying call. Fix: have `claimReconciliation` leave backgroundStart in a distinct
in-flight marker (e.g. `dispatching`), or have recovery skip intents whose `holder_token` lease is live.

**R2. The same-call retry path ignores a stop claim.** `claimReconciliation` does not apply the stop
check that `claimBackgroundRecovery` now has. A stop claimed on a `dispatched` row, followed by the run
resuming and retrying the call, can launch and then turn the task into `cancel-pending` (launch, then
cancel). Fix: inside `claimReconciliation` for `backgroundStart`, lock the task row and, if it is
stop-claimed or not `dispatched`, revoke with an owed revoke instead of returning a dispatchable claim.
Add a test for it.

M6 items remain deferred to 8.3/8.4 as planned.

## Re-run (at 72395058d)

- `CAPYBARA_TEST_WORKERS=4 pnpm exec vitest run packages/kernel/test/background packages/kernel/test/sandbox/operation-scopes.dual.test.ts`
  — 12 files, **125 passed** (116 before; +9 new tests, 2 rewritten).
- `pnpm typecheck` — pass. `pnpm check:migrations` — pass (no migration change in the fix).
