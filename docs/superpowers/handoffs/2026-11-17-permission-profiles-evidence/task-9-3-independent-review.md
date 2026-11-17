# Gate 9.3 independent review: one authority projection and fenced recorder

Reviewer: independent (read-only). Worktree `.claude/worktrees/perm-t9-3`, `git diff e2d24c679 6454e51af`
(one commit, 13 files, +2256/-67). Judged from code and spec/plan first; the author's report was read
only afterwards and agrees with what I found.

## Verdict: APPROVE

No Critical or Important findings. Admission semantics are unchanged; the recorder follows the
spec's writer contract (real claim, no open transaction, authority prelude before the inherited run
fence, explicit execution id/status checks, persisted-log dedupe, one bounded rediscovery outside
the transaction, after-commit notify only, eval refusal). Minor findings below should be ledgered;
M1/M2 must be carried into Task 8 / Gate 9.4 activation.

## Tests run (CAPYBARA_TEST_WORKERS=2 CAPYBARA_TEST_CONTAINER_STARTS=2)

| Suite | Result |
|---|---|
| `test/evals/reconstruct.test.ts` + `test/tools/rename-compat.test.ts` (zero drift) | 63/63 pass |
| `test/runtime/permission-context-recorder.test.ts` (integration) | 38/38 pass |
| `test/runtime/permission-context.dual.test.ts` (container list) | 7/7 pass |

Counts match the report (38 = 9 recorder incl. 2-case each + 29 projection incl. 7 unprobed cases and
the 16-case profile x report matrix).

## What I verified

**Admission refactor (snapshot -> runScheduledLocked + baseScopeLocked).** Statement-by-statement
identical to e2d24c679: lock acquire, publication, cloud reconcile, owner report, readOwnedRoot,
view, device check, preview, then run check (same status set running/queued/waiting, same
trigger/conversation checks, `scheduled_task_run_id` OR root `scheduled_task_id`), then
readDevice, device source (`executeTakeFirstOrThrow`), readWorkingFacts (`root.id` ==
`view.rootConversationId` since view copies `row.id`), projectMatches -> `conflict`, workingRoot,
`grants.forExec` with the actual run, owner/org host filter and network ceiling, then captureGrant,
epochs. No lock is added or moved; scheduled task grants, explicit task narrowing, stale Full
consent (view's downgrade), non-owner trigger all flow through the same code.

**readContextLocked.** Mandatory transaction; readOwnedRoot (inaccessible -> `conversation.not_found`
-> no-send actor); asserts platform/org/root and (when bound) device locks are held, else
`PermissionContextSubjectChanged`; active member; publication; actual run (scheduled from the run or
root). B1 table: no-device (selected profile/revision kept, all device fields null, exact reason);
actor-device-access (selected/revision also null, exact reason); provider unavailable or
coarse-unsupported -> unsupported; unprobed report -> unprobed; reconcile/blocked owner report ->
unprobed; applied environment null / location mismatch / unprojected working root mismatch ->
unprobed (precedes positive capability, as spec requires); restricted with `report.restricted ===
null` -> unsupported (never switches to Full); Full with `!report.fullAccess` -> unsupported; scope
null on every nonsupported state; output parsed by the strict v1 schema. Full requires ceiling +
consent (view already guarantees; a violation throws -> invalid, no-send). Hosts come from the same
`baseScopeLocked` admission uses; Full -> device/environment; local outer = host-environment, per
spec ("do not turn local Full's restricted-domain/egress:none setting into outer network-off"). No
`previewCall`, call grant, reviewer, provider or intent is reached (F3 spy set in the test covers
the classes the 9.5 review listed, plus every provider method).

**readAppliedEnvironmentLocked.** Asserts the device lock; non-deleted device of the org; live
(running/suspended) instance with provider, handle, committed roots and runtime identity; provider
matches the device's; installed binding of exactly this generation (PK device+generation, so no
ambiguity) of the same provider, bound machine == current unrevoked machine, binding identity ==
instance identity (same joins as `readRuntimeReport`); committed roots == handle roots. Never desired
policy, never a provider call. Cloud returns null (see M1).

**Recorder.** Claim from `currentExecutionClaim()` checked against org/run/conversation and claim
root; refuses with an open transaction; lock-free discovery (refuses `kind = 'eval'` or
`eval_run_id`); `withTransactionFencePrelude(acquire admit, appendLocked)` so advisory authority locks
(platform -> org -> device -> root) precede the inherited run fence (org, root, conversation) - the
same order as admission's prelude at `operation-authority.ts:173` and the other prelude users; no
`LockService` inside a transaction. Inside: publication, row locks in fence order then conversation
`FOR UPDATE` (same upgrade `EventLog.write` does), explicit `status = 'running'` and `execution_id`
comparison (works without the inherited wrapper: test via `runOutsideTransaction`), trigger account,
subject re-read, projection, latest `permission_context` of the calling conversation read under the
row lock, strict parse (corrupt -> invalid), hash dedupe (A->B->A appends three; idem key carries
the predecessor seq), abort checked before the append, `afterCommit` notify. One rediscovery on
`SubjectChanged` / `device.not_found` from acquire, outside the transaction; second -> `changed`.
Abort keeps its reason, ExecutionRevoked keeps identity. Error mapping and en/zh copy are correct and
consistent (zh avoids 企业 / `agent`).

