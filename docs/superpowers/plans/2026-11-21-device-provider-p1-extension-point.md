# Device Providers Phase 1: Extension Point and Multi-Provider Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task, layered with
> the `wave-planned-subagent-development` skill. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-choice `sandbox@2` point with the `multi` point `device-provider@1`,
bind every device to its own provider for life, let several providers be on in one org, and ship
`device-docker` / `device-e2b` as its first implementers.

**Architecture:** The SDK renames the contract and adds `report()`, the static `networkAllowlist`
declaration, `ProjectPathRefusedError`, the `{ projectRoot, writeRoots }` scope and the
`device-connection` guide place. The kernel's `DeviceProviders` resolves a device's provider from
`devices.provider` and asks the catalog which providers are on in an org; the "current cloud
provider" (demotion, stranded defaults, `otherProvider`, `cloudAvailable`) goes away; sweeps run
per provider. The kernel-internal `@local` provider keeps working (registered in the internal map,
fixed report) until phase 2 moves it into `device-local`.

**Tech Stack:** TypeScript, NestJS + Fastify kernel, Kysely/PG, Redis (Valkey), vitest; plugins
repo with changesets in pre mode.

**Spec:** `docs/superpowers/specs/2026-11-21-device-provider-design.md` (§6.1, §6.2, §6.4, §10,
§11 step 1, §13). Index: `docs/superpowers/plans/2026-11-21-device-provider.md` (Global
Constraints, Shared interfaces, Release order). Executors read both.


## Reconciliation (index rulings; these win over the tasks below)

- R1: Task 4 owns the scope change everywhere, including the test `a scoped operation carries projectRoot and writeRoots and no read roots`.
- R2: Task 4 sets protocol 5; nothing later in phases 1-2 bumps it.
- R4: Task 10 uses the code `device.project_refused` (422), not `project.refused`.
- R5: Task 9's migration is `0174_device_report.sql` unless that number is taken at execution time.

## Global Constraints

Every line of the index's Global Constraints applies. Phase-specific additions:

- `@local` stays registered in `DeviceProviders`' internal map and keeps working end to end;
  `LOCAL_PROVIDER` and `isInternalProvider` survive this phase (phase 2 deletes them). `cloud()`,
  `providerForDevice` and `forName` are deleted in this phase (Task 8).
- A device's provider is `devices.provider` (a plugin name, or `@local`), fixed at creation. A
  device whose provider is not loaded, or loaded but not on in the device's org, is
  **unavailable**: tools get an actionable error, the device view says `available: false`, files
  and instance rows are kept, nothing is demoted, recreated or moved.
- "On in an org" is exactly the catalog's answer used by every other org-scoped point:
  `ExtensionPointDefaults.providersFor(orgId, "device-provider")` (loaded here, enabled in the
  org, valid effective config), read per call, never cached in process.
- Device-provider calls carry no per-org config in this phase: `device-docker` / `device-e2b`
  declare no `orgAccess` fields, so their effective config is their deployment config.
- The device report is stored in PG (`devices.report`, Task 9); request paths read the stored
  copy and never call `report()`.
- No kernel migration renames or rewrites rows; Task 9 only adds two nullable columns.
  `devices.demoted_from_provider` stops being read or written here and is dropped by phase 2's
  migration (expand then contract under rolling upgrades).
- Device protocol becomes 5 in this phase (Task 4: the operation frames' scope shape changes);
  see Index issues.
- Tests run from the repo root: `pnpm exec vitest run <path>`. A new kernel unit test is added to
  `packages/kernel/test/unit-tests.json` in the same task.

## Review Focus

- A provider switched off for an org (or uninstalled) while its devices are bound to
  conversations: tools answer an actionable "device provider is off" error, the device view shows
  it unavailable, files are kept, nothing is demoted or recreated (index line owned by this
  phase; Task 8 `providers-per-device.test.ts`, Task 11 `devices.http.test.ts`).
- One provider on in org A and off in org B: org B's devices on it are unavailable while org A's
  keep working, and the answer flips at once when org B switches it on (no in-process cache)
  (Task 8, `provider switched on in one org only`).
- Creating a device naming a provider that is loaded but off in the org, the internal `@local`,
  an unknown name or one with `@` is refused before any row exists; with no `provider` and no
  effective default the create is refused, never bound to an arbitrary provider (Task 11).
- A default-provider override naming a provider later switched off: no new default device is
  made, the person's existing default stays (unavailable), the list still answers (Task 7,
  Task 11).
- Two providers loaded: `suspendIdle`, `destroyInactive` and `reconcileMarked` call each
  provider only for its own rows; a provider unloaded between ticks leaves its rows untouched
  (Task 8, `sweeps call each provider only for its rows`).
- Kernel reads on a local device stay confined to the read path's directory after the scope
  change (a symlinked AGENTS.md out of the project is refused as before) (Task 4).

## Waves

| Wave | Tasks | Notes |
|---|---|---|
| A | 1, 2 | Disjoint SDK areas; whichever lands second reruns `pnpm gen:sdk-api` on merge |
| B | 3, 4, 5 | 4 is reviewed alone; 3 and 4 both regenerate the API report |
| C | 6, 7 | 6 is a mechanical fixture rename; 7 adds the resolver beside the old methods |
| D | 8 | Reviewed alone (cross-tenant, multi-replica sweeps) |
| E | 9, 10 | 9 is reviewed alone (migration) |
| F | 11 | Reviewed alone (cross-tenant create / default) |
| G | 12, 13 | Web interim and docs |
| P1 | 14 → 15 | Plugins repo, after the SDK release carrying Tasks 1-4 (sequential: shared repo files) |
| H | 16 | Core pins after the plugins release |

---

### Task 1: Rename `sandbox@2` to `device-provider@1` across core

**Files:**
- Modify: `packages/plugin-sdk/src/extension-point.ts:43-48` (the `sandbox` entry), add
  `DEVICE_PROVIDER_EXTENSION_POINT` re-export note
- Move: `packages/plugin-sdk/src/sandbox.ts` → `packages/plugin-sdk/src/device-provider.ts`;
  `packages/plugin-sdk/src/sandbox-operation.ts` → `packages/plugin-sdk/src/device-operation.ts`
- Modify: `packages/plugin-sdk/src/index.ts` (the two `export *` lines), every SDK import of the
  two files (`device-protocol.ts`, `network-classes.ts`, … found by `grep -rl "./sandbox.js\|./sandbox-operation.js" packages/plugin-sdk/src`)
- Move: `packages/plugin-sdk/test/sandbox.test.ts` → `device-provider.test.ts`,
  `sandbox-operation.test.ts` → `device-operation.test.ts`; Modify `extension-point.test.ts`
- Move: `packages/plugin-sdk/agent-docs/extension-points/sandbox.md` → `device-provider.md`;
  Modify `packages/plugin-sdk/agent-docs/extensions.md:71`, `concepts.md:58-61`
- Modify (mechanical `SANDBOX_EXTENSION_POINT` → `DEVICE_PROVIDER_EXTENSION_POINT`,
  `SandboxProvider` → `DeviceProvider`, `list("sandbox")` → `list("device-provider")`):
  `packages/kernel/src/sandbox/providers.ts`, `packages/kernel/src/lifecycle/kernel-lifecycle.ts:278-285`,
  `packages/kernel/src/local-devices/local-device-provider.ts`, `packages/kernel/src/extensions/permission-view.ts:96-115`,
  `packages/kernel/src/extensions/locks.ts:59`, `packages/testing/src/**`, `packages/device/src/**`,
  `apps/web/src/lib/extension-capabilities.ts:59`, `apps/web/src/lib/admin-extensions.ts:149`
