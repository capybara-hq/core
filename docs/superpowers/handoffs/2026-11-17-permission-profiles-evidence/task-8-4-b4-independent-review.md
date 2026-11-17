# Task 8.4 B4: independent review

Reviewed: `perm/t8-4-b4`, `git diff e6c338b31 124eb1f9b` (fe24223ec, f24188071, 124eb1f9b), read-only.
I formed the verdict from the code and read the author's report afterwards.

## Verdict: CHANGES_REQUIRED

The kernel half is sound: generation allocation, migration 0146, the awaiting-device → installed
state machine, the post-commit RPC sent outside transactions, the answer check, attestation only
from a bound hello, the consent semantics, and the jsonb roots fix. Three Important problems remain.
Two are on the device side and one sits between the kernel's binding chain and the device's:

1. The device binder can let two supervisors write the same journal, and it checks for unsettled
   older-generation work before a long await, not at the moment it swaps backends.
2. The binding chain can deadlock for good. The kernel's machine-scoped "previous" and the device's
   single global binding file disagree after a re-login or after a binding that was persisted but
   never installed.
3. The shipped manifest is computed at pack time against dependencies that are published as
   ranges. Field installs will drift from it, verification will fail closed every time, and the
   device will never bind.

Nothing is wired into production: `LocalInstanceBindings.bind` has no caller, `InstanceBinder`
is never constructed, `serveStagedSession` is a dormant export (client.ts:515) and protocol 2
stays active. So none of these hurts users today. They are still defects in this row's
deliverables (binder, chain, manifest producer) and should be fixed before the row is accepted
rather than carried into activation.

## Critical

None.

## Important

### I1. Binder: two supervisors on one journal, and the retirement check races the swap
`packages/device/src/exec/instance-binding.ts:160-180` with
`packages/device/src/exec/operation-supervisor.ts:183, 401-460`.