**Author notes.** (1) Unbound working root != installed workspace -> unprobed: conservative, spec
compliant ("never unverified default as installed scope"). (2) Hard vs soft delete: hard-deleted
root -> `conversation.not_found` -> actor; soft-deleted -> ExecutionRevoked from the fence/explicit
check: both no-send, acceptable. (6) Deployment egress not narrowing an owner-auto local device:
this is `deviceNetwork` (auto mode -> open-public unless `egress: none`) in pre-existing accepted
admission; the context shares it, so it is consistent by construction and outside 9.3. For Full the
spec explicitly wants host-environment. Correct for this gate; see M5 on the test.

## Findings

### Critical
None.

### Important
None.

### Minor

**M1. Cloud contexts are permanently unprobed** - `packages/kernel/src/sandbox/permission-facts.ts:572`
(`if (device.source !== "local") return null`). Spec allows null when the installed outer boundary
cannot be proved, but it also names `readInstanceLimits`/applied state as evidence for cloud. With no
cloud binding attestation, every cloud device's context will say "Device operations are unverified"
after activation even when admission admits. Failure: after 9.4 activation a cloud user sees a false
"unverified" line every request. Fix: ledger as an activation prerequisite (Task 8 cloud binding /
applied-limits adapter) or explicitly accept cloud-unprobed for the first release in the plan.

**M2. Admission does not consume `readAppliedEnvironmentLocked`** - spec B1 says the adapter is
"consumed by the common admission/context base-facts reader"; only `readContextLocked` calls it
(`operation-authority.ts:787`). Direction is safe (context is narrower than admission: unprobed
while admission may admit; likewise M3's working-root case), but the spec's "one projection" is not
complete. Fix: record for the Task 8 managed path (the held `HeldDeviceContextEvidence` producer)
so admission and context agree before activation.

**M3. The cloud "desired-but-unapplied" test does not discriminate** -
`test/runtime/permission-context-recorder.test.ts:591-614`. Because every cloud device returns null
(M1), the case passes whether or not the desired/applied distinction exists. Fix: rename to what it
proves ("a cloud device is unprobed until its binding evidence exists") or add the discriminating
case when M1 is implemented.

**M4. Soft-deleted device is reported as actor-device-access** - `permission-facts.ts:967`
(`device.not_found` from `DeviceAccess.usable`, which filters `deleted_at`, `owner_account_id`,
`owner_kind`). Copy "This run's actor cannot use the selected device" is inaccurate for a deleted
device. Spec's table only defines no-device vs access; acceptable now, but consider mapping a
deleted device to no-device (or unsupported) when Task 8 defines deletion.

**M5. Narrowing test uses a `devicePolicy` spy** - `recorder.test.ts:795-800`. Both readers share
the spied policy, so equality is structural; a real config (local machine in sandbox mode with an
org `cloudNetwork` allowlist) would pin it without a spy. Low priority.

**M6. Plan-required case missing: call expansion does not leak** - plan 9.3 "no call expansion leaks
into the next request or another child". Structurally true (`readContextLocked` never reads
`PermissionCallGrants`; the throwing spies would catch `findForAdmission`/`forExecution`), but no
test seeds an accepted call grant and asserts the next context excludes it. Fix: one case with an
issued call grant on the run.

**M7. Eval refusal checks only the calling conversation** - `permission-context.service.ts:264,321`.
Replays dispatch no children today (run-replay spec §8), so not reachable; checking the root's kind
too would make the guard independent of that.

**M8. `baseScopeLocked`/`preview` ApiErrors become `unsupported`** - `operation-authority.ts:783-786`.
Includes `conflict` ("The conversation project binding changed"), which is a binding change rather
than a runtime capability. Truthful enough (admission refuses), but a project-binding change could
instead be treated like `SubjectChanged`. Note only.

## Test quality

Tests were written after the code; the mutation REDs reported (dedupe, run status, binding machine,
execution id) are the right gates. Beyond those, by reading: the fixed-order tests (both orders, and
cross-replica) would deadlock or record the wrong revision under a fence-first order; the race test
proves one snapshot (it would also pass via the idem key alone, which is fine as an outcome check);
the unfenced-claim test pins the explicit execution-id comparison; the A->B->A test pins the
predecessor-seq idem key; the F3 spies make any live entrypoint fail the test. Gaps: M3, M5, M6; no
Full-access admission-equality assertion (only restricted and scheduled cases compare with
`resolve`).

Nothing of Gate 9.4 was done here: no `model-call.ts` / `run-steps.ts` change, no
`managed-device-context` module, no Task 8 shared files; the recorder is provided but uncalled.
