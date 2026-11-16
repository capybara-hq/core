# Retained background output contract amendment

Status: accepted technical correction after independent builder review and scoped fix review.
Final journal-commit uncertainty amendment accepted after independent consistency review (2026-11-16).
Implementation and runtime verification remain separate gates.
Baseline: `f6bb72a90`, accepted Task 4 plus SDK contract. Evidence:
`task-8-output-contract-gap.md`. No current Task 6b files were inspected. This corrects delivery of
existing task output behavior; it adds no product feature and activates no protocol/backend.

## Public contract decision

Add this method to the existing exported `SandboxBackground` interface in
`packages/plugin-sdk/src/sandbox-operation.ts`; use the inline return shape to avoid new index
exports. Leave `tail`, status and stop signatures unchanged.

```ts
/**
 * Read retained managed output by exact execution reference, without a caller path,
 * new operation scope, exec, provisioning or resume. Offsets count raw merged-output
 * bytes. Returns at most 65,536 bytes from one committed output snapshot.
 */
readOutput(
  h: SandboxHandle,
  ref: SandboxExecutionRef,
  opts: { offset: number; maxBytes: number; signal: AbortSignal },
): Promise<
  | {
      data: Uint8Array;
      offset: number;
      nextOffset: number;
      totalBytes: number;
    }
  | { unavailable: "lost" | "expired" }
>;
```

Rules applying to all providers:

- `offset` is a nonnegative safe integer; `maxBytes` is an integer in `[0, 65_536]`. Validate
  before IO; invalid input throws `SandboxScopeDeniedError`. Zero budget is a metadata-only read.
  Bounds are decoded output bytes; wire encoding/frame limits still apply separately.
- `totalBytes` is the length of a single committed append-only output prefix chosen when the read
  is admitted. No output may be returned beyond that snapshot. Concurrent appends may increase a
  later read's total; a successful execution's total never decreases. Safe-integer overflow must
  fail the output stream, never round positions.
- `offset` in the result equals the requested offset. `data` is exactly the slice starting there,
  length at most `min(maxBytes, max(totalBytes - offset, 0))`.
  `nextOffset = offset + data.byteLength`. An offset at/past the snapshot end returns empty data
  and leaves nextOffset unchanged; it neither blocks waiting for output nor clamps the cursor.
  Read the complete requested available range unless interrupted or failed; no unexplained short
  reads. Short filesystem reads must be retried or reported unavailable, not called EOF.
- Read is non-destructive and retryable; it changes no provider-side reader cursor. The kernel
  owns `readOffset`. Equal ref/offset and an already-committed range return identical bytes even
  if the total later grows. Concurrent readers do not consume one another's output.
- Missing retained record/spool or an untrustworthy committed prefix returns `lost`; an exact
  known retained record past retention returns `expired`. Invalid/wrong-device/generation/ref
  mismatches remain scope-denied errors, following accepted Task 4 validation. Aborts propagate.
  Never use an arbitrary output file at a similar path to satisfy a lost reference.
- Reads require existing kernel task/user access checks but no new conversation profile scope or
  execution grant. A narrowed conversation profile cannot convert an output read into a new exec;
  actual owner/device revocation and independent access checks retain their existing meanings.

Rationale: a bounded positional read plus total is the smallest additive interface that can
preserve TaskOutput's existing unread-byte cursor, exact remaining count and overlap parser. A
ring tail with positions could report loss but could not recover it. Stateful/deduplicating tail
heuristics are excluded.

## Byte stream, UTF-8 and caller mapping

Background stdout and stderr become **one byte stream before user-output capture**, matching the
legacy `2>&1` artifact model. Select this topology through a trusted background-only worker option,
not user command comments. Use a shared output endpoint or trusted launch-time descriptor
redirection. Do not reconstruct order from two independently decoded streams. Order is the order
bytes reach the common endpoint; simultaneous writes have the OS endpoint's ordering, not a
claimed global source-time ordering. Private supervisor diagnostics never enter this stream.

