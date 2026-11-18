# Task 10D report: live profile change, supersession and exact scope display

Status: DONE_WITH_CONCERNS. Worktree `.claude/worktrees/perm-t10d`, branch `perm/t10d`, base
`9a519a376`. Commits: `d61703c61` (`fix(web): never derive a Full access selection from a recorded
profile`) and `4f45c91e4` (`feat(web): change permission profiles live with exact scopes`). No push,
no PR. Web only. Kernel untouched.

## Kernel gap check

There is no gap. The kernel already provides everything Slice D needs:
- PATCH `…/permissions` with `expectedRevision` returns `{revision}`. A changed revision, binding or
  stale consent returns 409 `conflict`. Only an interactive root can be changed (`forbidden`
  otherwise).
- The GET view's `scopeRevision`, `availability` and `fullAccessCeiling` come from the same
  `facts.scope(row.device_id, row.project_path, row.project_name)` that the PATCH checks consent
  against. An existing chat therefore uses the view as its preview: no preview read, and the
  consent is bound to the conversation's own device, project and scope revision.
- `PermissionTransitions.recordLocked` appends `permission_profile_changed` to the root (with
  `revision` and `reason`). For each pending command card in the tree it sets status
  `superseded`, `superseded_revision` and `superseded_reason`, and appends `approval_decided`
  `{decision:"superseded", byAccountId:null, reason, revision}` to the card's own conversation.
- The approval API exposes `supersededRevision`/`supersededReason`. `command` carries
  `permissionScope`/`targetPath`/`candidateHash`. The `approval_requested.command` event carries
  `permissionScope`/`targetPath`/`candidateHash`.

## Blocker first: 10C review Minor 1 (commit d61703c61)

RED: a new test "shows Full checked but yields no selection; choosing Full again needs the dialog"
failed with `expected '{"profile":"full-access"}' to be 'null'`. GREEN: `usePermissionChoice`
`selection` is now `PermissionSelection | null`. A recorded Full is the current state without
consent and yields `null`. Picking the current profile is a no-op. Full is chosen again only
through the dialog. NewConversation refuses a `null` selection; this cannot happen there, because no
`initial` is passed. permission-picker: 23 passed; new-conversation-page: 34 passed.

## What (commit 4f45c91e4)

- `lib/query/permission-state.ts` (new). Tab-local watermark per QueryClient, keyed
  `account/org/root`. `raisePermissionWatermark` is monotonic. `permissionsConfirmed` is
  `view.revision >= required` (no exact equality). `keepNewerPermissions` is a structural-sharing
  guard: a lower revision of the same root never replaces the cached view.
  `permissionKeysOfRoot` and `refreshPermissionViews` cancel a first read in flight, then
  invalidate. `clearPermissionWatermarks` is called from `resetSession`.
  `subscribePermissionWatermarks` serves `useSyncExternalStore`. The module has no React import,
  because server code imports `permissions.ts`.
- `defineQuery` takes an optional `keep` (structural sharing). `permissionsQuery` uses it.
  `keys.org().conversationsAll()` is a prefix builder (check:web-ui forbids literal keys).
- `PermissionPicker.tsx`:
  - `usePermissionChoice` takes optional `preview` (no preview read) and `onChange` (an
    existing-chat edit; the displayed value stays the authoritative `initial`).
  - New `useConversationPermission`. It runs the owner-only read. An interactive root (no parent,
    no scheduled task) is editable only while confirmed and no PATCH is pending.
  - The PATCH runs through `useAppMutation`. Its `fn` raises the watermark right after the HTTP
    answer, before it returns, so before the invalidation.
  - The PATCH invalidates the root's permission views, the pending approvals in the log, and the
    inbox and its count. On success, a toast with the "applies to new operations" notice.
  - On any PATCH error the views are read again and an ApiErrorDetail is shown (409 has its own
    localized summary). Nothing is ever resent, and Full needs the dialog again.
  - Unconfirmed: the profile is shown locked with the hint "Last confirmed permissions. Refreshing
    before they can change again". A failed read shows ApiErrorDetail plus a Refresh button that
    only reads.
  - A child is locked as inherited and a scheduled task's conversation as scheduled.
- `useRootPermissionSubscription.ts` (new) is mounted once from ConversationView, only for an owner
  child (the root ID comes from the authoritative view).
  - The root row is read through an owner-enabled `conversationQuery`, for its `lastSeq` cursor
    only. The root's log is never read.
  - It opens `openConversationStream(…, {eventsOnly:true})`. The new `stream.ts` option ignores
    `draft`/`delta` frames, so no run drafts are read.
  - Every `onOpen`, including the browser's own reconnect, refreshes the views that name the root
    plus the viewed key.
  - Every delivered seq advances the cursor; a repeated or older seq is ignored. A profile event
    raises the watermark, then refreshes.
  - When the browser gives up, the root row is read again and the stream reopens from the cursor,
    at most 3 times. A server error frame stops it.
  - Cleanup closes the stream on unmount or when the org, account, viewed conversation or root
    changes, and a disposed guard drops late callbacks.
  - Root events never enter the child's window, and the root view opens no second subscription.
