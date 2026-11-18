# Task 9.3 report: one authority projection and fenced recorder — DONE_WITH_CONCERNS

Worktree `.claude/worktrees/perm-t9-3`, branch `perm/t9-3`, base `e2d24c679`. Not pushed, no PR.
Commit: `6454e51af` feat(kernel): one authority projection and fenced permission context recorder.
Runs: `CAPYBARA_TEST_WORKERS=2 CAPYBARA_TEST_CONTAINER_STARTS=2`. Logs in scratchpad `t93/`.
No edits to sandbox.service.ts, legacy-retirement or machines.ts (no overlap with 8.5).

## What landed (dormant: nothing in production calls the recorder)

- `sandbox/permission-context-types.ts`: `PermissionContextSubject`, `HeldDeviceContextEvidence`,
  `AppliedEnvironment`, `PermissionContextSubjectChanged`. No runtime import from the lower module.
- `sandbox/operation-authority.ts`: `snapshot` split into `runScheduledLocked` + `baseScopeLocked`
  (policy/owner, working root + projectMatches, `NetworkGrants.forExec`, ceiling host filter),
  called in the original order (no admission semantic change; 274 + 130 regression tests green).
  New `readContextLocked(input, signal)` (mandatory tx): readOwnedRoot; asserts platform/org/root/
  device locks are already held (else SubjectChanged); active-member actor check; publication;
  run check; B1 table: no-device / actor-device-access (exact null fields, redacted profile),
  provider unavailable or contract/report unsupported → unsupported, unprobed report → unprobed,
  cloud reconcile / blocked owner report → unprobed, project binding refusal → unsupported,
  applied environment null (or location/workspace mismatch) → unprobed, then profile-specific
  report check (restricted null → unsupported; Full needs fullAccess) → supported scope from the
  same base admission uses. Scheduled = root binding or actual run `scheduled_task_run_id`.
  Output parsed by `PermissionContextV1Schema`.
- `sandbox/permission-facts.ts`: `viewWithAccess` (view unchanged over HTTP; adds access kind);
  `readAppliedEnvironmentLocked({orgId,deviceId})` (asserts device lock): running/suspended
  instance, committed `permission_roots` = handle roots, installed binding of exactly this
  generation/provider, binding machine = active machine, binding identity = instance runtime
  identity; local → host-environment. **Cloud returns null** (no installed provider binding exists
  yet), so cloud contexts are unprobed until Task 8 supplies cloud binding evidence.
- `permission-authority-lock.ts`: exported `assertAuthorityHeld` (method delegates).
- `runtime/permission-context.service.ts` `PermissionContextRecorder` (one provider in
  RuntimeModule; explicit imports OperationAuthorityModule, PermissionAuthorityModule,
  PermissionProfileStoreModule; explicit @Inject): `record` requires matching
  `currentExecutionClaim()` and no open tx; lock-free discovery (refuses eval conversations, claim
  of another tree); `withTransactionFencePrelude(locks.acquire(admit), appendLocked)`;
  `appendLocked` (@Transactional): publication, org/root/conversation locks in fence order,
  explicit run status=running + execution_id compare (ExecutionRevoked), actor, subject re-check,
  `readContextLocked`, latest `permission_context` from PG (strict parse; corrupt → invalid),
  hash dedupe, `appendIn` with `permission_context:v1:<hash>:<prevSeq>`, `afterCommit` notify.
  One rediscovery on changed subject; second → `run.permission_context_changed`.
  `permissionContextFailure()` maps: ExecutionRevoked/RunError/abort identical; stale publication;
  changed; actor (conversation.not_found/forbidden); storage (SQLSTATE 08/40/53/57/58/XX,
  connection errors); everything else incl. `RecordedPermissionContextError` → invalid (F5),
  logged sanitized. Copy for the five `run.permission_context_*` codes added to web en/zh.
- Changeset `.changeset/permission-context-recorder.md` (kernel + web patch).

## Tests

