# Task 8.1 — frozen managed-output transport checkpoint

Status: DONE as a dormant Phase 8.1 component, pending root independent review. Source is frozen; no further implementation, audit, or tests are running. User stop/handoff steering was received after the existing necessary checks finished. No later phase was started.

## Baseline and ownership

Worktree: `/Users/grant/.codex/worktrees/vpn-web-verification/core`.
Branch: `codex/permission-output-transport`; HEAD `3b27b4637c9f3f19d7e743575e91348259c05178`; pending accepted merge `1f380b4566135e3fa0147d6601e77f9b9e864a9c`.
Root owns index, pending merge, commits, and pushes. This implementation did not stage, commit, abort, move HEAD, push, or touch remote resources.

The original 42-path merged-byte snapshot remains intact. Thirteen additional existing paths were copied before editing; `task-8-1-before-implementation/manifest.json` marks them `additionalPreEdit`. The closed retained-output component remains byte-identical except its generated SDK API snapshot, which was regenerated for the combined accepted API. `task-8-1-component-preservation.json` records this verification. No journal, supervisor, worker, spool, helper, or no-follow implementation was changed. Merged web/lock changes are present only in the full integration patch, not this task's new-code delta; no #319 hydration fix or unrelated web edit was added.

## Implemented behavior

- Required `background.readOutput` forwards provider → fenced typed relay → authenticated dormant gateway socket → device staged session → dispatcher → existing retained backend. Arguments are exactly ref/offset/maxBytes. There is no ordinary file read, tail, path, actor/scope/grant, provisioning, creation, resume, or execution fallback.
- Codec checks strict unknown fields, exact execution ref shape, safe positions and 0–65536 budgets, canonical base64, requested offset equality, exact decoded range length against the sent budget and snapshot total, safe next offset, metadata probes, and past-end emptiness. Results preserve lost/expired separately from denied/unsupported/unknown error outcomes.
- Device staged hello derives actual frame capacity from `Credential.maxFrameBytes`. Kernel ready reports a random lease connection ID and the minimum of that advertisement and the deployment limit. Control capacity has a 1024-byte minimum and hello/ready must fit. Both sides enforce the effective frame size and refuse data before ready.
- Negotiated capacity lives in a TTL-bound Redis record keyed by device and exact gateway lease token. `DeviceTargets.transport` verifies that lease before and after reading it. Provider budgets use that connection's capacity, with the existing 65536-byte envelope reservation; frame 69632 yields 3072 raw bytes. Relay queue/result metadata fences the connection internally and never appears in operation args or device wire frames. A reconnect/capacity mismatch rejects; retry retains the same offset. A deployment capacity decrease closes the old staged transport before further traffic. There is no automatic reconnect retry loop in the provider.
- Zero capacity permits metadata and genuine EOF. When a zero-budget probe establishes unread bytes for a requested data range, the provider returns an actionable capacity error rather than false EOF. Reads are bounded independently of spool size. Cancel/deadline aborts only that read, not the task.
- Production `connect`, HTTP upgrade selection, registered provider, and active protocol constant remain v2. The authenticated `acceptStaged` and `serveStagedSession` seams are explicitly dormant; no public feature flag, partial v3 advertisement, or raw v2 fallback was introduced. Staged bulk kill operations are refused; exact controls use the existing backend.

## Approved bounded B3 addition

The actual join was `SandboxOperationAuthority.resolveInvocation` → `SandboxOperationIntents` → `PermissionCallGrants.forExecution` → local provider authority resolver. The initial source stored only flattened `granted_hosts`, not the original run/task source. Reconstructing that source from actor or current NetworkGrants would have changed consumed retry authority.

Root explicitly authorized moving this small persistence slice forward: additive `0142_starting_execution_grants.sql`, the schema declaration, admission capture/comparison, and the shared classification selectors. This is distinct from the still-gated background lifetime work.

`operation-authority-types.ts` owns `isExecutionMethod` and bounded starting-grant validation. The authority snapshot captures the exact NetworkGrants source once, combines accepted per-call additions with their original source precedence, bounds those hosts to current authority, and records `{version:1,grants:<original envelope|null>}` under the existing admission fence. Native metadata stays SQL null. Admission hash binds metadata together with method, exact input digest, and exact scope. Pending changes use the existing typed stale-refresh path; consumed dispatch reuses original recorded data and still intersects current org limits. Missing historical provenance fails closed (admitted) or unknown (already dispatching/consumed), never rereads grants as a replacement. Exact input/scope/source tampering rejects.

The same execution classification now covers platform publication, org settings, and owner-policy selectors. Actual writers were tested for exec and backgroundStart, preserved Full semantics, and owner-baseline removal with independently recorded host additions. The migration only adds metadata and expands the method constraint; no background-running state, task lifetime, owner config, or new generation allocation was implemented.

## Canonical preparation and remaining gates

