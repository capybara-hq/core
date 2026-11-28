# Browser Loopback Port Grants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task, layered with `wave-planned-subagent-development` (the wave table below). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The device's browser service reaches one approved loopback port (`127.0.0.1` / `::1` / `localhost` + exact port) for one conversation, granted with no person under Full access, by the review model under Approve for me, by the person's one click otherwise, and refused wherever an outside-sandbox escalation would be refused.

**Architecture:** A new crossing kind `loopback-port` reuses `approverForCrossing`, the classifier and the network-ask approval/rerun path; a grant row (`capybara.device_loopback_grants`) is the record, and the live port set per `(device, service)` travels whole with every `service.ensure` to capybara-device, whose patched sandbox-runtime proxy gains one exact carve-out `allowedLoopbackPorts`. The service's `networkKey` includes the set, so a change restarts the service through the existing supervisor path. The browser daemon adds a per-tab conversation check on top.

**Tech Stack:** TypeScript, NestJS + Kysely (kernel), PostgreSQL RLS, BullMQ via the transactional outbox, `@anthropic-ai/sandbox-runtime@0.0.81` pnpm patch, Playwright (browser daemon), React (web), vitest.

**Spec:** `docs/superpowers/specs/2026-11-28-browser-loopback-port-grants-design.md` (approved 2026-11-28, binding). Read it before any task. Area skills to read per task are named in each task.

## Global Constraints

- **Common case first (maintainer emphasis):** local dev + agent/tester browser testing must work end to end with no person under Full access (`approverForCrossing` → `none`) and under Approve for me (review model). The owner panel is a one-click fallback. Live acceptance (Task 12) proves each profile.
- A grant names only `127.0.0.1`, `::1` (also written `[::1]`) or `localhost` (case-insensitive), one integer port 1–65535. Every other loopback literal (`127.0.0.2`), private, CGNAT, link-local and metadata address stays closed. No ranges, wildcards, whole-device or all-conversation grants.
- Grant tuple `(org, device, service id, root conversation, port)`; sub-agents use their root's grants. Lifetime `LOOPBACK_GRANT_TTL_HOURS = 24` from issue, or conversation deletion, or explicit revoke, or the bounding outside-sandbox setting switched off — first wins.
- Ceiling = exactly where an outside-sandbox escalation is refused: platform/org/device/provider outside-sandbox setting off, owner ceiling off, unattended run, provider without loopback support. The ask is never offered where it would be refused; the note says why.
- Approver = `approverForCrossing({ crossing: "loopback-port" })`, same rules as `outside-sandbox` (sub-agent under Full access → review model). A person ask is decided only by the device owner, in a signed-in session (as network asks).
- Well-known database ports `5432, 3306, 6379, 27017` are allowed but flagged (`database: true`) and named in the approval and review texts ("a local database port").
- At most `LOOPBACK_MAX_PORTS_PER_SERVICE = 32` live ports per `(device, service)` (the sent set is bounded); a grant beyond that is refused with an actionable error.
- Model-facing text is English and states mechanism (spec §5.5); zh UI says 智能体 / 平台, never `agent` or 企业 (`pnpm check:i18n`).
- No DriftReason: every new model-visible word goes into the call's `tool_result` (already logged); the permission-profile system text (`runtime/context/permission-profile.ts`) is **not** changed.
- No device protocol bump: `DEVICE_PROTOCOL_VERSION` stays 6; capybara-device advertises hello feature `loopbackPorts`, and device-local sends `network.loopbackPorts` only to a machine that advertises it.
- Multi-replica: grant writes in `@Transactional()`; every refresh/narrowing is an outbox job (`device-loopback-refresh`) with a deterministic id without `:`; expiry is a `@LockedInterval` job under `WorkerModule`; no in-process state.
- Kernel conventions: `@Injectable`, explicit `@Inject`, `asPlatform(reason)` + `// org-filter:` marker for any deployment-wide query (`check:org-filter`).
- Public API: SDK change → `pnpm gen:sdk-api` + changeset bumping `@capybara-hq/plugin-sdk`; kernel/device/web changes → changesets for `@capybara-hq/kernel`, `@capybara-hq/device`, `@capybara-hq/capybara` (images).
- Tests: new unit / container test files join `packages/kernel/test/unit-tests.json` / `container-tests.json` (device OS tests: `packages/device/test/os-tests.json`) in the same change; no fixed sleeps, no per-test timeouts.

## Cross-repo ordering and consuming the unreleased SDK

- The plugins repo pins core packages exactly in its root `package.json` devDependencies and **`pnpm-workspace.yaml` `overrides`** (one plugin-sdk instance: `@capybara-hq/plugin-sdk`, `kernel`, `testing`, `plugin-model-fake`, `plugin-tools` all overridden to exact versions; plugin `package.json`s carry `^0.1.0-rc.N` ranges). Its AGENTS.md forbids committed `workspace:` / `file:` / `link:` references to core.
- **During development** (before the core release) a plugins implementer may consume the unreleased core packages locally only: in core run `pnpm --filter @capybara-hq/plugin-sdk pack` (likewise `kernel`, `testing`, `plugin-model-fake`) into the scratchpad, then in the plugins worktree temporarily point the **`pnpm-workspace.yaml` overrides** (not individual package.json files — the override keeps one instance) at those `file:` tarballs and `pnpm install`. These edits and the lockfile change are **never committed**; `git checkout pnpm-workspace.yaml pnpm-lock.yaml` before committing.
- **Release order:** core PR merged → Version Packages PR released (plugin-sdk, kernel, testing, plugin-model-fake, device, images `@capybara-hq/capybara`) → plugins PR (Task P0) bumps root devDependencies + every `overrides` entry to the released versions and the plugin ranges, then P1–P3 land in the same plugins PR → plugins Version Packages (device-local, browser) → upgrade local dev and prod per the standing grants.
- Plugins tasks are wave P (after the core release); P0 first.

## Review Focus

1. **Granted port, wrong conversation.** A second conversation on the same device gets the union carve-out at the proxy; its tab must still get the blocked result. Pinned in Task P2 (`refuses a granted port for another root's tab`).
2. **`localhost` resolving elsewhere / DNS rebinding.** A name that resolves to 127.0.0.1 (not literally `localhost`) and `localhost` itself must never go through DNS. Pinned in Task 2 (`refuses a name that resolves to 127.0.0.1`, `dials localhost without the resolver`).
3. **Setting switched off while a grant is live.** Turning outside-sandbox off (platform, org, device owner) must narrow the running service without waiting 24 h. Pinned in Task 5 (`ceiling publication owes a refresh and the job revokes`) and Task 4 (owner ceiling off drops the ports from the effective key).
4. **Crash between grant commit and rerun.** A replica dying after the grant transaction must leave a resumable call (rerun at `attempt + 1`, not "result unknown") and a refreshed device. Pinned in Task 9 (`resumes a granted call as the rerun after a crash`).
5. **Older capybara-device.** A machine without the feature must not receive the unknown key (it answers `invalid`) and the model gets the update note. Pinned in Task P1 (`omits loopbackPorts for a machine without the feature`) and Task 9 (`notes an outdated device`).

---

## Wave table

| Task | Depends on | Files / areas | Risk | Wave |
|---|---|---|---|---|
| 1 SDK contract | — | `packages/plugin-sdk/src/{device-provider,device-operation,device-protocol,device-service,permissions,ctx}.ts`, `api/plugin-sdk.api.md` | high (trust-boundary contract) | 1 |
| 2 sandbox-runtime carve-out | — | `patches/@anthropic-ai__sandbox-runtime@0.0.81.patch`, `packages/device/test/mac-srt-network-patch.test.ts` | high (trust boundary) | 1 |
| 3 Migration + table type | — | `packages/kernel/src/migrations/0199_device_loopback_grants.sql`, `packages/kernel/src/db/kernel-schema.ts` | high (migration, RLS) | 1 |
| 4 capybara-device applies ports | 1, 2 | `packages/device/src/services/{ops,mac-launcher,supervisor}.ts`, `exec/{operation-types,operation-worker}.ts`, `staged-device.ts`, device tests | high (trust boundary) | 2 |
| 5 Kernel grants service, refresh, expiry, narrowing | 1, 3 | `packages/kernel/src/sandbox/{loopback-grants,loopback-expiry.job,device-services,device-sandbox,permission-ceiling-writes,sandbox.module}.ts`, `conversations/conversations.service.ts`, `runtime/maintenance.ts`, `infra/outbox/registry.ts`, `roles/worker.module.ts`, device-fake fixture | high (multi-replica) | 2 |
| 6 Review: crossing + classifier + events | 1 | `packages/kernel/src/sandbox/review/{permission-candidate,classifier,review.service}.ts`, `sandbox/permission-call-types.ts`, `conversations/events.ts` | high (approval authority) | 2 |
| 7 Web approval card | — (shape fixed here) | `apps/web/src/lib/approvals.ts`, `apps/web/src/components/ApprovalCard.tsx`, `apps/web/messages/{zh,en}.json`, `apps/web/test/approval-card.test.tsx` | normal | 2 |
| 8 ctx.deviceAccess: report, grant, revoke, list | 1, 5 | `packages/kernel/src/device-access/device-access.service.ts`, `tools/call-scope.ts`, `ctx/create-ctx.ts`, `extensions/host.ts` (caller), fake-device-access fixture, device-access tests | high (trust boundary) | 3 |
| 9 Ask, approval and rerun in the pipeline | 5, 6, 8 | `packages/kernel/src/tools/{loopback-asks,pipeline,approvals.service,network-asks}.ts`, `channels/cards.ts` (+ phrases), kernel tool tests | high (approval authority) | 4 |
| 10 Dual-replica: one grant, one refresh | 9 | `packages/kernel/test/device-access/loopback-grants.dual.test.ts`, `container-tests.json` | high (multi-replica) | 5 |
| 11 Docs, AGENTS.md, skills, changesets | 9 | `AGENTS.md`, `.agents/skills/{writing-device-providers,writing-extensions}/SKILL.md`, `packages/plugin-sdk/agent-docs/extensions.md` (if it lists deviceAccess), `.changeset/*.md` | normal | 5 |
| P0 Bump core packages | core released | plugins `package.json`, `pnpm-workspace.yaml`, `plugins/{browser,device-local}/package.json`, `pnpm-lock.yaml` | normal | P1 |
| P1 device-local | P0 | `plugins/device-local/src/{report,pg-rows,frames,provider}.ts`, tests | high (trust boundary) | P2 |
| P2 Browser daemon | P0 | `plugins/browser/daemon/{protocol,actions}.ts`, `plugins/browser/test/daemon/*` | high (per-tab check) | P2 |
| P3 Browser extension + panel | P2 | `plugins/browser/src/{index,browser,routes,i18n}.ts`, `plugins/browser/ui-src/panel/{panel,page,i18n}.ts`, browser tests, changesets | normal | P3 |
| 12 Live acceptance (Mac) | P3 released | none (checklist) | normal | P4 |

