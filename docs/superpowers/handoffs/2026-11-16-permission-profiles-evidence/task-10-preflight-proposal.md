# Task 10 web integration preflight proposal

Status: docs-only implementation preflight, amended for all three Important findings in
`task-10-builder-review.md` (conditional plan GO), 2026-11-16. No application/design/kernel source, tests,
services, commits or subagents changed. Primary worktree: `fix-project-file-read-mode`; web/API source
binding `0788be8ab`, accepted generic composer permission slot `09272da87`. Task 6c WIP and Task 7's
isolated source were not inspected. Read only the frozen `task-7-wire-handoff.md` and
`task-7-report.md` from `fix-project-context-notice` for the handoff update below; that source is
frozen at base `34f03abf9d691fb7a8b8e16eaa855120bc7d4a50`, **independent source review pending**. Product behavior and neutral visual
direction are already approved; this proposal asks for technical review, not new product choices.

Read: controller `task-10-controller-preflight.md`; delivery Task 10; accepted conversation-profile,
permission-operation and call-grant designs; **all** of `.agents/skills/writing-web-ui/SKILL.md`;
`apps/web/AGENTS.md`; installed Next `dist/docs/01-app/03-api-reference/04-functions/use-router.md`
and server/client-components guidance. Keep thin server pages, hook-free query definitions, client
hooks at client boundaries, route prefetch and the existing HTTP/query cache. No `router.refresh()`
for these mutations; no app CSS/className/style/color literals, new layout or high-fidelity mock.

## Actual source seams

| Source | Required integration |
| --- | --- |
| `apps/web/src/components/conversation/NewConversation.tsx:141,178,300` | `useAppMutation` calls `createConversationWithMessage`, seeds cache, replaces URL; catch restores `ComposerDraft` after remount. Its current device-unavailable send gate must allow a device-less non-Full first send. Update obsolete POST comment too. |
| `apps/web/src/lib/conversations.ts:780` | Current helper POSTs `/conversations`. Browser first send must POST `/conversations/first-message` with required permission. Preserve `messageBody` attachments/files/model/effort/skill/browser time zone+locale and encoded IDs; ordinary create/PAT APIs stay separate. |
| `components/conversation/ComposerBar.tsx:119,245,428` | Add optional `pickers.permission`; pass existing design slot. `draftKey` covers message contents, not permission/device/model. Preserve its saved draft ID; new-chat caller must additionally freeze the complete first-send envelope for ambiguous network retries. |
| `components/conversation/useSelection.ts:240` | Device/project selection, existing project query, reset on another device. This is location choice; remove auto/sandbox product marks here. No selected device means no preview; offline/unavailable-device hint must not prohibit a device-less chat. |
| `components/conversation/ConversationView.tsx:180,240,547` | Existing model/effort/device pickers and owner/session context. Permission read is owner gated; editing additionally requires interactive root, no scheduled task. Child shows inherited read-only state; shared viewer never probes owner endpoints. |
| `lib/query/conversation.ts:conversationFollowUps,seedNewConversation,CONVERSATION_SIDE_KEYS` | Owner prefetch after row, truthful post-create loading/recorded label, stream/reconnect invalidation. Existing seed knows row/log/queue/files and null device only; it cannot manufacture a full permissions view. |
| `components/conversation/useConversation.ts:202–314` | SSE deduplication via `appendEvents`; invalidation cancels an obsolete first read before refetch. Current `changed` handles selection/title/queue/files/background; new profile events need explicit permission invalidation. |
| `components/conversation/PendingBubbles.tsx` | Optimistic **user-message** bubbles only, deduped by clientMessageId. Not approval cards. Preserve add/drop/restore; permission status must not be fabricated as an approved bubble. |
| `lib/timeline.ts:1417–1452`, `components/ApprovalCard.tsx` | Timeline copies command detail and decides cards from log/detail. Extend frozen Task 7 shapes (source review pending) and terminal superseded behavior; canonical full directory/host display cannot use only clipped command/path. |
| `app/(app)/inbox/view.tsx:717` | Independent actionable approval detail clips path/command and builds its own ActionRow. Reuse exact scope renderer here too; superseded cached items have no actions, already-decided failures refresh inbox/detail. |
| `lib/approvals.ts`, `lib/conversations.ts:72,84,285` | Web-owned types lack Task 7 optional review/scope fields, permission events and superseded. Bind frozen wire nesting below; reconcile any independent-review correction before code. Never import kernel or SDK into web. |
| `components/conversation/BackgroundSection.tsx` | Existing task list/panel and Stop use recorded task/status/output. Add general starting-grant notice alongside active tasks; no inferred per-task profile/revision without Task 8 evidence. |

