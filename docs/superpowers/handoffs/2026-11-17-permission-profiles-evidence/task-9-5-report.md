# Task 9.5 report: recorded-only full-run replay, plus 9.2 follow-ups M1–M4

- Worktree `/Users/grant/Capybara/core/.claude/worktrees/perm-t9-5`, branch `perm/t9-5`, base `239351676`.
- Commits (local only: no push, no PR):
  - `af9404023` fix(runtime): share recorded permission marker rule with replay (Part 1: M1, M2, M4)
  - `dd6d42686` feat(evals): replay recorded permission context only (Part 2: Gate 9.5, M3)
- Status: **DONE_WITH_CONCERNS**. The feeder is installed but **dormant**. Gate 9.4's request-boundary call is out of scope, so no runtime code calls `permissionContext.beforeRequest` yet (see Limitations).

## Part 1: 9.2 review follow-ups

### M1: one marker rule for live build and the checker
`permissionContextHistory` (`runtime/context/permission-profile.ts`) now calls `assertRecordedPermissionEvents` before it renders anything. Live `buildModelRequest` and the raw-coordinate checker share the traversal, so they follow the same rule. A `device_paths` marker that is present but not 1 (2, null or "1"), or a `permission_context` with an unsupported version or an unknown key, throws `RecordedPermissionContextError`. This holds whether or not a summary covers the event. Such an event is never rendered as legacy text and never surfaces as a raw ZodError. Unmarked events, including `permissionContextVersion: undefined`, render exactly as before.
- RED: 7 new cases in `permission-context.test.ts` ("live build refuses …") failed for the intended reasons. The 5 marker cases (2, null, "1", summary-restored, covered-superseded) threw nothing, because legacy text was rendered. The 2 `permission_context` cases threw a ZodError where `RecordedPermissionContextError` was expected.
- GREEN: all pass after the one-line change.

### M2: a corrupt recorded context is the snapshot's error, not the provider's
Decision: register the ApiError `eval.snapshot_invalid` (422) next to `eval.compact_not_replayable`, with zh and en text under `errors.eval`. Reasons:
- Existing eval failures that belong to the snapshot are already ApiErrors (`eval.call_not_found`, `eval.compact_not_replayable`).
- `classify` already passes ApiError codes through unchanged, and `isReplayFailure` already treats ApiError as a replay error, not a crash. Adding a new class to `classify` would have been a special case.
- `assertSnapshotPermissionEvents` in `evals/reconstruct.ts` wraps the check and converts `RecordedPermissionContextError` to the new code. The runtime keeps the typed error, which 9.4 will map to `run.permission_context_invalid`.
- RED: the 8 existing raw-snapshot rejection cases, re-asserted to expect `ApiError` with `eval.snapshot_invalid` and status 422, failed against the old code, which threw `RecordedPermissionContextError`.
- GREEN: they pass. The integration test "an unsupported version fails as eval.snapshot_invalid with no eval conversation" proves the worker path end to end: the result is `error` with that code and `evalConversationId` is null.

### M4: reuse `coversHost`
`conversations/events.ts` now imports `coversHost` from `sandbox/modes.ts`. There is no import cycle: `modes.ts` imports only types and `platform-auto-mode.ts`, which imports zod and types. A 9-row equivalence test pins the schema decision to `coversHost` for exact matches, subdomains, an apex under a wildcard, wildcard against wildcard and a look-alike suffix. This was a refactor, so the test is a lock and was green before and after the change; there was no RED.

## Part 2: Gate 9.5

### Source
- `evals/recorded-permission-context.ts` (new):
  - `permissionFeedPlan` builds the original requests C = (step, attempt, callSeq, U = min(toSeq, callSeq-1)). A missing attempt counts as 1. It rejects a duplicate (step, attempt), a step or attempt going backwards, and U going backwards, all as `eval.snapshot_invalid`. Each target-run `permission_context` (seq > R) gets its first visible C; an event that no request saw is never fed.
  - `selectOriginalRequest` implements the B4 table exactly.
  - `recordedPermissionContext(snapshot, eventLog, target)`:
    - Returns `undefined` when the recording has no marker of any kind (event, managed path or metadata).
    - Validates the snapshot first.
    - Tracks the furthest original request reached, so feeding is monotone, and feeds due events in source-seq order as one `append` batch. Idem keys are `replay_permission_context:<generatedRunId>:<originalSeq>`; the payload is a structured copy and the run id is the generated one. An idem hit returns the existing event, so the key, not the in-memory map, is the durable record of what was fed.
    - Fails closed on a conversation or run other than its own, and writes nothing once aborted.
  - `recordedRunPermissionDrift` runs the pure 9.2 checker over every target-run `model_call`, in original coordinates only.
