# Conversation logic review 2026-11-15

- core HEAD: `234632032205ea26e94639cd8611adafb74312dd`
- plugins HEAD: `1bcc5583f3f517619fed9755abcf456167b1a1d4` (baseline only; not reviewed)
- previous review: `2026-11-14-design-review.md` (core `6e9ddb4d2`)
- scope: conversation HTTP/access, lifecycle/recovery, model context/compaction, SSE and web consumers
- method: parallel read-only review followed by primary-reviewer source verification; no product changes
- validation: two source-function reproductions with Node's TypeScript stripping; no integration or
  fault-injection tests. Vitest could not start: this checkout has no installed dependencies
  (`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL: Command "vitest" not found`).

## Remediation — 2026-11-16

The original review below is preserved as baseline evidence. The eight requested findings have
implementations and regression coverage in this worktree. Final branch verification passed;
the original source-only review below must not be read as an integration test result.

Design: `docs/superpowers/specs/2026-11-15-conversation-reliability-design.md`.
Plan: `docs/superpowers/plans/2026-11-15-conversation-reliability.md`.
The user approved the design and clarified that maintainer contribution review does not require
repeated approval of local execution steps. The user subsequently authorized pushing, creating a PR
and merging it through the PR once verification and checks pass.

| Finding | Implementation | Regression evidence |
|---|---|---|
| run-lock-no-fencing | Unique Redis acquisition and quota tokens; persisted PG claim; scoped transaction fence; fenced dispatch, checkpoints, run transitions and cleanup; immediate lease-loss cancellation | Same-run late release failed before fix. Two independent workers now exercise takeover while A is paused: old tool/log/checkpoint writes fail, B's checkpoint/quota survive, and B executes the real counter tool once. Covered in `runtime/conversation-lock.test.ts`, `runtime/run-worker.test.ts`, `runtime/waits-dual.test.ts`. |
| org-deletion-does-not-stop-runs | Platform-owned cleanup obligation survives org outbox purge; active runs finish and revoke claims, cancellation is owed separately; starts/resumes reject deleted orgs; recovery settles deleted runs | Queued-job deletion and absent-cleanup recovery both failed before fix. In-flight model cancellation and waiting approval cleanup pass. `runtime/queued-abort.test.ts`, `runtime/run-orphan-check.test.ts`. |
| conversation-delete-misses-new-root-run | Mark under conversation row lock before cleanup; same direct/durable deleted-tree cleanup terminalizes root and descendants, revokes claims and owes cancellation | Idle-root race originally accepted POST 202 during deletion; now 404. Live-root/approval/child cleanup and deletion backstop covered by `conversations/archive.http.test.ts`, `runtime/subagents/cancel.test.ts`. |
| partial-selection-lost-update | Read latest selection under message row lock and compare the validated snapshot; revalidate outside transaction when it changed; three attempts then actionable 409 | HTTP gate reproduced effort-only send restoring default model; fixed selection retains new model and effort. Committed duplicate is returned before revalidation. `runtime/model-switch.test.ts`. |
| truncated-analysis-becomes-summary | Remove closed and unterminated analysis before extracting summary; empty summary uses existing failure path | Unit cases and real `max_tokens` model-step case failed before fix; raw context survives and no summary is stored. `runtime/context/compaction.test.ts`, `runtime/model-call.test.ts`. |
| sse-missed-notification-never-catches-up | Successful access recheck serially reads at most one 500-event PG page; no duplicate periodic backlog | Missing-hint unit case failed before fix. Actual Redis subscriber disconnect/reconnect loses terminal hint and stream still converges. Bounded pages and revoked access covered by `runtime/stream.test.ts`, `runtime/stream.http.test.ts`. |
| orphan-scan-starvation | Shared PG cursor preserves full timestamp precision and advances across bounded passes, wrapping at end | 5,001 healthy candidates hid the orphan on both original passes; cursor repair reaches it on next pass. `runtime/run-orphan-check.test.ts`. |
| dead-outbox-row-leaves-run-stuck | Dead current-generation delivery visibly fails the run and consumes its trigger; pending retry wins; admin retry advances delivery generation under conversation lock | Dead delivery stayed queued before fix. Explicit user retry completes, admin re-delivery does not resurrect terminal run, and two historical dead rows plus concurrent delivered retry do not fail live work. `runtime/run-orphan-check.test.ts`, `admin/outbox-dead.test.ts`. |