- The journal file is per device (`operation-journal-<digest(deviceId)>.json`), not per
  generation. `bind()` builds `candidate` (a second `MacOperationSupervisor` on the same file) at
  :160. It then computes `pending` from the candidate's snapshot plus `ownedTotal(this.bound)`, and
  only afterwards awaits `verify()` (hashing about 3k files plus node, python and shell; roughly 1 s
  by the author's measure) and `writeStored` (fsyncs). Only then does it swap at :180.
- The serial queue covers only `bind` and `recover`. Operations still reach `this.bound` (the old
  backend) through `staged-session.ts` while these awaits run. The old backend is never drained
  (`beginDrain`), never re-checked and never closed after the swap.
- **Failure scenario A (live work survives the check):** an exec or background start for the old
  generation that is already in flight, or arrives during the `verify()` await, is admitted by the
  old backend after `pending` was computed as 0. The swap still happens. The new generation is
  bound while old-generation work is live. That breaks the spec rule "A different binding/generation
  is refused while old live owners … remain" (spec B4 step 4), and the device must enforce it
  itself, without trusting the kernel.
- **Failure scenario B (journal regression):** every supervisor persists from its own in-memory
  `verifiedJournal` (operation-supervisor.ts:405-416). It writes rollback = its view and file = its
  view plus its change, and never re-reads the disk. Suppose the old supervisor persists after the
  candidate was constructed: a stop recorded as `already-exited`, `cancel-pending`/`revoked` from an
  in-flight `backgroundStop`, an output commit, or an `expireRetained` triggered by a tail. The
  candidate's next persist then writes its stale view, and that update is silently lost.
  `validateSuccessor` runs only on restart recovery and only between the last
  predecessor/successor pair, which are self-consistent, so a lost `revoked` tombstone is never
  detected. The reverse also happens: the old supervisor can overwrite the new one's entries.
- The author's concern ("two supervisors may read the same journal briefly") is therefore a real
  correctness bug, not a harmless read. The same problem appears in `recover()` → `enable()`, which
  builds a backend without checking `this.bound`, and in the same-generation path when
  `this.bound` holds another binding (:182-183 → `enable`). A refused candidate (pending > 0 or
  `verify` throws) is leaked. Its constructor may already have run `finalizeRecoveredOutput` and
  synced files.
- Spec order: "durably writes the bound identity before constructing/enabling that generation's
  supervisor". Here the supervisor is constructed before the write.
- **Fix:** keep one supervisor per journal and switch its admitted generation, or do the following
  in order: (1) `beginDrain()` on the old backend so it admits nothing more; (2) `verify()` and
  `writeStored()`; (3) after the last await, settle the old backend or recheck that its ownership is
  0, then build the candidate from the disk state and compute `retirementObligations()`;
  (4) swap; (5) dispose of the old supervisor so it can never persist again. Also refuse to
  construct a second supervisor while one is live in `recover`/`enable`.
  **Tests:** an old-generation start or stop that resolves during a deferred `verify()` must either
  block the bind or survive in the journal. After the swap, the old backend must refuse admission.

### I2. Binding chain liveness: kernel "previous" and device stored binding can diverge forever
Kernel `packages/kernel/src/sandbox/permission-instance-writes.ts:177-205` (previous = this
machine's last *installed* binding). Device `instance-binding.ts:58-69, 153-157` (one global
`instance-binding.json` in the shared `stateDir`; mismatch means refuse).

- **Re-login with a new machine credential, same device:** the kernel sends
  `expectedPreviousGeneration: null`, which is tested in "a new machine credential is never asked
  to confirm another machine's binding". The device still has the old stored binding: login does
  not clear it (`commands/login.ts`, `state.ts`). So :153 refuses every bind with "the kernel must
  reconcile", and nothing in the kernel reconciles. The kernel test and the device behaviour
  contradict each other, and no test crosses the two.
- **Login to a different device id with the same stateDir:** `readStored` throws "stored instance
  binding is invalid; repair the device state" (:64) on every bind. The device is permanently
  unbound.
- **Persisted but never installed:** the device writes G1 durably, then the reply is lost or
  `install` throws (instance replaced, machine changed, kernel crash after the deadline). If the
  instance is later replaced, `commitHandle` allocates G2 with previous = the last *installed*
  binding (G0 or null). The device has G1, so G2 and every later generation are refused. The spec
  says "Failure after persistence is recovered by the same request, never a new generation".
  `commitHandle` does not stop or reconcile while the current binding is `awaiting-device`.
- **Fix (one consistent rule on both sides), for example:**
  - Store the machine credential identity (and the device id) in `StoredBinding`, keyed per device
    like the journal.
  - A stored binding from another credential, or for another device, counts as "no previous" for
    the chain check. Retirement obligations still block, because they come from the journal.
  - The device accepts `expectedPreviousGeneration === stored.previousGeneration` when the stored
    generation was never acknowledged, which needs a kernel signal such as the kernel naming its
    last *sent* binding.
  - Alternatively, make `commitHandle` reconcile an `awaiting-device` binding before allocating a
    replacement.
  - Add a cross-side test: kernel `bind` → lost reply → replacement → device accepts. Add another:
    re-login → first bind succeeds.

### I3. The pack-time manifest cannot match field installs
`packages/device/package.json:46-52`, `packages/device/src/exec/runtime-manifest.ts:404-447,
574-584`, `packages/device/tools/runtime-manifest.ts`.

- The manifest pins the exact bytes of the whole runtime closure and of the helper closure as they
  sit in the monorepo at `prepack`. That includes `@capybara-hq/plugin-sdk`, reached through static
  imports, and `@anthropic-ai/sandbox-runtime`'s dependencies.
- The published dependencies are ranges: `"@capybara-hq/plugin-sdk": "workspace:^"` (published as
  `^…`), and sandbox-runtime's `zod ^3.25`, `commander ^12.1`, `node-forge ^1.4`,
  `@pondwader/socks5-server ^1.0.10`. `npm i -g @capybara-hq/device` resolves the newest version in
  range at install time.
- **Failure scenario:** any newer plugin-sdk rc or a zod patch changes a hashed file or a
  `meta/name@version` entry. `verifyInstalledRuntime` throws "Installed runtime differ … reinstall
  capybara-device" on every bind, and reinstalling reproduces it. Once wired, every field device is
  unbindable. This fails closed, so it is safe, but it is a complete liveness failure of the
  producer this row delivers.
- **Fix:**
  - Ship a lock for the closure: an `npm-shrinkwrap.json` in the published package,
    `bundleDependencies` for the runtime closure, or exact pins for plugin-sdk and sandbox-runtime's
    transitive dependencies.
  - Generate the manifest from that same resolution.
  - Add a test that packs the tarball, installs it into a scratch prefix with npm (not the
    workspace) and runs `verifyInstalledRuntime` against it.
- Also note that `prepack` runs `node tools/runtime-manifest.ts`. That needs Node type stripping
  (≥ 22.18 or 23.6), but `engines` says `>=22.12`, which matters for contributors on older Node.

## Minor

- **M1. TOCTOU between verification and launch:** `runtime-manifest.ts` verifies at bind time. The
  worker later loads `@anthropic-ai/sandbox-runtime` by path (`import(pathToFileURL(message.runtime))`)
  and its dependencies through Node resolution, with no pinning. Inline helpers are covered: they
  go through `stagePrivateSource` with its hash and owner checks.
  - Adversarial substitution needs the same uid, which already has full user power. The realistic
    case is an in-place `npm update` while the service runs: new runtime bytes would run under the
    old attested `runtimeHash`.
  - **Ruling:** acceptable for this staged row, because nothing is wired. It is an activation
    blocker, since the spec says "validate no substitution between verification and trusted
    staging/launch".
  - **Fix before activation:** stage the runtime closure privately (content-addressed, like
    `stagePrivateSource`) and launch from there, or re-check a dev/ino/size/mtime snapshot of the
    closure at each worker launch and refuse on drift.
- **M2. The environment fingerprint misses modules the helpers import:** `runtime-manifest.ts:491-497`
  imports `os,sys,json,stat,base64,errno,sysconfig`, but `native-files.py` also imports
  `urllib.parse` (`re` happens to be loaded through sysconfig). I checked on `/usr/bin/python3`:
  `urllib.parse` is not in `sys.modules` after the probe. A changed `urllib/parse.py` does not
  change `imageFingerprint`. **Fix:** derive the probe's import list from the shipped helper
  sources, or list `re, urllib.parse` explicitly, and add a test that every top-level import of
  each inline helper appears in the probe's `files`.
- **M3. The bind answer's `ownerCeiling` is dropped:** `instance-bindings.ts:129-209` parses and
  validates it, then never passes it to the owner-summary publisher, although spec B4 step 5 says
  it must. The author reports this and defers it to B2. It does not widen anything, because hello
  and policy frames still feed the summary. It needs a tracked follow-up.
- **M4. The legacy gate before bind is missing:** spec B4 step 4 says "The kernel's durable legacy
  gate is also checked before sending bind". The author defers it to 8.5 with the seam at
  `LocalInstanceBindings.bind`. Track it.
- **M5. Nothing asserts that the RPC runs outside a transaction:** `bind()`
  (`instance-bindings.ts:88-110`) relies on its caller holding no transaction. Only `install` is
  wrapped in `runOutsideTransaction`. A future caller inside `@Transactional` would hold a
  transaction across a 30 s RPC. Assert that no transaction is open at the start of `bind()`, or
  wrap the whole method.
- **M6. `readStored` errors are untyped:** `JSON.parse` at `instance-binding.ts:61` throws a raw
  `SyntaxError` on a corrupt file, unlike the typed `SandboxScopeDeniedError` used for the other
  corruption paths. The "corrupt binding" test passes only because it checks `toThrow()` with no
  type. Wrap it.
- **M7. Spec test gaps:** spec B4 requires "concurrent allocation and lost-commit reply" collision
  tests. The same-millisecond test runs two sequential `create()` calls with a mocked clock and no
  real concurrency, and there is no lost-commit-reply test: commit, lose the acknowledgment, then
  another holder reconciles the same committed binding without allocating.
- **M8. Retention:** `device_instance_bindings` gains one row per local instance generation and has
  no FK or cleanup. Rows outlive device and org deletion and grow with every inactivity-destroy and
  recreate cycle. This is intentional for non-reuse, but a later bounded cleanup should keep only
  the latest installed binding per (device, machine) plus anything still awaiting. The high-water
  table is one row per device, which is fine.
- **M9. The staged drain does not refuse `bindInstance`:** acknowledged by the author. Once I1 is
  fixed, check that a drained session cannot bind a new generation.

## Checked and sound

- **Generation allocation** (`permission-instance-writes.ts:59-75, 147-216`):
  - It computes `max(clock_timestamp ms, highWater+1)` under `ceilings.lock(device)` (a transaction
    lock) plus `FOR UPDATE` on the mark, and upserts it in the same `requires_new` transaction as
    `created_at`. It refuses inexact storage and range exhaustion (≤ 8.64e15, a safe integer).
  - `initialHighWater` runs only when no mark exists. It covers the instance row (`had_instance`),
    bindings, intents, background tasks and reports, and blocks on a non-numeric generation with
    nothing committed (tested).
  - Same millisecond, rollback and deleted row are covered: the mark outlives the row. I confirmed
    that existing writers of `instance_generation` (operation-intents, background store, report
    `record`) only write `String(created_at.getTime())`, so the active and cloud paths cannot hit
    `InconsistentGenerationError`.
  - The `sandbox.service.ts:2376` change correctly lets `commitHandle` own `created_at`.
- **Migration 0146:** `IF NOT EXISTS`, purely additive, follows the naming convention, and has
  `CHECK`s that match the SDK's `^[0-9]{1,16}$`, a uuid `binding_id UNIQUE` and PK
  (device, generation). Leaving out the FK is sound: the mark and the old bindings must outlive the
  instance and device rows so generations and binding ids are never reused. Only retention (M8) is
  open. `check:migrations` passed.
- **Kernel state machine** (`instance-bindings.ts`):
  - `awaiting-device` is committed with the row, and `installed` is set only by `install()` under
    the device writer, after checking the exact instance row (provider, `created_at` generation,
    handle id, live status), the binding id and the active machine id captured before the RPC.
  - The RPC is fenced to the captured connection. A delayed answer for a replaced generation, or a
    wrong binding id, is refused (tested). A retry of an installed binding sends nothing.
  - "Previous" is limited to bindings this machine installed (but see I2 for the device side).
- **Hello attestation:** an unbound hello, another generation, or a binding still
  `awaiting-device` attests nothing and clears the instance identity, so the report reads unprobed.
  `readRuntimeReport` for `@local` also requires the installed binding identity to equal the
  recorded one.
- **No re-consent loop:**
  - A changed identity advances the admission epoch, and resets Full consent only when
    `imageFingerprint` differs.
  - After the first mismatch, `record(undefined)` clears `permission_runtime_identity`, so repeated
    reconnects with the same changed identity do not reset again.
  - The first verified proof (previous null) does not reset (tested).
  - A replacement with a different fingerprint resets (tested). Machine replacement already resets
    through `revokeActive`, so first-bind-without-reset on a new machine is correct.
- **`displayedRoots`:** the first create on the roots the machine reported keeps consent, and other
  roots reset (tested). This matches the spec's "Initial Full consent and proof arrival" section.
- **jsonb roots fix** (`machines.ts:84-95, 296-310`):
  - It is correct. jsonb returns `{tmp, skills, workspace}`, ordered by key length, while hellos
    send `{workspace, skills, tmp}`, so before the fix every reconnect looked like a reach change
    and published with Full consent invalidated.
  - The comparison is shallow, which is enough for string-valued roots.
  - `recordHello` serves both v2 (`local-device-gateway.ts:263`) and v3. The regression is covered
    through the v3 test ("reconnect … consent and report kept", `toEqual(base)` on revision and
    full_revision with roots stored as jsonb), and machines.test.ts still passes.
  - A direct v2 `recordHello` test would be nicer but is not required, since it is the same code.
  - The policy comparison was already normalized by `localPolicyOf`.
- **Device binder (beyond I1):**
  - Binding happens only by request. It never moves to an older generation. Same generation with
    another binding id is a conflict. An identical retry is idempotent and re-verified.
  - The binding is written with write, rename and fsync of the file and directory before the swap.
  - `recover()` only works when the runtime is unchanged, and never reattaches a PID (old refs come
    back as `lost`).
  - Restart-uncertain obligations block even a far-future generation (tested).
- **Manifest canonical form:**
  - Tuple shape, code-point ordering, logical-name rules, hashing through `O_NOFOLLOW` handles with
    a post-read dev/ino/size check, symlinks refused inside package walks, refusal of missing,
    changed or extra files with the first difference reported, and fail-closed behaviour on an
    unenumerable dynamic import (the one known worker import is declared).
  - The generator hashes emitted JavaScript, not TypeScript.
- **SDK:**
  - `bindInstance` has strict keys, bounded identifiers (uuid binding id, ordered previous), and an
    answer parser tied to the exact request.
  - `gen:sdk-api` was regenerated (`check:sdk-api` passes) and the changeset bumps plugin-sdk.
  - The device imports only the SDK (`check:deps` passes).

## Verification (my runs, CAPYBARA_TEST_WORKERS=2, CAPYBARA_TEST_CONTAINER_STARTS=2)

| Run | Result |
|---|---|
| plugin-sdk device-protocol-v3 + device instance-binding, runtime-manifest, staged-session, server-ops-v3 | 5 files, 38 tests passed (10 / 7 / 10 / 8 / 3) |
| kernel local-devices/instance-bindings | 1 file, 9 tests passed |
| kernel machines, sandbox/permission-wiring, managed-output-transport, devices/mode | 4 files, 58 tests passed |
| check:migrations, check:deps, check:sdk-api, check:test-portfolio, check:kernel-conventions, check:plugin-pack | all passed (applied-migrations needs `--base`; not run) |

---

# Re-review round 1 (`git diff 124eb1f9b 527c6a3da`: cdf5abdf1, 527c6a3da)

## Verdict: CHANGES_REQUIRED (one new Important, introduced by the I2 chain change; everything else resolved or Minor)

## Original findings

- **I1, resolved.**
  - `switchTo` (`instance-binding.ts`) now does the following in order:
    1. `beginDrain()` on the old backend before `verify()`.
    2. Requires that the old backend owns nothing and that `retirementObligations(next)` is 0.
    3. Writes the binding durably.
    4. Re-checks after that last await, and writes the previous binding file back on failure.
    5. Disposes the old backend. `supervisor.close()` refuses while the supervisor owns work, and
       `persist()` and `checkHandle` refuse once it is closed.
    6. Builds the successor from the journal on disk.
  - Nothing awaits between the second check and `dispose`.
  - With no live backend, the candidate is the only supervisor and is disposed on refusal or on a
    write error.
  - `recover()` returns the live supervisor or nothing. `enable()` throws while a supervisor
    exists.
  - Persistence is synchronous, so two supervisors cannot interleave a persist.
  - Tombstones are kept: tested by an exact stop that lands during a held `verify()` and survives
    the successor's first write.
  - In-flight starts block the bind, and fresh starts are refused (tested).
  - A refused bind leaves the old generation draining. That is acceptable: the kernel has already
    replaced that instance.
- **I2, resolved, with N1 below and Minor R2.**
  - Bindings are stored per device id (`instance-binding-<sha256>.json`), with `deviceId` and a
    credential identity hash, never the secret.
  - The two-sided rule:
    - The kernel's previous is the last binding *committed* for the active machine.
    - The device refuses only when a stored binding of its own credential is newer than that
      previous (or the previous is null).
    - Generations never move backwards.
  - This is sound. The kernel commits before it sends, so for the same credential the kernel's
    previous is always at least the device's stored generation. A device that is behind (an
    undelivered commit) may skip ahead. The previous is only a consistency check: admission still
    depends on the journal's retirement obligations, which do not depend on credentials. So it
    widens nothing.
  - Cross-side tests drive the real binder and backend: a lost answer followed by a replacement, a
    re-login with the old file present, and two device ids in one directory.
