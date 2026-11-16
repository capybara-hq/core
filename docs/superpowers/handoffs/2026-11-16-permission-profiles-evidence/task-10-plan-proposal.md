# Task 10 expanded implementation plan proposal

Status: **proposal only**, amended for Important 1–3 in `task-10-builder-review.md`
(conditional technical plan GO), 2026-11-16. Companion `task-10-preflight-proposal.md` fixes source/contracts
and decisions. Implement only after controller's technical review and dependency handoffs. This
preparation changed only these two proposals and `task-10-amendment-report.md`; no source/tests/services/commits/subagents or runtime
acceptance occurred. Approved product/visual decisions need no additional human questions.

Source root: `/Users/grant/Capybara/core/.claude/worktrees/fix-project-file-read-mode`; frozen web/API
`0788be8ab`; composer permission slots `09272da87`. All paths below relative to that root.

## Binding gates and ownership

1. Frozen Task 7 `task-7-wire-handoff.md` and `task-7-report.md` were read as artifacts only,
   source base `34f03abf9d691fb7a8b8e16eaa855120bc7d4a50`, **independent source/builder review pending**.
   Exact scope/target/status/event nesting is bound in the companion preflight. Controller supplies
   reviewed handoff/corrections before code. Do not inspect isolated WIP or guess new payload fields.
   Task 9 owns model/replay text; Task 10 copies only reviewed web-owned event types and historical presentation. No kernel/event/schema/migration edit.
2. Task 8 supplies actual replacement owner CLI command, per-device ceiling DTO/read facts/write
   operations and mode retirement. Separate local owner grant from conversation choice. Task 10 may
   prepare/implement picker/cache independently; serialize device-details cutover with Task 8 so no
   old endpoint is relabeled with unimplemented permission semantics. Task 6c config/TransactionHost
   remains untouched. No new API/CLI command is proposed here.
3. Minimal optional icon/description on existing generic PickerItem requires technical design-spec
   review and new-state reference acceptance below. Reuse Task 5 slots, menus, mobile sheet and
   existing design primitives. Controller arranges any required blind visual reviewer; implementer
   neither dispatches uncontrolled parallel edits nor creates a new visual direction.

## Slice A — HTTP types, cache keys and first-paint reads

Files: create `apps/web/src/lib/permissions.ts`, `apps/web/src/lib/query/permissions.ts`; modify
`lib/query/keys.ts`, `lib/query/routes.ts`, `lib/query/conversation.ts`, `lib/conversations.ts`.
Tests: create `apps/web/test/conversation-permissions.test.tsx`; extend
`apps/web/test/conversations-lib.test.ts`, `conversation-cache.test.tsx`, `support/conversation.ts`.

- [ ] RED `permissions loaders encode org/conversation/device/project and mirror direct GET / revision-only PATCH`:
  actual stubApi body/path assertions; Full consent only when supplied, no arbitrary roots/config.
- [ ] RED `owner permissions are prefetched once; viewer never calls owner endpoint` with
  `renderRouteWithCache` + `expectNoFirstPaintFetch`; owner child read is inherited, scheduled root
  is read-only; missing accountId is not assumed authorization for this new owner read.
- [ ] RED `uncached permission read is disabled while loading and refresh failure retains safe label`;
  `renderRouteEmptyCache`, controlled unresolved promises, no fixed sleeps. Add home preview
  hydration case for real selected device and zero preview calls without one.
- [ ] GREEN mirror exact types in companion, encode URL params and signal; hook-free defineQuery
  freshness live. Build permissions key under conversation and preview key under device; add explicit
  preview-prefix builder. Extend home `then` after selected-device resolution and chat follow-ups
  only after owner row known. Do not fetch preview by selecting a cloud default implicitly for Full.
- [ ] Update shared fixtures with real direct permissions view and separate preview factories
  (supported/unprobed/unsupported, restricted=null, fullAccess=false, ceiling=false, no device,
  child/viewer/schedule, initial profile revision0). No invented reviewConfigured flag; frozen
  Task 7 nesting remains subject to independent-review corrections.

