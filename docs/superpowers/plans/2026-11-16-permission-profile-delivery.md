# Permission profile delivery implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development with
> wave-planned-subagent-development. Steps use checkbox syntax. Review each trust-boundary,
> migration, cross-tenant and multi-replica task independently before depending on it.

**Goal:** Deliver the approved three permission profiles across local, Docker and E2B devices.

**Architecture:** Keep one shared device instance and filesystem. The kernel resolves fresh
authority for each operation, providers enforce immutable scopes, and explicit supervisors retain
starting grants for running work. Core publishes the shared contract before plugins consume it.

**Tech Stack:** TypeScript/pnpm, Nest/Fastify, PostgreSQL/outbox/BullMQ, SRT, native Linux primitives,
existing Python/GCC tooling, TanStack Query and the existing design system.

**Spec:** `docs/superpowers/specs/2026-11-16-permission-operation-contract.md`, implementing
`docs/superpowers/specs/2026-11-16-conversation-approval-profiles-design.md`.

## Global constraints

- Default Approve for me; three equal neutral visual treatments; no daily auto/sandbox selector.
- Preserve one shared environment, owner/org ceilings, mandatory consent, current project roots,
  native semantics and exact BFS scan behavior. No container/seccomp/capability relaxation.
- Every operation receives fresh authority; running operations keep the starting grant. Actual
  ceiling revocation stops affected work. No old-client or unsupported-provider Full fallback.
- Full uses the existing OS user and outer device ceiling without restricted syscall/socket/
  daemonization filters. Managed cleanup does not promise arbitrary unregistered detached-process
  discovery or macOS PID isolation. Restricted OS/native rules share the same pinned root descriptors.
- SDK contains only types/pure functions/static source; device imports only SDK; official plugins
  install published npm SDK/testing versions, never file/link/local-path substitutes.
- No process-memory source of kernel authority; transactional writes/outbox; deterministic jobs
  without colons. Tests use readiness barriers, not fixed sleeps or per-test timeouts.
- Read area skills before edits. Add new unit/container tests to their checked-in lists. Each task
  has a scoped changeset for published packages; applied SQL stays immutable.
- The maintainer already authorized implementation and routine decisions. Request concrete
  merge/release authorization only after the respective change is reviewable; continue independent
  authorized work while an external publication boundary is pending.
- Linux same-pinned-root validation remains pending after a platform-blocked follow-up. Do not
  retry that blocked security task or label it fixed; proceed with independent SDK/API/UI work.

## Review focus

1. Renamed/restarted devices preserve consent, but a wider owner grant or different project/device
   invalidates it (Task 3).
2. A symlink/root swap during native access, or a mutable syscall pointer during broker checking,
   never escapes authority even through runtime read exceptions (Tasks 2, 4, 12, 13).
3. A launch acknowledgement is lost and another replica retries after a ceiling revocation; no
   duplicate or late unauthorized process appears (Tasks 6, 8, 14).
4. A first project read or marker lookup precedes any exec, and a later write follows Full narrowing;
   both use fresh authority without fixed-workspace or last-command fallback (Tasks 4, 6).
5. New-chat selection, mobile controls, stale pending approval clicks and old replay fixtures agree
   with root profile semantics (Tasks 7, 9, 10).

## Delivery waves and ownership

| Wave | Tasks | Dependencies and file ownership |
|---|---|---|
| A | 1; 5 complete | Additive SDK only; generic design commit `09272da87` is reviewed |
| B | 2a and 3 | Portable native API/source and authority-lock foundation/root API are disjoint |
| B-held | 2b | Linux restricted source/proof remainder stays held; no retry or alternate execution route |
| C | macOS-only 4, independent 11 and dormant 6b implementation after 6a | 6b consumes the frozen Task 4 interfaces in disjoint files; both high-risk reviews must pass before acceptance or activation; Linux/local-Docker work held; wire stays v2 |
| C-output | 8a | After accepted 4 and SDK; isolated SDK/device output correction, disjoint from 6b/7; no activation |
| D0 | 6a | After accepted 3 only; may run alongside 2a/4; read-only facts/module extraction and M1 fix |
| D | 4 + 6b acceptance gate | Both independent reviews must pass; facade/admission and staged v3 stay dormant; no announcement |
| E | 7 and independent 6c; then 8 | Policy/cards plus explicit startup config activation after 6b; background cutover requires 6c and 8a acceptance; v3 only after Task 8 retirement tests |
| F | 9; then 10 | Replay after 7–8; web after 3, 5, 9; no concurrent shared event edits |
| G | independent preparation of 12 and 13 | Published SDK/testing prerequisite remains; Linux enforcement/full proof cannot pass held 2b |
| H | 14; then 15 | Actual-provider acceptance, final checks and staged rollout |

Do not wait for Wave F to start G when the npm prerequisite is available. Task 1 owns additive SDK
types/exports/API snapshot (accepted commit `7a8e0d51d`); Task 2a owns portable source, SDK source
export/API regeneration and native-testing exports. Task 2b may extend those exports only later,
serially, after its gate is cleared; it cannot run concurrently against 2a's files. Task 6 prepares wire replacement/adapters; Task 8 closes the background/upgrade
gate before the coordinated pair may announce/publish v3. Task 3 owns authority-epoch SQL/store/locks
and profile/first-send SQL/schema/events; Task 6 owns operation-intent SQL/schema/outbox; Task 7 adds
approval-state migration/event changes after 3; Task 8 adds background migration/schema after 7
if their database files overlap. Task 9 owns replay/context changes after all event shapes settle.
Controller batches routine integration fixes per wave; trust-boundary findings receive their own review.

---

### Task 1: Freeze and test additive SDK declarations

**Files:** Create `packages/plugin-sdk/src/sandbox-operation.ts`; modify
`packages/plugin-sdk/src/sandbox.ts`, `index.ts`, `packages/plugin-sdk/test/sandbox.test.ts`,
`packages/plugin-sdk/api/plugin-sdk.api.md`; create `test/sandbox-operation.test.ts` and SDK changeset.
Task 2a adds `SANDBOX_RUNTIME_SOURCE` only for its implemented portable helper bytes; 2b cannot add
Linux payloads or support claims while held.

**Interfaces:** Export exact operation/browse/preparation scopes, capability report, factories,
background tail/stop/status/reference and revoke-before-start types in the corrected contract.
Add pure scope guards and error predicates. Existing raw signatures and protocol v2 stay unchanged;
the new optional operation contract describes device-ceiling semantics without activating consumers.

- [ ] Add failing pure tests: malformed scope/revision/purpose, unbounded paths/hosts and invalid
  execution references fail; owner browsing needs no conversation and cannot carry exec/write;
  denied/unsupported/unknown-outcome are distinct from gone; stop/tail types preserve exact limits.
- [ ] Run `pnpm exec vitest run packages/plugin-sdk/test/sandbox-operation.test.ts` and confirm red.
- [ ] Implement declarations, pure guards and error predicates; document immutable copy and no
  compatibility fallback. Test immutable input copies, `admitBeforeMs` and operation-reference guards.
  Export/test `parseSandboxOperationRef(value: unknown): SandboxOperationRef` for revoke validation.
- [ ] Re-run SDK tests and current device/kernel consumer typechecks; `pnpm gen:sdk-api`;
  `pnpm check:sdk-api`; `pnpm check:sdk-api-changeset`. Assert protocol constant/parsers remain v2.
- [ ] Commit `feat(sdk): define immutable sandbox operation scopes` with SDK changeset.

### Task 2a: Portable native-file source and ordinary API conformance (independent)

**Scope:** Implement ordinary native-file semantics and their transport-independent tests. This is
not Linux sandbox work: no Landlock, seccomp notifications, network broker, namespace launcher,
launch-root correction, enforcement experiment or renamed/rephrased version of the blocked task.
No kernel/OS security setting, service or live provider instance is needed. Existing accepted SDK
operation/browse/preparation/background contracts remain unchanged.

