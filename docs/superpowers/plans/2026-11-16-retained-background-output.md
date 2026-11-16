# Retained Background Output Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development with
> wave-planned-subagent-development under the root execution and ownership ledger.

**Goal:** Preserve existing TaskOutput/HTTP/output-file behavior with full retained managed output
and a bounded exact-reference positional read, without new execution authority.

**Architecture:** A private append-only spool is authoritative for managed reads. A separately
pinned artifact file preserves `Read outputPath`; both consume the background worker's single
combined byte stream. The accepted supervisor owns identities, lifetime and cancellation; a
small output helper owns file IO, durability and bounded flow control.

**Tech Stack:** Existing TypeScript device/SDK code, Node filesystem/process primitives and
accepted fixed helper/pinned-directory mechanisms as necessary; Vitest owned fixtures.

**Spec:** [retained output contract](../specs/2026-11-16-retained-background-output-design.md).
The accepted-source caller inventory uses `f6bb72a90`; it is not runtime acceptance evidence.

## Global constraints

- This bounded task preserves existing task output behavior. Design review is not implementation
  or runtime evidence; the root coordinates public SDK and device acceptance separately.
- Raw positional read response is at most 65,536 bytes, overlap included. Tail remains UTF-8 safe
  and terminal last 20 lines; finish-event limit stays 4,000 characters.
- No caller path/new scope for managed output; no exec/provision/resume. Full remains the same OS
  user with independent owner/org/OS ceilings. No global SandboxManager mutation.
- No heuristic deduplication, ring-only storage, total-output cap disguised as capture cap, or
  command replay on retry/restart. No capability claim from fake-only tests.
- Respect held Linux/local-Docker proof boundary. Actual macOS adapter validation uses only the
  already approved owned-fixture mechanism, coordinated by root, never new enforcement experiments.

### Task 8a: Retain background output with exact-reference positional reads

## Files and disjoint ownership

| Owner | Files / scope |
| --- | --- |
| 8a SDK-only amendment, root integrated into PR 317 | `packages/plugin-sdk/src/sandbox-operation.ts`; focused `packages/plugin-sdk/test/sandbox-operation.test.ts` type/contract cases if compatible with its existing structure; SDK changeset. Signature/result inline in existing `SandboxBackground`. No device code in this PR. |
| Root / Task 6b, not editable by 8a worker | SDK `src/index.ts`, API snapshot/generation coordination, staged v3 codec, `LocalDeviceProvider`, device `client.ts`/`server-ops.ts`, admission/run-claim/outbox transport wiring. |
| 8a device correction after SDK acceptance | `packages/device/src/exec/mac-operation-backend.ts`, `operation-supervisor.ts`, `operation-worker.ts`; create `output-spool.ts` with fixed private helper source only if pinned operations require it; corresponding tests below; device changeset. No unrelated executor cleanup. |
| Task 7 | Kernel schema allocation. 8a has no kernel SQL or caller dependency. |
| Task 8 integration | TaskOutput/TaskStop/HTTP/poll/retirement and adapters; stable stored task identity/cursor/retention; coordinated activation after 8a + 6b + 7 acceptance. |

Do not read or edit Task 6b WIP to make adapters compile early. Reconcile the accepted interface at
integration. If adding the SDK required method causes fixtures outside owned files to fail types,
list exact owners/fixtures for coordination; do not weaken the contract with an optional fallback.

## Review focus

1. Repeated output and >65 KiB disconnected bursts: positional reads recover exact bytes (Task B/C).
2. Symlink/ancestor swap or a user replacing the artifact: no unrelated read/write/unlink (Task B).
3. Lost ack or journal/spool partial write followed by restart: no replay/duplicate append (Task B/C).
4. Terminal 30-line output and UTF-8/login-code split: full output vs summary remains distinct (Task C).
5. Storage pressure and expiry concurrent with read/cancel: bounded memory, honest outcomes, retained
   cancellation ownership (Task B/C). Exact-generation rejection and existing public status/stop
   unions are accepted defaults; implement their private lifecycle/failure ordering below.

#### Step A: exact SDK contract, isolated from device implementation

**Interfaces:** Add exactly `SandboxBackground.readOutput(h, ref, {offset,maxBytes,signal})` and
the inline return union specified in the proposal. No new index export or protocol activation.

- [ ] Add contract/type cases that reject path/scope arguments and require offset/nextOffset/totalBytes
  in a successful typed result; pin docs for zero-byte metadata probes, safe integers, exact raw
  slices and `lost|expired`. SDK types cannot prove filesystem/provider behavior; do not label this
  provider conformance.
