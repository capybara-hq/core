# Task 8.4 B2 report: owner report and independent reach — DONE_WITH_CONCERNS (staged)

Worktree `.claude/worktrees/perm-t8-4-b2`, branch `perm/t8-4-b2`, base `781679021`. Not pushed, no PR.
All runs `CAPYBARA_TEST_WORKERS=2 CAPYBARA_TEST_CONTAINER_STARTS=2`, small batches. Logs: scratchpad
`b2/` (`device-red.log`, `kernel-red-mutation.log`, `b3-gate-red-mutation.log`, `batch1..3.log`, `unit.log`).
Protocol 2 stays the active wire; every v3 path stays dormant/staged; no activation.

## Commits

| sha | What |
|---|---|
| `9777d1470` | feat(device): version-2 owner ceiling, owner report sequence and ceiling CLI (+ SDK staged schemas) |
| `b3b31737b` | feat(kernel): authenticated owner reports and independent project reach (migration 0147) |
| `4789e33b4` | test(kernel): B2 owner writer drives the exact-revocation proof; real writers for R1 |

## Device + SDK (`9777d1470`)
- `state.ts`: policy.json `version: 2` with `ownerCeiling {fullAccess, restrictedProjectReach}`; `mode`
  removed from the format. Old `mode: auto` -> `{true, os-user}`, `sandbox` -> `{false, workspace}`
  (pre-mode legacy keys as before). `convertPolicyFile` = explicit, locked, atomic conversion
  (`start` runs it once; any store write also writes v2); malformed / mixed (`version 2` + `mode`) /
  unknown version refused with nothing written. `policyMode()` gives the protocol 2 encoding.
- Strict reader (`readStrictOwnerCeiling[Sync]`) trusts only a v2 file; Full and reach independent.
- `owner-report.ts`: `owner-report.json` `{sequence, lastPublishedRevision}`; under the policy lock a
  newly observed revision advances the sequence, written durably (rename + fsync file and dir) before
  the report is returned; corrupt sidecar / missing / old-format policy -> no report.
- `capybara-device ceiling show|set --full-access allow|deny --project-reach workspace|os-user [--yes]`:
  both fields required; narrowing direct; widening needs --yes or a confirmed TTY answer; show prints
  owner ceiling, restricted network baseline, revision, and that platform/org/runtime apply separately.
- Staged `policy`/`policyStatus` (serveOperationV3 + staged session, served while unbound): protocol 2
  logic, `ownerCeiling` narrowing only (true/os-user refused, nothing written), live owners
  reconciled **before** answering, answer/applied status carries the owner report. Protocol 2
  `policy` op also accepts the narrowing (device trust boundary).
- SDK (gen:sdk-api + changeset): `parseOwnerCeilingReportV3`, `DevicePolicyArgsV3` (narrowing),
  `DevicePolicyResultV3`, `DevicePolicyStatusV3` (applied requires the report), strict
  `DevicePolicyChangedV3` frame.

## Kernel (`b3b31737b`)
- Migration `0147_device_owner_report.sql` (`device_machines.owner_report jsonb`, per machine row:
  a new credential never adopts the old sequence).
- `local-devices/owner-report.ts` (pure): stored-report parser, `decideOwnerReport` (higher record /
  same idempotent / lower stale / same seq other bytes conflict), `ownerFactsOf` (report | blocked
  fail-closed | legacy v2 summary translated exactly | missing fail-closed), `ownerReportRevokes`
  (Full work only on Full removal; browse `/` and restricted roots outside machine roots only on reach
  -> workspace; hosts as before with independent grants surviving), `ownerModeOf`.