**Files:** Create `packages/plugin-sdk/src/sandbox-native-runtime-source.ts` (private source data),
`packages/plugin-sdk/src/sandbox-runtime-source.ts` (bundle metadata),
`packages/plugin-sdk/test/sandbox-runtime-source.test.ts`,
`packages/testing/src/sandbox-native-conformance.ts`,
`packages/testing/test/sandbox-native-conformance.test.ts` and
`packages/testing/test/sandbox-native-helper.test.ts`. Modify only SDK/testing `src/index.ts`, SDK
generated API snapshot and their changesets. No device/kernel/provider implementation belongs to 2a.

**Interfaces:** Keep the planned `SANDBOX_RUNTIME_SOURCE: {readonly version: number; readonly files:
readonly {readonly name: string; readonly source: string; readonly sha256: string}[]}`. Its first
bundle contains only implemented `native-files.py`; no empty Linux file, support flag or broker stub.
The SDK contains static source/hash data only, with no Node imports, process launch or filesystem I/O.
The helper serves the existing native method inputs/results; private JSON transport may encode
Uint8Array as base64. It neither determines a profile nor manufactures authority. Consumers supply
the already-resolved scope and preserve the accepted descriptor-relative native access mechanism;
this helper alone is not an OS execution boundary.

Testing exports `runSandboxNativeConformance(fixture: SandboxNativeFixture): Promise<void>` with
`SandboxNativeFixture = { root: string; operation(): Promise<Pick<SandboxOperation,
"readFile"|"writeFile"|"stat"|"list"|"scan">>; seed(entries: readonly NativeFixtureEntry[]):
Promise<void>; dispose(): Promise<void> }`. `NativeFixtureEntry` is a discriminated union of
`{path,kind:"directory"}`, `{path,kind:"file",data:Uint8Array}` and
`{path,kind:"symlink",target}`; paths/targets stay inside the fixture's owned temporary root.
Each `operation()` supplies a fresh operation ID through the existing SDK interface. Required
list/scan availability is asserted by the harness before using them. Seed/dispose are fixture-owned
test setup/cleanup, never production methods or permission grants. The harness creates no official
plugin dependency in core. The broader permission-conformance export remains Task 2b's separate gate.

- [ ] Add failing ordinary API cases for file/directory/missing results, byte limits including zero,
  binary round-trip, parent creation, stat sizes, in-fixture symlink behavior, sorted/bounded list,
  truncation and exact BFS depth 2 / 500 visits / 50 results / skipped directories / invalid names.
  Use ordinary owned temporary files with normal process permissions; no root swaps, mutable syscall
  pointers, peer-proxy probes, attack payloads or controlled enforcement-break experiments.
- [ ] Implement the portable helper source and test adapter using the accepted native API semantics;
  preserve no-follow descriptor traversal without adding or testing Linux launch-rule installation.
  Source packaging tests verify immutable data, exact SHA-256/name/version, no Node runtime dependency
  in SDK source, and absence of unimplemented Linux payloads. Do not copy the proof's simplified BFS.
- [ ] Run `pnpm exec vitest run packages/plugin-sdk/test/sandbox-runtime-source.test.ts packages/testing/test/sandbox-native-conformance.test.ts packages/testing/test/sandbox-native-helper.test.ts`,
  `pnpm gen:sdk-api`, API/changeset/dependency checks and existing SDK tests. Prove the harness detects
  an intentionally wrong ordinary return value; it must not infer runtime support from a fixture.
- [ ] Independently review and commit the portable subset with accurately scoped release notes.
  A passing result means native API compatibility only, never restricted runtime support.

**MacOS dependency boundary:** Task 4 may consume 1+2a when implementing the already-reviewed
immutable SRT worker/proxy and owned-background mechanism from `task-1-report.md`. Keep those device
files in Task 4. Its real macOS integration and lifecycle acceptance remain required; normal helper
tests do not replace them. Do not translate that mechanism into Linux or use this work as an
alternate path to the blocked Linux correction. Linux restricted capabilities remain unavailable.

### Task 2b: Restricted-runtime source and full permission evidence (gated remainder)

**State:** Held. The Linux launch-root correction is platform-blocked and unverified. Do not retry,
reroute, delegate to a different model/tool/agent, or execute a rephrased version. This is a recorded
dependency, not a dispatch instruction. Only a legitimate change to the blocking platform condition
can let the controller reassess the held work; urgency or a passing 2a fixture cannot clear it.

**Reserved ownership after that gate:** `packages/plugin-sdk/src/sandbox-linux-runtime-source.ts`,
later serial additions to `sandbox-runtime-source.ts` and its tests/API snapshot;
`packages/testing/src/sandbox-permission-conformance.ts`,
`packages/testing/test/sandbox-permission-conformance.test.ts`, testing exports and SDK/testing
changesets. Preserve `runSandboxPermissionConformance(fixture: SandboxPermissionFixture): Promise<void>`
for full provider evidence; the fixture supplies provider/handle, scopes, controlled endpoints,
readiness and exact cleanup. Do not implement a fixture success flag as a runtime capability.

**Remaining acceptance inventory, not work authorized to run now:** same pinned launch roots across
OS rules/native/metadata; Linux broker and complete syscall/ABI/resource inventory; mutable-input
and root/component race proof; real positive native/shell/network controls; cross-scope isolation,
revocation and cancellation under unchanged hardening. Source hashes are not substitutes for these
proofs. Production Linux source/support is withheld until independently reviewed evidence exists.

2a does not satisfy 2b, Task 12 Linux/Docker enforcement, or the all-provider completion gate in
Tasks 14–15. Independent macOS, root/API, policy, replay and UI development can continue, retaining
their own actual-provider tests. Do not claim the complete feature or either cloud provider supported
from a portable helper/fake fixture. Published extensions still consume actual npm SDK/testing
versions; there is no local-link workaround for either stage.

### Task 3: Persist root profiles, consent and owner-only API

**Files:** Create `packages/kernel/src/conversations/permission-profiles.service.ts`,
`permission-profiles.schemas.ts`, `permission-profiles.controller.ts`,
`packages/kernel/src/sandbox/operation-authority.ts`,
`packages/kernel/src/migrations/0137_conversation_permission_profiles.sql` (renumber if main advanced).
Modify `conversations/conversations.module.ts`, `conversations/events.ts`, `db/kernel-schema.ts`,
`conversations/conversations.controller.ts`, `conversations/conversations.service.ts`,
`conversations/conversations.schemas.ts`, `platform/exclusions.ts`, `devices/devices.service.ts`,
`devices/conversation-devices.ts`; create `sandbox/permission-availability.ts` and first-message
idempotency migration after the profile migration.
Create `sandbox/permission-authority-lock.ts`, `sandbox/permission-authority-epochs.ts` and the
authority-epoch migration before profile/first-send methods use them; register in `sandbox/sandbox.module.ts`.
Create `packages/kernel/test/conversations/permission-profiles.http.test.ts` and
`packages/kernel/test/sandbox/operation-authority.test.ts`, `test/sandbox/permission-authority-lock.test.ts`.

