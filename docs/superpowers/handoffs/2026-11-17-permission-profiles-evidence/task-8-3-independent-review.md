# Task 8.3 independent review: task consumers, cursor and exact completion (+ 8.2 R1/R2/M6)

Reviewer: independent, read-only. Checkout `/Users/grant/Capybara/core/.claude/worktrees/perm-t8-3`
(branch `perm/t8-3`), range `4c7a69a89..87886a276` (one commit, 27 files, +2975/-45).
I judged from the code against AGENTS.md, the writing-kernel-api, writing-tools,
writing-sandbox-providers, writing-migrations and replay-evals skills, plan Phase 8.3 and the B5 row,
and design §"Consumer mapping and authority" and §B5. I read the author's report only after
forming these findings.

## Verdict: CHANGES_REQUIRED

There is one Important finding, and its fix is small. The rest of the phase is sound:

- The byte-cursor and small-frame assembly are correct.
- The HTTP suffix stays fixed at N.
- Exact-ref-only access holds.
- Finishes are exactly-once.
- The migration is correct.
- R2 is closed. R1 is closed for the scheduled-recovery race it named, with one residual hole
  (M1).

The Important finding breaks a requirement the plan states explicitly: "already-exited, stopped,
cancel-pending and lost stay distinct". It sits on the path the new TaskStop wording itself sends
the model down.

## Findings

### Critical

None.

### Important

**I1. TaskOutput finishes a `cancel-pending` task from its status, so a cancellation the device
applied later is recorded as a natural exit (`failed` or `completed`), not `stopped`.**
`packages/kernel/src/tools/builtins/sandbox/task-output.ts:647` (the blocking loop) and `:669`
derive the end with `statusEnd(bg.status(...))` for every running managed task, including
`launch_state = 'cancel-pending'`. `:711` and `:701` then `settle` it through
`finisher.finish(..., reported=true, {unclaimed:true})`.

The SDK status has no stopped state. When the device applies a pending cancellation, the process
completes with an exit code. Both the device supervisor (`operation-supervisor.ts:978`) and the test
fake (`test/helpers/managed-background.ts:169`, `exited` 143) report `{state:"exited", exitCode}`.
Only `bg.stop` returns the atomically claimed `stopped` outcome.

Failure scenario:

