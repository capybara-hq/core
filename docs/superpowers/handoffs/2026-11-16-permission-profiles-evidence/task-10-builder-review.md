# Task 10 independent technical builder review

Verdict: **conditional GO for the implementation plan**, with the three bounded corrections below
incorporated before their slices begin. This is not acceptance of Task 10 implementation or an
authorization to expose the staged permission runtime. No new product or visual-direction decision
is needed.

Reviewed on 2026-11-16: the Task 10 preflight and expanded plan proposals, delivery-plan Task 10,
the approved conversation-profile, permission-operation and call-grant designs, the writing-web-ui
skill, and the frozen Task 7 wire handoff/report. UI/API source checks used **git show 0788be8ab**
in `/Users/grant/Capybara/core/.claude/worktrees/fix-project-file-read-mode`; no Task 7 implementation
source or current unrelated Task 6c source was inspected. Task 7's report is owner-reported evidence,
not independent source acceptance. This review ran no tests, services or builds, created no commit,
and changed only this report.

## Important findings and minimal fixes

### 1. Bind the idle child to the existing root stream before promising live inheritance

The preflight correctly acknowledges this gap, but Slice D still leaves the concrete integration
to coordination. At frozen source, `apps/web/src/components/conversation/useConversation.ts`
opens only the viewed conversation's stream. Its catch-up side-key invalidation happens only after
a newly appended event. The frozen Task 7 root profile event does not reach an idle child's stream,
and there need not be a child approval to supersede. Adding permissions to side keys or invalidating
already cached descendants cannot make that independently open child refresh immediately.

Minimal plan amendment: assign an owner-gated child subscription adapter in the conversation client
layer, using the **existing root conversation SSE endpoint**, with the root ID from the authoritative
permissions read. Subscribe only when root ID differs from the viewed ID; do not mount a second
whole `useConversation` with navigation and rendering side effects. Route root profile events to
permission invalidation for that root's cached views; do not append root events into the child's
event window. Specify root cursor/reconnect and cleanup on org/root/ownership changes. Close the
initial GET-to-subscribe race with a deliberate authoritative refresh when the root subscription
opens, or another explicitly reviewed cursor-before-read ordering. Handle reconnect even when no
child event arrives. Keep existing first-read cancellation discipline and gate viewers out of both
the owner read and this extra subscription. `apps/web/src/lib/stream.ts:openConversationStream`
already supplies the transport seam; no new backend route or `ConversationChange` enum is needed.

Add a focused FakeEventSource case: an owner opens a child with no pending card and no cached root
log, another session changes only the root profile, and the inherited label refreshes without a
child event, navigation or window focus. Also exercise subscription-open/read ordering, reconnect,
cleanup and zero extra viewer subscription. Controller review of this small binding closes the
known gap; it does not require a new creative-design round.

### 2. A successful PATCH needs an authoritative-read watermark, not just pending flags

The plan correctly states that PATCH returns only `{revision}` and must not be treated as a full
view. Its instruction to disable choices while mutation/refetch is pending is insufficiently
specific for the failure case. Frozen `apps/web/src/lib/query/mutation.ts:useAppMutation` awaits
ordinary `invalidateQueries` and then calls success; it does not establish that the refreshed GET
succeeded. Cached data can remain after a failed refetch. Ending `isPending`/`isFetching` therefore
does not establish that the displayed profile, consent and revision reflect the successful write.

Minimal fix: record the PATCH response revision as a required confirmation watermark. Until an
authoritative GET for the same root returns at least that revision, keep the historical label
explicitly unconfirmed and the editor disabled, with refresh/error recovery. Do not roll back the
known successful server mutation or retry it automatically. A later higher-revision response is
valid; never require exact equality. Carry the same stale-state discipline when a received profile
event announces a newer revision. This is local UI coordination, not optimistic authority.

Add one behavioral case: PATCH succeeds at revision N+1, GET fails while cached N remains, no second
PATCH is possible, then a successful GET at N+1 or later restores editing. Also show that a
superseded slow GET cannot overwrite the accepted new read. Existing cancellation tests can cover
the latter without adding another broad suite.

### 3. Make the first-send retry/conflict disposition executable