- `evals/run-replay.ts`:
  - Computes the diagnostics and the feeder before seeding, so a corrupt recording leaves no eval conversation.
  - Passes `permissionContext` through the extended `loop` dependency pick, only when the recording has markers.
  - Sets `permissionContextDrift: true` on the result when the diagnostics find drift. `RunBaseline` excludes the field.
- `evals/worker.ts`:
  - New exported `replayLoopDeps(stepDeps, overrides)` destructures the live `permissionContext` away together with hooks, both progress sinks and `skillForks`, then overlays the replay's overrides. With no override, the result has no `permissionContext` key at all.
  - `runWhole` adds `permission_profile_changed` in DRIFT_ORDER position, between `subagent_changed` and `model_switched`.
- `evals/recorded-tools.ts`:
  - `recordedCalls` keeps a managed `device_paths` payload whole (`structuredClone`); legacy payloads keep their old roots-and-level shape.
  - Insertion goes through `devicePathsChangeFromPayload`, which delegates to the old `devicePathsChange` for legacy payloads, so their bytes and keys are unchanged.
  - New `review?: ReviewRecord`: validated with `ReviewRecordSchema` (now exported), copied exactly with key order preserved, and copied verbatim onto matched results only. An unmatched or stopped result has no review. An invalid review is `eval.snapshot_invalid` and is never repaired. A review never enters matching, content or metadata.
- `runtime/model-call.ts`: a type-only `ModelStepDeps.permissionContext?: PermissionContextPort` and `PermissionContextRequestInput`, matching spec B2. It is documented as dormant: nothing invokes it until 9.4. It is needed so the strip and the overlay are typed and structural.
- M3, because the reason is now reachable in full-run results:
  - zh and en `evals.drift.permission_profile_changed` (the zh text avoids 企业 and the Latin word `agent`).
  - The parity list in `apps/web/test/messages-parity.test.ts`.
  - The reason line and a "Recorded permission context" paragraph in `.agents/skills/replay-evals/SKILL.md`.
- Changesets: `recorded-permission-context-guards.md` and `recorded-permission-context-replay.md`, both kernel and web patch.

### Test cases, RED → GREEN
RED method: I restored HEAD versions of `recorded-tools.ts`, `run-replay.ts` and `worker.ts`, and replaced `recorded-permission-context.ts` with a no-op stub with the same exports. In `worker.ts` I added an exported `replayLoopDeps` that keeps the pre-change strip list. Results:
- Unit (`recorded-permission-context.test.ts` + `recorded-tools.test.ts`): 35 failed / 11 passed.
- Integration (`run-replay.test.ts -t "Gate 9.5"`): 2 failed / 1 passed.
  - The marked recording failed because the matched result had no review.
  - The tampered recording failed because drift was `[]`.
  - The old-recording guard passed, as a no-regression guard should.
- Parity: with the labels removed, zh and en both failed.

Everything passes after restoring the real files.

Unit, `test/evals/recorded-permission-context.test.ts` (37 tests, new, registered in `unit-tests.json`):
- B4 table:
  - Before every original step → none.
  - Attempt before the first recorded one → that first attempt (original attempt 2 supplies generated attempt 1).
  - Exact attempt.
  - Interior gap → the greatest earlier attempt.
  - Past the last attempt → the last.
  - A missing step → the last request of the greatest earlier step.
  - Past every step → the final request.
  - A run with no requests → none.
