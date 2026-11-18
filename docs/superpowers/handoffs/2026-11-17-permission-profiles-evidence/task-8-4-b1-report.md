# Task 8.4 B1 report: public platform/org/cloud permission config migration — DONE_WITH_CONCERNS

Worktree `.claude/worktrees/perm-t8-4-b1`, branch `perm/t8-4-b1`, base `473486522` (perm/t8-4).
Not pushed, no PR. All runs `CAPYBARA_TEST_WORKERS=2 CAPYBARA_TEST_CONTAINER_STARTS=2`, small
batches. Logs: scratchpad `b1/` (`red-1.log`, `green-1.log`, `red-cli.log`, `green-cli.log`,
`red-cloud.log`, `green-cloud*.log`, `batch1..6.log`, `check-*.log`, `unit.log`).
No B4 surface touched (no sandbox.service instance writer, local provider/coordinator/gateway,
Machines, device commands/client/server, runtime manifest). Migration number used: 0145.

## Commits

| sha | What |
|---|---|
| `2655a9848` | feat(kernel): Full permission config replaces auto-mode inputs; 6c projection v2 + one-time conversion |
| `c04a4d1e8` | feat(capybara): `capybara config migrate-permissions` |
| `2ea4298d3` | feat(kernel): cloud owner ceiling/outer network snapshot, migration 0145, reconcile block |

## 1. Platform/org public config (`2655a9848`)

- `config/schema.ts`: `devices.fullAccess` (optional, no default, hot). `config/load.ts`
  `translateLegacyPermissionKeys` translates `devices.autoMode` / `CAPYBARA_DEVICES__AUTO_MODE` **per
  source before the merge**, so the old key keeps its own source's precedence (env > file/Nacos);
  old+new in one source must agree, else ConfigError; invalid values fail the schema.
  `KernelConfigService.fieldSource` labels either env name; hot reload publishes on
  `devices.fullAccess`. docs/config.md regenerated.
- `sandbox/platform-full-access.ts` (renamed from platform-auto-mode.ts): `devicesFullAccess`
  `{permission?}` setting, strict, invalid -> off + warning; `resolveDevicesFullAccess`
  configured > DB > default allowed. Old public views/patches kept as mirrors until 8.6
  (`DEVICES_AUTO_MODE_PATCH`, `legacyAutoModeView`).
- Admin settings: GET adds `devicesFullAccess:{permission,source}` (keeps `devicesAutoMode`
  mirror); PUT accepts `devicesFullAccess:{permission|null}` and the old `devicesAutoMode`
  (normalized; both -> 400 validation_failed); readonly path `devicesFullAccess.permission`;
  narrowing still through `PermissionCeilingWrites.publishLocked`; audit records
  `devicesFullAccess(Effective)`. Platform op `admin.update-settings` picks both keys (same shared
  schema; `pnpm check:platform-ops` passes); `orgs.set-limits` omits list updated.
- Org settings: stored `fullAccess` (invalid -> off + warning); PATCH accepts `fullAccess` and old
  `autoMode` (schema refine refuses both); answers mirror `autoMode` (`orgSettingsView`) and
  `deployment.fullAccess` + `deployment.autoMode`. Writes clear a leftover stored `autoMode`.
  Narrowing goes through the existing org ceiling writer (B3 selectors unchanged).
- Internal readers (`modes.ts`, device-auth, devices.service, sandbox config warning) use the new
  names. The device token response field `autoMode` (device protocol, B2 territory) is unchanged.
- **6c publisher evolved, not duplicated** (`permission-config-publication.ts`): projection
  `{version:2,fullAccess,egress,orgHosts,allowHosts}` fixed order, same 64 KiB bound, SHA-256 over
  canonical JSON. Stored rows are validated by their own version (v1 with the old algorithm and
  exact old fingerprint). Startup: a v1 row semantically equal to the local v2 -> outcome
  `migrated`: CAS update (predecessor = exact v1 hash) + `convertStoredPermissionKeys` in the same
  transaction under the platform write lock; no epoch, Full reset, revocation or outbox. A
  semantic difference -> `mismatch` (activeHash = v1 hash); `--activate-permission-config <v1>`
  converts keys and runs the existing ceiling selector/epoch flow. Fresh init converts keys too.
  Conflicting old/new stored values (deployment or any org) and corrupt/unknown predecessors abort
  the whole transaction. Old replicas: v1 hash != active -> assertCurrent fails; stale CAS loses.

## 2. Conversion command (`c04a4d1e8`)

`capybara config migrate-permissions --in <file> --out <file>` (kernel
`config/permission-migration.ts`, exported): YAML Document rename in place (comments/order kept),
equal old key dropped, conflict/invalid refused (exit 1), output opened `wx` (never overwrites),
prints env renames without values, connects to nothing (Nacos via saved copy + reviewed publish).

## 3. Cloud per-device snapshot (`2ea4298d3`)

