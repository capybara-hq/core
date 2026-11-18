# Task 8.4 B1 independent review

Reviewer: independent (read-only). Checkout `.claude/worktrees/perm-t8-4-b1`, branch `perm/t8-4-b1`,
range `473486522..2ea4298d3` (2655a9848, c04a4d1e8, 2ea4298d3). Judged from the code first; the
author's report was read afterwards.

## Verdict: CHANGES_REQUIRED

One live (not dormant) widening path in the stored-key migration, one fencing gap that the same fix
closes, and one writer-contract gap in the cloud snapshot writer. Everything else (source
precedence, v2 projection/CAS, migration 0145, lock order, CLI converter, ops parity, docs) is
sound.

## Critical

### C1. Before conversion, new replicas ignore and then erase the old stored keys: a lasting widening

- `packages/kernel/src/lifecycle/kernel-lifecycle.ts:225` - a `mismatch` outcome only logs a
  warning; the replica keeps starting and serves HTTP.
- `packages/kernel/src/sandbox/permission-config-publication.ts:207` - on a v1 row whose semantics
  differ from the local v2 candidate, `initializeLocked` returns `mismatch` **without** converting
  the stored keys (correct for the CAS), so `deployment_settings.devicesAutoMode` and
  `orgs.settings.autoMode` remain in place.
- `packages/kernel/src/orgs/settings.service.ts:188` (`OrgSettingsSchema` reads only `fullAccess`;
  `autoMode` is stripped as an unknown key) and `sandbox/platform-full-access.ts:137-160` (reads
  only `devicesFullAccess`): the new readers do not see the old keys at all.
- `packages/kernel/src/orgs/settings.service.ts:666-680` - `updateIn` destructures
  `autoMode: _legacyAutoMode` out of the stored object and writes `{...rest, ...after}`: **any**
  org settings write (locale, theme, ...) deletes an unconverted `autoMode`. The report calls this
  "Writes clear a leftover stored autoMode".

Failure scenario: v1 published, platform follows the default (`allowed`), org A stored
`autoMode: "off"`. The operator upgrades and in the same rollout changes a projection input (e.g.
`sandbox.limits.allowHosts` or `egress`). The new replica gets `mismatch`, warns, and serves.
(1) Org A's GET shows `fullAccess` absent (follows platform, allowed); `devicePolicy`,
`deviceModeView`, and the local-device token response (`device-auth.ts:259`) all compute Full
allowed for org A. Operation admission is held only by `assertCurrent`. (2) An org A admin changes
the locale: `autoMode` is erased. (3) The operator runs `--activate-permission-config <v1 hash>`:
`convertStoredPermissionKeys` finds no `autoMode`, so org A now follows the platform and its devices
are Full-eligible. The admin's "off" is lost for good and operations are admitted. The same holds
for the platform key: in the window the admin console shows `devicesFullAccess` default/allowed
while `devicesAutoMode: {mode:"off"}` is stored. A super admin write there produces a conflicting
pair that later aborts activation. That fails closed, but the console was wrong.

The same erasure happens whenever a new replica writes an org whose old key was rewritten later by
a stale replica (see I1).