- `OwnerReports` writer (device authority lock): used by `Machines.recordHelloV3` (new
  `connectionId` arg; v3 hello's report decides publication instead of the summary),
  new `Machines.recordPolicyV3` (policy frame), `LocalInstanceBindings.install` (bind answer
  ownerCeiling now persisted — minimal isolated edit), `DevicePolicyService.settleIn` (applied v3
  answer accepted only after its report is committed; stale/conflict -> op stays unknown) and the
  resolver's applied status. Publication: full_revision bump only when owner Full changed (or roots);
  a new revision with identical facts publishes nothing. Audit `device.owner_ceiling_changed`.
- Split: `requiresFullExecution` / `requiresBroadProjectReach` (`needsFullCeiling` = both, unchanged
  for platform/org writers). `DeviceProjectScope.reach`; `withinMode`/`baseOf` use reach;
  `resolveBrowse` readRoots by reach; `PermissionFacts.scope().broadProjectReach` (local: org/platform
  allow && owner reach os-user; cloud: unchanged rule) gates directory expansions in the candidate,
  call grants and resolveInvocation; `fullAccessCeiling` = Full only; scopeRevision unchanged (no
  reach/domains/sequence). `assertOwnerReportUsable` in browse + operation snapshot. v2 wire list/scan
  `limits.mode` = reach encoding (`readModeOf`).
- Device view `ownerCeiling {state, revision, sequence, fullAccess, restrictedProjectReach,
  restrictedAllowedDomains, observedAt, stale}` (stale = offline or not a current report; cloud =
  snapshotted Full ceiling).
- Local `POST /devices/:id/policy` `ownerCeiling: {fullAccess?: false, restrictedProjectReach?:
  "workspace"}` (zod refuses true/os-user; service re-checks); sent only when the machine has a
  current owner report, else `device.policy_unsupported` (protocol 2 cannot express it).
- Cloud `PATCH /devices/:id` `ownerCeiling: {fullAccess}` + `confirmWidening: true`: session only
  (token refused like `mode`), local device refused (`device.mode_on_device`), widening needs
  confirmation (`device.owner_ceiling_confirmation_required`) and platform+org allowing Full
  (`device.full_access_not_allowed`), never touches outer_network; narrowing revokes only Full work;
  both reset Full consent. Platform op `devices.rename` omits `ownerCeiling`, `confirmWidening`
  (`check:platform-ops` passes, parity test updated).
- New error codes: `device.owner_report_stale`, `device.owner_ceiling_confirmation_required`,
  `device.full_access_not_allowed` (409).

## Acceptance evidence
| Item | Test |
|---|---|
| four Full/reach combinations: preview, browse, selected project, UI read | `local-devices/owner-reach.test.ts` (4 cases) |
| higher-level off narrows reach, no report overrides | owner-reach "platform or org that turns Full off" |
| stale / conflict / same / missing / malformed / new credential | owner-reach "stale, missing and out-of-order" (3), `owner-report.test.ts` (unit) |
| disconnected narrowing (reconnect hello with higher seq resets Full; stale reconnect blocks) | owner-reach "disconnected owner narrowing" |
| restricted-only keeps Full consent; Full removal resets; re-widen needs fresh consent | owner-reach consent test |
| web cannot widen; narrowing only to owner-reporting programs; applied only after report commit | owner-reach "web writes only narrow" (2) |
| cloud PATCH widening confirmation / not allowed / outer network kept | owner-reach cloud (2) |
| device format conversion, sidecar, CLI, staged policy op | device `owner-ceiling.test.ts` (14), SDK v3 (+3) |
| B3: B2 writer exact revocation (restricted-only keeps Full task + consent scope; Full narrowing stops only Full task via outbox+worker) | `background/poll.test.ts` new gate |
| R1: real writers in the owner revocation test (policy frame + real network ask/decision) | `background/poll.test.ts` rewritten test |

RED: device/SDK/kernel new modules are API absence (`device-red.log`). Behavioural evidence by
mutation: reverting the reach split / folding reach+domain changes into consent reset -> 4 kernel
failures (`kernel-red-mutation.log`); conflating reach into Full revocation -> the B3 gate fails
`'revoked' !== 'background-running'` (`b3-gate-red-mutation.log`). Device staged-policy tests and the
SDK schema tests were written alongside the code (not RED first).

## Verification
device + SDK 78 files 1787 passed / 1 skipped; kernel batch1 (permission wiring/authority/grants/
classifier/policy/project knowledge) 117/117; batch2 (devices + local-devices) 24 files 296/296;
batch3 (poll, managed-launch/consumers, network-approvals, orgs, permission-lifetime.dual) 392/392;
platform + platform-tool 274/274 (after updating the rename omits test); `pnpm test:unit` 132 files
1476 passed; `pnpm typecheck` clean (incl. web); `pnpm check` all passed; Biome clean (warnings only).

## Not done / concerns
1. New-setup default `{false, workspace}` not applied: `DEFAULT_POLICY` keeps the exact old default
   (auto -> `{true, os-user}`) so protocol 2 login copy/behaviour is unchanged; flip it with the login
   copy at activation (8.6/10E). `mode auto|sandbox` command kept (writes the exact mapping) until
   cutover removes it.
2. Kernel v3 policy send path is not wired (DevicePolicyService still uses relay `call`); a narrowing
   is only sent to a machine with a current owner report, which no production connection has yet.
   Gateway does not yet pass `connectionId` to `recordHelloV3`/`recordPolicyV3` (dormant).
3. Missing sidecar on an existing machine restarts at 0 on the device; the kernel sees a lower
   sequence and blocks (`device.owner_report_stale`); repair is a new login (new machine row). The
   device cannot tell "existing machine" by itself.
4. A blocked (stale/conflicting) report blocks admission but does not revoke live work kernel-side
   (the device reconciles against its fresh strict state).
5. Platform/org writers keep `needsFullCeiling` (Full ∨ browse `/`); restricted ops on an outside
   project are not revoked by org/platform off (unchanged behaviour).
6. Touched B1/B4 spots minimally: `devices.service` update path (new isolated
   `cloudOwnerCeilingLocked`, uses `cloudChosenMode`, widening clears `mode`), `instance-bindings.ts`
   install (one call + injected `OwnerReports`), `machines.ts` recordHello (optional owner arg) and
   B4's `instance-bindings.test.ts` fixture (bind answer now repeats the hello's owner report; with a
   different report Full widening correctly resets consent).