**Interfaces:** `PermissionProfilesService.get(orgId, conversationId, accountId)` returns the
contract permission view; `.set(orgId, conversationId, accountId, body)` returns its new revision.
Export GET/PATCH Zod schemas. `SandboxOperationAuthority.resolve(ctx, operation, signal)` returns
`SandboxOperationScope` using the exact method union and context in the contract; operation grants
come from server-owned review/task records. No tool-supplied roots or profile become authority.
Implement the read-only selected-device/project preview and SessionOnly atomic first-send schemas/
service. Persist `(orgId, accountId, clientMessageId)` uniqueness and request hash. Availability reads
persisted provenance-bound capability facts or returns unprobed; no create/resume/update calls.
Request approval/Approve for me accept omitted deviceId and preserve `ConversationDevices.forNew`
default resolution, including null binding. Full requires explicit real preview device and displayed
consent. Persist every selected profile before enqueue, including no-device runs. Keep the same
request-hash idempotency path for all three; never fall back to old create and discard the selection.
Foundation APIs are `PermissionAuthorityLock.acquire(AuthoritySubject, AuthorityLockIntent): Promise<void>`,
`PermissionAuthorityEpochStore.readLocked(AuthoritySubject): Promise<AuthorityEpochVector>` and
`.bumpLocked(kind,id,expected): Promise<number>`, with exact types/order defined in the contract.
Use them inside real `@Transactional()` profile/first-send methods from this task onward; Task 6
integrates all ceiling writers before feature exposure. No temporary weaker lock or unfenced release.
Admissions/readers take shared locks at every present level; writers take shared ancestors and
exclusive at the changed level only. Root profile/first-send uses root-write. Choose lock intent
up front; no upgrades. Preserve fixed order and exclusive-highest-level handling for multi-level writes.

- [ ] Add failing default/migration-idempotence, interactive owner-only, stale revision, root/child,
  scheduled-trigger, cross-org 404, device switch, rename/restart, widening and narrowing cases.
  Cover first-operation profile for all three initial selections, stale displayed preview, lost
  first-send reply/idempotent retry, different-body ID reuse and PAT/Platform profile-field rejection.
  Assert zero provisioning calls for empty/suspended device GET/preview and unprobed metadata.
  Add HTTP first-send cases with no cloud provider/local selection: both non-Full profiles persist
  on a null-bound conversation before the first run; Full without explicit device/preview rejects
  before enqueue. Test shared admission concurrency, root-write versus same-root admission,
  unrelated-root progress, ancestor ceiling-write exclusion, no upgrades, fixed order, CAS conflict
  and rollback in the foundation test; ordinary Read must not take a global exclusive lock.
  Task 3 review obligation M1: reserve the first-send request/root identity early inside the existing
  transaction, and initialize root epoch rows only for the winning inserted conversation. Concurrent
  losing same-message retries return the winner without orphan `root` epoch rows for discarded UUIDs.
  Test race and rollback by asserting every newly created root epoch belongs to the winning root;
  advisory locking a proposed UUID must not by itself persist an epoch.
- [ ] Run the two named tests; implement transactional root state, audit/event append, explicit Full
  consent scope, SessionOnly controller and human-only Platform exclusion. Preserve prior owner
  ceiling during migration and expose truthful unavailable reasons.
- [ ] Register service/module dependencies explicitly; implement fresh authority intersection and
  scope hashing without name/instance-generation sensitivity.
- [ ] Run named tests, `pnpm check:migrations`, `pnpm check:platform-ops`, route parity and kernel conventions.
- [ ] Review migration/access boundary alone and commit `feat(kernel): persist conversation permission profiles`.

### Task 4: macOS operation backend and owned supervision (independent boundary)

**Prerequisites:** Accepted Task 1, reviewed Task 2a, and the accepted local macOS mechanism in
`task-1-report.md`. Integration uses that existing immutable SRT/Seatbelt-worker mechanism; it does
not translate or reroute any blocked Linux work. Linux/local-Docker restricted source, OS enforcement
tests and real-provider conformance are held with 2b. Do not edit `exec/docker.ts` for this task.
The new capability adapter returns `restricted: null` with the true pending-validation reason on
those backends; it never falls back to Full. Existing raw wire2 behavior is not activated/replaced here.

**Files:** Create `packages/device/src/exec/mac-operation-backend.ts`, `operation-types.ts`,
`operation-worker.ts`, `operation-supervisor.ts`, `runtime-source.ts`, `native-helper-client.ts`,
`packages/device/test/mac-operation-backend.test.ts`, `operation-supervisor.test.ts`,
`native-helper-client.test.ts`, `operation-ceilings.test.ts`. Prepare additive helpers in
`src/state.ts`, `policy.ts`, `policy-store.ts`, `exec/types.ts`, `exec/host.ts`, `exec/os.ts` only where
existing pure policy/spawn/ownership primitives are reused; no global SandboxManager mutation.
Keep legacy adapter removals (`switch`, CLI policy fields, old reaper/comment exceptions) with the
Task 6/8 cutover. Add a device changeset and accurately scoped README notes; no kernel files.

**Internal interfaces (device-private, no SDK contract change):**

- `createMacOperationBackend(options: MacOperationBackendOptions): Promise<MacOperationBackend>`
  returns `Required<Pick<SandboxProvider, "permissionSupport"|"operation"|"browse"|"prepare"|
  "revokeOperation"|"background">>` plus the two private methods below. Options contain `deviceId`, `instanceGeneration`, `stateDir`,
  `roots: SandboxRoots`, `pythonPath`, and `readOwnerCeiling(): Promise<DeviceOwnerCeiling>`.
  Validate the supplied handle/device/generation on every entry. Unsupported OS/backend selection
  happens before worker creation; only macOS selects this backend.
  Its additional device-private `forExecution(authority: LocalExecAuthority):
  Pick<MacOperationBackend, "operation"|"background">` returns a one-request facade, and
  `reconcileOwnerCeiling(signal: AbortSignal): Promise<void>` handles actual owner policy changes.
  Neither method is an SDK export or a model/tool input.
- `startMacOperationWorker(request: MacWorkerRequest, signal: AbortSignal): Promise<MacWorkerHandle>`
  owns one immutable worker. A request is exec with `SandboxOperationScope`/exec arguments, or one
  native method with an explicitly tagged operation/browse/preparation scope. Private request data
  is constructed by the backend, never selected by user command text. A handle has
  `ready: Promise<void>`, `completion: Promise<ExecResult|NativeHelperResult>` and
  `cancel(reason: string): Promise<void>`. `ready` resolves only after private IPC confirms fixed
  configuration/proxy installation and required helper descriptors are available.
- `MacOperationSupervisor` implements the SDK background methods and
  `revokeOperation(ref: SandboxOperationRef, signal: AbortSignal): Promise<void>` against the
  device-owned generation/journal. It consumes stable operation ID/input hashes before effects,
  records exact trusted launch identities, owns terminal outcomes/retention, and retains worker/proxy
  lifetime until owned execution ends. Caller RPC completion does not dispose an acknowledged task.
- `runNativeHelper(request: NativeHelperRequest, roots: readonly PinnedNativeRoot[],
  launch: NativeHelperLaunch, signal: AbortSignal): Promise<NativeHelperResult>` is private transport.
  `PinnedNativeRoot` contains `{path:string, fd:number, access:"read"|"write"}`; the trusted caller
  owns/cleans those descriptors. Launch chooses the fixed interpreter/helper and immutable macOS
  wrapper, never an arbitrary user command. Private request/response shapes are Task 2a's helper
  `method/path` (or scan base), limits/base64 and `{result}|{error}`; roots map to inherited fd indices.

**Exact local ceiling source:** Define this device-private type in `exec/operation-types.ts`; it
does not replace the SDK scope or add a remote project registry:

```ts
interface DeviceOwnerCeiling {
  readonly revision: string;
  readonly fullAccess: boolean;
  readonly roots: Readonly<SandboxRoots>;
  readonly restrictedProjectReach: "workspace" | "os-user";
  readonly restrictedAllowedDomains: readonly string[];
  readonly restrictedDeniedReadRoots: readonly string[];
  readonly preparation: Readonly<{ skillsRoot: string; attachmentsBase: string }>;
  readonly fullNetwork: "environment";
}
```

