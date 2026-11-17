# Task 10C review: atomic first send (commit 04eab10ec, branch perm/t10c)

Reviewer: independent read-only review, 2026-11-17. Diff `98c8d554f..04eab10ec` (16 files, web only).
The code was judged first; the author's report was read afterwards. No edits, commits or pushes.

## Verdict: APPROVE (no Critical, no Important; 6 Minor)

## Consent safety (the focus)

No path sends `full-access` with a consent that is not tied to a device/project/scopeRevision the
person confirmed in the dialog:

- `usePermissionChoice` (PermissionPicker.tsx:146-194) gives Full only through `confirm()`. Confirm
  checks that the frozen preview still matches the current device, project and `shown.scopeRevision`.
  The render-time reset (:159-166) drops the consent when the device, project or displayed revision
  changes. `selection` (:262-265) carries `consentScopeRevision` only from a stored consent. The send
  closure in NewConversation.tsx:269-294 reads `device.*` and `permission.selection` from the same
  render, so the device and the consent in the body always match.
- Kernel defence in depth: `createWithMessage` refuses Full without `deviceId`.
  `PermissionProfilesService.consent` refuses Full without `consentScopeRevision`, and refuses Full
  when the current preview revision, ceiling or support differs, with a generic 409 inside the
  transaction. Idempotency (`findCreated`, keyed by id plus request hash) runs before consent
  validation, so a Retry original of a committed attempt returns 200. It is not falsely refused.
- `initial: "full-access"` (PermissionPicker.tsx:146-155) yields `{profile:"full-access"}` with no
  consent, but nothing reaches it now. The only caller, NewConversation.tsx:184, passes no `initial`.
  The kernel would answer 409 in any case. It does not need closing in Slice C. Slice D must close it
  before it wires `initial` (Minor 1).
- Retry original resends the original bytes, including a Full consent for the device and revision
  shown when the person confirmed, even if the composer now shows another device or profile. The
  spec requires this (exact original bytes, no extra dialog). The consent stays bound to what was
  confirmed, and the kernel checks the revision again. The rows do not say what they will resend
  (Minor 2).

## Requirement checks

| Requirement | Result |
|---|---|
| Uses `POST /conversations/first-message`, body matches `FirstMessageBody` (strict: agentId, message incl. clientMessageId/timeZone/locale, deviceId?, project?, permission) | OK, lib/conversations.ts:735-762 |
| Never create-then-PATCH; no legacy `POST /conversations` from the browser | OK. `createConversationWithMessage` was removed; tests assert the only write is first-message |
| 409 clears Full, refreshes preview, never auto-resends | OK, NewConversation.tsx:250-257. The test "a 409 drops Full consent even when the scope read again looks unchanged" shows nothing is resent |
| Retry = identical bytes and same clientMessageId; any change = new id | OK. Bytes are frozen in `startFirstMessage`, `retryFirstMessage` only changes the state, and the intent covers org, agent, text, resources, files, skill, model, effort, device, project, profile and revision. A draft id that is already taken is replaced (:289-293) |
| Outcome classification | Network, non-API or 5xx gives unknown; 4xx gives rejected; 409 sets `conflict`. Generic 409 is never read as rollback (`hadUnknownOutcome` is kept) |
| No-device path | OK. deviceId and project are omitted, the preview query is disabled, Full is disabled with "Choose a device first", and the test asserts zero preview reads and no write but first-message. The kernel's `forNew` returns null without a cloud provider |
| Unprobed | Note copy only, no provisioning (Slice B, unchanged) |
| Late answers after unmount | `alive` ref (:224-231): no navigation and no state update. Cache seeding and group invalidation still happen, which is correct because the conversation exists. One request at a time (`inFlight` ref plus `sendDisabled`), so no answer can settle another attempt while the page is mounted. An org switch is a full navigation (`resetSession`), so no org-generation race exists |
| Owner/viewer | ConversationView.tsx:275 `owner ? recordedProfile(...)`. The viewer is still gated out of the owner read (`enabled: owner`), with a test |
| Handoff without an Approve flash | The seeded revision-0 `permission_profile_changed` event is shown, locked, while the owner GET loads. Nothing is fabricated |
| Slice B M2 (late `initial`) | Correct "adjust state during render" pattern; the test covers the late value, a changed value and an unchanged value keeping the person's pick |
| Web rules | No styles (design components only: Stack, Text, Button, LinkButton, FormError, Dialog). `submitFirstMessage` is called only inside a `useAppMutation` `fn`. `invalidates: () => []` plus the manual non-awaited groups invalidation is the existing pattern, kept so navigation does not wait. Acceptable |
| Copy | en and zh added in step. zh has no Latin "agent" and no 企业. Changeset present |
| D/E leakage | None: no PATCH, no supersession, no exact-scope display, no mode removal |
| Edits to existing tests | Justified: endpoint rename (`/first-message`), new-chat picker locked→editable (the approved behavior), and offline devices "send waits"→"restricted send without device" (required by the preflight no-device rule) |

