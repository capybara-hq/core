# Task 8.4 B4 report: generation and installed identity — DONE_WITH_CONCERNS (staged)

Worktree `.claude/worktrees/perm-t8-4-b4`, branch `perm/t8-4-b4`, base `473486522` (perm/t8-4).
Not pushed, no PR. All runs `CAPYBARA_TEST_WORKERS=2 CAPYBARA_TEST_CONTAINER_STARTS=2`.
Logs: scratchpad `b4/` (`sdk-red.log`, `kernel-red.log`, `device-binding-red.log`, `unit.log`,
`device-all.log`, `kernel-batch1.log`).

## Commits

| sha | What |
|---|---|
| `e6c338b31` | cherry-pick of primary `614325137` (runtime bundle 2 on the macOS backend), per coordinator |
| `fe24223ec` | feat(kernel): durable instance generations and post-commit binding (SDK codec, migration 0146) |
| `f24188071` | feat(device): canonical installed-byte runtime manifest (verifier + package-build generator) |
| `124eb1f9b` | feat(device): authenticated post-commit instance binding (staged) + kernel per-machine previous |

## What was built

**SDK (staged v3, gen:sdk-api + changeset):** `bindInstance` op; request args exactly
`{instanceId, instanceGeneration (^\d{1,16}$), bindingId (uuid), expectedPreviousGeneration (null
or older generation)}`, unknown keys (paths, manifests, policies, scope) rejected; answer parser
bound to the exact request (instanceId/generation/bindingId/identity generation), full
`runtimeIdentity`, `permissionSupport`, `ownerCeiling`. New exported types
`BindInstanceRequestV3`, `BindInstanceResultV3`, `DeviceRuntimeIdentityV3`.

**Kernel:**
- Migration `0146_device_instance_generations.sql`: `device_generation_high_water` (no FK; outlives
  instance rows) and `device_instance_bindings` (PK device+generation, unique binding_id,
  `awaiting-device|installed`, machine_id, runtime_identity; no FK).
- `PermissionInstanceWrites.commitHandle`: generation = `max(db clock_timestamp ms, highWater+1)`
  under the device authority lock, committed with created_at in the same tx; high-water initialized
  once from instance/bindings/intents/background tasks/reports; non-numeric prior generation →
  `InconsistentGenerationError` (nothing committed); range exhaustion refused. Local instances get
  an `awaiting-device` binding with random id; previous = the **current machine's** last installed
  binding. Consent: with no prior `permission_roots`, the baseline is the machine-reported roots the
  person saw (first create on those roots no longer resets Full consent).
- `LocalInstanceBindings` (local-devices): `committed()` (no allocation), `bind()` sends the staged
  RPC via `relay.callV3` fenced to the current connection outside any tx, `install()` under the
  device writer verifies row/generation/handle/bindingId/machine, records the report, marks
  installed; a changed environment fingerprint vs the previous installed binding resets Full
  consent; first verified proof does not. Installed binding → retry sends nothing.
- `readRuntimeReport` for `@local` requires an installed binding whose identity equals the
  instance's recorded identity.
- `Machines.recordHelloV3` (runtime report writer): only a bound hello re-reporting exactly the
  installed identity attests; unbound/awaiting/other generation → unprobed; a changed identity →
  unprobed + device admission epoch bump (Full consent reset only if imageFingerprint changed).
- Bug fixed in `recordHello`: roots compared canonically — jsonb returns keys in another order, so
  **every reconnect hello reset Full consent** (re-consent loop). This touches a Machines writer B2
  also owns; minimal (comparison only).

**Device:**
- `exec/runtime-manifest.ts`: canonical v1 entries/order/hash; `enumerateInstalled` follows the
  emitted helper closure (static + literal dynamic imports via a small lexer; non-literal dynamic
  import fails unless declared — the worker bootstrap's `import(pathToFileURL(message.runtime))`
  is the one declared), `@capybara-hq/*` modules as helpers, third-party packages and
  `@anthropic-ai/sandbox-runtime` with their full dependency closure as runtime entries (all files,
  `meta/<name>@<version>` entries), inline `native-files.py`, native prelude, output-spool helper and
  worker bootstrap. Files hashed through O_NOFOLLOW handles with post-read identity check.
  `collectEnvironment`: real node/python/shell realpaths+hashes, `sw_vers` build, uid, python
  modules the helpers load (+libpython), boundary digest of roots/uid. `verifyInstalledRuntime`
  compares installed with the shipped `dist/runtime-manifest.json`.
