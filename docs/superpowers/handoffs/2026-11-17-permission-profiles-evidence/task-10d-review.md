# Task 10D independent review

Scope: `git diff 9a519a376 4f45c91e4` on `perm/t10d` (`d61703c61`, `4f45c91e4`), worktree
`.claude/worktrees/perm-t10d`. Read-only: no edits, commits or pushes. Judged from code first,
the author's report read afterwards.

## Verdict: APPROVE

No Critical or Important findings. Six Minor findings below; none blocks merging Slice D. Slice E
material did not leak in: no device mode, ceiling or link page files were touched.

## Verification run (CAPYBARA_TEST_WORKERS=2, --maxWorkers=2)

- Touched web tests (permission-live, approval-card, inbox, background-starting-grant,
  timeline-waiter, conversation-cache, conversation-page, permission-picker, right-area):
  9 files, 268 passed.
- `pnpm exec vitest run apps/web/test --maxWorkers=2`: 188 files, 3487 passed, 0 failed.
- `pnpm check:web-ui`: passed. `pnpm check:i18n`: passed.
- `tsc -p apps/web/tsconfig.json --noEmit`: clean. Biome on the 29 touched files: clean.

## Kernel contract cross-check

- The GET view (`PermissionFacts.view`) and the PATCH consent check
  (`PermissionProfilesService.consent`) both call `facts.scope(orgId, row.device_id,
  row.project_path, row.project_name)` on the same root row. So the view that the web uses as the
  Full preview (`PermissionPicker.tsx` `useConversationPermission`, `preview:` built from
  `view.deviceId/scopeRevision/availability/fullAccessCeiling`) is the same set of facts the PATCH
  validates. The kernel also rechecks `expectedRevision`, the binding (device, project) and the
  consent scope revision under the root lock.
- `permission_profile_changed` is appended only to the root, with `revision`/`reason`, and the
  actor may be null. `PermissionTransitions.recordLocked` sets every pending `command` approval in
  the tree to `superseded` with `superseded_revision/reason`. It appends `approval_decided
  {decision:"superseded", byAccountId:null, reason, revision}` to the card's own conversation and
  notifies after commit. The approval API exposes `supersededRevision/Reason`, and
  `command.permissionScope/targetPath/candidateHash` (`PermissionExpansionSchema`:
  read/write directories and hosts). The web types in `lib/approvals.ts` and
  `lib/conversations.ts` mirror these exactly.

## Focus areas: findings

**Consent safety: OK.**
- A recorded Full gives `selection: null` (`d61703c61`, tested), and the existing-chat path never
  writes local choice state (`choose` → `onChange`).
- Full goes only through the dialog. `asking` freezes the view-derived preview. `confirm`
  re-checks the device, project and `scopeRevision` against the current view, and the PATCH
  carries `consentScopeRevision` plus `expectedRevision`.
- New conversations refuse a null selection.

**Watermark: OK.**
- The watermark is raised inside the mutation `fn` before `useAppMutation` invalidates. A root
  event raises it before `refreshPermissionViews`.
- It is monotonic, the comparison is `>=`, and `keepNewerPermissions` structural sharing stops a
  slower lower read from overwriting a newer view.
- It is keyed by QueryClient, account, org and root, so it survives remount. `resetSession` clears
  it, and every org switch and sign-out goes through `resetSession`.
- Skipping the watermark on an unknown-outcome PATCH is safe against a double apply, because the
  kernel CAS on `expectedRevision` turns any repeat into a 409. The display gap this leaves is
  Minor 1.