1. TaskStop gets `cancel-pending`. The new text (`task-stop.ts`, "stop requested ... Call
   TaskOutput to see when it has ended") tells the model to call TaskOutput.
2. The device applies the cancellation.
3. The model's blocking TaskOutput sees `exited`. The task finishes `failed` (exit 143 or null),
   with `launch_state='terminal'` and the intent `completed`.
4. The `background_task_finished` event says "failed", although the provider's claimed outcome is
   `stopped`.

The same happens to a revocation's cancel-pending task whenever TaskOutput reaches it before the
poller does. The poller avoids this because it stops cancel-pending tasks rather than polling their
status (`poll.job.ts:180`), so the result depends on which consumer comes first.

No test covers this. The fake does not model "apply a pending cancellation later, then a status
read".

Fix: for `launchState === 'cancel-pending'` (or `cancelRequestedAt !== null`), TaskOutput must not
settle from status. Either:

- leave the finish to the stopper or poller and only report the output with `terminal` from
  status; or
- derive the end from the idempotent `bg.stop(..., {graceMs})` claimed outcome through the stopper,
  so `stopped` and `already-exited` stay distinct and the requester's `stoppedBy` holds.

The blocking loop should likewise treat a cancel-pending task's `exited` as "ended". Add a test:
TaskStop gives cancel-pending, the fake applies it (status `exited 143`, stop `stopped`), and a
blocking TaskOutput must yield the event status `stopped`.

### Minor

**M1. R1 is only partly closed: `unknown()` is not fenced by execution.**
`operation-intents.ts:1039` moves *any* `dispatching` row to `started-or-unknown`. Since R1 the
retry's in-flight marker is `dispatching`, so a stale first dispatcher can clear the retry's marker.
This happens when the first dispatcher's claim was superseded but its provider call is still
running: when that call errors, `sandbox.service.ts:1409/1426/1446/1464` call `unknown(id)`.

Scheduled recovery can then take over while the retry is in flight. The result is the original R1
outcome: two concurrent same-id starts (safe under the SDK idempotency contract) and a spurious
"may have started" report for the retry. Fix: `unknown(id, executionId)` with
`.where("execution_id","=",executionId)`.

Related, and bounded rather than stuck: a dispatcher that dies on the retry path leaves the row
`dispatching`. Only `revokeHolders` resolves it, and that needs a later lease on the device that
claims the dead holder, or else the retention-expiry abandon (admission deadline + 1 day). Until
then the task shows as "starting". This is the same as the first-dispatch path, so it is acceptable,
but it should be stated in the PR.

**M2. A `cancel-pending` task on a not-running instance stays running indefinitely.**
`stop.ts:216` returns `pending()` for `not_running`. The poller (`poll.job.ts:180`) retries every
tick: it claims, takes no lease and sets `pending` again. Its acknowledged path, by contrast,
finishes the same situation as `lost` immediately (`poll.job.ts:~226`).

For a cloud instance that is `gone` or destroyed, the task stays `running/stopping` and holds a
`maxTasks` slot until the device is used again (the new instance then gives `other_instance`,
which settles it as `RECREATED`). Keeping it owed is right for `suspended`. For a missing or
destroyed instance, settle it as `lost` (not stopped), as the acknowledged path does, keeping
`cancel-pending` and the intent.

**M3. A lost or unavailable tail is rendered as "no output".**
`managed.ts:147` returns `""` for `{unavailable}`. TaskStop's `ended()` (`task-stop.ts:111`) then
prints `[No output.]`, and the finish event stores `lastLines: ""`, which TaskOutput's fallback
shows as `(none)`. For a `lost` stop result this says there was no output when the output was in
fact unavailable. Return `null` for unavailable and use an explicit "last lines unavailable"
wording. The existing null wording names a non-running sandbox, so this needs a managed variant.

**M4. HTTP `readManaged` does not map typed provider refusals.**
`tasks.service.ts:381` rethrows these errors:

- `SandboxScopeDeniedError`, including the kernel's own instance-mismatch throw at `managed.ts:93`;
- `SandboxPermissionUnsupportedError` (the provider has no `background`);
- `DeviceProtocolError`;
- relay `ToolError`.

Each surfaces as a 500, and a finished task loses the `output()` finished-event fallback. Map them
to `read_failed` (or `no_access` for denial) so the 409 / event-fallback contract holds.

**M5. A tail failure after a successful stop loses the stopped outcome.**
In `stop.ts:~196-206`, `lastLinesByRef` runs inside the same callback as `bg.stop`. A transport
error on the tail releases the claim and throws, although the provider already claimed `stopped`.
If the next consumer is a status reader, it records an exit (as in I1). Catch tail errors and use
an empty or unavailable summary once the stop outcome is known.

**M6. Lost managed records have no consumer and are kept forever.**
`pruneFinished` now keeps every row that is not `legacy` or `terminal`, and `finish` keeps
`cancel-pending` plus a `background-running` intent for a lost task. Nothing in 8.3 ever discharges
these, so the rows and intents grow without bound. This is intended (the report defers it to
8.4/8.5), but the 8.4 handoff must name it explicitly: the exact stop or revoke of lost
`cancel-pending` rows, then `terminal`, then pruning. Conversation hard delete still cascades these
rows (0070), so the retention promise does not survive deletion. Record this for 8.4/8.5.

**M7. The poller can stall on owed cancellations.**
It applies owed cancellations sequentially, each with a lease and a stop of up to 5 s grace
(`poll.job.ts:176-188`). Many cancel-pending tasks (for example after one revocation) lengthen a
locked tick linearly. A single poisoned status in `pollManagedInstance` (`poll.job.ts:205`) fails
the whole instance group every tick. Consider a per-tick cap or bounded concurrency, and catching
errors per task.

**M8. An aborted assembly returns no partial prefix.**
On abort or deadline, `assembleTaskOutput` throws and returns no partial prefix, so a very small
capacity C with the 50,000-byte budget could time out every call without progress. The spec allows
returning a partial fresh prefix. With realistic C (3,072 or more) this needs about 17 reads, so
this is not blocking. Note it for C near 1.

**M9. Test quality.**

- `permission-lifetime.dual.test.ts:162`, "a revocation written on one replica is applied by the
  other's poller", runs `poller(b)` twice. Nothing races across replicas; use `poller(a)` and
  `poller(b)`.
- "a poll on one replica and a TaskStop on the other" only asserts `polled <= 1`. The single event
  is the real assertion, which is fine.
- The HTTP-growth dual test does not force growth between the probe and the range reads. The unit
  test `managed-output.test.ts:288` does force it, so coverage exists there.
- There is no test for I1, nor for a person's pending stop settled by a TaskOutput status read.

**M10. A retried Bash call after a later stop gets the wrong message.**
`bash.ts` says "was stopped while it was starting" for an acknowledged task that a *later* stop
turned `cancel-pending` (`started` is false while it is running and cancel-pending with a ref).
This is an edge case and the wording is merely inaccurate.

## Verified (no finding)

- **Cursor and B5.**
  - The history is `[max(0,R-4096),R)`.
  - Fresh windows are `clamp(budget,4,61440)` with adjacent reads at the next unassembled offset.
    Budget is `min(65536,end-pos)`, and the adapter clamps to C.
  - Short reads are accepted. A zero-length read with bytes remaining is a deterministic capacity
    error.
  - A total that regresses below N is `lost`, and R>N is `mismatch` with no cursor move.
  - A window cut is completed with adjacent bytes even when C<4.
  - A live incomplete suffix is withheld (`wholeLength`) without spinning.
  - At a terminal end, status is established *before* the probe and every remaining byte is
    replacement-decoded, with the cursor advanced by the raw count.
  - Invalid lead bytes (0x80-0xBF, 0xF8+) decode as replacements, not withheld.
  - Remaining is `max(N-next,0)`. `advanceOffset` is monotonic (`read_offset < to`).
  - Memory holds history plus at most the configured budget (`outputSpillChars` = 50,000).
- **HTTP suffix.** It probes N, assembles `[max(0,N-min(B,65536)),N)` whatever later totals say,
  drops only the leading partial character, applies no line cap, and needs no read for N=0.
- **Exact-ref only.**
  - `exactRefOf` validates the operation id, instance id, generation digits, `sandboxCreatedAt`
    and the parse of the stored ref.
  - `ifRunning` is called with the recorded generation (never resume or create), and the held
    handle must be `ref.instanceId`.
  - Only `SandboxBackground` status, readOutput, tail and stop are used. There is no exec, path or
    scope. The ref always comes from the authorized row.
- **Stop.**
  - The grace is 5000 ms. `already-exited`, `stopped`, `lost` and `cancel-pending` are mapped
    separately, and cancel-pending writes no event.
  - Without a ref the claim and the requester are kept. Binding, acknowledgement, recovery and
    retry all treat `cancel_requested_at` as a stop.
  - The acknowledgement clears `stopping_at` so the poller owes the exact stop.
- **Exactly-once.** `store.finish` is conditional on `status='running'` (and on no claim for the
  poller and TaskOutput) and is written with its event and wake outbox in one transaction. The
  finisher locks the intent row before the task row, the same order as acknowledgement, recovery
  and abandon.
- **Wake rule.**
  - `reported=true` stops the wake for a TaskOutput settle or an immediate tool stop.
  - `cancel_requested_by` carries the person, deletion or sub-agent no-wake rule to a later finish.
  - A tool's pending stop that settles later wakes the model (`reported=false`). I agree with the
    author's choice: the model was told only "stop requested", so the real end is new information.
- **Migration 0144.** It is needed (the requester must outlive the claim TTL and the stopper
  invocation), additive, uses `IF NOT EXISTS`, has an idempotent CHECK drop and add, and matches
  `kernel-schema.ts`. It is numbered after 0143 with no collision on `main`.
- **R2.** `claimReconciliation` locks the task. A stopped, not-dispatched or missing task causes a
  revoke with `outcome_unknown` and an owed `-retry` revoke, and never a dispatch. The facade then
  throws OutcomeUnknown.
- **R1.** A `dispatching` marker is no longer taken by `claimBackgroundRecovery` (it requires
  `started-or-unknown`), and `reconcileBackground` defers it. The residual hole is M1.
- **M6 of 8.2.**
  - The stopper now stops managed rows.
  - `readLive` reads them instead of answering "starting".
  - Cancel-pending running tasks reach `terminal` through the poller.
  - The revoke worker's exact stop and the call-grant lookup remain 8.4, as the ledger says.
- **Legacy.** Every new branch is gated on `launch_state <> 'legacy'`. SID paths (`runningStarted`
  with `sid IS NOT NULL`, legacy TaskOutput, stop, HTTP) are unchanged. Protocol 2 is untouched, and
  the managed launch is still unwired.
- **Access.**
  - TaskOutput and TaskStop use `ownedTask` (own conversation and org) plus `recheckDevice`.
  - HTTP keeps `owned()` (the conversation or an ancestor in the org) plus `availableFor` and
    `deviceUsable` of the task's root owner.
  - The ancestor check grants no ref authority.
- **HTTP mapping.** Lost or expired output maps to `output_missing`, which goes through the
  finished-event fallback; capacity or a bad ref maps to `read_failed`. This is acceptable without
  a web or i18n change. The capacity remedy text is lost to the user; note it for the web follow-up.
- **Schemas and semantics.** The tool input schemas and HTTP view keys are unchanged, and a test
  pins them. `stopping` now also covers running cancel-pending tasks (a documented semantic
  widening).
- **Model-visible text.** The new TaskOutput and TaskStop strings are tool results, which are
  recorded in the log and replayed from it. `supervision_lost` is a new key in the `LOST_REASONS`
  render map, used only by new events. Old logs render byte for byte the same, so no DriftReason is
  needed. `reconstruct.test.ts` and `rename-compat.test.ts` pass.

## Test runs (this review, `CAPYBARA_TEST_WORKERS=2 CAPYBARA_TEST_CONTAINER_STARTS=2`, small batches)

| Batch | Files | Result |
|---|---|---|
| `managed-output` + `evals/reconstruct` + `tools/rename-compat` | 3 | 90 passed |
| `managed-consumers` + `managed-launch` | 2 | 53 passed |
| `--project kernel-container permission-lifetime.dual` | 1 | 6 passed |
| remaining `test/background/*` (http, launch, managed-artifact, poll-providers, poll.dual, poll, store, wake, tail-script) | 9 | 86 passed |
| `tools/sandbox/task-output`, `sandbox/operation-scopes.dual`, `sandbox/permission-wiring` | 3 | 40 passed |
| `tsc -b packages/kernel` | | clean |

Total: 18 files, 275 tests passed, 0 failed.

## Re-review round 1 (fix commit `f263b7047` on top of `87886a276`)

Scope: `git diff 87886a276 f263b7047`, 13 files, +416/-58. The review stayed read-only.

**RED evidence.** I copied the worktree (without `.git`) into the scratchpad, linked its
`node_modules`, and reverted only the changed `packages/kernel/src` files to `87886a276`. The new
tests ran there against the old code.

### Verdict: CHANGES_REQUIRED (one new Important finding, I2; everything from round 0 is resolved)

### Status of round-0 findings

| Finding | Status | Where | New test RED on old code? |
|---|---|---|---|
| I1 | **Resolved.** For a task with a requested cancellation (`cancel-pending` or `cancelRequestedAt`), TaskOutput no longer settles from status. It settles through `stopper.stop(t,"revoked",signal,{reported:true})`, so the provider's claimed outcome decides. | `task-output.ts:666-684`, `:717`, `:724`, `:734` | **Yes.** Both integration tests are real REDs. "I1: a pending cancellation the device applied later ..." gives `Status: failed, exit code 143` on old code. "I1: a person's pending stop settled by a TaskOutput read ..." gives `status: failed` on old code. The new dual test ("a TaskOutput on one replica and a poll on the other ...") **passes on old code**, as the author said. It does not discriminate because whichever consumer wins the race decides the result. It is only a once-only guard, not the I1 RED. |
| M1 | **Resolved.** `unknown(id, executionId)` is fenced by `execution_id`. All five facade call sites pass `admitted.execution_id`. Only the reconcile job's orphan cleanup stays unfenced, which is correct there. | `operation-intents.ts:1043-1052`; `sandbox.service.ts:1040, 1411, 1428, 1450, 1468` | **Yes**, it gives `started-or-unknown`. The test calls the fenced method directly, so the call-site wiring is verified only by reading the code. |
| M2 | **Resolved.** A `not_running` instance that is not `suspended` is finished `lost` (`sandbox_gone`) through `finish` with the requester's `reported` and `stoppedBy`. A `suspended` instance stays owed. A lost managed finish keeps `launch_state='cancel-pending'` and does not touch the intent: a revoked intent keeps its owed revoke, and a `background-running` intent stays selectable. | `stop.ts:221-226` | **Yes** for the "destroyed" case, and it checks that the slot is freed and the intent is kept. The "suspended" case passes on old code; it is a guard. |
| M3 | **Resolved.** `lastLinesByRef` returns null when the tail is unavailable or fails, and `summaryLines` stores a labelled `[Last lines unavailable: ...]`. TaskStop shows that label instead of `[No output.]`. | `managed.ts:139-167`, `task-stop.ts:66-79,111-121` | **Yes** |
| M4 | **Resolved.** Scope denial maps to `no_access`. Unsupported, `DeviceProtocolError`, `ToolError`, timeout or abort, a bad ref and capacity all map to `read_failed`. The result is a 409, and a finished task still falls back to its finished event. | `tasks.service.ts:385-399` | **Yes** (old code returns 500) |
| M5 | **Resolved.** A tail error after the provider has claimed the stop no longer releases the claim; the stopped outcome stands and gets the labelled summary. | `stop.ts:204-206`, via `managed.ts:156-162` | **Yes** |
| M7 | Per-task status failures: **resolved** (`poll.job.ts:214-230`; a test is RED on old code). The cap on owed stops: **introduces I2** (below). | `poll.job.ts:186` | Status part: yes |
| M9 | **Resolved.** The revocation dual test now races `poller(a)` and `poller(b)`. The HTTP dual test now forces growth after both probes and asserts the endpoint N and the later delivery of `GROWN`. | `permission-lifetime.dual.test.ts:162,172-203` | n/a |
| M10 | **Resolved.** An acknowledged task stopped later gets the message "is being stopped". | `bash.ts:581-586` | **Yes** |
| M6, M8 | Deferred by the plan (8.4/8.5); still to be recorded in the 8.4 handoff. | | |

### Checks of the new behaviour

- **The `how.reported` option and the wake rules are correct.**
  - A stop applied by TaskOutput passes `reported:true`, so there is no wake; the TaskOutput
    result shows the end. A person's, a deletion's or an ended sub-agent's `stoppedBy` is still
    taken from `cancel_requested_by` (test: person, `stoppedBy: person`, no `ensure-run`).
  - A tool's pending stop settled by the poller (`why="revoked"`) has `reported=false` and wakes.
    A tool's immediate stop is `reported=true`.
  - A revocation's cancellation settled by the poller wakes; settled by TaskOutput it is reported.
  - The default (`how={}`) keeps the round-0 rule, so no other caller changed.
- **M2 settlement keeps the obligations.** The task is lost with `cancel-pending`, the intent is
  untouched and the slot is freed (test asserts `countRunning` is 0 and the intent is
  `background-running`).
- **The HTTP 409 mapping is acceptable.** Small nit: the kernel's own instance-handle mismatch
  (`managed.ts:93`) is shown to the person as `no_access`, though it is really a failed or rebuilt
  read. That is acceptable, but `read_failed` would describe it better.
- **The helper's `last_seq` change is sound and test-only.** `seq = max(local, conversations.last_seq) + 1`,
  then `last_seq` is written back. It only orders events the kernel appended meanwhile. It is not
  atomic, but the tests are single-writer at that point.
- **New model-visible text.** `LAST_LINES_UNAVAILABLE` is stored in the payload of new finish events
  and the M10 wording is a new tool result. Neither changes existing logs, so no DriftReason is
  needed. `reconstruct.test.ts` and `rename-compat.test.ts` pass. Minor: the English label also
  reaches the web through the HTTP event fallback as output text, not i18n. It is shown as captured
  output, so this is acceptable, but note it for the web follow-up.
- **Tail failures.** `lastLinesByRef` now swallows every non-abort tail error. A transient tail
  failure on the poller or TaskOutput path therefore stores the "unavailable" label permanently in
  the finish event. This is an acceptable trade-off: the end is the authoritative fact.

### New finding

**I2 (Important): the per-tick cap of 8 owed stops is not fair. Stuck entries at the head starve
newer owed cancellations for as long as they stay stuck.**
`poll.job.ts:186` takes `cancels.slice(0, MANAGED_STOPS_PER_TICK)` from `runningManaged()`, which is
ordered `started_at, id` ascending. These entries all stay `running` / `cancel-pending` and unclaimed,
so they return at the head of the list on every tick:

- a task on a **suspended** instance (`stop.ts:224` returns `pending()`);
- a task whose device provider is unavailable (`continue` without an attempt);
- a task whose stop throws every time (claim released).

Each still takes one of the 8 slots.

Failure scenario: a revocation turns tasks on a cloud device into `cancel-pending`, and the instance
is then idle-suspended, leaving 8 or more such tasks. From then on, no newer owed cancellation on
any other device is settled by the poller until those instances are resumed or destroyed.

What still happens: the revoke worker still sends `revokeOperation`, so device-side work is
cancelled, and a TaskOutput read can still settle a task. What is starved: the kernel's settlement.
The newer tasks stay `running/stopping`, hold `maxTasks` slots, and owe no finish or wake.

Fix (any of these):

1. Filter out entries that cannot progress before applying the cap: an unavailable provider, or a
   recorded instance whose `device_instances.status` is `suspended` (a join in `runningManaged`, or
   a prefilter). Count only attempts that reached the provider.
2. Rotate fairly. For example, order by the time of the last attempt: release the claim with
   `stopping_at` set to a past "attempted" marker, or use a tick-indexed offset.
3. Bound the tick by elapsed time rather than count, and continue from where the previous tick
   stopped.

Add a test: 8 owed stops on a suspended instance plus one on a running instance; one poll must
settle the running one.

### Test runs (re-review, `CAPYBARA_TEST_WORKERS=2`, small batches)

| Batch | Result |
|---|---|
| Fixed code: `managed-consumers`, `managed-launch`, `managed-output`, `tools/sandbox/task-output` | 4 files, 99 passed |
| Fixed code: `--project kernel-container` `permission-lifetime.dual`, `poll.dual` | 2 files, 8 passed |
| Fixed code: background http, poll, poll-providers, store, wake, launch, managed-artifact; `sandbox/operation-scopes.dual`; `evals/reconstruct`; `tools/rename-compat` | 10 files, 153 passed |
| `tsc -b packages/kernel` | clean |
| Old code (src at `87886a276`) with new tests: `managed-consumers -t "fix round 1"` | 8 failed (I1×2, M2 destroyed, M3, M4, M5, M7, M10), 1 passed (M2 suspended guard) |
| Old code: `managed-launch -t "stale dispatcher"` | 1 failed (M1) |
| Old code: `permission-lifetime.dual` | 7 passed (the new I1 dual test does not discriminate) |

## Re-review round 2 (fix commit `86b893203` on top of `f263b7047`)

Scope: `git diff f263b7047 86b893203`, 9 files, +180/-16. The review stayed read-only.

**RED evidence.** As in round 1, I copied the worktree into the scratchpad, reverted only the
changed `packages/kernel/src` files to `f263b7047` (this includes the 0144 migration, so the
`cancel_attempted_at` column does not exist there), and ran the new tests against the old code.

### Verdict: APPROVE (I2 resolved; one new Minor finding, M11, does not block)

### I2: resolved

- **Separate query for owed stops.** Acknowledged tasks still come from `runningManaged()` (now
  `acknowledged` only). Owed stops come from a separate `owedCancels()` (`store.ts:~511-530`), which
  returns tasks that are running, `cancel-pending`, with a ref and no live claim. It is ordered
  `cancel_attempted_at ASC NULLS FIRST, started_at, id`.
- **Suspended instances are excluded**, when the device's instance is suspended *and* has the
  task's recorded generation. Such a task cannot progress there, because a stop never resumes an
  instance. The left join is safe because `device_instances` has one row per device (pkey). A
  suspended instance of *another* generation is kept, and the stopper settles it as `RECREATED`.
- **The rotation is persisted in PG.** `noteCancelAttempt` (`store.ts`) sets
  `cancel_attempted_at = now()`. The stopper calls it *after* winning `claimStop` and validating the
  ref, and *before* `ifRunning` (`stop.ts:~203`). So every attempt that reaches the instance or
  provider moves the task to the back, whether it succeeds, stays pending or throws.
- **The cap counts only attempts that reach a provider.** `attempts++` comes after the
  `availableFor` check (`poll.job.ts:~192-198`). A task whose provider is not loaded is skipped
  without using a turn.
- **Safe across two replicas.** `claimStop` is the single conditional row update that picks one
  stopper per task, and only that stopper writes `cancel_attempted_at`. The write is a standalone,
  committed `UPDATE` (not inside the finish transaction), so it is durable even when the stop then
  throws. A replica that loses `claimStop` writes nothing, and its loop still counts the attempt.
  That only lowers its own tick's throughput; nothing becomes incorrect. Concurrent `now()` writes
  are last-writer-wins, which is harmless for ordering.

### Starvation and livelock

- **A stop that always throws** is bumped on every attempt and rotates behind the others. That is
  fine, and a test covers it.
- **Tasks that are never attempted:**
  - a task on an unloaded provider (until the provider loads; it uses no turn);
  - a task on a suspended instance of the same generation (until the instance resumes or is
    replaced);
  - a task whose stored ref is malformed (skipped with a warning; this predates round 2 and was
    reviewed in round 0).

  All three are intended. None of them holds a turn, so newer owed stops progress.

  Each tick still loops over the whole owed list and runs one `availableFor` query per skipped
  row. That cost is O(owed) per tick but bounded, so it is acceptable.
- **No livelock.** An owed stop that the provider keeps answering with `cancel-pending` rotates
  normally.

### Other changes

- **`ManagedInstanceMismatchError` now maps to `read_failed`** (`managed.ts:33-38,100`;
  `tasks.service.ts:~395`). The HTTP answer is a 409 with `read_failed`, and a finished task still
  falls back to its finished event. In TaskOutput and TaskStop the error becomes a generic,
  retryable `ToolError` ("could not be read" / "could not be stopped ... Retry"), and the poller only
  warns. This is correct and matches what I suggested in round 1. RED: the extended M4 assertion
  fails on old code (`no_access`).
- **Migration 0144 edit** (`ADD COLUMN IF NOT EXISTS cancel_attempted_at timestamptz`). It is
  idempotent and expand-only. 0144 is not on `origin/main` or on the integration branch, so editing
  the file before it is ever applied is allowed. `check:applied-migrations --base origin/main` and
  `--base docs/conversation-permission-profiles` both pass, and so does `check:migrations`. The
  change is mirrored in `kernel-schema.ts`.

### New test REDs on old code (src at `f263b7047`)

| Test | Old code |
|---|---|
| "owed stops on a suspended instance never hold back one on a running instance" | FAIL (the task is still running: 9 suspended clones take the 8 slots) |
| "a stop that keeps failing rotates behind the others instead of holding the head" | FAIL |
| M4 (extended: the instance mismatch gives `read_failed`) | FAIL (`no_access`) |

The suspended-instance test checks the exclusion itself: with rotation alone, the 8 suspended
clones would still use up the first tick.

### New finding

**M11 (Minor): the suspended exclusion compares generations with a *rounded* millisecond value, so
it misses about half of real instances.**
`store.ts` `owedCancels` compares
`(extract(epoch from device_instances.created_at) * 1000)::bigint::text` with
`background_tasks.instance_generation`. That generation is `created_at.getTime()` on the JS side,
truncated to milliseconds. `device_instances.created_at` is written with `now()`
(`sandbox.service.ts:2376`), which has microsecond precision, and `::bigint` rounds.

I checked this on Postgres 17: `.123789 s` gives `…124` with `::bigint` but `…123` with `floor`.
So whenever the sub-millisecond part is 0.5 ms or more, the suspended task is not excluded.

Effect: the task is still attempted, counted against the cap and rotated, so there is **no
starvation**. The exclusion is simply ineffective for about half of the instances, and a suspended
backlog then still uses up turns, delaying other owed stops by a few ticks. The test misses this
because it inserts `created_at` with exact milliseconds (`MANAGED_GENERATION`).

Fix: `floor(extract(epoch from device_instances.created_at) * 1000)::bigint`, or compare
`date_trunc('milliseconds', created_at)` with the generation converted to a timestamp. Add a test
with a microsecond `created_at` (for example `…123789`).

### Test runs (re-review round 2, `CAPYBARA_TEST_WORKERS=2`, small batches)

| Batch | Result |
|---|---|
| `managed-consumers`, `managed-launch`, `poll-providers`, `store`, `poll` | 5 files, 105 passed |
| `--project kernel-container` `permission-lifetime.dual`, `poll.dual` | 2 files, 8 passed |
| `background.http`, `tools/sandbox/task-output`, `managed-output` | 3 files, 49 passed |
| `tsc -b packages/kernel` | clean |
| `check:migrations`; `check:applied-migrations --base origin/main` and `--base docs/conversation-permission-profiles` | passed |
| Old code (f263b7047 src) with new tests: `-t "fix round 2\|M4"` | 3 failed (all intended REDs) |