Run `pnpm exec vitest run apps/web/test/conversations-lib.test.ts apps/web/test/conversation-cache.test.tsx apps/web/test/conversation-permissions.test.tsx`.
Record the expected missing behavior and failing assertions before implementation, then passing counts.

## Slice B — approved three choices through existing design slots

Files: `apps/web/src/components/conversation/PermissionPicker.tsx` (client selection adapter returning
picker/details/dialogs), `ComposerBar.tsx`, `NewConversation.tsx`, `ConversationView.tsx`,
`apps/web/messages/{en,zh}.json`. Design changes **only if needed for the proven row-state gap**:
`packages/design/src/conversation/{composer,composer-options,menu}.tsx`,
`packages/design/src/styles/conversation.css` and existing design tests/reference/catalog listed below.

- [ ] RED `Request / Approve / Full use one neutral treatment and device-permission-model-effort order`:
  actual new/existing composer DOM, selected checkmarks and full accessible names; no Full warn
  badge/accent. Preserve optional absence for existing consumers.
- [ ] RED `unprobed choice explains deferred check without provision; unsupported choice explains actual reason`;
  test supported report restricted=null/fullAccess=false separately from ceiling=false and no device.
  Unknown English reason is under ErrorDetail's raw toggle in zh, localized summary visible.
- [ ] RED `device or widened scope clears Full consent; rename/restart with same identity/revision keeps it`;
  a late preview response for another device/project never enables Full. Non-Full choice stays chosen.
- [ ] RED `only interactive root owner can edit; child/viewer/schedule cannot escalate`;
  no forbidden GET/PATCH from viewer; child inherited label is read-only; scheduled copy never claims
  scheduled work inherits chat Full. Do not infer live viewer authority from old events.
- [ ] RED `missing reviewer uses conditional fallback copy and authorized settings link`:
  model list absence never invents configuration state; members see no admin link.
- [ ] GREEN controlled selection defaults Approve. Full selection opens existing Dialog for actual
  displayed device/scope; current project is context, Full reaches authorized device environment.
  Store confirmed revision with device/project identity, not just enum. Cancel changes nothing.
  New chat copy concerns first operation; existing changes expose new-operation/starting-grant note.
- [ ] Add optional generic PickerItem `icon`/`description`, forward through existing ConvMenu and mobile
  OptionsGroup, with same neutral tokens and accessible descriptions. ConvMenu already supports icons;
  extend description only, no bespoke permission menu/layout or color. Add app optional permission prop
  and pass existing `ComposerBox` / `ComposerOptions` path without duplicating mobile controls.

Design RED tests in existing `packages/design/test/{composer,composer-menu,composer-phone}.test.tsx`:
`permission rows expose descriptions and disabled reasons by keyboard`, `mobile option groups retain
order and checked state`, `all profile icons use identical neutral color`. CSS color equality needs
real-browser computed-style assertions in addition to jsdom structure; do not claim jsdom proves it.

Before design implementation update `docs/design/spec.md` state list/size table and reference blocks
in `docs/design/reference/src/{picker-menu,composer}.html`; add matching all-state light/dark fixtures
in `apps/web/src/dev/catalog/{conversation-blocks,conversation-page-blocks}.tsx`. Existing fields stay
optional. Get technical spec diff reviewed. Render `COMPARE=picker-menu,composer` in pinned Linux
Playwright `mcr.microsoft.com/playwright:v1.64.1-noble`, controller dispatches blind pair review,
fix all severe/moderate differences and record minor ones. Keep/update `visual/accepted.ts` coverage;
reference-update/visual-update workflows alone produce committed Linux baselines. No local baseline
commits. No new token without tokens.json + gen:tokens. Existing generic component names remain.

Run focused web test plus `pnpm exec vitest run --project design packages/design/test/composer.test.tsx packages/design/test/composer-menu.test.tsx packages/design/test/composer-phone.test.tsx`.

## Slice C — atomic first send, retry envelope and optimistic handoff

