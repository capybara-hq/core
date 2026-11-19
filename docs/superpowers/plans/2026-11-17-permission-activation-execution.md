# Permission activation execution plan (Phase 8.6)

Status: execution plan, not yet reviewed. It schedules the work that
[Phase 8.6 of the cutover plan](2026-11-16-permission-runtime-cutover.md#phase-86--atomic-paired-activation-and-legacy-surface-removal)
requires, starting with every activation blocker that is still open. Phase 8.6 stays the authority; this file only orders
the work and assigns owners. Binding: primary branch `docs/conversation-permission-profiles` at `7f92d2a2f`
(accepted 8.1–8.5, 9.2–9.5, 10A–E, 2b). Inputs: the cutover design, the context-replay plan (Gate 9.6), delivery
Tasks 14–15, the 2026-11-17 handoff, and the SDD ledger with its reports and reviews in
`.superpowers/sdd/2026-11-16-permission-profile-delivery/`. Every "open" claim below was checked against the code at
`7f92d2a2f`. Line numbers are as of that commit.

Standing rules for every task: write a RED test first and confirm it fails for the intended reason; run tests with
`CAPYBARA_TEST_WORKERS=2` and `--maxWorkers=2`, in small batches, with Docker suites one at a time. Each task runs in its
own worktree (`pnpm wt:new <branch> --from origin/docs/conversation-permission-profiles`). Tasks that touch a trust
boundary, a migration or a multi-replica race (marked **TB**, **MIG** or **MR**) are reviewed alone by the most capable
model. Fix rounds continue until APPROVE. The controller then merges into the primary branch, runs
typecheck/check/unit plus the affected suites, pushes, and records the result in the ledger.

## 1. Open activation blockers (confirmed at 7f92d2a2f)

| # | Source | Still open: where | Acceptance test (RED first) |
|---|---|---|---|
| B-1 | 8.1 review M8 | `local-device-provider.ts:416-421` sends `killAll`/`killTagged`, and revocation sends v2 `stop` through `relay`. The staged gateway's `drainOnce` (`local-device-gateway.ts:449-500`) answers these untagged v2 frames with "connection changed" and never delivers them. | On a staged connection, machine stop and revocation reach the device as v3 frames (`stop`, `revokeOperation`). No `killAll`/`killTagged` frame is ever queued for a v3 device, and a test asserts the device receives each one. |
| B-2 | 8.1 rereview N1 | `packages/device/src/staged-session.ts:177`: held answers in `state.pending` expire only when the next socket becomes ready. There is no sweep and no cap. | A device that never reconnects keeps no more than a fixed number of held answers (cap test), and expired entries are swept on insert (fake-clock test). |
| B-3 | 8.1 rereview N2 | `StagedSessionState` is not bound to a credential (`staged-session.ts:20-31`). | Production keeps one state per credential or machine identity. A credential change discards the old state, and a test shows no held answer crosses credentials. |
| B-4 | 8.1 fix report concern 3 | `createStagedSessionState({graceMs})` defaults to 0 (`staged-session.ts:127`). | Production wiring passes `cred.reconnectGraceSeconds*1000`, and a test shows an answer held across a reconnect inside the grace. |
| B-5 | 8.1 fix report concern 1 | A queued non-read request on a changed connection is refused (`relay.ts:63`), but the held-operation path may still record it as outcome-unknown. | A request refused as not sent is recorded as a definite pre-effect failure. Test: a retry carries the same operation ID with no `outcome_unknown`. |
| B-6 | 8.4a/I3, ledger | B3 lacks two pieces of evidence: revocation across a disconnect and reconnect on the real staged session, and an end-to-end path from the platform writer through the outbox and worker to an exact device stop. | Dual test: two real tasks; one is revoked while the device is disconnected, delivered on reconnect, and stopped exactly; the sibling keeps its grant. A platform Full-off write goes `PermissionCeilingWrites` → outbox → revoke worker → exact `backgroundStop`, with duplicate delivery and stop-before-start covered. |
| B-7 | 8.4 B4 review M1 | `operation-worker.ts:110,385` loads `@anthropic-ai/sandbox-runtime` through Node resolution after `runtime-manifest.ts` has verified it at bind. Nothing pins the files between verification and launch (TOCTOU). | Changing a byte in the closure after bind makes the next worker launch refuse with a typed unsupported error. Preferred fix: launch from a private, content-addressed staged copy, the way `stagePrivateSource` already works. |
| B-8 | 8.4 B4 report / ledger | `LocalInstanceBindings.bind` has no production caller: `sandbox.service.ts` never binds before downgrade. The 8.5 legacy gate is not checked before bind (B4 review M4). | Under the exclusive lease: create → commit → legacy gate → `bindInstance` → installed → downgrade. A device with an open legacy obligation gets no bind and no admission. A lost bind reply is retried with the same `bindingId`. |
| B-9 | 8.4 B4 review M9 | `REFUSED_WHILE_DRAINING = new Set(["create"])` (`staged-session.ts:55`) lets `bindInstance` through during a drain. | `bindInstance` gets a typed refusal while draining. Status, read, tail, stop and recovery of admitted IDs still pass. |
| B-10 | 8.4 B1 report item 1 | `CloudPermissionSnapshots.snapshot` has no production driver: only `reconcileDevice` is wired, in `runtime/maintenance.ts:113` and `sandbox/jobs.ts:106`. | An operator command snapshots every cloud device under the cutover barrier. It is idempotent: a rerun publishes nothing. A narrowing snapshot resets Full consent and revokes affected intents (the existing fix-round tests). A crash mid-run resumes without double publication. |
| B-11 | 8.4 B1 review M1 | The `device.permission_reconcile_required` check runs only in `SandboxOperationAuthority`/`permission-facts.ts`. The `SandboxService` acquire paths (raw exec/files, preparation at `:1030`, browse at `:1085-1096`) do not check it. | Each acquire path refuses a device that carries the marker, with zero provider calls. This must land before B-10 runs anywhere. |
| B-12 | 8.4 B1 review M3 | There is no comparison against the provider's outer restrictions, no "Full unavailable when the provider cannot enforce the outer boundary", and the only reconcile path is a file reset. | A provider whose outer network is narrower than the snapshot keeps the narrower one (intersection). A provider that cannot enforce the boundary reads Full as unsupported. A provider update re-reconciles under the lifecycle lease, with no widening. |
| B-13 | 8.4 B1 report item 5 | `org.auto_mode_not_allowed`, `deployment.auto_mode_not_allowed` and `device.auto_mode_not_allowed` remain (`errors.ts:39,43,383`; `common.ts:671`; `identity/settings.ts`; `orgs/settings.service.ts`; `platform/ops/{org-settings,admin}.ops.ts`). | Renamed to `*.full_access_not_allowed` everywhere, with zh/en copy. `check:i18n`, `check:platform-ops` and the parity test are green. No old code string remains in `src`. |
| B-14 | 8.4 B2 M6 | `packages/device/src/state.ts:96-103`: `DEFAULT_POLICY.ownerCeiling` is still Full (`FULL_OWNER_CEILING`). | A new setup writes `{fullAccess:false, restrictedProjectReach:"workspace"}`, and the login copy says how to widen. An existing v1 policy still converts with the exact mapping. |
| B-15 | 9.3 M1 / 9.4 I2 | `permission-facts.ts:573` returns null for every cloud device, and `PermissionRuntimeReports.record` is called only for local devices (`machines.ts`, `instance-bindings.ts`). As a result, with the gate on, every cloud managed call fails `ManagedDeviceContextUnavailable`. | See Q1. Option A: after create or resume under the lifecycle lease, a cloud instance records the provider's `permissionSupport` plus a kernel-built identity (provider plugin and version, handle, instance generation, recorded applied limits). The context then reads `supported` and admission admits. A changed provider version or applied limits makes it `unprobed`. Rename the 9.3 M3 test, or make it discriminate between the two cases. |
| B-16 | 9.3 M2 / 9.4 concern 3 | `operation-authority.ts:349` `snapshot()` does not call `readAppliedEnvironmentLocked`, which only `readContextLocked` uses (`:706`). | Admission refuses exactly when the context would say "unprobed / unproved environment". A table test over local and cloud × applied, desired-but-unapplied and stale shows identical verdicts from the context and from admission. |
| B-17 | 9.4 I1 remainder | Only `inSandboxOperations` uses the managed writer, and only the never-called `runInBackgroundManaged` (`bash.ts:474`) reaches it. Read, Write, Edit, Glob, Grep, Deliver, foreground Bash, background Bash and skill-load all still call legacy `inSandbox` (`read.ts:115`, `grep.ts:204`, `deliver.ts:147`, `glob.ts:89`, `edit.ts:100`, `bash.ts:297,691`, `write.ts:83`, `skill-load.ts:684`). | With the gate on, every builtin records a marked `device_paths` entry through the managed writer before the callback. The legacy route refuses (the existing I1 test). The zero-drift group is unchanged with the gate off. |
| B-18 | 9.4 M3 | `common.ts:835-838`: `reviewed ?? evidence.workingRoot`. | When the reviewed working root differs from the evidence's root, the call fails as stale before the callback. |
| B-19 | 9.4 M4 | `managed-device-context.ts:255` checks the actor's identity but not whether the actor is still an active member. | A removed member's run fails no-send with the same predicate as `readContextLocked`. |
| B-20 | 9.4 review, concern 4 | There is no gate-on end-to-end test of an anonymous channel run. | After activation, a guest-account channel run gets an ordinary reply whose context is `availability: unavailable / no-device`. A note records that narrowing an agent from org to members makes existing anonymous threads fail with the actor error, which is intended. |
| B-21 | ledger (Task 12 M6 follow-up) | `plugin-sdk/src/sandbox-linux-runtime-source.ts` sets `PR_SET_NO_NEW_PRIVS`, `CHILD_SUBREAPER` and `PDEATHSIG`, but never makes the launcher or broker non-dumpable. Without Yama, a Full process running under the same uid can ptrace them. | Linux Docker conformance case: a same-uid process gets `EPERM` from `ptrace(PTRACE_ATTACH)` and from reading `/proc/<launcher>/mem`. Use `prctl(PR_SET_DUMPABLE, 0)` in the launcher and broker, after every point that needs `/proc/self` access. macOS: record that same-uid task ports are covered by Task 14 M5, not by this fix. |
| B-22 | 8.5 report / review | A suspended cloud instance with a revoked managed start is destroyed whole (`sandbox.service.ts` retirement path near `:2159-2196`), so its siblings end up lost. | Under the exclusive lease: resume, exact-cancel the revoked ref with confirmation, then downgrade. The sibling task survives. A failed cancel keeps the obligation and falls back to the existing destroy. |
| B-23 | 10E report/review | The device view does not expose `permission_reconcile_required`, the outer or resulting network, or the effective (not raw) `owner_full_access`. The reconcile code is overloaded for "not migrated". `MODE_CHANGE_ACTIONS` (`devices.service.ts:1558`) lacks `device.owner_ceiling_changed`, and the web has no label for it. | View schema test for each new field. The new error code `device.permission_not_migrated` is distinct from `permission_reconcile_required`. A cloud ceiling change appears in recent changes with from/to values, and the web shows its label (zh/en). |
| B-24 | 10E report item 8 | The local narrowing from the web sends protocol 2 `mode:"sandbox"`, and it is the kernel's only narrowing path. `DevicePolicyService` already accepts `change.ownerCeiling` (`device-policy.service.ts:214`). | The narrowing sends a v3 `policy` op carrying an `ownerCeiling` narrowing, and the result is recorded with its `connectionId`. The narrowing never widens. |
| B-25 | 8.4 B4 / ledger | Production wiring is missing: device `commands/start.ts:102-112` still constructs `PolicyStore`, the old executors and the v2 client. The gateway records only the v2 `recordHello`/`recordPolicy` (`local-device-gateway.ts:262,279`), so `recordHelloV3`/`recordPolicyV3` (`machines.ts:415,542`) have no caller and no `connectionId`. `DevicePolicyService` sends the v3 shape only through a dormant path. | Covered by W3-M and W3-N and proven by the W6 protocol integration suite. |
| B-26 | 8.5 report concern 4 | The legacy freeze and `report()` have no operator surface. Old unfenced replicas are not detected. | Covered by W2-I (CLI) and the runbook in section 4. |
| B-27 | new finding | A device on a platform other than macOS reports `fullAccess:false, background:false` (`mac-operation-backend.ts:383-390`). After activation (no raw fallback), local Linux and local Docker devices cannot run anything. In production, `restrictedSupported` is never set to true for macOS either (`mac-operation-backend.ts:81`). | macOS: W3-M decides `restrictedSupported` from a verified manifest plus a worker self-check at bind, and tests both outcomes. Linux and local Docker: see Q2. |
| B-28 | new finding | 17 kernel test files use the v2 `test/local-devices/fake-machine.ts` (local-devices 7, tools 4, devices 2, sandbox 2, evals 1, schedules 1). | W3-R provides a v3 fake machine and moves these tests to it while dormant, so the activation commit only flips a constant in the tests. |
| B-29 | 8.5 / B1 runbook | Step 1 of the cutover order is to ship the boot-reporting device build and wait for `localWithoutBoot`/`cloudUnknown` to empty. Boot-ID reporting exists only on the primary branch (not released), and B1's settings writes are not fenced against old replicas. | Release R1 (section 5) ships the dormant tree on protocol 2 before activation. The runbook stops every old replica before the first new one starts. |

Non-blocking residuals carried into the PR notes and Task 14, not into this plan: 8.3 M8 (partial prefix on abort at tiny
capacities), 8.3 M1 residual (a dead retry dispatcher stays dispatching until expiry), suspended owed stops counting
against `maxTasks`, B1 M4 (the converter does not handle properties-format Nacos documents or YAML aliases/merge keys;
this is documented), Task 12 M5 (Full shares the device uid), confirming the kernel never leaks execution UUIDs, the
zero-drift test that failed once under load (`reconstruct.test.ts` "clamped output cap"), the load timing of
`sandbox-native-helper`, and the `/dev/ui` catalog's old badges.

## 2. Activation scope (Phase 8.6 itself)

- **SDK:** promote the staged v3 codecs into `device-protocol.ts`. `DEVICE_PROTOCOL_VERSION = 3`, and the canonical
  names drop the `V3` suffix. Delete `device-protocol-v3.ts`, `STAGED_DEVICE_PROTOCOL_VERSION`, the "Development
  staging" export block in `index.ts:15-38` and the sentinel comment. Remove `killTagged`/`killAll`, raw exec/files and
  the background-comment exports from `DeviceOp`. Then run `pnpm gen:sdk-api` and add a changeset.
  `sandbox@2` provider signatures stay as they are (operation contract spec §Public SDK). The kernel simply stops
  calling `killAll`/`killTagged` to cancel user work.
- **Paired switch, in one commit:** the kernel HTTP header gate (`device-routes.ts:10`, `DEVICE_PROTOCOL_HEADER`), the
  WebSocket hello gate (`accept` becomes today's `acceptStaged` path), the device hello, header and client dispatcher,
  and the provider registration with operations (`local-devices.module.ts:57` registers the `stagedOperations`
  transport). The kernel rejects v2, malformed frames and any mismatch between header and hello. It sets
  `PERMISSION_CONTEXT_ACTIVATION` to true by default (`overrides.ts:101`) and applies `DEFAULT_POLICY {false,
  workspace}` on the device.
- **Legacy removal, every caller replaced:** shell comment exemption, SID stdout and control files (`background/*`), the
  last-exec write window (`device exec/switch.ts`), the startup environment-marker reaper (`exec/reap.ts`,
  `exec/procs.ts`, `exec/os.ts`), raw user exec/files (`SandboxService.withSandbox`, `common.ts` legacy writer), broad
  `killTagged`/`killAll` (`sandbox.service.ts:1786-1896,2432,2690,2961`; `server-ops.ts:529-533`), default-mode
  operation selection (`sandbox/modes.ts`, device `commands/mode.ts`), and the old public permission inputs (B1:
  `devices.autoMode`, `devicesAutoMode`, org `autoMode`; the parser now rejects them with a conversion message). Callers
  outside the tools: `background/{session,tasks.service}.ts`, `runtime/project/knowledge.service.ts`,
  `sandbox/sandbox-file-reader.ts`, `skills/invoke.ts`, `devices/{device-projects.service,conversation-devices}.ts`.
- **Production wiring:** the `commands/start` binder, a backend per bound generation, `DevicePolicyService` sending v3,
  and the gateway passing `connectionId` to `recordHelloV3`/`recordPolicyV3`.

## 3. Waves

Concurrency: never more than three implementers at once. A wave is closed only when all of its tasks are accepted and
merged. Files listed in one wave are owned by exactly one task in that wave.

### W0 — baseline and decisions (controller, no implementer)

1. Merge `origin/main` into the primary branch (it brings SDK rc.28, testing rc.22 and #339). Resolve conflicts against
   both sides, then run typecheck, check, unit and the full kernel suite once with `CAPYBARA_TEST_WORKERS=2`.
2. Record the zero-drift baseline:
   `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts --maxWorkers=2`.
3. Obtain the maintainer's answers to Q1–Q3 (section 6), then add the wave table to the ledger.

### W1 — dormant blockers (gate off, protocol 2 live)

| Task | Owns | Risk | RED-first gates | Verify |
|---|---|---|---|---|
| **A** staged session hygiene (B-2, B-3 API, B-4 API, B-9) | `packages/device/src/staged-session.ts`, `packages/device/test/staged-session*.test.ts` | TB (drain/bind) | cap/sweep; state keyed by credential; `graceMs` required (no default); `bindInstance` refused while draining, reads still served | `pnpm exec vitest run packages/device/test --maxWorkers=2` |
| **B** runtime closure pinning (B-7) | `packages/device/src/exec/{runtime-manifest,operation-worker,runtime-source}.ts`, `packages/device/tools/runtime-manifest.ts`, their tests | TB | a byte changed after bind leads to a refused launch; a replaced file or symlink leads to a refused launch; same bytes still launch | device suite + pack test (`runtime-manifest`) |
| **C** non-dumpable Linux launcher (B-21) | `packages/plugin-sdk/src/sandbox-linux-runtime-source.ts`, `packages/testing/src/**` conformance case, changeset (sdk, testing) | TB | Docker aarch64: ptrace attach and `/proc/<pid>/mem` refused for a same-uid Full process (fails on base); existing 19+1 cases unchanged | `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1` conformance on local Docker (sequential); x86_64 evidence on CI later |
| **D** admission/context agreement (B-16, B-19, 9.3 M3 rename, 9.4 M5 variants) | `packages/kernel/src/sandbox/{operation-authority,managed-device-context}.ts`, `test/runtime/permission-context-recorder.test.ts`, `test/sandbox/managed-device-context.test.ts`, `test/sandbox/operation-authority*.test.ts` | TB | table test (context vs admission verdicts); inactive member refused no-send; binding replaced between `heldContextEvidence` and `record` | the 9.6 command + `test/sandbox` authority files |
| **E** SandboxService gates (B-8, B-11) | `packages/kernel/src/sandbox/sandbox.service.ts`, `packages/kernel/src/local-devices/instance-bindings.ts`, `test/sandbox/sandbox.service*.test.ts`, `test/local-devices/instance-bindings.test.ts` | TB+MR | the marker refuses raw, preparation and browse acquires with zero provider calls; bind before downgrade through the staged transport fake; legacy obligation means no bind; lost reply retried with the same `bindingId`; two replicas lead to one binding | sandbox + local-devices suites, `operation-scopes.dual`, `protocol-upgrade` |
| **F** device view and audit (B-23) | `packages/kernel/src/devices/devices.service.ts` (view and `MODE_CHANGE_ACTIONS` only), devices schemas/DTO, `packages/kernel/src/errors.ts` (new code only), `apps/web/src/**` device components and `lib/devices.ts`, `apps/web/messages/{en,zh}.json` | normal (web can't widen) | view fields; distinct not-migrated code; audit row kind for the ceiling change; web label | devices tests, `apps/web/test/devices*.test.tsx`, `pnpm check:web-ui`, `check:i18n`, `check:platform-ops` |

Review: A, B, C, D and E are each reviewed alone (opus). F is reviewed by opus in a batch.

### W2 — cloud evidence, B3 proof, cutover tooling

| Task | Owns | Risk | RED-first gates | Verify |
|---|---|---|---|---|
| **H1** cloud installed evidence (B-15, Q1 option A) | `sandbox/permission-runtime-reports.ts`, `sandbox/permission-facts.ts`, `sandbox/sandbox.service.ts` (record after create/resume, cloud `contextEvidence`), tests | TB+MR | after a fake-cloud create, the context is supported and a managed call records; a changed provider version or applied limits makes it unprobed; a suspended instance stays readable without resume; no probe from readers | `test/sandbox`, `test/runtime/permission-context*.test.ts`, `managed-device-context` |
| **G** B3 evidence (B-6, B-5) | new `test/background/revocation-reconnect.dual.test.ts` (added to `container-tests.json`), new `test/sandbox/platform-revocation-e2e.test.ts`; fixes limited to `sandbox/{operation-reconcile.job,permission-ceiling-writes,held-operations}.ts`, `local-devices/relay.ts` | MR | the B-6 scenarios; refused-not-sent is never `outcome_unknown` | the new files + `permission-lifetime.dual` |
| **S** Linux and local-Docker operation backend (B-27, maintainer Q2) | new `packages/device/src/exec/linux-operation-backend.ts` (+ worker/supervisor glue it needs, coordinated after W1-B), the local Docker device backend in `packages/device/src/exec/docker*.ts` only where it hosts operations, their tests (Linux tests run in the hardened Docker harness from 2b) | TB | parity with the macOS backend: native ops, restricted exec via the 2b launcher with the same pinned roots, Full without restricted filters, background start/status/tail/readOutput/stop with exact cancellation and supervisor-loss cleanup; probe fails closed on unsupported kernels/ABIs; aarch64 locally, x86_64 on CI with the REQUIRE switch | device suite, the 2b conformance against the backend, Docker suites sequential |
| **I** cutover operator surface (B-10, B-26) | new `apps/capybara/src/commands/permissions.ts` (`cutover report`, `cutover freeze`, `cutover snapshot`), `sandbox/cloud-permission-snapshot.ts` (driver only), `sandbox/legacy-retirement.ts` (freeze runs `scanUntilStable` before returning, report shape), `.agents/skills/writing-sandbox-providers/SKILL.md` runbook section | MIG+MR | the snapshot driver refuses when admission is open (no freeze) or the replica is not current; rerun is a no-op; resume after a crash; freeze then use without a scan is refused; the CLI works without Redis (`openKernelCliOverPool`) | `test/sandbox/cloud-permission-snapshot*.test.ts`, `test/background/protocol-upgrade.test.ts`, `apps/capybara` tests |

All four are reviewed alone (S by the most capable model). **Release R1** follows W2 (section 5).

### W3 — activation preparation (gate still off; each new path selected only by the single gate or protocol constant)

| Task | Owns | Risk | RED-first gates | Verify |
|---|---|---|---|---|
| **K** builtin route migration (B-17, B-18, B-13 tool mapping) | `tools/builtins/sandbox/*.ts`, `tools/builtins/skill-load.ts`, `tools/builtins/builtin-tools.ts`, `tools/tools.module.ts` | TB | with the gate on, each builtin goes through the managed writer before the callback (per-tool test); legacy refused; reviewed root ≠ evidence leads to stale; gate off: zero-drift byte equality | zero-drift group, `test/tools/sandbox/*`, `managed-device-context`, `permission-context-requests` |
| **L** non-tool callers (prep for removing raw use) | `background/{session,tasks.service}.ts`, `runtime/project/knowledge.service.ts`, `sandbox/sandbox-file-reader.ts`, `skills/invoke.ts`, `devices/{device-projects.service,conversation-devices}.ts` | TB | with the gate on: project browse uses the owner `browse`; skill and attachment staging uses `prepare` (never model-selectable); knowledge reads go through operations; zero raw `withSandbox` calls (spy) | `test/background`, `test/devices`, `test/skills`, `test/runtime/project` |
| **H2** cloud outer limits and resume cancel (B-12, B-22) | `sandbox/sandbox.service.ts`, `sandbox/cloud-permission-snapshot.ts`, `sandbox/legacy-retirement.ts` | TB+MR | intersection with a stricter provider boundary; Full unsupported when the boundary can't be enforced; a provider update re-reconciles; suspended revoked start leads to exact cancel and a surviving sibling; failed cancel falls back to destroy | sandbox suites, `mode-limits.dual`, `protocol-upgrade` |
| **M** device production wiring (B-3, B-4, B-25 device side, B-27 macOS) | `packages/device/src/{cli,client}.ts`, `commands/{start,drain,stop}.ts` | TB | start constructs the binder and one backend per bound generation; one session state per credential with `graceMs` from the credential; drain waits for owned work; machine stop cancels exact owners; `restrictedSupported` true only after a verified manifest plus worker self-check; the v3 path is selected only by the protocol constant | device suite (mac), `capybara-device` start/drain tests |
| **N** kernel production wiring (B-1, B-24, B-25 kernel side) | `local-devices/{local-device-gateway,relay,local-device-provider,device-policy.service,machines,local-devices.module}.ts`, `devices/devices.service.ts` (local narrowing only) | TB+MR | staged hello and policy recorded through `recordHelloV3`/`recordPolicyV3` with `connectionId`; machine stop and revocation reach a v3 device; no `killAll`/`killTagged` queued for v3; local narrowing goes as a v3 `ownerCeiling` op | local-devices suites, `local-device-gateway.dual` |
| **R** v3 test fixtures (B-28) | new `test/local-devices/fake-machine-v3.ts`, the 17 test files that use `fake-machine.ts`, `packages/testing/src/**` device fakes if any | normal | each moved test passes against `acceptStaged` | the affected files |

Each W3 task is reviewed alone, except R (batched).

### W4 — atomic paired activation (one implementer, one branch, serial)

**Task O** owns the SDK device protocol (`device-protocol.ts`, delete `device-protocol-v3.ts`, `index.ts`,
`api/plugin-sdk.api.md`), `local-devices/device-routes.ts`, the gateway's `accept`, provider registration, `overrides.ts`
(gate default), device `client.ts` header/hello and `state.ts` (`DEFAULT_POLICY`, B-14), `commands/login.ts` copy,
and the flip of the protocol constant in the W3-R fixtures. Changesets: plugin-sdk, kernel, device, testing.
RED-first: a v2 header is rejected; a v2 hello is rejected; a header/hello mismatch is rejected; a malformed frame is
rejected; a gateway → device round trip through each operation (including `backgroundReadOutput` above 65 KiB); a new
install sets the default ceiling. Then: `pnpm gen:sdk-api && pnpm check:sdk-api && pnpm check:sdk-api-changeset`,
`pnpm typecheck`, `pnpm check`. Review: activation alone (opus).

### W5 — legacy surface removal (parallel, disjoint; on top of O)

| Task | Owns | Risk | Gates |
|---|---|---|---|
| **P1** device legacy | `packages/device/src/exec/{switch,os,reap,procs,host,docker,sandbox-messages}.ts`, `server-ops.ts` legacy dispatch, `commands/{mode,policy}.ts`, `args.ts`, `policy-store.ts` last-good behavior | TB | a test per removed op shows it is refused as unknown; startup runs no marker reaper; `capybara-device ceiling` stays; the docker backend follows Q2 |
| **P2** kernel background legacy | `background/{launch,session,status,stop,poll.job,tasks.service,store}.ts`, `db/kernel-schema.ts` type narrowing only (no migration that drops columns: expand-only) | TB+MR | no SID script is built; legacy rows are still handled by `retire-legacy-tasks.job.ts`; poll, stop and output use exact refs only |
| **P3a** kernel exec and kill legacy | `sandbox/sandbox.service.ts` (raw `withSandbox`, `killAll`/`killTagged` takeover, SID cleanup on resume and rebuild), `sandbox/modes.ts`, `tools/builtins/sandbox/common.ts` (legacy writer), `sandbox/review/*` comment exemption | TB+MR | crashed holder: exact revoke, no broad kill; resume: no `killAll`; default-mode selection gone; no reference to the removed exports |
| **P3b** old public inputs (B-13) | `config/schema.ts`, `identity/settings.ts`, `orgs/settings.service.ts`, `platform/ops/{admin,org-settings}.ops.ts`, `errors.ts`, `apps/web/messages`, `docs/config.md` (regenerated) | MIG | the old env/file/Nacos keys are rejected with the conversion message; the old stored keys go through the publication conversion; renamed codes; `check:config-docs`, `check:platform-ops`, parity test |

Each W5 task is reviewed alone. Exports become obsolete only once a grep finds no reference to them.

### W6 — integrated verification (controller and reviewers)

1. **Task Q** (gate-on end-to-end, B-20 and the cross-path smoke test): add `test/runtime/permission-activation.test.ts`.
   It covers an anonymous guest channel run, a local staged device and a fake-cloud managed call; each records a v1
   context and produces a reply.
2. Run, sequentially with 2 workers: the 9.6 group (zero-drift, run-replay, permission-context, dual); local-devices
   and gateway dual; background, tools, sandbox and dual suites; device and SDK v3; and the web.
3. Two separate opus reviews on the final revision: (a) activation and protocol; (b) lifecycle and revocation.
4. `CAPYBARA_TEST_WORKERS=2 pnpm verify` on the primary branch (use 4 only when the machine is idle). Update
   `.agents/skills/replay-evals/SKILL.md` (9.6), the sandbox, extension and device skills, and replace the "PLATFORM
   HELD" wording in the final doc pass.

## 4. Cutover runbook (production order)

1. Release R1 (protocol 2, dormant). Operators upgrade the kernel and the devices. Stop every old kernel replica before
   the first new one starts, because B1 settings writes are not fenced. Drain the old workers as well: an old retirement
   worker does not reopen an `exact-cancelled` obligation (B-22) and could acknowledge a revoked start added after it.
2. `capybara permissions cutover report`: wait until `localWithoutBoot` and `cloudUnknown` are empty, or accept that
   those devices will answer `replace_required` / `recreate_required`.
3. `capybara config migrate-permissions` for file and Nacos, then rename the env variables. Start the new config with
   `--activate-permission-config <hash>` (6c CAS).
4. `capybara permissions cutover freeze`. This publishes the freeze, scans until stable, and fences pending producers.
5. `capybara permissions cutover snapshot`. Cloud devices go through the lifecycle lease. Unreconciled devices keep
   `permission_reconcile_required`.
6. Deploy R2: the paired core and device v3 release. The kernel rejects v2 devices, which must update. Gate the release
   on `retired`, with the operator acknowledging any `abandoned > 0`. Stop and drain every previous-release
   replica (workers included) before the first R2 worker runs, as in step 1: only workers that reopen `exact-cancelled`
   obligations may settle retirement members.
7. Dogfood acceptance on the maintainer's Mac (handoff): three profiles, a background `pnpm test`, then a replay eval.

Notes for operators:

- **Upgrade the kernel before the devices at R2.** A v3 `capybara-device` that reaches a kernel not yet on R2 gets
  426 "Update capybara-device" and does not connect; it connects once the kernel runs R2.
- **Running legacy background rows finish only after the freeze (step 4).** Until then each one still holds a
  background slot (`sandbox.background.maxTasks`) and keeps its device's instance from idling (no suspension).

## 5. Plugins repo and release order

- **sandbox-docker** (rc.17 already has permission scopes): bump to the SDK/testing release that contains C (the
  non-dumpable launcher). Rerun the permission conformance on Docker. Rerun the Task 12 R1/R7 attacks. Release the
  image. Remember the single plugin-sdk instance rule: bumping the SDK there needs a pnpm override. No contract change
  is needed under Q1 option A.
- **sandbox-e2b** (Task 13, not started): run it in the plugins repo in parallel from W1, on the same SDK and testing
  release. Live tests use the configured credential file without printing it. Record the exact VM and delete it.
- **Order:**
  1. R1 = SDK, testing (with C) and plugin-tools, then kernel and device (protocol 2, dormant, boot-ID reporting).
  2. Providers: sandbox-docker and sandbox-e2b on the R1 SDK; pin them in `bootstrap.json` and compose only after they
     are published.
  3. R2 = SDK (device protocol 3) and testing, then kernel and device together, in one version PR.
  The providers do not consume the device protocol, so R2 needs no provider re-release unless Q1 option B or a later
  identity field is chosen.

## 6. Decisions (answered 2026-11-18)

- **Q1 → option A** (controller, within the approved design): kernel-recorded cloud evidence (task H1).
- **Q2 → Linux backend before the cutover** (maintainer decision): no local device may become unusable at
  activation. Task **S** (W2) builds a Linux local operation backend on the accepted 2b runtime, with the same
  functions as the macOS backend, and covers the local Docker device backend the same way; it is reviewed alone
  by the most capable model. R2 waits for S. B-27 is resolved by S, not by an unsupported state.
- **Q3 → E2B gates R2** (controller): Task 13 runs in parallel; core merges do not wait for it, the R2 release does.

### Original questions and recommendations

- **Q1. Cloud context evidence or cloud dormancy?** Under the single global gate, a dormant cloud means every Docker or
  E2B device fails every tool call once activation lands. The legacy route fails closed, as I1 requires. Splitting the
  gate by location reintroduces mixed state. **Recommend option A**: a kernel-recorded cloud binding (B-15). It uses the
  provider's `permissionSupport`, the provider plugin and version, the handle, the instance generation and the recorded
  applied limits, with image digest null. In-process extensions are full trust, so a provider's own report is the
  strongest evidence available without an SDK change. Defer a provider-attested image digest (an optional SDK field) to
  a later contract revision.
- **Q2. Local Linux and local Docker devices at activation.** No operation backend exists for them (B-27), so after R2
  they are unusable rather than degraded. **Recommend** shipping them as explicitly unsupported, with clear copy ("this
  device program supports permission profiles on macOS only; use a cloud device"). Task 14 should record "unavailable"
  for them. Then open a follow-up line for a Linux local backend built on the 2b runtime. The alternative is to hold
  activation for that backend, which is new, unplanned trust-boundary work.
- **Q3. Is E2B (Task 13) a hard gate for R2?** Phase 8.6 says required providers cannot be stubbed and activation stays
  unshipped without them. **Recommend** treating E2B as required: run Task 13 in parallel and gate R2, not the core
  merges, on it. If the maintainer prefers to ship sooner, E2B devices must show the honest unsupported state that
  Task 15 allows, and that must be recorded as a known limitation.

Technical decisions taken here, not questions:

- `sandbox@2` provider methods stay; the kernel stops calling them for cancellation.
- The macOS `restrictedSupported` criterion is a verified manifest plus a worker self-check at bind (W3-M).
- Release R1 before activation is required by the boot-ID cutover ruling.
- Merging dormant work to `main` falls under the standing merge authorization once its gates pass.