- Plan: U = min(toSeq, callSeq-1), legacy attempt 1, a never-visible event excluded. Rejects a duplicate (step, attempt), a backward attempt, a backward step and a backward U.
- Feeder:
  - An unmarked recording gets no feeder.
  - A and B, both logged before the only step-1 call (a fit before and after a compaction), are fed in source order.
  - The generated request built with `buildModelRequest` renders P, A and B, and its metadata locates the generated seq.
  - The earlier run's P is seeded once and never appended.
  - The same boundary, or a generated extra retry, appends nothing.
  - C arrives only at step 2. D, never seen by the original run, is never fed.
  - Extra steps keep the last recorded context.
  - A candidate that ends early consumes nothing later.
  - The interior attempt gap and the missing step are proven against the feeder too.
  - A marked recording without any request installs a feeder that never feeds.
  - Reentry with a fresh feeder recovers the mapping from the idem keys, with no duplicates.
  - Wrong conversation or run throws; an aborted signal writes nothing.
- Diagnostics:
  - Baseline: no drift.
  - An unrendered revision alone: no drift, because the hash covers the rendered contributions.
  - A changed profile: drift. A deleted event: drift.
  - A tampered call from an earlier run alone does not count.
  - Version 2 is `eval.snapshot_invalid` (422) from both the feeder and the diagnostics.
- Strip: `replayLoopDeps` drops a throwing live recorder, hooks, progress and forks; installs the recorded feeder; and has no key at all when there is no override.
- Old recordings: pre-background (parent and child), pre-rename, pre-skills (parent and child) and pre-tool-rename give no feeder, no permission drift, no `review` key and no marked paths. The fixture sha256 values match `task-9-2-historical-fixtures.json`.

Unit, `test/evals/recorded-tools.test.ts` (+5 tests):
- A review is copied exactly (same key order); absent stays absent.
- An invalid review is refused.
- A managed path is kept whole; a legacy one keeps its old shape.
- A matched result gets the review verbatim (cloned, not shared); an unmatched result gets none; no extra events are written.
- A managed payload is inserted after a legacy event with identical roots, using the idem key `device_paths:permission-v1:<64hex>:4`. The same managed payload already being latest appends nothing.

Integration, `test/evals/run-replay.test.ts` (+3 tests; one real kernel through the HTTP eval-run path):
- A marked recording, written by hand with consistent per-request metadata: an earlier run's context, target context A, a managed path and a denied review. After `addCase`, today's DB is changed (`permission_profile` set to full-access, revision 99). Throwing spies are installed on:
  - `SandboxOperationAuthority`: `previewCall`, `resolve`, `resolveInvocation`, `resolveBrowse`, `subjectFor`
  - `SandboxOperationIntents`: `admit`, `admitBrowse`, `claimDispatch`
  - `CommandReviewService.review`
  - `PermissionFacts`: `view`, `preview`, `scope` (the runtime-report probe path), `readDevice`, `devicePolicy`, `readWorkingFacts`, `projectScope`
  - `SandboxService`: `withSandbox`, `withOperations`, `withPreparation`, `withBrowse`, `ifRunning`, `status`, `currentInstance`, `availableFor`
  - A throwing live `permissionContext` set on `RunSteps.deps`.

  Result: `done`, drift `[]`, no `permissionContextDrift`. The seed is present once at its original seq. The matched result carries the denial and the review verbatim. The managed path is copied whole before that result. No spy was called, there were no sandbox ops, the tool count is unchanged, and no `permission_reviewed` or approval event was invented.
- A tampered stored snapshot gives drift `["permission_profile_changed"]`. Version 2 gives result `error` with `eval.snapshot_invalid` and no eval conversation.
- An old recording gives no `permission_context` or `device_paths` events and no `permissionContext` metadata on generated `model_call` events.

## Commands and counts (from the worktree root)
- `CAPYBARA_TEST_WORKERS=4 CAPYBARA_TEST_CONTAINER_STARTS=2 pnpm exec vitest run packages/kernel/test/evals packages/kernel/test/tools/rename-compat.test.ts packages/kernel/test/runtime/permission-context.test.ts` on the committed tree: **22 files, 452 tests passed**, exit 0.
  - The same set plus `apps/web/test/messages-parity.test.ts`, run before the commit: 23 files, 462 passed.
  - `permission-context.test.ts` grew from 158 to 175 tests. The reconstruct and rename-compat zero-drift groups are part of the 452.