Independent review found additional boundaries in the implementation; each was reproduced and fixed:
read-only PG snapshots skip the locking fence; org admission follows the existing `NO KEY UPDATE`
authorization order before conversation locks; a lost acquisition is checked again after claim lock
waits; and delivery-generation changes invalidate stale scans even after the relay deleted a retry.
No Redis call was moved into a business transaction.

Operational limits: dispatched third-party effects cannot be recalled. Started calls with unknown
results retain the existing no-automatic-replay semantics. Fenced write transactions serialize
briefly per org; model/tool network calls remain outside those transactions. Dead acquisitions can
occupy their quota slot until its existing TTL. The ninth compaction absorption-boundary concern
was not changed or claimed fixed.

Validation: `CAPYBARA_TEST_WORKERS=4 pnpm -s verify --json` returned `ok: true`: lint, typecheck,
custom checks, commitlint and affected tests passed. E2E and Docker are delegated to CI by that
command. Separate Web validation passed 182 files / 3,377 tests; i18n passed. Zero-drift fixtures
passed 62/62 before and after changes. Actual takeover and SSE files passed 24/24; the final
ownership/deletion regression group passed 30/30; updated latency/outbox/provenance passed 20/20.
Lint retains 28 existing warnings and two informational diagnostics, with no errors. Separate
cursor-row deletion, insertion-before-cursor and process-restart scenarios were not individually
tested; persisted continuation and end reset are covered by the >5,000-candidate regression.

## Themes

1. Durable state is stronger than execution ownership. Run creation and completion use transactions
   and the outbox, but deletion and lease expiry do not consistently revoke an executing worker.
2. Context transformations need the same boundaries as message absorption. Compaction output must
   be usable before replacing history, and its input must not include future run input.
3. Recovery assumes another event or a small candidate population. Missing notifications, dead
   deliveries and bounded scans can leave a conversation stuck indefinitely.

## Findings

### run-lock-no-fencing: a worker can execute tools after losing its conversation lease

- status: recurring (4th report, first seen in `2026-11-12-design-review.md`)
- severity: high (previous report: medium; stale execution can perform external side effects)
- lens: design-flaw
- evidence: `runtime/run-worker.ts:532-535` aborts `state.shutdown`, while the model/tools receive
  a separate `ac.signal` at `:899-900`; `runtime/langgraph-loop.ts:199` checks shutdown at the next
  prepare boundary. `conversations/event-log.ts:443-459` locks the conversation without checking
  execution ownership. `runtime/conversation-lock.ts:59-61` uses the run id as the holder token.
- trigger: a lease expires during an in-flight step and another worker takes over; the old worker
  resumes its model/tool step before reaching prepare again.
- impact: stale responses can enter the log and external tools can execute after ownership is lost.
  Event idempotency does not undo or prevent those external effects.
- fix: give every execution a distinct persisted claim/generation; enforce it on event/checkpoint
  writes and before tool dispatch. Propagate lease loss to immediate request/tool cancellation.
- size: needs a spec
- verification: source-confirmed; takeover fault injection still required.

### org-deletion-does-not-stop-runs: deleting an org does not revoke its active conversations

- status: recurring (2nd report, first seen in `2026-11-14-design-review.md`)
- severity: high (previous report: medium; this includes real tool execution after deletion)
- lens: design-flaw
- evidence: `orgs/orgs.service.ts:265-289` marks deletion, removes owed work and cancels evals,
  but records no stop for ordinary/subagent runs. `runtime/run-queue.ts:242` checks conversation
  deletion only. `runtime/run-worker.ts:477-482` checks neither org nor conversation deletion.
  `runtime/run-orphan-check.job.ts:103` excludes deleted orgs from recovery.