- Migration `0145_cloud_owner_ceiling.sql` (ADD COLUMN IF NOT EXISTS only): `devices.owner_full_access`,
  `outer_network`, `permission_migration` (provenance), `permission_reconcile_required`.
- `modes.ts`: `cloudSnapshotOf(oldEffective, applied)`, `intersectNetworks`,
  `sameAppliedExactly` (host set, not just kind), `cloudChosenMode`; `effectiveDevicePolicy`
  takes the outer network and intersects. PermissionFacts and devices.service use them.
- `sandbox/cloud-permission-snapshot.ts` `CloudPermissionSnapshots`: exclusive lifecycle lease
  (SandboxLeases, outside the tx) -> device authority write lock (platform->org->device) -> row
  locks; old effective via the old algorithm; known applied limits only narrow (stricter instance
  never widened); written once (`existing` afterwards). States unprobed / bound /
  reconcile-required(+`action: reset-files`). `reconcile`/`reconcileDevice` clear the marker only
  when no instance/fs remains or applied == desired exactly; the reset-files job now reconciles.
- Admission block: `PermissionFacts.assertCloudReconciled` in `SandboxOperationAuthority.snapshot`
  (resolve + previewCall) and `resolveBrowse` -> 409 `device.permission_reconcile_required`.
- Old cloud PATCH `mode:"sandbox"` narrows a snapshotted ceiling; `mode:null` never widens it.

## Acceptance evidence

| Item | Tests |
|---|---|
| allowed/off/default/configured-over-DB | sandbox/platform-full-access, identity/settings, orgs/settings ("configured wins"), admin.http readonly |
| org follow/allowed/off, corrupt | orgs/settings "org fullAccess (B1)", migration test corrupt org, registry.test |
| strict source precedence | config/full-access (env>file across old/new, same-source conflict), infra/config |
| cloud auto / sandbox-open / allowlist / empty / egress:none | sandbox/cloud-snapshot-cases (unit) + cloud-permission-snapshot |
| unknown/stale applied limits block | cloud-permission-snapshot (unknown, stale host set, pending reset; reconcile; reset job) |
| semantic publication migration / CAS / crash / stale replica | config/permission-config-migration (7 tests) + existing activation + dual suites |
| no second publisher | conversion lives inside `PermissionConfigPublication` (`initializeLocked`/`publishLocked`) |

RED (behavioural): `red-1.log` 14 failures (config translation undefined, outcome `matching`
instead of `migrated`, keys unconverted, conflicts not refused); `red-cli.log` 5 (unknown option
`--in`); `red-cloud.log` 8 (skeleton writer returned `skipped`, columns null). The pure
`cloud-snapshot-cases` helpers were written with the implementation (not RED first).

Verification: focused batches all green (batch1 141, batch2/2b 175, batch3 177, batch4 113 incl.
container suites, batch5 193, batch6 24 container: operation-scopes.dual, mode-limits.dual,
permission-lifetime.dual, activation.dual; snapshot+lifecycle+maintenance 29; CLI+args 34);
`pnpm typecheck` clean (incl. web); `pnpm check` all passed (platform-ops, config docs, kernel
conventions, test portfolio); Biome clean on touched files (pre-existing warnings only);
`pnpm test:unit` 131 files / 1473 tests passed. New lists: `config/full-access.test.ts`,
`sandbox/cloud-snapshot-cases.test.ts` in unit-tests.json; the other new tests are integration.
Changesets: `full-access-permission-config.md`, `cloud-owner-ceiling-snapshot.md` (kernel),
`config-migrate-permissions.md` (capybara). No SDK change. No web change needed (old public
fields are mirrored; UI rename is Task 10E).

## Not done / concerns

1. **Snapshot invocation**: nothing calls `CloudPermissionSnapshots.snapshot` in production yet.
   Per spec it runs after closing admission through the deployment cutover barrier (8.6 sequence);
   an iterate-all-devices driver (job or CLI) is not written.
2. **Cloud `ownerCeiling` PATCH** (`ownerCeiling?:{fullAccess:boolean}`, session-only widening with
   confirmation, route schema + platform op parity) not implemented; a snapshotted false can only
   be widened by that future API. Old `mode` PATCH narrows only.
