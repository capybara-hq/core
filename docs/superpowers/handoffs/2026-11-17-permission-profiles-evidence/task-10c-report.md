# Task 10C report: atomic first send, retry envelope and optimistic handoff

Status: DONE_WITH_CONCERNS. Worktree `.claude/worktrees/perm-t10c`, branch `perm/t10c`, base
`98c8d554f`; commit `04eab10ec` (`feat(web): send the chosen permission profile with the first
message`). No push, no PR. Kernel untouched: no gap found.

## Kernel gap check

`POST /api/v1/orgs/:orgId/conversations/first-message` (SessionOnly; `CreateBody` with required
message and `permission`) already provides what Slice C needs: 201 create / 200 idempotent retry by
`(org, account, clientMessageId)` plus request hash, generic 409 `conflict` for stale consent and for
changed-body reuse, omitted `deviceId` for non-Full, and the `permission_profile_changed` revision-0
event in `events`. No kernel change was made.

## What

- `lib/conversations.ts`: `createConversationWithMessage` (legacy `POST /conversations` from the
  browser) replaced by `serializeFirstMessage(request, clientMessageId)` (builds the body once,
  browser context materialized once) and `submitFirstMessage(orgId, serializedBody)` (sends the
  exact bytes to `/first-message`). Added a web `permission_profile_changed` event type (payload as
  Task 3 emits it).