Review tiers: tasks 1–6, 8–10, P1, P2 are reviewed alone on the most capable model; 7, 11, P0, P3 batched per wave.

---

### Task 1: SDK contract

Skills: `writing-extensions`, `writing-device-providers`. Repo: core.

**Files:**
- Modify: `packages/plugin-sdk/src/device-provider.ts` (`ServiceBlockedHost` ~l.106, `DeviceProvider.ensureService` opts ~l.910)
- Modify: `packages/plugin-sdk/src/device-operation.ts` (`SandboxPermissionSupport` l.208, `SandboxSupportLimitedBy`)
- Modify: `packages/plugin-sdk/src/device-protocol.ts` (`DeviceFeature` l.63, `DEVICE_FEATURES` l.64, `parseSandboxPermissionSupport` l.837)
- Modify: `packages/plugin-sdk/src/device-service.ts` (new network type + parser)
- Modify: `packages/plugin-sdk/src/permissions.ts` (`deviceAccess` l.74, parse l.354)
- Modify: `packages/plugin-sdk/src/ctx.ts` (`DeviceAccessCtx` l.199, `DeviceAccessErrorCode` l.260)
- Modify: `packages/plugin-sdk/src/index.ts` (exports), `packages/plugin-sdk/api/plugin-sdk.api.md` (generated)
- Test: `packages/plugin-sdk/test/{device-provider,device-protocol,device-service,permissions-device-access}.test.ts`
- Create: `.changeset/loopback-sdk.md` (`@capybara-hq/plugin-sdk`: minor-in-pre, "ctx.deviceAccess loopback port grants")

**Interfaces — Produces:**
```ts
// device-provider.ts
export const LOOPBACK_GRANT_HOSTS: readonly ["127.0.0.1", "::1", "localhost"];
export function isLoopbackGrantHost(host: string): boolean; // also "[::1]", case-insensitive "LOCALHOST"
export const LOOPBACK_DATABASE_PORTS: readonly number[]; // [5432, 3306, 6379, 27017]
export const LOOPBACK_MAX_PORTS_PER_SERVICE = 32;
export interface ServiceBlockedHost {
  host: string;
  layer: NetworkBlockLayer;
  /** The refused port; absent: the HTTPS port (443). */
  port?: number;
  /** The closed address class when `layer` is `address` and known (`classifyAddress`, or "loopback" for `localhost`). */
  class?: AddressClass;
}
// DeviceProvider.ensureService opts:
opts?: { ifRunning?: boolean; loopbackPorts?: readonly number[] }
// device-operation.ts
SandboxPermissionSupport["network"] gains `readonly loopbackPorts?: boolean` // absent = false
SandboxSupportLimitedBy gains `readonly loopbackPorts?: "device-update"`     // display only
// device-protocol.ts
export type DeviceFeature = "networkReport" | "projects" | "loopbackPorts";
// device-service.ts
export interface DeviceServiceNetwork {
  kind: "open-public" | "allowlist";
  hosts: string[];
  /** Live granted loopback ports, sorted ascending, unique, 1–65535, ≤ LOOPBACK_MAX_PORTS_PER_SERVICE. */
  loopbackPorts?: number[];
}
export function parseLoopbackPorts(value: unknown, what: string): number[]; // throws TypeError
// permissions.ts
deviceAccess?: { services: string[]; loopbackPorts?: boolean };
// ctx.ts
export type LoopbackGrantSource = "human" | "review-model" | "full-access" | "owner-panel";
export interface LoopbackGrantView { port: number; source: LoopbackGrantSource; expiresAt: string; database: boolean }
DeviceAccessCtx gains:
  grantLoopbackPort(scope: DeviceAccessScope & { service: string; port: number }): Promise<LoopbackGrantView>;
  revokeLoopbackPort(scope: DeviceAccessScope & { service: string; port: number }): Promise<void>;
  loopbackPorts(scope: DeviceAccessScope & { service: string }): Promise<LoopbackGrantView[]>;
reportBlockedHosts opts gains `service?: string` (the declared service the refusals came from; required for a loopback ask when the extension declares more than one service).
DeviceAccessErrorCode gains "loopback_not_declared" | "loopback_unavailable" | "loopback_limit".
```

Decisions: `loopbackPorts` in the support is **optional** in the type and parser (absent = false), so a provider built on the previous SDK still parses after the kernel upgrades first (release order). `parseSandboxPermissionSupport` keeps strict keys: add `"loopbackPorts"` to the allowed network keys (l.866) and `"loopbackPorts"` to the limitedBy keys (l.896); `loopbackPorts: true` requires `outsideSandbox: true` and `boundary: "operation"` (else throw "loopbackPorts needs outsideSandbox on an operation boundary"); `limitedBy.loopbackPorts` only with `network.loopbackPorts` false. `permissions.deviceAccess` keys may be `services` and `loopbackPorts` (boolean) only; error text becomes `permissions.deviceAccess must be { services: string[], loopbackPorts?: boolean }`. JSDoc on each new `DeviceAccessCtx` method states: owner only, the scope conversation's root holds the grant, the same ceilings as an outside-sandbox escalation, recorded with source `owner-panel` (grant), 24 h lifetime.

- [ ] **Step 1: Write the failing tests**