3. Reconciliation only clears via "no instance/fs" or exact recorded equality; there is no
   provider-update reconcile path (that would need the sandbox.service instance writer, B4's lane).
   "Full unavailable if the provider cannot enforce the outer boundary" is not modelled.
4. Old replicas that still write `devicesAutoMode` / org `autoMode` after conversion are not read
   by new replicas; the rollout must fence/drain them (spec says so) — not enforced in code.
5. Error codes `org.auto_mode_not_allowed` / `deployment.auto_mode_not_allowed` kept (web maps
   them); renaming them belongs with 8.6/10E. Device token `autoMode` field unchanged (B2).
6. Admin test "startup config read-only and wins" previously called `service.apply` without the
   durable publisher (it could not have applied); it now publishes like the lifecycle does.

## Fix round 1 (independent review CHANGES_REQUIRED) — commit `75586f498`

RED (`b1/fix1-red.log`): 8 behavioural failures — window GET read `allowed` over stored legacy
off; org locale write erased `autoMode`; no carry of the old platform key; no conflict refusal;
stale-replica legacy off ignored; `cloudChosenMode(mode sandbox, owner true)` returned null; a
narrowing snapshot left a Full root `full-access`; `creating`/no-handle row read `unprobed`;
snapshot ran on a non-current replica.

- C1: `readStoredDevicesFullAccess` reads `devicesFullAccess` and `devicesAutoMode`, narrower wins
  (off if either is off or the old value is invalid). `parseOrgSettings` narrows `fullAccess` with a
  stored `autoMode` (`narrowedOrgFullAccess`), so GET, `devicePolicy`, devices views and the
  device-auth token all see the narrowed value. `OrgSettingsService.updateIn` never drops a stored
  `autoMode`: a write that sets `fullAccess` writes both keys equal; one that does not carries the
  old value into `fullAccess` and keeps `autoMode`, refusing 409 `org.settings_conflict` when the
  two stored values differ. Admin writes of `devicesFullAccess` also rewrite a present
  `devicesAutoMode` in step. Key conversion stays only in the publication transaction.
- I1: `cloudChosenMode` = sandbox when `mode === "sandbox"` or `owner_full_access === false`.
  Old-replica legacy writes are honoured by the narrow read (tested). Conversion on the `matching`
  path not added: a conflict there would block startup after an old replica wrote a differing key,
  while the narrow read already fails closed. Changeset now says: stop every old replica before
  the first new replica starts (settings writes are not fenced).
- I2: `snapshotLocked` calls `PermissionConfigPublication.assertCurrent()` after the platform
  shared lock. If the snapshot narrows the old effective authority (Full false, or outer network
  narrower), it calls `PermissionCeilingWrites.publishLocked({orgId,deviceId},"device",selector,
  fullNarrowed)` in the same transaction: epoch bump, Full consent reset, exact revocation of
  Full / uncovered allowlist host intents. Tested: Full root reset, device epoch 1/1; an unchanged
  snapshot publishes nothing.
- M2: `creating` rows (with or without a handle) and any non-`none` file system are "not
  established" -> reconcile-required.
- M4: CLI usage states YAML/JSON only (no properties-format Nacos) and alias/merge keys not renamed.
- M5: window and stale-replica tests added (4 in permission-config-migration, 3 in
  cloud-permission-snapshot, cases updated). They use the real services and simulate an old
  replica's writes by its exact stored shape. No dual-replica test was added (old code cannot run
  in-process).

Verification: focused 34 + 124 + 255 tests green; container suites operation-scopes.dual,
mode-limits.dual, activation.dual, permission-lifetime.dual 24/24; `pnpm typecheck` clean; `pnpm
check` all passed; Biome clean; `pnpm test:unit` 131 files / 1473 tests.

8.6 / B4 obligations recorded:
- M1: `device.permission_reconcile_required` is enforced only in `SandboxOperationAuthority`.
  Legacy pre-8.6 `SandboxService` acquire paths (raw exec/files, skill/attachment preparation,
  browse outside the authority) do not check it; 8.6 must check it (or remove those paths) before
  the snapshot driver runs. Not added here because the acquire path is in B4's lane.
- M3: provider outer-restriction comparison, "Full unavailable if the provider cannot enforce
  the outer boundary", and a provider-update reconcile path (8.6/B4).
- The snapshot driver, the cloud `ownerCeiling` PATCH and the error-code renames are still open.

## Fix round 2 (re-review round 1) — commit `c674362fa`

RED (`b1/fix2-red.log`): 3 failures — an agreeing stored pair `{fullAccess:"allowed",
autoMode:"allowed"}` refused a locale write (409); a divergent pair refused a locale write; an
`environment`-network exec intent stayed `admitted` after a snapshot narrowed the outer network to
an allowlist.

- R1: removed the `org.settings_conflict` 409 (and its error code). A write without `fullAccess`
  over a stored `autoMode` now stores `narrowedOrgFullAccess(before.fullAccess, stored.autoMode)`
  in both keys: never refused, never wider. Tests: agreeing pair -> locale and cloudNetwork
  narrowing writes succeed and keep both keys `allowed`; divergent `{off, allowed}` -> locale write
  stores `off` in both keys.
- R2: the snapshot's device ceiling selector also revokes execution intents whose network is
  `environment` when the outer network is an allowlist (`none` is narrower and kept; allowlists
  still checked host by host). Test: environment revoked, covered allowlist and none kept.

Verification: migration + snapshot + orgs settings + ops-channels-settings + registry 69/69;
`pnpm check` passed; test typecheck clean; `pnpm test:unit` 131 files / 1473 tests.