- `tools/runtime-manifest.ts` (+ `prepack` script): loads the emitted verifier and writes the
  manifest. Ran on the real build: 2967 runtime / 74 helper entries; real verification ~1 s.
- `exec/instance-binding.ts` `InstanceBinder`: bind only by request; stored previous must match;
  never to an older generation; new generation refused while `retirementObligations()` (new
  supervisor read-only method: other-generation entries live/cancelling or without completed
  result / established stop) or current ownership is nonzero; verify before write; durable
  write-then-rename+fsync before enabling the backend; same binding idempotent (re-verified);
  same generation + other binding id = conflict; `recover()` after restart only with unchanged
  runtime. `serveOperationV3` serves `bindInstance` through the binder; staged session routes ops
  to the bound backend, refuses all while unbound.

## Acceptance items

| Item | Evidence |
|---|---|
| unbound first hello/create | kernel: awaiting binding + bound hello/report attest nothing; device session: unbound hello, ops refused, bindInstance then admitted |
| post-commit bind | kernel `bind()` exact request, install, report supported; device durable binding |
| reconnect | kernel: same-identity hello after rename keeps report and consent (jsonb-order fix) |
| same-generation recovery | device restart recovers binding + journal (old ref → `lost`, no PID reattach); output-spool read after restart not separately gated |
| real replacement | kernel G1→G2 with previous; device G1→G2 after settle; old refs refused |
| stale/changed helper/interpreter/env | kernel hello: helper change → unprobed + epoch bump; env change → consent reset; device: changed runtime not recovered/rebind refused; manifest tests: changed/missing/extra/symlink/inline change |
| failed verification → no admission | device: verify failure binds nothing, no file, unbound |
| old retirement obligation survives asserted generation | device: live and post-restart uncertain work block G2 and a far-future generation |
| generation collisions | kernel: rolled-back clock, deleted row, same-ms (seam `databaseNowMs`), unordered prior generation |
| consent stability | first-unprobed → create on displayed roots → bind: full_revision unchanged; other roots/env reset |

RED: SDK 2 behavioural failures (`sdk-red.log`); kernel 7/8 behavioural (`kernel-red.log`, e.g.
same generation reused `1794897241354 > 1794897241354`, consent reset, delayed answer accepted);
device manifest/binder RED is module absence (new modules).

## Verification

- kernel instance-bindings 9/9, machines + permission-wiring 46 (with bindings), batch of
  sandbox.service/instance/permission-policy/local-device-provider/lifecycle/gateway 148/148
- SDK v3 codec 12/12; device instance-binding/staged-session/server-ops-v3/supervisor/backend 56/56;
  runtime-manifest 10/10
- `pnpm typecheck` clean, `pnpm check` all passed, Biome clean on touched files
- `pnpm test:unit` 129 files / 1457 tests passed; full device suite + SDK v3 36 files / 608 passed, 1 skipped

## Remaining (not done)

- **Production wiring stays dormant**: `commands/start` does not construct the binder / a bound
  hello (re-verified identity) yet; `sandbox.service` does not call `LocalInstanceBindings.bind`
  before downgrade (the v3 provider is not registered). Both belong to the paired activation.
- 8.5 legacy gate check before sending bind (seam: `LocalInstanceBindings.bind`).
- B2: persist `ownerCeiling` from the bind answer through the owner-summary publisher (parsed and
  validated only).
- Staged drain does not refuse `bindInstance` (binder refuses a new generation only on
  obligations); left alone to avoid the drain edits in flight.
- Manifest limits: no pinning between verification and the worker's own `createRequire` resolution
  at launch (TOCTOU); Node's dynamic libraries and python native deps beyond loaded modules +
  libpython are not enumerated; the import lexer is heuristic (fails closed on unterminated
  tokens). Cloud provider image attestation not implemented (providerImageDigest null = host).