- trigger: delete an org while an ordinary run is active or its job is already in BullMQ.
- impact: active work is not reliably cancelled; depending on the available provider/tool path it
  can keep spending and performing effects after access to its conversation disappears. Jobs removed
  by deletion can also leave nonterminal run rows behind.
- fix: owe durable active-run stops in the deletion transaction, surviving the deletion's outbox
  cleanup; reject starts/dispatches for deleted orgs and settle their run states.
- size: direct fix with cross-module integration coverage
- verification: source-confirmed; deletion during execution still needs an integration test.

### conversation-delete-misses-new-root-run: a concurrent message escapes deletion's stop

- status: new
- severity: high
- lens: design-flaw
- evidence: `conversations/conversations.service.ts:760-766` stops the root before marking it
  deleted. Both its immediate tree stop (`:773`) and durable recovery
  (`runtime/subagents/tree-jobs.ts:119`) use `includeSelf: false`.
  `runtime/run-worker.ts:477-482` does not reject a deleted conversation.
- trigger: DELETE reads an idle root; a concurrent POST creates its run before DELETE marks the
  conversation deleted. Neither subsequent tree stop includes that new root run.
- impact: an invisible deleted conversation can continue calling models and tools.
- fix: mark deletion and record the root stop obligation under the conversation row lock; include
  the root in deletion recovery and reject deleted conversations at worker start.
- size: direct fix
- verification: deterministic interleaving confirmed in source; no concurrent integration test run.

### partial-selection-lost-update: changing effort can silently revert a concurrent model change

- status: new
- severity: medium
- lens: design-flaw
- evidence: `conversations/conversations.service.ts:1276-1279` computes a full selection from an
  unlocked view before resource resolution and the write transaction; `:1476-1482` appends it as
  a full `model_switched`. The append's row lock occurs after this calculation.
- trigger: A and B read model M1; A switches to M2; B changes only effort but commits last.
- impact: B logs M1 plus its effort, reverting M2 despite not requesting a model change. Effort
  validation also uses the stale model.
- fix: apply the partial pick to the latest `readSelection` while holding the conversation row
  lock, and validate the resulting effective model before writing the event.
- size: direct fix
- verification: executed the actual `planSelection` source with this interleaving; B's result was
  `{ model: null, effort: "high" }`, reverting to the agent's M1. HTTP race test still needed.

### truncated-analysis-becomes-summary: incomplete compaction analysis replaces usable context

- status: new
- severity: medium
- lens: design-flaw
- evidence: `runtime/context/compaction.ts:395-401` strips only closed analysis blocks.
  `runtime/model-call.ts:1379-1390` accepts the remaining text by length without rejecting a
  `max_tokens` response. `:1497-1515` stores it as `compaction_summary`;
  `runtime/context/build.ts:801-806` renders it in place of the covered history.
- trigger: the summary model reaches its output cap before closing its instructed analysis block.
- impact: subsequent requests receive unfinished scratchpad text rather than a useful summary;
  original events remain stored, but are omitted from the model's context.
- fix: remove an unterminated analysis block through EOF; reject attempts without usable summary
  text and retain the previous context. Add truncation coverage.
- size: direct fix
- verification: executed `extractSummary` directly from source with a 370-character unfinished
  analysis; its 369-character output retained `<analysis>` and passed the 200-character floor.

### sse-missed-notification-never-catches-up: a healthy HTTP stream can stay stale after Redis recovery

- status: new
- severity: medium
- lens: gap
- evidence: `runtime/stream.ts:247` catches up at opening; `:299-303` catches up on event hints.
  Periodic work at `:264-267` sends heartbeats and rechecks access; `:405-421` does not catch up.
  `ctx/bus.ts:46-60` exposes no subscriber-recovery signal to the stream.
- trigger: only the API replica's subscriber connection drops while a worker publishes final
  events. HTTP remains open, Redis later reconnects, and no later conversation event arrives.
