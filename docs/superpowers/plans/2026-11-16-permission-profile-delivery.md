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
| B | 2 and 3 | Runtime source/testing and authority-lock foundation/root API are disjoint; separate reviews |
| C | 4 and 11 | Device runtime uses 1–2; first additive SDK release uses 1–2 only, wire remains v2 |
| D | 6 | Kernel facade/admission and staged v3 codecs/adapters after 3–4; no v3 announcement |
| E | 7 and 8 | Policy/cards and background cutover after 6; v3 activation only after Task 8 retirement tests |
| F | 9; then 10 | Replay after 7–8; web after 3, 5, 9; no concurrent shared event edits |
| G | 12 and 13 | Plugins after published SDK/testing from 11; disjoint providers, individual reviews |
| H | 14; then 15 | Actual-provider acceptance, final checks and staged rollout |

Do not wait for Wave F to start G when the npm prerequisite is available. Task 1 owns additive SDK
types/exports/API snapshot; Task 2 later owns source implementation, SDK source export/API regeneration
and testing exports. Task 6 prepares wire replacement/adapters; Task 8 closes the background/upgrade
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
Task 2 adds `SANDBOX_RUNTIME_SOURCE` only when its verified production bytes exist.

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

### Task 2: Shared native runtime source and conformance harness

**Files:** Create `packages/plugin-sdk/src/sandbox-runtime-source.ts`,
`packages/plugin-sdk/test/sandbox-runtime-source.test.ts`; update SDK `src/index.ts` and its generated
API snapshot after Task 1. Create
`packages/testing/src/sandbox-permission-conformance.ts`; modify `packages/testing/src/index.ts`;
create `packages/testing/test/sandbox-permission-conformance.test.ts` and SDK/testing changesets.
The SDK source file owns the common Python native helper and C/Linux broker source strings.

**Interfaces:** `SANDBOX_RUNTIME_SOURCE: {readonly version: number; readonly files:
readonly {readonly name: string; readonly source: string; readonly sha256: string}[]}`.
`runSandboxPermissionConformance(fixture: SandboxPermissionFixture): Promise<void>` exported by
testing. `SandboxPermissionFixture` supplies provider/handle, restricted/full/preparation scopes,
controlled endpoint receipt probes, barrier hooks, exact cleanup and a symlink/race fixture root;
it never loads an official plugin inside core. The harness asserts contract outcomes, not mechanism.

- [ ] Add red cases for scope mutation, root/component swaps, symlink read/write/stat/list/scan,
  safe parents, truncation, list flags and BFS depth/order/500-visit/50-result bounds.
- [ ] Add actual Linux syscall inventory cases for stat/chmod plus chown, time, xattr, access,
  readlink, statfs, ioctl and watch families; dangerous unsupported variants deny explicitly.
  Test native ABI/header layouts on supported architectures, notification invalidation, concurrent
  pointer mutation, descriptor alias/reuse, O_NONBLOCK, TCP_NODELAY and resource exhaustion.
- [ ] Run the new tests and confirm failing controls; implement descriptor-pinned operations,
  shared pinned-root identity validation for OS rules and native/metadata access, trusted staging
  metadata and bounded broker lifecycle. Never reopen checked roots by pathname at launch. Do not use
  seccomp CONTINUE on mutable validated pathname/sockaddr requests.
- [ ] Run tests, `pnpm gen:sdk-api`, API/changeset checks, plus positive real curl/Node/filesystem controls and synthetic negative controls
  under unchanged Docker hardening. Missing ABI/runtime coverage stays unavailable in capability tests.
- [ ] Independently review the source inventory and commit `feat(sdk): ship verified sandbox helper sources`.

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
- [ ] Run the two named tests; implement transactional root state, audit/event append, explicit Full
  consent scope, SessionOnly controller and human-only Platform exclusion. Preserve prior owner
  ceiling during migration and expose truthful unavailable reasons.
- [ ] Register service/module dependencies explicitly; implement fresh authority intersection and
  scope hashing without name/instance-generation sensitivity.
- [ ] Run named tests, `pnpm check:migrations`, `pnpm check:platform-ops`, route parity and kernel conventions.
- [ ] Review migration/access boundary alone and commit `feat(kernel): persist conversation permission profiles`.

### Task 4: Local operation workers, supervision and owner-ceiling migration

**Files:** Prepare modifications to `packages/device/src/state.ts`, `policy.ts`,
`policy-store.ts`, `policy-ops.ts`, `commands/start.ts`, `commands/policy.ts`, `commands/mode.ts`,
`cli.ts`, `exec/types.ts`, `exec/switch.ts`, `exec/os.ts`, `exec/docker.ts`, `exec/fs-helper.ts`,
`exec/listing.ts`, `exec/groups.ts`, `exec/reap.ts`; create `exec/operation-worker.ts`,
`exec/operation-supervisor.ts`, `exec/runtime-source.ts` and `test/operation-scopes.test.ts`.
Update affected device tests and README; no kernel files. Implement factories behind the unactivated
operation entry point; old wire still compiles. Task 6 prepares client/server-ops changes; Task 8's
verified cutover gates activation/removal of old adapters together, not a released compatibility layer.

**Interfaces:** Implement SDK scopes and capability report; local configuration uses
`DeviceOwnerCeiling`, independent from profile. Supervisor implements background contract and
exact authenticated references. Factory workers initialize once and retain immutable policy.

- [ ] Add failing first-read/outside-workspace project, Full→restricted write, concurrent opposing
  grants in both orders, peer-proxy borrowing, preparation separation and owner-ceiling revocation tests.
  Assert Full retains its existing OS syscall/socket/daemonization behavior without restricted filters.
- [ ] Run device scope tests red; implement fresh workers, per-request ceiling intersection, protected
  shared helper staging and all native methods. Remove the 60-second write mode and command-comment
  background exception. Replace public auto/sandbox choice directly without widening stored authority.
- [ ] Add trusted background-start retry, exact cancel, crash/disconnect and proxy-lifetime tests;
  foreground cleanup never discovers ownership from model stdout or all-user scans.
  Cover browse without conversation, bounded 65,536-byte tail, stop/exit race and repeat lookup after
  admission expiry. Table-test every migration row with empty/nonempty lists and restrictive org
  ceiling; no old auto narrowing from sandbox-only lists and no restricted widening.
- [ ] Run device tests and actual macOS/Linux conformance; report unavailable runtime separately
  from passing simulation. Positive native/shell controls must run after restrictions are installed.
- [ ] Commit `feat(device): enforce immutable operation permissions` with device changeset.

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

### Task 6: Fresh kernel operation facade and preparation separation

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
- [ ] Run named scope tests plus `packages/kernel/test/local-devices/local-device-provider.test.ts`,
  `packages/kernel/test/tools/sandbox/working-root.test.ts` and native reader tests; list dual test
  in `packages/kernel/test/container-tests.json`.
- [ ] Review this boundary alone and commit `feat(kernel): enforce fresh authority on sandbox operations`.

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

### Task 8: Background lifetime, exact identity and revocation

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

**Files:** Only changesets/package release metadata for additive Tasks 1–2 and the small contract PR;
no plugin dependency mutation before the package exists in npm.

**Interfaces:** Publish the exact SDK API/source and testing conformance export used by Tasks 12–13.
This is an external dependency, not permission to use a file/link workaround.
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