- `test/runtime/permission-context-recorder.test.ts` (integration, 38): exact supported payload +
  admission equality (fs, network, ceilingRevision = authorityRevision); dedupe/no notify; A→B→A
  via real PermissionProfilesService.set + restricted-only device epoch bump; rolled-back append
  (no event, no notify, later predecessor 0); no claim / other claim / inside tx / unfenced claim
  after replacement (runOutsideTransaction) / eval conversation; replaced claim, ended run, deleted
  root, abort (identity preserved, nothing appended); stale publication / disabled actor / corrupt
  recorded snapshot; changed device during discovery (one retry, then named error); writer-first
  and recorder-first fixed order with pg_stat_activity lock-wait barriers; no-device and nonowner
  (owner Full, redacted) exact payloads; unprobed: no report, awaiting binding, no binding,
  suspended without evidence, stale identity, replaced machine, cloud desired-but-unapplied;
  suspended with evidence supported (no resume); no-contract provider unsupported; 16-case
  matrix {request,approve,full,stale-Full} × {both,restricted-only,full-only,neither}; scheduled
  root on Full-only, scheduled child/wake with real `scheduled_task_run_id` and task grants
  (inherited, child log only, equals admission, root keeps Full); task-grant narrowing equals
  admission (devicePolicy spy narrows the ceiling for both); adapter refuses without lock.
  F3: while recording, throwing spies on authority preview/resolve*/subjectFor, intents,
  CommandReviewService.review, PermissionCallGrants (issueLocked/findForAdmission/forExecution/
  assertCurrent), PermissionRuntimeReports.record, LocalInstanceBindings bind/install/retarget,
  ApprovalsService request*/decide, SandboxService lifecycle/prepare/pathLease/destroy/reset,
  and every provider method of a replaced `@local` — none called.
- `test/runtime/permission-context.dual.test.ts` (container list, 7): distinct kernels/pools/tx
  hosts; same-predecessor race with read hold + lock-wait barrier → one snapshot; cross-replica
  same payload no extra; A→B→A across replicas; claim replaced on the other replica; writer on B
  vs recorder on A in fixed order; run ended by B while A waits.
- RED: implementation was written before the tests, so RED was shown by mutation: removing dedupe,
  run-status check, binding machine check, explicit execution-id check each made its test fail
  for the intended assertion, then restored (logs `red-*.log`, `green-claim2.log`).

## Verification

- Zero-drift: reconstruct + rename-compat 63/63 (before tests), again in regression batch 2.
- Regression: permission-wiring, call-grants, operation-scopes(+dual), operation-authority,
  permission-policy, permission-context (pure), instance-bindings, permission-approvals.dual,
  permission-lifetime.dual, run-replay: 274 + 130 green. Final focused 3 files 220/220.
- `pnpm typecheck` ok, `pnpm lint` ok (warnings pre-existing), `pnpm check` all passed.
- `pnpm test:unit` 1475/1476: `log.test.ts` redaction-cost timing test failed under load, passed
  33/33 on rerun (unrelated, load-sensitive).

## Concerns / for review

1. Cloud is always unprobed (no cloud installed binding). Truthful per spec; needs Task 8 evidence.
2. Without a project, a working root that differs from the installed workspace is unprobed
   (avoids reporting an unverified default); admission still uses the recorded/reported root.
3. Integration tests live in a new file `permission-context-recorder.test.ts` (plan named
   `permission-context.test.ts`, which holds the pure 9.2 tests); shared fixture
   `permission-context-fixture.ts`.
4. Recorder throws `RunError` directly (9.4 adapter only needs to pass it through);
   `PermissionContextBeforeRequestError` from the spec is therefore not introduced here.
5. Hard-deleted root during discovery maps to actor-unavailable, soft delete to ExecutionRevoked.
6. Task-grant narrowing test narrows via a `devicePolicy` spy (the deployment egress config did
   not narrow a local owner-auto device); both readers share the spied policy.
7. Trust-boundary change: review alone (`snapshot` refactor in operation-authority.ts).