- impact: the page can keep showing a partial/running turn despite a completed durable log.
- fix: catch up from PG after subscriber recovery, or add bounded catch-up to the existing
  authorized periodic recheck.
- size: direct fix
- verification: source-confirmed; subscriber-disconnect fault injection still required.

### orphan-scan-starvation: recovery repeatedly scans the same first 5,000 active runs

- status: new
- severity: medium
- lens: gap
- evidence: `runtime/run-orphan-check.job.ts:35-42` caps a pass at 500 rows times ten pages;
  `:108` orders oldest first; `:146-153` resets its cursor each invocation; `:236` starts a new
  pass every check.
- trigger: 5,000 older healthy long-running or quota-delayed jobs remain ahead of an orphan.
- impact: later orphans are not reached on the next tick either; they can remain stuck as long
  as those preceding rows remain active. The comment promising the next minute is incorrect.
- fix: persist a shared rotating scan cursor with wrap-around, or index a per-run next-check
  schedule; test an orphan behind more than one pass's worth of healthy rows.
- size: direct fix
- verification: bounded-pagination control flow confirmed; no large-population test run.

### dead-outbox-row-leaves-run-stuck: exhausted delivery retries have no conversation outcome

- status: recurring (2nd report, first seen in `2026-11-14-design-review.md`)
- severity: medium
- lens: gap
- evidence: `runtime/run-orphan-check.job.ts:126-137` treats dead and pending deliveries alike;
  `:268` consequently suppresses queued-run recovery while either exists.
- trigger: a run-job delivery exhausts the relay's retries and becomes a dead letter.
- impact: the run remains queued until a super admin intervenes, blocking subsequent turns.
- fix: give dead run-job deliveries a visible terminal failure and an explicit retry operation,
  rather than treating them as work still in progress.
- size: direct fix with an explicit retry contract
- verification: source-confirmed; not reproduced against a running relay.

## Additional risk requiring a runtime regression test

`compaction-crosses-absorption-boundary`: `runtime/model-call.ts:594,1203` passes the full log to
`compactionPlan`, without limiting it to `input.absorbedUpToSeq`. That boundary is used only for
the opening-message calculation at `:1206`. With the allowed `keepRecentTurns: 0`
(`identity/settings.ts:169`), planning can cover a newly logged message which the current run did
not absorb, including a future fork invocation. `context/build.ts:801-806,842-845` renders the
summary and omits covered raw events before applying normal absorption placement.

The planning function was reproduced independently in the context review; a full runtime case was
not run. Test a message/fork arriving between prepare and compaction. The fix must cap the contiguous
summarizable prefix before the first unabsorbed event; merely filtering that event while advancing
`coversUpToSeq` beyond it would still hide it.

## Fixed since the previous review

- `compaction-needs-user-turns`: the blanket claim that a long single-turn tool run cannot compact
  no longer holds. `runtime/context/compaction.ts:166-185` now cuts inside the current turn at
  tool-pair boundaries. `test/runtime/context/compaction.test.ts` and
  `test/runtime/context/current-turn-compaction.test.ts` cover this path. Implementation confirmed;
  tests could not be executed in this checkout.
- Other findings from the platform-wide review are outside this focused review unless listed above.

## Reasonable

- Event sequence allocation and per-conversation deduplication occur under one PG row lock.
- Run creation and terminal transitions owe follow-up work transactionally; `RunFinish.finishIn`
  updates terminal status, consumption, pending waits and follow-up obligations together.
- Reviewed conversation, attachment, output and SSE reads enforce ownership/org/agent visibility;
  hidden eval conversations are excluded and subagent access checks the reachable root. No concrete
  cross-tenant read leak was found in those paths; this is not an exhaustive security guarantee.
- Live drafts are display state; durable events remain the authoritative result.

## Scoped baseline

- 93 source files in `packages/kernel/src/conversations` and `packages/kernel/src/runtime`.
- 50 commits touch those directories since previous review HEAD `6e9ddb4d2`.
- Whole-platform dependency currency and unrelated review lanes were not re-audited.
- No commits, pushes, PRs or business-code edits were made for this review.