`readOwnerCeiling` is a trusted bootstrap closure, not a callback obtained from a tool request.
Derive it from the current valid on-disk `Policy` (`state.ts:readPolicyFile`) and credential:
`fullAccess = policy.mode === "auto"`; `restrictedProjectReach` is `os-user` for that independently
authorized old-auto ceiling and `workspace` for old-sandbox. `roots = osRoots(credential.dir)` from
`exec/shared.ts`, checked against the backend's roots; request handles/paths do not supply them.
`restrictedAllowedDomains` is a validated copy of `Policy.allowedDomains`; it is the restricted
baseline only. Full keeps the OS environment network and never intersects this old sandbox-only list.
Restricted operation allowance still respects current org limits and existing authenticated run/task
grant semantics from `policy.ts:effectiveEgress/grantedHosts`; a raw user host list is not a grant.
No new grant is inferred from `Policy.allowCredentials` (currently ignored), `cpu` or `memoryMb`.

`restrictedDeniedReadRoots` reuses `policy.ts:deniedSecretPaths(home)` plus the trusted state directory;
skills remain readonly to scoped user work and existing scoped write protections remain in force.
Preparation roots are `roots.skills` and `${roots.workspace}/attachments`; attachment preparation is
further confined to the kernel's existing root-conversation subtree, never the whole workspace.
These locations authorize only purpose-specific staging; user arguments cannot select preparation.
Workspace/project, scratch, skills and that conversation's attachment roots are selected by trusted
kernel authority per operation, not all granted merely because they appear in this ceiling snapshot.

The authoritative project inventory is kernel `device_projects`, written by `DeviceProjectsService`
after owner checks. `state.ts` has no project-root allowlist and the device has no project inventory:
do not invent either or populate one from incoming scope paths. The trusted kernel validates the
bound project against that inventory before sending its immutable scope. Locally intersect the
requested scoped data roots with the independent ceiling above: an outside-default-workspace project
is permitted when old-auto already authorized that OS-user reach, while the conversation still gets
only its scoped project/scratch/skill/attachment access. Old-sandbox remains workspace-bounded; a
previously registered outside project or caller-supplied path cannot widen it. Owner narrowing may
therefore make that project unavailable, as before. This preserves first-read behavior when only the
conversation profile tightens, without manufacturing a new local-owner grant.

Read and validate fresh policy for every operation. Build `revision` from the policy file generation
(the existing inode/size/mtime identity used by PolicyStore), normalized policy and trusted root/device
identity; return a frozen snapshot. Missing/malformed policy fails closed in this new backend rather
than using `readPolicyFile`'s absent-file auto default or `PolicyStore.current()`'s last-good fallback.
This strict additive reader leaves active wire2 behavior unchanged until the coordinated cutover.

**Network grant provenance:** `SandboxExecOptions` currently has no grants field: its source
`SandboxProvider.exec` omits that field. Existing `DeviceExecArgs` carries `limits` and `grants`.
Reuse those authenticated device-transport fields, not a new SDK scope field or an interpretation
of opaque `ceilingRevision`. Define private
`LocalExecAuthority = { operationId: string; orgNetwork: SandboxLimits["network"];
grants?: DeviceExecGrants }`. The actual source is `LocalDeviceProvider` reading current limits and
`NetworkGrants.forExec` followed by `grantsWithin`, as its existing exec path already does. Task 6b
preserves this separate provenance in staged v3 exec requests; Task 8 does the same for backgroundStart.
Read it afresh for each actual admission, including approved resume; the device dispatcher validates
the existing grant/source fields over its authenticated kernel connection and creates a frozen
one-request facade. Require its operationId to match the scope and include org network/grants/source
in the consumed input hash. Do not cache this authority on a shared factory or device handle.

For restricted exec/background start, compute the current baseline plus explicit additions using
the existing `effectiveEgress`/`grantedHosts` rules with restricted mode, fresh local
`restrictedAllowedDomains`, the separate org network and explicit grants. Then intersect that result
with the immutable scope's allowlist (or deny-all for scope `none`), preserving host-pattern narrowing.
Only `grants` provides approved-addition provenance; a flattened scope host never does. Thus a host
removed from the local baseline is denied unless still independently approved by a valid bounded
run/task grant; a host absent from both inputs is denied. Read policy again immediately before launch;
a changed revision before launch rejects the prepared attempt for fresh resolution instead of using
its earlier baseline. Do not compare the local revision with the opaque composite ceiling hash.
Full retains environment networking within its independent ceiling and ignores sandbox-only lists.
Native/browse/preparation helpers have no network, require no execution-grant envelope and cannot
receive one. Missing execution authority fails closed for restricted exec; staged baseline-only
behavior must not be described as complete grant support.

