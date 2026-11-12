# Network ask-to-allow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task, with the `wave-planned-subagent-development` layer. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A command on a connected device that is refused a network domain explains itself (domain, layer, who can lift it), and for the device layer the device owner is asked on the spot (web and IM) with 「这次允许 / 这台设备一直允许 / 拒绝」; the org layer becomes a request to the admins; the owner can switch 「这台设备不限网络」; scheduled tasks collect pre-approved domains.

**Architecture:** The device reads the sandbox-runtime proxy's violations per command, classifies each refused host (`device` / `org` / `address` / `unknown`), appends an English trailer to stderr and returns `ExecResult.network.blocked`. The kernel recomputes the org layer, turns device-layer refusals into an approval of the new kind `network` (same table, waits, inbox, IM card), keeps the formatted command result in the approval and writes it plus a decision note when the ask settles (the command is never re-run). 「这次」 becomes a run grant the kernel sends with each `exec` of the run tree; 「一直」 is a new kernel→device op `policy` that edits the device's local policy live, accepted only while the device's local `remoteGrants` is `owner`.

**Tech Stack:** `@capybara-hq/device` (Node, `@anthropic-ai/sandbox-runtime` 0.0.81), `@capybara-hq/plugin-sdk` (device protocol, `ExecResult`, cards), kernel (NestJS + Fastify + Kysely, vitest with test containers, model-fake), Next + TanStack Query + `@capybara-hq/design`, next-intl.

