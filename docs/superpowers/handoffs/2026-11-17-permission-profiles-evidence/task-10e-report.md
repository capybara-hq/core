# Task 10 Slice E report: daily device modes removed, owner ceilings kept

Status: DONE_WITH_CONCERNS. Worktree `perm-t10e`, branch `perm/t10e`, base `077de1ac9`.
Commit: `780ce49bf feat(web): owner ceilings replace the daily device mode`. Not pushed, no PR.
No kernel file touched.

## What changed (apps/web only, plus the writing-web-ui skill and one changeset)

- `lib/devices.ts`: `Device.ownerCeiling` (kernel `DeviceOwnerCeilingView`); `deviceCeilingOf`
  (Full access `available | owner | platform | unconfirmed`, owner allowance, project reach, one
  notice `noMachine | blocked | missing | legacy | stale | migrating`); `deviceCeilingMark`
  (neutral `full | restricted`). Removed `deviceModeMark`, `DeviceMarkKind`, `setDeviceMode`.
  `DevicePolicyPatch.ownerCeiling` is typed narrowing-only (`fullAccess?: false`,
  `restrictedProjectReach?: "workspace"`). `narrowCloudDevice(migrated)` sends
  `ownerCeiling:{fullAccess:false}` (or `mode:"sandbox"` before the B1 snapshot, the narrowing the
  kernel's reconcile message names); `widenCloudDevice` always sends
  `{ownerCeiling:{fullAccess:true}, confirmWidening:true}`.
- `components/DeviceModeSection.tsx` (filename kept): the run-mode RadioGroup, the
  `capybara-device mode` keycaps and the mode dialog are gone. 概览: 访问上限 KeyValue (完全访问,
  local 项目范围 and 报告时间) + one notice. 设置: the same facts, then
  - local: narrowing buttons only when the report allows something to narrow and the machine is
    online with `policyOpId` (`report`: Full off / reach to workspace separately; `legacy`: one
    `mode:"sandbox"` narrowing with a note that it narrows both); offline / old program: a muted
    reason, no refused button; blocked / missing / no machine: nothing to press; always the
    `CEILING_COMMAND` keycaps (`capybara-device ceiling set --full-access allow|deny
    --project-reach workspace|os-user`, the real usage line from `packages/device/src/args.ts`);
  - cloud: 关闭完全访问 while the owner ceiling allows Full, 允许完全访问 only when migrated and the
    platform/org allow it; both through a confirmation Dialog (effect, network unchanged, next use);
  - a `device.permission_reconcile_required` refusal on a cloud device shows a 重建文件 button that
    opens the page's existing reset dialog.
  The local allowlist is shown whenever a machine is connected (restricted work uses it), no
  longer only in sandbox mode. Recent changes relabel old mode rows as 已允许 / 已关闭完全访问.
- Device detail/list pages, conversation properties: neutral ceiling mark (`Badge` default tone,
  list meta plain text). Composer device picker: no mark.
- `DeviceProjectsSection`: add/remove also invalidate `permissionPreviewAll(device)` (not the
  candidates key, so no scan/provision).
- Ceiling mutations invalidate `devices()` and `device(id)`; the preview keys live under
  `device(id)`, so they are read again.
- Copy (en/zh): new `devices.ceiling.*`, `devices.recent.fullAllowed/fullOff`; removed
  `devices.mode.*`, `devices.mark.*`, `devices.recent.mode/modeFrom`; `errors.device.restart_required`
  added with the exact text and position used on `perm/t8-5` (identical change, should merge
  cleanly); `errors.device.mode_on_device`, `project_outside_mode`, `project_home_unknown`,
  `devices.projects.hidden/homeUnknown`, `devices.network.overviewNote/description` reworded from
  modes to the ceiling; device-link disclosure says confirming does not allow Full access.
- `.agents/skills/writing-web-ui/SKILL.md`: the device page row and the old "Auto mode's places"
  paragraph rewritten for the ceiling model.
- `.changeset/device-owner-ceiling-page.md` (`@capybara-hq/web` patch).

## Tests (RED first, then GREEN)

RED (new tests against the old source, `git stash` of src/messages):
- `devices-mode.test.tsx`: 29 failed / 7 passed.
- `device-projects.test.tsx` preview invalidation: `expected [false,false] to deeply equal [true,true]`.
- marks (`devices`, `conversation-page`, `new-conversation-page`): 3 failed.
- `device-link-page` "grants no Full": 1 failed.

New/rewritten cases: no daily mode (no radiogroup/radio, no `capybara-device mode`); local ceiling
read-only on 概览; owner-only widening keycaps (zh), copy; narrowing bodies exactly
`{ownerCeiling:{fullAccess:false}}` / `{ownerCeiling:{restrictedProjectReach:"workspace"}}`, no
`true`/`os-user`/`auto`/PATCH ever sent; narrowed machine offers nothing; legacy one narrowing
`{mode:"sandbox"}` with note; offline/upgrade reasons without buttons; blocked report fails closed;
platform/org forbids; no machine; error copy for `device.owner_report_stale` and
`device.restart_required`; cloud narrow and widen only after confirmation (widen body has
`confirmWidening:true`), cancel sends nothing, no widen when platform/org forbid, unmigrated cloud
narrows with `mode:"sandbox"` and never widens, `device.full_access_not_allowed` copy,
reconcile refusal offers 重建文件, pending lines, ceiling change re-reads the device and invalidates
its permission preview; network sections; recent changes relabelled; neutral marks in list,
nameplate, properties; no marks in the composer picker; project add/remove invalidate previews
(other devices untouched, candidates read once); device-link confirm body carries no ceiling.

GREEN:
- 20 device/conversation/permission web files: 442 passed. Another 11 files (auth-layout, nav,
  pages, proxy-session, query-routes, schedule*, settings*): 268 passed. `--maxWorkers=2`.
- `tools/checks/test/error-copy.test.ts` 4 passed.
- `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm typecheck`, `pnpm check` (all checks passed),
  Biome on staged files clean (one pre-existing warning: unused `limits` in devices/[id]/view.tsx).
- No visual baselines rendered locally (visual-update in CI later); no dev stack.

## Concerns / gaps for the controller

1. Kernel gap (not changed, kernel off-limits): the device read view has no
   `permission_reconcile_required` flag, so the page offers 重建文件 only after a refusal names it.
   Exposing the flag (or a `reconcileRequired` field) would let the page show it up front.
2. Kernel gap: `device.owner_ceiling_changed` is not in `MODE_CHANGE_ACTIONS`
   (`devices.service.ts`), so a cloud ceiling change does not appear in the page's recent changes,
   and the web has no org audit page; the admin audit map is platform-only (no-org rows), so no
   label was added there. Once the kernel lists it (e.g. `kind: "ceiling"` with from/to
   fullAccess), the web needs one label; I did not invent the row shape.
3. `device.restart_required` exists only on `perm/t8-5`; copy added here identically. The
   "delete the device and reconnect" error ruled in 8.5 review has no code on any branch I could
   see, so it has no copy yet (needs the code name from 8.5's fix round).
4. Cloud "owner/admin can narrow": the devices API is owner-only (others get `device.not_found`),
   so the page has no admin path; role handling is the owner page plus the existing not-found.
5. M6 (`DEFAULT_POLICY` {false, workspace} for new setups) is in `packages/device`, not done here.
6. A ceiling change does not invalidate existing conversations' `permissions()` keys (per
   conversation); their live stream/supersession path (Slice D) is relied on.
7. `src/dev/catalog/device-blocks.tsx` still shows the old 自动/沙箱/开放/白名单 badges as component
   catalog samples of `DeviceNameplate`; left as is to avoid visual-baseline churn.
8. The legacy local narrowing still sends the protocol 2 `mode:"sandbox"` (the kernel's only
   narrowing for `legacy` reports); 8.6 mode retirement must keep or replace that path.