- A bound hello cannot finish an awaiting installation (hello carries no bindingId); only the
  bindInstance answer installs.

## Concerns

- `recordHello` canonical-roots fix changes behaviour on the active v2 path (fewer spurious Full
  consent resets on reconnect). Reviewers should confirm it is wanted now.
- Two supervisors may read the same journal briefly when binding a new generation in a process
  that still holds the old (idle) backend.
- `kernel-schema.ts` and `machines.ts` may conflict textually with B1/B2.

## Fix round 1 (independent review CHANGES_REQUIRED)

Logs: scratchpad `b4/fix1-device-red.log`, `b4/fix1-kernel-red.log`, `b4/fix1-i3-red.log`.

**I1 — one supervisor per journal** (`exec/instance-binding.ts`, supervisor/backend):
- Supervisor `close()` (only when it owns nothing): never persists or admits again. Backend
  `lifecycle.dispose()` closes it and refuses every later call (typed `unsupported`, "superseded").
  `retirementObligations(generation)` is parameterized.
- New-generation bind: `beginDrain()` on the old backend first, then verify, then require that the
  old backend owns nothing and has no unsettled work of other generations, write the binding
  durably, re-check after that last await (on failure the previous binding file is written back),
  dispose the old supervisor, and only then build the successor from the journal on disk. Without a
  live backend the successor is the only supervisor; it is disposed when it refuses. `recover()`
  never builds a second supervisor (returns the live one or nothing); `enable()` throws if one exists.
- Tests (RED: 5 s timeout / "not settled (2)" from a stale snapshot / second backend leaked):
  an in-flight start whose launch resolves during a held verify blocks the bind and the binding file
  stays G1; a fresh start during the bind is refused; an exact stop recorded by the old supervisor
  during the bind survives in the journal after the new generation's first write; the old backend
  refuses afterwards; a refused bind and `recover()` construct no extra backend.

**I2 — consistent binding chain** (device + `permission-instance-writes.ts`):
- Device: one binding file per device id (`instance-binding-<sha256(deviceId)>.json`, like the
  journal); `StoredBinding` carries `deviceId` and `credentialIdentity` (sha256 of the credential,
  never the secret). Rule: never move to an older generation; a stored binding of this credential
  must not be newer than the kernel's previous; another credential's binding is no previous.
- Kernel: the awaiting binding records the active machine at commit; previous = the last binding
  committed for that machine, **delivered or not** (so a persisted-but-unconfirmed generation
  chains). A re-login (new machine) has no previous.
- Cross-side kernel tests drive the real device binder over a real backend via the relay mock:
  lost answer then replacement (RED: previous was null); re-login with the old binding in the same
  state directory; two devices sharing one state directory. Device RED for these: "invalid stored
  binding" / "does not follow previous".
- Concern: the kernel test imports device sources by relative path (`../../../device/src/...`);
  `pnpm check` passes.

**I3 — reproducible installed closure** (`packages/device/package.json`, `tools/runtime-manifest.ts`):
- pnpm refuses `bundleDependencies` with the isolated linker, and the workspace **patches**
  `@anthropic-ai/sandbox-runtime` (so a shrinkwrap of registry tarballs could never match). So
  `prepack` now copies the whole runtime closure (`bundledRuntime`: plugin-sdk with its publish
  exports, the patched sandbox runtime, ws, all transitive dependencies) byte for byte into
  `dist/node_modules` with npm-style hoisting (checked: every dependent resolves its exact
  version), then writes the manifest from that tree; `postpack` removes the bundle. Runtime packages
  are resolved from `dist/exec` (where the worker runs), so the bundle wins. The published package
  declares **no dependencies** (moved to devDependencies; `pnpm-lock.yaml` updated). Bundle ≈ 40 MB.
- Same runtimeHash as before bundling (identical bytes).
- Engines: prepack/postpack use `node --experimental-strip-types` (works from 22.6).
- New `test/runtime-manifest-pack.test.ts`: `pnpm pack` as the release does → `npm install
  --offline` into a clean prefix (own npmrc, cache, unreachable registry) → installed package has
  no dependencies, ships the patch, verifies against its manifest; a changed installed byte fails.
  RED on the previous packaging: `ENOTCACHED` (npm must fetch the closure from a registry).
  ~13 s, all in `beforeAll`. It packs inside the workspace (dist/node_modules exists briefly).

