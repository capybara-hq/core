# Task 10 Slice E review: owner ceilings replace the daily device mode

Reviewed: `perm/t10e` commit `780ce49bf` against `077de1ac9` (read only; judged from code, then the
author's report). Kernel files touched: none (`git diff --stat -- packages` is empty).

## Verdict: APPROVE

No Critical or Important finding. The web cannot widen a local ceiling, cloud widening is sent only
from the confirmation with exactly `{ownerCeiling:{fullAccess:true}, confirmWidening:true}`, and the
request shapes match the kernel DTOs on this branch. The Minor items below can go into a follow-up or
the Slice F packet.

## Contract verification (code, this branch)

- **Local POST `/devices/:id/policy`** (`packages/kernel/src/devices/dto.ts` `DevicePolicyBody`,
  `narrowOnly` in `devices.service.ts`). The web sends exactly `{ownerCeiling:{fullAccess:false}}`,
  `{ownerCeiling:{restrictedProjectReach:"workspace"}}`, legacy `{mode:"sandbox"}` and `{add}` /
  `{remove}` (`DeviceModeSection.tsx:338,355,365,548,575`). `DevicePolicyPatch.ownerCeiling` is
  typed `fullAccess?: false; restrictedProjectReach?: "workspace"` (`lib/devices.ts`), so a widening
  body does not typecheck. `updateDevicePolicy` has one caller, `DeviceModeSection.tsx:194`. The
  device-link confirm sends no ceiling field (new test).
- **Ownership states.** `ownerCeiling` buttons appear only for `state:"report"`, the single legacy
  narrowing only for `legacy`, and nothing for `blocked`, `missing` or no machine. This matches
  `device-policy.service.ts:214` (ownerCeiling needs `state === "report"`; anything else is
  `unsupported`).
- **Gating.** Buttons need `online === true` and the `policyOpId` feature
  (`DeviceModeSection.tsx:206`). Otherwise the page shows a muted reason and the keycaps, not a
  refused button.
- **Cloud PATCH** (`DevicePatchBody`, `cloudOwnerCeilingLocked`):
  - Narrowing sends `ownerCeiling:{fullAccess:false}` once the device is migrated
    (`ownerCeiling !== null`, which the view sets when `owner_full_access` is not null), and
    `{mode:"sandbox"}` before that. Both match the kernel.
  - Widening is offered only when the device is migrated, `allowedMode === "auto"` and the owner
    ceiling is off (`DeviceModeSection.tsx:400`). The only call site is the dialog's confirm
    (`:198-201`, `:275`).
  - `deviceCeilingOf`'s cloud `ownerAllows` (`fullAccess && !(mode==="sandbox" && allowed)`) agrees
    with the kernel's `current = cloudChosenMode(row) !== "sandbox"`, because `mode.mode` for cloud
    is `cloudChosenMode` cut by `allowedMode`.
  - The old `mode: null` widening ("follow the org") is no longer sent anywhere.
- **CLI text.** `CEILING_COMMAND` = `capybara-device ceiling set --full-access allow|deny
  --project-reach workspace|os-user`. This matches `packages/device/src/args.ts:64,192`; both flags
  are required there, and `[--yes]` is omitted, which is fine. The `capybara-device mode` CLI command
  itself is **kept** (`args.ts:59,165-180` untouched); only the web mentions of it on the device page
  were removed.
- **Error codes.**
  - `owner_report_stale`, `owner_ceiling_confirmation_required`, `full_access_not_allowed` and
    `permission_reconcile_required` exist in `errors.ts:388-391` and have copy.
  - `device.restart_required` does **not** exist on this branch. It is `perm/t8-5`
    `errors.ts:391` (503, emitted from `sandbox.service.ts:468`). The en and zh copy here is
    byte-identical to t8-5's, so it should merge cleanly, maybe with an adjacent-line conflict.
  - `device.permission_reconcile_required` on a cloud device offers 重建文件, which opens the page's
    existing reset dialog. The kernel's `assertCloudReconciled` message names a file reset, and
    `cloud-permission-snapshot` returns `action: "reset-files"`.
- **Preview invalidation.**
  - A ceiling change invalidates `devices()` and `device(id)`. `permissionPreview*` and
    `deviceProjects` live under `device(id)`; `deviceProjectCandidates` lives outside it, so no scan
    is triggered.
  - Project add and remove invalidate `deviceProjects` + `permissionPreviewAll(id)` only. The test
    asserts that another device's preview is untouched and that the candidates are read once.
- **Neutral marks.** The list meta is plain text, the nameplate `<Badge>` has no tone, and the
  properties panel has `sandboxBadgeTone: "default"`. The composer picker has no mark.
- **Checks.** No styles were added (`check:web-ui` passes). zh uses 智能体 / 平台 / 超级管理员,
  with no 企业 and no Latin "agent" (`check:i18n` passes).

## Findings

### Critical
None.

### Important
None.

### Minor

1. **The project reach shown is the owner's value, not the effective one.**
   - Where: `DeviceModeSection.tsx:62` / `lib/devices.ts` `deviceCeilingOf` (`reach: c.restrictedProjectReach`).
   - Problem: the Full access row is cut by the platform and the org ("Not allowed by the platform
     or the organization"), but the 项目范围 row is not. The kernel's `projectReach`
     (`devices.service.ts:~715`) gives `os-user` only when `allowedMode === "auto"`.
   - Failure scenario: the org turns Full access off, and the page still says "Whatever this
     computer's user can read" while restricted work actually reaches only the workspace. The page
     overstates authority, and the two rows disagree.
   - Fix: when `mode.allowedMode !== "auto"`, show `workspace`, optionally with "(limited by the
     platform or the organization)". Or label the row as the owner's setting.

2. **Two in-flight double-submit tests were deleted without replacement.**
   - Where: `apps/web/test/devices-mode.test.tsx`. The old tests were "a mode change in flight
     disables the cards: a second confirm sends no second PATCH" and "a policy change in flight …
     no second POST".
   - The guards still exist (`disabled={pending}`, `if (pending) return` at `:221`), but nothing
     covers them now.
   - Fix: port both tests to the narrowing buttons and the widen confirm. The kernel tolerates a
     repeated widening, but a second POST spends a policy op.

3. **Old mode wording is left in error copy.**
   - Where: `messages/{en,zh}.json`: `errors.device.open_network_refused` ("with the device in
     sandbox mode (its owner switches it …)"), `errors.device.mode_requires_session` ("A device's
     mode is changed by its owner on the device page") and `errors.device.auto_mode_not_allowed`
     (`capybara-device mode sandbox`).
   - The last one stays valid while the CLI command exists (until 8.6).
   - The first two now point at a control the device page no longer has.
   - Fix: reword them to the ceiling ("turn off Full access on the device page") or record them for
     the 8.6 copy sweep.

4. **The widen button can still be refused for provider support.**
   - Where: `DeviceModeSection.tsx:400`.
   - Problem: the kernel also refuses a widening when the provider cannot run Full
     (`cloudOwnerCeilingLocked` M3), and the view exposes no flag for that. On such a provider,
     允许完全访问 is shown, refused, and then explained by `full_access_not_allowed` copy.
   - This is acceptable as a stopgap, but it is the "no refused actions shown" rule.
   - Fix: a kernel gap (see below). Add a provider-supports-Full fact to the view and gate the
     button on it.

5. **The confirm dialog can say something untrue when narrowing a cloud device the platform already
   forbids.**
   - Where: `CloudControls` `:391`.
   - Problem: when the owner allows Full but the platform or the org forbids it, 关闭完全访问 is
     still offered. That is a legitimate persistent narrowing, but the confirm's
     `effect.narrow` ("Work running with Full access on this device stops") describes work that
     cannot exist.
   - Fix: hide the narrowing when `full === "platform"`, or use a variant of the effect copy.

6. **The reconcile button's position and trigger are off.**
   - Where: `DeviceModeSection.tsx:289-295`.
   - Problem: the 重建文件 button is a bare row after the error detail, between the settings
     sections and the projects section. It also appears only after a refused PATCH, and the PATCH
     path's own reconcile message (`devices.service.ts:640`, "not migrated yet … switch it to
     sandbox mode") does not name a reset. That path is practically unreachable from the web,
     because the snapshot writes `owner_full_access` and `outer_network` together.
   - Fix: once the kernel exposes the flag, show reconcile up front inside 访问上限.

7. **The UI catalog still shows the old mark.**
   - Where: `apps/web/src/dev/catalog/device-blocks.tsx:30`.
   - Problem: the catalog sample still draws `<Badge tone="warn">自动</Badge>` on
     `DeviceNameplate`, which contradicts the new neutral ceiling mark. The author left it to avoid
     visual-baseline churn.
   - Fix: update it in the next visual-update run.

8. **The `restart_required` test uses an invented route.**
   - Where: `devices-mode.test.tsx:388`.
   - Problem: the test serves `device.restart_required` from `POST …/policy` (503). On t8-5 the
     code comes from the exec path (`sandbox.service.ts:468`), not the policy route. The test only
     proves generic error-copy rendering, so it is harmless but misleading.
   - Fix: comment it as a copy-rendering test, or move it to where exec errors surface.

9. **Process note.** The author's RED evidence used `git stash` of src/messages. The stash stack is
   shared across worktrees and sessions. Prefer a WIP commit or `git worktree`-local copies.

## Kernel gaps the author flagged, and whether they block this slice

1. The view has no `permission_reconcile_required` flag, so 重建文件 is offered only after a
   refusal. **Not blocking**: the refusal path works and the copy is actionable.
2. `device.owner_ceiling_changed` is not in `MODE_CHANGE_ACTIONS`, so cloud ceiling changes are
   missing from the page's recent changes. **Not blocking**: it is an audit-display gap, and the web
   needs one label once the kernel lists it.
3. `device.restart_required` exists only on `perm/t8-5`; its copy is added identically here. The
   8.5 "delete the device and reconnect" code is undefined. **Not blocking**: the copy is an
   integration-order item.
4. The devices API is owner-only, so there is no admin narrowing path. **Not blocking**: it matches
   the current API, and role handling is consistent.
5. M6 (`DEFAULT_POLICY` for new setups) belongs to `packages/device`. **Not blocking** (a Task 8
   item).
6. A ceiling change does not invalidate per-conversation `permissions()` keys; Slice D's stream is
   relied on. **Not blocking**, but verify it in Slice F.
7. The catalog sample still shows the old badges (Minor 7).
8. The legacy local narrowing still sends protocol-2 `mode:"sandbox"`; 8.6 must keep or replace
   that path. **Not blocking now**; it is a hand-off constraint for 8.6.

Reviewer addition: provider Full support is not exposed in the view (Minor 4). Not blocking.

## Test runs (`--maxWorkers=2`)

- Touched device files (`devices-mode`, `devices`, `device-link-page`, `device-projects`):
  4 files, 102 passed.
- `conversation-page`, `new-conversation-page`: 2 files, 118 passed.
- Full `apps/web/test`: see the result line below.
- `pnpm check:web-ui`: passed. `pnpm check:i18n`: passed.