- **I3, acceptable as implemented.** The judgment is below.
- **M2, resolved.** The probe imports the modules parsed from the shipped Python helper sources, so
  `urllib.parse` is now fingerprinted, and a test checks every helper import.
- **M5, resolved.** `bind()` refuses when a transaction is open (tested).
- **M6, resolved.** A corrupt file now raises a typed error (tested).
- **M7, resolved.** Three concurrent commits of one fence produce one generation, one mark and one
  binding. A lost commit reply is reconciled without allocating.
- **M8, resolved.**
  - Pruning runs in the commit transaction under the device lock. It keeps the new binding, the
    chain's previous, each machine's latest installed binding, and every generation with an owed
    intent (not completed, or revoked without acknowledgment) or a non-terminal managed task.
  - Retirement obligations never read binding rows. They live in intents, tasks and the device
    journal, and the high-water mark is a separate table. So pruning cannot lose anything
    retirement needs, and the owed-generation clause is extra caution.
- **M1:** recorded as an 8.6 activation blocker, which I agree with.
- **M3, M4, M9:** deferred and tracked.

## New Important

### N1. Full consent is not reset when the environment changes across an unconfirmed generation
- Location: `packages/kernel/src/local-devices/instance-bindings.ts:184-196`. The code is unchanged,
  but the I2 change made this path reachable.