7. New error codes and audit action are not mapped in web i18n/UI (Task 10E). No web change needed
   for typecheck.
8. Still open B3 gates outside B2: revocation across disconnect/reconnect against a real device or
   staged session; platform writer end to end through the worker.

## Fix round 1 (review `task-8-4-b2-independent-review.md`, CHANGES_REQUIRED)

On top of `e86ab3412` (merged B1 + B4 fix rounds). Commits: `28ff1e55c` (device), `9521e69f6`
(kernel). Logs in scratchpad `b2/`: `fr1-red-kernel.log`, `fr1-red-i5.log`, `fr1-red-device.log`,
`fr1-batch1..3.log`, `fr1-unit.log`, `fr1-device-all.log`.

| Finding | Change | RED -> GREEN |
|---|---|---|
| I1 | `OwnerReports.recordLocked`: `before` = stored report facts with `blocked` ignored | owner-reach "I1": consent dropped to approve-for-me (RED), kept + no audit (GREEN) |
| I2 | lower sequence on `policy` / `policy-result` / `bind` (any non-hello carrier) returns `stale` without writing a block; only a hello regression or a same-sequence conflict blocks; `settleIn` downgrades to unknown only on conflict/revoked | owner-reach "I2": device blocked (RED) -> report kept, browse `/`, late answer applied |
| M4 | policy answers (`relay.connection` before the call), resolver statuses and bind answers (`install(..., connectionId)`) carry their connection into the writer | owner-reach "M4" guard; carriers wired |
| I3 | cloud PATCH refused with `device.permission_reconcile_required` when `owner_full_access` or `outer_network` is null (B1's `snapshotLocked` needs the exclusive lifecycle lease, which a request cannot take inside its transaction); nothing written, `mode` untouched | owner-reach "I3": PATCH resolved (RED) -> refused, row unchanged |
| M3 | widening also refused when the provider has no permission-scoped operations or its runtime report has no Full | owner-reach "M3" (RED: resolved) |
| I4 | device `resetOwnerReport` (policy lock, fsync dir) called by `login` before writing the new credential (non-fatal if the lock is held: fail closed, warns to log in again); device and kernel error copy say "log in again" | login.test "a new credential resets…": sidecar kept (RED) -> removed |
| I5 | `outsideMachineRoots` shared by the owner writer and new `needsWiderDeviceCeiling`; org, platform settings and publication Full-off writers revoke running restricted work outside the machine's roots (`localMachineRoots`) | poll.test "I5": owner `{false, os-user}`, restricted background task on `/home/owner/ext`, org Full off -> with the old writers `'background-running' !== 'revoked'` (behavioural RED), now revoked and stopped once via the worker |
| I5 (found while gating) | the tool session's working root still gated an outside project by the Full mode (`workingRootOf(..., mode)`): `{false, os-user}` could not launch on its selected project (output path refused). `workingRootOf` takes `reach`; `ConversationDevices`/`DevicesService.projectReach` feed sandbox tools, skill invocation and the review facts. `DeviceModeLevel` (model-visible `device_paths`) is unchanged | same test (launch refused before) |
| M1 | `ceiling set` re-decides widening inside `store.update` on the locked policy; a narrowing landed since the read -> refused (2) unless confirmed | owner-ceiling "M1" (RED: exit 0) |
| M2 | `ceiling show` prints that reach takes effect only on the new protocol; `mode auto|sandbox` prints both owner fields it sets | owner-ceiling "M2" (RED) |
| M5 | deferred to 10E: web i18n/mapping for `device.owner_report_stale`, `device.owner_ceiling_confirmation_required`, `device.full_access_not_allowed`, audit `device.owner_ceiling_changed` (and the copy change of `device.owner_report_stale`) | — |
| M6 | deferred to 8.6/10E: new-setup default `{false, workspace}` with the login copy | — |

Test fixture edits: `operation-scopes.dual.test.ts` hand-built schema gains `device_machines`
(publication now reads machine roots); `skills/invocable.test.ts` mock gains `projectReach`.

Verification: device+SDK full run 1796 passed / 5 failed / 1 skipped under load — the 5 are
`background-output` (2) and `exec-docker` (3), untouched files, and pass alone (95/95); kernel
fr1 batch1 (devices, local-devices, invocable, platform ops) 26 files 335/335; batch2 (tools/sandbox,
project knowledge, config migration/activation, admin, identity settings, orgs, permission
wiring/authority/policy) 31 files 580/580; batch3 (poll, managed launch/consumers, activation.dual,
operation-scopes.dual) 116 with the dual schema fix -> operation-scopes.dual 7/7; mode-limits.dual
+ permission-approvals.dual 16/16; `pnpm test:unit` 132 files 1476; `pnpm typecheck` clean (incl.
web); `pnpm check` all passed; Biome clean (warnings only).

Remaining: hello regression from an *older* connection is not distinguished (a hello always opens
the current connection, so it is treated as current); the kernel v3 send path and gateway
`connectionId` wiring for hello/policy frames stay dormant; B4's in-flight edit of
`instance-bindings.ts` install may conflict textually with the added `connectionId` parameter.

## Fix round 2 (re-review round 1, R1)

Commit `3e12834e6` on top of `326cb9c4e`. Logs: scratchpad `b2/fr2-red.log`, `b2/fr2-batch.log`.

- R1: `orgs/settings.service.ts` selector now reads
  `if (after.fullAccess === "off" && needsWiderDeviceCeiling(scope, roots)) return true;`
  `if (needsFullCeiling(scope)) return after.fullAccess === "off";` and then continues to the
  cloudNetwork host check, so with Full on an outside-root restricted task is still revoked when the
  org removes its host. (The publication writer already had this shape; the platform settings
  writer has no host check.)
- Gate `background/poll.test.ts` "R1": owner report `{true, os-user}` (the protocol 2 auto
  translation), project `/home/owner/ext`; a sibling task launched with no baseline host
  (`network: none`), then a task with `allowlist [github.com]`; runs complete; Full stays on; org
  `cloudNetwork {mode: allowlist, excludedHosts: [github.com]}` -> the host task is revoked, the
  sibling stays `background-running`. RED on `9521e69f6`'s selector:
  `'background-running' !== 'revoked'`.
- Comments: `instance-bindings.ts` (lower sequence ignored, conflict blocks) and the login reset
  comment (a failed reset never fails the login; the old sequence continues and is accepted as the
  new machine's first report; a corrupt sidecar still issues nothing until a later login).

Verification: orgs + poll + instance-bindings + device login, 15 files 360/360; `pnpm typecheck`
clean; Biome clean on touched files.