- `useConversation.ts` (root stream):
  - `permission_profile_changed` raises the watermark, with the account read from the cached
    `meQuery` (`useSession` is not available in every consumer), then refreshes the root's views.
  - `approval_decided` with `superseded` invalidates `approval(id)` and the inbox keys.
  - `CONVERSATION_SIDE_KEYS` now includes `permissions`. A viewer's key has no enabled observer, so
    no read happens.
- Exact scope:
  - Web types mirror Task 7: `PermissionScope`, `CommandAsk`/`CommandAskDetail`
    `permissionScope`/`targetPath`/`candidateHash`, `ApprovalStatus` `superseded`,
    `supersededRevision`/`Reason`, and decision `superseded` plus `revision`.
  - New `components/PermissionScopeDetail.tsx` uses only Stack and `Text pre`. It shows the
    read-write and read-only directories and the hosts whole, with the target file on a separate
    line. It is shared by ApprovalCard (pending and superseded) and the inbox detail.
- Superseded:
  - ApprovalCard renders a final block (StatusMark plus explanation text) before any
    ApprovalBlock, with no buttons. The user and authority-changed reasons are bilingual; the
    revision line comes from the event `revision` or the API `supersededRevision`.
  - `outcomeOf` maps the API fields separately.
  - `useDecide` failure invalidates `approval(id)` and the inbox (no retry).
  - The inbox overlays the cached `approval(id)` read without a request (`enabled:false`). A
    non-pending item gets only "Open conversation", with no Approve, Deny or ScopePicker.
- BackgroundSection: while a task or sub-agent runs, it shows the "keeps the permissions it
  started with … revoked access can still stop it" line (no per-task profile is claimed). Stop is
  unchanged.
- Copy: en and zh were added (`chat.permission.{unconfirmed,unconfirmedFailed,refresh,changed,
  conflict,saveFailed}`, `approval.decision.superseded`, `approval.permissionScope.*`,
  `approval.superseded.*`, `subagents.startingGrant`). No Latin "agent" and no 企业 in zh.
- Changeset `.changeset/live-permission-profile.md` (`@capybara-hq/web` patch).

## RED -> GREEN

- RED: the new tests ran with the src and messages changes stashed. permission-live.test.tsx
  failed to load (module missing). 11 tests failed: approval-card ×5 (scope, superseded,
  late click), inbox ×3, background ×2, picker owner-editable ×1. timeline-waiter's superseded
  cases passed at runtime before and after: the union change is type-level only, so they are
  characterization tests.
- Mutation checks after GREEN, each restored and each turning its named test red:
  - Without the onOpen refresh, the idle-child/race test fails.
  - Without the watermark in the PATCH `fn`, the failed-GET watermark test fails.
  - Without `keepNewerPermissions`, the slow-lower-read test fails.
  - Without the cursor dedupe, the idle-child test fails (duplicate reads).
  - Without the disposed guard on reopen, the "unmount during the recovery's root row read" test
    fails.
  - Without the session clear, the remount/resetSession test fails.