- [ ] Confirm the relevant compile/test check fails for the absent interface method, then add only
  the SDK interface/doc amendment and required SDK changeset.
- [ ] Run `pnpm exec vitest run packages/plugin-sdk/test/sandbox-operation.test.ts` and the repository
  typecheck appropriate to the coordinated contract change. Report exact fixture compile blockers
  rather than editing Task 6b-owned files.
- [ ] Root coordinates `pnpm gen:sdk-api` and snapshot/checks with the index/API owner. Independently
  review and integrate only these SDK changes into PR 317 before merge/publication; no device code.

#### Step B: exact-owned spool and ordinary output artifact

**Files:** Create `packages/device/src/exec/output-spool.ts` and
`packages/device/test/output-spool.test.ts`. Add fixed helper source under `src/exec` only when
needed to implement descriptor-relative no-follow operations; it is private and not user-selectable.
Update only supervisor/backend private journal/plumbing fields needed to own the helper.

**Private interfaces:** Produce `ManagedOutputSpool` with `append(bytes, signal): Promise<void>`,
`read({offset,maxBytes,signal})` returning the SDK successful range shape, `flush(): Promise<void>`
and `close(): Promise<void>`. A factory consumes trusted private spool root, validated starting
artifact root/path, exact execution ref and journal callbacks; callers never choose helper command
text or a different read path. Separate `openExisting`/expiry cleanup uses recorded file identity
and committed length, not user outputPath. The helper owns safe handles; supervisor owns lifetime.
Append acceptance means mirror write, spool sync and durable checkpoint succeeded; a completion
barrier also syncs final artifact contents. The helper must expose creation/checkpoint/final-flush
failures without awaiting supervisor stop inside its append queue.

- [ ] Write failing owned-temp-directory tests: exclusive/no-follow creation, component and final
  symlink swaps, artifact replacement, preexisting target refusal, private-spool/artifact distinct
  identities, byte-exact writes, bounded offset reads and metadata probes.
- [ ] Add deterministic IO barriers for partial write and journal-checkpoint crash: no duplicated
  bytes, reader sees only committed prefix; same-generation reopen verifies identity and never
  resumes command; wrong generation/ref cannot adopt storage. Test zero/negative/NaN/unsafe integer
  offsets and budgets, 65,536-byte ceiling, interrupted reads and unexpected short reads.
- [ ] Implement the helper with serialized explicit-offset appends and pinned descriptors. Fully
  sync spool before durable checkpoint publication; keep per-operation queued bytes bounded;
  never read/store the full file in memory. Published artifact uses a separate pinned file.
- [ ] Add named IO-order barrier test `creation-sync-before-locator-and-launch`: new file sync,
  containing directory sync and every newly created directory's parent-entry sync precede durable
  locator/identity/zero checkpoint/collecting obligation and launch. Repeat for artifact setup;
  failure at each barrier prevents launch/ack. Keep these operations in the output helper.
- [ ] Add `final-files-sync-before-complete`: final ordered bytes and both spool/artifact syncs
  precede durable complete publication, even when child exit arrives first. No complete record
  or visible success while final flush/checkpoint is blocked or fails.
- [ ] Add expiry/read and expiry/cancel races: pinned read completes or admission returns expired;
  private cleanup is idempotent, retains pending-cancel/operation tombstones, never unlinks a
  replacement or auto-deletes the user-visible output artifact.
- [ ] Add `expiry-tombstone-unlink-directory-sync`: durable expiry precedes identity-checked unlink,
  containing directory sync precedes cleanup completion; interruption at each barrier is retryable
  and preserves pending cancellation/operation tombstones. Replacement is never unlinked.
- [ ] Add `checkpoint-failure-keeps-published-prefix`: inject partial write/ENOSPC/EIO/mirror and
  definitely pre-decision checkpoint faults; only the last verified prefix remains reader-visible.
  Indeterminate final decision publication follows the separately reviewed recovery rules below. The
  helper rejects its append and exposes failure without waiting for cancellation completion.
- [ ] Run `pnpm exec vitest run packages/device/test/output-spool.test.ts`; require deterministic
  barrier-driven PASS. These tests establish helper behavior only, not production worker wiring.

#### Step C: background worker collection and supervisor readOutput

**Files:** Modify `mac-operation-backend.ts`, `operation-supervisor.ts`, `operation-worker.ts`;
extend `packages/device/test/mac-operation-backend.test.ts`, `operation-supervisor.test.ts` and
create `packages/device/test/background-output.test.ts` for the joined output path.