## Findings

### Minor 1: latent Full without consent through `initial` (PermissionPicker.tsx:146-155, 262-265)
Scenario (Slice D): an existing chat passes `initial: "full-access"` from the GET. The picker shows
Full checked while `selection` is `{profile:"full-access"}` with no revision. A PATCH or send then
gets a 409, or Slice D code could mistake the recorded profile for a fresh consent.
Fix in Slice D, before wiring `initial`. Either type `initial` as a non-Full profile, or model the
recorded Full as a separate "current, unchanged" state that emits no selection, and never
synthesize a selection without consent. This is not reachable now, and the kernel fails closed.

### Minor 2: recovery rows do not identify their attempt (NewConversation.tsx:378-400)
Scenario: two unknown outcomes give two identical rows with two identical "Retry original" buttons.
The rows also do not say that the retry may resend Full access for another device than the one
displayed. Fix: give each row a short text excerpt plus the profile and device label (all stored in
the attempt). This is acceptable for this slice. Do it before the integrated acceptance (Task 14).

### Minor 3: no "Send updated request" label (plan wording)
Scenario: after an unknown outcome, a scope refresh clears Full or a device refetch changes the
default. The person's "unchanged" Enter is then a new logical request and may create a second
conversation. The inline line explains this in general terms. Fix (optional): show the new-request
sentence only when the current draft's intent differs from the recoverable attempt, or add a send
label slot through the design flow later. Acceptable as recorded.

### Minor 4: a 409 refreshes only the currently selected device's preview (NewConversation.tsx:253-256)
Scenario: a Retry original of an attempt for device A gets a 409 while device B is selected. A's
cached preview stays stale until it is read again; the `live` freshness rereads it on use. A
consent given against that stale cache is still refused by the kernel. Fix: also invalidate the
attempt's own device (parse it from the stored request or keep it on the attempt).

### Minor 5: fixed 20 ms sleeps for negative assertions (new-conversation-page.test.tsx:402, 877, 919, 972)
AGENTS.md says "no fixed sleeps". The pattern already existed (the replaced offline test used it).
Fix (optional): assert with a deterministic flush, or wait until the preview GET or the attempt state
settles and then check the call count.

### Minor 6: e2e journal/queue evidence still pending
The plan makes this compulsory before claiming atomic first operation. The author ran the kernel
`permission-profiles.http.test.ts` (15 passed, by their report; not rerun here because the machine
is loaded). The Playwright UI send with harness inspection is deferred to Task 14. The changeset
only claims the web uses the atomic request, which is fine. The gate stays open.

## Assessment of the listed UX gaps
- No send-button rename: acceptable now (Minor 3).
- Duplicate recovery rows: acceptable now; label them before Task 14 (Minor 2).
- 409 refreshes only the current device: acceptable; a cheap fix (Minor 4).
- No progress text while a Retry original is in flight: acceptable, because the composer is disabled.
- `initial: "full-access"`: not reachable now; it is a blocking item for Slice D (Minor 1).

## Commands and counts (worktree perm-t10c, CAPYBARA_TEST_WORKERS=2, --maxWorkers=2)
- Touched tests, batch 1 (first-message-attempt, conversations-lib, permission-picker,
  new-conversation-page): 4 files, 74 passed.
- Touched tests, batch 2 (composer-skills, conversation-page, conversation-project): 3 files, 129 passed.
- `pnpm exec vitest run apps/web/test`: 186 files, 3456 passed, 0 failed.
- `pnpm check:web-ui`: passed. `pnpm check:i18n`: passed.