**Actual owner revocation trigger:** `reconcileOwnerCeiling` strictly re-reads local policy, compares
the previous trusted snapshot and the durable starting grants, and records/cancels only affected
owned operation IDs. Invalid/missing policy blocks new work and reconciles existing owned work
fail-closed; Full→restricted and lost root reach revoke affected work. A restricted-baseline removal
does not narrow Full, or a still-valid independently approved addition. Conversation-profile changes
do not invoke this owner-revocation hook. Journaled cancellations survive a lost acknowledgement.
Task 4 owns this method and deterministic policy-change/journal tests. Task 6b/8 must wire it after
successful `PolicyStore.update`/server policy operations and from local file-generation detection
before replacing old executors. Reuse the existing policy-check/reconciliation pattern (client
`pushPolicy`, SwitchingExecutor's 1-second `sync` cadence); the new supervisor's check must remain
active while it owns live work even if the WebSocket disconnects. A method call on the next tool
alone is insufficient. Register/stop that owned watcher with supervisor lifetime and hook the strict
reader rather than PolicyStore's last-good fallback. Tests may inject tick/changed-policy notifications;
they cannot claim real revocation wiring until the actual caller/watcher integration is verified.

**Helper consumption:** The current 2a helper requires supplied pinned directory descriptors and
reads one JSON request from stdin. Its ordinary test adapter already passes an open directory as
child fd 3 to `python3 -I`; no Linux launcher is required. The macOS trusted worker can use the same
private extra-stdio mapping through its fixed SRT shell wrapper. Verify fd identity/availability
with an ordinary owned-directory handshake before method dispatch; if the wrapper drops it, fail
unsupported rather than reopening a root pathname. Close unrelated descriptors. No root descriptors
are passed to arbitrary exec commands; native helper and user exec are separate worker requests.
Canonical macOS `/tmp` paths, interpreter/library exceptions and literal ancestor access follow the
reviewed local mechanism; native data authority still comes only from supplied descriptor roots.

- [ ] Add deterministic ordinary tests using injectable trusted spawn/IPC/journal/clock dependencies,
  not a model-selectable bypass. Test barriers await `ready`, journal-consumed, launch-ack and terminal
  events; use controlled promises/IPC messages rather than fixed sleeps. Verify one initialization,
  no config update, one fresh worker per native operation, descriptor close on every exit and bounded
  output/JSON errors. Hooks observe trusted phases; command stdout cannot supply ownership or readiness.
- [ ] Implement profile/ceiling intersection on every call, genuine Full via the existing OS user
  without restricted child filters, and scoped macOS native/exec workers. The new backend has no
  last-exec write window or shell-comment background privilege. Browse is stat/list/scan only;
  preparation includes marker read/recheck/write and no exec. No shared handle stores authority.
- [ ] Test first-read/project roots, ordinary native BFS semantics via 2a, Full→restricted freshness,
  immutable overlapping worker lifetimes, owner-ceiling revocation, retry/hash mismatch/unknown
  outcomes, expiry lookup, bounded 65,536-byte tail and stop/exit race. Full checks stay within owned
  fixtures and must show that no restricted wrapper was selected. Keep managed cleanup guarantees;
  no all-user scan or promise to discover arbitrary unregistered detached descendants.
  Add ordinary deterministic cases for removed baseline host, approved once/task addition, unknown
  scope-only host, scope/org intersection, stale local revision during startup, and authority hash/
  operation-ID mismatch. Exercise owner-change hook while idle/disconnected with a live owned task;
  assert recorded cancellation and sibling preservation without any network enforcement experiment.
- [ ] After ordinary tests pass, validate the production macOS adapter against the already-approved
  local acceptance cases with exact owned-resource cleanup, as Task 4's separate evidence. Do not
  run Linux/local-Docker enforcement or launch-root experiments. Record unverified runtime behavior
  honestly; passing fake IPC/helper fixtures alone does not advertise restricted support.
- [ ] Run the four named device tests and affected existing device tests, review the device-private
  boundary, and commit `feat(device): add scoped macOS operation backend`. Wire2 constants, hello,
  dispatch and current consumers stay unchanged until coordinated Task 6/8 activation.

### Task 5: Generic neutral composer permission picker (complete)

**Files:** `packages/design/src/conversation/composer.tsx`, `composer-options.tsx`, existing design
i18n files, `packages/design/test/composer.test.tsx`, `composer-menu.test.tsx`, `composer-phone.test.tsx`;
design changeset. Update the composer group count in `docs/design/spec.md` with the integrated picker.
Commit `09272da87` is complete/reviewed; do not redispatch implementation. Remaining spec bookkeeping
may be folded into Task 10 without changing the accepted generic interface.

**Interfaces:** Optional `ComposerBoxProps.pickers.permission?: PickerProps` and
`ComposerOptionsProps.permission?: PickerProps`; device → permission → model → effort, including mobile.

- [ ] Complete existing focused component tests for neutral treatment, order, selected checkmark,
  keyboard/ARIA and absence when unspecified; preserve all current composer slots.
- [ ] Run `pnpm exec vitest run --project design`; review the component API and visual states.
- [ ] Commit the generic design support. App-specific labels/state belong to Task 10.

### Task 6a: Lower-level permission facts and acyclic modules (independent)

**Dependencies/scope:** Requires accepted Task 3 only; can run while 2a is being fixed or Task 4 is
implemented. Existing HTTP/tool results and active execution behavior remain unchanged. No fresh
facade, operation admission/dispatch, protocol activation, OS runtime work or provider execution.
First extract lower-level policy/profile facts from the Task 3 services,
before injecting `SandboxOperationAuthority` into `SandboxService`. Current Authority → Profiles →
SandboxService and Authority → SandboxService edges would become a runtime Nest cycle; project
services can create another indirect path. Do not solve it with `forwardRef`, service locators or
temporarily weaker authority checks.

**Files:** Create `packages/kernel/src/sandbox/permission-facts.ts`, `permission-facts.module.ts`,
`providers.module.ts`, `permission-authority.module.ts`, `operation-authority.module.ts`,
`packages/kernel/src/conversations/permission-profile-store.ts`, `permission-profile-store.module.ts`,
`packages/kernel/src/local-devices/network-grants.module.ts` and
`packages/kernel/test/sandbox/permission-wiring.test.ts`. Modify existing `sandbox/sandbox.module.ts`,
`sandbox/sandbox.service.ts`, `sandbox/operation-authority.ts`,
`conversations/permission-profiles.service.ts`, `conversations/conversations.service.ts`,
`conversations/conversations.module.ts`, `devices/conversation-devices.ts`,
`local-devices/local-devices.module.ts`, and their named
permission/first-send tests. Provider registry and NetworkGrants logic remain unchanged; declarations
move to their own low-level modules, with one instance each.

**Interfaces:** `PermissionFacts.readDevice(orgId,
deviceId)` returns current persisted roots/policy/owner ceiling without lifecycle or provisioning;
`PermissionFacts.projectMatches(deviceId,name,path): Promise<boolean>` checks stored project binding.
`PermissionFacts.readProject(orgId,deviceId,name): Promise<{name:string;path:string}|null>` supplies
the current stored project for the permission preview without invoking DeviceProjectsService.
`PermissionFacts.readWorkingFacts({orgId,deviceId,rootConversationId,holderConversationId}):
Promise<WorkingFacts>` extracts the exact DB-only algorithm currently in
`devices/conversation-devices.ts:workingFacts/recordedWorkspace/machineRoots/workingProject`.
Workspace precedence stays holder's latest `device_paths.roots.workspace` → root's latest event
(when distinct) → active machine workspace → `DEFAULT_SANDBOX_ROOTS.workspace`. This is not a
`working_directory` event and must not be replaced by current machine roots. Home stays the machine's
absolute reported home, otherwise `homeOf(resolvedWorkspace)`, never a project-derived home.
Project stays null for an unbound root or absent/invalid snapshot; otherwise use the bound root's
latest `project_root` event with the same `root`/`unavailable` interpretation. Preserve event `seq`
ordering, no-event and revoked-machine handling. Existing ConversationDevices.workingFacts delegates
to this reader so tool/review callers and Authority keep one algorithm. Callers retain org/owner/
root/holder checks. Move WorkingFacts as a type-only lower-layer declaration rather than importing
the rich service; move pure `permissionScopeHash`/effective-view calculations to the facts layer
too, so Authority imports no values from PermissionProfilesService. No DevicesModule or
ConversationsModule import is allowed into OperationAuthorityModule to regain these helpers.
`PermissionProfileStore.readRoot(orgId,conversationId)` returns the root's stored owner/device/profile,
revision/consent/project/schedule facts, without calling the profile HTTP/view service. Preserve
existing ownership/access checks in their callers. Move the exact `SandboxService.devicePolicy`
read-only implementation to this lower layer and make its old method delegate if still needed.
Use KernelDb/config/pure policy functions only; these providers import none of SandboxService,
SandboxOperationAuthority, PermissionProfilesService, DeviceProjectsService or ConversationDevices.
Both the profile service and Authority depend downward on the facts/store; Authority no longer
depends on the profile service or lifecycle service. Extract `SandboxUseContext` to a type-only
`sandbox/use-context.ts` if its existing service import would otherwise remain a runtime edge.
Module graph: `SandboxProviderRegistryModule` in `providers.module.ts` imports only
`ExtensionRegistryModule`, provides/exports the existing `SandboxProviders`. `NetworkGrantsModule`
provides/exports existing DB-only `NetworkGrants` without importing SandboxModule or LocalDevicesModule.
`PermissionAuthorityModule` provides/exports existing locks/epochs; `PermissionProfileStoreModule`
provides/exports the read store. `PermissionFactsModule` depends on those lower-level readers/config
as needed, never the lifecycle module. `OperationAuthorityModule` imports facts/profile-store,
authority-foundation and network-grants modules, providing/exporting `SandboxOperationAuthority`.
ConversationsModule and later SandboxModule import these providers downward; LocalDevicesModule
reuses registry/network-grants exports instead of redeclaring them. Keep constructor injection tokens
explicit; prefer method-shaped Pick/type-only dependencies over service cycles. A provider registry
lookup may inspect registered metadata but must not start/probe an actual provider in this task.

- [ ] Pin existing permission GET/preview, first-send/no-device, owner checks, scope hashes and
  current authority-return semantics with the existing Task 3 tests. Add module resolution and
  shared-provider identity assertions to `permission-wiring.test.ts`; lifecycle methods are spies
  and must remain uncalled for reads. This is a normal Nest/DB integration test, not an OS experiment.
  In `operation-authority.test.ts`, pin differing child/root recorded workspaces versus current
  machine roots, holder absent → root fallback, both events absent → machine/default, reported-home
  versus homeOf fallback and bound project snapshot/unavailable states. Assert identical resolved
  roots, scope hashes and errors before/after; the extraction must not read only device-level facts.
- [ ] Extract readers/modules and update constructor/module declarations before any later facade
  injection; compile and resolve the full test application without `forwardRef` or locator callbacks.
- [ ] Close M1 here: `PermissionProfilesService.lockInitial` reserves only the ordered transaction
  locks, without initializing an epoch for the candidate UUID. Only the winning insert's
  `initialize` path creates its root epoch. Extend first-send concurrent same-message and rollback
  tests to assert exactly one root epoch for the winner and none for losing UUIDs.
- [ ] Run `pnpm exec vitest run packages/kernel/test/sandbox/permission-wiring.test.ts packages/kernel/test/conversations/permission-profiles.http.test.ts packages/kernel/test/sandbox/operation-authority.test.ts packages/kernel/test/local-devices/network-grants.test.ts`,
  the existing first-send idempotency cases and kernel conventions/typecheck. Prove unchanged result
  and error shapes, zero new lifecycle calls and one NetworkGrants/registry instance.
- [ ] Review and commit `refactor(kernel): extract permission authority readers`. No dependency on
  Task 4 runtime readiness or held 2b; Task 6b consumes this finished lower-level graph.

### Task 6b: Fresh operation facade, durable admission and staged protocol adapters

**Prerequisites:** Accepted Tasks 3 and 6a plus the frozen Task 4 device-private interfaces.
Dormant implementation may run alongside Task 4 fixes in disjoint files; Task 4 and Task 6b both
require independent acceptance before any caller activation or downstream reliance. An interface
change in Task 4 is coordinated before changing a consumer. The lower-level reader/module graph
is already acyclic; do not reintroduce profile/lifecycle dependencies or duplicate extracted
providers. This task retains the existing admission/fencing scope and waits for Task 8 before any
protocol3 announcement.

**Files:** Modify `packages/kernel/src/sandbox/sandbox.service.ts`, `sandbox.module.ts`,
`providers.ts`, `sandbox-file-reader.ts`, `local-devices/local-device-provider.ts`,
`local-device-gateway.ts`, `policy-summary.ts`, `dto.ts`, `devices/device-projects.service.ts`,
`tools/builtins/sandbox/common.ts` (including attachment synchronization), `tools/builtins/skill-load.ts`;
move only trusted staging calls to preparation.
Also modify `sandbox/unreachable.ts`, `local-devices/relay.ts`, `sandbox/modes.ts`,
`local-devices/device-policy.service.ts`, `orgs/settings.service.ts`, `sandbox/platform-auto-mode.ts`,
`infra/config/kernel-config.service.ts`, `db/kernel-schema.ts`, `infra/outbox/registry.ts` and
`roles/worker.module.ts`. Create `sandbox/operation-intents.ts`, `sandbox/operation-reconcile.job.ts`
and next-numbered operation-intent SQL. Consume Task 3's authority lock/epoch foundation.
Stage v3 codecs in SDK `src/device-protocol-v3.ts` with parser tests, and adapters in device
`src/client.ts`, `src/server-ops.ts` and kernel local-device gateway/provider. Current exported
`DEVICE_PROTOCOL_VERSION` and active dispatch remain v2 until Task 8's gate. At that gate replace
`src/device-protocol.ts`/remove the staging file, regenerate API and remove old adapters together;
this staging is development sequencing, not a shipped dual-protocol compatibility layer.
Create `sandbox/held-operations.ts`, `test/sandbox/operation-scopes.test.ts`,
`test/sandbox/operation-scopes.dual.test.ts`; update the sandbox-fake fixture and local fake machine.

**Interfaces:** Existing HeldProvider method signatures preserved. `withPreparation(ctx, purpose,
roots, fn, signal)` passes only `SandboxPreparation`. HeldProvider is an explicit narrow Pick, not
Omit/prototype inheritance. Each held method resolves current authority,
checks runtime capability, creates one factory and invokes one method. Native list/scan ignore the
legacy caller mode in favor of current authority; owner project browsing has its own bounded context.
`resolveBrowse({orgId,deviceId,accountId}, signal)` and `withBrowse` expose only stat/list/scan.
`SandboxOperationIntents` persists the exact state machine, hash/identity/result and epoch vector.
Existing run/tool workers dispatch inline after durable admission under their own sandbox lease,
holder registration, instance generation and abort signal. Outbox carries revoke/reconciliation and
owed continuations, never synchronous native-operation dispatch. Recovery reacquires its own lease
through the existing run/tool claim path and reconciles the stable ID/hash; unknown never gets a new
ID retry. Every ceiling writer uses Task 3's explicit shared/exclusive intents and fixed
platform→org→device→root order. Protocol3 remains unannounced until
Task 8's background callers and SID retirement are integrated and verified.

- [ ] Add red tests narrowing between stat/read and within one held callback, after lease wait,
  approved resume and gone retry; missing factory/unsupported runtime never calls raw provider exec.
- [ ] Add two-replica admission/revocation races with a delayed provider launch. A profile update
  invalidates pending work; recorded admitted work retains its grant; ceiling revocation cancels
  admitted and started work, including cancellation arriving before launch acknowledgement.
  Add authority-read/admission ceiling race, crash-before-dispatch, start-before-ack, duplicate
  completed dispatch, unknown native side effect and disconnected revoke recovery. Assert at most
  once and no automatic new-ID retry. Browse owner/cross-owner/cross-org without a conversation row.
  Assert synchronous native calls retain the caller's lease/signal and enqueue no execution job;
  crash reconciliation cannot use a stale holder token and must re-enter the existing execution claim.
- [ ] Implement facade, exact grant intent/dispatch handling, current roots and trusted preparation.
  Conversation profiles never enter shared instance update/recreation decisions.
  Move entire marker read/recheck/write through preparation; test before first exec. Wrap nested
  provider errors and preserve relay denied/unsupported/unknown outcomes separately from gone.
  Validate all v3 user/browse/preparation/background frames and reject v2 only on coordinated activation.
  Preserve existing authenticated `DeviceExecArgs.limits/grants` provenance for exec in the staged
  transport and create Task 4's request-bound facade only after validation/current grant lookup.
  Wire actual local policy update and file-generation reconciliation callers before new backend
  activation; verify removed baseline versus explicit addition without parsing ceilingRevision.
- [ ] Run named scope tests plus `packages/kernel/test/local-devices/local-device-provider.test.ts`,
  `packages/kernel/test/tools/sandbox/working-root.test.ts` and native reader tests; list dual test
  in `packages/kernel/test/container-tests.json`.
- [ ] Review this boundary alone and commit `feat(kernel): enforce fresh authority on sandbox operations`.

### Task 6c: Explicit startup permission configuration activation

**Requirements:** The independently reviewed [activation design](../specs/2026-11-16-permission-config-activation-design.md)
and [exact implementation plan](2026-11-16-permission-config-activation.md) bind accepted Task 6b
publisher semantics and the private bounded startup transaction port. Complete all named consent,
CAS, mixed-source, cancellation, commit-uncertainty and real-PG evidence gates there before Task 8 activation.

**Ownership:** CLI/startup options, lifecycle publication checkpoint, permission-config-publication,
and the narrow TransactionHost startup-only port belong to 6c. Task 7 consumes existing fences and
lower ceiling writers without editing those files. Root integrates shared test membership lists.
No live startup/configuration change is part of source implementation.

### Task 7: Profile-aware policy and pending approval races

**Files:** Modify `packages/kernel/src/tools/policy.ts`, `pipeline.ts`, `approvals.service.ts`,
`approvals.schemas.ts`, `sandbox/review/review.service.ts`, `review/types.ts`, `review/rules.ts`,
`conversations/events.ts`, `infra/outbox/registry.ts`; create
`tools/permission-approval-jobs.ts`, `test/tools/permission-policy.test.ts`,
`test/tools/permission-approvals.dual.test.ts`; add approval supersession SQL after Task 3's migration
and update `db/kernel-schema.ts` if stored status requires it.

**Interfaces:** Review output records bounded granted roots/hosts, scope/profile revision and
decision source; policy returns ordinary allow, bounded review/ask or deny. Profile update produces
outbox work keyed `permission-recheck-<rootId>-<revision>`; conditional claims supersede cards and
resume a held tool only once. Use current grant on resumed execution.

- [ ] Add red profile matrix: in-project Python/package.json read and edits need no discretionary
  prompt; outside/network asks or reviewer decisions; Full bypasses sensitive-command asks while
  explicit denies, fixed external asks, roles and OS authorization remain. Failed/unknown reviewer asks.
- [ ] Add dual-replica stale click/revision-change/duplicate outbox-delivery cases. Assert obsolete
  cards are superseded, never approved; no duplicated tool side effect and current grant at resume.
- [ ] Implement decisions and transactional outbox/resume wiring; preserve unattended schedules and
  live child-root inheritance. Do not regex-whitelist arbitrary inline scripts.
- [ ] Run named tests and existing `test/tools/policy.test.ts`, `test/schedules/unattended-policy.test.ts`,
  `test/runtime/subagents/permissions.test.ts`, review classifier acceptance; register dual test.
- [ ] Commit `feat(kernel): apply permission profiles to review and approval resume`.

### Task 8a: Retained output correction (independent preparation)

**Prerequisites:** Accepted Task 4 and SDK scopes. Implement in an isolated checkout from the
reviewed foundation; no Task 6b/7 source ownership overlap. Both SDK and device corrections require
independent acceptance before Task 8 activates the coordinated consumers.

**Contract and exact plan:** [retained output design](../specs/2026-11-16-retained-background-output-design.md)
and [implementation plan](2026-11-16-retained-background-output.md).

Add the required reference-bound positional `readOutput` method and a durable provider-owned full
spool with a separate pinned ordinary output artifact. Preserve incremental TaskOutput, exact byte
counts, split-login-code overlap, HTTP byte tails and terminal summary limits. Storage faults stay
sticky, cancellation survives failure of a new journal write, credits cannot deadlock shutdown,
and file/directory creation is synced before durable locator publication. No tail-only substitute,
new execution grant, arbitrary output path read or change to active protocol is permitted.

Root integrates only the SDK contract/doc/test/changeset/API delta into SDK-only PR 317; device
implementation stays separate. The Task 6b/8 owners coordinate staged codecs and provider adapters.
Task 6c is the separately reviewed explicit operator startup-CAS producer for non-hot permission
config changes; complete it after 6b and before Task 8 activation. Ordinary source observation does
not publish restart-only changes as active, and ordinary matching startup needs no extra action.

---

### Task 8: Background lifetime, exact identity and revocation

**Prerequisites:** Accepted Tasks 6b, 6c, 7 and 8a. Current protocol remains v2 until the full
retirement, output, authority and caller cutover gates below pass.

**Files:** Modify `packages/kernel/src/background/launch.ts`, `session.ts`, `store.ts`, `stop.ts`,
`tasks.service.ts`, `poll.job.ts`, `status.ts`, `finish.ts`, `background.schemas.ts`,
`tools/builtins/sandbox/bash.ts`; add background execution-ref/starting-grant SQL and DB types after
Task 7's schema work; create `test/background/permission-lifetime.dual.test.ts`.
Create `background/retire-legacy-tasks.job.ts` and
`test/background/protocol-upgrade.test.ts`; update `roles/worker.module.ts` and outbox registry.
After verified cutover, own final coordinated SDK protocol constant/export, device hello/dispatch,
kernel handshake activation and API snapshot changes staged by Task 6.

**Interfaces:** Persist `SandboxExecutionRef`, starting scope, task-owned tag and launch intent.
Use provider `background.start/status/tail/stop`; no PID text or shell-comment bypass. Control/output
methods never resume instances. Tail caps at 65,536 bytes; terminal stop outcomes distinguish prior
exit, stop-won, cancel-pending and lost. Preserve five-second graceful stop and final-line limits.
Add the one-time SID-row retirement job/migration; no conversion to trusted new refs.
BackgroundStart carries the same separately resolved current org network/DeviceExecGrants provenance
as exec, bound to its operation ID/input hash. Its acknowledged owned supervisor remains subscribed
to strict local-owner reconciliation through idle/disconnection. Existing-result retry preserves
recorded start authority; it does not manufacture a fresh operation or rewrite that starting grant.

- [ ] Add failing lost-start-ack/retry, profile narrowing, owner revocation-before-ack, supervisor loss,
  exact generation mismatch and two-live-task cancellation tests. Assert only one launch and one
  finished event; sibling keeps filesystem/network access from its starting grant.
  Add huge-output bounded tail, paused `kill_pending` before resume, retention expiry and pre-upgrade
  SID rows; no arbitrary PID kill or new execution scope for reading task output.
- [ ] Implement persisted reference recovery and owned broker lifetime, conditional completion and
  outbox cancellation. Poll/read/stop keep existing user access and output-retention semantics.
- [ ] Run named dual test plus existing background and Bash background tests; register dual test.
- [ ] Run `test/background/protocol-upgrade.test.ts`: active legacy SID work drains or records
  stop-before-reuse; suspended/offline instances cannot resume it; new callers use owned refs/tail.
  Only after these pass announce v3 in the coordinated kernel/device pair, reject v2, regenerate
  SDK API and rerun protocol/gateway/device integration tests. Do not publish an intermediate v3 pair.
- [ ] Review lifecycle/revocation alone; commit `feat(kernel): supervise background permission lifetimes`.

### Task 9: Logged permission context and replay

**Files:** Create `packages/kernel/src/runtime/context/permission-profile.ts`; modify
`runtime/context/build.ts`, `runtime/context/device-paths.ts`, `conversations/events.ts`,
`evals/reconstruct.ts`; extend `test/evals/reconstruct.test.ts`, `test/evals/run-replay.test.ts` and
create `test/runtime/permission-context.test.ts`.

**Interfaces:** Logged permission event is the sole model-context source; add
`permission_profile_changed` DriftReason. Recorded review includes Task 7's profile/revision/source.
No context builder queries current profiles; replay never asks a reviewer or resolves live authority.

- [ ] Re-run `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts` before edits (recorded baseline: 62/62).
- [ ] Add red append-only context, mid-run change, child context and replay-with-different-current-DB
  cases; old fixtures retain exact request bytes and no drift.
- [ ] Implement logged rendering and drift metadata; preserve original logs/fixtures.
- [ ] Re-run both zero-drift groups and named replay/context tests; commit `feat(runtime): log permission context for replay`.

### Task 10: Web integration and removal of daily mode controls

**Files:** Create `apps/web/src/components/conversation/PermissionPicker.tsx` and
`apps/web/src/lib/query/permissions.ts`; modify `lib/conversations.ts`, `lib/query/conversation.ts`,
`components/conversation/ComposerBar.tsx`, `NewConversation.tsx`, `ConversationView.tsx`,
`PendingBubbles.tsx`, `BackgroundSection.tsx`, `app/(app)/devices/[id]/view.tsx`,
`app/(auth)/devices/link/view.tsx`, `apps/web/messages/en.json`, `apps/web/messages/zh.json`;
create `apps/web/test/conversation-permissions.test.tsx` and extend device/composer page tests.

**Interfaces:** Consume Task 3 GET/PATCH schemas via web-owned HTTP types, `defineQuery` and
`useAppMutation`; use completed Task 5 slots. New chat displays the selected-device/project preview
before selection, then sends that displayed consent revision/profile through atomic SessionOnly
first-message with a retry-stable clientMessageId. Never create/enqueue then PATCH. Unprobed state
explains deferred checking without provisioning. Pending badges show supersession and the
running-work starting-grant notice.
No-device new chat skips preview, disables Full and sends the chosen non-Full profile through the
same atomic endpoint with omitted deviceId; later binding follows the existing consent rules.

- [ ] Add failing desktop/mobile/new/existing chat, unavailable reason, device-change reset, stale
  consent conflict and owner/viewer controls. Assert identical neutral colors for all three rows.
  Include no-cloud-provider/no-local-selection first-send UI cases preserving Request approval and
  Approve for me, with Full disabled and no provisioning request.
- [ ] Implement approved bilingual copy, keyboard selection/checkmark, missing-review-model
  explanation and authorized settings link. Remove daily mode pickers; connection/details retain
  explicit owner ceiling authorization, including inability of the web to grant local Full access.
- [ ] Run named web tests, `pnpm check:web-ui`, `pnpm check:i18n`; inspect desktop/mobile layouts.
  If baselines change, use the repository visual-update workflow, never commit local screenshots.
- [ ] Commit `feat(web): add conversation permission profiles` with web/design package bumps as needed.

### Task 11: First core SDK/testing release boundary

**Files:** Only changesets/package release metadata for additive Tasks 1+2a and the small contract PR;
no plugin dependency mutation before the package exists in npm.

**Interfaces:** First publication may contain accepted Task 1 types, 2a's portable helper source and
`runSandboxNativeConformance` only. Do not describe it as the complete restricted-runtime source or
export an unimplemented `runSandboxPermissionConformance`. Tasks 12–13 may consume the available
published subset for independent preparation; full permission conformance waits for its real export
and applicable evidence gates. A later additive publication carries reviewed 2b bytes/exports if its
gate clears. This changes no accepted operation contract and permits no file/link workaround.
Leave `DEVICE_PROTOCOL_VERSION`, v2 declarations and current consumers unchanged. Protocol3 publishes
with the coordinated kernel/device release only after Task 8's background/retirement gate, consuming
Task 6's staged adapters. Pending Linux validation blocks shipping/claims of
that helper capability, not independent additive types or profile API/UI implementation.

- [ ] Split the independently passing contract/helper/testing change into a core PR without
  exposing incomplete profiles; run its affected checks, API snapshot/changeset/dependency checks.
- [ ] Prepare concrete PR description, test evidence and release diff. Request maintainer merge/
  publication authorization when needed; keep Tasks 3–10 progressing independently.
- [ ] After publication, verify registry tarball exports/source hashes and exact version. Current
  `next` may be newer than `latest`; resolve the actual published release, not stale node_modules.
  Install testing's actual published kernel/SDK dependency closure in a clean temporary project and
  run the conformance import there, not only against monorepo source.
- [ ] Record published SDK/testing versions for plugin install and release notes; no guessed version.

### Task 12: Docker provider integration under unchanged hardening

**Files (plugins repo):** `plugins/sandbox-docker/src/provider.ts`, `listing.ts`,
`image/Dockerfile`, `package.json`, `README.md`; create `src/operations.ts`,
`src/runtime-source.ts`, `test/permission-scopes.test.ts`; update dependency lock and changeset.

**Interfaces:** Consume Task 11's published SDK/testing. Implement runtime capabilities, factory,
preparation/background with shared SDK helper source and provider transport. No instance policy
mutation for profiles and no new execution containers or cap/seccomp additions.

- [ ] Install published versions normally; add failing actual-provider conformance with both
  overlap orders, native metadata/race cases and ordinary shell/Python/Node/curl positive controls.
  Compare real Full without restricted syscall/socket/daemonization filters against the restricted worker.
- [ ] Stage/build hash-verified root-owned source in the existing image; implement broker scope,
  original socket ownership/aliases, metadata mediation, exact cancellation and fail-closed probes.
- [ ] Run Docker provider conformance, native listing/network/concurrent/lifecycle suites through
  the actual proxy and image. Test the production syscall inventory; unsupported ABIs remain unavailable.
- [ ] Review boundary alone; commit `feat(sandbox-docker): enforce operation permission scopes`.

### Task 13: E2B provider integration on the existing tested template

**Files (plugins repo):** `plugins/sandbox-e2b/src/provider.ts`, `listing.ts`, `e2b-api.ts`,
`package.json`, `README.md`; create `src/operations.ts`, `src/runtime-source.ts`,
`test/permission-scopes.test.ts`, `test/live/permission-scopes.live.test.ts`; update lock and changeset.

**Interfaces:** Same published contract/helper/conformance as Task 12. Restricted namespace launcher mounts
shared backing files and installed runtime, closes foreign descriptors, drops capabilities and
retains a private broker/supervisor. Runtime probe is template-specific, not a claim about all E2B.

- [ ] Add failing API/parser and actual-template conformance; use the configured test-only credential
  file without printing/exporting secrets. Record exact owned VM before remote mutation.
- [ ] Implement restricted namespace/mount/network/PID scopes and trusted native helper staging;
  Full retains the existing VM environment/OS rights without restricted child filters. No
  VM-wide network updates for conversation grants and no copied-files replacement VM.
- [ ] Run live positive/negative networking, native, overlap, background/cancellation and cleanup
  checks. Assert the exact owned VM deleted and absent. Missing configured runtime is unverified.
- [ ] Review boundary alone; commit `feat(sandbox-e2b): enforce operation permission scopes`.

### Task 14: Cross-runtime product acceptance

**Files:** Create `packages/kernel/test/sandbox/permission-profiles.dual.test.ts`,
`apps/web/e2e/permission-profiles.spec.ts`; extend device/provider live conformance fixtures and
`packages/kernel/test/container-tests.json`; update the completion evidence report with results.

**Interfaces:** Exercise actual UI→owner API→policy→fresh facade→provider path, not just helper APIs.
Use the same behavioral assertions on local macOS/Linux, Docker and E2B.

- [ ] Test full profile/operation matrix, first-read project outside fixed workspace, read/write
  after profile changes, shared files/services, approvals late-click races and replay context.
- [ ] Inject delayed launch, lost acknowledgement, replica failure, ceiling revocation and provider
  rebuild; prove exact cancellation without duplicate execution or sibling interruption.
- [ ] Verify trusted skill/attachment preparation cannot be selected by a model; runtime library
  exceptions do not expose native data; same-port peer endpoints and IPv4/IPv6/DNS rebinding stay denied.
- [ ] Record real runtime/version/template/image and every unavailable environment. Feature
  completion requires actual local/Docker/E2B evidence, not mocks or capability booleans alone.
- [ ] Commit acceptance coverage and independently review all trust-boundary findings before rollout.

### Task 15: Final verification and staged publication

**Files:** Relevant area skills/docs, package changesets, `packages/kernel/bootstrap.json` and
`docker/compose.yaml` image references only after provider release; no applied migration edits.

**Interfaces:** Core and device protocol 3 deploy together. Provider artifacts use the verified
published SDK. Old/unavailable providers present a clear unavailable state, never widened execution.

- [ ] Run `CAPYBARA_TEST_WORKERS=4 pnpm verify` in each affected repository; run relevant live suites
  and zero-drift fixtures again after final changes. Verify SDK API, dependencies, i18n, platform
  parity, new test lists and migrations. Repeat tests only for new changes or unresolved failures.
- [ ] Prepare reviewable core feature/provider PRs, release sequence and bootstrap/image bump PR.
  Obtain concrete merge/release authorization where required; do not stop for routine choices.
- [ ] Publish providers before pinning them in core bootstrap/compose; validate real installation
  from their published artifacts and synchronized device upgrade, including truthful unsupported UI.
- [ ] Report completed evidence, exact release versions and any material remaining limitation;
  do not label profiles supported or the feature complete while required runtime proof is missing.