- `install()` compares the answer's `imageFingerprint` only with the binding named by
  `expectedPreviousGeneration`, and only when that binding is `installed`. Since fix round 1, the
  previous is the last *committed* binding, which may never have been installed.
- **Failure scenario:**
  1. G1 is installed with fingerprint A.
  2. G2 is committed, and its answer is lost (G2 stays `awaiting-device`).
  3. The machine's Python or OS changes.
  4. G3 is committed with previous = G2 and binds with fingerprint B.
  5. The lookup finds no installed G2, so `publishLocked(..., true, true)` is never called.
  6. A bound hello then matches G3's own identity, so that path never resets either.
- Result: the Full consent given for environment A carries over to environment B. Spec B4
  ("a changed runtime environment … resets") and the handoff's consent rules require a reset.
- **Fix:** compare with the latest *installed* binding of this machine (or device) whose
  generation is older than the request. Pruning already keeps each machine's latest installed
  binding. Add a test: G1 installed with fingerprint A, lost answer on G2, G3 bound with
  fingerprint B, expect `full_revision + 1`. Add the converse too: same fingerprint, no reset.

## New Minor

- **R1. Kernel tests import device sources by relative path.** The imports are in
  `test/local-devices/instance-bindings.test.ts:485-488`, and
  `test/background/macos-device.test.ts` already does the same.
  - Strictly, AGENTS.md "Dependency direction" does not forbid this, because it is test code and
    `check:deps` only enforces the plugin/SDK boundary. That is why it passes.
  - It is an undeclared kernel → device edge, though. The CI plan (`tools/ci/src/affected.ts`)
    derives affected packages from package.json dependencies, so a PR that changes only
    `packages/device` will not run these kernel cross-side tests. They can go stale until the full
    run on main.
  - **Fix:** declare `"@capybara-hq/device": "workspace:*"` as a kernel devDependency and record
    the edge in docs/architecture.md, or move the cross-side tests into `packages/testing`.
