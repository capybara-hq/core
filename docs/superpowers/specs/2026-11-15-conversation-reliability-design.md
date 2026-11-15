# Conversation execution and recovery reliability

Status: design approved by the user on 2026-11-15; contribution review remains required.
Baseline: `234632032205ea26e94639cd8611adafb74312dd`.
Evidence: `docs/reviews/2026-11-15-conversation-review.md` (the eight findings only).

## Intent and boundaries

A conversation must have one authorized execution, deletion must durably revoke future work,
and missed hints or exhausted delivery must not leave the UI or run state stuck forever.
Preserve the event log as the source of truth and transactionally owe required follow-up work.
No SDK compatibility layer, new model-visible input, automatic replay of uncertain effects,
new UI, or expansion to the ninth, unverified compaction absorption concern.

## Approaches

1. Only propagate Redis lease loss to cancellation. Small, but a provider can ignore cancellation
   and the old process can still commit. Insufficient for execution ownership.
2. Persist a per-execution claim in PG and guard durable writes and dispatch with it, while Redis
   still controls lease acquisition and immediate cancellation. Recommended: fits existing PG
   row-lock serialization and keeps recovery independent of unreliable notifications.
3. Keep a PG transaction open across model/tool calls. Serializes takeover, but holds locks and
   connections across arbitrary network calls and prevents bounded recovery. Rejected.

The user approved this design. The implementation decisions below record refinements made during
local development and validation; the contribution retains the repository review requirements.

## Execution ownership (finding 1)

Add an immutable random execution id for every acquisition, distinct from run id. Redis values
must identify the acquisition, so a late renewal/release by an old execution cannot renew or
remove a replacement executing the same run. Callers that inspect holders still receive run id;
cleanup from a failed job must use the exact acquisition or leave it to expire, never delete a
new acquisition by run id alone.

Add a nullable execution claim to `runs` with an expand-only migration. Once the conversation
lease is acquired, claim the nonterminal run under conversation-then-run locks, checking org and
conversation deletion and stop intent. A replacement claim revokes its predecessor atomically.
Carry the claim in the loop context and internal execution context (including LangGraph saver).
Request handlers, maintenance and parent delivery retain their own authorized transactional paths;
never infer authorization merely from an event's optional `runId`.

Worker event appends, checkpoint puts/writes/pruning, run-start/terminal/wait transitions and
consumption updates must compare the claim in the same transaction as the write. No check-then-
write gap. The shared guard uses the existing conversation-then-run lock order. A stale execution
throws a dedicated internal interruption, with no failure event, terminal state, or checkpoint
cleanup that could damage its successor. Read-only checkpoint restoration is permitted.

Before each tool dispatch (including resumed approvals and internal tools), authorize the claim
under the same serialization as the existing durable tool-start record. A replacement reuses the
existing uncertain-result behavior: a started tool with no result is never automatically rerun.
Claims guard child spawning, wait creation and other tool-side durable writes as well, not only
`tool_result` appends. Inventory every worker write before implementation.

Lease loss aborts both shutdown and the in-flight model/tool signal immediately. Completion paths
must classify this as interruption, never a user abort. Sink/draft callbacks must also stop emitting
for the revoked claim. A replacement never directly waits for an uncooperative provider to return; a dead acquisition may
occupy its quota slot until the existing TTL expires.

Guarantee: after replacement commits, the old execution cannot commit durable worker state or
begin another authorized tool dispatch. Calls already dispatched may complete externally; no
kernel can recall an arbitrary third-party request. Such an uncertain effect is not retried.
A lease loss that nobody has yet observed is bounded by the lease deadline and the next dispatch
check; providers must honor abort where supported. No exactly-once external-effect claim.

## Deletion and selection serialization (findings 2–4)

Conversation deletion takes the conversation row lock and marks deletion before stopping runs.
Owe a whole-tree stop including the root in that transaction. Immediate and outbox paths use the
same inclusion rule. Recheck writable/deleted state under the message transaction's row lock;
an earlier successful HTTP access check cannot authorize a later write to a deleted row.
Queued or stalled jobs reject deleted conversations before models/tools and settle active runs.

Org deletion records a platform-owned cleanup obligation after removing the org's pending outbox
rows. The obligation has no `org_id`, so deletion cannot purge its own stop. It stops all active
chat/subagent runs and background tasks, including waiting runs, idempotently and in bounded
pages. `ensureRun`, manual compaction, resumes, subagent starts and worker claim/dispatch reject
deleted orgs. Serialize creation against deletion with org-before-conversation lock order where
needed; audit existing paths before adding locks to avoid inversions. Recovery settles deleted
runs rather than interpreting their purged jobs as queue loss. No resurrection or billable retry.

For message selections, resolve attachments/skills outside the transaction, then lock the
conversation row, recheck writable state and read the latest selection from the log. Apply only
the supplied model/effort fields and validate that effective model. Append the switch and user
message and update the selection cache in the same transaction. Preserve idempotency: a duplicate
message must not introduce another switch or fail because today's model availability changed.
Provider validation currently uses the provider registry; avoid external I/O under the row lock.
If resolution can invoke provider I/O, snapshot the model metadata before the transaction and
validate the chosen snapshot against the current effective target with a bounded retry outside
it, rather than holding a transaction across a network call.

## Compaction and SSE (findings 5–6)

Remove closed and unterminated analysis blocks before finding a summary block. Analysis containing
summary-like tags is still scratchpad. Empty output fails through the existing compaction failure
path, preserving raw context. A max-token response with usable summary remains governed by the
existing acceptance rule. No request format or replay drift reason changes.