- `pnpm typecheck`: exit 0.
- `pnpm check`: "All checks passed" (includes test portfolio, i18n and terms).
- `npx biome check` on every touched file: clean.
- Historical fixtures: all 7 files in `task-9-2-historical-fixtures.json` match their sha256, checked by a node script and by a unit test. `git diff 239351676 -- packages/kernel/test/evals/fixtures` is empty.

## Limitations and concerns
1. **Dormant feeding.** 9.4 (the model-call request boundary) is out of scope, so no runtime code calls `beforeRequest`. In a real full-run replay today:
   - The feeder is installed for marked recordings but never runs.
   - Target-run `permission_context` events do not reach generated requests; seeded earlier-run contexts and managed paths do.
   - The feeding semantics are proven against an in-memory log that enforces the real idempotency and write validation, plus `buildModelRequest` on that log. Once 9.4 lands, an end-to-end run-replay assertion that target-run contexts appear in generated requests should be added.
2. `ModelStepDeps.permissionContext` is a type-only addition to `model-call.ts`, which 9.4 owns. It is a one-field merge point with 9.4; no behavior was added.
3. There is no dedicated resume or probe method on `SandboxService`. The spies cover every `with*` entry and status/instance read, plus `PermissionFacts.scope`, which is the caller of `readRuntimeReport`. The module-level `readRuntimeReport` function itself is not spied (ESM).
4. Child and scheduled-run full-run replays with recorded permission context are not specifically covered: no producer writes those shapes yet (9.3/9.4). The feeder keys off the case's own `runId`, which is the same for child cases.
5. `recordedCalls` now throws `eval.snapshot_invalid` for a stored review that fails the current strict `ReviewRecordSchema`. The log validates reviews with that same schema on write, so stored data should pass; a historical review shape that has since become invalid would now refuse replay instead of passing through.
6. The plan puts the skill update in 9.6. I added the M3 skill line and a short paragraph now, as the brief asked for M3, marking the feature as dormant.

## Fix round 1 (independent review: F1, F2, F4; F3 and F5 deferred to 9.3/9.4 by the controller)

Commit `41bb24645` fix(evals): read recorded tool results before the replay seed.

- F1: `.agents/skills/replay-evals/SKILL.md` now states that until Gate 9.4 wires the request boundary nothing calls the feeder. A full-run replay today only seeds earlier runs' contexts and copies managed paths; the target run's own `permission_context` events are not injected into generated requests.
- F2: the marked-recording integration test is retitled to say "target-run context not yet fed". It now asserts that context A exists in the original conversation and that the eval conversation has no `permission_context` after the seeded one. 9.4 must flip this assertion.
- F4:
  - The `eval.snapshot_invalid` copy is now generic to any invalid recorded snapshot data: the errors.ts comment lists permission context, review records and step/attempt order. New en text: "The case snapshot holds recorded data that this version cannot read, so the case cannot be replayed." New zh text: "用例快照中的记录数据无法被当前版本读取，因此该用例无法回放。"
  - `recordedCalls(s)`, which validates reviews, now runs in `replayRun` before the seed, next to the permission diagnostics and the feeder.
  - New integration case: a tampered tool_result review (`decision: "maybe"`) ends the result in `error` with `eval.snapshot_invalid` and `evalConversationId` null.
  - RED: with the old `run-replay.ts` (reviews validated after the seed), that assertion failed: "expected '<uuid>' to be null". With the fix, it is GREEN.
- Verification:
  - `CAPYBARA_TEST_WORKERS=4 CAPYBARA_TEST_CONTAINER_STARTS=2 pnpm exec vitest run packages/kernel/test/evals packages/kernel/test/tools/rename-compat.test.ts packages/kernel/test/runtime/permission-context.test.ts`: 22 files, 452 tests passed. The new review case is an extra assertion block inside an existing test, so the test count is unchanged.
  - `pnpm typecheck`: exit 0.
  - `pnpm check:i18n`: passed.
  - Biome on the touched files: clean.