- **R2. A machine can change between commit and bind.** `awaitDevice` records `machine_id = M1` at
  commit. If the owner logs in again as M2 before `bind()`, the RPC goes to M2 and `install()`
  overwrites `machine_id` to M2 only on success.
  - Failure scenario: if that answer is lost, the row keeps M1. M2's next commit sees previous =
    null, while the device has a stored M2-credential binding of that generation. The device then
    refuses "previous binding" until it is reconciled by hand.
  - **Fix:** refuse to bind when the committed binding's `machine_id` is not the active machine
    (that is, re-commit for the new machine), or set `machine_id` to the target before the RPC.
- **R3. Pack test and load.**
  - `runtime-manifest-pack.test.ts` runs `tsc -b` and `pnpm pack` inside the workspace, which
    creates `dist/node_modules` for a while. It also adds about 12 s of CPU-heavy work to the
    device project.
  - The two real-macOS timeouts at default workers (load average about 9.5) are pre-existing
    5-second waits. They pass alone and at 2 workers, and the pack test adds to the pressure.
  - AGENTS.md says flakes get fixed, not tolerated. Two follow-ups:
    - Run the pack test serially or in its own project (or after the device suite).
    - Open an issue to fix the wait conditions of `mac-operation-backend` "prepares a missing
      conversation subtree" and `operation-supervisor` "real registered cancellation", rather than
      raising timeouts.
  - Neither blocks this row.