Staged hello now accepts an explicit unbound null generation only with unsupported/unprobed capability and an initialization reason. Its strict owner report uses version 2, revision, sequence, Full permission, independent restricted reach, and domains. These are codec preparation only. There is no owner sidecar producer, durable sequence publisher, policy/backfill conversion, bindInstance lifecycle implementation, installed-runtime manifest proof, or synthetic runtime identity. The existing runtime-report/bootstrap activation remains later work.

Phase 8.2 still owns durable task reservation/ref joins and background-running lifetime. Phase 8.3 still owns TaskOutput history/fresh assembly and HTTP captured suffix/cursor consumer cutover. Phase 8.4 still owns owner/config/generation/bindInstance/runtime manifest producer wiring and full durable revocation/lifetime joins. Phase 8.5/8.6 and Task 9 remain required before paired activation, context publication, final cutover and release. No model-visible context/event writer was touched; no replay claim or new shared context publisher is made.

Linux same-pinned-root proof remains PLATFORM HELD. No retry, reroute, remote VM, restricted Linux experiment, cloud claim, live credentials/services, or hardware durability claim was made. The device proof uses the actual Mac backend, supervisor, journal/spool, dispatcher and WebSocket session with an injected owned worker fixture; it does not establish OS containment. The kernel proof uses actual provider/relay/gateway/Redis/WebSockets and a scripted authenticated device endpoint. No private cross-package test imports remain. These are complementary component seams, not an activated full-production pair.

## Evidence and commands

All logs/configs below are alongside this report. Commands ran from this worktree.

1. Baseline source-alias noemit: `pnpm exec tsc -p .superpowers/sdd/2026-11-16-permission-profile-delivery/task-8-1-kernel-types.json` failed as expected with TS2741: provider background missing required readOutput. Evidence: `task-8-1-baseline-types.log`. The initial temporary config's obsolete baseUrl option was removed before recording this meaningful baseline.
2. Behavioral RED: `pnpm exec vitest run packages/plugin-sdk/test/device-protocol-v3.test.ts` gave 2 failed / 4 passed. The new positional request failed with Unknown operation and the exact result range failed with backgroundReadOutput result must be null, both at real assertions. Evidence: `task-8-1-codec-red.log`.
3. Retained component and bridge regression command: `pnpm exec vitest run packages/plugin-sdk/test/device-protocol-v3.test.ts packages/plugin-sdk/test/sandbox-operation.test.ts packages/device/test/server-ops-v3.test.ts packages/device/test/staged-session.test.ts packages/device/test/background-output.test.ts packages/device/test/output-spool.test.ts packages/device/test/mac-operation-backend.test.ts packages/device/test/operation-supervisor.test.ts packages/device/test/operation-worker.test.ts packages/device/test/native-helper-client.test.ts` → 9 actual files, 256 tests PASS. `operation-worker.test.ts` is not a file in this tree; worker coverage came from the retained background/supervisor tests. Evidence: `task-8-1-retained-tests.log`.
4. Existing kernel + new integration regression: `pnpm exec vitest run packages/kernel/test/local-devices/managed-output-transport.test.ts packages/kernel/test/local-devices/local-device-gateway.test.ts packages/kernel/test/local-devices/local-device-provider.test.ts packages/kernel/test/local-devices/relay.test.ts packages/kernel/test/config/permission-config-activation.test.ts packages/kernel/test/sandbox/permission-call-grants.test.ts packages/kernel/test/tools/permission-policy.test.ts` → 7 files, 136 tests PASS. Evidence: `task-8-1-kernel-tests.log`.
5. Final transport refinements: `pnpm exec vitest run packages/device/test/staged-session.test.ts packages/kernel/test/local-devices/managed-output-transport.test.ts packages/plugin-sdk/test/device-protocol-v3.test.ts` → 3 files, 17 tests PASS. Includes >65KiB adjacent slices, saved client lower than server and server lower than client, 3072-byte chunks at frame 69632, zero probes, zero capacity EOF vs unread, post-exit/expiry, exact generation rejection, request-before-ready and oversized-frame refusal, read cancellation/deadline preserving a running task, strict unbound/owner/ready codecs, and reconnect during a pending range with same-offset retry. Evidence: `task-8-1-final-transport-tests.log`.
6. Final authority/provider refinements: `pnpm exec vitest run packages/kernel/test/local-devices/local-device-provider.test.ts packages/kernel/test/sandbox/permission-call-grants.test.ts packages/kernel/test/local-devices/managed-output-transport.test.ts` → 3 files, 43 tests PASS. Includes both methods, original source on consumed retries, current org narrowing refusal, forged source/changed input/scope, explicit no-grant, native metadata DB rejection, and missing historical provenance. Evidence: `task-8-1-final-authority-tests.log`.
7. Source-alias noemit: `pnpm exec tsc -p .../task-8-1-kernel-types.json`, `.../task-8-1-device-types.json`, and `.../task-8-1-test-types.json` → all PASS with empty logs. The exact JSON configs and corresponding logs are saved. No emitted kernel/device build was run.
8. `pnpm gen:sdk-api` → PASS; `pnpm check:sdk-api` → PASS; `pnpm check:sdk-api-changeset --base HEAD` → PASS; `pnpm check:applied-migrations --base HEAD` → PASS. Logs: api-generation, sdk-api-check, sdk-changeset-check, applied-migrations-check. The first changeset-check invocation omitted its required base and printed usage; the corrected explicit-base gate passed.
9. `pnpm check` → all structural checks PASS, including migrations, boundaries, test portfolio, SDK snapshot, kernel conventions and platform operations. Evidence: `task-8-1-structural-checks.log`.
10. `pnpm exec biome check --write <owned paths>` → PASS, exact owned list in `task-8-1-owned-ts-files.json` and output in `task-8-1-biome.log`. Formatting was limited to those paths. Final noemit and structural gates ran afterward.