## Existing HTTP contract; no new kernel/public API proposed

Web-owned `lib/permissions.ts` will mirror only consumed fields. Define:

```ts
type PermissionProfile = "request-approval" | "approve-for-me" | "full-access";
type PermissionSelection = {profile: PermissionProfile; consentScopeRevision?: string};
type PermissionAvailability =
  | {state: "supported"; report: {version: 1; restricted: {
      filesystem: true; network: true; native: true; concurrentScopes: true
    } | null; fullAccess: boolean; background: boolean; unavailableReason?: string}}
  | {state: "unsupported" | "unprobed"; reason: string};
type PermissionPreview = {deviceId: string; project: string | null; scopeRevision: string;
  availability: PermissionAvailability; fullAccessCeiling: boolean};
type ConversationPermissions = {profile: PermissionProfile; revision: number;
  rootConversationId: string; deviceId: string | null;
  consentScope: {deviceId: string; scopeRevision: string} | null;
  scopeRevision: string | null; availability: PermissionAvailability;
  fullAccessCeiling: boolean; startingWorkNotice: string};
```

- GET `/api/v1/orgs/:orgId/conversations/:id/permissions` → direct `ConversationPermissions`.
- PATCH same path `{...PermissionSelection,expectedRevision:number}` → **only `{revision}`**.
  Refetch authoritative GET after success; do not treat response as full view or optimistically
  assert availability/consent. Record the returned revision as a confirmation watermark; editor stays
  disabled until an authoritative same-root GET reaches **at least** that revision, even after a
  failed refetch ends pending flags. The local coordination contract below is mandatory.
- GET `/api/v1/orgs/:orgId/conversation-permission-preview?deviceId=…&project=…` → direct preview.
  Query only with real device; `project` is existing project name, optional. Never provision/probe.
- POST `/api/v1/orgs/:orgId/conversations/first-message` existing create body with required message
  and `permission` → existing `{conversation,event,events?}`, 201 or idempotent 200. No subsequent
  permissions PATCH and no run/message call before this succeeds.

Actual `PermissionProfilesService` validates Full against displayed `scopeRevision`, ceiling and
unsupported state; stale revision/scope uses generic **409 `conflict`**, not an invented special
code. New consent must be explicit after refreshing; never auto-retry a wider scope. Reused different
first-send body can also return `conflict`; explain/refetch without guessing from English text.

## Query/cache ownership and invalidation

Add keys only in `lib/query/keys.ts`:

- `keys.org(orgId).conversation(id).permissions()` → `["org",orgId,"conversation",id,"permissions"]`.
- `keys.org(orgId).permissionPreview(deviceId,project?)` →
  `["org",orgId,"device",deviceId,"permissionPreview",project ?? null]`. Add a preview-prefix builder
  when needed; all previews sit below existing device prefix, so existing device/ceiling writes
  invalidate the affected preview. Project writes currently invalidate only `deviceProjects(id)`;
  extend `components/DeviceProjectsSection.tsx` add/remove mutations to invalidate preview prefix too. Include org/device/project, never just selected profile.

`lib/query/permissions.ts` exports hook-free `permissionsQuery` and `permissionPreviewQuery`, both
`freshness:"live"`, forwarding AbortSignal through loaders. Client mutation/selection hook lives
in `components/conversation/PermissionPicker.tsx`, returning `{picker:PickerProps,details,dialogs}`
for ComposerBar and surrounding existing Stack/Dialog. Selection is controlled by its caller.