- **R4. Packaging hygiene (part of the I3 judgment):**
  - Ship a modification notice for the patched Apache-2.0 `@anthropic-ai/sandbox-runtime`
    (Apache §4(b)). Today the vendored files carry no mark of the patch.
  - Make the generator refuse `optionalDependencies` or platform-specific packages instead of
    silently bundling whatever the release runner (Linux) resolved. The closure has none today.

## I3 judgment: is vendoring the closure acceptable?

Yes, for this package, with R4 as follow-ups. I packed it myself:

| What | Measured |
|---|---|
| Tarball | 8.5 MB |
| Unpacked | 39 MB, of which `dist/node_modules` is 37 MB |
| Largest packages | sandbox-runtime 11 MB (with its vendor binaries), plugin-sdk closure 9.2 MB, kysely 3.4 MB |
| Published `dependencies` | none (only devDependencies) |

- **Why not the alternatives:**
  - A shrinkwrap of registry tarballs cannot reproduce the workspace patch of sandbox-runtime.
    pnpm refuses `bundleDependencies` with the isolated linker.
  - A single-file bundle would not remove the bulk. The worker imports sandbox-runtime *by path*
    and needs its vendor binaries, and the patch has to apply to those files. The repository also
    has no bundler, so this would add a build tool. At most it would save the roughly 9 MB of the
    SDK closure.
  - Vendoring also fixes a latent bug: before this, npm users installed an **unpatched**
    sandbox-runtime from the registry, because pnpm patches only apply inside the workspace.