Intermediate harness failures (wrong cleanup method and a fixture append exceeding the already-required 65536-byte append bound) were fixed in test code only; the retained implementation was not weakened. Test counts above overlap and are not an aggregate unique-test claim. No broad full test suite or additional matrix was run.

## Frozen artifacts

- `task-8-1-new-code.patch`: only the actual 28-path implementation delta against the merged initial snapshot plus saved pre-edit originals. Root should review this bridge delta first.
- `task-8-1-new-code-manifest.json`: exact path, pre-edit SHA-256, final SHA-256, bytes and new-file marker for those 28 paths.
- `task-8-1-full-head-integration.patch`: full 58-path tracked HEAD delta plus all six new files, including the already accepted component/web merge.
- `task-8-1-full-head-manifest.json`: all 58 final files and hashes.
- `task-8-1-component-integration.json`: root's accepted component/conflict integration baseline, unchanged.
- `task-8-1-component-preservation.json`: closed component byte preservation check.
- `task-8-1-freeze.json`: checkpoint and artifact hashes.

New-code manifest (full hashes are in JSON):

| Path | Status |
|---|---|
| `.changeset/managed-output-transport.md` | new |
| `packages/device/src/client.ts` | modified from saved merged/pre-edit bytes |
| `packages/device/src/server-ops.ts` | modified from saved merged/pre-edit bytes |
| `packages/device/src/staged-session.ts` | new |
| `packages/device/test/staged-session.test.ts` | new |
| `packages/kernel/src/db/kernel-schema.ts` | modified from saved merged/pre-edit bytes |
| `packages/kernel/src/local-devices/keys.ts` | modified from saved merged/pre-edit bytes |
| `packages/kernel/src/local-devices/local-device-gateway.ts` | modified from saved merged/pre-edit bytes |
| `packages/kernel/src/local-devices/local-device-provider.ts` | modified from saved merged/pre-edit bytes |
| `packages/kernel/src/local-devices/policy-summary.ts` | modified from saved merged/pre-edit bytes |
| `packages/kernel/src/local-devices/relay.ts` | modified from saved merged/pre-edit bytes |
| `packages/kernel/src/local-devices/targets.ts` | modified from saved merged/pre-edit bytes |
| `packages/kernel/src/migrations/0142_starting_execution_grants.sql` | new |
| `packages/kernel/src/orgs/settings.service.ts` | modified from saved merged/pre-edit bytes |
| `packages/kernel/src/sandbox/operation-authority-types.ts` | new |
| `packages/kernel/src/sandbox/operation-authority.ts` | modified from saved merged/pre-edit bytes |
| `packages/kernel/src/sandbox/operation-intents.ts` | modified from saved merged/pre-edit bytes |
| `packages/kernel/src/sandbox/permission-call-grants.ts` | modified from saved merged/pre-edit bytes |
| `packages/kernel/src/sandbox/permission-config-publication.ts` | modified from saved merged/pre-edit bytes |
| `packages/kernel/test/config/permission-config-activation.test.ts` | modified from saved merged/pre-edit bytes |
| `packages/kernel/test/local-devices/fake-machine.ts` | modified from saved merged/pre-edit bytes |
| `packages/kernel/test/local-devices/local-device-provider.test.ts` | modified from saved merged/pre-edit bytes |
| `packages/kernel/test/local-devices/managed-output-transport.test.ts` | new |
| `packages/kernel/test/sandbox/permission-call-grants.test.ts` | modified from saved merged/pre-edit bytes |
| `packages/plugin-sdk/api/plugin-sdk.api.md` | modified from saved merged/pre-edit bytes |
| `packages/plugin-sdk/src/device-protocol-v3.ts` | modified from saved merged/pre-edit bytes |
| `packages/plugin-sdk/src/index.ts` | modified from saved merged/pre-edit bytes |
| `packages/plugin-sdk/test/device-protocol-v3.test.ts` | modified from saved merged/pre-edit bytes |

Root independent review, staging, merge completion, commit/push and cross-phase handoff remain root-owned. No permission to activate later phases is implied by this checkpoint.