The desired invariants are right, including frozen browser context. The preflight currently says
both that a definitive 409 retains the ID and that changed requests after ambiguous outcomes need
a new logical ID. It does not assign an explicit transition between those states. Frozen
`apps/web/src/lib/conversations.ts:messageBody` computes browser context on every invocation, while
`ComposerBar.tsx:draftKey` omits profile/device/model/effort. Frozen
`packages/kernel/src/conversations/conversations.service.ts:findCreated` returns the same generic
`conflict` for changed-body reuse as the Full-consent path uses for stale scope. A generic 409 alone
does not prove that no earlier request committed. An implementation must not discard the original
envelope and re-use its ID for changed consent, nor silently turn an uncertain create into another
create.

Minimal plan amendment: name the caller-owned attempt state and its transitions: idle, sending,
outcome-unknown, rejected/conflicted, resolved. Store the normalized serialized first-message body
(after browser context is materialized), its org/agent identity and ID above ComposerBar's layout
remount. Exact retry sends those bytes; it must not call the context builder again. Distinguish
retaining an ID for unchanged retry/recovery from deliberately starting a new logical message.
Keep the old unresolved attempt available when the user deliberately changes the request; do not
infer rollback or create completion from generic conflict text. Explicitly state what the send
action does after a conflict and fresh Full reconfirmation. Do not expand this into persistent
cross-reload storage unless that lifecycle is separately required.

The existing planned tests can carry this correction: extend the lost-reply case with a changed
device/model/profile and a conflict, verify original recovery uses the original body and ID, and
verify a deliberate changed logical send uses a new ID rather than silently reinterpreting the
uncertain one. The stale-scope test must demonstrate recovery after reconfirmation, not merely
stop at the first 409. This is an implementation-detail clarification of already approved behavior.

## Boundaries and coverage that are ready

- Query keys include org/conversation or org/device/project, preview lives under the device prefix,
  and project mutation invalidation is explicitly included. Hook-free definitions, owner-aware
  route prefetch, abort signals, no first-paint refetch on hydrated reads, empty-cache states and
  no owner read for viewers are concrete. The first-send handoff correctly permits one real
  permissions GET without fabricating a full cached permission view.
- The separate SessionOnly first-message endpoint, complete selected profile/consent body before
  enqueue, no-device Request/Approve path, no provision/preview without a device, preserved message
  fields and mandatory kernel journal/outbox evidence match the contract. Mocked browser request
  ordering alone is explicitly not advertised as atomic-run proof.
- Read-only children and scheduled rows, interactive-root ownership, conditional reviewer copy and
  authorized settings link, unknown availability text behind ErrorDetail, full-environment reach
  rather than project-only reach, and no inferred review configuration are correctly covered.
- Task 7's exact `approval.command.permissionScope` directory/host arrays and separate `targetPath`
  are bound correctly. API `supersededRevision/supersededReason` and event `revision/reason` remain
  distinct. Both conversation and inbox renderers, event-only history, subagent detail, first-paint
  terminal state and stale-click refetch are included. Scope evidence stays read-only and grants
  no client authority. The plan does not invent `fileOnlyRestriction`.
- The generic optional PickerItem icon/description change addresses an observed component gap.
  Existing Task 5 slot/order and mobile path remain reusable. Design spec/reference/catalog,
  Linux blind review, workflow-only committed baselines, accessibility, computed neutral colors,
  wrapping and no nested boxes are meaningful gates. No new app styling or permission-specific
  design component is necessary. Prefer the proposed existing-primitives terminal superseded
  rendering unless actual shared HITL consumers require the small state extension.
- Task 8 is correctly a **binding handoff gate**, not an invented current DTO or CLI. Preserve
  independent local owner ceiling, host allowances, disconnect and link-page organization/device
  selection. Cut over daily mode controls only after the real replacement read/write/CLI contract
  freezes. Never relabel current mode writes as newly implemented permission grants.

## Controller disposition

Accept the product choices and the overall slice/file/test plan. Incorporate findings 1–3 in the
proposal before implementing the affected state/stream slices. Slices A–C may proceed only within
already accepted contracts; Task 7-dependent event/card code waits for the copied independently
reviewed handoff and corrections. Slice E waits for Task 8's concrete owner-ceiling contract.
Design implementation waits for its narrow technical spec review, then follows the existing blind
reference and CI baseline gates. Integrated activation and provider-support claims remain blocked
by the existing Task 8/14 runtime and acceptance gates. No additional human permission question is
introduced by this review.