`routes.ts` home `then` prefetches preview for `chosenDeviceId` after devices/projects, never when
undefined. Chat `conversationFollowUps` adds owner permissions only after row/account known; gate
identically in client. Existing hydrated-cache tests assert zero browser read. Empty cache shows
existing loading shape; permissions are disabled while loading. Owner child may GET its inherited
root but cannot PATCH; scheduled rows show unattended explanation, no editable selector. A viewer
may show a recorded profile label as historical information or omit it; never imply a live ceiling.

PATCH invalidates its permissions key, pending `approval(id)` keys named by the visible tree/log,
`inboxChangeKeys(orgId)` (list/count), and affected conversation queue/background data when displayed;
SSE supersession events remain final card evidence. Scope-changing device/project writes invalidate
both device preview prefix and cached permissions for affected device, derived from cached views/
conversation rows, not a new global polling loop. Keep existing devices/detail/projects invalidation.
`permission_profile_changed` invalidates current owner permission reads and cached tree reads naming
that root; `approval_decided` including superseded invalidates its `approval(id)` and inbox keys.
`approval_updated` retains its existing reader refresh. Reconnect catch-up includes permissions in
`CONVERSATION_SIDE_KEYS`; inactive viewer keys have no observer, so invalidation issues no owner GET.
Frozen Task 7 emits `permission_profile_changed` on the **root**; descendant command cards get
their own `approval_decided` superseded event. There is no general root-change frame on an idle
child. Close that gap in the client using the existing root SSE endpoint, as follows.

### Owner child subscription lifecycle (Important 1)

Create `components/conversation/useRootPermissionSubscription.ts` (client hook); invoke once from
`ConversationView.tsx` after strict `row.accountId === session.me.account.id` and successful owner
permissions read. Root identity comes **only** from that authoritative result. Hydrated first paint uses prefetched
reads; the subsequent subscription-open GET is an intentional race-closing refresh, asserted
separately from zero first-paint browser reads. A root view uses
its existing stream, with no second subscription. A child (`rootConversationId !== viewedId`) uses
`conversationQuery(orgId,rootId)` as an owner-enabled bootstrap read for the existing row's lastSeq;
no root log fetch/cache is required. Queries remain defineQuery/useQuery and normal scoped keys.
The initial row cursor may precede changes: every subscription open deliberately refreshes current
permissions, closing the permissions-GET → root-row → subscription race even if the row cursor
already passed a profile event. No new backend route or ConversationChange value.