The spool, artifact mirror and positional reads preserve this stream byte-for-byte, including
invalid UTF-8. Positions count bytes, not characters. `readOutput` may begin/end inside a UTF-8
sequence: it never strips bytes, injects replacements or advances a cursor for undelivered bytes.
The kernel retains its existing complete-prefix/overlap parsing behavior for model text. Incomplete
live trailing sequences wait for a later read; terminal invalid/incomplete bytes follow the
existing text-decoding behavior. Changing chunk boundaries cannot change stored bytes.

`tail` remains a distinct display operation: at most 65,536 bytes, existing UTF-8 boundary handling,
and terminal last-20-line behavior. Finish events keep the existing 4,000-character cap. A terminal
`readOutput` is **not** restricted to 20 lines. Tail should derive from the same committed output
stream; a bounded cache may accelerate it but is not authoritative output storage.

Task 8 integration mapping (not Task 8a caller edits):

1. TaskOutput chooses `start = max(0, readOffset - 4096)` and `skip = readOffset - start`.
   Request at most 65,536 bytes including overlap, so fresh bytes are at most `65_536 - skip`.
   A larger existing tool budget can be fulfilled by successive bounded reads; overlap is counted
   in each response budget. Advance the stored cursor only by newly delivered complete text bytes.
   `nextOffset` locates returned raw bytes; it is not permission to mark an incomplete text suffix
   as delivered. Repeated content never triggers string-based deduplication.
2. The split-login-code parser receives the exact previous 4,096 bytes plus new bytes. Output
   bursts/disconnection cannot overwrite that range before retention. The exact remaining count
   is `max(snapshotTotal - deliveredOffset, 0)` for the read's snapshot.
3. HTTP byte-tail output (including after exit) may first obtain N with a zero-budget read, then
   read `[max(0, N - requestedTail), N)` through `readOutput`. Bound the second request to that
   end even if its returned total has grown. This gives a consistent captured suffix without
   applying terminal 20-line limits. Preserve HTTP UTF-8 trimming and finished-event fallback.
4. TaskStop and finished events continue using `tail` for terminal final lines. Thirty completed
   short lines remain fully accessible via TaskOutput/HTTP; only the terminal summary is twenty.

## Retained spool and outputPath artifact

Accepted Task 4 currently validates/hashes `outputPath` but does not write it. Task 8a must supply
both an authoritative provider-owned spool and the existing ordinary output file promise.

**Private spool:** use an append-only file under the trusted device state directory, keyed by the
exact journaled execution identity, never by a caller-provided storage filename. Journal its
relative private locator, pinned file identity, committed byte length and retention deadline.
Persist the private output lifecycle and interrupted-collection cancellation obligation described
below alongside that identity; a reader cursor or process result is not output-completion evidence.
Keep full output through retention; response/capture limits do not limit retained file length.
Do not keep full output in a JS buffer or encode it into the JSON operation journal.

**Published artifact:** create the accepted `outputPath` as a separate regular file inside the
starting scope's write authority, before launch acknowledgment. Stream the same bytes there.
It must not be a hard link to the trusted spool: a user-writable artifact cannot become the
authority for `readOutput`. Ordinary `Read outputPath` remains possible under the normal current
file-access rules; it may be refused after a profile/access change without preventing an otherwise
authorized task API read. Do not expand current profile roots or make a new grant to permit Read.
The kernel must not advertise the file as created unless setup succeeded.

Creation/readback rules:

- Resolve roots using trusted starting authority. Pin directories and open each path component
  relative to a pinned parent without following symlinks; final files are regular, exclusive
  creations (`no-follow`/equivalent), not truncation of preexisting files. Root/ancestor changes,
  preexisting symlink/file and identity mismatch fail before command launch. New task retries
  reuse the recorded owned files and stable input hash; they never recreate/truncate/relaunch.