After each successful credential/access recheck, serialize at most one 500-event PG catch-up page
on the existing output chain. Keep `rechecking` set until that page completes, avoiding queued
periodic work under load. Subsequent ticks continue from `lastSeq`; ordinary opening and event
hints retain full catch-up. Failed auth sends no further events; PG errors abort the stream.
This guarantees eventual convergence even when the final Redis notification is permanently lost.

## Fair recovery and dead deliveries (findings 7–8)

Persist the orphan scan's `(since, runId)` cursor in shared storage (PG is preferred for restart
survival), under the existing single job lock. Each bounded pass starts after the saved cursor;
advance after inspected pages even when all candidates are healthy. Reaching the end resets it
for a future pass. Store timestamps without JS precision loss. The diagnostic
`queuedRunsWithoutJob` remains a separate full diagnostic scan, not the scheduler's cursor owner.
A Redis-only cursor with TTL is simpler but repeated eviction can recreate starvation; reject
in-process state because another replica can own the next tick.

Distinguish pending delivery from dead delivery. A queued run with no live job and only dead rows
ends `run_failed` with a registered actionable `run.delivery_failed` error through `RunFinish`,
consumes its attempted trigger boundary, cancels waits, and owes normal terminal follow-up. Check
again under its conversation row lock so concurrent relay/admin retry cannot be mistaken for an
exhausted delivery. A pending retry takes precedence over a historical dead row.

Retry contract: the user explicitly sends a new message to retry failed work; the old
run remains terminal. Existing super-admin dead-row retry remains a transport retry only: an old
run job reaching a terminal run is a no-op and never resurrects it. Keep the dead row/audit evidence.
Do not automatically create a new run for the same failed message. Additional unconsumed messages
can start normally. Document this behavior in the outbox contract.

## Validation and rollout

Before implementation, create an inventory of claim-sensitive writes and lock ordering. Add only
new migrations; no applied migration edits. No changes to the public SDK are planned. Include a
kernel patch changeset and update the original report with evidence and remaining limits.

Tests use barriers and signals, not sleeps:

- Pause an old worker in a model response, lose its lease, claim on another replica, then release
  the old response with a tool call. Assert no old append/checkpoint/dispatch/release survives.
  Also revoke during an in-flight tool and ensure its uncertain result is not rerun.
- Delete orgs with queued/running/waiting chat and child runs while stop dispatch is unavailable;
  assert a surviving platform outbox obligation, eventual terminal states, and no further calls.
- Interleave an idle-root deletion and a POST at the row-lock boundary in both orders. Recover
  after death immediately following the deletion commit; the root and descendants must stop.
- Delay one message's attachment resolution, commit a model switch from another request, then
  release an effort-only message. Assert model retention and effort validation against that model.
- Return max_tokens inside an analysis longer than the minimum summary floor. Assert one failed
  attempt, no summary event, and the next request still contains original context.
- Drop the final bus event while the SSE output stays open; advance the recheck clock. Assert
  one delivery, bounded pages, sequence deduplication, and no catch-up after auth revocation.
- Seed more than 5,000 healthy candidates before an orphan. Execute consecutive bounded passes
  on different job instances, verify reachability and wrap-around without starvation.
- Make the relay exhaust delivery, verify visible failure/consumption, then admin-retry the old
  row and explicitly send a new message; verify no resurrection or automatic effect replay.

Run reconstruct and rename-compat zero-drift fixtures before/after context work, relevant test
files, checked-in test membership checks, and `CAPYBARA_TEST_WORKERS=4 pnpm -s verify --json`.
The user approved the design and clarified that contribution review is not a repeated local
execution approval gate. Implementation follows the checked-in plan.

## Implementation decisions and reviewed boundaries

- `RunExecution` installs a scoped `TransactionHost` fence. Every writable root transaction
  acquires org and root/current conversation `FOR NO KEY UPDATE` locks, and verifies the acquisition
  claim before domain writes. This matches org write/offboarding admission order and prevents
  shared-lock upgrades and conversation/org inversions. It serializes short worker write
  transactions within an org; no model/tool network request is enclosed by that transaction.
- Explicit read-only snapshot transactions skip the row-lock fence because PG forbids their
  locks and enforces no writes. Subsequent mutation and external dispatch are still fenced.
- EventLog/StepLog, checkpoint put/putWrites/prune/delete, run start/fallback/finish, waits,
  subagent commits and builtin tool domain transactions all use TransactionHost. The two raw
  worker `running` updates became `markRunning` transactions. Tool dispatch rechecks a writable
  fence immediately before the handler/remote call. Ambient claim context crosses the loop and
  saver; no model-visible event or SDK contract was added.
- Queue jobs, schedule jobs, bus callbacks and afterCommit hints run outside inherited transaction
  and execution scopes. Their owed work was authorized with its intent; it must survive a worker
  ending. Worker failure handling and terminal checkpoint cleanup cannot modify a live successor.
- Direct and owed deleted-conversation tree stops use `RunDeletion`, not cooperative worker
  finishing: a deleted worker is forbidden to write its own terminal state. The cleanup commits
  terminal state/claim revocation and a platform-owned cancellation obligation together.
- Admin run-job retries lock conversation before outbox and advance queued_at using PG's current
  clock. The scan compares that delivery generation and ignores older dead copies. This closes a
  delivered-and-deleted retry race without Redis I/O inside the terminal transaction.
- New integration coverage is merged into the existing SSE and dual-replica files as required by
  the test-portfolio check. `runtime/waits-dual.test.ts` is explicitly in the container list.

- Conversation admission uses `NO KEY UPDATE` so a session approval can reference the root
  through its grant FK while holding a child lock. A stronger root `UPDATE` lock could wait for
  that child while blocking its approval's FK check. Domain event writes still take their normal
  stronger conversation lock; deletion remains mutually exclusive with admission.