Hook lifecycle identity is `(accountId,orgId,viewedId,rootId,ownershipGeneration)`. Keep its root
cursor in that hook instance: initialize from root row.lastSeq, then advance monotonically from
**all delivered root event seqs**, deduping repeated profile events by seq. Call existing
`openConversationStream(orgId,rootId,cursor,handlers)` with no rendering/navigation callbacks;
never mount another useConversation and never append any root event into the child event window.
Root profile event revision feeds the watermark below and invalidates owner permission keys whose
cached view names that root (including the viewed child's key). Other root events only advance
the cursor; child timeline/draft/run state stays untouched.

On every `onOpen`, including EventSource automatic reconnect, cancel any first read predating that
open and force an authoritative permissions refresh, even with no child/new root event. This
refresh is independent of the ordinary catch-up “added event” check. On browser-terminal error
without a server code, use the existing bounded reopen pattern: recheck the root row through
query/apiFetch (refreshes session), then reopen from the retained cursor. Authentication/access
error stops subscription, invalidates session/ownership through existing handlers and leaves
permissions unconfirmed, never falls back to a viewer read. No uncontrolled timer/retry loop.
Cleanup closes transport, cancels this adapter's bootstrap/recovery subscription work and marks
its generation disposed on org/account/viewed-root/root-ID/ownership change or unmount; late reads/
events from the prior generation cannot set watermark, reopen transport or update the new view.
Viewers get neither the owner permission read, root bootstrap read nor extra subscription.

Required FakeEventSource cases: owner child with no pending card and **no cached root log** updates
from only a root profile event; change between first GET and subscribe is recovered by onOpen GET;
reconnect with no child/new event still refreshes; duplicate/out-of-order root seqs do not regress;
root/org/ownership switch and unmount close old source and ignore delayed callbacks; viewer has zero
extra root reads/subscriptions; child event window never receives root events.

### Authoritative revision watermark (Important 2)

`lib/query/permission-state.ts` owns tab-local confirmation metadata keyed by QueryClient,
accountId, orgId and rootId (the existing sentHereOf pattern); PermissionPicker observes it. Store
`{requiredRevision,lastAcceptedView,readGeneration}` above composer/route remount so returning to
cached revision N cannot lose an unconfirmed N+1 barrier. Reset it with existing resetSession
cache clearing in `lib/query/workspace.ts`; no browser persistence or server state. A PATCH success `{revision:r}` and each root profile event both raise
`requiredRevision = max(requiredRevision,r)` **before** invalidation. For PATCH, do this inside
useAppMutation.fn immediately after the HTTP response and before returning it; its onSuccess runs
after ordinary invalidation and is too late to establish the barrier. They never construct a new
profile/consent/availability view. An authoritative GET can confirm only the same identity/generation
with `view.revision >= requiredRevision`; equality is not required. Accept a higher revision and
advance the watermark/lastAcceptedView. Keep query cache revisions monotonic for the same root
with a pure structural-sharing acceptance guard in permissionsQuery (a lower revision cannot
replace an already newer cached view); generation checks reject reads from obsolete identities.

While cached/displayed revision is below the watermark, label it “last confirmed / refreshing” in
the current UI language, disable editor/send actions that rely on that consent, and offer Refresh.
Mutation/refetch pending ending or GET failure cannot release this barrier. GET error uses localized
ErrorDetail while the historical label remains explicitly unconfirmed. Never roll back a known
successful PATCH or automatically PATCH again. A manual Refresh only performs GET. A later successful
GET at the watermark or above restores controls. Viewer historical labels remain historical; they
never acquire an owner watermark via a forbidden read. Regression cases include PATCH N+1 followed
by failed GET with cached N, root event N+2 followed by N+1 read, and a superseded slow GET arriving
after accepted N+2; editor remains blocked or keeps N+2 as appropriate. Remount/back navigation
with cached N and required N+1 must retain the barrier; resetSession clears old account metadata.

## State and consent behavior

Default new selection is Approve for me. All three rows have equal neutral icons/text/checkmarks;
Request/Approve do ordinary project work and ask/review bounded extra reach. Full does not confer
root privileges or cloud-host access; it uses independently authorized device environment reach.
Show exact selected device/project from the current preview identity, and accurately describe Full
as device-wide authorized reach, **not limited to the displayed project**. Preview has no root/host
expansion arrays; do not invent them or render its opaque hash as an explanation. For cloud outer
network/owner-ceiling details consume actual device facts and Task 8's accepted presentation contract.

Full is enabled only with real matching preview, permitted ceiling, supported report.fullAccess (or
unprobed), and explicit consent to that displayed revision. Unsupported restricted/full report
states disable corresponding execution choices with their real reason; never fall back to Full.
Unprobed remains selectable and says “Checked when this device starts” / “设备启动时检查”. A device or
consent-relevant scope change clears Full to Approve and drops consent; a harmless rename/restart
with identical ID/revision does not. Preserve non-Full choice across location changes.

For an existing chat, GET supplies the actual effective profile and root revision; full selection
confirms its currently displayed scope before PATCH. After success show localized “Changes apply to
new operations. Work already started keeps its starting permissions.” The same general notice is
shown by active/background work; actual owner/admin revocation may stop work and is not described
as preserving permission. A new chat says the choice governs its **first** operation, not an
already-running notice. Do not echo raw `startingWorkNotice` English into zh.

No device: Request and Approve stay available; omit deviceId/project, skip preview and provision,
disable Full with localized “Choose a device first”. This includes no cloud provider and all local
devices offline/no local selection. Later binding follows kernel reset rules.

### Caller-owned serialized first-message attempt (Important 3)

`NewConversation.tsx` owns the attempt state **above ComposerBar's sent/new remount**, separate
from the editable draft. Minimal new app-only type/module `components/conversation/first-message-attempt.ts`:
`{state:"idle"|"sending"|"outcome-unknown"|"rejected/conflicted"|"resolved", orgId, agentId,
clientMessageId, intentKey, serializedBody, hadUnknownOutcome, result?}` (idle has no envelope).
The caller owns the state/ref, current draft and unresolved previous attempts for this mounted
new-chat view; no cross-reload persistence, global server state or new API is introduced.

`intentKey` covers agent, text/resources/files/skill, device/project, profile/consent revision and
model/effort independently of ComposerBar.draftKey. When deliberately starting a **new logical
request**, caller allocates a fresh clientMessageId (even if only permission/model/device changed),
materializes browser context once, normalizes/builds the accepted body and serializes it once.
Split `lib/conversations.ts` first-message preparation from submission: submission receives
`{orgId,serializedBody}` and sends those exact bytes, never calls messageBody/browserContext anew.
Exact retry/recovery always uses stored org/agent/ID/bytes and does not rebuild from current controls.

| Transition/action | Required behavior |
| --- | --- |
| idle → sending | Freeze once on explicit first Send; pending bubble uses frozen ID. |
| sending → resolved | Actual 200/201 response resolves that attempt, seeds returned row/events and navigates once. Permission GET failure afterward cannot undo success. |
| sending → outcome-unknown | Network/lost reply; retain full envelope and draft/selection. Do not claim create failed/rolled back. |
| sending → rejected/conflicted | Server rejection or generic 409; retain envelope/ID and prior unknown flag. Generic conflict cannot prove no earlier commit or distinguish stale consent from changed-body reuse. |
| unknown/conflicted → sending via Retry original | Submit original bytes and ID, unaffected by current draft/selection. Success resolves original; repeated conflict leaves it unresolved, with no automatic new request. |
| unknown/conflicted + edited/reconfirmed draft | Change only the editable draft. Keep original recoverable. Fresh preview/Full reconfirmation never mutates the old envelope or retries automatically. |
| Send updated request | Explicit action on the updated draft starts a new logical request with **new ID**, byte snapshot and attempt state; retain unresolved original under its original ID with Retry original. Explain inline that original outcome is unconfirmed and this sends a new request, with no extra confirmation dialog. |

After a 409, refresh preview/permissions and clear editable Full consent. Unchanged Send is an
explicit Retry original; updated/reconfirmed scope uses clearly labeled Send updated request and
a fresh ID, never the old ID with new revision. Restore draft/attachments/skill/model/device/profile;
render any prior unresolved attempt recovery separately from current unsent draft. A successful
late original result resolves only its matching attempt/generation; never seeds/navigates as the
newer request, never silently resends either request. A late original success may expose its own
conversation link while preserving the newer active draft/view. Existing-message ComposerBar identity remains
unchanged. The actual original might have committed; client disposition never infers rollback from
conflict text. Tests must recover beyond the first 409 through both original retry and explicit
reconfirmed new request, asserting exact byte/ID identity and preserved prior recovery.

After first-send success seed actual events, including initial profile revision 0; while owner GET
loads show recorded chosen label/loading, never default Approve or a fabricated full view. One new
permission GET is expected on first navigation unless an authoritative view is cached. No create-
then-PATCH path and no inferred enqueue/create completion from a conflict.

No configured-review boolean exists in the endpoint. Always truthful conditional copy: “If a review
model is unavailable or uncertain, you will be asked” / “审查模型不可用或无法确定时，仍会询问你”. Link
org admins/owners to `/settings/models?tab=purposes`; do not expose settings link to unauthorized
members or deduce review configuration from the chat-model list. Availability reason strings are
raw English: known state/ceiling cases get bilingual summaries; unknown text uses design ErrorDetail
raw toggle (`ApiErrorDetail` for real API failures), never inline raw text in zh.

## Task 7 frozen wire handoff and approval presentation

Read only isolated `task-7-wire-handoff.md` and `task-7-report.md`; source base is
`34f03abf9d691fb7a8b8e16eaa855120bc7d4a50`. **Frozen implementation, independent source/builder
review pending** (including the file-only clarification). These are exact reported wire shapes,
not a claim of acceptance. Controller copies reviewed handoff/corrections before UI implementation.

- `approval.command.permissionScope`, **not** `approval.detail.permissionScope`, contains exact
  `{readDirectories:string[],writeDirectories:string[],hosts:string[]}`. Command detail also has
  optional `permissionCandidate`, `targetPath`, `candidateHash`, and existing optional `workingRoot`.
  Candidate is `{binding,permissionScope,targetPath?,scopeKind:"directories-and-hosts",candidateHash}`;
  its server-owned binding/hash is read-only evidence, never a new decision request body. Scoped
  approval offers only `scopes:["once"]`. Historical command records may omit these fields.
- `approval_requested.payload.command` has existing kind/command/path/rule/reason/mode plus optional
  `permissionScope`, `targetPath`, `candidateHash`; it **does not** embed the candidate/binding.
  Command/reason display strings are bounded to 2000, path 4096; scope arrays remain exact, untruncated.
- Approval API status and status query add `superseded`; API records expose optional nullable
  `supersededRevision` and `supersededReason` (`"user"` or `"authority-changed"` today). Existing
  decision route/signature is unchanged. Supersession assigns no human decider/decision scope;
  a replacement has another ID and increased `attempt`, never revives the old card.
- `approval_decided.payload` retains approvalId/callId/decision/byAccountId/scope?/reason? and adds
  `"superseded"` decision plus optional integer `revision`. Supersession sends
  `{decision:"superseded",byAccountId:null,reason:"user"|"authority-changed",revision}` on the
  card's **own conversation/run**, omitting scope. Event uses `revision`, not `supersededRevision`.
- `permission_profile_changed.payload` is
  `{oldProfile,newProfile,actorAccountId:string|null,reason?:"user"|"authority-changed",
  deviceId:string|null,scopeRevision:string|null,revision:number}`. It belongs to the root. System
  reset has null actor/scope revision, no invented device; old initialization events may lack reason.
- New `permission_reviewed.payload` is `PermissionCandidate & {outcome:"allow"|"ask"|"deny",
  reason:string,decisionSource:"review-model"}`. Its conversation/seq identify recorded evidence;
  ask/deny grants nothing and it is not a human pending approval.
- `tool_result.payload.review` preserves decision/by/rule/reason/scope?/commandHash? and adds optional
  `profile`, `profileRevision`, `scopeRevision`, `decisionSource` (`scope`, `human`, `review-model`,
  `full-access`, `task-grant`). `task-grant` is reserved; Task 7 issues no interactive scheduled grant.
  Canonical `tool_call_started.payload.permissionInput?` holds `{callInputHash,resolvedInputHash}`;
  neither hash creates client authority. No main model/replay text change in Task 7.

Show every directory and host as plain code/text, preserving full values and read/write labels.
“Directory and its descendants” is explicit; target filename is a **separate informational field**.
Write roots imply read roots; scope arrays are approved expansion, not silently unioned base scope.
No clipping, inferred dirname, clickable model-controlled path or host summarizing. Render alongside
ApprovalBlock with existing Stack headings and `Text pre` (wraps long words). Plain KeyValue values
ellipsize, so reserve it for short facts; no authorization paths in a truncated ItemList title.
No new boxed component. Share exact rendering with the independent inbox detail.

Terminal superseded UI maps API supersededRevision/Reason and event revision/reason separately,
with bilingual user-change/authority-change explanations, no invented decider/scope. Old log/detail/
catch-up/subagent cards and stale inbox selections have no actions. Late already-decided click
refetches detail/inbox, removes actions and never retries. `openWaitReads` already removes an
approval on any approval_decided event; extend its wire union/fixtures so superseded retains this
first-paint behavior. Pending user bubbles and mandatory tool/connector/git/network policies remain.

File-only clarification is **source frozen/review pending**: no producer for the previously alleged
`fileOnlyRestriction` exists; it was removed rather than inventing an API/event/UI mode. A bare
outside file may request its separately displayed parent directory. Existing human/reviewer deny or
ask yields no expansion, no file-only root and no inferred parent consent. No new client field or
file-only permission choice is needed; explain directory reach and offer an in-project path.

## Actual device controls and Task 8 boundary

`components/DeviceModeSection.tsx` owns the daily radios, cloud `setDeviceMode` mutation/confirmation,
local `{mode:"sandbox"}` narrowing and old `MODE_COMMAND="capybara-device mode auto|sandbox"`.
It also owns **independent** local host allowances, machine disconnect and recent audit. Remove daily
radios/mode command; retain explicit owner ceiling authorization, network allowances and disconnect.
Do not delete the whole section or reinterpret the owner grant as conversation selection.
`devices/[id]/view.tsx` supplies overview/settings and nameplate; `lib/devices.ts:deviceModeMark`
feeds device list, composer and `PropertiesSections.tsx` too. Replace daily auto/sandbox labels with
truthful ceiling facts using Task 8's frozen contract, without confusing backend OS/Docker selection.

`(auth)/devices/link/view.tsx:334,345` Selects are **organization** and **new/existing local device
attachment**, not mode selectors; retain both and their ownership/name/expiry/error behavior. Its
current confirm body has only userCode/orgId/name-or-deviceId, no Full grant. It cannot widen local
authority. Pending machine currently exposes name/OS/arch/version only, so no claimed owner ceiling
or invented new confirmation field. Any new connection disclosure is bounded by Task 8's handoff.

Before device UI cutover, Task 8 must supply actual owner CLI command, accepted per-device ceiling
read/write DTOs and local “web may narrow, never fullAccess:true” restriction, host-list semantics,
mode retirement and affected fixtures. Do not invent a CLI flag/route/DTO here or remove the only
owner control before its replacement exists. Task 6c's config/startup/TransactionHost files remain
out of scope. UI/API preparation is independently reviewable; activation/provider claims stay gated.

## Minimal design extension, only for proven gaps

Task 5's optional slot already works in desktop and mobile. Actual PickerItem has label/tag/check/
disabled/badge and one shared note; it lacks per-row icon/explanation. Approved three-row icon +
explanation requires only optional `icon?:IconName`, `description?:string` on **existing PickerItem**,
forwarded through existing ConvMenuEntry (icon already exists there; add description) and mobile
OptionsGroup. Keep existing consumers unchanged, same tokens/neutral treatment, full accessible
label/description for disabled reasons. No new permission-specific design component or badge tone.

Existing ApprovalState cannot represent superseded; either render its terminal line with existing
Text/StatusMark composition before ApprovalBlock (no design change), or minimally add the accepted
superseded terminal state to existing HITL types/i18n/maps if the shared card needs it. Prefer the
former unless shared rendering requires the latter. No directory scope design primitive is needed.

For any actual new picker/HITL state: update `docs/design/spec.md` state list/size table, matching
`docs/design/reference/src/picker-menu.html`, `composer.html` and `approval-block.html` HITL reference; add matching catalog blocks in `apps/web/src/dev/catalog/conversation-blocks.tsx`
and/or `conversation-page-blocks.tsx`, existing design tests/styles/i18n only as needed. Obtain
technical spec-diff review; controller dispatches blind PNG review in pinned Linux Playwright
`v1.64.1-noble`; fix severe/moderate differences, record minor ones; update `visual/accepted.ts`
state coverage and use reference-update/visual-update CI workflows for committed Linux baselines.
No local Darwin baselines, new visual direction approval or separate custom app menu.