Files: `lib/conversations.ts`, `components/conversation/NewConversation.tsx`,
`lib/query/conversation.ts`; create pure app-only
`components/conversation/first-message-attempt.ts`; `ComposerBar.tsx`/`PendingBubbles.tsx` only if
concrete draft handoff needs an additive type. Existing messages/retries keep their current semantics.
Tests: `apps/web/test/{conversation-permissions,conversation-page,new-conversation-page,conversation-project}.test.tsx`.

- [ ] RED `each initial profile reaches first-message before any enqueue-producing request`:
  capture actual fetch sequence/body; assert no legacy POST/create-then-PATCH, selected scope/profile
  sent with attachments/files/skill/model/effort/browser context. Test all three initial choices.
- [ ] RED `Request and Approve first-send work without cloud provider or local selection`:
  omit deviceId/project, zero preview/provision requests, Full disabled; include local-only offline
  list and no selected device. Preserve no-agent/send-in-progress gates.
- [ ] RED `stale Full 409 keeps original attempt recoverable and fresh confirmation sends a new logical request`:
  original conflict preserves draft, original ID/serialized body and any prior unknown-outcome flag;
  refresh preview, clear editable Full consent and never auto-retry. Reconfirm updated Full scope,
  explicitly Send updated request with new ID, get 200/201, verify original remains recoverable.
  Generic 409 never proves rollback or which conflict branch ran. Existing PATCH conflict separately
  refreshes authoritative state rather than rewriting a successful mutation.
- [ ] RED `lost reply recovers original bytes after changed device/model/profile and generic conflict`:
  network failure → outcome-unknown; edit only controls while original envelope remains immutable;
  explicit Retry original uses identical bytes/org/agent/ID/context. If conflict occurs, retain it;
  explicit updated logical send allocates new ID even with unchanged text/draftKey. Recover original
  later with its original body; do not navigate/seed a newer request under original result identity.
- [ ] RED `attempt lifecycle survives composer remount and resolves only its own response`:
  idle/sending/unknown/conflicted/resolved transitions, pending bubbles keyed per attempt, double Send
  in-flight refused; old late response cannot overwrite active newer draft/attempt or navigate it.
  No persistent cross-reload storage, no auto-creation after reconfirmation and no generic-message parsing.
- [ ] RED `chosen Request/Full survives optimistic layout and URL handoff with no Approve flash`:
  pending bubble shown once; returned initial profile event is preserved; owner permissions may
  still be loading without fabricated availability. Successful create stays success if later GET fails.
- [ ] GREEN NewConversation caller owns attempts above layout remount, separate from editable draft.
  Explicit states: `idle`, `sending`, `outcome-unknown`, `rejected/conflicted`, `resolved`; store
  org/agent/clientMessageId/intentKey/serializedBody/hadUnknownOutcome and actual result when resolved.
  `intentKey` includes message content/files/resources/skill, device/project, permission+revision,
  model/effort; ComposerBar's narrower draftKey is not the authority for first-send identity.
- [ ] GREEN split first-message helper into prepare/submit. New logical request gets fresh ID,
  materialized browser context and normalized serialized body once; submit sends exact stored bytes.
  Unchanged Retry original never rebuilds messageBody/browserContext. Conflicts preserve envelope/ID;
  refreshed/reconfirmed edited selection is only a draft until explicit Send updated request creates
  a new ID/snapshot. Keep unresolved old attempt's Retry original available; explain inline that
  original outcome is unconfirmed and updated send is new, without another confirmation dialog.
  Do not alter existing-message identity. Guard late callbacks by attempt ID and view generation.
- [ ] GREEN switch only browser first-send submission to SessionOnly endpoint; preserve pending
  add/drop/restored draft and model/device/profile/attachment/skill selection. Actual success seeds
  returned row/events/queue/files and navigates once for that active attempt; old resolved attempt
  may expose its own returned conversation link without replacing a newer active view. Never seed
  fabricated permissions. Keep recorded chosen label/loading until authoritative GET; sidebar groups
  invalidated without waiting. Update POST stubs to first-message; no create-then-PATCH.