- New pure `components/conversation/first-message-attempt.ts`: states `sending`,
  `outcome-unknown`, `rejected` (+ `conflict` flag for generic 409), `resolved`; stores org/agent/
  clientMessageId/intentKey/serializedBody/hadUnknownOutcome/message/result. `firstMessageIntent`
  covers org, agent, text, resources, files, skill, model, effort, device, project, profile and
  consent revision (independent of ComposerBar's draftKey). Network/abort/5xx -> outcome-unknown;
  4xx -> rejected. Recoverable = unknown, conflict, or any refusal after an unknown outcome; a definite
  non-409 refusal of a never-unknown attempt is dropped (it created nothing).
- `NewConversation.tsx`: interactive `usePermissionChoice` (default Approve for me, Full via the
  existing Dialog for the displayed device/project/revision, reset on device/scope change). Attempts
  live in page state above the composer's sent/new remount. Unchanged send = retry of the
  recoverable original (same bytes/id); changed send = new attempt with a new id (fresh id even if
  the composer kept its draft id). Inline recovery line per recoverable attempt (unconfirmed or
  conflict copy + "Retry original sends it exactly as it was; sending a changed message starts a new
  request.") with a Retry original button; a button retry keeps the composer and its newer draft,
  does not navigate, and on success offers "Open its conversation" (LinkButton). 409: clear Full
  consent (`clearFullAccess`) and invalidate the device's `permissionPreviewAll`; never auto-resend.
  In-flight guard; an `alive` ref stops late answers after unmount from navigating/updating (the
  cache is still seeded and groups invalidated). Device-offline/no-cloud no longer blocks: the reason
  is muted text, the send omits deviceId/project and no preview is read (Full disabled, "Choose a
  device first").
- `PermissionPicker.tsx`: review M2 fixed (a starting `initial` that changes after mount is taken
  over, render-time adjustment); `clearFullAccess()`; exported `recordedProfile(events)`.
- `ConversationView.tsx`: owner sees the log's recorded profile (revision-0 event from the seeded
  answer) while the owner permissions read loads; viewers never (owner-gated as before). No seeded or
  fabricated permissions view.
- Copy: `chat.firstSend.*` en/zh (no Latin "agent", no 企业), `chat.deviceOffline` reworded.
- Changeset `.changeset/atomic-first-message-permission.md` (`@capybara-hq/web` patch).

## RED -> GREEN

RED before implementation (`new-conversation-page`, `conversations-lib`, `first-message-attempt`,
`conversation-project`, `composer-skills`): 25 failed / 65 passed, plus the attempt module file
failing to load. New tests (new-conversation-page "Task 10 slice C" block, 12): default Approve with
only one first-message write; Request approval; Full consent dialog (cancel, confirm, unprobed note,
consented scope-1 sent); device change resets Full; phone options sheet; lost reply retried with
identical bytes (one navigation); stale Full 409 -> consent cleared, preview re-read, Retry original
identical bytes, repeat 409 sends nothing more, reconfirmed scope-2 sent with a new id; 409 clears
Full even if the re-read scope looks unchanged; lost reply -> changed profile -> generic 409 ->
original recovered with its own bytes, link offered, newer draft/profile kept, no navigation; late
answer after unmount; handoff shows recorded Request approval while the permissions GET hangs, no
Approve flash, pending bubble once; viewer never shows the recorded profile nor reads permissions.
Device tests: offline-only now sends without device (Request approval, zero preview reads); no
provider sends `approve-for-me` without device. Lib: exact body/bytes, no deviceId for device-less.
Pure: intent, classification, conflict keeps envelope/unknown, recoverability, lookup.
permission-picker: new-chat picker now interactive (zero first-paint browser reads); M2 test.
Mutations after GREEN (each restored): no retry reuse -> lost-reply test fails; no alive guard ->
late-answer test fails; no recorded fallback -> handoff test fails; no clearFullAccess -> the
unchanged-scope 409 test fails (the stale-scope test alone did not catch it, so that test was added);
no initial sync -> M2 test fails.

## Commands (final)

- `pnpm exec vitest run` on conversation-permissions, conversation-page, new-conversation-page,
  conversation-project, permission-picker, conversation-cache, composer-skills, conversations-lib,
  first-message-attempt, right-area -> 10 files, 281 passed.
- `pnpm exec vitest run --project web --project design --maxWorkers=6` -> 228 files, 4501 passed.
- `pnpm exec vitest run packages/kernel/test/conversations/permission-profiles.http.test.ts`
  (unchanged kernel; journal/rollback evidence incl. "stale displayed Full consent rolls back
  creation and its run obligation", "persists both restricted initial selections without a device
  and rejects changed-body retries", "initializes only the winning root epoch …") -> 15 passed.
- `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm check` (all), `pnpm typecheck` passed; Biome on
  touched files clean; `git diff --check` clean.

## Concerns / not done

- Browser e2e with a real SessionOnly UI send and harness inspection of the initial profile event and
  queued run obligation before worker admission was not run (no dev stack/Playwright in this slice);
  evidence pending for Task 14 / Slice F. Kernel ordering evidence is the HTTP test above.
- The composer's send button is not relabeled "Send updated request"; the inline recovery line says
  a changed send starts a new request (ComposerBar has no send-label slot; no design change made).
- While a Retry original from the recovery line is in flight the line hides and the composer is
  disabled, with no separate progress text.
- Two recoverable attempts with the same text show two identical lines (oldest first).
- On 409 only the currently selected device's preview is invalidated (the attempt's own device, if
  different, is not).
- `usePermissionChoice` with `initial: "full-access"` yields a Full selection without consent; only
  relevant to Slice D's existing-conversation editing.
- Visual baselines: new-chat composer now has an interactive permission button instead of a locked
  value, plus the recovery line state; no local baselines; `visual-update` needed.

## Fix round 1 (review `task-10c-review.md`)

Commit `0ecb95471` (`fix(web): name each first-send recovery line and refresh its own device`).

- Minor 2: each recovery line now quotes the first 40 characters of its text, plus the profile and
  device it would resend: "“go” with Full access on Personal." or "…, without a device." (zh:
  "“go”，完全访问，设备 …。"). The attempt stores `deviceId`, `profile` and `controlsKey`
  (`firstMessageControls`: agent, model, effort, device, project, profile and consent revision).
  `PROFILE_KEY` is exported from PermissionPicker.
- Minor 3 (optional, done within what the page knows): when the composer's current choices differ
  from the attempt's `controlsKey`, the line says "Your choices changed since: sending now starts a
  new request, and Retry original sends it as it was." Otherwise it keeps the general sentence.
  Text edits alone are not detected, because the page does not see the draft.
- Minor 4: a 409 invalidates `permissionPreviewAll` for the refused attempt's own device as well
  as the displayed one. New test "a 409 on the original for another device refreshes that device's
  preview too": a mutation that drops the attempt's device makes it fail.
- Minor 5: the four 20 ms sleeps were replaced with state barriers: the greeting heading plus an
  `act` flush; the recovery line reappearing after the attempt settles (twice); and, after unmount,
  the groups query marked invalidated, which happens right before the skipped navigation, plus the
  seeded row. One older 10 ms sleep at line 234 (an existing focus test) was left, as it is out of
  scope.
- Minors 1 and 6 were left as instructed (blocking Slice D; Task 14).

Run with CAPYBARA_TEST_WORKERS=2 and --maxWorkers=2: new-conversation-page, first-message-attempt,
permission-picker, conversation-page, conversations-lib, conversation-project, composer-skills and
conversation-permissions gave 8 files, 227 passed. `pnpm check:web-ui`, `pnpm check:i18n` and
`pnpm typecheck` passed; Biome on the touched files is clean; `git diff --check` is clean.