**Interfaces:** Backend `background.readOutput` validates handle/ref then delegates to supervisor,
without `readOwnerCeiling` granting a new operation. Supervisor delegates to its exact owned spool.
Trusted background worker request carries managed output sink configuration, not a user-selectable
privilege marker. Use ordered frames, one outstanding frame of at most 65,536 decoded bytes,
separately bounded producer buffer and explicit accept/fail acknowledgments. Sink acceptance
returns credit; IPC-send completion does not. Control/cancel/terminal messages bypass output credits.
Private supervisor state is `collecting -> complete | fault`, with fault sticky and process-exit
evidence/cancellation separate. Public status/stop signatures do not change.

- [ ] Add failing cases for 200 KiB output before first read and while kernel transport is absent,
  plus repeated identical chunks. Read successive bounded ranges and assert byte-for-byte equality,
  totals/next offsets, no omission/duplication and no exec/provision/resume calls.
- [ ] Implement background-only stdout/stderr merging at the child output endpoint before chunking;
  private diagnostics remain separate. Wire owned spool/artifact creation before acknowledgment,
  backpressure during output, final flush before terminal status and cancellation on real collector
  failure. Keep foreground capture behavior and maxOutputBytes truncation independent.
- [ ] Persist collecting marker, zero checkpoint and interrupted-collection cancellation obligation
  before child launch. Permit complete only after exit, final ordered boundary, accepted batches,
  both final syncs and completion checkpoint. Latch any collector fault immediately; do not let
  existing worker-completion handlers overwrite it with exited/success.
- [ ] On fault claim exact cancellation ownership, reject/settle append and send failure ack, then
  dispatch owned cancellation outside append/journal queues without awaiting stop there. Attempt
  fault/pending-cancel persistence and retry while owned, but dispatch even if persistence throws.
  Preserve the durable collecting obligation. Failed-stream shutdown drains/discards or closes
  producer pipes in bounded memory; it releases credit waiters and cannot become complete.
- [ ] Implement faulted status as lost and stop as cancel-pending until exact termination, then
  stopped. Do not infer already-exited from a raced result. Ordinary stop drains accepted output;
  fault cancellation uses failed-stream shutdown. Preserve exact owner/ref rules and prefix reads.
- [ ] Assert exceeding maxOutputBytes neither kills the task nor truncates retained output. Use
  injectable barriers for queued-byte bounds and appends during reads; no timing sleeps. Test
  cancellation/stop race does not skip final accepted output or erase the pending-stop owner.
- [ ] Add named joined barrier tests `mirror-failure-after-child-exit-before-final-flush` and
  `exit-zero-races-collector-fault`: release barriers in both orders, assert sticky fault, lost
  status, verified-prefix reads, cancel-pending/stopped semantics and never false complete or
  already-exited from the output-fault branch.
- [ ] Add `fault-and-pending-cancel-journal-enospc`: fail both fault and pending-cancel writes after
  durable prelaunch collecting. Assert exact registered cancellation is attempted despite failures,
  only acknowledged prefix is exposed, and same-generation reopen of the unchanged collecting
  marker retains interruption/cancellation uncertainty rather than recovering complete.
- [ ] Add `credit-starved-fault-stop-completion-race`: pause the sole outstanding output frame,
  fault its sink while stop and terminal delivery race, and release barriers in both orders.
  Prove append/failure-ack settlement, credit-independent control/terminal delivery, exact
  cancellation settlement and bounded buffered bytes without sleeps or append->stop->completion
  wait cycles. Cover ordinary stop separately to show accepted bytes still drain before success.
- [ ] Add `fault-read-status-stop-race`: pin a committed-prefix read while fault/exit/stop race;
  assert immutable prefix/total, sticky lost status and separate pending/stopped cancellation.
- [ ] Assert lost-start-ack retry returns same ref and files without relaunch/truncation; supervisor
  restart returns verified retained prefix under the accepted generation rule while status remains
  lost if supervision was lost. No PID/file discovery or new profile scope.
- [ ] Add `restart-collecting-fault-complete-distinction`: safe same-generation reopen preserves
  verified prefix for collecting/fault, never marks either complete, and retains durable complete
  output through retention. Test new-generation rejection without old-path search; artifact
  access stays independent. Retry never relaunches, truncates or discards cancellation ownership.
