# Task 8.4 B2 independent review — owner report and independent reach

Reviewed: `git diff 781679021 4789e33b4` on `perm/t8-4-b2` (9777d1470 device/SDK, b3b31737b kernel +
migration 0147, 4789e33b4 tests), plus merged HEAD `e86ab3412` (B1 + B4 fix rounds) for
interactions. Judged from code first; the author's report was read afterwards.

## Verdict: CHANGES_REQUIRED

No widening path was found from web/API to a local owner ceiling: DTO, service (`narrowOnly`), SDK
`narrowing()` and device `applyPolicyOp` each refuse `true`/`os-user`. Old-mode conversion is exact.
The Full/reach split is consistent across preview, browse, binding and candidate expansion. Migration
0147 is fine. Three Important defects remain in the report sequencing and in the cloud PATCH's
interaction with B1. All of them are reachable once v3 is active, and one (I4) is reachable today.

## Important

**I1. Unblocking with a higher report resets Full consent even though Full never changed, and writes a false audit entry.**
`packages/kernel/src/local-devices/owner-reports.ts:97` computes `before = ownerFactsOf(row)`. When
the stored report carries `blocked`, `ownerFactsOfReport` returns the fail-closed facts
(`fullAccess:false`, `workspace`, no domains).
- Failure scenario: report 5 `{true, os-user}` is recorded and a conversation consents to Full.
  A delayed report 4 arrives and the row is blocked. Report 6 `{true, os-user}` then arrives with
  the same facts. `fullChanged` is `false→true`, so `publishLocked(..., invalidateFullConsent=true)`
  bumps `full_revision` and `resetRoot` moves every Full conversation on the device to
  approve-for-me. Audit also records `device.owner_ceiling_changed false→true`.
- The `same` path (line 91) clears the block without any reset, so the two unblock routes disagree.
- This violates "restricted-only / no actual Full change preserves Full consent".
- Fix: derive `before` from the stored report with `blocked` ignored, e.g.
  `ownerFactsOfReport({ ...stored, blocked: undefined })` when `stored !== null`. Add a test:
  consent, then stale, then higher with the same facts, and expect consent kept and no audit.

**I2. A lower sequence on any carrier blocks the machine, so harmless reordering locks it out until its next report.**
`owner-report.ts:70` (`stale`) together with `owner-reports.ts:82` writes `blocked`. Carriers are
committed in the order they take the device lock, not the order they were issued:
- the `policy` frame and the hello are handled on the gateway;
- `settleIn` / resolver statuses run on the caller replica or in a worker job;
- the bind answer runs on the coordinator.
- Failure scenario: the device answers a policy op with seq N+1 and then pushes seq N+2 (an owner
  edit). If the N+2 frame commits first, the N+1 answer becomes `stale`. The device is then blocked
  (`device.owner_report_stale`) and the op is downgraded to `unknown` (`device-policy.service.ts:384`).
  An idle online device sends no new report, so it stays blocked until a restart or the next edit.
- The same happens when an old connection's late answer lands after a reconnect hello.
- A lower sequence carries no newer authority. The design introduced the sequence to discard
  exactly this kind of delivery.
- Fix: treat `incoming < stored` on a non-hello carrier, or one from an older connection, as
  ignore (outcome `stale`, no block). Block only when a lower sequence comes from the current or a
  newer connection's hello, which is the regression / lost-sidecar case. Same-sequence conflict may
  keep blocking. Keep the policy-result downgrade to `unknown` only for conflict.

**I3. A cloud ownerCeiling PATCH on a device B1 has not snapshotted pre-empts the B1 snapshot and can widen the outer network.**
`devices.service.ts:627-647` writes `owner_full_access` even when it is `null` (not yet
snapshotted). `cloud-permission-snapshot.ts:126` then returns `existing` for that device forever,
so it never writes `outer_network` or `permission_migration`.
- Failure scenario: an unsnapshotted cloud device has `mode:"sandbox"`. Its old effective network
  is the sandbox network. The owner PATCHes `{fullAccess:true, confirmWidening:true}`.
  `owner_full_access` becomes `true`, `mode` is cleared and `outer_network` stays `null`, so
  `effectiveDevicePolicy` gives `deviceNetwork(auto)` (possibly open-public).
- B1 would have pinned the sandbox network as the outer boundary. This contradicts "cannot open an
  outer network boundary" and drops migration provenance.
- Fix: under the same lock, take the B1 snapshot (`snapshotLocked`) before applying the PATCH when
  `owner_full_access` is null, or refuse with `device.permission_reconcile_required`. Add a test for
  an unsnapshotted device.

