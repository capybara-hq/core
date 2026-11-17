# Task 8.3 report: task consumers, cursor and exact completion

Status: DONE_WITH_CONCERNS. Commit `87886a276` on `perm/t8-3`
(worktree `/Users/grant/Capybara/core/.claude/worktrees/perm-t8-3`, based on `4c7a69a89`). Not
pushed, no PR. Protocol 2 stays active, nothing is activated, and the managed launch is still not
wired into the Bash tool. Legacy SID tasks take their old code path unchanged: every new branch
checks `launch_state <> 'legacy'`.

## What was built

- **`background/managed-output.ts`** (pure, unit-tested). It implements the small-frame algorithm
  from the design (§B5):
  - `probeOutput` reads the metadata total N with a zero budget.
  - `readOutputRange` reads adjacent ranges at the next unread offset, each with a budget of at
    most min(65,536, end − pos). It rejects these answers:
    - a wrong offset, data longer than the budget, or an inconsistent `nextOffset`;
    - a total that went down (reported as `lost`, never EOF);
    - a read that returns 0 bytes while bytes remain (`ManagedOutputCapacityError`, deterministic).
  - `assembleTaskOutput` (TaskOutput):
    - re-reads the history `[max(0,R−4096),R)`;
    - assembles fresh windows of `clamp(budget, 4, 61,440)` bytes up to N or the tool budget;
    - fetches the adjacent bytes needed to finish a character cut by the window, even when the
      capacity is under 4 bytes;
    - on a live stream, delivers only whole characters;
    - at a verified terminal end, delivers every remaining byte with replacement decoding and
      advances by the raw byte count;
    - treats R > N as unavailable (`mismatch`);
    - computes remaining as max(N − delivered, 0).
  - `assembleOutputSuffix` (HTTP): reads every byte of `[max(0,N−B),N)` and keeps N as the end
    even when the output grows. It drops only a leading partial character and applies no line cap.
  - `lastLinesOf`: the last 20 lines, at most 4,000 characters.
- **`background/managed.ts`**:
  - `exactRefOf` validates the stored ref against the row's own operation, instance id and
    generation, and the generation's digits. On a mismatch it raises `ManagedRefError`, and the
    ref is never used.
  - `onManagedInstance` uses `ifRunning` on the exact recorded generation only, so it never
    creates, resumes or rebuilds an instance. The held handle must match `ref.instanceId`. It uses
    only `SandboxBackground`: no exec, no path, no scope.
  - The status and stop result mappings (`already-exited`, `stopped`, `cancel-pending` → no
    finish, `lost` → `supervision_lost`).
  - The exact tail summary and the positional reader.
- **TaskOutput** (managed branch):
  - Load the row (own conversation and org only), check the device again, then validate the ref.
  - The blocking wait checks status by exact ref; the timeout and the run budget are kept.
  - Status is read *before* the probe, so a terminal end is established first.
  - The cursor advances by exactly `delivered.length` (`advanceOffset` only moves forward).
  - The login-code parser reads history plus the new text.
  - Lost, expired or mismatched output moves nothing. For a finished task the answer then shows
    the labelled finish-event summary ("Last lines recorded when the task finished (not new
    output)"). No bytes are made up.
- **HTTP** (`tasks.service.readManaged`): an acknowledged managed task is now read live by exact
  ref instead of being reported as "starting". Existing access is kept: the conversation or an
  ancestor, the org, the device owner and provider availability. Lost or expired output maps to
  the existing `output_missing` reason, then the event fallback; a capacity error or bad ref maps
  to `read_failed`. `stopping` is true for `cancel-pending` tasks.
- **Stopper (M6)**: managed rows are now actually stopped by exact ref with a 5 s grace.
  - `already-exited` → the natural exit; `stopped` → stopped; `lost` → lost (uncertain).
  - `cancel-pending` → no event. The task stays running in `cancel-pending`, the claim is
    released, and the requester is recorded.
  - Instance not running → the cancellation stays owed. Other instance → lost.
  - No ref yet → the claim and the requester are kept, so the binding or acknowledgement
    settles it.
- **Poller**:
  - Acknowledged tasks: one lease per exact instance; status by ref; on an end, finish with the
    exact tail (`reported=false`; the durable `ensure-run` outbox entry is owed).
  - `cancel-pending` tasks with a ref: the owed exact stop runs through the stopper with reason
    `revoked`, which settles M6 "cancel-pending must reach terminal".
  - Malformed refs are skipped with a warning. Unavailable providers are left alone.