- [ ] Assert 30 completed lines are all available from readOutput, while tail returns final 20;
  terminal event caller limit remains 4,000 characters. Exercise UTF-8 bytes split at read/chunk
  boundaries, invalid bytes and 4,096-byte prompt overlap within the 65,536-byte response budget.
- [ ] Assert outputPath exists and reads byte-for-byte through an ordinary authorized file read;
  after current profile narrowing the task read still uses its ref, and no broader ordinary Read
  grant is created. An artifact replacement cannot substitute data for the private spool.
- [ ] Run the new joined test and existing accepted backend/supervisor/ceiling tests using
  `pnpm exec vitest run packages/device/test/background-output.test.ts packages/device/test/output-spool.test.ts packages/device/test/mac-operation-backend.test.ts packages/device/test/operation-supervisor.test.ts packages/device/test/operation-ceilings.test.ts`.
  Record exactly which tests used injected IO vs production owned fixtures. Do not broaden into
  Linux/local-Docker conformance or services. Root coordinates already-authorized macOS adapter proof.

#### Final commit-decision publication and recovery (accepted amendment)

Implement the spec's final journal-commit uncertainty rules. Preserve the cause/phase: only final
commit-decision uncertainty after every candidate prerequisite may recover a separately evidenced
successor. Physical data/frame/overflow/final-flush and definitely pre-decision failures stay
sticky. Live uncertain owners return no success/credit, retain the last verified prefix and
cancellation uncertainty, and dispatch exact cancellation even when later writes fail.

- [ ] Prove successful append and complete publication waits for the final decision-file and
  namespace syncs, then survives restart without regressing acknowledged state.
- [ ] Retain all six candidate replacement/file-sync/directory-sync failure cases before the
  decision stage, including failure of every later fault write: no candidate-only promotion.
- [ ] Validate independent decision evidence against exact ref/generation, candidate digest,
  predecessor/version, pinned identities and lifecycle. Missing/torn/stale/wrong/conflicting
  evidence cannot promote a candidate. Recovery must validate/finalize durability before newly
  adopting a successor; failed recovery stays unknown rather than returning a regressed snapshot.
- [ ] Test final decision taking effect while its durability call errors: live unknown and ungated
  cancellation; coherent recovery may select only a properly evidenced successor. An append stays
  interrupted collecting/lost; only a completion with every prerequisite may recover complete.
- [ ] Test paired A/B histories with identical recovered evidence (successful ACK versus
  indeterminate final return), plus successful durability with lost ACK. Evidence gives the same
  deterministic recovery choice, without test-only syscall-return memory or replay.
- [ ] Test valid success evidence together with independently durable collector-fault/cancellation
  decisions: fault wins, stop outcomes and at-most-once tombstones survive, and raced zero exit
  never creates an already-exited result on the fault branch.
- [ ] Test repeated recovery and a second execution with acknowledged output/admission/revocation
  state. Preserve all acknowledged lower bounds and exact-generation rejection without path/PID
  discovery or append/effect replay. Keep Task 8's uncertainty/cursor/access/retirement consequence
  explicit; unchanged public unions do not establish adapter or protocol activation.

## Acceptance and handoff

- [ ] Confirm the accepted exact-generation and unchanged-public-union defaults are implemented.
  Independently review spool identity, lifetime, failure and retention behavior; accept device-only
  correction separately from SDK PR.
- [ ] Root coordinates SDK generation/required checks and device changeset. No direct commit/index
  or merge action is part of this proposal preparation. Later implementation commits follow the
  existing worktree/PR workflow and assigned file ownership.
- [ ] Hand accepted signature/byte semantics to Task 6b's codec/provider/dispatcher owner and Task 8's
  caller owner. Codecs must preserve byte counts through encoding and enforce bounds; no fake
  adapter claiming tail equals readOutput. Do not advertise v3 until joined integration tests pass.
- [ ] Task 8 jointly proves actual HTTP and tool cursor/access behavior, lost ack/reconnect,
  exact-ref retirement and output retention with accepted 6b/7. Task 8a ordinary tests alone do not
  prove gateway transport, multi-replica kernel persistence, protocol upgrade or live revocation.
- [ ] Review named barrier evidence for sticky failure even when fault journaling fails,
  credit/cancellation deadlock avoidance and new-directory-entry durability/cleanup ordering.
  No software IO-order test is proof of arbitrary power loss or hardware durability.

Self-review: contract signature/results and helper consumers align; all five review risks have
owning test steps; no Task 6b/7 source ownership overlap is proposed. The plan intentionally leaves
production activation and cross-layer adapters to the coordinated Task 8 gate.