- Amendment-report cases are covered in `permission-live.test.tsx` (16 tests):
  - Idle child with no pending card and no cached root log, updated from a root-only event.
  - Root-only change with no navigation and no child event.
  - Open/read ordering: the root changed after the server read is recovered by the open GET.
  - Empty reconnect refreshes.
  - Cursor dedupe, including an older seq and non-profile root events.
  - Lifecycle: give-up reopens after the cursor; unmount during recovery; error frame stops; unmount
    closes; late events are ignored.
  - Zero viewer subscription, read or root row read.
  - No root event is appended to the child window.
  - Root view: one stream only.
  - Watermark:
    - PATCH N+1 followed by a failed GET (the app's 5xx retry included): cached N stays, locked
      and unconfirmed, with no second PATCH.
    - Refresh confirms. A higher revision than the PATCH answer is accepted.
    - Root event N+2 followed by a GET at N+1 stays locked.
    - A slow lower read never overwrites a newer view.
    - Remount keeps the barrier and resetSession clears it.
  - 409 re-reads and never resends.
  - Full: dialog for the conversation's own device name; cancel sends nothing; PATCH carries
    `consentScopeRevision` and `expectedRevision`; after a 409 the dialog is required again.
- Other tests: approval-card +5 (exact arrays, long path, no inferred parent, event and API agree,
  superseded before first paint with zero requests, API-mapped authority change, late click),
  inbox +4, timeline-waiter +2, `background-starting-grant.test.tsx` 2.
- Existing tests adjusted for the approved behaviour change: the owner root is now editable, not
  locked (permission-picker, conversation-page "issue U", right-area "no device bound"), and
  catch-up side reads now include `/permissions` (conversation-cache, conversation-page). The
  owned-child hydration test now asserts that the only browser read is the root-row bootstrap.

## Commands (CAPYBARA_TEST_WORKERS=2 / --maxWorkers=2)

- `pnpm exec vitest run apps/web/test --maxWorkers=2`: 188 files, 3487 passed, 0 failed.
- `pnpm typecheck` passed. `pnpm check` passed (all checks, including Web UI rules and UI copy).
  `pnpm check:web-ui` and `pnpm check:i18n` passed. Biome on the touched files is clean.
  `git diff --check` is clean.
- No kernel change, so no kernel tests were run. No dev stack and no local visual baselines.

## Concerns / not done

1. The owner-child first paint now makes one browser read after mount: the root row, for the
   cursor. Its open GET is deliberate. The plan counts it separately; a server prefetch of the
   root row would need the root ID, which only the permissions read provides.
2. The design system was not changed. Superseded is a terminal Text/StatusMark composition, not a
   HITL state. The scope detail uses Stack/Text plus `data-*` divs, as ApprovalCard already does.
   A visual review and CI `visual-update` are still needed: the editable root picker replaces
   the locked one, and new superseded and scope blocks were added.
3. Unknown outcome of a PATCH (network loss): the views are read again and the change is not
   resent. A PATCH that silently succeeded shows as the new authoritative profile, without a
   watermark because no revision is known. This is acceptable, as GET is authoritative.
4. A PATCH does not invalidate queue/background data. Supersession events and the existing stream
   refreshes cover cards. The plan's "affected conversation queue/background when displayed" item
   was judged unnecessary.
5. The scheduled-conversation lock and the inherited lock lose their specific hint while
   unconfirmed (they show "last confirmed" instead).
6. Owner-change (ownership generation) is covered through the effect identity (account, org,
   viewed conversation, root), not a separate generation counter.
7. Slice E (mode pickers) is untouched. Task 14 e2e and runtime acceptance are still open.

## Fix round 1 (review `task-10d-review.md`)

Commit `c0f107524` (`fix(web): keep an unanswered permission change unconfirmed`). Web only.

RED first: five new tests in `permission-live.test.tsx` ("fix round 1"). Before the fix, Minors 1,
2, 4 and 5 failed on their assertions. Minor 3 failed with "expected 0 to be greater than 0" (the
wait card's approval was never read again).

- Minor 1. A PATCH that gets no answer (no `ApiClientError`, status 0 or 5xx) records
  `unknownAt`, cancels the in-flight permission read and reads again. The view counts as
  confirmed only when the read's `dataUpdatedAt` is later than `unknownAt`. A read that was in
  flight at the failure was cancelled, so any later success started after the failure. Until
  then the profile is locked as "last confirmed", with the new `chat.permission.unknownOutcome`
  copy (en/zh: the change "may or may not have been saved") and the Refresh button, which only
  reads. A new choice clears the marker. The unused `saveFailed` key was removed.
- Minor 2. `usePermissionChoice` now stores the open question as `{preview, revision}` and takes
  `revision` and `editable` as inputs. If the picker becomes non-editable or another revision is
  displayed, the question is cleared during render. A Full dialog closed by a newer revision
  therefore never reappears by itself.
- Minor 3. A PATCH now invalidates `openWaitReads(events).approvals`. That covers this log's
  pending asks plus the sub-agent waits the root page shows, and replaces `pendingApprovalIds`.
- Minor 4. `deviceLabel` is `string | undefined`, and ConversationView passes `undefined` while
  the bound device is being read. With a device set and no name, Full gets the "Checking this
  device…" reason, so the dialog never names the device "—".
- Minor 5. Refresh shows whenever the view is unconfirmed and no read is in flight. The error
  details and the explanatory line appear only when they apply.
- Minor 6. The watermark `subscribe` is memoized with `useCallback([qc])`. The watermark type is
  renamed `PermissionWatermarkScope`. In the inbox, a final denied item uses the `failed`
  StatusMark, as ApprovalCard does. `PermissionScopeDetail` keys values by index.

Run with --maxWorkers=2:
- permission-live, permission-picker, approval-card and inbox: 4 files, 123 passed.
- conversation-page, right-area, conversation-cache, new-conversation-page,
  background-starting-grant, timeline-waiter and conversation-permissions: 7 files, 207 passed.

`pnpm check:web-ui`, `pnpm check:i18n` and `pnpm typecheck` passed. Biome is clean on the touched
files, and `git diff --check` is clean.