- **Licenses:** every package is copied whole, LICENSE files included (69 license files in the
  tree). Only the modification notice in R4 is missing.
- **Security updates and audit:**
  - Vendored dependencies are frozen per release, and `npm audit` on a user's install will not see
    them because they are not declared.
  - Advisories still reach maintainers through the workspace lockfile and Dependabot, since the
    same packages are devDependencies there. The remedy is a device re-release, as for any bundled
    CLI. Note this in docs/deploy/release.md.
- **Does the pack test prove an installed tarball verifies?** Yes, within its scope:
  - It uses `pnpm pack`, the same command the release uses (`plugin-tools release/publish.ts:342`),
    so prepack and postpack run.
  - It installs offline with npm into a clean prefix with an unreachable registry. That proves no
    dependency is fetched.
  - `verifyInstalledRuntime` succeeds on the installed tree, and one changed byte fails it.
  - It does not cover `npm i -g` or another platform or Node version. Bytes are
    platform-independent here, so that is acceptable.
  - I ran it: 3/3 passed, about 12 s, and `dist/node_modules` was cleaned up afterwards.

## Verification (CAPYBARA_TEST_WORKERS=2)

| Run | Result |
|---|---|
| device instance-binding, runtime-manifest, staged-session, server-ops-v3, operation-supervisor, mac-operation-backend | 6 files, 74 tests passed |
| device runtime-manifest-pack (run alone) | 3/3 passed |
| kernel instance-bindings + machines | 2 files, 30 tests passed (instance-bindings 16) |
| check:deps, check:test-portfolio, check:kernel-conventions, check:sdk-api | passed |
| Manual pack inspection | tarball 8.5 MB, no runtime dependencies, no optional dependencies in the closure |

---

# Re-review round 2 (`git diff 527c6a3da 6acde42d8`: e366658dc, 6acde42d8)

## Verdict: APPROVE (the remaining findings are Minor follow-ups)

## Round 1 findings

- **N1, resolved.**
  - `install()` now compares the answer's `imageFingerprint` with the device's latest *installed*
    binding whose generation is older than the request, whatever the chain's previous was.
  - The lookup is device-wide. That is correct: a machine replacement already resets Full consent
    through `revokeActive`.
  - Pruning keeps each machine's latest installed binding, so the device-wide latest installed
    binding always survives.
  - Both tests exist and pass:
    - Environment changed across an unconfirmed generation: `full_revision + 1`.
    - Same environment: no reset.