**Minors:** M2 probe imports derived from the shipped Python helper sources (`pythonImports`;
urllib.parse, re now fingerprinted; test checks every helper import's file is an entry). M5
`bind()` refuses an open transaction (test). M6 unparseable binding → `SandboxScopeDeniedError`
(test). M7 three concurrent commits of one fence → one generation, one mark, one binding; lost
commit reply reconciled from the committed binding without allocating. M8 `pruneBindings` after
each commit keeps the new and previous binding, each machine's latest installed one and any
generation with an owed intent (not completed, or revoked unacknowledged) or non-terminal managed
task (test). M1 recorded as an 8.6 activation blocker (unchanged); M3/M4/M9 deferred to B2/8.5/drain.

**Fix round 1 commits:** `cdf5abdf1` (I1, I2, M2, M5–M8), `527c6a3da` (I3).

**Verification:** device suite + SDK v3 37 files / 619 passed, 1 skipped (CAPYBARA_TEST_WORKERS=2);
kernel instance-bindings 16/16 plus machines, permission-wiring, sandbox.service and
permission-policy, 149 in total; `pnpm test:unit` 129 / 1457; `pnpm typecheck` clean; `pnpm check` passed;
Biome clean.

**Concerns:**
- Under heavy load (load avg about 9.5) with default workers, two pre-existing real-macOS tests
  (`mac-operation-backend` "prepares a missing conversation subtree", `operation-supervisor`
  "real registered cancellation") hit their 5 s timeout during a full device run. They pass alone
  and in the 2-worker full run. The new pack test adds load (about 13 s of pnpm pack and npm install).
- `pnpm install --offline` re-resolved the whole lockfile and dropped optional platform packages.
  It was restored from HEAD with only the device importer change (dependencies moved to
  devDependencies).
- The published device package grows by about 40 MB (bundled closure, including kysely and the
  sandbox runtime's vendor binaries).
- The pack test packs inside the workspace, so `dist/node_modules` exists briefly; postpack removes it.
- The kernel cross-side tests import device sources by relative path.
- A bind refused after `beginDrain` leaves the old generation draining. This is intended: the kernel
  has already replaced that instance.

## Fix round 2 (re-review round 1)

Commits: `e366658dc` (kernel: N1, R2, R1), `6acde42d8` (device: R4, R3). Failing-test logs:
scratchpad `b4/fix2-kernel-red.log` and `b4/fix2-bundle-red.log`.

- **N1:** `install()` now compares `imageFingerprint` with the device's latest *installed* binding
  older than the request.
  - Test, environment changed: G1 installed with fingerprint A, the answer for G2 lost, G3 bound
    with fingerprint B. Expect `full_revision + 1`. RED: `expected +0 to be 1`.
  - Converse: the same fingerprint gives no reset.
- **R2:** if the committed binding's `machine_id` is not the active machine, `bind()` first
  retargets it.
  - `retarget()` runs as a transaction under the device writer.
  - It changes only an `awaiting-device` row with the exact generation and id, and sets the active
    machine and that machine's previous.
  - Cross-side test: G2 committed for M1, re-login as M2, the answer is lost, then G3. The row now
    carries M2, G3 names G2 as previous, and G3 installs. RED: the row kept the old machine id.
  - `CommittedBinding` gains `machineId` (an added field; answer handling is unchanged).
- **R1:** the kernel declares `@capybara-hq/device: workspace:*` as a devDependency, and
  docs/architecture.md records the tests-only edge.
  - Why not move the tests to packages/testing: they need kernel services and kernel test helpers,
    and `test/background/macos-device.test.ts` already crosses the same way.
  - Effect: `tools/ci` derives affected packages from package.json dependencies, so a change only
    to the device now runs the kernel tests.
  - The device still imports only the SDK. The imports stay relative paths, because the device
    package exports only its entry.
  - pnpm-lock.yaml: only the kernel importer gained this entry. Edited by hand, then
    `pnpm install --frozen-lockfile`.
- **R3:** the waits in those tests are already event-based. The timeouts came from real-OS work
  (several sandbox-exec, Python helper and curl processes) against the 5 s default under load.
  - The fix follows the repo's category rule: a checked-in list `packages/device/test/os-tests.json`
    defines a `device-os` vitest project. It holds the exec-os, network, docker and host tests, the
    fs, native and output-spool helpers, the native contract, mac-operation-backend,
    operation-supervisor, runtime-manifest (it hashes the real node binary) and the pack test.
  - The project has a category-sized `testTimeout: 60_000` (as kernel-container does) and
    `sequence.groupOrder: 1`, so it runs after the parallel projects instead of competing with them.
  - No per-test timeout and no sleep was added.
  - The full device suite at the **default** worker count passed with load average 15: 38 files,
    621 passed, 1 skipped.
  - Note: `operation-supervisor.test.ts` is unchanged, only listed, so there is no conflict with
    the drain work.
- **R4:**
  - The bundler writes `CAPYBARA-MODIFICATIONS.md` and copies the exact patch
    (`CAPYBARA-MODIFICATIONS.patch`) into every package listed in the workspace's
    `patchedDependencies`.
  - It refuses packages with `optionalDependencies` or with `os`, `cpu` or `libc` fields.
  - New `test/runtime-bundle.test.ts`. RED: no notice was written, and the bundle was accepted.
  - The pack test checks that the installed sandbox-runtime carries the notice and the patch.
  - docs/deploy/release.md gains "The device package's bundled dependencies": frozen per release,
    `npm audit` does not see them, and a Dependabot alert means a device re-release.

Verification:
- kernel instance-bindings 19/19, plus machines, background/macos-device and tools/ci (101 tests in
  total, workers 2)
- device + SDK v3 at the default worker count: 38 files, 621 passed, 1 skipped
- `pnpm test:unit` 129 files, 1457 passed; `pnpm typecheck` clean; `pnpm check` passed; Biome clean

## Fix round 3 (re-review round 2 minors)

Commit `8f03df3d1`. Each change was red first, failing on its behaviour.

- **R5:** `tools/ci/src/affected.ts` gains `TESTS_ONLY_EDGES` (kernel → device), followed one step
  only.
  - A device change runs the `packages/device` and `packages/kernel` tests, plus `tools/checks` as
    on every PR.
  - It does not run the kernel's dependents (`apps/capybara`, `packages/testing`), and never web,
    visual, e2e or docker. `depsOf` skips the edge too.
  - The kernel devDependency stays.
  - Covered in `tools/ci/README.md` and by two new tests in `affected.test.ts` (device change; a
    kernel change still runs its dependents). RED: the plan returned 7 directories, including
    `apps/capybara`.
- **R6:** `check:test-portfolio` now checks a list of category lists.
  - The testing container list and the new device list share the overlap and missing-file rules.
  - New rule `test-portfolio-os-unlisted`: an unlisted `packages/device/test` file that names a
    real-OS marker. The markers are `startMacOperationWorker`, `createOsExecutor`,
    `runNativeHelper`, `ManagedOutputSpool`, `collectEnvironment` and a `pnpm pack` invocation.
  - Red fixture `tools/checks/fixtures/test-portfolio/device-os/` (missing, overlap, unlisted).
  - It runs in both modes (cheap), as stated in `tools/checks/README.md`, which also documents the
    blind spot: Docker, raw spawn and the fs helper script carry no marker and are listed by hand.
  - The check found `background-output.test.ts` (real macOS worker) unlisted; it is now listed.
- **R7:** `patchFor` matches an exact `name@version` patch key, then a bare `name` key. Another key
  for the same name (another version, a range) is refused with an actionable error.
  - Test in `runtime-bundle.test.ts`. RED: a bare key bundled the package without its notice.

Verification:
- `tools/ci`, `tools/checks` test-portfolio and the full device suite: 39 files, 689 passed,
  1 skipped (workers 2).
- `pnpm typecheck` clean, `pnpm check` passed (test-portfolio included), Biome clean.
