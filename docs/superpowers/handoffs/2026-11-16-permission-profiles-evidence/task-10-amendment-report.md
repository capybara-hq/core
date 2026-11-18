# Task 10 builder-review amendment report

Status: docs-only amendment completed, 2026-11-16. Read `task-10-builder-review.md` fully and applied
all three Important corrections to `task-10-preflight-proposal.md` and `task-10-plan-proposal.md`.
This records plan edits, not implementation/test acceptance or runtime activation. The only files
written in this amendment are those two proposals and this report. No source/tests/services/builds,
commits or subagents. No Task 7 WIP source inspected.

Read-only binding used `git show 0788be8ab` for `apps/web/src/lib/stream.ts`, Conversation.lastSeq in
`lib/conversations.ts`, and `useConversation.ts` bounded stream reopening. The existing opener has
onOpen, event/error callbacks, afterSeq and close lifecycle; EventSource uses Last-Event-ID on its
automatic reconnect. Review-reception skill applied; no additional human product confirmation.

## Important 1 — owner child live inheritance

Assigned `components/conversation/useRootPermissionSubscription.ts`, called from ConversationView.
Only a strict owner child subscribes; authoritative permission result supplies root ID, owner-enabled
conversationQuery bootstrap supplies root row.lastSeq. Root views reuse their stream; viewers receive
neither owner GET/root bootstrap nor extra subscription. No second useConversation or root-log fetch.

Specified cursor advancement from all delivered root seqs, dedupe, root-profile invalidation and
watermark before refresh; root events never enter child EventWindow. Every subscription onOpen forces
an authoritative permission refresh and cancels stale first read, closing GET-to-subscribe and
reconnect races even without child/new events. Terminal browser recovery uses existing bounded
recheck/reopen pattern; auth errors stop it. Org/account/view/root/ownership/unmount cleanup closes
transport, cancels adapter work and ignores prior-generation callbacks.

Named RED/GREEN coverage now includes idle child with no pending card/no cached root log; root-only
profile change without navigation/focus/child event; open/read ordering; empty reconnect; root cursor
dedupe; lifecycle cleanup; zero viewer subscription/read; no root-event append to child.

## Important 2 — successful-write/event revision watermark

Assigned `lib/query/permission-state.ts` tab-local QueryClient/account/org/root coordination and
`lib/query/workspace.ts` resetSession cleanup. This retains the barrier through composer/route remount
without browser persistence. Both successful PATCH revision and profile-event revision monotonically
raise requiredRevision. PATCH mutation fn records it immediately after the HTTP response and
before returning to useAppMutation invalidation; onSuccess is too late. GET must match current identity/generation and reach **>=** requiredRevision;
a higher revision is valid. Pure same-root query structural sharing prevents a slow lower-revision
response from replacing a newer accepted view.

Failed GET or ended pending flags leave historical label explicitly unconfirmed, editor disabled,
localized ErrorDetail and GET-only Refresh recovery. Never roll back/resubmit known-successful PATCH.
Cases now include PATCH N+1/failed GET/cached N/no second PATCH; eventual GET N+1 or N+2; event N+2
with stale N+1; slow GET after accepted N+2; remount/back barrier and session cleanup.

## Important 3 — first-send attempt disposition

Assigned pure app-only `components/conversation/first-message-attempt.ts`, caller-owned state above
ComposerBar remount, and prepare/submit split in `lib/conversations.ts`. States are idle, sending,
outcome-unknown, rejected/conflicted, resolved; stored org/agent/ID/intentKey/serializedBody includes
browser context materialized once. Actual submission sends exact original bytes, never reconstructs
from current controls or calls browserContext for retry.

Generic 409 preserves original envelope/ID/unknown history; it proves neither earlier rollback nor
conflict subtype. Preview refresh/Full reconfirmation updates only draft. Explicit Retry original
uses original bytes/ID; explicit Send updated request allocates new ID even if only profile/device/
model changed. Prior unresolved attempt stays recoverable. Inline action text identifies the new
request without an extra confirmation dialog; late result matches only its attempt/generation.
A resolved old attempt may expose its own conversation link without replacing the newer active view.
No cross-reload persistence/new endpoint added; existing-message ComposerBar identity stays unchanged.

Extended cases recover beyond first conflict: lost reply → edited controls → generic conflict →
original recovery with unchanged bytes/ID, plus fresh Full reconfirmation → deliberate updated send
with new ID/success. Also remount/double-send/late-result guards and no automatic create/reconsent.

## Preserved gates and validation limits

- Task 7 exact frozen wire binding remains **independent source/builder review pending**, including
  file-only clarification. Copy independently reviewed handoff/corrections before event/card code;
  no new file-only field/mode/producer.
- Slice E still waits for Task 8's actual owner CLI, per-device ceiling read/write DTOs and retirement
  binding; local web cannot grant Full. No invented command/route/API.
- Approved all-neutral profile colors, device-permission-model-effort order, no-device restricted
  first send, exact full directory/host display and target separation, i18n/ErrorDetail, existing
  design slot and narrow reference/catalog/Linux blind/CI gates remain.
- Kernel journal/outbox and Task 14 actual-provider acceptance remain required; this amendment ran
  no tests/builds and makes no provider/runtime support claim. Maintainer final acceptance notice
  belongs to integrated completion, not this docs checkpoint.

Verification here: read back the amended contracts; checked Markdown fences/trailing whitespace and
presence of all three correction bindings and existing gates. Root independently reviews these
amendments before UI source implementation.