**Root subscription: OK.**
- Owner-only: `inheritedRootId` is set only for an owner child, and a viewer makes zero reads.
- Every open (including the browser's own reconnect) refreshes and cancels a first read first.
  The cursor starts at the root row's `lastSeq` and every seq advances it; older or repeated seqs
  are ignored.
- Reconnect is bounded (3 consecutive, the same pattern as `useConversation`). A server error frame
  stops it. Cleanup uses the effect identity plus a `disposed` guard.
- `eventsOnly` reads no drafts, and nothing reaches the child's EventWindow.

**Supersession: OK.**
- The log carries the outcome, so the card is terminal on first paint with no read. The early
  return in ApprovalCard comes after all hooks.
- A late click hits a `useDecide` failure, which invalidates `approval(id)` and the inbox and never
  retries.
- In the inbox, a cached non-pending detail removes Approve, Deny and ScopePicker. That read uses
  `enabled:false`, so no request is made.

**Other focus items: OK.**
- Exact scope: `PermissionScopeDetail` uses `Text pre`, which is `pre-wrap` plus
  `overflow-wrap:anywhere`, so nothing is clipped. Write, read and hosts are separate from the
  target, and nothing is inferred. ApprovalCard and the inbox share it, and the event and API
  values agree (tested). No boxes, no styles.
- Locked children and scheduled conversations: a child is "inherited" and a scheduled one is
  "scheduled". `interactiveRoot` mirrors the kernel's parent/scheduled refusal.
- 409: `onError` re-reads and shows the localized conflict summary. It never resends.
- Copy: en and zh are complete; zh uses 智能体 and has no Latin agent and no 企业.

**Test edits: justified.**
- The owner root is now editable rather than locked (permission-picker, conversation-page,
  right-area).
- `/permissions` joins the catch-up side reads.
- The owned-child hydration test now allows exactly the deliberate root-row bootstrap read after
  first paint, as the plan counts it separately.

**Should PATCH invalidate queue/background data? No.**
- A profile change does not change queue entries or the background list. Narrowing cancels
  nothing, and starting grants are retained.
- Superseded cards arrive as `approval_decided` on each card's own stream, which the new handler
  turns into `approval(id)` and inbox invalidations.
- The one gap is sub-agent wait cards shown in the root page (Minor 3).

## Minor

1. **Unknown-outcome PATCH shows a possibly stale profile as confirmed.**
   - Where: `apps/web/src/components/conversation/PermissionPicker.tsx:434-437` (onError),
     `:477-491` (notice).
   - Scenario: the owner picks Full and the PATCH commits, but the response is lost to a network
     drop. No watermark is raised, the follow-up GET also fails, and `confirmed` stays true on
     cached N. The picker therefore stays editable and shows "Request approval" as current while
     the server is on Full. The notice shows only the PATCH error, not the "last confirmed" label
     or a Refresh button.
   - Impact: this is not a consent breach (the user just confirmed Full) and not a double apply (a
     repeat PATCH gets a 409). Once the stream reconnects, `permission_profile_changed` corrects
     the view.
   - Fix: on a failure without an HTTP status, or a 5xx, record a local "unknown since" marker
     scoped to this root. Until a read that started after the failure succeeds, show the
     `unconfirmed` label with the GET-only Refresh.
   - Related: `chat.permission.saveFailed` is defined in en/zh but never used. Its "Couldn't change
     the permissions" wording would be wrong for an unknown outcome anyway, so either remove it or
     reword it as "may or may not have changed".
2. **The Full dialog can come back by itself.**
   - Where: `PermissionPicker.tsx:495-496` (`dialog: editable ? choice.dialog : null`) with
     `usePermissionChoice`'s `asking` state.
   - Scenario: the owner opens the Full dialog, then a root event or other-tab change raises the
     watermark. The dialog disappears, but `asking` stays set. When the read confirms, the dialog
     reappears unprompted, and its confirm would PATCH against the new `view.revision`.
   - Impact: the kernel still validates `consentScopeRevision`, and the user must still click.
     But consent is collected about a state they may not have been looking at.
   - Fix: clear `asking` whenever the picker is not editable, or whenever `view.revision` changes
     (for example by adjusting during render, as the consent reset already does).
3. **PATCH does not refresh sub-agent wait cards in the root page.**
   - Where: `PermissionPicker.tsx:425-429`. `pendingApprovalIds(o.events)` only covers the root's
     own log.
   - Scenario: a child's `command` approval is shown in the root through `SubagentWait`
     (`fromRead`). The kernel supersedes it, but the `approval_decided` lands only in the child's
     log, so the root page shows the card as pending until the sub-agent progress clears the wait.
   - Impact: a click re-reads it and turns it terminal (safe).
   - Fix (optional): also invalidate the approval ids of the current sub-agent waits, or accept it
     and note it for Task 14.
4. **The Full dialog may name the device as "—".**
   - Where: `apps/web/src/components/conversation/ConversationView.tsx:271`
     (`deviceLabel: device.data ? deviceName(device.data) : "—"`).
   - Scenario: if the bound-device read is still loading or failed, the dialog asks "Use Full
     access on —?" even though the consent is bound to `view.deviceId`.
   - Fix: make Full unavailable (a "checking" reason) until the device name is known, or fall back
     to a non-empty label.
5. **No recovery when unconfirmed but not erroring.**
   - Where: `PermissionPicker.tsx:477`. The Refresh button appears only when `read.isError`.
   - Scenario: if a successful read ever lands below the watermark with nothing in flight, the
     picker stays locked as "Refreshing…" with no button. `refetchOnWindowFocus` is false, so only
     a stream event or reconnect clears it. This is unlikely, since PG reads after commit and
     events are monotonic.
   - Fix: show Refresh whenever `!confirmed && !read.isFetching`.
6. **Small cleanups.**
   - `useSyncExternalStore` gets a new inline subscribe function on every render
     (`PermissionPicker.tsx:394-399`), so it resubscribes each render; memoize it with
     `useCallback([qc])`.
   - `permission-state.ts:14` exports a type `PermissionScope` (account/org/root) that collides by
     name with `lib/conversations.ts` `PermissionScope` (directories and hosts); rename it to
     `PermissionWatermarkScope`.
   - In the inbox, a final `denied` item gets the `cancelled` StatusMark
     (`inbox/view.tsx` actions), while ApprovalCard uses `failed` for denied; align the two.
   - `PermissionScopeDetail` keys values by the value itself (`key={v}`), so duplicate entries would
     collide; key by index.

## Author's report

The report matches the code. Its concern 3 (unknown outcome) is Minor 1 above, with the display
gap stated precisely. Its concerns 2 (visual review / `visual-update` still needed) and 7 (Slice
E, Task 14 runtime acceptance) remain open gates outside this slice's approval.