Journal/queue integration evidence is compulsory before claiming atomic first-operation behavior:
run existing kernel `packages/kernel/test/conversations/permission-profiles.http.test.ts`, including
`stale displayed Full consent rolls back creation and its run obligation`,
`persists both restricted initial selections without a device and rejects changed-body retries`,
`initializes only the winning root epoch on concurrent first-send and rolls back failed creation`.
Task 10 browser body/order tests alone do not prove DB/event/outbox ordering. Extend
`apps/web/e2e/conversation-send.spec.ts` or add Task 14's planned `e2e/permission-profiles.spec.ts`
with a real SessionOnly UI send and inspection through the **test harness** of initial profile
journal event and queued run obligation, before worker admission. No test-only public API. If harness
cannot pause/drain the worker safely, coordinate the fixture with Task 14 and report this evidence
pending rather than accepting a mocked “first operation used profile” assertion.

## Slice D — live profile mutation, supersession and exact scope display

Files: `components/conversation/PermissionPicker.tsx`, `ConversationView.tsx`, `useConversation.ts`;
create `components/conversation/useRootPermissionSubscription.ts` and
`lib/query/permission-state.ts`; extend `lib/query/workspace.ts` resetSession cleanup;
consume existing `lib/stream.ts`
transport and `conversationQuery` root-row cursor; `lib/query/{permissions,conversation}.ts`, `lib/{conversations,approvals,timeline}.ts`,
`components/ApprovalCard.tsx`, `app/(app)/inbox/view.tsx`, `components/conversation/BackgroundSection.tsx`.
May create one app logic component `components/PermissionScopeDetail.tsx` built solely from existing
Stack headings and `Text pre` for full wrapping values; share it between conversation and inbox.
KeyValue defaults to single-line ellipsis, so use it only for short metadata, not scope arrays. No new design primitive.
Tests: `conversation-permissions.test.tsx`, `conversation-cache.test.tsx`, `approval-card.test.tsx`,
`timeline.test.ts`, `timeline-waiter.test.ts`, `timeline-background.test.ts`, `inbox.test.tsx`.

- [ ] RED `PATCH sends expectedRevision and holds revision watermark through failed GET`:
  PATCH succeeds N+1, cached GET N remains after forced GET failure; show last-confirmed/unconfirmed
  label and ErrorDetail+Refresh, editor cannot PATCH again even when isPending/isFetching become false.
  Manual GET N+1 or N+2 restores editor; never rollback/resubmit successful PATCH. Root event N+2
  raises same watermark; GET N+1 cannot release it. Superseded slow GET after accepted N+2 cannot
  overwrite cache/display. Remount/back with cached N retains required N+1; resetSession clears
  old account metadata. Existing cancellation test seam covers in-flight stale-first-read race.
- [ ] RED `owner idle child follows root-only stream without a root log or child event`:
  no pending card/cached root events, owner permissions read names root, bootstrap root row.lastSeq,
  subscribe existing root endpoint; only root profile event changes inherited label without navigation,
  focus/window refresh or child event. Root events never enter child EventWindow; root view opens
  no extra root subscription; viewer opens zero owner reads/bootstrap/subscriptions.
- [ ] RED `root subscription open closes GET-to-subscribe race and reconnect refreshes without events`:
  root change after child GET/before root-row snapshot or subscription is recovered by onOpen GET;
  automatic reconnect forces GET even when no new child/root event exists. Cancel stale first reads
  before refresh; duplicate/out-of-order root event seq cannot regress accepted revision.
- [ ] RED `root subscription cursor and cleanup follow identity and ownership`:
  all delivered root events advance cursor, terminal browser recovery rechecks root row and reopens
  from that cursor with existing bounded retry; server authorization error stops subscription and
  leaves state unconfirmed. Org/account/viewed-root/root-ID/ownership change and unmount close old
  source, cancel adapter work and ignore late callbacks. Reconnect catches latest root revision.