**I4. A corrupt `owner-report.json` has no working repair, and a lost one cannot recover by restarting.**
`packages/device/src/owner-report.ts:29,43`
- A corrupt sidecar makes every `issueOwnerReport` throw, and the message says "log in again to
  repair". Login (`commands/login.ts`) never removes or resets the sidecar, so the machine can never
  issue a report again without manual file deletion.
- A missing sidecar restarts at 0 (line 80). The kernel blocks it (accepted by the spec as "block
  pending owner repair"), and a new login creates a fresh `device_machines` row, which does repair
  it. However, the kernel's message (`permission-facts.ts:170`) first suggests "restart
  capybara-device", which cannot help in that case.
- Fix:
  - `login`, when it issues a new credential, atomically resets the sidecar under the policy lock
    (or keys the sidecar by machine/credential id).
  - Make the kernel message distinguish a sequence regression ("log in again on the machine") from
    reordering (moot after I2).
  - Add a device test that login repairs a corrupt sidecar.

**I5. Platform/org Full-off does not revoke running restricted work that reaches outside the workspace.**
`orgs/settings.service.ts:720`, `identity/settings.ts:823` and `permission-config-publication.ts:324`
still use `needsFullCeiling` (Full or browse `/`). The spec (line 149, "Higher-level off narrows
restricted reach to workspace", and line 153, "config/org writers ... must use the same
distinction") requires those writers to apply the same reach selector the owner writer uses.
- Failure scenario: an owner `{false, os-user}` runs a restricted background task on a selected
  outside project. The org turns Full off. New admission narrows to the workspace, but the running
  task keeps its outside read/write roots. The owner writer's `ownerReportRevokes` would revoke it.
- This was pre-existing for directory expansions. It is now an explicit B2/B3 requirement, and the
  author lists it as concern 5.
- Fix: give platform/org writers a selector that is "Full, or a restricted scope whose roots lie
  outside the machine roots" (reuse `ownerReportRevokes`'s root test), and add a gate test. If it
  is deferred to B3, record it in the B3 matrix row.

## Minor

- **M1** `packages/device/src/commands/ceiling.ts:93`: the widening check reads the unlocked
  `store.current()`, and `store.update` then writes the full target. If a web narrowing lands
  between the two, the CLI writes `{true, os-user}` without the confirmation. Move the `widens`
  check into the `update` callback, under the lock, and abort if it needs confirmation.
- **M2** The CLI is live on the protocol 2 wire, but reach is not enforced there.
  `ceiling set --full-access allow --project-reach workspace` writes protocol 2 `mode:auto`. The
  kernel translates it as legacy `{true, os-user}`, and the auto device lists and reads as the
  owner. `ceiling show` still prints "Project reach: workspace". Print a notice that reach takes
  effect only with the new protocol, or hide `--project-reach workspace` with Full until
  activation. Also, `mode auto` silently widens reach to os-user. That is covered by its own
  confirmation, but worth a line.
- **M3** `devices.service.ts` cloud widening checks only platform/org (`allowedMode`). The spec
  also names the provider ceiling. Effective Full is intersected elsewhere, so this is not a
  widening, but the PATCH accepts a ceiling the provider cannot honour.
- **M4** The policy-result, status and bind carriers record `connectionId: null`
  (`device-policy.service.ts:380`, `instance-bindings.ts:185`). The spec wants the authenticated
  connection generation persisted. This is fine while dormant but needed for I2's fix.
- **M5** The new error codes (`device.owner_report_stale`,
  `device.owner_ceiling_confirmation_required`, `device.full_access_not_allowed`) and the audit
  action `device.owner_ceiling_changed` have no web i18n or mapping. Acceptable while dormant, as
  no web path hits them yet except the cloud PATCH body, which the web does not send. They must be
  in 10E's list.
- **M6** `DEFAULT_POLICY` is still `{true, os-user}`, so the "new setup defaults to {false,
  workspace}" rule is deferred. The author acknowledges this; track it for 8.6/10E.
- **M7** Test quality. RED for new modules was module absence. The mutation evidence (reach split,
  consent folding, B3 conflation) is meaningful. Still missing:
  - unblock-by-higher with consent kept (would catch I1);
  - reordered carriers across replicas (I2);
  - an unsnapshotted cloud PATCH (I3);
  - login repairing the sidecar (I4);
  - org-off with running outside-root restricted work (I5).

  The cloud PATCH test only covers an already-snapshotted device.

## Checked and acceptable

- **Old mode conversion.** v2 conversion of old auto/sandbox is exact, locked and atomic. A mixed
  file (`version:2` with `mode`) or an unknown version is refused with nothing written. The strict
  reader refuses legacy files and missing files (`statSync`).
- **Narrowing only.** The staged and protocol 2 `policy` ops narrow only, and refusals write
  nothing. Reconciliation runs before the answer. An applied status requires the report.
- **Sidecar ordering.** The sidecar is written durably (rename plus fsync of file and directory)
  before the report is returned, under the policy lock. The sidecar is not part of the revision.
- **Blocked state.** A blocked report only stops new admission (`assertOwnerReportUsable` in
  browse and in the operation snapshot), and preview fails closed. Not revoking running work on a
  stale or conflicting report is consistent with the spec: a stale report is not evidence of
  narrowing, and the device enforces against its fresh strict state.
- **Consent effects.** Full removal revokes only Full work and resets consent. Restricted-only
  changes revoke only the restricted work they narrow, and independent grants survive. A new
  revision with identical facts publishes nothing. `scopeRevision` excludes reach, domains and
  sequence.
- **Migration 0147.** `ADD COLUMN IF NOT EXISTS`, expand-only, per machine row, so a new credential
  starts with no report.
- **Platform op parity.** `devices.rename` omits `ownerCeiling` and `confirmWidening`, and PAT use
  is refused like `mode`.
- **SDK.** The API is regenerated and the changesets are present.
- **Edits in B1/B4 areas.**
  - `recordHello`'s optional owner argument correctly folds `rootsChanged` into one publication.
  - `instance-bindings` install records the report before marking the binding installed. A stale
    report does not fail installation. The early return when the binding is already installed
    skips recording, which is fine.
  - The B4 fixture now reuses the hello's report, a correct adjustment.
  - `cloudOwnerCeilingLocked` clearing `mode` when widening is the intended deliberate widening for
    snapshotted devices; see I3 for unsnapshotted ones.
- **Merged HEAD (B1/B4 fix rounds).** No behavioural conflict found beyond I3.

## Tests run (CAPYBARA_TEST_WORKERS=2, CAPYBARA_TEST_CONTAINER_STARTS=2)

- device `owner-ceiling`, `state`, `server-ops`, `mode`, `policy-store`; SDK `device-protocol-v3`;
  kernel unit `owner-report`: 7 files, 95/95 passed.
- kernel `local-devices/owner-reach`, `background/poll`, `local-devices/instance-bindings`: 3 files,
  60/60 passed.
- kernel `platform/ops-devices-skills`, `sandbox/cloud-permission-snapshot`: 2 files, 25/25 passed.
- kernel `devices/mode`, `devices/device-policy.http`, `devices/projects.http`: 3 files, 32/32
  passed.
- Total: 15 files, 212 tests, all green. I1–I5 are not covered by the existing tests.

---

# Re-review round 1

Scope: `git diff e86ab3412 9521e69f6` (28ff1e55c device, 9521e69f6 kernel) and the resolved
`packages/kernel/src/local-devices/instance-bindings.ts` at HEAD `326cb9c4e`. Read only.

## Verdict: CHANGES_REQUIRED (one small Important regression in the I5 fix; everything else resolved)

## Original findings

| # | Status | Notes |
|---|---|---|
| I1 | Resolved | `owner-reports.ts`: `before` is now the stored report's facts with `blocked` dropped. Unblocking with the same facts no longer resets consent or writes an audit entry, and there is a test for it. |
| I2 | Resolved (limitation acceptable) | A lower sequence on a non-hello carrier returns `stale` and writes nothing. `settleIn` downgrades to `unknown` only on `conflict` or `revoked`. **Limitation:** a hello is always treated as coming from the current connection. A hello is the first frame of each connection, and the relay supersedes older holders. The only way an older connection's hello commits after a newer one is two near-simultaneous connects. That fails closed, and the next current report clears it, so I accept it. The bind-path comment in `instance-bindings.ts:231` ("a stale ... one blocks") is now out of date (cosmetic). |
| I3 | Resolved (refusal acceptable) | When `owner_full_access` or `outer_network` is null, the PATCH is refused with `device.permission_reconcile_required` and nothing is written. Snapshotting inline would need the exclusive lifecycle lease, which a request cannot take inside its transaction. Refusing never widens, and the old `mode: sandbox` switch still narrows. The `want === current` early return is now safe because null has already been excluded. |
| I4 | Resolved | `login` calls `resetOwnerReport` under the policy lock, removing the file and fsyncing the directory, before writing the new credential. The device and kernel messages now say "log in again". The comment says a failed reset makes the deployment refuse work. In fact the new machine row has no stored report, so the old sequence is simply accepted (no block). A corrupt file still keeps the program from issuing reports, so a second login is needed. This is harmless, but the comment is inaccurate. |
| I5 | Resolved, but introduced a regression (R1 below) | `needsWiderDeviceCeiling` (Full ∨ browse `/` ∨ restricted roots outside the machine roots) is used by the org writer, the platform settings writer and publication. The poll.test gate proves exact revocation through the worker. |
| M1 | Resolved | The widening check is repeated inside `store.update` under the lock. If a narrowing landed meanwhile, the command exits 2 unless the widening was already confirmed. |
| M2 | Resolved | `ceiling show` prints the protocol-2 note, and `mode` prints both owner fields. |
| M3 | Resolved | Widening is refused when the provider is unsupported or its report has no Full. Minor: `readRuntimeReport` is given `provider.version`, not the instance's runtime version. That is only a pre-check (admission rechecks), so it is acceptable. |
| M4 | Resolved | Policy answers, statuses and bind answers now pass a `connectionId`. It is read before the call (`relay.connection`), so a reconnect during the call records the older id. It is metadata only, so acceptable. |
| M5 / M6 | Deferred to 10E / 8.6 | Acceptable. |

## New finding

**R1 (Important): the org writer no longer applies network narrowing to restricted work outside the machine roots.**
- Location: `packages/kernel/src/orgs/settings.service.ts:725-726`:
  ```ts
  if (needsWiderDeviceCeiling(scope, machineRoots.get(row.device_id)))
    return after.fullAccess === "off";
  ```
- `needsWiderDeviceCeiling` now also matches restricted execution scopes whose roots lie outside
  the machine roots. For those scopes the selector returns early, so the cloudNetwork/host check
  below is skipped.
- Failure scenario:
  1. A local owner `{true, os-user}` runs a restricted background `Bash` on a selected outside
     project, with an allowlisted host. (Legacy protocol 2 auto translates to os-user reach, so
     this is reachable today.)
  2. The org removes that host from its network while Full stays allowed.
  3. Before 9521e69f6 the task was revoked by the host check. Now it is not.
- `permission-config-publication.ts` is not affected: there, the B2 check returns `true` only when
  `nextMode === "off"` and otherwise falls through.
- Fix:
  ```ts
  if (after.fullAccess === "off" && needsWiderDeviceCeiling(scope, roots)) return true;
  if (needsFullCeiling(scope)) return after.fullAccess === "off";
  ```
  then continue to the host check.
- Add a gate test: org cloudNetwork narrowing while Full stays allowed revokes a restricted
  outside-root task whose host was removed.

## workingRootOf / projectReach change

- **Wiring.** `ConversationDevices.projectReach` (review facts), sandbox tools (`sessionWorkingRoot`)
  and skill invoke all compute the root from the same `DevicesService.projectReach`. The reviewed
  root and the session root therefore agree.
- **Local `projectReach`.** It is os-user only when `allowedMode === "auto"` and the owner facts
  give os-user. Blocked or missing facts fail closed to workspace. Legacy protocol 2 facts
  translate `mode` exactly, so on protocol 2 a non-Full owner (`sandbox`) is always workspace:
  nothing widens for any live machine.
- **Under v3 reports**, only an owner who granted os-user (within platform and org) gets an outside
  root. The project must still be a selected `device_projects` entry, and the `aboveHome` and
  path-shape checks remain.
- **`{true, workspace}`** now narrows (the outside root falls back to the workspace), which matches
  the spec's "restricted work stays workspace-bounded".
- **Cloud** keeps `mode === "auto"` → os-user, which is the previous rule. Stubs without
  `projectReach` fall back to the mode.
- **Conclusion:** no widening beyond the reach the owner granted.
- **Model-visible output.** `DeviceModeLevel` and `device_paths` rendering are untouched, so the
  working root changes only where reach is os-user without Full, which needs v3 reports (dormant).
  `reconstruct.test.ts` and `rename-compat.test.ts` pass.

## Merge 326cb9c4e (instance-bindings.ts)

- B2's `recordLocked(machineId, answer.ownerCeiling, {connectionId, via: "bind"})` runs before
  B4's "latest installed older binding" fingerprint lookup.
- B4's `retarget` and `machineId` additions are kept, and `connectionId` is threaded through
  `bindInstance` → `install`.
- An owner Full change and an image-fingerprint change in the same answer publish twice in one
  transaction. That is harmless: both reset, and the epochs bump twice.
- No conflict in behaviour.

## Tests run (CAPYBARA_TEST_WORKERS=2, CAPYBARA_TEST_CONTAINER_STARTS=2, HEAD 326cb9c4e)

- `evals/reconstruct`, `tools/rename-compat`, `local-devices/owner-reach`, device `owner-ceiling`,
  device `login`: 5 files, 126/126 passed.
- `background/poll`, `skills/invocable`, `local-devices/instance-bindings`: 3 files, 66/66 passed.
- R1 is not covered by any test.