- **Finisher**: finishes stay one conditional update plus the event in a single transaction. For a
  managed task it locks the intent row before the task row (the authority writer's order).
  - Verified end → `launch_state='terminal'`, and the intent moves from `background-running` to
    `completed` (no longer selected for revocation).
  - Lost → `launch_state='cancel-pending'` and the intent is kept (the obligation survives).
- **Pruning**: only `legacy` or `terminal` rows are deleted, so uncertain launch or cancel records
  survive ordinary output pruning.
- **Migration `0144_background_cancel_requester.sql`** (needed). It adds `cancel_requested_by`.
  A stop that cannot settle at once is finished later by another path (poller or acknowledgement),
  and that finish must keep the wake rule of whoever asked. Without the column, a person's, a
  deletion's or an ended sub-agent's pending stop would wake the conversation when it settled.
- **8.2 R1**: `claimReconciliation` now leaves a `backgroundStart` in `dispatching` under the
  retry's holder, so scheduled recovery defers. Only `unknown()` or `revokeHolders` hand it over.
- **8.2 R2**: `claimReconciliation` locks the task row. If the task was stop-claimed or
  cancel-requested, or is no longer running and dispatched, it revokes with `outcome_unknown`,
  owes the `-retry` revoke and marks the task `cancel-pending`. The facade then throws
  OutcomeUnknown, not "nothing was started".
- **Shared stop condition**: dispatch binding, acknowledgement, recovery and retry all treat
  `cancel_requested_at IS NOT NULL` like a live stop claim. The acknowledgement's cancel-pending
  update clears `stopping_at`, so the poller owes the stop at once.
- **Bash managed retry**: a retry of a call whose acknowledged task has since ended reports the
  start it made. It no longer reports "not started", which would have been a regression once
  finishes set `terminal`.
- **TaskList**: a managed task without a ref shows no output path. The path is advertised only
  after acknowledgement.
- **render**: a new `supervision_lost` lost-reason text. It is used only by new events, so old
  events render byte for byte as before.

## Gates: RED → GREEN

Logs are in the scratchpad `/private/tmp/claude-501/-Users-grant-Capybara-core/3c06d80f-5364-4c73-8472-47a47fd00814/scratchpad/t83/`.

| Gate | Test (file) | RED | GREEN |
|---|---|---|---|
| B5: capacity below, equal and above 4096 (1, 2, 3, 3072, 4095, 4096, 4097, 65536); adjacent offsets; no overlap loop; exact cursor; bounded memory | managed-output.test.ts | 27/27 assertion failures against a stub (`red-output.log`) | 27/27 |
| B5: 1–4-byte boundary capacities, terminal incomplete bytes, stale or renegotiated lower capacity, zero capacity, total regression, expired, malformed answers, suffix through growth, window > 61,440, repeated identical bytes, split login prompt | managed-output.test.ts | same | ✓ |
| 200 KiB burst and >20 lines before the first read, at capacity 3072 | managed-consumers | `red-consumers.log` (23/26 failed: exec fallback / 409 / no exact stop) | ✓ |
| Disconnect mid-read: no cursor move, retry from the same byte | managed-consumers | ✓ RED | ✓ |
| Split live character withheld; login code split across reads | managed-consumers | ✓ RED | ✓ |
| Terminal invalid bytes consumed by raw count; one reported finish; no wake; intent completed | managed-consumers | ✓ RED | ✓ |
| Expiry, and lost output with the labelled event fallback (no cursor progress) | managed-consumers | ✓ RED | ✓ |
| Malformed generation or ref: zero provider calls; poller skips | managed-consumers | ✓ RED | ✓ |
| Cross-conversation (tool) and cross-org (HTTP 404); HTTP ancestor reads a sub-agent task | managed-consumers | ✓ RED | ✓ |
| Unavailable device provider (HTTP 409 `unavailable`; poller leaves the task) | managed-consumers | passed on base (pre-existing guard) | ✓ |
| Suspended instance never resumed; lost with the record retained past pruning | managed-consumers | ✓ RED | ✓ |
| TaskStop: exact ref with 5 s grace and 20 lines; already-exited ≠ stopped; cancel-pending writes no event and settles once later; a person's pending stop never wakes; lost keeps the uncertainty and the intent | managed-consumers | ✓ RED | ✓ |
| Revocation's cancel-pending task with a ref → terminal via exact stop, wake owed; stop before ref → acknowledgement → poller settles | managed-consumers | ✓ RED | ✓ |
| Poller exit → one finish with tail, durable `ensure-run` owed; terminal rows prune | managed-consumers | ✓ RED | ✓ |
| HTTP suffix ends at N through growth; no 20-line cap; cursor untouched | managed-consumers | ✓ RED | ✓ |
| Tool and HTTP schemas plus status semantics compared explicitly (input schemas, view keys, running not "starting") | managed-consumers | passed on base for the schema half; "running" half RED | ✓ |
| Retry of a finished task's call reports its start | managed-consumers | `red-retry-finished.log` (ToolError "not started") | ✓ |
| 8.2 R1: retry in flight is not taken over by recovery | managed-launch | `red-r1r2.log` (`started-or-unknown` ≠ `dispatching`) | ✓ |
| 8.2 R2: retry after stop claim starts nothing and owes the revoke | managed-launch | `red-r1r2.log` (2 starts) | ✓ |
| Concurrent replica reads, finishes, stops and revocation; HTTP on one replica while the other finishes | permission-lifetime.dual.test.ts (2 in-process kernels, one PG and Redis, barriers) | `red-dual.log`: 5/6 failed against base sources | 6/6 |
| Cross-replica recovery vs in-flight dispatch | same | passes on base (8.2 fix round already covers first dispatch); kept as a guard | ✓ |

Ordering caveat: the dual test and the "retry of a finished call" test were written after their
code. Their RED was produced by temporarily reverting the source (logged above), not by writing
the test first. Every other gate was written and run RED before its implementation.

Updated existing tests:
- `managed-launch` deletion test: the deletion's own stop now actually applies the exact
  cancellation (terminal `stopped`, `stoppedBy: deletion`) where it used to claim and skip.
- `store.test` round trip (new fields).
- `poll-providers` (new constructor argument).

## Commands (worktree root)

- `CAPYBARA_TEST_WORKERS=4 pnpm exec vitest run packages/kernel/test/background packages/kernel/test/tools/sandbox/task-output.test.ts`:
  15 files, 189/189 passed.
- `CAPYBARA_TEST_WORKERS=4 CAPYBARA_TEST_CONTAINER_STARTS=2 pnpm exec vitest run` on poll.dual,
  permission-lifetime.dual, local-device-gateway.dual, network-ask.dual, oauth.dual and
  read-before-write.dual: 6 files, 13/13 passed.
- Integration files that failed in the big combined run (permission-wiring, sandbox.service,
  approvals.http, drift, pipeline, sandbox-tools, send-message, task-tools): 8 files, 280/280
  passed when run on their own.
- One combined run of `test/background test/tools test/local-devices test/sandbox` (134 files,
  every dual suite together) gave 2,739 passed and 17 failed. All 17 were timeouts or timing
  failures (tests running 200–1,300 s, `6008 < 6000`) from machine contention with every
  container suite at once. All of them pass when rerun in smaller batches as above. That run is
  not clean evidence. I did not rerun all 134 files at once.
- `pnpm test:unit`: 128 files, 1415/1415 passed.
- `pnpm typecheck`: clean.
- `pnpm check`: all passed, after rewording one ToolError the tool-design check flagged.
- Biome on all touched files: 0 errors and 0 warnings.
- Kernel changeset: `.changeset/managed-background-consumers.md`.

## Files

New: `src/background/managed.ts`, `src/background/managed-output.ts`,
`src/migrations/0144_background_cancel_requester.sql`, `test/background/managed-output.test.ts`
(unit list), `test/background/managed-consumers.test.ts`,
`test/background/permission-lifetime.dual.test.ts` (container list),
`test/helpers/managed-background.ts`.

Changed: `src/background/{finish,poll.job,render,stop,store,tasks.service}.ts`,
`src/db/kernel-schema.ts`, `src/sandbox/{operation-intents,sandbox.service}.ts`,
`src/tools/builtins/sandbox/{bash,common,task-list,task-output,task-stop}.ts`, the tests above,
and `test/{unit-tests,container-tests}.json`.

## Concerns and deferred items (owning phase)

1. **Exact cancel boundary (8.4).** The revoke worker still calls `revokeOperation`. The exact
   `background.stop` for a revoked or `cancel-pending` task now runs from the poller through
   `BackgroundTaskStopper` (reason `revoked`). That was the smallest change that makes
   cancel-pending reach a terminal state with a precise outcome. Switching the revoke worker to
   branch on backgroundStart and call exact stop, plus B3 selectors and the call-grant lookup,
   remain 8.4.
2. **Lost or uncertain obligations are retained, not resolved (8.4/8.5).** A lost finish (supervision
   lost, suspended or replaced instance) keeps `launch_state='cancel-pending'` and keeps a
   `background-running` intent, so revocation writers still select it. Nothing yet retires these;
   retirement and quarantine are 8.5.
3. **Suspended managed instance.** TaskOutput and the poller finish the task as lost
   (`sandbox_suspended` or `sandbox_gone`), as the legacy path does. The stopper instead leaves the
   cancellation owed. Applying a stop on resume is the provider's or 8.5's job.
4. **HTTP reason mapping.** Lost or expired retained output reuses the existing `output_missing`
   reason, and a capacity error reuses `read_failed`, so the web enum and i18n are unchanged.
   Distinct reasons would need a web change.
5. **Model-visible text.** There is a new lost-reason text (`supervision_lost`) and new
   TaskOutput/TaskStop wording for managed-only states. Old events render unchanged. Flagging it
   for Task 9's rendering ownership.
6. **Wake for a tool's pending stop.** When a tool's stop returned `cancel-pending` and is settled
   later, the finish is `reported=false` and wakes the model, which by then had only been told
   "stop requested". This is intentional; review if a different rule is wanted.
7. **Retained authority after a verified finish.** The intent moves to `completed` with a null
   result. A same-call retry then returns the recorded task (covered by a test).

## Fix round 1 (independent review CHANGES_REQUIRED)

Commit `f263b7047`, on top of `87886a276`. Each behaviour change was RED first. The logs are in the
scratchpad `t83/` directory: `fr1-red.log`, `fr1-red-m1.log` and `fr1-red-m7.log`.

| Finding | Change | RED → GREEN |
|---|---|---|
| I1 | TaskOutput no longer settles a `cancel-pending` (or cancel-requested) task from its status. It still reads to the end, but the finish goes through `stopper.stop(task, "revoked", signal, {reported: true})`, so the provider's claimed `stopped` or `already-exited` outcome and the requester's `stoppedBy` hold. The stopper gained an optional `how.reported`. | Two consumer tests: an applied cancellation then a blocking TaskOutput, where RED was "failed, exit code 143"; and a person's pending stop settled by TaskOutput, where RED had no `stoppedBy`. A dual test covers TaskOutput on A racing the poller on B: exactly one finish, `stopped`. That dual test passed on the base, because the ordering was not forced. |
| M1 | `unknown(id, executionId)` is now fenced on `execution_id`, and all five facade callers pass the admitted execution. The reconcile job's orphan cleanup stays unfenced. | managed-launch "stale dispatcher's unknown": RED was `started-or-unknown` ≠ `dispatching`. |
| M2 | When the instance is not running during a managed stop: a suspended instance keeps the cancellation owed. Any other state (gone, destroyed) finishes the task `lost/sandbox_gone`, keeps `cancel-pending` and the intent, and frees the slot. | Destroyed: RED, then GREEN. The suspended test passed on the base (a regression guard). |
| M3 | `lastLinesByRef` returns null for an unavailable tail or a failed tail read. Finishes then store the labelled `LAST_LINES_UNAVAILABLE`, and TaskStop prints that text instead of `[No output.]`. | RED, then GREEN. |
| M4 | HTTP `readManaged` maps `SandboxScopeDeniedError` (including the kernel's instance mismatch) to `no_access`. It maps Unsupported, `DeviceProtocolError`, `ToolError`, timeout/abort, a bad ref and capacity errors to `read_failed`. The answer is a 409, or the finish-event fallback for a terminal task. | RED was a 500, then GREEN. |
| M5 | A tail error after the provider claimed the stop outcome no longer releases the claim. The task settles with its outcome and the labelled summary. | RED (a ToolError, "keeps running"), then GREEN. |
| M7 | Each task's status read on an instance is caught separately and logged, then retried on the next tick. Owed stops are capped at `MANAGED_STOPS_PER_TICK` = 8 per tick, oldest first. | Isolation: RED "expected 0 to be 1", produced by reverting `poll.job.ts`. The cap has no dedicated test, because it needs more than 8 concurrent tasks above the fixture's `maxTasks`. |
| M9 | The revocation dual test now races `poller(a)` against `poller(b)`. The HTTP dual test forces growth between both probes and the range reads, and asserts the growth is absent from both answers and present in the next read. The I1 dual test was added. | GREEN. |
| M10 | A Bash retry for an acknowledged or ref-attached task that is now `cancel-pending` says "is being stopped … while or after it started". The no-ref case keeps "stopped while it was starting". Two existing ref-case assertions were updated to match. | RED, then GREEN. |

Also fixed:
- The helper's event `seq` now follows `last_seq`, so a second launch in one run works.
- Six `noUnsafeOptionalChaining` errors and one unused import in my tests from round 0. The
  round-0 report said "Biome 0/0", which was wrong for these test files: my Biome file list had
  missed them.

Not done, as instructed: M6 (lost-record discharge, now an explicit 8.4/8.5 handoff item, along
with the hard-delete cascade note) and M8 (no partial prefix on abort at capacity C near 1; recorded
only). Also worth stating for the PR (M1): a dispatcher that dies on the retry path leaves the
intent `dispatching` until `revokeHolders` or retention expiry. The first-dispatch path has the same
bound.

Verification, all with `CAPYBARA_TEST_WORKERS=2` in small batches:
- `permission-lifetime.dual` + `poll.dual`: 8/8 passed.
- `managed-consumers` + `managed-launch`: 63/63 passed.
- `background.http`, `launch`, `poll`: 52/52 passed.
- The remaining background files (wake, store, poll-providers, tail-script, managed-artifact,
  managed-output, macos-device): 68/68 passed.
- `tools/sandbox/task-output` + `tools/task-tools`: 38/38 passed.
- `evals/reconstruct` + `tools/rename-compat`: 63/63 passed.
- `operation-scopes.dual` + `permission-wiring`: 31/31 passed.
- After the lint fix, I re-ran the two changed test files: 43/43 passed.
- `pnpm test:unit`: 1415/1415 passed.
- `pnpm typecheck`: clean.
- `pnpm check`: all checks passed.
- Biome on every file the two commits touched: clean.

## Fix round 2 (re-review round 1: I2 plus two notes)

Commit `86b893203` on top of `f263b7047`. Every change was RED first; the log is the scratchpad
file `t83/fr2-red.log`.

| Item | Change | RED → GREEN |
|---|---|---|
| I2: owed-stop starvation | The poller now separates the two kinds of managed rows. Acknowledged rows come from `runningManaged()`. Owed stops come from the new `owedCancels()`: running `cancel-pending` rows with a ref and no live claim. `owedCancels()` leaves out any row whose recorded instance (the same generation) is `suspended`, because a stop never resumes an instance and so could not progress there. Rows are ordered by `cancel_attempted_at` (NULLS FIRST), then `started_at` and `id`. Each managed exact-stop attempt now records `cancel_attempted_at` (`noteCancelAttempt`) before it calls the provider, so the order is persisted rather than kept in process memory. The per-tick cap of 8 counts only attempts that reach a provider; a task whose provider is not loaded takes no turn. | Two new tests: 9 owed stops on a suspended instance plus 1 on a running instance, where one poll settles the latter; and 9 always-throwing stops ahead of 1 good one, settled within 2 polls. Both were RED (the task stayed running). |
| Instance-handle mismatch | The kernel's own handle mismatch now raises `ManagedInstanceMismatchError`, which HTTP maps to `read_failed`. Provider scope denials still map to `no_access`. | The M4 test was extended to assert `"reason":"read_failed"`. It was RED: the mismatch was reported as `no_access`. |
| HTTP fallback text | No i18n key was added. In `apps/web` (`BackgroundSection.tsx` `outputProps` and `unavailableOf`), the primary message is the i18n'd `unavailable.reason`. The event's `lastLines`, including the English `LAST_LINES_UNAVAILABLE` label, appear only inside the output block as captured output, like any other task output. If the web ever shows that text as a status message, it will need a key. | n/a |

Migration 0144 gains `cancel_attempted_at timestamptz` (IF NOT EXISTS). 0144 exists only on this
unmerged branch and has never been applied, so editing it is allowed, and
`check:applied-migrations --base 4c7a69a89` passes.

## Verification

All runs used `CAPYBARA_TEST_WORKERS=2` and small batches.

| Batch | Tests |
|---|---|
| `permission-lifetime.dual` + `poll.dual` | 8/8 |
| `managed-consumers` + `managed-launch` | 65/65 |
| `background.http` + `launch` + `poll` | 52/52 |
| The other 7 background files | 68/68 |
| `task-output` + `task-tools` | 38/38 |
| `reconstruct` + `rename-compat` | 63/63 |
| `operation-scopes.dual` + `permission-wiring` | 31/31 |
| `pnpm test:unit` | 1415/1415 |

`pnpm typecheck` is clean, `pnpm check` passes all checks, and Biome is clean on every file touched
since `4c7a69a89`.