- Before publishing a new spool locator/checkpoint or acknowledging launch, sync the new spool
  file and every newly created containing directory entry: sync its containing directory, then
  each parent needed to persist a newly created directory up to the existing trusted root.
  Only then durably publish the locator, identity, initial checkpoint and collecting obligation.
  Apply the same file/directory creation ordering to the artifact before claiming durable setup.
  A failed creation/directory sync prevents launch; it is not a successfully retained empty spool.
- The writer holds opened descriptors. Managed reads use the private spool descriptor and bounded
  positional reads, never re-resolve outputPath. A path replacement cannot redirect writes into
  an unrelated target. On restart, reopen only the journal's trusted relative private locator by
  the same no-follow walk, then compare device/inode (and file-kind/owner requirements) with the
  recorded identity before readback. A numeric inode alone is not an authority to discover files.
- A user can move/delete/change the published artifact just as with existing output files. Detect
  replacement before reopening or cleanup; never overwrite, unlink or adopt the replacement.
  Such external edits must not affect the authoritative private spool. Do not repair the artifact
  by widening roots or granting a new operation. Availability of the user-visible artifact after
  user alteration is distinct from reference-bound retained-output availability.
- Do not require the shell command to see the private state directory, spool path or descriptors.
  Use trusted output collection/file helpers; pass only intended output endpoints to user work.
  Reuse accepted pinned-directory mechanisms where applicable. No global SandboxManager mutation,
  broad owner grant, privileged launcher, arbitrary process scan or exec-based output read.

Retention cleanup deletes private spool storage after its retention deadline and after no writer,
reader or pending cancellation still owns it. A reader that loses the expiry race gets `expired`;
once a read pins a valid retained snapshot, hold it until that bounded read releases it. Record the
expiry/tombstone before deletion; cleanup is retryable and unlinks only the expected owned identity.
Sync the containing private directory after unlink before recording cleanup completion; retry
after interruption honors the prior tombstone and never adopts a replacement. New directory
creation and cleanup ordering belong to the private output helper, not shared state-helper edits.
Do not let output cleanup erase pending cancellation or at-most-once operation tombstones.
**Do not automatically delete the user-visible artifact at task-output expiry:** the old kernel
prunes task rows but leaves `.out` files to ordinary device-file deletion/reset/user removal.

## Flow control, durability and failures

Use ordered output frames with explicit accept/fail acknowledgments and **one outstanding frame
of at most 65,536 decoded bytes per execution**, plus a separately bounded producer stream buffer.
The implementation must state and test that buffer's byte bound. Return credit only after sink
acceptance, not IPC-send completion. Control, cancellation and terminal messages need no output
credit and cannot queue behind a credit-starved output frame. Do not fire unbounded promises from
`onOutput`. One serialized append pipeline provides a monotonic committed length: fully write each
batch to the spool and pinned artifact mirror, sync the private spool, then durably advance the
journal checkpoint before publishing that length to managed readers or acknowledging acceptance.
Partial writes use explicit offsets and retry remaining bytes; they cannot duplicate bytes.
Finish waits for its pending writes and syncs final artifact contents as well as the spool.

The exact fsync batching implementation may coalesce bounded chunks, but acknowledgment of a
published committed byte position requires the stated ordering. A completion message establishes
the final ordered frame boundary; success waits for all preceding frames to be accepted, both
files' final flush/sync and durable complete metadata. Receiving an exit result alone cannot
publish success. Kernel socket disconnection does not stop collection; the device-owned
supervisor/output pipeline lives with the acknowledged task.

`SandboxExecOptions.maxOutputBytes` still bounds the captured `ExecResult` prefix only. Exceeding
it never truncates the spool or kills the task. No arbitrary new total-output quota is introduced.
Real storage exhaustion/write failure uses the following private state machine, with existing
public status/stop unions unchanged:

1. **Before child launch**, durably establish `collecting`, the exact registered execution/owner,
   committed length (initially zero), and an obligation to retain cancellation uncertainty if
   collection or its owner is lost. This prelaunch marker is the durable conservative fallback
   when ENOSPC/EIO later prevents writing the fault itself. Failed initial durability means no launch.
2. `collecting` can become `complete` only after observed process completion, the final ordered
   frame boundary, complete drain, both final file syncs and successful durable completion checkpoint.
   A spool/mirror/overflow or definitely pre-decision checkpoint fault instead latches `fault` immediately. Fault is sticky:
   a raced exit-zero result or stop completion cannot change it back to collecting/complete.
   Process-exit and cancellation evidence are tracked separately from output lifecycle.
3. On fault, stop accepting batches and publishing byte positions beyond the last acknowledged
   durable checkpoint. Claim cancellation ownership immediately and arrange dispatch to the
   already registered live worker independently of fault/pending-cancel persistence: **even if
   that write throws**, the safety action proceeds. Do not await that disk write before dispatch
   or call the existing persist-first stop path unchanged. Retain the prelaunch obligation;
   attempt/retry persistence while its owner exists. No new disk write gates the safety action.
4. Settle/reject the pending append and issue its failure acknowledgment; schedule exact owned
   cancellation **outside** the append/journal queue. The append callback must never await stop's
   terminal result: stop may await worker completion, which depends on draining that callback.
   Failed-stream shutdown closes or drains/discards remaining producer-pipe bytes in bounded
   memory so termination can be observed. Discard is permitted only after the irreversible fault,
   and cannot yield complete output. Pending credit waits settle on failure/shutdown; terminal
   delivery and cancellation remain independent of those credits.
5. While faulted, `status` returns `lost`, including while cancellation is pending and after a
   raced normal exit. `stop` returns `cancel-pending` until exact stop/termination is established,
   then `stopped`; this path never synthesizes `already-exited` from the raced process result.
   Missing exact live ownership retains pending/lost uncertainty under existing ownership rules.
   No PID adoption, invented exit code or cancellation-owner deletion is allowed.
6. Ordinary stop keeps draining accepted output and awaits the final boundary/flush. Output-fault
   cancellation follows failed-stream shutdown instead. Concurrent read/status/stop see the
   latched fault and only the last verified committed prefix. Fault does not erase that prefix
   or its cancellation obligation. If storage is untrustworthy, return `lost`; do not claim a
   durable prefix or durable fault record whose write never succeeded.

### Final journal-commit uncertainty

Journal publication distinguishes a failure known to precede any commit decision from an
indeterminate outcome of final commit-decision publication. A commit decision may be published
only after all candidate prerequisites succeeded. A successful acknowledgment requires all
required decision-file and namespace durability barriers to return success, including the final
containing-directory sync. An unsynced decision is never acknowledged.

Spool/mirror I/O, ordering/frame, position-overflow, final-flush and definitely pre-decision
publication failures retain the sticky-fault behavior above. Failure of a later fault write
cannot reclassify one of those failures as an indeterminate commit.

Only when final decision publication may have taken effect is its outcome indeterminate. The
live owner stops accepting output, returns no success/credit, exposes at most its last verified
prefix, retains lost/unknown status and cancellation uncertainty, and dispatches exact owned
cancellation independently of subsequent journal writes. It claims neither definite commit nor
definite rollback from the error alone.

Recovery resolves this uncertainty from independent commit-decision evidence bound to the exact
execution generation, candidate identity/digest and predecessor/version, including pinned spool
identity, committed length and lifecycle. Candidate contents or a `complete` field alone are
never decision evidence. Readable bytes are not assumed durable: before newly adopting a
successor, recovery must validate the evidence and complete the required file and namespace
durability barriers. Missing, invalid, conflicting or unverifiable evidence cannot promote the
candidate; retain the verified predecessor or lost/unknown as appropriate.