Fix (narrow, and it keeps the spec's "same transaction" conversion intact):
- Until 8.6, have the new readers fail closed over both keys. The org's effective `fullAccess` is the
  narrower of `fullAccess` and a valid/invalid(`off`) `autoMode`. `readStoredDevicesFullAccess` reads
  both `devicesFullAccess` and `devicesAutoMode` and takes the narrower; an explicit value beats an
  absent one only when it is narrower.
- `updateIn` must never drop `autoMode` silently. Carry it into `fullAccess` (refusing on conflict,
  as `convertStoredPermissionKeys` does), or keep it untouched until the publication conversion
  runs.
- Do not "fix" this by converting keys outside the publication. Old replicas still hold the
  matching v1 hash, pass `assertCurrent`, and would read the converted org as `autoMode` absent:
  that widens on the old side.
- Add tests: a mismatch-window GET/org-write/activation sequence must keep org A `off`, and the
  platform view in that window must report the stored legacy `off`.

## Important

### I1. Stale-replica settings writes after conversion are silently ignored (narrowing lost)

`assertCurrent` (`permission-config-publication.ts:352`) is called only from operation admission
(`operation-authority.ts:112,357`). Old replicas' settings writers are not fenced. After a
`migrated` conversion:
- an old replica's admin PUT `devicesAutoMode: {mode:"off"}` writes the old key, which no new
  replica reads;
- an old replica's org PATCH `autoMode: "off"` writes `autoMode` and keeps the stale `fullAccess`
  (an unknown key to the old code), so new replicas read the stale wider `fullAccess`;
- an old replica's cloud device PATCH `mode: "sandbox"` on a snapshotted device
  (`owner_full_access = true`) is ignored. `cloudChosenMode` (`sandbox/modes.ts:256-266`) returns
  `null` whenever `owner_full_access === true`, regardless of `mode`.

In each case the admin's narrowing is acknowledged with 200 and never takes effect. The new
replica's `matching` path (`permission-config-publication.ts:202`) never re-runs the idempotent
conversion, so a restart does not repair it either. The spec delegates this to the rollout ("must
fence/drain them before release"), but the changeset says "old replicas fail the publication
barrier afterwards" (`.changeset/full-access-permission-config.md:12`), which overstates the
protection.

Fix:
- The fail-closed dual-key reader of C1 closes the first two.
- Make `cloudChosenMode` return `"sandbox"` when `mode === "sandbox"`, even with
  `owner_full_access === true` (the minimum of both).
- Optionally run `convertStoredPermissionKeys` on the `matching` startup path too. It is
  idempotent, and a conflict there fails the start closed.
- Correct the changeset/runbook wording: old replicas must be stopped before the first new replica
  starts, because their settings writes are not fenced.

### I2. Snapshot writer: no publication-currency check, and a narrowing without the ceiling writer

`packages/kernel/src/sandbox/cloud-permission-snapshot.ts:113-153`.
- It computes the "old effective" authority from `readDeploymentDevicePolicy` / `readOrgSettings`,
  which now read only the new keys. If it runs in the C1 window (unconverted stored keys), an org
  whose legacy `autoMode` was off snapshots `owner_full_access = true` / open-public. The snapshot
  is "written once", so the widening is permanent. Fix: call
  `PermissionConfigPublication.assertCurrent()` under the platform shared lock inside
  `snapshotLocked`. That proves the conversion committed. Alternatively, use the C1 dual-key
  reader.
- When the known applied limits are stricter than the old effective authority, `cloudSnapshotOf`
  narrows: old auto plus applied sandbox becomes `fullAccess: false`, and the outer network
  becomes the intersection. The device's effective Full and network then change, but no
  device-level `PermissionCeilingWrites.publishLocked` runs: no epoch bump, no Full consent
  invalidation, no revocation selector. The cloud device PATCH path for the same narrowing does
  publish (`devices.service.ts:537-545`). The spec requires "any actual semantic change goes
  through the existing PermissionCeilingWrites selector/epoch/transition/outbox flow".
  Fix: when `snap.fullAccess !== (old.mode === "auto")` or the outer network is narrower than
  `old.network`, call `ceilings.publishLocked({orgId, deviceId}, "device", <Full/network
  selector>, fullNarrowed)` in the same transaction. The device write lock is already held, so the
  assertHeld check passes. Add a test that a Full root on that device is reset.

This is dormant today (no production driver calls `snapshot()`), but it is the writer contract
8.6 will call. Fix it before the driver lands, preferably now.

## Minor

- M1. The `device.permission_reconcile_required` block is enforced only in
  `SandboxOperationAuthority` (`operation-authority.ts:113,358`). The legacy pre-8.6 lifecycle and
  raw paths (`SandboxService` acquire for raw exec/files, skill/attachment preparation, project
  browse outside the authority) do not check it. Record this as an 8.6 obligation, or check the
  marker in the `SandboxService` acquire path.
- M2. `lockedInstance` (`cloud-permission-snapshot.ts:212-224`) treats a row with
  `status: "creating"` and `handle: null`, and an fs that is not ready, as "no instance"
  (`unprobed`, no marker). A create that crashed after the provider acted can leave a real instance
  with old limits. Treat any non-`none` status without established limits as
  `reconcile-required`.
- M3. Provider outer restrictions are not compared, and "Full unavailable if the provider cannot
  enforce the outer boundary" is not modelled (report concern 3). The reconcile path is
  reset-files only. That is acceptable while dormant; track it for 8.6/B4.
- M4. The CLI converter (`config/permission-migration.ts`) handles only YAML/JSON documents. A
  Nacos data id in `properties` format is not convertible, and the usage text does not say so. A
  key reached through a YAML alias or merge key is not renamed. Add the limitation to the usage
  text.
- M5. Tests:
  - No test covers the C1 window or stale-replica legacy writes (I1).
  - The "old replicas fail the barrier" test simulates the old replica with new code, which is fine
    for CAS but proves nothing about settings writers.
  - No dual-replica test covers snapshot against concurrent admission. The lock order is verified
    by reading: lease outside the transaction, then platform shared, org shared, device exclusive,
    then FOR UPDATE. No LockService is taken inside the transaction.

## Verified sound

- **Source precedence:** `translateLegacyPermissionKeys` runs per source before `deepMerge`, so env
  beats file/Nacos for old and new keys. Old and new keys in the same source must be equal, or the
  config fails with an error. The value is validated by the schema under the new key. There is no
  schema default, so configured > DB > default `allowed` holds. `fieldSource` labels the env
  source of either name. Hot reload of either key goes through durable publication (unchanged
  guard).
- **Stored values:** invalid stored deployment and org values convert to an explicit `off`. That
  matches the old readers exactly (old `parseStoredDevicesAutoMode` → off; old org
  `.catch("off")`), so the format-only claim holds. Empty stays empty (follow).
- **v1 → v2 in-place upgrade:**
  - The v1 row is validated with its own schema and exact fingerprint (`sha256` over the v1 field
    order).
  - "Semantically identical" is checked exactly: the `ofLegacy` field-for-field v2 projection must
    hash to the candidate.
  - The CAS update uses the exact v1 hash as predecessor.
  - Key conversion runs in the same transaction under the platform write lock.
  - The format-only case has no epoch bump, Full reset, or revocation.
  - A non-identical case returns `mismatch`. `--activate-permission-config <v1>` then converts and
    runs the full ceiling flow; the epoch and `full_revision` bumps are tested.
  - A conflict or corrupt/unknown predecessor aborts atomically. There is no second publisher.
- **Migration 0145:** `ADD COLUMN IF NOT EXISTS` only, expand-only, kernel schema. Registered
  error `device.permission_reconcile_required: 409`. The marker clears only when no instance/fs
  exists or the applied limits equal the desired limits exactly (host set compared, and nothing
  pending in `unapplied`).
- **Snapshot cases:** auto → true/open-public; egress:none → true/empty; sandbox-open →
  false/open-public; allowlist → exact; empty → empty. A stricter applied instance is never
  widened. The snapshot is written once, and a later widening keeps an explicit false. The legacy
  `mode: null` PATCH never widens a snapshotted device.
- **Platform ops:** `admin.update-settings` and `org-settings.update` use the shared route schemas
  (`DEPLOYMENT_SETTINGS_PATCH.pick`, `OrgSettingsPatchSchema`), and `orgs.set-limits` omit list is
  updated. `check:platform-ops` passes.
- **docs/config.md:** regenerated (`check:config-docs` passes).
- **CLI:** no service connection, `wx` (no overwrite), comment- and order-preserving rename, prints
  env names only. `.env` is loaded by the CLI, but only names are printed.
- **Changed existing tests are justified.** In particular, the admin "startup config is read-only
  and wins" test: the base `KernelConfigService.apply` already rejected a `devices.autoMode`
  change without a publisher, so the old test could not have applied its config. It now publishes
  as the lifecycle does.
- **Open items (8.6 snapshot driver, cloud `ownerCeiling` PATCH):** the cloud part is dormant-safe.
  With no driver, `owner_full_access` stays NULL, `cloudChosenMode` falls back to the old `mode`,
  the marker is never set, and `reconcileDevice` is a no-op. The platform/org config and
  publication conversion is **not** dormant: it runs at every start, which is why C1 is Critical.

## Test evidence (this review, `CAPYBARA_TEST_WORKERS=2 CAPYBARA_TEST_CONTAINER_STARTS=2`, maxWorkers 2)

| Batch | Files | Tests |
|---|---|---|
| unit: config/full-access, sandbox/cloud-snapshot-cases, config/load, config/fields, config/devices-local, apps/capybara config-migrate | 6 | 69 passed |
| config/permission-config-migration, sandbox/cloud-permission-snapshot, sandbox/platform-full-access | 3 | 26 passed |
| admin/admin.http, orgs/settings, identity/settings | 3 | 59 passed |
| devices/mode, sandbox/modes, config/permission-config-activation, infra/config | 4 | 56 passed |
| platform/platform-e2e-phase2, platform/ops-channels-settings, sandbox/platform-full-access, lifecycle/start-order | 4 | 31 passed |

Total 241 tests passed, 0 failed. `pnpm typecheck` clean. `check:config-docs`,
`check:config-forms`, `check:platform-ops` and `check:kernel-conventions` passed. Dual/container
suites were not re-run (the author reports activation.dual, mode-limits.dual, operation-scopes.dual
and permission-lifetime.dual green).

---

# Re-review round 1 (`git diff 2ea4298d3 75586f498`, commit 75586f498)

## Verdict: CHANGES_REQUIRED (one Important, small fix)

C1, I1, I2, M2, M4 and M5 are closed as intended. No new widening path was found. The new 409 can
never block turning Full off. However, it fires falsely on two *agreeing* stored values, and that
blocks ordinary writes, narrowing writes included.

## Closed

- **C1, readers.**
  - `readStoredDevicesFullAccess` (`platform-full-access.ts:150-163`) reads both keys and takes the
    narrower (`off` wins, and an invalid legacy value reads as off). This one function feeds
    `readDevicesFullAccess`, so it covers `SettingsService.view`, `checkDevicesFullAccess`,
    `readDeploymentDevicePolicy` (devicePolicy, devices views, the device-auth token response)
    and the org `deployment()` view.
  - `parseOrgSettings` (`orgs/settings.service.ts:355-362`) applies `narrowedOrgFullAccess`, so
    `readOrgSettings`, the org GET, devicePolicy and device-auth see the narrower value.
  - A legacy `allowed` with the new key absent reads as follow. Effective permission is the
    minimum of platform and org, so this equals the old explicit `allowed`: no widening.
- **C1, writers.**
  - `updateIn` no longer drops `autoMode`. It carries the legacy value into `fullAccess` and
    writes `autoMode` in step while the old key exists (`:657-670`, `:705-711`).
  - The admin `devicesFullAccess` write also rewrites `devicesAutoMode` while that key exists
    (`identity/settings.ts:812-818`).
  - Conversion still happens only in the publication transaction (`convertStoredPermissionKeys`
    callers unchanged). The keys kept in step agree, so a later conversion does not hit its
    conflict check.
- **Mismatch-window scenario re-run.** The new test "a mismatch window reads the legacy off, an
  org write keeps it, activation converts to off" covers exactly my scenario. It passes: GET,
  devicePolicy and the admin view read off; a locale write keeps `autoMode: off`; activation ends
  with `fullAccess: off`.
- **I1.**
  - `cloudChosenMode` now returns the minimum (`mode === "sandbox" || owner_full_access === false`).
  - Stale-replica legacy writes narrow (tested).
  - The changeset now states that settings writes are not fenced and that every old replica must
    stop before the first new replica starts.
- **I2.**
  - `snapshotLocked` calls `assertCurrent()` under the platform shared lock (tested: refused, row
    untouched).
  - A narrowing snapshot calls device-level `publishLocked`, which bumps the epoch. It passes
    `invalidateFullConsent = fullNarrowed`, so the Full root is reset (tested: `approve-for-me`,
    revision/full_revision 1). Its selector revokes Full scopes and allowlist hosts outside the
    outer network. A no-op snapshot publishes nothing (tested).
- **M2.** `creating` without a handle, or any `fs_status !== "none"` (`ready`/`lost`), counts as
  an instance and leads to `reconcile-required` (tested). This fails closed, and reset clears it.
- **M4.** The usage text now states the YAML/JSON-only and alias/merge-key limits.
- **M5.** Window and stale-replica tests were added.
- **Not blocking Full off.** Org PATCH `fullAccess: "off"` takes the `patch.fullAccess !== undefined`
  branch and never reaches the 409. Admin PUT `devicesFullAccess` has no new refusal.

## Remaining

### Important R1. False `org.settings_conflict` on agreeing values blocks ordinary and narrowing writes

`orgs/settings.service.ts:660-668` compares the raw `stored.fullAccess` with
`narrowedOrgFullAccess(undefined, stored.autoMode)`. For a legacy `autoMode: "allowed"` that
function returns `undefined` (follow), so stored `{ fullAccess: "allowed", autoMode: "allowed" }`
gives `"allowed" !== undefined` and a 409.

The same file produces that state itself. A window PATCH `fullAccess: "allowed"` on an org that
still has `autoMode` writes both keys as `allowed` (`:705-711`). An old replica re-writing
`autoMode: "allowed"` after conversion produces it too.

After that, every org write that does not name `fullAccess` returns 409: locale, theme, and
narrowing `cloudNetwork` writes. The workaround is to resend `fullAccess`. Turning Full off still
works.

Fix: compare parsed values, using the old reader's own semantics: `legacyValue =
Permission.safeParse(autoMode).success ? data : "off"`, and conflict only when the parsed
`fullAccess` is defined and differs. Better still, drop the 409 entirely and carry the narrower
value (`after.fullAccess = narrowedOrgFullAccess(before.fullAccess, stored.autoMode)`). That is
already what every reader sees, so it can never widen, and no narrowing write is ever refused. Add
a test with `{ fullAccess: "allowed", autoMode: "allowed" }` plus a locale or cloudNetwork write.

### Minor R2. The snapshot's network selector revokes only allowlist-network scopes

The selector (`cloud-permission-snapshot.ts:173-183`) revokes only allowlist scopes whose hosts
fall outside an allowlist outer network. When the outer network narrows from open-public to an
allowlist, an admitted restricted operation whose scope network is open is not revoked. The
practical impact is nil, because the narrowing comes only from the instance's own applied
allowlist. Even so, revoke any non-allowlist execution scope when `outer.kind === "allowlist"`.

M1 and M3 stay recorded for 8.6/B4.

## Tests (this round, CAPYBARA_TEST_WORKERS=2, maxWorkers 2, HEAD 75586f498)

| Batch | Files | Tests |
|---|---|---|
| permission-config-migration, cloud-permission-snapshot, cloud-snapshot-cases, orgs/settings | 4 | 53 passed |
| admin.http, identity/settings, platform-full-access, devices/mode, permission-config-activation, apps/capybara config-migrate | 6 | 78 passed |

131 passed, 0 failed. `pnpm typecheck` passed. `check:platform-ops` and
`check:kernel-conventions` passed. R1 is not covered by any test; I found it by reading the code
and tracing the values.