- **R2, resolved.**
  - When the committed binding's `machine_id` differs from the active machine, `bind()` calls
    `retarget()` before the RPC.
  - `retarget()` runs in its own transaction (through `runOutsideTransaction`) under the device
    writer. It updates only an `awaiting-device` row with the exact generation and binding id. It
    sets the active machine and that machine's latest strictly-older committed binding as the
    previous, and throws when the row changed.
  - `install()` still re-checks the machine after the RPC.
  - The cross-side test passes: re-login between commit and bind, answer lost, then the next
    generation binds.
- **R1, acceptable.**
  - The kernel declares `@capybara-hq/device: workspace:*` as a devDependency, and
    docs/architecture.md records it as a tests-only edge (which also covers the earlier
    `macos-device.test.ts`).
  - This is consistent with AGENTS.md: the forbidden edges are extension → kernel, device → anything
    but the SDK, and SDK/design/client → `@capybara-hq/*`. There is no cycle, because the device
    does not depend on the kernel. `check:deps` passes; its `device-imports-internal` rule covers
    only the device's own imports.
  - CI cost: `affected.ts` takes dependents transitively. A device-only PR now runs the kernel's
    tests and those of every kernel dependent (testing, plugin-tools, the CLI and so on), not just
    the two cross-side files. That is acceptable, and it is the honest consequence of a real test
    edge. See R5 for a cheaper variant.
- **R3, acceptable.**
  - The new `device-os` project reads a checked-in list (`packages/device/test/os-tests.json`).
    The `node` project excludes those files, so nothing runs twice.
  - The project has a category-level `testTimeout: 60_000` and `hookTimeout: 300_000`. That is the
    same kind of project-level bound as kernel-integration (60 s) and kernel-container (240 s/300 s),
    not a per-test override. `check:test-portfolio` forbids per-test overrides only, and passes.
  - `sequence.groupOrder: 1` runs the project after the parallel projects. CI runs vitest by
    directory filter without `--project`, so these tests still run in CI.
  - Leaving it out of `verify --fast` is consistent: `--fast` never ran the device tests (it runs
    kernel-unit, design and plugin-client only).
  - The gap is that the list is not enforced by a check the way the other lists are (R6).
- **R4, resolved.**
  - The bundler writes `CAPYBARA-MODIFICATIONS.md` and copies the exact patch beside the vendored
    package's own LICENSE. This happens before the manifest is generated, so both files are
    attested.
  - It refuses packages with `optionalDependencies` or with `os`, `cpu` or `libc` fields
    (`runtime-bundle.test.ts`).
  - The pack test checks that the installed package carries the notice and the patch.
  - docs/deploy/release.md documents the frozen bundle, the audit blind spot, and that a Dependabot
    alert means a device re-release.

## New Minor (none blocking)

- **R5. CI breadth.** The tests-only kernel → device edge pulls in kernel's dependents too.
  - Option: an `EXTRA_INPUTS`-style rule in `tools/ci/src/affected.ts` that maps `packages/device/**`
    to `packages/kernel` only, instead of a package.json edge that is followed transitively.
  - Keep the devDependency either way, for documentation and pnpm linking.
- **R6. `os-tests.json` is not checked.**
  - Extend `check:test-portfolio` with the overlap and missing-file rules that `container-tests.json`
    already has. Today a stale or misspelled entry is silently ignored.
  - Ideally add an "unlisted" marker rule too, for example a device test that spawns `sandbox-exec`,
    `python3` or `pnpm pack` must be listed.
  - List it in tools/checks/README.md.
- **R7. Patch-key parsing in `workspacePatches`** (`tools/runtime-manifest.ts`).
  - It matches only `name@version` keys. A versionless `patchedDependencies` key (pnpm allows
    `name: path`) would bundle a patched package without the notice, silently.
  - Fix: refuse when a bundled package matches a patched name but not the key, or parse both forms.

## Verification (CAPYBARA_TEST_WORKERS=2)

| Run | Result |
|---|---|
| kernel instance-bindings, background/macos-device, device runtime-bundle, device instance-binding, tools/ci | 5 files, 102 tests passed |
| `--project device-os` | 12 files, 231 passed, 1 skipped (45.7 s; `dist/node_modules` cleaned up afterwards) |
| check:deps, check:test-portfolio | passed |
