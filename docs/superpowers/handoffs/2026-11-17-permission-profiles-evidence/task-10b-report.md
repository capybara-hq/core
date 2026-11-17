# Task 10B report: neutral permission profile picker

Status: DONE_WITH_CONCERNS. Worktree `.claude/worktrees/perm-t10b`, branch `perm/t10b`, base
`a5185eb77`; commit `f0584546f` (`feat(web): add neutral permission profile picker`). No push or PR.

## What

Design (generic, existing components, no new component or token):
- `PickerItem.icon?: IconName`, `PickerItem.description?: string`, `PickerProps.action?` (a plain,
  non-choice item such as "Set up the review model"). ConvMenu `description` renders a two-line
  "described" row (`data-described`): name = label + tag (aria-labelledby), sentence =
  aria-describedby (`data-part="menu-desc"`). Phone `OptionsGroup` does the same for radios and
  renders the action as a dense ghost button (closes the sheet).
- Icons `hand`, `shield-check`, `lock-open` added via `gen-icons.mjs` (lucide-static).
- Neutral CSS only (`muted` icons and description, `disabled` with the row; no tone/accent).
- Spec: §6.16.2 permission picker line, §6.16.3 "Permission" bullet, picker-menu state
  `permission` + 7 size-table rows; reference block `picker-menu-permission` (conversation.js,
  reference.css, picker-menu.html); catalog `Block id="picker-menu-permission"`;
  `PERMISSION_FIXTURE` in design fixtures. Also folds Task 5's spec bookkeeping.

Web:
- `components/conversation/PermissionPicker.tsx`: `usePermissionChoice({orgId, deviceId, project,
  deviceLabel, context, initial?})` -> `{picker, dialog, selection}`; default Approve for me;
  known unavailable reasons (no device, checking, check failed, ceiling, unsupported, restricted
  null) as localized tags, raw provider reasons never shown; unprobed note "Checked when this
  device starts."; Full only via a Dialog naming device/project, consent bound to the displayed
  device + project + scopeRevision (frozen at open; mismatch on confirm grants nothing), cleared
  to Approve on another device/project/revision (also after returning to the first device);
  rename keeps it; non-Full choices survive device changes; review-model conditional note; settings
  action (`/settings/models?tab=purposes`) only for org admin/owner (`canUpdateOrg`).
  `useLockedPermissionPicker(profile, why)` for read-only display.
- Mounted read-only only (no request change): new conversation shows the default Approve for me
  (locked, desktop + phone); ConversationView shows the owner's recorded profile from an owner-gated
  `permissionsQuery` (strict `row.accountId === me.account.id`, `retryOnMountOf`), inherited hint for
  children (`rootConversationId !== id`), scheduled hint for `scheduledTaskId`; viewer: no picker, no
  GET. `ComposerBar` passes optional `pickers.permission`.
- `messages/{en,zh}.json`: `chat.permission.*` (approved spec zh copy; no Latin "agent").
- Changeset: design + web patch.

## RED / GREEN

- Design RED (before implementation): `pnpm exec vitest run --project design
  packages/design/test/composer-menu.test.tsx packages/design/test/composer-phone.test.tsx`
  -> 4 failed / 32 passed: descriptions absent from rows, look differed (icon/desc), no
  `menuitem` action, no "Full access Choose a device first" radio name. GREEN after implementation.
- Web: product-mount RED was real: 4 failed / 17 passed in `apps/web/test/permission-picker.test.tsx`
  (no permission picker on new chat / owner chat / child / scheduled). The 17 harness cases were
  written before `PermissionPicker.tsx` existed (module-resolution failure, not behavioral RED), so
  regression mutations were run after GREEN, each restored from a scratch copy:
  - Full given a warn badge -> initially still passed: the badge selector `[data-part="badge"]`
    matched nothing (Badge renders `.cb-badge[data-tone]`; Task 5's existing design assertion had the
    same blind spot). Strengthened to `.cb-badge, [data-tone]` in the app test and both design tests;
    rerun -> neutral-treatment test fails as intended.
  - Consent reset removed -> device-change test fails. Settings action for everyone -> member test
    fails. Full allowed without device -> no-device + phone tests fail.
- Adjusted existing assertions that assumed no locked element at all: `conversation-page.test.tsx`
  (issue U), `right-area.test.tsx` (no device), and Slice A's
  `conversation-permissions.test.tsx` refresh count 1 -> 2 (the page's own owner observer now
  reads once on an empty-cache mount; the test's probe refresh reads once).

## Commands and counts (final)

- `pnpm exec vitest run apps/web/test/permission-picker.test.tsx apps/web/test/conversation-permissions.test.tsx apps/web/test/conversation-page.test.tsx apps/web/test/right-area.test.tsx apps/web/test/new-conversation-page.test.tsx apps/web/test/conversation-cache.test.tsx`
  -> 6 files, 204 passed.
- `pnpm exec vitest run --project design packages/design/test/composer.test.tsx packages/design/test/composer-menu.test.tsx packages/design/test/composer-phone.test.tsx`
  -> 3 files, 52 passed.
- `pnpm exec vitest run --project web --project design --maxWorkers=6` -> 228 files, 4488 passed.
  (An earlier full web run had 2 `change-password.test.tsx` failures under load; it passed in
  isolation and on the final full run; untouched by this change.)
- `pnpm check:web-ui` passed; `pnpm check:i18n` passed; `pnpm check` all passed;
  `pnpm typecheck` passed (incl. web `next typegen && tsc`); Biome on touched files: no errors
  (one new `noDescendingSpecificity` warning in conversation-page.css of the same false-positive
  kind as the 3 pre-existing ones); `git diff --check` clean.

## Concerns / gates not done here

- Visual: not run locally. Required by the change flow and left to the controller: Linux
  `COMPARE=picker-menu,composer` in `mcr.microsoft.com/playwright:v1.64.1-noble` + blind pair
  review; real-browser computed-style equality of the three rows (jsdom proves structure only);
  `visual-update` workflow for baselines. Expected baseline changes: new `picker-menu-permission`
  block, icon catalog (3 icons), and every new-chat/owner-chat composer screenshot (extra locked
  permission value; phone options button name gains the profile). No screenshots committed.
- Owner chat on an empty-cache client navigation now issues one permissions GET (owner only);
  hydrated first paint still makes no browser read (tested).
- Unknown raw reasons: shown as a localized summary tag only; an ErrorDetail raw toggle is not
  mounted (no surface in a menu) — revisit when C/D add a details area.
- Interactive picker is exercised by harness tests only; product mounts are locked display.

## Remaining for C–E

- C: switch NewConversation from `useLockedPermissionPicker(DEFAULT)` to `usePermissionChoice`
  (`selection` -> atomic first-message body, attempt state, Full re-consent after 409, dialog mount).
- D: owner-root editing via `usePermissionChoice({context:"existing", initial})` + PATCH with
  expectedRevision, watermark/refresh label, root subscription, invalidation, starting-grant notice,
  child/scheduled stay locked.
- E: remove daily mode pickers/badges, owner ceilings, preview-prefix invalidation on project writes.