A recovered append successor may contain additional verified bytes whose original owner returned
no acknowledgment, but remains interrupted collecting/lost with cancellation uncertainty. Only
a separately evidenced completion candidate prepared after process exit, final ordered boundary,
all accepted batches and both final file syncs may recover complete. A durable collector-fault
decision stays sticky and takes precedence over incompatible success evidence. Durable stop
ownership/outcomes and at-most-once tombstones remain independent of output commit resolution.

Previously acknowledged state is a lower bound: recovery never regresses its prefix/complete
decision, changes committed bytes or rolls back unrelated executions' acknowledged admissions,
revocations or cancellation tombstones in the shared journal. Selection is deterministic from
evidence and remains stable after durable finalization, without effect/append replay, PID adoption,
path discovery or silent truncation. If durability cannot be established, return lost/unknown
rather than a successful regressed snapshot.

Task 8 must preserve exact refs/cursors and access/retirement obligations through this uncertainty.
A transient lost/unknown observation caused by an indeterminate final commit is not permanent
proof that an independently evidenced completion can never be recovered. Public SDK unions and
signatures remain unchanged; this amendment does not accept or activate the cross-layer adapters.

Mirror failure is reported even if child exit was already observed; artifact completion is part
of the final success barrier. Diagnostic details stay in operator logs, not paths or secrets
exposed in SDK errors. No public error/status expansion is needed for this conservative behavior.

Same-generation supervisor restart may read the journaled committed prefix after safe reopen even
when process status is lost/unknown. It never adopts recorded PIDs or restarts the command. Any
remaining `collecting` marker means interrupted/unknown collection and retained cancellation
uncertainty, never successful completion. A persisted `fault` remains faulted; failure to persist
that fault still leaves the durable collecting obligation. Verified prefix reads are allowed in
both cases; loss of exact live ownership does not authorize process discovery. Bytes past the
committed checkpoint are not claimed complete unless the separately evidenced indeterminate
final-commit procedure above selects a prepared successor. Recovery may trim only the private
owned spool's uncommitted suffix once no writer owns it. This is an explicitly interrupted output
stream, not successful silent data loss. Completed durable output survives such restart through
retention. A changed instance generation still fails exact-generation validation; do not relax
that control boundary to find old files. Existing user artifact files may separately remain under
normal file-access rules.

## Scope, acceptance and resolved review decisions

The additive SDK signature can be isolated in SDK-only PR 317 with documentation/type coverage
and required SDK changeset. No device implementation belongs in that PR. Root coordinates API
snapshot regeneration/index ownership with Task 6b. Task 8a device work starts from accepted Task 4
and this accepted SDK contract; it does not require Task 6b/7 implementation and does not edit
their files. All codec/admission/provider/caller adapters are accepted jointly before Task 8
activation. Passing local mocks does not establish transport or production output proof.

The independent builder review accepted these two bounded defaults; neither remains a design TBD:

1. **Generation:** keep exact-generation rejection and same-generation verified-prefix readback.
   Cross-generation archival is outside this correction; ordinary artifact access remains separate.
2. **Storage-failure outcome:** preserve existing public status/stop unions, with private sticky
   output lifecycle, durable prelaunch interrupted-collection obligation, ungated exact safety
   cancellation and credit-failure ordering specified above. The accepted supervisor's existing
   completion/persist-first-stop implementation must change within Task 8a ownership; it cannot
   be assumed to satisfy the amendment unchanged.

Tasks B/C name deterministic barriers for each failure/durability ordering. Passing those tests
will establish software ordering only, not arbitrary power-loss or hardware durability proof.

The actual no-follow/pinned descriptor and merged-output implementation must be demonstrated on
the already authorized macOS owned-fixture boundary. No Linux/local-Docker enforcement experiment
or capability claim is authorized by this amendment. No policy-format migration is proposed.