- [ ] GREEN implement owner-only child hook from the companion's concrete lifecycle: authoritative
  permission root ID, enabled root-row defineQuery/useQuery bootstrap, local monotonic delivered seq,
  openConversationStream with notification-only handlers, independent onOpen refresh and existing
  bounded terminal recovery. No second useConversation, root event-log cache, new backend route,
  ConversationChange value, rendering/navigation side effects or child-event dependency.
- [ ] GREEN tab-local permission-state module owns
  `requiredRevision=max(PATCH revision,event revision)` and lastAcceptedView/readGeneration, keyed by
  QueryClient/account/org/root above composer/route remount (existing sentHereOf pattern). Clear it
  with resetSession; no browser persistence or server state. Only authoritative same-identity GET revision >= watermark
  releases confirmation barrier; stale query flags/cached success never do. Add pure same-root
  monotonic structural-sharing guard to permissionsQuery; ignore disposed-generation reads. Failed
  GET keeps explicitly historical label, disabled editor and GET-only recovery. PATCH mutation fn records watermark after HTTP response **before returning** (onSuccess is after
  invalidation and too late); root event handler raises it before owner-key invalidation. Existing
  first-read cancel discipline remains. Count deliberate child subscription-open GET separately
  from hydrated first-paint reads.
- [ ] RED `Write target is separate from entire approved directory and every host`:
  fixture `/outside/reports/report.txt`, write/read directories `/outside/reports`, several distinct
  hosts and very long paths; conversation **and inbox** show exact arrays, descendant explanation,
  target label and no truncation/inferred sibling/root. Event-only and API-read paths agree.
- [ ] RED `superseded card is terminal before first paint and cannot be approved`:
  log decision, direct detail, subagent fromRead, reconnect, late already-decided click and inbox
  cached selection all show no approve/deny/scope controls; no mutation on terminal card. Ordinary
  mandatory approval scopes/questions/network fallback retain prior behavior.
- [ ] RED `starting work retains recorded grant notice without claiming a historical profile from current state`:
  active foreground/background task, later profile narrowing, Stop still usable; owner revocation
  is not explained as guaranteed continued access. No new background DTO guessed.
- [ ] GREEN after independent acceptance, bind frozen exact Task 7 fields: HTTP
  `approval.command.permissionScope/targetPath/candidateHash` (candidate evidence read-only); API
  `supersededRevision/supersededReason` versus decision-event `revision/reason`; nullable system
  profile actors and root-only profile events; `permission_reviewed` Candidate+outcome/reason/source;
  optional ReviewRecord provenance. Scoped approvals offer once only. Apply review corrections
  first. Render exact scope values via shared plain composition; historical fields stay optional. Prefer dedicated
  terminal Text/StatusMark before ApprovalBlock for superseded (no design state extension). If shared
  HITL state must change, extend existing `hitl.tsx`, design i18n + complete maps and tests only;
  `docs/design/reference/src/approval-block.html`/spec/catalog/Linux blind/CI gates apply as in Slice B.
- [ ] GREEN on superseded/already-decided failure invalidate `approval(id)`, inbox/list count and local
  stale outcome; never auto-resubmit grant. Profile events refresh only owner-enabled live reads;
  known tree pending cards/queues/background invalidated, viewer stays read-only. Active-work notice
  comes from approved bilingual semantics, raw English details remain behind ErrorDetail.

## Slice E — remove daily modes while retaining explicit owner ceilings

Files after Task 8 freeze: `components/DeviceModeSection.tsx`, `lib/devices.ts`,
`app/(app)/devices/[id]/view.tsx`, `app/(app)/devices/view.tsx`,
`components/conversation/{useSelection,PropertiesSections}.tsx`,
`components/DeviceProjectsSection.tsx`, `app/(auth)/devices/link/view.tsx` (disclosure only if needed),
`messages/{en,zh}.json`. Preserve shared component filename or rename imports together; no broad cleanup.
Tests: `apps/web/test/{devices-mode,devices,device-link-page,device-projects,conversation-project}.test.tsx`.