**Spec:** `docs/superpowers/specs/2026-11-12-network-ask-to-allow-design.md` (issue #180). The six open questions were answered as recommended (spec §13).

## Global Constraints

- Default stays restricted: a fresh device has no network; the cloud never widens a device policy unless the device's local `remoteGrants` is `"owner"` (default) and the device owner decided in a signed-in session.
- Nothing model-driven decides a network ask or changes a device policy: decision and policy routes are `HUMAN_ONLY` (no PAT, no embed token) and are Platform exclusions with category `human-only` and a reason.
- The model sees only `tool_result` content (the command output, the device trailer, the kernel's note). `approval_requested.network` and the `network_blocked` event are display-only; no new `DriftReason`. Zero-drift fixtures (`reconstruct.test.ts`, `rename-compat.test.ts`) pass before and after Phase 1.
- Model-visible text and comments English; UI copy zh + en (zh: 智能体 / 平台 / 超级管理员, never 企业 or the Latin word `agent`).
- Multi-replica: approvals, run grants, task grants and the policy summary live in PG; the `policy` op goes through `LocalDeviceRelay`; the `policy` op is sent outside any transaction, the decision is recorded in `@Transactional()` and resume / bus events go in `afterCommit`.
- Org-scoped lookups everywhere: approval org = conversation org = device org.
- `packages/device` imports only `@capybara-hq/plugin-sdk` (`pnpm check:deps`).
- SDK public API change → `pnpm gen:sdk-api` + a changeset bumping `@capybara-hq/plugin-sdk`; device changes → changeset on `@capybara-hq/device`; kernel / web changes → changeset on `@capybara-hq/capybara` when they ship in the images.
- Migrations: `0114_network_asks.sql` (Phase 1), `0115_network_requests.sql` (Phase 2); `IF [NOT] EXISTS`; kernel schema `capybara`.
- Web: pages from `@capybara-hq/design`, no styles, `defineQuery` / `useAppMutation`, no box in a box (`pnpm check:web-ui`).

## Decisions taken while planning (deviations from the spec text)

- **P-D1 Policy summary lives on `device_machines`, not `devices`.** The hello is stored per machine (`MachinesService.recordHello`); the spec's `devices.local_policy` becomes `device_machines.local_policy jsonb` + `device_machines.features text[]`. The device view reads the active machine's row, so a new machine starts with its own summary.
- **P-D2 The pipeline settles the ask, not a second handler call.** The spec (§6.2.4) has the kernel call `Bash` again with `call.resume`. Since `Bash` would only return the kept text plus a note, the pipeline does it itself: the approval's `detail.result` holds the formatted `tool_result` (≤ 16 KB, output already archived by the formatter), and on settle the pipeline writes it with the note. Same model-visible outcome, no re-run, no new handler contract.
- **P-D3 Run grants reach the device provider through `SandboxActor.runId`** (new optional field, SDK). `LocalDeviceProvider.exec` asks `NetworkGrants.forExec(...)` and adds `grants` to `DeviceExecArgs`. Cloud providers ignore `runId`.
- **P-D4 Approvals get `kind` and `detail`; the unique index stays `(run_id, call_id, attempt)`.** A network ask takes the next attempt after the call's tool approvals (it is only asked after the command ran, so no tool approval can follow it); dropping the index would break `ON CONFLICT` on replicas still running the previous version. `forCall` (tool approvals) filters `kind = 'tool'`, `networkForCall` filters `kind = 'network'`. Status gains `skipped`.
- **P-D5 The decision body gains `hosts?: string[]`** (the checked subset of a network ask; absent = all). Unchecked hosts count as denied.
- **P-D6 Org-layer requests reuse `catalog_requests`** with kind `network_allowlist`, `item_id` null and `detail jsonb` (`{ hosts, note, conversationId, agentId }`), filed by a new member route; approving merges the hosts into the org's `sandboxEgress.allowHosts`.
- **P-D7 Scheduled task network grants reuse `scheduled_task_grants`** with `tool_key = 'network:<host>'`, `spec_hash = 'network'`, `connector_id` null: no migration.

## Review Focus

1. A network ask can only be decided by the device owner, in a signed-in human session (web or bound IM identity); a PAT, an embed token, a Platform call, another member and an org admin are all refused (P1.6, P1.8, P2.2).
2. The device refuses every widening (`add`, `network: "open"`, run grants, task grants) under `remoteGrants: "off"`, always accepts narrowing, validates every host, and grants never exceed the org's limits (P1.3, P2.3).
3. The kernel never trusts the device's claim that the org allows a host: the org layer is recomputed from `SandboxService.orgLimits` at the call (P1.5).
4. The `policy` op is sent before, never inside, the decision transaction; offline / refusing devices fall back to a run grant; one decision resumes the run exactly once across replicas (P1.6, dual-replica test).
5. Zero drift: the note is part of the `tool_result`; `network_blocked` and `approval_requested.network` never reach the model (P1.7).
6. Live reload never loosens on a broken file: an invalid `policy.json` keeps the last good policy (P0.2).

---

## Wave plan

Stacked branches: `feat/network-ask-p0` (from `origin/docs/network-ask-to-allow`), `feat/network-ask-p1` (from p0), `feat/network-ask-p2` (from p1). One PR each, bases chained, `Refs #180`.

- **Phase 0** — Wave 0a (parallel): P0.1, P0.2, P0.4. Wave 0b: P0.3 (needs P0.1 + P0.2). P0.5 closes. Batched review of the wave.
- **Phase 1** — Wave 1a (parallel): P1.1 (SDK), P1.2 (migration). Wave 1b (parallel, disjoint): P1.3 (device), P1.4 + P1.5 (one implementer: `local-devices/*`, `devices/*`), P1.6 (approvals). Wave 1c (parallel): P1.7 (pipeline), P1.8 (channels), P1.9 (design + web). P1.10 closes. **Trust-boundary review alone on the most capable model:** P1.3 (`policy` op, `remoteGrants`, live reload) and P1.4 + P1.6 (owner-only decision, op ordering).
- **Phase 2** — Wave 2a (parallel): P2.1 (requests), P2.2 (device policy route), P2.3 (device CLI), P2.4 (task grants). Wave 2b (parallel): P2.5 (device page), P2.6 (card request + settings prefill + inbox + task form). P2.7 closes. **Alone review:** P2.2 (owner-only policy route).

---

## Phase 0 — self-explaining refusals (spec §9)

### Task P0.1: Violation parse, classification and trailer (device, pure)

**Files:**
- Create: `packages/device/src/network.ts`
- Test: `packages/device/test/network.test.ts`

**Interfaces (produces):**
```ts
export type BlockedLayer = "device" | "org" | "address" | "unknown";
export interface BlockedHost { host: string; port: number; layer: BlockedLayer }
/** Parses one sandbox-runtime 0.0.81 violation line `deny network-outbound <host>:<port> (<reason>)`; undefined for other lines. IPv6 hosts arrive bracketed. */
export function parseNetworkViolation(line: string): { host: string; port: number; reason: string } | undefined;
/** The layer that refused `host`: address (IP literal, validateAllowHost refuses, or a resolved-address reason), org (not in the org's effective egress, egress none), device (org allows, local policy does not), unknown. */
export function classifyHost(host: string, reason: string, limits: Pick<SandboxLimits,"egress"|"allowHosts">, policy: Pick<Policy,"allowedDomains"> & { network?: "allowlist" | "open" }): BlockedLayer;
/** Dedupe by host (first port kept), at most 20 (MAX_BLOCKED_HOSTS). */
export function blockedHosts(lines: string[], limits, policy): BlockedHost[];
/** The stderr trailer of spec §9.2 (English), "" for an empty list. */
export function networkTrailer(blocked: BlockedHost[]): string;
/** The reason the ask callback answers (spec §9.1), e.g. "capybara: x is not in this device's allowed domains". */
export function denyReason(host: string, limits | undefined, policy): string;
export const MAX_BLOCKED_HOSTS = 20;
```

- [ ] Write failing tests: the line format pinned to 0.0.81 (literal sample strings, including `[::1]:443`, `files.slack.com:443 (host is not on the allow list)`, a resolved-address reason); `deny socks-tunnel` and file lines ignored; classification table (org none → org; allowlist without host → org; host in org list but not local → device; both → org; `10.0.0.5` → address; `localhost` / `.local` → address); 20-host cap; trailer text exactly as spec §9.2; deny reasons.
- [ ] Run `pnpm exec vitest run packages/device/test/network.test.ts` → fails.
- [ ] Implement with `covers()` matching like `policy.ts` (`*.x.com` admits subdomains, never the apex), `validateAllowHost` from the SDK for the address check.
- [ ] Tests pass; commit `feat(device): classify and explain blocked network hosts`.

### Task P0.2: Live policy, lock file, `policy add|remove` (device)

**Files:**
- Create: `packages/device/src/policy-store.ts`
- Modify: `packages/device/src/state.ts` (`withPolicyLock`), `packages/device/src/commands/policy.ts`, `packages/device/src/args.ts` (USAGE, `policy add|remove <key> <value>`), `packages/device/src/commands/start.ts`, `packages/device/src/cli.ts` (executors get a `PolicyStore`), `packages/device/src/exec/docker.ts` and `packages/device/src/exec/os.ts` (read `store.current()` per exec instead of a fixed `Policy`)
- Test: `packages/device/test/policy-store.test.ts`, `packages/device/test/policy.test.ts`, `packages/device/test/args.test.ts`, existing `start.test.ts` / `exec-*.test.ts` adjusted

**Interfaces (produces):**
```ts
export class PolicyStore {
  constructor(dir: string, opts?: { err?: (line: string) => void; initial?: Policy });
  /** The policy now: re-reads policy.json when its mtime (or existence) changed; an invalid file keeps the last good policy and reports once per bad mtime. */
  current(): Policy;
  /** Read-modify-write under the lock; writes atomically, swaps the in-memory policy, returns the new one. */
  update(change: (p: Policy) => Policy): Policy;
}
/** policy.json.lock with O_EXCL; a lock older than 10 s is stale and taken over; retries up to ~2 s then throws. */
export function withPolicyLock<T>(dir: string, fn: () => T): T;
```

- [ ] Failing tests: reload on mtime change; invalid file keeps last good and calls `err` once; deleted file → defaults; lock serializes two writers (simulate a held lock file, stale after 10 s via injected clock); `policy add allowedDomains a.com` / `remove` (validates with `validateAllowHost`, lowercases, dedupes, idempotent); `set` no longer prints "Restart capybara-device"; args parsing for add / remove.
- [ ] Implement. The executors take `policy: () => Policy` (OS: `effectiveEgress(this.opts.policy(), args.limits)`); `start` builds one `PolicyStore` and passes `() => store.current()`; `createExecutor(cred, store)` signature in `cli.ts` / `start.ts`.
- [ ] Update `policyCommand` header comment: the machine's user edits the file; the program applies changes at the next command.
- [ ] Tests pass; commit `feat(device): apply local policy changes without a restart`.

### Task P0.3: Deny reason and stderr trailer in OS mode (device)

**Files:**
- Modify: `packages/device/src/exec/os.ts`
- Test: `packages/device/test/exec-os.test.ts`

- [ ] Failing tests (with the existing test seams / a mocked `SandboxManager` where the real sandbox is unavailable): `createOsExecutor` passes an ask callback to `SandboxManager.initialize` only when `SandboxManager.askCallbackDenyReason === true`, and the callback answers `{ allow: false, reason: denyReason(host, lastLimits, policy) }`; after a command, violations of its `commandId` (`getSandboxViolationStore().getViolationsForCommand(commandId)`) are classified against that exec's `args.limits` and the current policy and the trailer is appended to `stderr` (separated by a newline); no trailer without network violations; the fs helper never appends a trailer. Where the platform supports the real sandbox (existing `describe.runIf`), an integration case with a local HTTP server: a blocked `curl` gets the trailer naming the host and `device` layer.
- [ ] Implement: remember `lastLimits` from each exec; read violations in `finish` before `cleanup()` unregisters the command.
- [ ] Tests pass; commit `feat(device): explain blocked network access after each command`.

### Task P0.4: Proxy hint in the `Bash` description (kernel)

**Files:**
- Modify: `packages/kernel/src/tools/builtins/sandbox/bash.ts` (`SPEC.description`)
- Test: the tests that pin the description or the builtin fingerprint (`grep -rn "Prefer Read, Write, Edit" packages/kernel/test`), `packages/kernel/test/evals/reconstruct.test.ts`, `packages/kernel/test/tools/rename-compat.test.ts`

- [ ] Run the zero-drift fixtures first (record pass).
- [ ] Append to the description: "Network access goes through a proxy set in HTTP_PROXY / HTTPS_PROXY / ALL_PROXY; a tool that ignores them fails with 'Operation not permitted'. A blocked domain is reported after the output."
- [ ] Update pinned descriptions / fingerprints where a test pins them; rerun the zero-drift fixtures (a description change appears as `tools_changed` only in replays of older recordings, which is its purpose).
- [ ] Commit `feat(kernel): tell the model how sandbox network access works`.

### Task P0.5: Docs, changesets, verify (Phase 0)

- [ ] `packages/device/README.md`: `policy add|remove`, changes apply at the next command, the trailer.
- [ ] Changesets: `@capybara-hq/device` minor (pre-1.0: patch per repo convention, check `.changeset` history), `@capybara-hq/capybara` patch (Bash description).
- [ ] `pnpm typecheck && pnpm lint && pnpm check && pnpm verify`.
- [ ] Push `feat/network-ask-p0`, PR against `docs/network-ask-to-allow`.

---

## Phase 1 — network asks for the device layer

### Task P1.1: SDK — device protocol, `ExecResult.network`, actor, cards

**Files:**
- Modify: `packages/plugin-sdk/src/sandbox.ts`, `packages/plugin-sdk/src/device-protocol.ts`, `packages/plugin-sdk/src/cards.ts`, `packages/plugin-sdk/src/index.ts` (exports)
- Test: `packages/plugin-sdk/test/device-protocol.test.ts`, `packages/plugin-sdk/test/cards.test.ts`
- Generated: `pnpm gen:sdk-api`; changeset `@capybara-hq/plugin-sdk` minor

**Interfaces (produces):**
```ts
// sandbox.ts
export type NetworkBlockLayer = "device" | "org" | "address" | "unknown";
export interface NetworkBlockedHost { host: string; port: number; layer: NetworkBlockLayer }
export interface ExecResult { /* … */ network?: { blocked: NetworkBlockedHost[] } }
export interface SandboxActor { accountId: string; conversationId: string; /** The run the command serves (kernel-internal routing of run grants; informational for providers). */ runId?: string }

// device-protocol.ts
export type DeviceFeature = "networkReport" | "policyOp";
export type DeviceRemoteGrants = "owner" | "off";
export type DeviceNetworkMode = "allowlist" | "open";
export interface DeviceLocalPolicySummary { network: DeviceNetworkMode; allowedDomains: string[]; remoteGrants: DeviceRemoteGrants }
export interface DeviceHello { /* … */ features?: DeviceFeature[]; policy?: DeviceLocalPolicySummary }
export type DeviceOp = /* … */ | "policy";
export interface DevicePolicyArgs {
  add?: string[]; remove?: string[]; network?: DeviceNetworkMode;
  source: { approvalId?: string; accountId: string; accountName: string; via: "web" | "im" };
}
export interface DevicePolicyResult { policy: DeviceLocalPolicySummary }
export interface DeviceExecGrants { hosts: string[]; source: { kind: "run" | "task"; id: string; accountId: string } }
export interface DeviceExecArgs { /* … */ grants?: DeviceExecGrants }
export const MAX_NETWORK_BLOCKED_HOSTS = 20;

// cards.ts (approval variant)
scopeLabels?: Partial<Record<"once" | "session" | "always", string>>;
state: "pending" | "approved" | "denied" | "expired" | "cancelled" | "skipped";
```

- [ ] Failing tests: `parseOpResult("exec", …)` keeps a valid `network` (hosts passing `validateAllowHost` or layer `address`; unknown layers dropped; >20 cut), drops a malformed one without failing the result, and works without it; `parseHello` keeps valid `features` (unknown features dropped) and `policy`, ignores malformed ones (old kernels / devices interoperate), still parses a hello without them; `policy` op args validated (`add`/`remove` string arrays of ≤ 100 entries, `network` enum, `source` required with `via` enum), result validated; exec `grants` validated when present; `validateChannelCard` accepts `scopeLabels` (only the three keys, strings ≤ 40) and `skipped`; `renderCardAsText` uses `scopeLabels` when present and has a `skipped` state text (zh 已跳过 / en Skipped).
- [ ] Implement; `pnpm gen:sdk-api`; changeset.
- [ ] Commit `feat(plugin-sdk): network reports, the policy device op and approval scope labels`.

### Task P1.2: Migration 0114 and Kysely types

**Files:**
- Create: `packages/kernel/src/migrations/0114_network_asks.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts` (`ApprovalsTable.kind`, `.detail`; `DeviceMachinesTable.local_policy`, `.features`)
- Test: `packages/kernel/test/migrations/*` pattern (a test applying the migration twice; see existing migration tests)

```sql
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'tool';
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS detail jsonb;
-- kind check, status check widened with 'skipped' (drop + re-add, like 0108); unique index unchanged (P-D4)
CREATE INDEX IF NOT EXISTS approvals_network_run_idx ON approvals (run_id) WHERE kind = 'network';
ALTER TABLE device_machines ADD COLUMN IF NOT EXISTS local_policy jsonb;
ALTER TABLE device_machines ADD COLUMN IF NOT EXISTS features text[] NOT NULL DEFAULT '{}';
```
- [ ] Follow `writing-migrations` (idempotent). `ApprovalsTable.kind` / `.detail`, `DeviceMachinesTable.features` / `.local_policy`, status `skipped` in the Kysely types.
- [ ] `pnpm exec vitest run packages/kernel/test/migrations` and the approvals tests pass; commit `feat(kernel): approval kinds and device policy summaries (migration 0114)`.

### Task P1.3: Device — report, hello, `policy` op, `remoteGrants`, run grants (TRUST BOUNDARY)

**Files:**
- Modify: `packages/device/src/state.ts` (`Policy.network: "allowlist" | "open"` default `allowlist`, `Policy.remoteGrants: "owner" | "off"` default `owner`, validation), `packages/device/src/policy.ts` (`effectiveEgress(policy, limits, grants?)`: `open` → org list (`allowlist`) or `["*"]` (`open`), none → []; grants added only under `remoteGrants: owner` and only where the org allows them), `packages/device/src/exec/os.ts` (`network` in the result), `packages/device/src/exec/docker.ts` (no report: Docker mode has no per-host view; grants: none), `packages/device/src/client.ts` (hello `features: ["networkReport","policyOp"]` in OS mode, `["policyOp"]` in Docker mode; `policy` summary), `packages/device/src/server-ops.ts` (`policy` op), `packages/device/src/command-log.ts` (optional `detail` string on entries: the audit line and an exec's grant source), `packages/device/src/commands/policy.ts` (`show` prints `network` and `remoteGrants`)
- Test: `packages/device/test/policy.test.ts`, `server-ops.test.ts`, `client.test.ts`, `exec-os.test.ts`, `state.test.ts`

- [ ] Failing tests: `policy` op under `remoteGrants: off` refuses `add` and `network: "open"` with `kind: "policy"` ("This device does not accept network changes from the deployment; allow it locally with capybara-device policy add allowedDomains <host>") but applies `remove` and `network: "allowlist"`; every host validated (wildcards rejected from the cloud: exact hosts only for `add`); idempotent; written through `PolicyStore.update` (lock); the command log gets `policy add files.slack.com by <name> (<id>) via web, approval <id>`; result is the new summary; `effectiveEgress` with grants: added only when owner, intersected with org limits, ignored under org `none`; `network: open` semantics; the exec result carries `network.blocked` (from P0.1) in OS mode; hello carries features and the summary, and the summary after a `policy` op is the new one on the next hello.
- [ ] Implement. Commit `feat(device): accept owner-approved network changes from the deployment`.

### Task P1.4: Kernel — hello summary, `DevicePolicyService` (TRUST BOUNDARY)

**Files:**
- Modify: `packages/kernel/src/local-devices/machines.ts` (`recordHello` stores `features`, `local_policy`; `ActiveMachine` gains `features`, `localPolicy`), `packages/kernel/src/devices/devices.service.ts` (`DeviceView.network: { features: string[]; policy: DeviceLocalPolicySummary | null } | null`, only for the owner, which the view already requires)
- Create: `packages/kernel/src/local-devices/device-policy.service.ts` (provided and exported by `LocalDevicesModule`)
- Test: `packages/kernel/test/local-devices/device-policy.test.ts`, `machines.test.ts`

**Interfaces (produces):**
```ts
export type PolicyChangeOutcome =
  | { applied: true; policy: DeviceLocalPolicySummary }
  | { applied: false; reason: "offline" | "refused" | "unsupported"; message: string };
@Injectable() export class DevicePolicyService {
  /** Sends the `policy` op (no transaction may be open), stores the returned summary, audits device.policy_changed. Never throws for offline / refusal / old program. */
  apply(input: { orgId: string; deviceId: string; change: Omit<DevicePolicyArgs,"source">; source: DevicePolicyArgs["source"]; actorTokenId?: string }): Promise<PolicyChangeOutcome>;
  /** The active machine's features and summary (null when no machine). */
  summary(deviceId: string): Promise<{ features: DeviceFeature[]; policy: DeviceLocalPolicySummary | null } | null>;
}
```
- [ ] Failing tests (FakeMachine answering `policy`): applied → summary stored, audit row; device lacks `policyOp` → `unsupported` without sending; offline → `offline`; device answers `kind: "policy"` → `refused` with its message; a device of another org → `device.not_found`.
- [ ] Implement with `LocalDeviceRelay.call(deviceId, "policy", args, { deadlineMs: 30_000, signal })`; summary write in its own `@Transactional()` method.
- [ ] Commit `feat(kernel): send owner-approved policy changes to a device`.

### Task P1.5: Kernel — org layer recompute and run grants in `exec` (TRUST BOUNDARY)

**Files:**
- Create: `packages/kernel/src/local-devices/network-grants.ts` (`NetworkGrants` provider in `LocalDevicesModule`)
- Modify: `packages/kernel/src/local-devices/local-device-provider.ts` (`exec`: `grants` from `NetworkGrants.forExec`, `network.blocked` re-layered against `limits`), `packages/kernel/src/sandbox/sandbox.service.ts` / `packages/kernel/src/tools/builtins/sandbox/common.ts` (`actor.runId` set from `ctx.runId`)
- Test: `packages/kernel/test/local-devices/network-grants.test.ts`, `local-device-provider.test.ts`

**Interfaces (produces):**
```ts
@Injectable() export class NetworkGrants {
  /** Hosts allowed for this exec: approved `network` approvals with scope once in the run tree of runId (budget_run_id lineage), or the task's network grants when the run is unattended (Phase 2 fills the task branch). */
  forExec(input: { orgId: string; runId: string }): Promise<DeviceExecGrants | undefined>;
  /** Hosts denied / expired / skipped in the run tree (spec §6.8), and the count of asks in the run. */
  runState(runId: string): Promise<{ granted: Set<string>; refused: Set<string>; asks: number; pending: boolean }>;
}
/** Kernel-side layer: a host the device calls `device` that the org's effective egress does not allow becomes `org`. */
export function relayer(blocked: NetworkBlockedHost[], limits: Pick<SandboxLimits,"egress"|"allowHosts">): NetworkBlockedHost[];
```
- [ ] Failing tests: `relayer` table; `forExec` returns the run tree's once-approved hosts (a sub-agent's run sees the root's grant; another run tree does not); approval hosts stored per decision in `approvals.detail.grantedHosts`; provider sends `grants` only when there are hosts.
- [ ] Commit `feat(kernel): run grants reach the device with each command`.

### Task P1.6: Kernel — approvals of kind `network` (TRUST BOUNDARY)

**Files:**
- Modify: `packages/kernel/src/tools/approvals.service.ts`, `packages/kernel/src/tools/approvals.controller.ts` (`DecisionBody.hosts`), `packages/kernel/src/tools/approvals.schemas.ts` (status `skipped`), `packages/kernel/src/conversations/events.ts` (`approval_requested.network?: { hosts: string[] }`, `approval_decided.decision` adds `skipped`, display-only `network_blocked`), `packages/kernel/src/infra/events/kernel-events.ts` (`approval.decided.status` adds `skipped`), `packages/kernel/src/conversations/conversations.service.ts` + `queue.service.ts` (reply skips network asks next to questions), `packages/kernel/src/runtime/waits.ts` (`stoppedResults`: a network approval writes its kept result + the cancelled note), `packages/kernel/src/errors.ts` (codes below)
- Test: `packages/kernel/test/tools/network-approvals.test.ts`, `approvals.http.test.ts`

**Interfaces (produces):**
```ts
interface ApprovalRecord { kind: "tool" | "network"; detail: NetworkAskDetail | null; /* … */ }
interface NetworkAskDetail { deviceId: string; hosts: { host: string; port: number }[]; command: string; description: string | null; result: { content: string; isError: boolean }; grantedHosts?: string[]; outcome?: "once" | "always" | "once_fallback"; fallback?: "offline" | "refused" | "unsupported" }
ApprovalsService.requestNetwork(input: { orgId; conversationId; runId; step; callId; requestedFor: string /* device owner */; detail: Omit<NetworkAskDetail,"grantedHosts"|"outcome"|"fallback">; scopes: ("once"|"always")[] }): Promise<ApprovalRecord>;
ApprovalsService.networkForCall(runId: string, callId: string): Promise<ApprovalRecord | null>;
ApprovalsService.skipNetworkIn(conversationId: string, authorAccountId: string): Promise<string[]> // mandatory tx, returns ids
```
- [ ] `decide` for kind `network` (outside the `requires_new` transaction first): only `requested_for` may decide (else `approval.not_yours` 403 "Only <owner> can allow network access on this device."); `hosts` ⊆ asked hosts; scope `always` → `DevicePolicyService.apply({ add: hosts, source: { approvalId, accountId, accountName, via } })`; not applied → record as `once` with `fallback`; then `decideIn` records status / scope / `detail.grantedHosts` / outcome, appends `approval_decided`, audits `device.network_allowed` or `device.network_denied`, and emits `approval.decided` in `afterCommit`. `via` = `im` when called from channel card actions (add a parameter), else `web`. Tool-kind code paths (`session` grants, `keepTrialGrant` for tools) skip network approvals; `keepTrialGrant` for network is P2.4.
- [ ] `forCall` filters `kind = 'tool'`; `list` / inbox views carry `kind` and `detail` minus `result`.
- [ ] Reply skip: `writeMessage` / queue path call `approvals.skipNetworkIn` beside `skipQuestionsIn` (same author rule: the run's trigger account), emit `approval.decided { status: "skipped" }` after commit.
- [ ] Failing tests first: owner decides once / always (FakeMachine applies) / always with device offline → once fallback; another member, org admin, PAT → refused; hosts subset; skip by reply; expiry; abort writes kept output + cancelled note; tool approvals of the same call unaffected (unique index by kind).
- [ ] Commit `feat(kernel): network asks are approvals the device owner decides`.

### Task P1.7: Kernel — the ask in the tool pipeline, notes, caps, unattended (zero drift)

**Files:**
- Create: `packages/kernel/src/tools/network-asks.ts` (pure note texts + the decision of what to ask)
- Modify: `packages/kernel/src/tools/builtins/sandbox/bash.ts` (foreground result carries kernel-internal `network: { deviceId, blocked }`), `packages/kernel/src/tools/pipeline.ts` (`processCall`: a network approval for the call → pending: wait; settled: write `detail.result` + note; `runCall` after execution: ask or note), `packages/kernel/src/runtime/context/build.ts` (explicit `case "network_blocked": break;`), `packages/kernel/src/evals/trajectory.ts` (show network_blocked), `packages/kernel/src/schedules/unattended.ts` (`network:<host>` missing grant key)
- Test: `packages/kernel/test/tools/network-ask.test.ts` (model-fake + a fake device / sandbox-fake returning `network.blocked`), `packages/kernel/test/evals/reconstruct.test.ts` (new case), `packages/kernel/test/tools/network-asks.unit.test.ts`

Rules (spec §6.2, §6.6–§6.9, §8.3):
- Every reported refusal appends `network_blocked { step, callId, hosts }` (display-only) before the result.
- Asked only for foreground `Bash` on a device whose machine has `policyOp`, layer `device`, host passing `validateAllowHost`, not granted / refused in the run tree, at most one pending per run tree and 5 asks per run (else the "Too many network requests…" note), the run attended. `scopes` = `["once","always"]`, or `["once"]` when the summary says `remoteGrants: off`.
- Unattended (`ctx.unattended`): `fail` → no approval, note §8.3, `appendMissingGrant(network:<host>)` (and `org` layer records too); `wait` → ask the task creator.
- Notes (English, appended to the kept text with a blank line, one per host group): exactly spec §6.6 / §8.3; device-without-feature: no note (the device trailer explains).
- `requestedFor` = the device's `owner_account_id`; card description = the call's `description`.
- [ ] Zero-drift fixtures before; failing tests for each outcome (once, always, always-fallback, deny with reason, expired, skipped by reply, cancelled), caps, refused host not asked again, sub-agent ask surfaces in root (`subagent_waiting`), background not asked, unattended fail records `missing_grants`, dual-replica: ask on one replica, decide on the other, resumes once (`createDualReplicaHarness`).
- [ ] Reconstruct case: a recorded conversation with a network ask reconstructs with zero drift and `network_blocked` absent from requests.
- [ ] Commit `feat(kernel): ask the device owner when a command is refused a domain`.

### Task P1.8: Kernel — IM approval card for network asks

**Files:**
- Modify: `packages/kernel/src/channels/cards.ts` (`approvalCard` for kind `network`: title from §6.5, `toolName: "Bash"`, `inputPreview` = host list + clipped redacted command, `scopes` from the approval, `scopeLabels` zh/en, state `skipped`), `packages/kernel/src/channels/actions.ts` (pass `via: "im"`; an anonymous speaker cannot decide network asks), `packages/kernel/src/channels/outbound.ts` (skipped state update)
- Test: `packages/kernel/test/channels/*` fake-im approval card tests (owner click, other member click, text fallback)
- [ ] Commit `feat(kernel): network ask cards in IM channels`.

### Task P1.9: Design + web — network approval block and blocked facts

**Files:**
- Modify: `packages/design/src/conversation/hitl.tsx` (`ApprovalBlock` gains `network?: { hosts: { host: string; registrable: string }[]; command: string; description?: string }`, `scopeLabels`, `scopeHints`, host checkboxes when > 1 host, state `skipped`; primary button = first scope), packages/design i18n for hitl, `apps/web/src/components/ApprovalCard.tsx` (network variant, `hosts` in the decision), `apps/web/src/lib/approvals.ts`, `apps/web/src/lib/conversations.ts` + `apps/web/src/lib/timeline.ts` (`network_blocked` → facts under the command row for `org` / `address` layers), `apps/web/messages/{zh,en}.json`, `apps/web/src/dev/catalog/conversation-blocks.tsx` (stories: one host, n hosts, once-only, decided variants, org / address facts)
- Create: `packages/design/src/conversation/registrable.ts` (registrable domain: last two labels, three for a small built-in list of multi-label public suffixes such as `co.uk`, `com.cn`; documented as a display aid, not security)
- Test: `packages/design/test/*` (hitl), `apps/web/test/timeline.test.ts`, approval card tests
- [ ] Copy exactly spec §6.5 (zh / en). Org-layer facts show text only in Phase 1 (the request button is P2.6).
- [ ] `pnpm check:web-ui`, `pnpm check:i18n`.
- [ ] Commit `feat(web): ask to allow a blocked domain in the conversation`.

### Task P1.10: Platform exclusions, docs, changesets, verify (Phase 1)

- [ ] `packages/kernel/src/platform/exclusions.ts`: the decision route reason mentions network asks ("a person must decide network access on their own device").
- [ ] Docs: `docs/design/spec.md` approval states (network variant, skipped), `packages/device/README.md` (`remoteGrants`, the policy op, audit lines), environments spec §8.2 amendment note, `writing-sandbox-providers` skill (`ExecResult.network` optional for providers).
- [ ] Changesets: plugin-sdk (minor), device, capybara.
- [ ] Zero-drift fixtures, `pnpm typecheck && pnpm lint && pnpm check && pnpm verify`; push; PR against `feat/network-ask-p0`.
- [ ] Note reference-set / visual impacts (approval block stories) in the PR; do not run the workflows.

---

## Phase 2 — org requests, 「不限网络」, task grants

### Task P2.1: Org-layer requests (`network_allowlist`)

**Files:**
- Create: `packages/kernel/src/migrations/0115_network_requests.sql` (`catalog_requests.detail jsonb`; kind check widened with `network_allowlist`; item check allows null item for it; unique pending index per org + host set hash optional)
- Modify: `packages/kernel/src/catalog/requests.service.ts` (`requestNetwork(orgId, accountId, { hosts, note?, conversationId?, agentId? })`, approve → merge hosts into the org's `sandboxEgress` (copying the deployment list when the org follows it; refused with `catalog.request_invalid` when the deployment egress is `none`), audit `org.settings_updated` with the request id), `packages/kernel/src/catalog/org-catalog.controller.ts` (`POST /api/v1/orgs/:orgId/catalog-requests/network`, `@OrgAction("catalog.request")`), schemas, `packages/kernel/src/inbox/inbox.service.ts` (views carry kind + hosts), `packages/kernel/src/platform/exclusions.ts` (human-only: "a member asks admins from a blocked command's card")
- Test: `packages/kernel/test/catalog/network-requests.http.test.ts`
- [ ] Commit `feat(kernel): members ask org admins to allow a domain`.

### Task P2.2: Device policy route for the owner (TRUST BOUNDARY)

**Files:**
- Modify: `packages/kernel/src/devices/devices.controller.ts` (`POST /api/v1/orgs/:orgId/devices/:id/policy` body `{ add?: string[]; remove?: string[]; network?: "allowlist" | "open" }`, owner only via `DeviceAccess.usable`, `HUMAN_ONLY`), `devices.service.ts` (calls `DevicePolicyService.apply` with `via: "web"`; `add` accepts wildcards here (spec §7) and `open` only when the summary says `remoteGrants: owner`; returns the outcome; device view gains `network.recent` = last 10 `device.policy_changed` audit rows), `packages/kernel/src/devices/dto.ts`, `devices.schemas.ts`, `packages/kernel/src/platform/exclusions.ts` (human-only: "a person changes their own machine's network policy")
- Note: `add` of a wildcard needs the device to accept wildcards from the cloud when the request comes from the device page: `DevicePolicyArgs.source.via = "web"` + no `approvalId` → device accepts wildcards (P1.3 refuses wildcards only with an `approvalId`). Adjust P1.3's rule accordingly in this task if needed.
- Test: `packages/kernel/test/devices/device-policy.http.test.ts` (owner ok; other member 404; PAT 403; offline 409 `device.offline`; refused → 409 `device.policy_refused`)
- [ ] Commit `feat(kernel): the device owner edits the device's network policy from the web`.

### Task P2.3: Device CLI — 「不限网络」 and `remoteGrants`

**Files:**
- Modify: `packages/device/src/commands/policy.ts`, `packages/device/src/args.ts` (`--yes`), `packages/device/README.md`
- Test: `packages/device/test/policy.test.ts`, `args.test.ts`
- [ ] `policy set network open` prints the risk text (spec §7, English) and requires `--yes` (or an interactive `y` when stdin is a TTY); `allowlist` always accepted; `policy set remoteGrants owner|off`.
- [ ] Commit `feat(device): switch a device to no network limit from the command line`.

### Task P2.4: Scheduled task network grants

**Files:**
- Modify: `packages/kernel/src/schedules/grant-rules.ts` (`networkGrantRefusal(host, { limits, deviceSummary })` → `not_grantable` | `needs_admin` | `device_refuses`), `packages/kernel/src/schedules/scheduled-tasks.service.ts` (`addGrants` accepts `network:<host>`; `attentionFor` network branch with `needsAdmin`), `packages/kernel/src/local-devices/network-grants.ts` (task branch: `source.kind = "task"`), `packages/kernel/src/tools/pipeline.ts` / `network-asks.ts` (unattended: a task-granted host is never asked; `org` layer records `network:<host>` with needs-admin), `packages/kernel/src/tools/approvals.service.ts` (`keepTrialGrant` for network once-decisions by the task creator in a trial run), schedules schemas / DTOs, web task form API types
- Test: `packages/kernel/test/schedules/network-grants.test.ts`
- [ ] Commit `feat(kernel): scheduled tasks carry pre-approved network domains`.

### Task P2.5: Web — device page network section and 「不限网络」

**Files:**
- Modify: `apps/web/src/app/(app)/devices/[id]/view.tsx` (network section: local allowlist with remove, add field (wildcards ok), the switch with a confirm `Dialog` carrying the risk text, `remoteGrants` read-only with the CLI hint, recent changes), `apps/web/src/lib/devices.ts` (`updateDevicePolicy`), `apps/web/src/components/conversation/useSelection.ts` / `packages/design/src/conversation/composer-options.tsx` (「不限网络」 warn badge in the picker), `apps/web/messages/{zh,en}.json`
- Test: `apps/web/test/devices*.test.tsx`
- [ ] Commit `feat(web): device network settings on the device page`.

### Task P2.6: Web — ask an admin, prefilled settings, inbox, task form

**Files:**
- Modify: `apps/web/src/lib/timeline.ts` + the network facts component (org layer: 「请管理员添加」 for members → `POST …/catalog-requests/network` with an optional note; 「去组织设置添加」 link for org admins → `/settings/sandbox?allowHost=<host>`; deployment `none` text), `apps/web/src/app/(app)/settings/sandbox/{page,view}.tsx` (`allowHost` search param prefills the draft), `apps/web/src/app/(app)/inbox/view.tsx` (request rows of kind `network_allowlist`), scheduled task form (a "Network access" list of hosts; grants shown on the task page), messages
- Test: `apps/web/test/*` for each
- [ ] Commit `feat(web): ask an admin to allow a domain and pre-approve task domains`.

### Task P2.7: Docs, changesets, verify (Phase 2)

- [ ] Docs: device README (`network open`, `remoteGrants`), scheduled tasks spec §7 amendment note, `docs/design/spec.md` (device page network section).
- [ ] Changesets; `pnpm typecheck && pnpm lint && pnpm check && pnpm verify`; push; PR against `feat/network-ask-p1`.

## Phase 3 (later, not in these PRs)

Cloud sandboxes (`sandbox-docker` proxy reports into `ExecResult.network`; `sandbox-e2b` documented as unable) and Docker device mode behind a domain proxy (spec §4.2, §11).