- Modify: `packages/kernel/test/extensions/single-provider.test.ts` (its example single point
  becomes `object-store@1`), `apps/web/test/admin-extensions.test.tsx`,
  `apps/web/test/catalog-pages.test.tsx:2913`, `apps/capybara/test/extensions.test.ts:205-210`
- Modify: `packages/kernel/bootstrap.json:89-96` (remove the `sandbox-docker` entry: it provides
  a point this kernel refuses; Task 16 pins `device-docker`)
- Create: `.changeset/device-provider-point.md` (`@capybara-hq/plugin-sdk` minor,
  `@capybara-hq/kernel` minor, `@capybara-hq/device` patch, `@capybara-hq/testing` minor)
- Regenerate: `packages/plugin-sdk/api/plugin-sdk.api.md`

**Interfaces:**
- Produces: `DEVICE_PROVIDER_EXTENSION_POINT = "device-provider@1"`; `EXTENSION_POINTS["device-provider"] = { majors: [1], cardinality: "multi", brokered: true, orgScoped: true, description: "Provides devices (an instance plus kept files) agents run commands in: containers, microVMs, connected machines." }`; `interface DeviceProvider` (today's `SandboxProvider` members, renamed); `SENSITIVE_EXTENSION_POINTS` holds `"device-provider@1"`. Every other `Sandbox*` name is kept (index).
- No `SANDBOX_EXTENSION_POINT`, no `sandbox` key, no alias.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/plugin-sdk/test/extension-point.test.ts
it("device-provider@1 is a multi, brokered, org-scoped point and sandbox is gone", () => {
  expect(EXTENSION_POINTS["device-provider"]).toMatchObject({
    majors: [1], cardinality: "multi", brokered: true, orgScoped: true,
  });
  expect(EXTENSION_POINTS.sandbox).toBeUndefined();
  expect(DEVICE_PROVIDER_EXTENSION_POINT).toBe("device-provider@1");
});
// packages/kernel/test/extensions/resolve.test.ts
it("two device-provider@1 extensions load and are enabled side by side", async () => {
  // install lifePkg devA and devB, both provides ["device-provider@1"], enable both
  expect(registry.list("device-provider").map((e) => e.plugin).sort()).toEqual(["devA", "devB"]);
});
it("a plugin providing sandbox@2 is refused at import (unknown point major)", ...);
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm exec vitest run packages/plugin-sdk/test/extension-point.test.ts packages/kernel/test/extensions/resolve.test.ts`
Expected: FAIL (`EXTENSION_POINTS["device-provider"]` undefined).

- [ ] **Step 3: Rename** with `git mv` for the moved files, then the mechanical renames listed
  under Files. Kernel behaviour stays as is in this task (`SandboxProviders.cloud()` reads the
  first `device-provider@1` entry until Task 8 removes it).

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm gen:sdk-api && pnpm check && pnpm exec vitest run packages/plugin-sdk packages/kernel/test/extensions apps/web/test/admin-extensions.test.tsx apps/capybara/test/extensions.test.ts`
Expected: PASS; `git grep -n "sandbox@2\|SANDBOX_EXTENSION_POINT" -- ':!docs/superpowers' ':!**/CHANGELOG.md'` prints nothing.

- [ ] **Step 5: Commit**

```bash
git commit -am "refactor(sdk)!: rename sandbox@2 to the multi point device-provider@1

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 2: Setup-guide place `device-connection` and `::shell-action`

**Files:**
- Modify: `packages/plugin-sdk/src/setup-guide.ts:29-99` (place list, place info, limits)
- Modify: `packages/plugin-sdk/src/setup-guide-parse.ts` (scanner and `ParsedSetupGuide`)
- Modify: `packages/plugin-sdk/src/setup-guide-render.ts:31-36,370-415` (new block kind)
- Modify: `packages/plugin-sdk/schemas/plugin.v1.schema.json:225-229` (place enum)
- Modify: `packages/kernel/src/extensions/guide-places.ts:39-47,100-170` (`PLACE_ACTIONS`,
  `TARGET_PARAMS`, variable values)
- Test: `packages/plugin-sdk/test/setup-guide.test.ts`, `packages/plugin-sdk/test/setup-guide-render.test.ts`,
  `packages/kernel/test/catalog/guides.http.test.ts` (existing file; add cases)
- Create: `.changeset/device-connection-guides.md` (`@capybara-hq/plugin-sdk` minor, kernel minor)

**Interfaces:**
- Produces: `SETUP_GUIDE_PLACES` gains `"device-connection"`; `SETUP_GUIDE_PLACE_INFO["device-connection"] = { modes: [], audiences: ["member"], variables: { publicUrl: "url", orgId: "token", orgName: "text", pluginName: "token" }, drift: false, shellActions: ["connect-this-machine"] }`; `SetupGuidePlaceInfo.shellActions: readonly SetupGuideShellAction[]` (`[]` for the other places); `type SetupGuideShellAction = "connect-this-machine"`; `SETUP_GUIDE_LIMITS.shellActions = 4`; `ParsedSetupGuide.shellActions: { action: string; label: string; line: number; section: number | null }[]`; `SetupGuideBlock` gains `{ kind: "shell-action"; action: SetupGuideShellAction; label: string }`; kernel `PLACE_ACTIONS["device-connection"] = { member: "agents.use" }` (the devices routes' action).
- Kernel checks for this place (`::check` rows run against a target) are wired in phase 3 with
  the 新建设备 route; this task validates, imports and renders such guides.

- [ ] **Step 1: Write the failing tests**

```ts
// setup-guide.test.ts
it("device-connection: member audience, its four variables, connect-this-machine allowed", () => {
  expect(SETUP_GUIDE_PLACE_INFO["device-connection"]).toEqual({
    modes: [], audiences: ["member"], drift: false, shellActions: ["connect-this-machine"],
    variables: { publicUrl: "url", orgId: "token", orgName: "text", pluginName: "token" },
  });
});
it("parses ::shell-action connect-this-machine <label> with its line and section", () => {
  const p = parseSetupGuide("# Connect\n\n::shell-action connect-this-machine Connect this Mac\n");
  expect(p.shellActions).toEqual([{ action: "connect-this-machine", label: "Connect this Mac", line: 3, section: null }]);
});
it("refuses a shell action without a label, with variables, an unknown action, or in another place", () => {
  // validateSetupGuide({ place: "channel-connection", ... }) → error "shell actions are not allowed in place channel-connection"
  // "::shell-action open-terminal X" in device-connection → error naming the known actions
  // "::shell-action connect-this-machine" → "needs a label"; "{{orgName}}" in it → "directive lines hold no variables"
  // five actions → limit error (4)
});
// setup-guide-render.test.ts
it("renders a shell action as its own block in document order", () => {
  expect(doc.blocks.map((b) => b.kind)).toEqual(["markdown", "shell-action", "markdown"]);
});
// guides.http.test.ts
it("imports a device-connection guide and renders its variables for an org member", async () => {
  // values: publicUrl, orgId = the org id, orgName, pluginName; no target parameters accepted (400 for connectionId)
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm exec vitest run packages/plugin-sdk/test/setup-guide.test.ts packages/plugin-sdk/test/setup-guide-render.test.ts packages/kernel/test/catalog/guides.http.test.ts`
Expected: FAIL (`device-connection` unknown).

- [ ] **Step 3: Implement.** The scanner treats `::shell-action <action> <label>` in column 0
  outside fences like a `::check` line (a level-6 marker heading with its own private-use marker,
  regex `/^::shell-action[ \t]+(\S+)(?:[ \t]+(.*?))?[ \t]*$/`, label ≤ `checkLabelChars`); the
  place check lives in `validateSetupGuide`; zh and en documents must carry the same actions in
  the same sections (same rule as checks). `resolvePlace` sets `values.orgId = ctx.org?.orgId ?? null`
  with reason `no_org`.

- [ ] **Step 4: Verify**

Run: same command as Step 2, then `pnpm typecheck && pnpm gen:sdk-api`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(sdk): device-connection guide place and the connect-this-machine shell action

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 3: Device report, `networkAllowlist` and project refusals in the contract

**Files:**
- Modify: `packages/plugin-sdk/src/device-provider.ts` (add types, error, parser)
- Create: `packages/kernel/src/ctx/device-provider-check.ts`
- Modify: `packages/kernel/src/ctx/create-ctx.ts:903-918` (`provide` runs the check)
- Modify: `packages/kernel/src/local-devices/local-device-provider.ts` (`report`,
  `networkAllowlist`)
- Test: `packages/plugin-sdk/test/device-provider.test.ts`,
  `packages/kernel/test/ctx/device-provider-check.test.ts` (new, unit; add to
  `packages/kernel/test/unit-tests.json`), `packages/kernel/test/local-devices/local-device-provider.test.ts`
- Create: `.changeset/device-report.md` (sdk minor, kernel minor)

**Interfaces:**
- Produces (SDK, exact index shapes): `DeviceProvider.report(device: DeviceRef, signal: AbortSignal): Promise<DeviceReport>`; `readonly networkAllowlist: true`; `interface DeviceRef { deviceId: string; orgId: string; handle: SandboxHandle | null }`; `interface DeviceReport { revision; description; home; limits; reset }`; `class ProjectPathRefusedError extends Error { readonly projectPathRefused = true; readonly reason: { en: string; zh?: string } }` + `isProjectPathRefusedError(e): e is ProjectPathRefusedError` (duck-typed like `isSandboxGoneError`); `parseDeviceReport(value: unknown): DeviceReport` (throws `TypeError` on any other shape) with `DEVICE_REPORT_LIMITS = { revisionChars: 128, descriptionChars: 300, limits: 8, limitLabelChars: 60, limitValueChars: 60, homeChars: 4096 }` (`home` passes `validateSandboxPathShape`).
- Produces (kernel): `checkDeviceProvider(plugin: string, impl: unknown): DeviceProvider` — throws `Error("plugin <name>: device-provider@1 requires <member>")` unless `networkAllowlist === true`, `concurrentExec === true`, `report`, `killTagged`, `exec`, `create`, `createFileSystem` are functions; called by `ctx.provide` for `DEVICE_PROVIDER_EXTENSION_POINT`, so a failing provider fails its plugin's setup (not loaded).
- `@local` (kernel-internal, phase 1 only): `report` answers `{ revision: "local-1", description: { en: "Runs on a computer connected with capybara-device; the computer's owner limits it there.", zh: "运行在用 capybara-device 连接的电脑上，电脑的主人在本机限制它。" }, home: <device_machines.home of the active machine or null>, limits: [], reset: false }`.

- [ ] **Step 1: Write the failing tests**

```ts
// device-provider.test.ts
it("parseDeviceReport accepts the index shape and refuses extra keys, long text, bad home", () => {
  const ok = { revision: "r1", description: { en: "Docker container" }, home: null, limits: [], reset: true };
  expect(parseDeviceReport(ok)).toEqual(ok);
  expect(() => parseDeviceReport({ ...ok, outsideSandbox: true })).toThrow(TypeError);
  expect(() => parseDeviceReport({ ...ok, description: { en: "x".repeat(301) } })).toThrow(TypeError);
  expect(() => parseDeviceReport({ ...ok, home: "relative/path" })).toThrow(TypeError);
  expect(() => parseDeviceReport({ ...ok, limits: Array(9).fill({ label: { en: "cpu" }, value: "1" }) })).toThrow(TypeError);
});
it("isProjectPathRefusedError is duck-typed and keeps the reason", () => {
  const e = new ProjectPathRefusedError({ en: "Another connection's directory" });
  expect(isProjectPathRefusedError(e)).toBe(true);
  expect(isProjectPathRefusedError(Object.assign(new Error("x"), { name: "ProjectPathRefusedError", projectPathRefused: true, reason: { en: "y" } }))).toBe(true);
});
// device-provider-check.test.ts
it.each(["networkAllowlist", "concurrentExec", "report", "killTagged"])("refuses a provider without %s", (m) => {
  expect(() => checkDeviceProvider("p", { ...fullFake(), [m]: undefined })).toThrow(`device-provider@1 requires ${m}`);
});
it("passes a complete provider through unchanged", () => {
  const impl = fullFake();
  expect(checkDeviceProvider("p", impl)).toBe(impl);
});
// local-device-provider.test.ts
it("@local reports the fixed description, the machine's home and no reset", async () => { ... });
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm exec vitest run packages/plugin-sdk/test/device-provider.test.ts packages/kernel/test/ctx/device-provider-check.test.ts packages/kernel/test/local-devices/local-device-provider.test.ts`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement** the SDK additions, `checkDeviceProvider`, the `provide` hook
  (next to `checkFilePreviewProvider`) and `@local`'s `report` (it reads `home` through the
  `MachinesService` it already holds; no machine round trip).

- [ ] **Step 4: Verify**

Run: Step 2 command, then `pnpm typecheck && pnpm gen:sdk-api`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(sdk): device reports, the networkAllowlist declaration and project refusals

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 4: Operation scope `{ projectRoot, writeRoots }` and device protocol 5 [review alone, most capable model]

**Files:**
- Modify: `packages/plugin-sdk/src/device-operation.ts:99-106,390-410,454-500` (`SandboxFileScope`,
  `fileScope` parser)
- Modify: `packages/plugin-sdk/src/device-protocol.ts:34-41` (`DEVICE_PROTOCOL_VERSION = 5`,
  `LEGACY_DEVICE_PROTOCOL_VERSION = 4`)
- Modify: `packages/kernel/src/sandbox/operation-authority.ts:81-106,160-205,560-600,640-660,780-790`
  (`PermissionScopeFacts.projectRoot`, `intersectPermissionScope`, kernel-read scope)
- Modify: `packages/kernel/src/sandbox/permission-call-types.ts:86-92` (snapshot gains
  `projectRoot: string | null`)
- Modify: `packages/kernel/src/sandbox/permission-ceiling-writes.ts:230-245` and
  `packages/kernel/src/local-devices/owner-report.ts:150-200` (predicates read `projectRoot` /
  `writeRoots`; browse keeps its `readRoots`)
- Modify: `packages/kernel/src/local-devices/device-routes.ts:61-125` (426 text names protocol 5)
- Modify: `packages/device/src/exec/operation-types.ts:45-55,215-275` (derive the read roots)
- Modify: `packages/testing/src/sandbox-permission-conformance.ts:686-700`
- Modify (scope literals in tests, mechanical): every test file `grep -rl "readRoots" packages/*/test`
  lists except browse-scope cases
- Test: `packages/plugin-sdk/test/device-operation.test.ts`, `packages/kernel/test/sandbox/operation-scopes.test.ts`,
  `packages/kernel/test/sandbox/kernel-reads.test.ts`, `packages/device/test/operation-ceilings.test.ts`,
  `packages/kernel/test/local-devices/device-protocol-activation.test.ts`
- Create: `.changeset/device-scope-project-root.md` (sdk minor, kernel minor, `@capybara-hq/device`
  minor, testing minor)

**Interfaces:**
- Produces: `SandboxFileScope = { kind: "scoped"; projectRoot: string | null; writeRoots: readonly string[] } | { kind: "device" }`; the parser refuses a `readRoots` key; `projectRoot` passes `validateSandboxPathShape`. `SandboxBrowseScope` is unchanged (owner browsing keeps its `readRoots`; phase 2 / 4 own it).
- Kernel values: an operation-boundary call gets `projectRoot` = the bound project's path (null in free mode) and `writeRoots` = today's `baseWriteDirectories` plus accepted write expansions; an instance-boundary call keeps `writeRoots = ["/", workingRoot]` (sorted) and `projectRoot` as above; a kernel read gets `projectRoot = <covering directory>`, `writeRoots = []` (instance boundary: `["/", workingRoot]`).
- Device program (the only reader of read roots until phase 4): its internal `readRoots` =
  sorted unique `[...writeRoots, projectRoot ?? roots.workspace, roots.skills]`, dropping entries
  inside another entry. A kernel-admitted read-directory expansion is no longer conveyed (see
  Index issues 1); the review facts (`baseReadDirectories`, recorded context, events) are unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
// device-operation.test.ts
it("a scoped filesystem carries projectRoot and writeRoots, never readRoots", () => {
  expect(parseSandboxOperationScope({ ...base, filesystem: { kind: "scoped", projectRoot: "/w/p", writeRoots: ["/w/p"] } }).filesystem)
    .toEqual({ kind: "scoped", projectRoot: "/w/p", writeRoots: ["/w/p"] });
  expect(() => parseSandboxOperationScope({ ...base, filesystem: { kind: "scoped", projectRoot: null, readRoots: [], writeRoots: [] } }))
    .toThrow(SandboxScopeValidationError);
});
// operation-scopes.test.ts
it("an operation scope names the project root and the write roots; free mode has projectRoot null", ...);
it("an instance-boundary scope keeps writeRoots [/, workingRoot]", ...);
// kernel-reads.test.ts
it("a kernel read sends projectRoot = the covering directory and no write roots", ...);
// operation-ceilings.test.ts (device)
it("derives read roots from the project root, the write roots and the skills root", () => {
  expect(normalizedReadRoots({ kind: "scoped", projectRoot: "/u/repo", writeRoots: ["/u/repo"] }, roots))
    .toEqual(["/u/repo", "/u/.capybara/skills"]);
});
it("a symlink from the project to outside it is refused for a kernel read (unchanged)", ...);
// device-protocol-activation.test.ts
it("a protocol 4 program gets 426 Update capybara-device", ...);
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm exec vitest run packages/plugin-sdk/test/device-operation.test.ts packages/kernel/test/sandbox/operation-scopes.test.ts packages/kernel/test/sandbox/kernel-reads.test.ts packages/device/test/operation-ceilings.test.ts packages/kernel/test/local-devices/device-protocol-activation.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the SDK shape and parser, the kernel values above (the snapshot's
  `projectRoot` comes from `workingRootOf`'s `projectRoot`, already computed at
  `operation-authority.ts:727`), the device derivation (one exported pure function
  `normalizedReadRoots(fs: SandboxFileScope, roots: SandboxRoots): string[]` in
  `operation-types.ts`), the conformance helper `scoped(writeRoots)` →
  `{ kind: "scoped", projectRoot: root, writeRoots }`, and the protocol constants.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm gen:sdk-api && pnpm exec vitest run packages/plugin-sdk packages/device packages/testing/test packages/kernel/test/sandbox packages/kernel/test/local-devices`
Expected: PASS. Run the replay zero-drift fixtures (`pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts`): unchanged (no model-visible input changed).

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(sdk)!: operation scopes carry the project root and write roots; device protocol 5

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 5: `devices.defaultProvider` with an org override

**Files:**
- Modify: `packages/kernel/src/config/schema.ts:2026-2100` (`devices.defaultProvider`)
- Create: `packages/kernel/src/devices/default-provider-setting.ts`
- Modify: `packages/kernel/src/identity/settings.ts:300-430,650-790` (`devicesDefaultProvider`
  view and patch)
- Modify: `packages/kernel/src/orgs/settings.service.ts:73-110,228-300` (`deviceDefaultProvider`)
- Modify: `apps/web/src/lib/admin.ts` (the settings type only; the controls are phase 3)
- Regenerate: `docs/config.md` (`pnpm gen:config-docs`)
- Test: `packages/kernel/test/config/device-sandbox-config.test.ts`,
  `packages/kernel/test/identity/settings.test.ts`, `packages/kernel/test/orgs/settings.test.ts`
- Create: `.changeset/device-default-provider.md` (kernel minor)

**Interfaces:**
- Produces: config `devices.defaultProvider?: string` (optional, no schema default, `hot: true`,
  env `CAPYBARA_DEVICES__DEFAULT_PROVIDER`, matches `EXTENSION_NAME_RE` or `""`); deployment
  setting key `DEVICES_DEFAULT_PROVIDER_SETTING = "devicesDefaultProvider"` stored
  `{ provider?: string }`; admin `PUT /api/v1/admin/settings` body field
  `devicesDefaultProvider: { provider: string | null }` (null clears; refused with
  `deployment.setting_from_config` when the startup config sets it); view
  `{ provider: string | null; source: DeviceSandboxSource }`.
- `readPlatformDefaultProvider(cfg: KernelConfigService, db: KernelSchemaDb, log): Promise<{ provider: string | null; source: DeviceSandboxSource }>` in `default-provider-setting.ts` (env > file / Nacos > PG > null; `""` reads null; an invalid stored value reads null with a warning).
- Org settings: `deviceDefaultProvider?: string` (absent follows the platform; invalid stored
  value reads absent); PATCH `deviceDefaultProvider: string | null`; setting a provider that is
  not on in the org → 400 `org.device_provider_not_available` (registered in `errors.ts`).
  `Platform` operations follow from the shared schemas (`platform-parity.test.ts` stays green).

- [ ] **Step 1: Write the failing tests**

```ts
// device-sandbox-config.test.ts
it("devices.defaultProvider: env wins over file, empty reads as none", ...);
// identity/settings.test.ts
it("devicesDefaultProvider: stored, read back with source db, cleared with null, read-only when configured", ...);
// orgs/settings.test.ts
it("deviceDefaultProvider: accepted only for a provider on in the org; null clears", async () => {
  await expect(patch({ deviceDefaultProvider: "device-fake-b" })).rejects.toMatchObject({ code: "org.device_provider_not_available" });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm exec vitest run packages/kernel/test/config/device-sandbox-config.test.ts packages/kernel/test/identity/settings.test.ts packages/kernel/test/orgs/settings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** following the `devicesOutsideSandbox` pattern
  (`sandbox/device-sandbox-settings.ts`), per the `adding-config` skill; the org check uses
  `ExtensionPointDefaults.providersFor(orgId, "device-provider")`.

- [ ] **Step 4: Verify**

Run: Step 2 command, then `pnpm gen:config-docs && pnpm check:config-docs && pnpm exec vitest run tools/checks/test/platform-parity.test.ts packages/kernel/test/platform`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(kernel): devices.defaultProvider with an org override

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 6: Fixture `sandbox-fake` → `device-fake`, plus `device-fake-b`

**Files:**
- Move: `packages/kernel/test/fixtures/plugins/sandbox-fake/` → `packages/kernel/test/fixtures/plugins/device-fake/`
  (the brief's "packages/testing" location does not exist; the fixture lives in the kernel tests)
- Create: `packages/kernel/test/fixtures/plugins/device-fake-b/index.ts`
- Modify: `packages/kernel/test/helpers/plugin-packages.ts:461-480` (`deviceFakePkg`,
  `deviceFakeBPkg`), `packages/kernel/test/helpers/sandbox.ts:130-160` (`seedDevice` records
  `device-fake` for a cloud device), every importer (`grep -rl "sandbox-fake" packages/kernel/test tools/checks`)
- Move: `packages/kernel/test/sandbox/sandbox-fake.test.ts` → `device-fake.test.ts`; update
  `packages/kernel/test/unit-tests.json:123` and `tools/checks/test-portfolio-baseline.json:79,105`
- Modify: `.agents/skills/writing-sandbox-providers/SKILL.md` Tests section (paths)

**Interfaces:**
- Consumes: Task 3's `report`, `networkAllowlist`.
- Produces: plugin `device-fake` (deployment config `{ root, … }` as today, `provides: [DEVICE_PROVIDER_EXTENSION_POINT]`,
  `networkAllowlist: true`, `report` answering `{ revision: <fs id or "none">, description: { en: "Test device (a local directory, no isolation)" }, home: null, limits: [], reset: true }`);
  plugin `device-fake-b`: the same factory (`createFakeSandbox`) under the name `device-fake-b`
  with its own `root` and description `"Second test device"`; helper exports keep their names
  (`createFakeSandbox`, `readFakeSandboxOps`, …).

- [ ] **Step 1: Write the failing test**

```ts
// packages/kernel/test/sandbox/device-fake.test.ts
it("device-fake and device-fake-b report their own description and declare networkAllowlist", async () => {
  expect((await a.report({ deviceId, orgId, handle: null }, signal)).description.en).toBe("Test device (a local directory, no isolation)");
  expect((await b.report({ deviceId, orgId, handle: null }, signal)).description.en).toBe("Second test device");
  expect(a.networkAllowlist).toBe(true);
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm exec vitest run packages/kernel/test/sandbox/device-fake.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Rename** (`git mv`), add `device-fake-b`, update importers and lists.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm check:test-portfolio && pnpm test:unit && pnpm exec vitest run packages/kernel/test/sandbox packages/kernel/test/devices packages/kernel/test/background`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "test(kernel): rename the sandbox-fake fixture to device-fake, add device-fake-b

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 7: `DeviceProviders`

**Files:**
- Modify: `packages/kernel/src/sandbox/providers.ts` (whole file), `packages/kernel/src/sandbox/providers.module.ts`
  (imports the module that exports `ExtensionPointDefaults`)
- Test: `packages/kernel/test/sandbox/device-providers.test.ts` (new, integration: PG for the
  org enablement)

**Interfaces:**
- Consumes: Task 5 `readPlatformDefaultProvider`, `OrgSettingsService` read of `deviceDefaultProvider`.
- Produces (index names): `@Injectable() class DeviceProviders` with
  `forDevice(provider: string): DeviceProviderEntry | undefined` (internal map first, then the
  loaded `device-provider@1` extension of that plugin name; guarded by `guardProviderConnection`),
  `onInOrg(orgId: string): Promise<DeviceProviderEntry[]>` (from `providersFor`, extension
  name order, internal providers never included), `defaultFor(orgId: string): Promise<DeviceProviderEntry | undefined>`
  (the org's `deviceDefaultProvider`, else the platform's; returned only when it is in
  `onInOrg(orgId)`, else undefined — no fallback to another provider);
  `type DeviceProviderEntry = { plugin: string; version: string; impl: DeviceProvider; binder?: SandboxInstanceBinder }`.
  Additions beside the index: `loaded(): DeviceProviderEntry[]` (every loaded extension
  provider, for the sweeps), `register(entry)` (internal `@…` names only, as today),
  `isOnInOrg(orgId: string, provider: string): Promise<boolean>` (internal providers: registered).
- `cloud()` and `forName()` stay until Task 8's last step; the class keeps the old name
  `SandboxProviders` as a type alias **only inside this branch** until Task 8 deletes it.

- [ ] **Step 1: Write the failing tests**

```ts
describe("DeviceProviders", () => {
  it("onInOrg lists the providers enabled in the org, in name order, never @local", ...);
  it("provider switched on in one org only: onInOrg differs per org and follows a toggle at once", ...);
  it("forDevice finds @local in the internal map and an extension by plugin name; unknown → undefined", ...);
  it("defaultFor: org override wins; platform otherwise; a default not on in the org → undefined", async () => {
    await setOrgDefault(orgA, "device-fake-b"); await disable(orgA, "device-fake-b");
    expect(await providers.defaultFor(orgA)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm exec vitest run packages/kernel/test/sandbox/device-providers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** (reads every call; no in-process cache).

- [ ] **Step 4: Verify**

Run: Step 2 command, `pnpm typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(kernel): DeviceProviders resolves a device's provider and the providers on in an org

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 8: Devices bound to their provider; per-provider sweeps [review alone, most capable model]

**Files:**
- Modify: `packages/kernel/src/sandbox/sandbox.service.ts` (lines 139-141, 366-380, 483-500,
  630-760, 900-910, 1460-1500, 2045-2055, 2520-2900, 2990-3200, 3480-3500, 3660, 3720,
  3915-4030, 4080-4110)
- Modify: `packages/kernel/src/devices/access.ts` (whole file),
  `packages/kernel/src/devices/conversation-devices.ts:195-382`,
  `packages/kernel/src/sandbox/permission-facts.ts:397,560,887`,
  `packages/kernel/src/sandbox/cloud-permission-snapshot.ts:386`,
  `packages/kernel/src/sandbox/legacy-retirement.ts:230-265,1300`,
  `packages/kernel/src/sandbox/operation-reconcile.job.ts:106,215`,
  `packages/kernel/src/devices/legacy-cleanup.job.ts:69-110`,
  `packages/kernel/src/background/poll.job.ts:74,120-125`,
  `packages/kernel/src/tools/builtins/sandbox/common.ts:78,215-222,662-675,1020-1033`,
  `packages/kernel/src/lifecycle/kernel-lifecycle.ts:278-285` (config warnings per loaded provider),
  `packages/kernel/src/sandbox/providers.ts` (delete `cloud`, `forName`, `providerForDevice`, the alias)
- Modify: `packages/kernel/test/helpers/sandbox.ts:59-110` (`providers` seam: `forDevice`,
  `onInOrg`, `loaded`)
- Test: `packages/kernel/test/sandbox/providers-per-device.test.ts` (rewrite),
  `packages/kernel/test/devices/access.test.ts` (drop demotion cases, add binding cases),
  `packages/kernel/test/tools/sandbox/device-errors.test.ts`

**Interfaces:**
- Consumes: Task 7 `DeviceProviders`.
- Produces:
  - `SandboxService.availableFor(deviceId: string, orgId: string): Promise<boolean>` (provider
    loaded and on in the device's org); `cloudAvailable` deleted.
  - `deviceUnavailable(provider: string | null): ApiError` (`device.unavailable`, 503) text:
    `This device's provider ${provider} is off in this organization or not installed; its files are kept, and the device works again once an org admin switches the provider back on`
    (null provider: `This device has no provider; delete it and create a new one`).
  - Tool text `ENV_UNAVAILABLE_TEXT`: `"This conversation's device runs on a device provider that is off in this organization or not installed; its files are kept. Ask an org admin to switch the provider back on, or start a new conversation on another device."`
  - `sandboxUsable(deps, orgId, conversationId)`: true when the conversation's device (an unbound
    one: the device it would bind to) has its provider on in the org; without a conversation,
    true when `onInOrg(orgId)` is non-empty.
  - Sweeps: `suspendIdle` and `reconcileMarked` loop over `providers.loaded()`, each restricted to
    rows `device_instances.provider = p.plugin` (reconcile cursor key per provider:
    `capk:sandbox-reconcile-cursor:<plugin>`); `destroyInactive` handles gone rows of every loaded
    provider and `@local`, inactivity only on loaded extension providers. Rows of a provider not
    loaded are skipped, never touched.
  - Removed: `otherProvider`, "current provider" takeover of `creating` rows, `isCloudProvider`
    branches. An instance row whose provider differs from `devices.provider` reads as
    `device.unavailable` (it cannot occur for rows this kernel writes).

- [ ] **Step 1: Write the failing tests**

```ts
// providers-per-device.test.ts (two fakes loaded: device-fake, device-fake-b)
it("each device uses its own provider; both run in one org at once", ...);
it("a provider switched off in the org: the device is unavailable, its row, files and instance kept, nothing created elsewhere", async () => {
  await disable(org, "device-fake-b");
  await expect(svc.withSandbox(ctxB, run)).rejects.toMatchObject({ code: "device.unavailable" });
  expect(readFakeSandboxOps(rootA)).toEqual(opsBefore); // provider A never called for B's device
  expect(await instanceRow(devB)).toMatchObject({ provider: "device-fake-b", fs_status: "ready" });
});
it("provider switched on in one org only: org B's device unavailable, org A's works", ...);
it("an uninstalled provider: availableFor false, destroyDevice leaves the row for a retry", ...);
it("sweeps call each provider only for its rows", async () => {
  // two idle running instances, one per provider → suspendIdle(now) === 2; ops logs: one suspend each
});
it("a provider unloaded between ticks: its idle rows stay running and untouched", ...);
it("@local is never suspended or destroyed for inactivity (unchanged)", ...);
// device-errors.test.ts
it("device.unavailable becomes the actionable provider-off tool text", ...);
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm exec vitest run packages/kernel/test/sandbox/providers-per-device.test.ts packages/kernel/test/devices/access.test.ts packages/kernel/test/tools/sandbox/device-errors.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** Resolution everywhere is `providers.forDevice(devices.provider)`
  plus, on the use path (`DeviceAccess.usable`, `SandboxService` acquisition,
  `ConversationDevices.forTool` / `usableNow`), `providers.isOnInOrg(orgId, provider)`; lifecycle
  cleanup (destroy, sweeps, legacy cleanup, revocation delivery) only needs `forDevice` (loaded).
  No locks are taken inside transactions (the existing order stays).

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm test:unit && pnpm exec vitest run packages/kernel/test/sandbox packages/kernel/test/devices packages/kernel/test/background packages/kernel/test/tools packages/kernel/test/local-devices && pnpm exec vitest run --project kernel-container packages/kernel/test/sandbox`
Expected: PASS; `git grep -n "\.cloud()\|providerForDevice\|forName(\|cloudAvailable" packages/kernel/src` prints nothing.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(kernel)!: bind devices to their provider; providers per org; per-provider sweeps

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 9: Stored device report [review alone, most capable model]

**Files:**
- Create: `packages/kernel/src/migrations/0174_device_report.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts:1276-1310` (`DevicesTable.report`, `report_at`)
- Create: `packages/kernel/src/sandbox/device-reports.ts`
- Modify: `packages/kernel/src/sandbox/sandbox.module.ts` (provide/export `DeviceReports`),
  `packages/kernel/src/sandbox/sandbox.service.ts` (after a committed create and after a resume,
  under the exclusive lease, outside the transaction)
- Test: `packages/kernel/test/sandbox/device-reports.test.ts` (new, integration)

**Interfaces:**
- Migration: `ALTER TABLE devices ADD COLUMN IF NOT EXISTS report jsonb; ALTER TABLE devices ADD COLUMN IF NOT EXISTS report_at timestamptz;` (additive, no backfill).
- Produces: `@Injectable() class DeviceReports` with
  `refresh(entry: DeviceProviderEntry, ref: DeviceRef, signal: AbortSignal): Promise<{ changed: boolean }>`
  (calls `report` bounded at 10 s, `parseDeviceReport`, writes `report` + `report_at` only while
  `devices.provider = entry.plugin`; `changed` compares `revision`; a failure or invalid answer is
  logged once per device per hour (Redis key with TTL) and leaves the stored report as it was) and
  `read(orgId: string, deviceId: string): Promise<DeviceReport | null>` (PG only, re-parsed;
  invalid stored → null). Phase 2 calls `refresh` from `ctx.devices.reportChanged` and bumps the
  epoch on `changed`.

- [ ] **Step 1: Write the failing tests**

```ts
it("a first use stores the provider's report; read returns it without calling the provider", ...);
it("a resume refreshes it; changed is true only when the revision differs", ...);
it("an invalid or failing report keeps the stored one and never fails the use", ...);
it("a report is never written for a device whose provider changed under it", ...);
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm exec vitest run packages/kernel/test/sandbox/device-reports.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** (migration per `writing-migrations`; `pnpm check:migrations`).

- [ ] **Step 4: Verify**

Run: Step 2 command, `pnpm check:migrations && pnpm exec vitest run packages/kernel/test/sandbox/sandbox.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(kernel): store each device's provider report

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 10: Project path refusals

**Files:**
- Modify: `packages/kernel/src/devices/device-projects.service.ts:650-700` (`listFailure`)
- Modify: `packages/kernel/src/errors.ts` (`"device.project_refused": 422`)
- Modify: `packages/kernel/test/fixtures/plugins/device-fake/index.ts` (deployment option
  `refusePaths?: string[]`: `list` throws `ProjectPathRefusedError` for them)
- Test: `packages/kernel/test/devices/projects.http.test.ts`

**Interfaces:**
- Produces: a `list(path)` throwing `isProjectPathRefusedError` → `ApiError("device.project_refused", reason.en, [{ reason }])`
  (details carry `{ en, zh? }` for the web), checked before the existing `stat` fallback.

- [ ] **Step 1: Write the failing test**

```ts
it("a provider refusing a path answers 422 device.project_refused with its reason", async () => {
  const res = await addProject({ path: "/refused/dir" });
  expect(res.statusCode).toBe(422);
  expect(res.json()).toMatchObject({ code: "device.project_refused", message: "Refused by the test provider" });
});
```

- [ ] **Step 2: Run, expect failure** — `pnpm exec vitest run packages/kernel/test/devices/projects.http.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — same command → PASS.
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(kernel): a provider may refuse a project path with a reason

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 11: Device creation takes a provider; the default device follows `defaultFor` [review alone, most capable model]

**Files:**
- Modify: `packages/kernel/src/devices/devices.service.ts` (lines 60-110 view types, 270-500
  list / create / insert / checkCreate, 1005-1180 ensureDefault / demote / formerDefaults
  (deleted), 1270-1420 views, 1596)
- Modify: `packages/kernel/src/devices/dto.ts:12,129` (`DeviceCreateBody`),
  `packages/kernel/src/devices/devices.controller.ts:40,85-102`,
  `packages/kernel/src/devices/devices.schemas.ts:17-40`, `packages/kernel/src/devices/label.ts`,
  `packages/kernel/src/platform/ops/devices.ops.ts:27,137-230`, `packages/kernel/src/errors.ts`
- Test: `packages/kernel/test/devices/devices.http.test.ts`, `packages/kernel/test/devices/access.test.ts`,
  `packages/kernel/test/devices/label.test.ts`, `tools/checks/test/platform-parity.test.ts` (stays green)

**Interfaces:**
- Consumes: Task 7 (`onInOrg`, `defaultFor`, `isOnInOrg`), Task 9 `DeviceReports.read`.
- Produces:
  - `DeviceCreateBody = { name: DeviceName; provider?: string }` (`EXTENSION_NAME_RE`);
    `DevicesService.create(orgId, accountId, input: { name: string; provider?: string }, actorTokenId?, auditDetail?)`;
    absent `provider` → `defaultFor(orgId)`, none → 400 `device.provider_required`
    ("Choose a device provider: <names on in the org>"); a provider not in `onInOrg` (unknown,
    off, `@local`) → 400 `validation_failed` at path `provider`. Audit `device.created` detail
    gains `provider`. `checkCreate(orgId, accountId, name, provider?)` mirrors it.
  - `createLocal` unchanged (phase 2 replaces it).
  - `ensureDefault(orgId, accountId): Promise<string | null>`: the live default if any (whatever
    its provider's state), else a new default on `defaultFor(orgId)`, else null. No demotion, no
    restore, no swap.
  - `DeviceList = { items; defaultId; lastUsedId; providers: { plugin: string; displayName: LocalizedName | null }[]; defaultProvider: string | null }`
    (`cloudAvailable` removed); `DeviceView` drops `demotedFrom`, keeps `provider: string | null`,
    `available` = `isOnInOrg(orgId, provider)`, adds `report: DeviceReport | null` (stored copy).
  - `deviceLabel(v: Pick<DeviceView, "name">, locale)`: `name ?? "Personal" / "个人设备"`.
  - Platform op `devices.create` input gains optional `provider`; `devices.list` returns
    `providers` / `defaultProvider`; errors list `device.provider_required` with its `next`.

- [ ] **Step 1: Write the failing tests**

```ts
// devices.http.test.ts (device-fake and device-fake-b on in the org)
it("POST /devices with provider binds the device to it for life", ...);
it("POST /devices without provider uses the org default; with none answers device.provider_required", ...);
it("POST /devices naming a provider off in the org, @local or an unknown name is refused and creates nothing", async () => {
  for (const provider of ["device-fake-off", "@local", "nope"]) {
    expect((await create({ name: "x", provider })).statusCode).toBe(400);
  }
  expect(await countDevices()).toBe(before);
});
it("GET /devices lists the providers on in the org and the default provider; no cloudAvailable", ...);
it("a device whose provider is switched off lists as available false with its stored report", ...);
// access.test.ts
it("ensureDefault never demotes: a default whose provider is off stays the default", ...);
it("ensureDefault makes no default when defaultFor is undefined", ...);
// label.test.ts
it("the default is Personal / 个人设备; a given name wins", ...);
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm exec vitest run packages/kernel/test/devices tools/checks/test/platform-parity.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**; delete `demote`, `formerDefaults`, `stranded`, `demotedProvider`,
  `deviceProvider`'s current-provider argument; `devices.demoted_from_provider` is no longer
  selected or written.

- [ ] **Step 4: Verify**

Run: Step 2 command, `pnpm typecheck && pnpm check:platform-ops`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(kernel)!: devices are created on a chosen provider; no demoted defaults

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 12: Web interim: provider list in the devices pages

**Files:**
- Modify: `apps/web/src/lib/devices.ts:140-275`, `apps/web/src/lib/query/devices.ts:11`,
  `apps/web/src/components/use-device-name.ts`, `apps/web/src/components/DeviceCreateDialog.tsx:45-130`,
  `apps/web/src/app/(app)/devices/view.tsx:55-85`, `apps/web/src/app/(app)/devices/[id]/view.tsx:225-245`,
  `apps/web/src/components/conversation/useSelection.ts:280-340`, i18n zh / en message files
- Test: `apps/web/test/devices.test.tsx` (existing; add cases)

**Interfaces:**
- Consumes: Task 11 `DeviceList.providers`, `defaultProvider`, `DeviceView.available`, `report`.
- The cloud option of 新建设备 shows when `providers.length > 0`; with two or more providers it
  shows a design `Select` of their display names (default preselected); the request sends
  `provider`. The detail page shows `report.description` in the overview and drops the demoted
  label. Phase 3 replaces this dialog with provider cards and guides.

- [ ] **Step 1: Write the failing tests**

```tsx
it("新建设备 with two providers offers a provider choice and posts the chosen one", ...);
it("with no provider on in the org the cloud option is absent and the local steps remain", ...);
it("an unavailable device says its provider is off in this organization", ...); // zh: 「此设备的提供方已在本组织关闭或未安装，文件仍保留」
```

- [ ] **Step 2: Run, expect failure** — `pnpm exec vitest run apps/web/test/devices.test.tsx` → FAIL.
- [ ] **Step 3: Implement** with design components only (`pnpm check:web-ui`, `pnpm check:i18n`).
- [ ] **Step 4: Verify** — same command plus `pnpm check:web-ui && pnpm check:i18n` → PASS.
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(web): choose the device provider when creating a device

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 13: Docs and skill rename

**Files:**
- Move: `.agents/skills/writing-sandbox-providers/` → `.agents/skills/writing-device-providers/`
  (frontmatter `name`, description; contract section: `device-provider@1`, `multi`, `report`,
  `networkAllowlist`, scope, devices bound for life, per-provider sweeps, unavailable rule;
  `@local` section marked "until phase 2")
- Modify: `AGENTS.md` (Sandboxes line: skill link; Extensions line: `device-provider@1` is a
  `multi` point), `docs/architecture.md`, `.agents/skills/writing-extensions/SKILL.md`,
  `.agents/skills/writing-tools/SKILL.md` (links)
- Test: `pnpm check:agent-docs`, `pnpm check` (skill frontmatter and link checks)

- [ ] **Step 1:** Run `pnpm check:agent-docs` after the move without fixing links → expect FAIL
  naming the dead `writing-sandbox-providers` links.
- [ ] **Step 2:** Update every link and the text listed above.
- [ ] **Step 3:** Run `pnpm check` → PASS.
- [ ] **Step 4: Commit**

```bash
git commit -am "docs: writing-device-providers replaces writing-sandbox-providers

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 14: Plugins repo: `device-docker` (and the repo-wide rename)

Runs in `/Users/grant/Capybara/plugins` (a worktree from `origin/main`) after the SDK, testing
and kernel releases carrying Tasks 1-11 (index Release order step 1).

**Files:**
- Modify: `pnpm-workspace.yaml` overrides and root `package.json` devDependencies: the released
  `@capybara-hq/plugin-sdk`, `@capybara-hq/kernel`, `@capybara-hq/testing` versions (one
  instance each)
- Move: `plugins/sandbox-docker/` → `plugins/device-docker/`; `package.json` name
  `@capybara-hq/plugin-device-docker` (version continues from `0.1.0-rc.21`, so image tags
  `ghcr.io/capybara-hq/capybara-sandbox{,-egress}:<version>` never collide; image names kept),
  `.capybara-plugin/plugin.json` (`name: device-docker`, displayName 「Docker 设备」 / "Docker
  devices", description without `sandbox@2`, `setupGuides: [{ id: "connect", place: "device-connection" }]`)
- Create: `plugins/device-docker/guides/connect.md`, `connect.zh.md` (title, one paragraph: what
  the device is, that files are kept until deleted; "Give it a name, then create it.")
- Modify: `plugins/device-docker/src/index.ts` (`DEVICE_PROVIDER_EXTENSION_POINT`),
  `src/provider.ts` (`networkAllowlist: true`, `report`), `src/operations.ts:350-360,515-545`
  (`isInstanceScope` and `checkRoots` read `writeRoots` / `projectRoot`)
- Modify: `.changeset/config.json` (`fixed` group with the new names), `.capybara-plugin/marketplace.json`
  (`capybara-plugin marketplace --write`), `tsconfig.json` references, `.github/workflows/ci.yml`,
  `.github/workflows/images.yml` (paths `plugins/device-docker/image`, `…/egress-proxy`),
  `tools/icons/src/plugins.ts`, `tools/checks/test/*.test.ts`, `tools/ci/test/affected.test.ts`,
  `AGENTS.md`, `README.md`, `.agents/skills/writing-extensions/SKILL.md`
- Move: `.agents/skills/writing-sandbox-providers/` → `.agents/skills/writing-device-providers/`
- Create: `.changeset/device-docker.md` (minor, "renamed from sandbox-docker; device-provider@1")
- Test: `plugins/device-docker/test/manifest.test.ts`, `test/instance-boundary.test.ts`,
  `test/permission-scopes.test.ts`

**Interfaces:**
- `report(ref)` answers `{ revision: "<plugin version>:<runtime>:<handle id or none>", description: { en: "A Docker container (runc or gVisor) with its files on a volume; the container is the sandbox.", zh: "Docker 容器（runc 或 gVisor），文件保存在卷上；容器本身就是沙箱。" }, home: null, limits: [cpu, memory, disk from the instance's recorded limits when the handle is known, else []], reset: true }`.

- [ ] **Step 1: Write the failing tests**

```ts
// manifest.test.ts
it("provides device-provider@1, declares networkAllowlist and ships the device-connection guide", () => {
  expect(plugin.provides).toEqual([DEVICE_PROVIDER_EXTENSION_POINT]);
  expect(createDockerSandbox(cfg).networkAllowlist).toBe(true);
});
it("report describes the container and offers reset", async () => {
  expect(await provider.report({ deviceId, orgId, handle: null }, signal)).toMatchObject({ reset: true, home: null });
});
// instance-boundary.test.ts
it("a scope with writeRoots [/, workingRoot] is the whole instance; a narrower one is refused", ...);
```

- [ ] **Step 2: Run, expect failure** — `pnpm exec vitest run plugins/device-docker/test/manifest.test.ts plugins/device-docker/test/instance-boundary.test.ts` → FAIL.
- [ ] **Step 3: Implement** the move and edits; `pnpm install` refreshes the lockfile.
- [ ] **Step 4: Verify** — `pnpm typecheck && pnpm check && pnpm exec vitest run plugins/device-docker` → PASS (docker-backed suites run where Docker is available, as today).
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(device-docker)!: sandbox-docker becomes the device-provider@1 plugin device-docker

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 15: Plugins repo: `device-e2b`

**Files:**
- Move: `plugins/sandbox-e2b/` → `plugins/device-e2b/`; package `@capybara-hq/plugin-device-e2b`
  (version continues from `0.1.0-rc.21`), `plugin.json` (`name: device-e2b`, displayName 「E2B
  设备」 / "E2B devices", `setupGuides: [{ id: "connect", place: "device-connection" }]`)
- Create: `plugins/device-e2b/guides/connect.md`, `connect.zh.md`
- Modify: `src/index.ts`, `src/provider.ts` (`networkAllowlist: true`, `report`),
  `src/operations.ts:345-360,555-580`, `.changeset/config.json`, marketplace, tsconfig, CI,
  icons (the entries Task 14 left for e2b)
- Create: `.changeset/device-e2b.md`
- Test: `plugins/device-e2b/test/manifest.test.ts`, `test/permission-scopes.test.ts`

**Interfaces:**
- `report` answers `{ revision: "<plugin version>:<template>:<handle id or none>", description: { en: "An E2B sandbox (microVM) whose files are kept by pausing it; the microVM is the sandbox. E2B's metadata service stays reachable (see README).", zh: "E2B 沙箱（微型虚拟机），暂停时保留文件；虚拟机本身就是沙箱。E2B 元数据端点仍可达（见 README）。" }, home: null, limits: [], reset: true }`. `networkAllowlist: true` holds also for self-hosted `domainAllowlist: false` (it degrades to closed, never open).

- [ ] **Step 1: Write the failing tests** (manifest: provides, `networkAllowlist`, guide; report shape; scope `writeRoots` includes `/`).
- [ ] **Step 2: Run, expect failure** — `pnpm exec vitest run plugins/device-e2b/test/manifest.test.ts plugins/device-e2b/test/permission-scopes.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — `pnpm verify` → PASS; then the live E2B tests once with the key file (`CAPYBARA_TEST_E2B_*`, loaded only inside the command).
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(device-e2b)!: sandbox-e2b becomes the device-provider@1 plugin device-e2b

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

After merge and release: deprecate the old npm names
(`npm deprecate @capybara-hq/plugin-sandbox-docker "renamed to @capybara-hq/plugin-device-docker"`,
same for e2b) — a maintainer action, listed in the PR description.

---

### Task 16: Core pins `device-docker`

Runs after the plugins release (index Release order step 1, same core PR train).

**Files:**
- Modify: `packages/kernel/bootstrap.json` (`marketplace.commit` = the released plugins commit;
  entry `{ name: "device-docker", source: "npm", npm: "@capybara-hq/plugin-device-docker", version, integrity, required: false }`
  where `sandbox-docker` stood; `device-e2b` stays a marketplace install as before)
- Modify: `docker/compose.dev.yaml:53-90`, `docker/compose.yaml` (git build contexts
  `…#<commit>:plugins/device-docker/image` and `…/egress-proxy`)
- Modify: `tools/checks/src/bootstrap-network.ts:56-70,243-260` (`PLUGIN_HAPROXY_COPY`,
  `PLUGIN_SANDBOX_RUNTIME_SUMS` under `plugins/device-docker/`), its tests
- Create: `.changeset/pin-device-docker.md` (`@capybara-hq/capybara` patch: image-only)

- [ ] **Step 1:** Run `pnpm check:bootstrap --network` with only the paths changed → expect FAIL
  (`bootstrap-haproxy` / `bootstrap-compose-ref` at the old commit).
- [ ] **Step 2:** Pin, update compose refs and the check paths.
- [ ] **Step 3:** Run `pnpm check:bootstrap --network && pnpm exec vitest run tools/checks` → PASS;
  `docker compose -f docker/compose.dev.yaml --profile sandbox build` succeeds.
- [ ] **Step 4: Commit**

```bash
git commit -am "chore(bootstrap): pin device-docker

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

Report to the maintainer: repo, PR number, head sha and merge order for the core PR (Tasks
1-13), the plugins PR (14-15) and the pin PR (16).

---

## Index issues

1. **Read expansions vs. the scope without read roots.** The kernel's review still proposes and
   admits per-call read-directory expansions (`PermissionExpansion.readDirectories`,
   `operation-authority.ts:474`), and they reach the recorded context and events. With
   `scoped{ projectRoot, writeRoots }` they cannot reach a provider, so on a local device an
   approved read outside the project is refused by the machine from phase 1 until phase 4 makes
   reads "the whole machine minus denies". Instance-boundary providers are unaffected. This plan
   accepts the interim narrowing (Task 4). Alternatives for the maintainer: move the scope change
   into phase 4 with the local read model, or stop proposing read expansions in phase 1 (a
   review and replay change: `conversations/events.ts`, `runtime/context/permission-profile.ts`).
2. **Protocol version.** The scope change alters protocol 4's operation frames, so Task 4 bumps
   `DEVICE_PROTOCOL_VERSION` to 5 here (a mismatched program gets the 426 instead of parse
   errors). The index says the bump to 5 happens in phase 2; phase 2 should bump to 6, or phases
   1 and 2 ship in one release and phase 2 keeps 5.
3. **`project.refused`** sits outside the existing `device.project_*` code family
   (`device.project_path_missing`, `device.project_outside_mode`); kept as the index names it.
4. **Fixture location.** `sandbox-fake` lives in `packages/kernel/test/fixtures/plugins/`, not in
   `packages/testing`; Task 6 renames it in place.
5. **`DevicesCtx.reportChanged`** is listed in the shared interfaces without a phase; this plan
   stores reports (Task 9, `DeviceReports.refresh` returns `changed`) and leaves the `ctx`
   method and the epoch bump to phase 2.
6. **Settings UI.** `devices.defaultProvider` and the org override are settable through config,
   the admin / org settings APIs and the Platform tool in this phase; their web controls belong
   with phase 3's device pages.