- [ ] RED `daily mode radios/command disappear; owner ceiling and restricted network remain explicit`:
  local web has no grant-Full action/body, supported narrowing uses Task 8 actual operation; cloud
  owner changes only accepted ceiling within platform/org reach and confirmation describes effects.
- [ ] RED `org/device link selects still choose org and new/existing device; confirmation grants no Full`:
  preserve existing name/expiry/deny/invalidation cases and machine OS-vs-Docker backend facts.
- [ ] RED `device/project ceiling mutation invalidates preview and cached affected permissions`:
  project add/remove currently invalidates only deviceProjects; add preview prefix without launching
  suggestions scan/provision. New device/scope mismatch resets local Full selection before send.
- [ ] GREEN replace radio/old mode command with accepted Task 8 owner-ceiling read/write/disclosure;
  retain local host add/remove, disconnect, recent audit and files-reset notices. Stop displaying daily
  auto/sandbox badges in location picker; describe ceiling/provider facts consistently in list/detail/
  properties. Existing low-level internal mode encoding is not permission selection. Do not invent
  new fields on pending-device confirm or show a guessed CLI command. Missing handoff blocks only
  this cutover, not Slices A–D preparation; record exact unresolved Task 8 item for controller.

## Slice F — browser acceptance, verification and review packet

Extend `apps/web/visual/conversation.interaction.spec.ts` and actual app Playwright
`apps/web/e2e/{new-conversation-page,conversation-send,query-cache}.spec.ts` (or Task 14's scoped
permission file), using existing free-port/testcontainers fixtures. No dev stack restart in this
preparation; implementation verification starts only owned bounded test harnesses and cleans them.

- [ ] Real desktop/mobile (1440/640/390), light/dark: order, all profile neutral computed text/icon
  colors, equal checkmarks; long directory/host wrapping, no horizontal page scroll; CSS-only narrow
  first paint with JS off where layout is asserted, reduced motion, touch selection no keyboard pop.
- [ ] Keyboard: tab to picker, arrows/Enter choose, Escape returns focus; Full dialog initial focus,
  cancel/confirm and mobile sheet return focus correctly; disabled options expose localized reasons;
  selected state announced as radio, description associated; no nested boxes (`findNestedBoxes`).
- [ ] Owner hydration reads none in browser; viewer never owner GET; non-Full/no-device sends once;
  stale conflict preserves and recovers original snapshot and reconfirmed updated send has new ID;
  failed post-PATCH GET keeps editor blocked until watermark confirmed; idle child root-only update
  and subscription cleanup pass; profile narrowing/terminal supersession visible; active Stop works.
  Screenshots alone are insufficient for mutation/consent/neutral-color behavior.
- [ ] Run changed named web/design suites; `pnpm check:web-ui`, `pnpm check:i18n`, applicable design
  token/reference checks; `CAPYBARA_TEST_WORKERS=4 pnpm verify` in integrated branch after source
  handoffs. Record commands/counts/failures and dependency status. No extra broad reruns without cause.
- [ ] Publish review packet: exact file diff and frozen Task 7/8 bindings, RED→GREEN evidence by slice,
  first-send journal/queue evidence, desktop/mobile/keyboard/a11y and neutral-color results, blind
  reference report/CI baseline links if design changed, affected-package changeset(s), residual runtime
  gates. Conventional commit only during later implementation; this proposal creates no commit.

File-only clarification: consume existing human/reviewer deny/ask as no expansion. No
`fileOnlyRestriction` producer, new API/decision argument or file-only UI mode is introduced; that
source clarification still awaits Task 7 independent builder review.

Task 10 is not complete until its integrated UI/API tests and device handoff pass. Product acceptance
still requires Task 14 actual local/Docker/E2B and race evidence; unsupported/unprobed reports cannot
be advertised as provider support. Notify the maintainer only at the final integrated acceptance
requested in the parent session; an intermediate plan is not a completion notification.