```ts
// device-provider.test.ts
it("names exactly the three loopback grant hosts", () => {
  for (const h of ["127.0.0.1", "::1", "[::1]", "localhost", "LocalHost"]) expect(isLoopbackGrantHost(h)).toBe(true);
  for (const h of ["127.0.0.2", "0.0.0.0", "10.0.0.1", "169.254.169.254", "localhost.", "a.localhost", "::ffff:127.0.0.1"]) expect(isLoopbackGrantHost(h)).toBe(false);
});
// device-service.test.ts
it("parses loopback ports strictly", () => {
  expect(parseLoopbackPorts([3999, 3000], "p")).toEqual([3000, 3999]);
  for (const bad of [[0], [65536], [3.5], ["3000"], [3000, 3000], Array.from({ length: 33 }, (_, i) => i + 1), "x"])
    expect(() => parseLoopbackPorts(bad, "p")).toThrow(TypeError);
});
// device-protocol.test.ts
it("parses network.loopbackPorts and its limitedBy", () => {
  const s = parseSandboxPermissionSupport({ ...OPERATION_SUPPORT, network: { ...OPERATION_SUPPORT.network, loopbackPorts: true } });
  expect(s.network.loopbackPorts).toBe(true);
  expect(parseSandboxPermissionSupport(OPERATION_SUPPORT).network.loopbackPorts).toBeUndefined();
  expect(() => parseSandboxPermissionSupport({ ...OPERATION_SUPPORT, outsideSandbox: false, network: { ...OPERATION_SUPPORT.network, loopbackPorts: true } })).toThrow(/outsideSandbox/);
  expect(parseSandboxPermissionSupport({ ...OPERATION_SUPPORT, limitedBy: { loopbackPorts: "device-update" } }).limitedBy?.loopbackPorts).toBe("device-update");
});
it("keeps the loopbackPorts hello feature", () => { /* features: ["loopbackPorts", "bogus"] → ["loopbackPorts"] */ });
// permissions-device-access.test.ts
it("accepts deviceAccess.loopbackPorts and refuses other keys", () => {
  expect(validatePermissions({ deviceAccess: { services: ["browser"], loopbackPorts: true } })).toEqual([]);
  expect(validatePermissions({ deviceAccess: { services: ["browser"], loopbackPorts: "yes" } })).not.toEqual([]);
  expect(validatePermissions({ deviceAccess: { services: ["browser"], ports: [1] } })).not.toEqual([]);
});
```
(Use the existing fixture/helper names in each file; `OPERATION_SUPPORT` stands for the file's valid operation-boundary support literal.)

- [ ] **Step 2:** `pnpm exec vitest run packages/plugin-sdk/test` → the new tests FAIL (missing exports / keys refused).
- [ ] **Step 3:** Implement the interfaces above; export the new names from `src/index.ts`.
- [ ] **Step 4:** `pnpm exec vitest run packages/plugin-sdk/test` → PASS; `pnpm gen:sdk-api`; `pnpm typecheck` (kernel compiles: `DeviceAccessService` must satisfy the widened `DeviceAccessCtx` — add stubs that throw `DeviceAccessError("capability_missing", …)` in `ctx/create-ctx.ts` only if typecheck requires; Task 8 replaces them).
- [ ] **Step 5:** Commit `feat(sdk): loopback port grant contract` with the changeset.

---

### Task 2: sandbox-runtime exact loopback carve-out

Skills: `writing-device-providers` (socket proxy / closed classes). Repo: core.

**Files:**
- Modify: `patches/@anthropic-ai__sandbox-runtime@0.0.81.patch` (regenerate with `pnpm patch @anthropic-ai/sandbox-runtime@0.0.81` → edit `dist/sandbox/{sandbox-config,sandbox-manager,resolved-address-guard}.js` → `pnpm patch-commit <dir>`)
- Test: `packages/device/test/mac-srt-network-patch.test.ts` (unit, node project; not an OS test)

**Interfaces — Produces:** network config option `allowedLoopbackPorts?: number[]` (zod: `z.array(z.number().int().min(1).max(65535)).max(32).optional()`, description "Strict mode only: loopback ports the proxy dials for exactly 127.0.0.1, ::1 and localhost"). Guard API gains `loopbackCarveOut(hostname: string, port: number): string | undefined` returning the address to dial (`"127.0.0.1"` or `"::1"`) or undefined.

Algorithm (fixed here, the patch shape is otherwise the builder's): in `filterNetworkRequest`, **before** the strict literal check (`literalWhy`), if `config.network.allowedLoopbackPorts` includes `port` and the canonical host is `127.0.0.1`, `::1` or `localhost` (exact, case-insensitive; never a DNS lookup) → allow and dial: `127.0.0.1` for `127.0.0.1` and `localhost`, `::1` for `::1`. Implement the dial target through the guard's lookup for that connection (the `lookupFor(port)` path returns the fixed loopback address for these three hosts on a listed port, bypassing `resolve`, the DoH resolver and `denial`). Nothing else changes: any other loopback port, `127.0.0.2`, private / CGNAT / link-local / metadata literals, and a name whose DNS answer is loopback stay refused with today's reasons. Without `resolvedAddressStrict` the option is ignored.

- [ ] **Step 1: Failing tests** in a new `describe("the patched runtime's exact loopback carve-out")`:

```ts
it("allows exactly 127.0.0.1, [::1] and localhost on a listed port", async () => {
  const filter = await strictFilter({ allowedLoopbackPorts: [3999] }); // helper building the patched config + filterNetworkRequest
  for (const host of ["127.0.0.1", "::1", "localhost", "LOCALHOST"]) expect(await filter(3999, host)).toEqual({ allowed: true });
});
it("refuses another port, another loopback literal, a private literal and metadata", async () => {
  const filter = await strictFilter({ allowedLoopbackPorts: [3999] });
  expect(await filter(4000, "127.0.0.1")).toMatchObject({ allowed: false, reason: expect.stringMatching(/^address is /) });
  for (const host of ["127.0.0.2", "10.0.0.1", "169.254.169.254", "0.0.0.0"]) expect((await filter(3999, host)).allowed).toBe(false);
});
it("refuses a name that resolves to 127.0.0.1", async () => {
  const guard = createResolvedAddressGuard({ ...STRICT, allowedLoopbackPorts: [3999], resolve: answer("127.0.0.1") });
  await expect(dial(guard, "dev.example.test", 3999)).rejects.toThrow(/resolved to/);
});
it("dials localhost without the resolver", async () => {
  const resolve = vi.fn();
  const guard = createResolvedAddressGuard({ ...STRICT, allowedLoopbackPorts: [3999], resolve });
  expect(await lookup(guard, "localhost", 3999)).toEqual([{ address: "127.0.0.1", family: 4 }]);
  expect(resolve).not.toHaveBeenCalled();
});
it("ignores allowedLoopbackPorts without strict mode", async () => { /* upstream behaviour unchanged */ });
it("accepts the option in the network config schema", async () => {
  const { NetworkConfigSchema } = await load("sandbox-config.js");
  expect(NetworkConfigSchema.safeParse({ ...BASE, allowedLoopbackPorts: [3999] }).success).toBe(true);
  expect(NetworkConfigSchema.safeParse({ ...BASE, allowedLoopbackPorts: [0] }).success).toBe(false);
});
```
(Reuse the file's existing `load`, lookup and filter-source helpers; add the two small helpers they need.)

- [ ] **Step 2:** `pnpm exec vitest run packages/device/test/mac-srt-network-patch.test.ts` → new tests FAIL.
- [ ] **Step 3:** Patch the runtime; `pnpm install` applies it.
- [ ] **Step 4:** Same command → PASS; also `pnpm exec vitest run packages/device/test/srt-patch.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat(device): exact loopback port carve-out in the sandbox proxy patch`.

---

### Task 3: Migration and table type

Skills: `writing-migrations`. Repo: core.

**Files:**
- Create: `packages/kernel/src/migrations/0199_device_loopback_grants.sql` (re-check the last number on rebase; take the next free one)
- Modify: `packages/kernel/src/db/kernel-schema.ts` (`DeviceLoopbackGrantsTable`, registered in `KernelSchema` as `device_loopback_grants`)
- Test: `packages/kernel/test/db/` migration test covered by the existing migrate/`check:org-filter` runs; add `packages/kernel/test/sandbox/loopback-grants.test.ts` in Task 5.

Columns (spec §6 plus three resolution columns, see Rulings):
```sql
CREATE TABLE IF NOT EXISTS device_loopback_grants (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  service_id text NOT NULL,                  -- `<extension>.<name>`
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, -- the root
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  source text NOT NULL CHECK (source IN ('human','review-model','full-access','owner-panel')),
  approval_id text REFERENCES approvals(id) ON DELETE SET NULL,
  run_id text, call_id text, attempt integer, -- the call that asked (null for owner-panel)
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IN ('revoked','expired','conversation-deleted','outside-sandbox-off'))
);
CREATE UNIQUE INDEX IF NOT EXISTS device_loopback_grants_live_uidx
  ON device_loopback_grants (device_id, service_id, conversation_id, port) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS device_loopback_grants_expiry_idx ON device_loopback_grants (expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS device_loopback_grants_call_idx ON device_loopback_grants (run_id, call_id) WHERE run_id IS NOT NULL;
DROP POLICY IF EXISTS org_scope ON device_loopback_grants;
CREATE POLICY org_scope ON device_loopback_grants USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));
```
Header comment cites the spec. Kysely type: `revoke_reason: Generated<…|null>`, timestamps `Ts` / `TsNullable` like neighbours.

- [ ] **Step 1:** Write the SQL and type.
- [ ] **Step 2:** `pnpm check` (org-filter, migration checks) and `pnpm --filter @capybara-hq/kernel exec capybara migrate` against `docker/compose.dev.yaml` postgres → applies; re-run → no-op.
- [ ] **Step 3:** `pnpm typecheck` → PASS. Commit `feat(kernel): device_loopback_grants table`.

---

### Task 4: capybara-device applies the port set

Skills: `writing-device-providers` (services, socket proxy). Repo: core.

**Files:**
- Modify: `packages/device/src/services/ops.ts` (`service.ensure` network parse l.141: `keys(n, ["kind","hosts","loopbackPorts"])`, `parseLoopbackPorts`)
- Modify: `packages/device/src/services/supervisor.ts` (`networkKey` l.270 and `ServiceLauncher.networkKey` param type → `DeviceServiceNetwork | undefined`)
- Modify: `packages/device/src/services/mac-launcher.ts` (`networkKey` l.72; grant `loopbackPorts` l.99-107)
- Modify: `packages/device/src/exec/operation-types.ts` (`LocalOperationGrant.loopbackPorts?: readonly number[]`)
- Modify: `packages/device/src/exec/operation-worker.ts` (`macNetworkConfig` l.274)
- Modify: `packages/device/src/staged-device.ts` (features l.449)
- Test: `packages/device/test/services.test.ts`, `packages/device/test/mac-srt-network-patch.test.ts` (the "macOS worker's network configuration" describe), `packages/device/test/staged-device.test.ts`, `packages/device/test/mac-service-install.test.ts` (OS, already in `os-tests.json`)
- Create: `.changeset/loopback-device.md` (`@capybara-hq/device`)

**Interfaces — Consumes:** Task 1 `DeviceServiceNetwork`, `parseLoopbackPorts`, `DeviceFeature`; Task 2 `allowedLoopbackPorts`.
**Produces:**
- `networkKey(n)` → unchanged string when `loopbackPorts` is absent or empty; otherwise `<old>;loopback:<p1>,<p2>` (sorted).
- mac-launcher: effective ports = `ceiling.outsideSandbox ? req.network.loopbackPorts ?? [] : []` (the owner ceiling bounds them on the machine too); the key and the grant use the effective ports; `macNetworkConfig(grant)` adds `allowedLoopbackPorts: [...grant.loopbackPorts]` to `network` only when non-empty and never in the `allowPrivate` seam path's absence of strict (strict is always on in production).
- Hello: `features` includes `"loopbackPorts"` exactly when `mode === "os" && platform === "darwin"` (the mac service launcher exists).

- [ ] **Step 1: Failing tests**

```ts
// services.test.ts
it("parses network.loopbackPorts and refuses a bad one", () => { /* parseServiceOp({op:"service.ensure", spec, network:{kind:"allowlist",hosts:[],loopbackPorts:[3999]}}) → network.loopbackPorts [3999]; [70000] → invalid */ });
it("restarts a running service when its loopback ports change, and keeps it when they do not", async () => {
  // ensure with {kind:"allowlist",hosts,loopbackPorts:[]} → start; same again → kept (starts 1);
  // with loopbackPorts:[3999] → restarted (starts 2); with [3999] again → kept
});
// mac-srt-network-patch.test.ts (worker config)
it("adds allowedLoopbackPorts only for granted ports", () => {
  expect(macNetworkConfig({ hosts: [], loopbackPorts: [3999] }).network.allowedLoopbackPorts).toEqual([3999]);
  expect(macNetworkConfig({ hosts: [] }).network).not.toHaveProperty("allowedLoopbackPorts");
});
// mac-launcher (unit in services.test.ts with a fake owner ceiling)
it("drops loopback ports from the key while the owner ceiling forbids running outside the sandbox", async () => { /* key has no ;loopback: */ });
// staged-device.test.ts
it("advertises loopbackPorts only on a macOS host device", () => { /* darwin os → includes; linux → not */ });
```

- [ ] **Step 2:** `pnpm exec vitest run packages/device/test/services.test.ts packages/device/test/mac-srt-network-patch.test.ts packages/device/test/staged-device.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS. On a Mac also `pnpm exec vitest run packages/device/test/mac-service-install.test.ts` → PASS, and add to `mac-open-network.test.ts` (OS list) one real-Seatbelt case `reaches a granted loopback port from a restricted exec and not another` (listener on 127.0.0.1:<free>, exec `curl` through the proxy with `loopbackPorts:[free]` → 200; port+1 listener → refused).
- [ ] **Step 5:** Commit `feat(device): apply granted loopback ports to device services`.

---

### Task 5: Kernel grants service, refresh, expiry and narrowing

Skills: `writing-kernel-api` (outbox, LockedInterval, transactions), `writing-device-providers` (DeviceServices, effectiveDeviceSandbox). Repo: core.

**Files:**
- Create: `packages/kernel/src/sandbox/loopback-grants.ts`
- Create: `packages/kernel/src/sandbox/loopback-expiry.job.ts`
- Modify: `packages/kernel/src/sandbox/device-sandbox.ts` (`DeviceSandboxProviderLayer.network.loopbackPorts?`, `DeviceSandbox.loopbackPorts`, `providerLayerOf` l.236, `effectiveDeviceSandbox` l.159)
- Modify: `packages/kernel/src/sandbox/device-services.ts` (`ensure` l.35, `ifRunningEnsure` l.88; new `refreshLoopback`)
- Modify: `packages/kernel/src/sandbox/permission-ceiling-writes.ts` (`publishLocked`: owe refreshes)
- Modify: `packages/kernel/src/conversations/conversations.service.ts` (deletion ~l.1106)
- Modify: `packages/kernel/src/runtime/maintenance.ts` (dispatch `device-loopback-refresh`), `packages/kernel/src/infra/outbox/registry.ts`, `packages/kernel/src/sandbox/sandbox.module.ts`, `packages/kernel/src/roles/worker.module.ts`
- Modify: `packages/kernel/test/fixtures/plugins/device-fake/index.ts` (support `network.loopbackPorts: true` in `FAKE_PERMISSION_SUPPORT`; record each `ensureService` opts `loopbackPorts` in the ops log; export `readFakeServiceLoopbackPorts(root): Promise<number[][]>`)
- Test: `packages/kernel/test/sandbox/device-sandbox.test.ts` (unit list), `packages/kernel/test/sandbox/loopback-grants.test.ts` (integration), `packages/kernel/test/sandbox/device-services.test.ts`

**Interfaces — Consumes:** Task 1 types; Task 3 table.
**Produces:**
```ts
// sandbox/loopback-grants.ts
export const LOOPBACK_GRANT_TTL_HOURS = 24;
export const LOOPBACK_REFRESH_JOB = "device-loopback-refresh";
export interface LoopbackRefreshJobData { orgId: string; deviceId: string; serviceId: string }
export const loopbackRefreshJobId = (deviceId: string, serviceId: string, change: string) => `dlr-${deviceId}-${serviceId}-${change}`; // no ':'
export interface LoopbackGrantKey { orgId: string; deviceId: string; serviceId: string; rootConversationId: string; port: number }
export interface LoopbackGrantRow { id: string; port: number; source: LoopbackGrantSource; expiresAt: string; runId: string | null; callId: string | null; attempt: number | null }
/** Why a loopback grant is refused on this device now, in the note's words; null when grantable. */
export function loopbackRefusal(box: DeviceSandbox, support: SandboxPermissionSupport | null, escalationRefusal: string | null | undefined): string | null;
/** Owes one refresh per (device, service) with live grants under the subject (plain function, like `oweConversationDeletedNotice`). */
export async function oweLoopbackRefreshes(db: KernelSchemaDb, outbox: Pick<OutboxService,"add">, under: { level: "platform"|"org"|"device"|"root"; orgId?: string; deviceId?: string; rootConversationId?: string }, change: string): Promise<number>;
/** Revokes a deleted root's live grants (reason conversation-deleted) and owes their refreshes, in the caller's transaction. */
export async function revokeLoopbackGrantsOfConversation(db: KernelSchemaDb, outbox: Pick<OutboxService,"add">, target: { orgId: string; rootConversationId: string }): Promise<void>;
@Injectable() export class LoopbackGrants {
  /** In the caller's transaction (`propagation: "mandatory"`): expire stale rows of the key, insert (or return the live row), audit `device.loopback_granted`, owe the refresh. Throws LoopbackLimitError past 32 live ports. */
  grantIn(key: LoopbackGrantKey, by: { source: LoopbackGrantSource; actorAccountId: string | null; approvalId?: string; call?: { runId: string; callId: string; attempt: number } }): Promise<LoopbackGrantRow>;
  @Transactional() revoke(key: LoopbackGrantKey, actorAccountId: string): Promise<boolean>; // audit device.loopback_revoked {reason:"revoked"}
  livePorts(orgId: string, deviceId: string, serviceId: string): Promise<number[]>; // sorted, unique, not revoked, expires_at > now()
  liveForRoot(orgId: string, deviceId: string, serviceId: string, rootConversationId: string): Promise<LoopbackGrantRow[]>;
  forCall(runId: string, callId: string): Promise<LoopbackGrantRow | null>; // org-filter: runtime's own run
  /** The refresh job: revoke the device's live grants (reason outside-sandbox-off, audited) when `loopbackRefusal` is non-null now, then `DeviceServices.refreshLoopback`. */
  refresh(data: LoopbackRefreshJobData, signal: AbortSignal): Promise<void>;
  /** Expiry pass: mark live rows past expires_at revoked (reason expired) under asPlatform, owe one refresh per (device, service). */
  expireDue(): Promise<number>;
}
// device-sandbox.ts
DeviceSandbox gains `loopbackPorts: boolean` = outsideSandbox && provider.network.loopbackPorts === true
// device-services.ts
ensure / ifRunningEnsure pass `{ loopbackPorts: await this.loopback.livePorts(use.orgId, use.deviceId, name) }` to `p.ensureService` (always, possibly []; a provider without support ignores it);
refreshLoopback(orgId: string, deviceId: string, name: string, signal: AbortSignal): Promise<DeviceServiceStatus | null>; // an ifRunning ensure only (no applyLimitsIfRunning)
```

Refusal texts (`loopbackRefusal`, in this order): `escalationRefusal` non-null → `running outside the sandbox is not possible here (${escalationRefusal})`; `support?.network.loopbackPorts !== true && support?.limitedBy?.loopbackPorts === "device-update"` → `capybara-device on this device is too old; update capybara-device to let the browser reach local ports`; provider without support → `this device's provider cannot open a local port to a device service`; else null.

Expiry job: `@LockedInterval(LOOPBACK_EXPIRY_JOB = "device-loopback-expiry", () => 60_000)` in `loopback-expiry.job.ts`, provided only under `WorkerModule`. Outbox registry entry for `device-loopback-refresh`: queue `cap-kernel-maintenance`, `processedIn: "packages/kernel/src/runtime/maintenance.ts"`, idempotent "the refresh sends the whole live set to an ifRunning ensure; a repeat sends the same set and the machine keeps the service", `opts: { attempts: 3, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: true, removeOnFail: true }`. Change ids: `g<grantId>` (grant), `r<grantId>` (revoke / expiry / deletion), `c<level>-<subjectId>-<epoch>` (ceiling publication, the epoch after `bumpLocked`). `publishLocked` calls `oweLoopbackRefreshes` whenever `revoke !== false` (every narrowing writer goes through it). Deletion: `revokeLoopbackGrantsOfConversation` next to `oweConversationDeletedNotice` in the deleting transaction.

- [ ] **Step 1: Failing tests**

```ts
// device-sandbox.test.ts (unit)
it("opens loopback ports only with outside-sandbox and provider support", () => {
  expect(effectiveDeviceSandbox(PLATFORM_ON, {}, DEVICE, { ...OP_PROVIDER, network: { ...OP_PROVIDER.network, loopbackPorts: true } }).loopbackPorts).toBe(true);
  expect(effectiveDeviceSandbox(PLATFORM_OFF, {}, DEVICE, SUPPORTING).loopbackPorts).toBe(false);
  expect(effectiveDeviceSandbox(PLATFORM_ON, { outsideSandbox: "off" }, DEVICE, SUPPORTING).loopbackPorts).toBe(false);
  expect(effectiveDeviceSandbox(PLATFORM_ON, {}, DEVICE, OP_PROVIDER).loopbackPorts).toBe(false);
});
it("words each loopback refusal", () => { /* the three texts above, exact strings */ });
// loopback-grants.test.ts (integration: one app per file)
it("grants once per key and returns the live row on a repeat", ...);           // two grantIn → same id, one audit row device.loopback_granted
it("expires after 24 hours: the expiry pass revokes and owes a refresh", ...); // set expires_at = now() - 1s via sql; expireDue() → 1; row revoke_reason "expired"; outbox row dlr-…-r<id>
it("refuses a 33rd live port with loopback_limit", ...);
it("revokes a deleted conversation's grants in the deleting transaction", ...); // OUTBOX_DISPATCH_FAILS on; delete conv → rows revoked conversation-deleted, outbox row present; drainOutbox → fake service ensure saw []
it("ceiling publication owes a refresh and the job revokes", ...);            // grant; org outsideSandbox off (OrgSettingsService.update) → outbox row c…; drainOutbox → revoke_reason outside-sandbox-off, audit device.loopback_revoked, last ensure loopbackPorts []
it("sends the live set with every ensure", ...);                               // device-services: grant 3999 → ensure opts loopbackPorts [3999] (readFakeServiceLoopbackPorts)
```

- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/sandbox/device-sandbox.test.ts packages/kernel/test/sandbox/loopback-grants.test.ts packages/kernel/test/sandbox/device-services.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; `pnpm check` (kernel conventions, outbox registry, org-filter) → PASS.
- [ ] **Step 5:** Commit `feat(kernel): loopback grant records, refresh, expiry and narrowing`.

---

### Task 6: Review — crossing, approver, classifier, events

Skills: `writing-device-providers` (per-call escalation), `replay-evals` (review record, no DriftReason). Repo: core.

**Files:**
- Modify: `packages/kernel/src/sandbox/permission-call-types.ts` (`PermissionCrossingKind` l.54 + `"loopback-port"`)
- Modify: `packages/kernel/src/sandbox/review/permission-candidate.ts` (`approverForCrossing` l.245)
- Modify: `packages/kernel/src/sandbox/review/classifier.ts` (`ReviewClassifierInput.kind` l.97, `classifierMessage` l.117)
- Modify: `packages/kernel/src/sandbox/review/review.service.ts` (new public `reviewLoopbackPort`)
- Modify: `packages/kernel/src/conversations/events.ts` (`permission_reviewed` l.~996, `approval_requested` l.1648)
- Test: `packages/kernel/test/sandbox/loopback-review.unit.test.ts` (new, add to `unit-tests.json`), `packages/kernel/test/sandbox/review-classifier.test.ts`

**Interfaces — Produces:**
```ts
// approverForCrossing: the sub-agent / credential rule applies to crossing "outside-sandbox" OR "loopback-port"
// classifier.ts
kind: "command" | "write" | "read" | "loopback-port";
loopback?: { service: string; port: number; url: string | null; database: boolean };
// review.service.ts
async reviewLoopbackPort(input: {
  orgId: string; conversationId: string; runId: string; step: number; callId: string; signal: AbortSignal;
  accountId: string; agentId: string; agentVersion: number; conversationKind: …; parent?: …; parentRunId?: string; budgetRunId?: string;
  profile: PermissionProfile; service: string; port: number; url: string | null; database: boolean;
  beforeSend?: …;
}): Promise<ReviewVerdict & { approver: PermissionApprover }>;
// events.ts
permission_reviewed.scopeKind enum + "loopback-port"; crossing enum + "loopback-port";
permission_reviewed gains `loopback: z.object({ service: z.string(), port: z.number().int().min(1).max(65535) }).optional()`
approval_requested gains `loopback: z.object({ service: z.string(), port: z.number().int().min(1).max(65535), database: z.boolean() }).optional()` (display only, never model-visible)
```
(Copy the hook-fact field types from `ReviewInput` in `review.service.ts` l.97 rather than restating them.)

`reviewLoopbackPort`: approver `none` → `allow("Full access grants this local port within the device's limits.", null)` with `crossing: "loopback-port"`; `person` → ask with reason `The browser asks to reach port ${port} on this device${database ? " (a local database port)" : ""}.`; `review-model` → if classifier not mapped → that ask; else `runClassifier` with `kind: "loopback-port"`, `text: \`${service} → ${url ?? \`127.0.0.1:${port}\`}\``, `cwd: ""`, `ruleHits: []`, person messages of the root, `fullAccessReview: { subAgent: true }` when a sub-agent under Full access. Classifier message for `loopback-port`: heading `Local port request`, plus the fixed line `Loopback port requested: the agent's browser asks to reach port ${port} on the person's own device (127.0.0.1, ::1 and localhost) for this conversation, for up to 24 hours.${database ? " This is a well-known local database port." : ""} Answer allow only when the person's messages make testing a local server in the browser part of the task; otherwise answer ask.`

- [ ] **Step 1: Failing tests** (`loopback-review.unit.test.ts`)

```ts
it("decides loopback-port like outside-sandbox", () => {
  expect(approverForCrossing({ profile: "full-access", crossing: "loopback-port", subAgent: false })).toBe("none");
  expect(approverForCrossing({ profile: "full-access", crossing: "loopback-port", subAgent: true })).toBe("review-model");
  expect(approverForCrossing({ profile: "approve-for-me", crossing: "loopback-port", subAgent: false })).toBe("review-model");
  expect(approverForCrossing({ profile: "request-approval", crossing: "loopback-port", subAgent: false })).toBe("person");
});
it("states the loopback request to the review model", () => {
  const m = classifierMessage({ mode: "auto", kind: "loopback-port", text: "browser.browser → http://127.0.0.1:3999/", cwd: "", ruleHits: [], personMessages: "test it in the browser", tag: "t1", loopback: { service: "browser.browser", port: 3999, url: "http://127.0.0.1:3999/", database: false } });
  expect(m).toContain("Local port request (untrusted data):");
  expect(m).toContain("reach port 3999 on the person's own device");
  expect(m).not.toContain("database");
});
it("accepts loopback-port in permission_reviewed and loopback in approval_requested", () => { /* EVENT_SCHEMAS parse */ });
```
In `review-classifier.test.ts` (integration, fake model): `reviews a loopback port with the classifier under approve-for-me` (scripted allow → `decision: "allow", by: "classifier"`), `asks the person when no review model is mapped`.

- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/sandbox/loopback-review.unit.test.ts packages/kernel/test/sandbox/review-classifier.test.ts` → FAIL.
- [ ] **Step 3:** Implement; add the new file to `packages/kernel/test/unit-tests.json`.
- [ ] **Step 4:** Same → PASS; `pnpm check:test-portfolio` (or `pnpm check`) → PASS.
- [ ] **Step 5:** Commit `feat(kernel): loopback-port crossing in the permission review`.

---

### Task 7: Web approval card for a loopback ask

Skills: `writing-web-ui`. Repo: core.

**Files:**
- Modify: `apps/web/src/lib/approvals.ts` (`NetworkApprovalDetail` union l.39)
- Modify: `apps/web/src/components/ApprovalCard.tsx` (`networkAskOf` l.652 and the network block l.378)
- Modify: `apps/web/messages/zh.json`, `apps/web/messages/en.json`
- Test: `apps/web/test/approval-card.test.tsx`

**Interfaces — Consumes (fixed here, produced by Task 9):** the approval view `kind: "network"` with
```ts
detail: { kind: "loopback"; deviceId: string; service: string; url: string | null; port: number; database: boolean; attempt: number; outcome?: "session" }
scopes: ["session"]
```
and the log payload `approval_requested.loopback = { service, port, database }` before the detail is read. Decide body: `{ decision: "approve", scope: "session" }` (no `hosts`).

Copy (exact): title zh `允许浏览器访问本机端口 {port}？` / en `Allow the browser to reach port {port} on this device?`; database line zh `这是一个本地数据库端口。` / en `This is a local database port.`; allow zh `允许本会话访问` / en `Allow for this conversation`; deny uses the existing deny label; another approver zh `只有设备所有者可以开放本机端口 {port}。` / en `Only the device's owner can open local port {port}.`. Keys under `network.loopback*`. No styles, design components only.

- [ ] **Step 1: Failing tests:** `renders a loopback ask with its port and one allow choice` (title text, single approve button "Allow for this conversation", no host checkboxes); `names a database port`; `approves with scope session and no hosts` (onDecide called with `("approve", "session", undefined, undefined)`); `renders from the log before the detail is read` (`item.loopback`).
- [ ] **Step 2:** `pnpm exec vitest run apps/web/test/approval-card.test.tsx` → FAIL.
- [ ] **Step 3:** Implement (a `loopbackAskOf(item, view)` beside `networkAskOf`).
- [ ] **Step 4:** Same → PASS; `pnpm check:web-ui && pnpm check:i18n` → PASS.
- [ ] **Step 5:** Commit `feat(web): loopback port approval card`.

---

### Task 8: ctx.deviceAccess — reports with port and class, grant, revoke, list

Skills: `writing-extensions`, `writing-device-providers` (device services). Repo: core.

**Files:**
- Modify: `packages/kernel/src/device-access/device-access.service.ts` (`DeviceAccessCaller` l.78, `reportBlockedHosts` l.505, new methods)
- Modify: `packages/kernel/src/tools/call-scope.ts` (`CallScope.blocked` l.60)
- Modify: `packages/kernel/src/ctx/create-ctx.ts` (l.751-779 wiring; caller gets `loopbackPorts`)
- Modify: `packages/kernel/test/fixtures/extensions/fake-device-access/index.ts` (declares `loopbackPorts: true`; `navigate` reports `{host:"127.0.0.1", port, layer:"address", class:"loopback"}` when its input names a loopback URL)
- Test: `packages/kernel/test/device-access/device-access.test.ts`

**Interfaces — Consumes:** Task 1 SDK, Task 5 `LoopbackGrants`, `loopbackRefusal`, `PermissionFacts.deviceSandboxFacts`.
**Produces:**
```ts
DeviceAccessCaller gains `loopbackPorts: boolean` (from permissions.deviceAccess.loopbackPorts === true)
CallScope.blocked gains `loopback: { serviceId: string; host: string; port: number } | null`
  // set by reportBlockedHosts for the first entry with layer "address", class "loopback", isLoopbackGrantHost(host), integer port,
  // only when the caller declares loopbackPorts and the service resolves (opts.service, or the single declared service).
  // Otherwise port/class are dropped and the entry is today's address host.
DeviceAccessService.grantLoopbackPort(caller, scope & {service, port}): Promise<LoopbackGrantView>
  // scopedDevice (owner only) → root of scope.conversationId → ceiling (`loopbackRefusal` on deviceSandboxFacts + previewCall-equivalent escalation refusal; refused → DeviceAccessError("loopback_unavailable", <why>))
  // → LoopbackGrants.grantIn(…, { source: "owner-panel", actorAccountId: scope.accountId }) in one transaction
  // → DeviceServices.refreshLoopback (best effort, logged; the outbox job is the backstop)
DeviceAccessService.revokeLoopbackPort(caller, scope & {service, port}): Promise<void>
DeviceAccessService.loopbackPorts(caller, scope & {service}): Promise<LoopbackGrantView[]>  // the scope root's live grants
not declaring loopbackPorts → DeviceAccessError("loopback_not_declared", "This extension does not declare permissions.deviceAccess.loopbackPorts.")
```
Error texts are actionable English for the model (spec "Not possible": what is off and who can change it).

- [ ] **Step 1: Failing tests** (device-access.test.ts):
`keeps port and class only for an extension declaring loopbackPorts`; `grants a loopback port from the owner panel and refreshes the running service` (grant → view `{port:3999, source:"owner-panel", database:false}`, audit `device.loopback_granted` detail `{source:"owner-panel", port:3999, service:"fake-device-access.echo"}`, fake ensure saw `[3999]`); `refuses a non-owner` (`not_owner`); `refuses when outside-sandbox is off, naming the layer` (`loopback_unavailable`, message contains "running outside the sandbox is not possible here"); `lists the root's live grants for a sub-agent scope`; `revokes and narrows` (ensure saw `[]`, audit `device.loopback_revoked`).
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/device-access/device-access.test.ts` → FAIL.
- [ ] **Step 3:** Implement; replace any Task 1 stubs.
- [ ] **Step 4:** Same → PASS; `pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(kernel): ctx.deviceAccess loopback grants`.

---

### Task 9: The ask, the approval and the rerun

Skills: `writing-tools`, `replay-evals`, `writing-device-providers` (per-call escalation), `writing-channels` (cards). Repo: core.

**Files:**
- Create: `packages/kernel/src/tools/loopback-asks.ts` (pure planner + notes)
- Modify: `packages/kernel/src/tools/approvals.service.ts` (`LoopbackAskDetail`, `NetworkAskDetail` union l.174, `networkAskHosts` l.182, new `requestLoopback`, `decideNetwork` l.1439 branch)
- Modify: `packages/kernel/src/tools/network-asks.ts` (`settledNetworkNotes` l.531 delegates a loopback detail)
- Modify: `packages/kernel/src/tools/pipeline.ts` (`serviceRerunAfter` l.1180, `processCall` l.1548-1613, the report site l.2294-2310, new `loopbackBlocked` beside `networkBlocked` l.3256)
- Modify: `packages/kernel/src/channels/cards.ts` (`networkCardText` l.272: loopback text, scope label `session`) and its phrase table (`networkServiceTitle` neighbours)
- Test: `packages/kernel/test/tools/loopback-asks.unit.test.ts` (unit list), `packages/kernel/test/tools/loopback-asks-service.test.ts` (integration, modeled on `tools/network-asks-service.test.ts`)

**Interfaces — Consumes:** Task 5 (`LoopbackGrants.grantIn/forCall`, `loopbackRefusal`), Task 6 (`reviewLoopbackPort`, event fields), Task 8 (`CallScope.blocked.loopback`).
**Produces:**
```ts
// approvals.service.ts
export interface LoopbackAskDetail extends Omit<NetworkAskDetailBase, "appliesAt" | "grantedHosts" | "outcome"> {
  kind: "loopback"; service: string; url: string | null; port: number; database: boolean; attempt: number; outcome?: "session";
}
async requestLoopback(input: Omit<NetworkAskInput, "detail" | "scopes"> & { detail: LoopbackAskDetail }): Promise<ApprovalRecord>;
  // kind "network", scopes ["session"], requested_for = device owner (checked as requestNetworkIn), one per call,
  // approval_requested payload `loopback: { service, port, database }` (no `network` field)
// decideNetwork, detail.kind === "loopback": owner + signed-in session (as today); approve requires scope "session" and no hosts;
// in the decision's transaction LoopbackGrants.grantIn({…, rootConversationId}, { source: "human", actorAccountId, approvalId, call:{runId, callId, attempt: detail.attempt} });
// ceiling re-checked there: refused → ApiError("approval.loopback_unavailable", <why>) (register the code), the ask stays pending.
// networkAskHosts(loopback detail) → [] (callers audited: cards, pipeline, approval_requested)
// loopback-asks.ts
export type LoopbackPlan =
  | { kind: "none" }                                   // no loopback entry in the report
  | { kind: "refused"; note: string }                  // ceiling refusal note
  | { kind: "decide"; port: number; host: string; database: boolean };
export function planLoopbackAsk(entry: { host: string; port: number } | null, refusal: string | null, escalationAvailable: boolean): LoopbackPlan;
export const loopbackPendingNote = (host: string, port: number) => `[network] ${hostPort(host, port)} is a local port on the device. The browser reaches local ports only after the port is approved for this conversation; an approval was requested.`;
export const loopbackGrantedNote = (port: number) => `Port ${port} on the device was approved for this conversation.`;
export const loopbackRefusedNote = (host: string, port: number, why: string, escalationAvailable: boolean) =>
  `[network] ${hostPort(host, port)} is a local port on the device. Local ports stay closed to the browser because ${why}.${escalationAvailable ? ' A command run outside the sandbox (Bash with sandbox: "escalated") still reaches it.' : ""}`;
export const loopbackDeniedNote = (port: number, reason?: string | null) => `[network] Port ${port} on the device was not approved for this conversation, so the browser cannot reach it.${reason ? ` Reason: ${reason}` : ""}`;
export const loopbackExpiredNote = (port: number, hours: number) => `[network] The approval for port ${port} on the device expired after ${hours} hours without an answer, so the browser cannot reach it.`;
export const loopbackReviewDeniedNote = (port: number, reason: string) => `[network] The review declined port ${port} on the device for this conversation: ${reason}`;
export function settledLoopbackNotes(a: ApprovalRecord, hours: number): string[] | null; // null while pending
const hostPort = (h: string, p: number) => (h.includes(":") ? `[${h}]:${p}` : `${h}:${p}`);
// pipeline.ts
function rerunAfter(ask: ApprovalRecord | null, grant: LoopbackGrantRow | null): number | null; // serviceRerunAfter(ask) ?? grant?.attempt ?? null (approved loopback asks resolve through their grant row)
private async loopbackBlocked(ctx, call, tool, input, report: { deviceId; loopback: {serviceId; host; port}; url }, attempt, kept): Promise<
  | { kind: "wait"; wait: WaitingFor; content: string }
  | { kind: "rerun"; notes: string[] }
  | { kind: "write"; notes: string[] }>;
```

Flow in `loopbackBlocked` (runs at the report site when `scoped.loopback` is set, before `networkBlocked` for the remaining hosts; the loopback entry is removed from the hosts sent to `networkBlocked`):
1. Facts: `permissionAuthority.previewCall(use, {runId, callId}, signal)` (gives `escalationRefusal` incl. unattended, profile, revisions) + `PermissionFacts.deviceSandboxFacts` support → `loopbackRefusal`. Refused → `{kind:"write", notes:[loopbackRefusedNote(…)]}` (escalation available = `escalationRefusal == null`).
2. Already a live grant for the root and port (the device was slow to restart) → `{kind:"rerun", notes:[]}` once (only if no grant row is tied to this call yet; otherwise write the result as is).
3. `approver = approverForCrossing({ profile, crossing: "loopback-port", subAgent: ctx.parent !== undefined })`. `none` → grant (source `full-access`) + `permission_reviewed` (scopeKind `loopback-port`, `decisionSource: "full-access"`, `outcome: "allow"`, `permissionScope: {writeDirectories:[], hosts:[]}`, `loopback`) in one transaction → `rerun` with `[loopbackGrantedNote(port)]`. `review-model` → `review.reviewLoopbackPort`: allow → grant (source `review-model`) + event (`decisionSource: "review-model"`) → rerun; deny → event + `{write, [loopbackReviewDeniedNote]}`; ask → step 4. `person` → step 4.
4. Person ask (attended only; unattended is already refused in 1): `approvals.requestLoopback` with the kept result (as `networkBlocked` keeps it) → `wait` with content `loopbackPendingNote`. The per-run cap counts it like a network ask (`MAX_NETWORK_ASKS_PER_RUN`); over the cap → `write` with `tooManyNote([hostPort])`.
5. `rerun` → `runCall(ctx, call, resolved, attempt + 1, resume, { review, notes })`, the notes appended to the rerun's result with `withNetworkNotes`. `processCall` uses `rerunAfter(networkAsk, await loopback.forCall(runId, callId))` everywhere it used `serviceRerunAfter`, and treats `detail.kind === "loopback"` like `"service"` for `askedHere`.

- [ ] **Step 1: Failing tests**

Unit (`loopback-asks.unit.test.ts`): `plans none without a loopback entry`; `plans refused with the reason and the escalation sentence only when escalation is available`; `words every note exactly` (assert the five strings above with `127.0.0.1`, `::1` → `[::1]:3999`, `localhost`); `settles an approved, denied and expired loopback ask`.

Integration (`loopback-asks-service.test.ts`, fake-device-access `navigate` to `http://127.0.0.1:3999/`, device-fake supporting loopback; one app per file, profiles set per conversation):
- `full access grants the port with no person and reruns the call` — events: `permission_reviewed {scopeKind:"loopback-port", decisionSource:"full-access", outcome:"allow"}`, two `tool_call_started` (attempts 1 and 2), final `tool_result` contains `Port 3999 on the device was approved for this conversation.`; grant row source `full-access` with run/call/attempt 1; fake ensure saw `[3999]`; no approval row.
- `approve-for-me asks the review model and reruns on allow` (scripted classifier allow) and `asks the person when the review model answers ask`.
- `a sub-agent's ask goes to the review model under full access`.
- `request-approval asks the device owner; approval grants and reruns` (decide via `POST /api/v1/approvals/:id/decision {decision:"approve", scope:"session"}`; grant source `human`, approval_id set).
- `deny leaves the call failed with the not-approved note`; `expiry writes the expired note`.
- `refuses with a note when outside-sandbox is off, an unattended run, or the provider lacks support` (three cases, no approval, no grant; note names the reason).
- `notes an outdated device` (support `limitedBy.loopbackPorts: "device-update"` → note contains `update capybara-device`).
- `an extension not declaring loopbackPorts keeps today's address note` (`addressLayerNote` text, no ask).
- `resumes a granted call as the rerun after a crash` (full access; fail the rerun's start once via the pipeline's test seam / kill between grant commit and rerun, restart the run → rerun at attempt 2, not "result unknown").
- Channel card: `cards a loopback ask with the session label` (unit-level call of `networkCardText` in the same file or `channels/cards` tests).

- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/tools/loopback-asks.unit.test.ts packages/kernel/test/tools/loopback-asks-service.test.ts` → FAIL.
- [ ] **Step 3:** Implement; add the unit file to `unit-tests.json`; register `approval.loopback_unavailable` in the error-code registry (see `writing-kernel-api`, "registering error codes").
- [ ] **Step 4:** Same → PASS. Regression: `pnpm exec vitest run packages/kernel/test/tools/network-asks-service.test.ts packages/kernel/test/tools/network-ask.test.ts packages/kernel/test/tools/network-asks.unit.test.ts` and the zero-drift fixtures named in `replay-evals` (`reconstruct.test.ts`) → PASS.
- [ ] **Step 5:** Commit `feat(kernel): loopback port asks with rerun under every profile`.

---

### Task 10: Dual-replica — one grant, one refresh

Skills: `writing-kernel-api` (outbox testing), `writing-extensions` (dual-replica harness). Repo: core.

**Files:**
- Create: `packages/kernel/test/device-access/loopback-grants.dual.test.ts`
- Modify: `packages/kernel/test/container-tests.json`

- [ ] **Step 1: Test** `one grant leads to one refresh across two replicas`: two replicas (both with workers) on one PG/Valkey, device-fake root shared; full-access conversation; navigate to `127.0.0.1:3999` → assert exactly one grant row, exactly one `permission_reviewed` with `scopeKind: "loopback-port"`, and after `waitFor` on the outbox being empty, the fake ensure log shows the `[3999]` set applied by the refresh job exactly once (the rerun's own ensure is the other entry; count jobs by the ops log tag `loopback-refresh`). Second test `the expiry job runs once per tick across replicas` (one expired row → one revoke audit row).
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/device-access/loopback-grants.dual.test.ts` → PASS (written after Task 9; it must fail if the refresh job id were random — verify by temporarily making the id random, see it fail, revert).
- [ ] **Step 3:** Add to `container-tests.json`; `pnpm check` → PASS. Commit `test(kernel): loopback grants under two replicas`.

---

### Task 11: Docs, AGENTS.md, skills, changesets

Repo: core.

**Files:**
- Modify: `AGENTS.md` — **Sandboxes** line: after "private ranges, metadata and host services stay closed" insert "except a loopback port granted to a device service for one conversation (`loopback-port`, decided like an outside-sandbox escalation and bounded by the device's outside-sandbox setting)"; **Device access** line: add "a loopback grant is per conversation and per port, owner-only, and expires with the conversation or after 24 hours" (spec "AGENTS.md rules touched", verbatim).
- Modify: `.agents/skills/writing-device-providers/SKILL.md` ("Device services and stream holds" section: `loopbackPorts` support flag, `service.ensure.network.loopbackPorts`, `networkKey`, the hello feature, `device-loopback-refresh`, expiry job); `.agents/skills/writing-extensions/SKILL.md` (`permissions.deviceAccess.loopbackPorts`, the three ctx methods, the ask).
- Modify: `packages/plugin-sdk/agent-docs/extensions.md` only if it documents `permissions.deviceAccess` (then add `loopbackPorts`); run `pnpm gen:agent-docs` if `check:agent-docs` asks.
- Create changesets: `@capybara-hq/kernel` (loopback grants), `@capybara-hq/capybara` (images: kernel + web + device-fake fixture none), `@capybara-hq/testing` only if its exports changed (they do not in this plan).

- [ ] **Step 1:** Edit; `pnpm check` (agent-docs, english comments) → PASS.
- [ ] **Step 2:** `pnpm verify --fast` → PASS; `pnpm check:api-changeset --base origin/main` → PASS.
- [ ] **Step 3:** Commit `docs: loopback port grants in AGENTS.md and skills`. Open the core PR (draft until all core tasks are in; issue linked).

---

### Task P0: Bump core packages in plugins

Repo: plugins (`/Users/grant/Capybara/plugins/.claude/worktrees/feat-browser-loopback-ports`). Skill: plugins `writing-plugins`.

**Files:** root `package.json` devDependencies (`@capybara-hq/plugin-sdk`, `testing`, `plugin-model-fake`, `plugin-tools` if released), `pnpm-workspace.yaml` `overrides` (every core entry, incl. `@capybara-hq/kernel`), `plugins/browser/package.json` and `plugins/device-local/package.json` (`^0.1.0-rc.<released sdk>`), `pnpm-lock.yaml`.

- [ ] **Step 1:** Set the released versions (from the core Version Packages PR); `pnpm install`.
- [ ] **Step 2:** `pnpm typecheck && pnpm exec vitest run plugins/browser plugins/device-local` → PASS (no behaviour change yet).
- [ ] **Step 3:** Commit `chore: core rc.<N> (loopback port grants)`.

---

### Task P1: device-local reports and sends loopback ports

Skill: plugins `writing-device-providers`. Repo: plugins.

**Files:**
- Modify: `plugins/device-local/src/pg-rows.ts` (`FEATURES` l.18 + `"loopbackPorts"`)
- Modify: `plugins/device-local/src/report.ts` (support l.25-47, l.369-377)
- Modify: `plugins/device-local/src/frames.ts` (`ServiceBody` l.145: `network: DeviceServiceNetwork`)
- Modify: `plugins/device-local/src/provider.ts` (`ensureService` l.581)
- Test: `plugins/device-local/test/{report,services,hello}.test.ts`
- Create: `.changeset/device-local-loopback.md` (`@capybara-hq/plugin-device-local`)

Rules: support `network.loopbackPorts = attested.outsideSandbox && machine.features.includes("loopbackPorts") && os === "darwin"` (after the owner ceiling is applied, so an owner-off machine reports false with `limitedBy.outsideSandbox: "owner"`); a darwin machine without the feature reports `limitedBy.loopbackPorts: "device-update"`. `ensureService(h, spec, signal, o)`: `network.loopbackPorts = [...(o?.loopbackPorts ?? [])]` **only when** the machine's features include `loopbackPorts`; otherwise the key is omitted (an older machine answers `invalid` to unknown keys).

- [ ] **Step 1: Failing tests:** `reports loopbackPorts for a macOS machine with the feature`; `reports device-update for a macOS machine without it`; `reports false when the owner forbids running outside the sandbox`; `sends network.loopbackPorts with ensure and ifRunning ensure`; `omits loopbackPorts for a machine without the feature`; `keeps loopbackPorts in the stored hello features` (pg-rows round trip).
- [ ] **Step 2:** `pnpm exec vitest run plugins/device-local` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS (the kernel-level `kernel.test.ts` / `e2e.test.ts` included).
- [ ] **Step 5:** Commit `feat(device-local): loopback port grants`.

---

### Task P2: Browser daemon — port and class, per-tab check

Skill: plugins `writing-extension-ui` (panel events), `writing-tools`. Repo: plugins.

**Files:**
- Modify: `plugins/browser/daemon/protocol.ts` (`BlockedHost` l.502, `RequestConversation` l.379)
- Modify: `plugins/browser/daemon/actions.ts` (`blockedMessage` l.115, collector `blocked` map l.133, `checkBlocked` l.2766, viewer event type l.81, a route guard per context)
- Test: `plugins/browser/test/daemon/blocked.test.ts`, `plugins/browser/test/daemon/proxy-refusal.test.ts`, new `plugins/browser/test/daemon/loopback.test.ts`

**Interfaces — Produces:**
```ts
export interface BlockedHost { host: string; port: number; layer: "device" | "address"; class?: "loopback" }
export interface RequestConversation { conversationId: string; rootConversationId: string; /** The root's live loopback grants (kernel-sourced, sent by the extension on every request). */ loopbackPorts?: number[] }
// viewer event
| { type: "blocked"; host: string; url: string; root: string; port?: number; kind?: "loopback" }
```
Rules: collector key `host:port` (`c.blocked: Map<string, BlockedHost>`); `class: "loopback"` iff `isLoopbackGrantHost(host)` (SDK) and layer `address`. The daemon keeps `loopbackByRoot: Map<root, Set<number>>` replaced by each request's `loopbackPorts` (absent = unchanged; process state is fine here: the daemon is a single process per device and the kernel resends the set on every request). Per-tab check: a context-level `route` for URLs whose host `isLoopbackGrantHost` → `abort("blockedbyclient")` when the tab's root set lacks the port, and the refusal is recorded as `{host, port, layer:"address", class:"loopback"}` for that owner; ports in the set continue to the proxy. A loopback `address` refusal emits the viewer `blocked` event with `port` and `kind: "loopback"` (today only `device` emits). `blockedMessage` loopback line: `<host:port> is a local port on the device, which the browser reaches only after the port is approved for this conversation.`

- [ ] **Step 1: Failing tests:** `reports the port and the loopback class`; `keys two ports of one host apart`; `emits a loopback blocked event for the panel`; `refuses a granted port for another root's tab` (root A set `[3999]`, root B none, proxy test double allows 3999 → B's navigate blocked with class loopback, A's reaches the listener); `follows the root's set from each request` (set removed → next navigate blocked).
- [ ] **Step 2:** `pnpm exec vitest run plugins/browser/test/daemon` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS.
- [ ] **Step 5:** Commit `feat(browser): loopback refusals with port and a per-tab check`.

---

### Task P3: Browser extension and panel

Skills: plugins `writing-extension-ui`, `writing-tools`. Repo: plugins.

**Files:**
- Modify: `plugins/browser/src/index.ts` (manifest l.56 `deviceAccess: { services: ["browser"], loopbackPorts: true }`; wrappers l.60-73 for the three new methods)
- Modify: `plugins/browser/src/browser.ts` (`finishReply` l.387: pass `port`, `class`, `opts.service: "browser"`; every daemon request adds `loopbackPorts` from `deviceAccess.loopbackPorts({ orgId: call.orgId, conversationId: call.conversationId, accountId: call.accountId, service: "browser" })` mapped to ports)
- Modify: `plugins/browser/src/routes.ts` (new `/ui/loopback-ports`: `GET` list, `POST {port}` grant, `DELETE {port}` revoke; integer 1–65535 validation; errors mapped like `/ui/network-hosts`)
- Modify: `plugins/browser/ui-src/panel/{panel,page,i18n}.ts` (loopback strip + grants list), `plugins/browser/src/i18n.ts` if server copy is needed
- Test: `plugins/browser/test/{routes,tools}.test.ts`, `plugins/browser/test/panel/panel.test.ts`
- Create: `.changeset/browser-loopback.md` (`@capybara-hq/plugin-browser`)

Copy (exact): strip zh `本机端口 {port} 未开放` / en `Local port {port} is closed`; action zh `允许本会话访问` / en `Allow for this conversation`; list title zh `本会话可访问的本机端口` / en `Local ports open to this conversation`; remove zh `移除` / en `Remove`; database suffix zh `（本地数据库端口）` / en ` (local database port)`. After a grant the panel reloads the tab (as after `allowHost`, panel.ts l.787-800).

- [ ] **Step 1: Failing tests:** `declares deviceAccess.loopbackPorts`; `reports a loopback refusal with port and class to the kernel` (fake deviceAccess records `reportBlockedHosts` args); `sends the root's live ports with each daemon request`; routes: `grants a port from the panel`, `refuses a non-integer or out-of-range port`, `lists and revokes`; panel: `shows the loopback strip and grants on click`, `lists grants with remove`.
- [ ] **Step 2:** `pnpm exec vitest run plugins/browser` → FAIL.
- [ ] **Step 3:** Implement; `pnpm build:ui`.
- [ ] **Step 4:** `pnpm exec vitest run plugins/browser && pnpm check && pnpm verify --fast` → PASS.
- [ ] **Step 5:** Commit `feat(browser): ask for and grant local ports`. Open the plugins PR.

---

### Task 12: Live acceptance on the Mac

After the plugins release, on local dev (and prod per the standing grants), personal Mac device with the released capybara-device:

- [ ] Prompt "Build a Next.js todo app, start the dev server and test it in the browser" under **Full access**: no approval card; timeline shows the review record `loopback-port` / full access; the browser loads `127.0.0.1:<port>`; no Playwright install in the project.
- [ ] Same under **Approve for me** with a review model mapped: review-model allow, browser loads the page; with the review model unmapped: owner card appears, one click, page loads.
- [ ] Same under **Request approval**: owner card "允许浏览器访问本机端口 …？", allow → rerun loads.
- [ ] Panel fallback: navigate a tab to an ungranted port → strip "本机端口 N 未开放" → "允许本会话访问" → tab reloads and loads.
- [ ] Second conversation on the same device: same port blocked until its own grant.
- [ ] Org outside-sandbox off → the grant is revoked within seconds (audit `device.loopback_revoked`), the page no longer loads; note names the setting.
- [ ] Older capybara-device (previous release) → note "update capybara-device…".

---

## Rulings on spec ambiguities

1. **Grant hosts are exactly `127.0.0.1`, `::1`, `localhost`** (§4); §5.4's "literal in the loopback class" is read narrowly — `127.0.0.2` etc. stay closed.
2. **Rerun durability without a person:** the grant row carries `run_id`, `call_id`, `attempt` (extra columns beyond §6), so a Full access / review-model grant resumes as the rerun after a crash; a person ask still uses the `network` approval row (`detail.kind: "loopback"`, scope `session`).
3. **The live set is pure records; ceilings narrow by revocation.** Any narrowing ceiling publication (`PermissionCeilingWrites.publishLocked`) owes a `device-loopback-refresh` per affected (device, service); the job revokes (`outside-sandbox-off`) when the ceiling now refuses. capybara-device additionally drops ports while its owner ceiling forbids outside-sandbox. A `revoke_reason` column records why.
4. **"The kernel tells the daemon the live set on each request"** is implemented as `ctx.deviceAccess.loopbackPorts(scope)` called by the browser extension before every daemon request (request bodies stay opaque to the kernel).
5. **The grants list with remove lives in the browser panel** (the conversation side panel's browser section), through plugin routes and `ctx.deviceAccess.loopbackPorts / revokeLoopbackPort`; no kernel web page.
6. **Support flag is optional in the SDK** (`network.loopbackPorts?`, absent = false) so providers on the previous SDK keep parsing after the kernel upgrades first; `limitedBy.loopbackPorts: "device-update"` carries the outdated-machine note.
7. **Refusal note**: the "a command outside the sandbox reaches it" sentence is appended only when an escalation is actually available (spec "because that remains true").
8. **No permission-profile system text change** → no DriftReason; all model-visible text is in `tool_result`.
9. **Port cap** `LOOPBACK_MAX_PORTS_PER_SERVICE = 32` live ports per (device, service), not in the spec; bounds the sent set and the patch schema.
10. **Approval scope** for a loopback ask is the existing `ApprovalScope` value `session` ("this conversation").
11. **Expiry job name** `device-loopback-expiry` (every 60 s); refresh job `device-loopback-refresh` (spec leaves names to the builder).
