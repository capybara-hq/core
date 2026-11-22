# Device Providers Phase 3: Network Setting, Device Page, 新建设备 with Guides

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task, layered with
> `wave-planned-subagent-development`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One network setting in the kernel for every device (local included), network asks that
offer only what the provider can enforce, a device page reduced to 概览 / 网络 / 项目 / 重建文件 /
删除设备, and a 新建设备 dialog that offers the providers on in the org with each one's
connection guide.

**Architecture:** The device layer of `effectiveDeviceSandbox` becomes one shape read from
`devices.network_mode` / `network_hosts` for every device; the device network route and its
Platform operation accept every device; a network ask offers "this run" only when the device's
permission support has `perOperationHosts`, otherwise only "add to this device's list" (written in
the decision's transaction, applied by the provider's `limitsApplyAt` timing). `GET /devices`
lists the providers on in the org with display name, description, dial-in flag and their
`device-connection` guide; `POST /devices` takes a provider. The web renders provider cards plus
the guide (`SetupGuideSection`, with the `::shell-action connect-this-machine` block as a primary
button only inside a shell offering the device capability) and one device page for every provider
driven by the device report.

**Tech Stack:** TypeScript, NestJS + Fastify kernel, Kysely/PG, Next.js web with TanStack Query and
`@capybara-hq/design`, next-intl, vitest.

**Spec:** `docs/superpowers/specs/2026-11-21-device-provider-design.md` (§6.3, §6.4, §6.6; §6.1 for
the report and project refusals). Index: `docs/superpowers/plans/2026-11-21-device-provider.md`
(its names and signatures are fixed). Skills to read before starting: `writing-web-ui`,
`writing-kernel-api`, `writing-sandbox-providers` (renamed `writing-device-providers` by phase 1 or
2), `writing-plugins` (setup guides), `writing-tools` (network asks).


## Reconciliation (index rulings; these win over the tasks below)

- R3: Task 1 does only what phase 1 Task 2 did not (check on main first).
- R4: the error code is `device.project_refused` (422); phase 1 maps the provider error; Task 7 keeps the hidden-count / `mode` / `withinMode` removal.
- R6: Task 3 does only the fail-closed `providerLayerOf(null)`, the `owner` parameter removal and `deviceListAddRefusal`; the device layer for every device is phase 2's.
- R7: Task 4 skips the policy route and service (deleted in phase 2).
- R15: Task 10 wires the button to the shell's current `device@1.connect`; phase 5 switches it.
- Migration numbers: the next free number at execution time.

## Starting point (after phases 1 and 2 are merged)

This phase is written against main as of 2026-11-21 plus what the index assigns to phases 1 and 2.
It assumes these hold when it starts; where one does not, the task named after it completes it
(no compatibility code either way):

- `DeviceProviders` (`forDevice`, `onInOrg`, `defaultFor`) exists; `devices.provider` is a plugin
  name; `cloud()`, `LOCAL_PROVIDER`, `isInternalProvider`, `demotedFrom`, `stranded` are gone
  (phase 1). `DeviceList.cloudAvailable` is gone or replaced by some providers field: Task 6
  replaces it with `providers: DeviceProviderOption[]`.
- `DeviceProvider.report(device, signal)` and `ProjectPathRefusedError` are exported by the SDK
  (phase 1); the dial-in channel and `device-local` exist; `device_machines` lost `features`,
  `local_policy`, `owner_report`, `pending_policy_ops`, `home`, `roots`, `mode`; operation scopes
  carry no read roots (phase 2).
- If `POST /orgs/:orgId/devices/:id/policy` or `DeviceView.ownerCeiling` / `DeviceView.network`
  (machine features) is still in the kernel, Task 4 deletes them. If `restrictedProjectReach` is
  still in `DeviceSandbox` / `ConsentReach`, Task 3 deletes it. If the SDK lacks the
  `device-connection` place, Task 1 adds it; if `device.project_refused` is not mapped, Task 7 maps it.

## Global Constraints

Every line of the index's Global Constraints applies. Phase-specific:

- `apps/web` writes no styles (`check:web-ui`); pages are templates + design components; every read
  is a `defineQuery`, every write `useAppMutation`; one box is enough (no box in a box).
- UI copy in zh and en (`check:i18n`): zh says 设备 / 本机 / 平台 / 智能体, never 企业 or `agent`.
  Removed copy is deleted from both files in the same task that removes its last use.
- `window.capybaraShell` stays read only through `apps/web/src/lib/shell.ts`; `use-this-machine.ts`
  and `shell.ts` are not changed in this phase (phase 5 owns them; `device@1` stays).
- Every route change keeps `pnpm check:platform-ops` green: a removed route takes its exclusion;
  a changed body changes the shared schema (`devices.schemas.ts`), never a copy.
- Kernel tests: new unit tests join `packages/kernel/test/unit-tests.json`; integration tests use
  one app per file; no fixed sleeps, no per-test timeouts.
- Design package changes (`DeviceNameplate`, `GuideDocument`, the network approval) change the
  reference set and baselines only through the `reference-update` and `visual-update` workflows;
  run them on the PR.
- Network modes on the wire stay `open | allowlist | none | null` (`DeviceNetworkBody`); approval
  scopes stay `once | session | always` (`always` on a network ask means "add to this device's
  list"; no new enum value, no migration).

## Review Focus

- A local (dial-in) device's network widened on the web by its owner must still be clamped by the
  org and platform ceilings and recorded (`device.network_changed`, recent changes, via `web`),
  and must bump the device authority epoch like a cloud device's (Task 4 test
  "local device: open network on the web → clamped by the org ceiling, audited, epoch bumped").
- An "add to this device's list" decision on an instance-boundary device must not take effect in
  the command that asked (never rerun) and must say when it applies; on a `limitsApplyAt:
  "fileSystem"` provider the card says 重建文件 (Task 8 test "always on a fileSystem provider:
  appliesAt files-reset, hosts stored, pendingFilesReset").
- A host outside the org's effective hosts must never be offered "add to this device's list"
  (a device list only narrows the org's list); it gets the org-admin note instead (Task 3 test
  "deviceListAddRefusal names the org admin for a host outside the org's hosts").
- A provider switched off for the org must disappear from 新建设备 and `POST /devices` naming it
  must refuse, while its existing devices still list as unavailable with their provider's display
  name (Task 6 test "a provider switched off: not offered, create refused, its device unavailable").
- In a browser (no shell) the `::shell-action connect-this-machine` block must render nothing,
  not a disabled button (Task 10 test "browser: the shell-action block renders nothing").

## Waves

| Wave | Tasks | Notes |
|---|---|---|
| 1 | 1 (SDK), 2 (design), 3 (device layer) | disjoint packages |
| 2 | 4 (network route, removed routes), 5 (guide place in the kernel), 7 (projects) | disjoint kernel files |
| 3 | 6 (providers list, create with provider, device report view), 8 (network ask offers) | 6 owns `devices.service.ts` / controller / ops; 8 owns approvals, pipeline, channels |
| 4 | 9 (web devices lib), 12 (web network ask card) | 12 is the only one touching `messages/*.json` in this wave |
| 5 | 10 (新建设备) | |
| 6 | 11 (device page) | |
| 7 | 13 (i18n sweep, skill docs, changesets) | |

Tasks 3, 4 and 8 are trust-boundary tasks: **[review alone, most capable model]**. Waves 5 and 6 are
separate only because both edit `apps/web/messages/*.json`.

---

### Task 1: SDK `device-connection` guide place and `::shell-action`

Skip any step whose result is already on main (phase 1 or 2 may have added the place).

**Files:**
- Modify: `packages/plugin-sdk/src/setup-guide.ts:59-99` (`SETUP_GUIDE_PLACES`, `SETUP_GUIDE_PLACE_INFO`)
- Modify: `packages/plugin-sdk/src/setup-guide-parse.ts` (directive scanner, next to `CHECK_LINE_RE` at :37)
- Modify: `packages/plugin-sdk/src/setup-guide-render.ts:32-35, 370-400` (block union, emission)
- Test: `packages/plugin-sdk/test/setup-guide.test.ts`, `packages/plugin-sdk/test/setup-guide-render.test.ts`
- Create: `.changeset/device-connection-guide.md` (`@capybara-hq/plugin-sdk`: minor)
- Modify: SDK API report via `pnpm gen:sdk-api`

**Interfaces:**
- Produces: `SETUP_GUIDE_PLACE_INFO["device-connection"] = { modes: [], audiences: ["member"],
  variables: { ...COMMON_VARIABLES, orgId: "token" }, drift: false }` (`pluginName`, `publicUrl`,
  `orgName` come from `COMMON_VARIABLES`);
  `export const SETUP_GUIDE_SHELL_ACTIONS = ["connect-this-machine"] as const;`
  `export type SetupGuideShellAction = (typeof SETUP_GUIDE_SHELL_ACTIONS)[number];`
  `SetupGuideBlock` gains `{ kind: "shell-action"; action: SetupGuideShellAction; label: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
// setup-guide.test.ts
it("device-connection: member audience, orgId/publicUrl/pluginName variables, no drift", () => {
  expect(SETUP_GUIDE_PLACE_INFO["device-connection"]).toMatchObject({
    audiences: ["member"], drift: false, modes: [],
  });
  expect(Object.keys(SETUP_GUIDE_PLACE_INFO["device-connection"].variables)).toEqual(
    expect.arrayContaining(["publicUrl", "orgId", "orgName", "pluginName"]),
  );
});
it("::shell-action connect-this-machine is accepted only in a device-connection guide", () => {
  const doc = "# Connect\n\n::shell-action connect-this-machine Connect this machine\n";
  expect(errorsOf(validate("device-connection", doc))).toEqual([]);
  expect(errorsOf(validate("channel-connection", doc))[0]).toMatch(/shell-action/);
});
it("an unknown shell action or a missing label is an error", () => {
  expect(errorsOf(validate("device-connection", "# C\n\n::shell-action open-tray Open\n"))[0])
    .toMatch(/connect-this-machine/);
  expect(errorsOf(validate("device-connection", "# C\n\n::shell-action connect-this-machine\n"))[0])
    .toMatch(/label/);
});
// setup-guide-render.test.ts
it("renders ::shell-action as its own block between prose blocks", () => {
  const r = render("# C\n\nStep one.\n\n::shell-action connect-this-machine Connect\n\nStep two.\n");
  expect(r.blocks.map((b) => b.kind)).toEqual(["markdown", "shell-action", "markdown"]);
  expect(r.blocks[1]).toEqual({ kind: "shell-action", action: "connect-this-machine", label: "Connect" });
});
```

(`validate` / `render` / `errorsOf` are the files' existing helpers around
`validateSetupGuide` / `renderSetupGuide`; reuse them.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run packages/plugin-sdk/test/setup-guide.test.ts packages/plugin-sdk/test/setup-guide-render.test.ts`
Expected: FAIL (`device-connection` not a place; `shell-action` unknown directive).

- [ ] **Step 3: Implement**

Add the place; parse `^::shell-action[ \t]+(\S+)(?:[ \t]+(.*?))?[ \t]*$` like `::check` (line
kept blank for Markdown, no variables in the line, label required, action in
`SETUP_GUIDE_SHELL_ACTIONS`, allowed only when the place is `device-connection`); emit the block
in document order in `renderSetupGuide`.

- [ ] **Step 4: Run tests, regenerate the API report**

Run: `pnpm exec vitest run packages/plugin-sdk/test/setup-guide.test.ts packages/plugin-sdk/test/setup-guide-render.test.ts && pnpm gen:sdk-api && pnpm check:sdk-api`
Expected: PASS; the report shows the new exports.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-sdk .changeset/device-connection-guide.md
git commit -m "feat(plugin-sdk): device-connection guide place and shell-action directive

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 2: Design: nameplate origin, guide action block, network "add to list"

**Files:**
- Modify: `packages/design/src/display/device-nameplate.tsx:15-95`
- Modify: `packages/design/src/display/guide-document.tsx:10-60`
- Modify: `packages/design/src/conversation/hitl.tsx:85-95` (`NetworkAsk`), `:709-830` (`NetworkApproval`)
- Modify: `packages/design/src/i18n.ts` (zh ~:404-421, en ~:1021-1040)
- Modify: `apps/web/src/dev/catalog/device-blocks.tsx` (catalog entries follow the new props)
- Modify: `docs/design/spec.md` §6.41 (nameplate origin) and the network approval paragraph of §6.16.11
- Test: `packages/design/test/device-nameplate.test.tsx`, `packages/design/test/guide-document.test.tsx`, `packages/design/test/hitl-network.test.tsx`

**Interfaces:**
- Produces: `DeviceNameplateProps.origin: string` (the provider's display name, drawn as is;
  `DeviceNameplateOrigin` and `labels.origin` deleted; `data-origin` attribute removed).
- Produces: `GuideBlock` gains `{ kind: "action"; id: string; label: string }`;
  `GuideDocumentProps.renderAction?: (block: { id: string; label: string }) => ReactNode`
  (absent or returning null: the block draws nothing).
- Produces: `NetworkAsk.appliesAt?: "next-command" | "next-use" | "files-reset"`; `NetworkApproval`
  offers `once` and `always` from `p.scopes` (in that order, the first primary); `always` is
  labelled `hitl.network.addToDevice` with the hint `hitl.network.applies.<appliesAt>`; the decided
  line for `scope: "always"` says `hitl.network.allowedDevice`. Keys added (zh / en):
  `addToDevice` 加入此设备的列表 / Add to this device's list; `allowedDevice` 已加入此设备的列表 /
  Added to this device's list; `applies.next-command` 从下一条命令起生效 / Applies from the next
  command; `applies.next-use` 下次使用这台设备时生效 / Applies the next time the device is used;
  `applies.files-reset` 重建文件后生效 / Applies after the files are rebuilt. Key removed:
  `hitl.network.onMachine`.

- [ ] **Step 1: Write the failing tests**

```tsx
it("draws the origin text it is given", () => {
  render(<DeviceNameplate name="Mac" origin="device-local" state="online" created={T} />);
  expect(screen.getByText("device-local")).toBeTruthy();
});
it("an action block draws what renderAction returns, nothing without it", () => {
  const blocks = [{ kind: "action", id: "connect-this-machine", label: "Connect" } as const];
  const { rerender } = render(<GuideDocument blocks={blocks} />);
  expect(screen.queryByText("Connect")).toBeNull();
  rerender(<GuideDocument blocks={blocks} renderAction={(b) => <button>{b.label}</button>} />);
  expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
});
it("a network ask offering once and always shows both, always with its timing hint", () => {
  render(<ApprovalBlock {...base} scopes={["once", "always"]}
    network={{ hosts: ["a.dev"], command: "curl a.dev", appliesAt: "next-use" }} />);
  expect(screen.getByRole("button", { name: zh["hitl.network.once"] })).toBeTruthy();
  expect(screen.getByRole("button", { name: zh["hitl.network.addToDevice"] })).toBeTruthy();
  expect(screen.getByText(zh["hitl.network.applies.next-use"])).toBeTruthy();
});
it("a list-only network ask offers only add-to-list, as the primary", () => {
  render(<ApprovalBlock {...base} scopes={["always"]}
    network={{ hosts: ["a.dev"], command: "curl a.dev", appliesAt: "files-reset" }} />);
  expect(screen.queryByRole("button", { name: zh["hitl.network.once"] })).toBeNull();
  expect(screen.getByRole("button", { name: zh["hitl.network.addToDevice"] })
    .getAttribute("data-variant")).toBe("primary");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run packages/design/test/device-nameplate.test.tsx packages/design/test/guide-document.test.tsx packages/design/test/hitl-network.test.tsx`
Expected: FAIL (origin typed as the enum; no action block; `always` filtered out at hitl.tsx:760).

- [ ] **Step 3: Implement** the three prop changes and keys above; update the `/dev/ui`
  catalog entries and the spec paragraphs.

- [ ] **Step 4: Run tests and checks**

Run: `pnpm exec vitest run packages/design/test && pnpm check:i18n && pnpm check:web-ui`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/design apps/web/src/dev/catalog/device-blocks.tsx docs/design/spec.md
git commit -m "feat(design): provider origin on the nameplate, guide actions, network add-to-list

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 3: One device layer for every device **[review alone, most capable model]**

**Files:**
- Modify: `packages/kernel/src/sandbox/device-sandbox.ts:58-365`
- Modify: `packages/kernel/src/sandbox/permission-facts.ts:180-280` (device layer, `owner` plumbing, `orgHostGrantCeiling`)
- Modify: `packages/kernel/src/sandbox/permission-context-types.ts:40`, `operation-authority.ts:122`, `review/permission-candidate.ts:159` only where they still read a local device layer
- Test: `packages/kernel/test/sandbox/device-sandbox.test.ts` (unit, already listed)

**Interfaces:**
- Produces:

```ts
/** The device layer: its stored network for every device (devices.network_mode / network_hosts). */
export interface DeviceSandboxDeviceLayer {
  /** Null follows the org; `none` closed. An allowlist with no own hosts follows the org's hosts. */
  networkMode: DeviceNetworkMode | "none" | null;
  networkHosts: readonly string[];
}
export function providerLayerOf(report: SandboxPermissionSupport | null): DeviceSandboxProviderLayer;
export function hostGrantCeiling(box, platform, org): HostGrantCeiling;      // `owner` removed
export function hostGrantRefusal(host, box, platform, org): string | null;   // `owner` removed
/** Why `host` cannot be added to this device's own list (null: it can). */
export function deviceListAddRefusal(
  host: string,
  box: Pick<DeviceSandbox, "networkMode" | "networkCeiling" | "layer">,
  platform: Pick<DeviceSandboxPlatformLayer, "egress" | "allowHosts" | "orgHosts">,
  org: DeviceSandboxOrgLayer,
): string | null;
```

  `DeviceSandboxLayer` loses `"device"` for `outsideSandbox` (only platform / org / provider set it;
  the provider layer's `outsideSandbox` is the device's report, e.g. the local owner ceiling).
  `providerLayerOf(null)` is fail-closed: `{ boundary: "instance", network: { openPublic: false,
  allowlist: true, perOperationHosts: false }, outsideSandbox: false }`.
  `restrictedProjectReach` leaves `DeviceSandbox` and `ConsentReach` if still present.

- [ ] **Step 1: Write the failing tests** (replace the `location: "local"` cases)

```ts
describe("effectiveDeviceSandbox: one device layer", () => {
  it("every device follows the org default when its mode is null", () => {
    const box = effectiveDeviceSandbox(PLATFORM_OPEN, { deviceNetwork: { default: "allowlist" } },
      { networkMode: null, networkHosts: [] }, OPERATION_PROVIDER);
    expect(box.networkMode).toBe("allowlist");
    expect(box.hosts).toEqual(orgHostsOf(PLATFORM_OPEN, { deviceNetwork: { default: "allowlist" } }));
  });
  it("an own host list narrows the org's hosts and never adds one", () => {
    const box = effectiveDeviceSandbox(PLATFORM_LIST(["a.dev", "b.dev"]), {},
      { networkMode: "allowlist", networkHosts: ["a.dev", "x.dev"] }, OPERATION_PROVIDER);
    expect(box.hosts).toEqual(["a.dev"]);
  });
  it("outside the sandbox follows the provider layer, never a device layer", () => {
    const allowed = effectiveDeviceSandbox(PLATFORM_OPEN, {}, OPEN_DEVICE,
      { ...OPERATION_PROVIDER, outsideSandbox: true });
    expect(allowed.outsideSandbox).toBe(true);
    const refused = effectiveDeviceSandbox(PLATFORM_OPEN, {}, OPEN_DEVICE,
      { ...OPERATION_PROVIDER, outsideSandbox: false });
    expect(refused.layer.outsideSandbox).toBe("provider");
  });
  it("providerLayerOf(null) is fail-closed", () => {
    expect(providerLayerOf(null)).toEqual({ boundary: "instance",
      network: { openPublic: false, allowlist: true, perOperationHosts: false }, outsideSandbox: false });
  });
});
describe("deviceListAddRefusal", () => {
  it("null for a host within the org's hosts", () => {
    expect(deviceListAddRefusal("a.dev", ALLOWLIST_BOX, PLATFORM_LIST(["a.dev"]), {})).toBeNull();
  });
  it("deviceListAddRefusal names the org admin for a host outside the org's hosts", () => {
    expect(deviceListAddRefusal("x.dev", ALLOWLIST_BOX, PLATFORM_LIST(["a.dev"]), {}))
      .toMatch(/organization admin adds x\.dev/);
  });
  it("an excluded host or a closed network is refused", () => {
    expect(deviceListAddRefusal("a.dev", ALLOWLIST_BOX, PLATFORM_LIST(["a.dev"]),
      { deviceNetwork: { excludedHosts: ["a.dev"] } })).not.toBeNull();
    expect(deviceListAddRefusal("a.dev", { ...ALLOWLIST_BOX, networkMode: "none" },
      PLATFORM_LIST(["a.dev"]), {})).toMatch(/turned off/);
  });
});
```

(`PLATFORM_OPEN`, `PLATFORM_LIST`, `OPERATION_PROVIDER`, `OPEN_DEVICE`, `ALLOWLIST_BOX` are small
fixtures at the top of the file; adapt the existing ones.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run packages/kernel/test/sandbox/device-sandbox.test.ts`
Expected: FAIL (type errors on the union, `deviceListAddRefusal` missing).

- [ ] **Step 3: Implement**

Collapse the union; `chosen = device.networkMode ?? org.deviceNetwork?.default ??
platform.settings.network.default`; hosts: own non-empty → `intersectHosts(orgHosts, own)`, else
the org's. `deviceListAddRefusal`: closed network or egress `none` → "network access is turned
off for this device's sandbox"; covered by `orgHostsOf` and no `excludedHosts` entry covers it →
null; else the org-admin / super-admin texts of `hostGrantRefusal`. In `permission-facts.ts` build
the device layer with `cloudOwnNetwork(row)` for every device and drop the `owner` arguments.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run packages/kernel/test/sandbox/device-sandbox.test.ts packages/kernel/test/sandbox/approval-only-profiles.dual.test.ts packages/kernel/test/sandbox/permission-profiles.dual.test.ts && pnpm typecheck`
Expected: PASS (adapt the dual tests' local-owner expectations to the device's stored network).

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/sandbox packages/kernel/test/sandbox
git commit -m "feat(kernel): one stored network layer for every device

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 4: Device network route for every device; machine and policy routes gone **[review alone, most capable model]**

**Files:**
- Modify: `packages/kernel/src/devices/devices.controller.ts:35-70` (doc), `:164-190` (delete `revokeMachine`, and `changePolicy` if present)
- Modify: `packages/kernel/src/devices/dto.ts:36-90` (doc of `DevicePatchBody`; delete `DevicePolicyBody` and its DTO if present)
- Modify: `packages/kernel/src/devices/devices.schemas.ts` (drop the `DevicePolicyBody` re-export and its doc)
- Modify: `packages/kernel/src/devices/devices.service.ts:240-262` (`DevicePolicyChange`, `DevicePatch` doc), `:565-720` (`update` / `planNetwork`: no local refusal), `:930-982` (delete `revokeMachine`, `changePolicy`), `DeviceSettingChangeView` (kind `network` only, via `web | im | token | agent`)
- Modify: `packages/kernel/src/platform/exclusions.ts:258-272` (delete both device exclusions)
- Modify: `packages/kernel/src/platform/ops/devices.ops.ts:155-180` (`devices.get` text), `:384-445` (`devices.set-network`)
- Modify: `packages/kernel/src/errors.ts:457-484` (delete `device.ceiling_on_machine`, and `device.policy_refused` / `device.policy_unsupported` / `device.owner_report_stale` if no source uses them)
- Delete: `packages/kernel/test/devices/device-policy.http.test.ts` (if still present)
- Test: `packages/kernel/test/devices/devices.http.test.ts` (:700-760), `packages/kernel/test/platform/ops-devices-skills.test.ts`

**Interfaces:**
- Consumes: Task 3 `DeviceSandboxDeviceLayer`.
- Produces: `DevicesService.addNetworkHostsIn(orgId: string, accountId: string, deviceId: string,
  hosts: string[], via: "web" | "im"): Promise<void>` — `@Transactional()` (joins the caller's
  transaction); adds `hosts` to the device's own list; refuses with `device.network_not_allowed`
  unless the stored mode is `allowlist` with a non-empty own list and every host passes
  `deviceListAddRefusal`; writes `device.network_changed` (from → to) and the recent-change row
  exactly as `PATCH` does, and the same epoch bump and next-use marking as `update`.
- Produces: `devices.set-network` description "Narrow the sandbox network of one of your
  devices: …" (no local exception), errors without `device.ceiling_on_machine`.

- [ ] **Step 1: Write the failing tests**

```ts
// devices.http.test.ts (the device is created on the fake dial-in provider from phase 2)
it("local device: open network on the web → clamped by the org ceiling, audited, epoch bumped", async () => {
  await setOrgDeviceNetwork(org, { ceiling: "allowlist" });
  const before = await authorityEpoch(local.id);
  const res = await patch(`/devices/${local.id}`, { network: { mode: "open" } });
  expect(res.statusCode).toBe(400);
  expect(errCode(res)).toBe("device.network_not_allowed");
  await setOrgDeviceNetwork(org, { ceiling: "open" });
  const ok = await patch(`/devices/${local.id}`, { network: { mode: "open" } });
  expect(ok.json().device.sandbox).toMatchObject({ network: "open", ownNetwork: "open" });
  expect(await auditOf("device.network_changed", local.id)).toHaveLength(1);
  expect(await authorityEpoch(local.id)).toBeGreaterThan(before);
});
it("DELETE /devices/:id/machine is gone", async () => {
  expect((await del(`/devices/${local.id}/machine`)).statusCode).toBe(404);
});
it("addNetworkHostsIn adds within the org's hosts and refuses outside them", async () => {
  await patch(`/devices/${cloud.id}`, { network: { mode: "allowlist", hosts: ["a.dev"] } });
  await app.get(DevicesService).addNetworkHostsIn(org, owner, cloud.id, ["b.dev"], "web");
  expect((await get(`/devices/${cloud.id}`)).json().device.sandbox.allowedDomains)
    .toEqual(["a.dev", "b.dev"]);
  await expect(app.get(DevicesService).addNetworkHostsIn(org, owner, cloud.id, ["x.dev"], "web"))
    .rejects.toMatchObject({ code: "device.network_not_allowed" });
});
// ops-devices-skills.test.ts
it("devices.set-network narrows a local device too", async () => {
  const r = await runOp("devices.set-network", { deviceId: local.id, network: { mode: "allowlist", hosts: ["a.dev"] } });
  expect(r.ok).toBe(true);
});
```

Replace the old "a local device's network is its machine's" assertions (`devices.http.test.ts`
~:704-752) with the first test above.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run packages/kernel/test/devices/devices.http.test.ts packages/kernel/test/platform/ops-devices-skills.test.ts`
Expected: FAIL (`device.ceiling_on_machine` 409; `/machine` 204; `addNetworkHostsIn` missing).

- [ ] **Step 3: Implement** the deletions and `addNetworkHostsIn` as specified.

- [ ] **Step 4: Run tests and checks**

Run: `pnpm exec vitest run packages/kernel/test/devices packages/kernel/test/platform/ops-devices-skills.test.ts && pnpm check:platform-ops && pnpm check:kernel-conventions`
Expected: PASS; no orphan exclusion.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/devices packages/kernel/src/platform packages/kernel/src/errors.ts packages/kernel/test
git commit -m "feat(kernel): every device's network is set on the web; drop machine disconnect

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 5: Kernel `device-connection` guide place

**Files:**
- Modify: `packages/kernel/src/extensions/guide-places.ts:40-46` (`PLACE_ACTIONS`), `:91-96` (`TARGET_PARAMS`), `:104-160` (`resolvePlace`)
- Modify: `packages/kernel/src/extensions/plugin-guides.ts:493-518` (new `deviceGuides` next to `channelGuides`)
- Modify: the fake dial-in provider fixture from phase 2: add a `device-connection` guide
  (manifest `guides: [{ id: "connect", place: "device-connection" }]`, `guides/connect.en.md`,
  `guides/connect.zh.md` with one `::shell-action connect-this-machine` line and
  `{{publicUrl}}` in a code block)
- Test: `packages/kernel/test/catalog/guides.http.test.ts`

**Interfaces:**
- Consumes: Task 1 place and block.
- Produces: `PLACE_ACTIONS["device-connection"] = { member: "agents.use" }`;
  `TARGET_PARAMS["device-connection"] = []`; `resolvePlace` sets `orgId` to the org's id
  (`no_org` without an org).
  `PluginGuides.deviceGuides(names: string[], org: { orgId: string; role: OrgRole }):
  Promise<Map<string, SetupGuideRef>>` — plugin name → its `device-connection` guide ref
  (`itemId`, `guideId`, `version`) for items the org's catalog shows.

- [ ] **Step 1: Write the failing tests**

```ts
it("a member reads a device-connection guide with publicUrl and orgId filled, shell-action as a block", async () => {
  const res = await asMember.get(`/api/v1/orgs/${org}/catalog/${dialInItem}/guides/connect?audience=member&locale=en`);
  expect(res.statusCode).toBe(200);
  const g = res.json().guide;
  expect(g.place).toBe("device-connection");
  expect(g.blocks).toContainEqual({ kind: "shell-action", action: "connect-this-machine", label: "Connect this machine" });
  expect(JSON.stringify(g.blocks)).toContain(PUBLIC_URL);
  expect(g.unresolved).toEqual([]);
});
it("device-connection takes no target parameter", async () => {
  const res = await asMember.get(`/api/v1/orgs/${org}/catalog/${dialInItem}/guides/connect?connectorId=x`);
  expect(res.statusCode).toBe(400);
});
it("deviceGuides maps a provider plugin to its guide ref", async () => {
  const m = await app.get(PluginGuides).deviceGuides([DIAL_IN_PLUGIN, "nope"], { orgId: org, role: "member" });
  expect(m.get(DIAL_IN_PLUGIN)).toMatchObject({ itemId: dialInItem, guideId: "connect" });
  expect(m.has("nope")).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run packages/kernel/test/catalog/guides.http.test.ts`
Expected: FAIL (`PLACE_ACTIONS` has no entry; 403/500).

- [ ] **Step 3: Implement** the entries and `deviceGuides` (same visibility query as `channelGuides`,
  `orgVisibleItems` with `roleAtLeast(role, "admin")`).

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run packages/kernel/test/catalog/guides.http.test.ts packages/kernel/test/catalog/import-guides.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/extensions packages/kernel/test packages/testing
git commit -m "feat(kernel): render device-connection guides for members

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 6: Providers on in the org, create with a provider, the device report view

**Files:**
- Modify: `packages/kernel/src/devices/devices.service.ts` (`DeviceView` :65-130, `DeviceList` :274-282, `list` :333-357, `create` :371-410, `views` :1285-1460, `refuseDeviceReset` :1596)
- Modify: `packages/kernel/src/devices/devices.controller.ts:85-101`, `packages/kernel/src/devices/dto.ts` (`DeviceCreateBody`), `packages/kernel/src/devices/devices.schemas.ts` (POST body)
- Modify: `packages/kernel/src/platform/ops/devices.ops.ts` (`devices.list` :130-153, `devices.create` :184-228, `devices.get` text)
- Modify: `packages/kernel/src/errors.ts` (add `device.provider_dial_in`: 409)
- Test: `packages/kernel/test/devices/devices.http.test.ts`, `packages/kernel/test/platform/ops-devices-skills.test.ts`

**Interfaces:**
- Consumes: `DeviceProviders.onInOrg(orgId)`, `forDevice(provider)`; `DeviceProvider.report`;
  `ExtensionDisplayNames.many`; Task 5 `PluginGuides.deviceGuides`.
- Produces (the shapes the web consumes in Tasks 9–11):

```ts
export interface DeviceProviderOption {
  plugin: string;
  displayName: LocalizedName | null;
  /** The catalog item's description; null when none. */
  description: string | null;
  /** The provider declares `permissions.dialIn`: devices are created by the machine signing in. */
  dialIn: boolean;
  guide: SetupGuideRef | null;           // { itemId, guideId, version }
}
export interface DeviceList {
  items: DeviceView[]; defaultId: string | null; lastUsedId: string | null;
  providers: DeviceProviderOption[];     // on in this org, by display name
}
export interface DeviceView {
  id: string; name: string | null; isDefault: boolean; ownerKind: "personal";
  provider: string;
  providerDisplayName: LocalizedName | null;
  dialIn: boolean;
  /** The provider is loaded and on in the org. */
  available: boolean;
  /** Dial-in devices: a replica holds its machine now; null otherwise. */
  online: boolean | null;
  /** Dial-in devices: the active machine's generic facts; null otherwise or when none. */
  machine: { id: string; os: string; programVersion: string | null; lastSeenAt: string | null } | null;
  /** `GET /:id` only (null in the list), null when unavailable or not answered within 5 s. */
  report: Omit<DeviceReport, "revision"> | null;
  sandbox: DeviceSandboxView; reconcileRequired: boolean; sessionIsolation: boolean;
  filesLost: boolean; instance: { status: "running" | "suspended"; lastUsedAt: string } | null;
  limits: SandboxLimits; createdAt: string;
}
```

  `POST /devices { name, provider }` (`DeviceCreateBody = z.object({ name: DeviceName, provider:
  z.string().min(1).max(100) }).strict()`); a provider not on in the org → 503
  `device.unavailable`; a dial-in provider → 409 `device.provider_dial_in` ("Devices of this
  provider are connected from the machine: follow its guide in 新建设备" in English text).
  `refuseDeviceReset` → refuses when `report?.reset !== true` with `device.files_on_device` (message
  from the provider's description, no `capybara-device` commands).

- [ ] **Step 1: Write the failing tests**

```ts
it("lists the providers on in the org with display name, description, dial-in and guide", async () => {
  const l = (await get("/devices")).json();
  expect(l.providers.map((p) => p.plugin).sort()).toEqual([FAKE_A, DIAL_IN_PLUGIN].sort());
  expect(l.providers.find((p) => p.plugin === DIAL_IN_PLUGIN))
    .toMatchObject({ dialIn: true, guide: { guideId: "connect" } });
  expect(l).not.toHaveProperty("cloudAvailable");
});
it("create takes a provider; a dial-in provider is refused", async () => {
  const ok = await post("/devices", { name: "A", provider: FAKE_A });
  expect(ok.json().device).toMatchObject({ provider: FAKE_A, dialIn: false, online: null });
  expect(errCode(await post("/devices", { name: "B", provider: DIAL_IN_PLUGIN }))).toBe("device.provider_dial_in");
  expect((await post("/devices", { name: "C" })).statusCode).toBe(400);
});
it("a provider switched off: not offered, create refused, its device unavailable", async () => {
  const d = (await post("/devices", { name: "A", provider: FAKE_A })).json().device;
  await switchPluginOff(org, FAKE_A);
  const l = (await get("/devices")).json();
  expect(l.providers.map((p) => p.plugin)).not.toContain(FAKE_A);
  expect(l.items.find((e) => e.id === d.id)).toMatchObject({ available: false, providerDisplayName: expect.anything() });
  expect(errCode(await post("/devices", { name: "B", provider: FAKE_A }))).toBe("device.unavailable");
});
it("GET /:id carries the provider's report without its revision", async () => {
  const d = (await get(`/devices/${cloud.id}`)).json().device;
  expect(d.report).toEqual({ description: { en: expect.any(String) }, home: null, limits: [], reset: true });
});
```

Ops test: `devices.create` with `{ name, provider }` succeeds and `devices.list` returns `providers`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run packages/kernel/test/devices/devices.http.test.ts packages/kernel/test/platform/ops-devices-skills.test.ts`
Expected: FAIL (`providers` missing; create ignores `provider`).

- [ ] **Step 3: Implement**

`list`: `onInOrg` → display names (one `many` call), catalog descriptions (one query on
`catalog_items` by name), `deviceGuides`; `dialIn` from the provider manifest's
`permissions.dialIn`. `get`: call `forDevice(row.provider)?.impl.report({ deviceId, orgId,
handle }, AbortSignal.timeout(5000))` outside any transaction; any throw → `report: null` (logged
at warn with the device id). `devices.create` Platform op: input `{ name, provider }`, description
names `devices.list`'s `providers` and that a dial-in provider's device is made on the machine;
errors add `device.provider_dial_in`.

- [ ] **Step 4: Run tests and checks**

Run: `pnpm exec vitest run packages/kernel/test/devices packages/kernel/test/platform/ops-devices-skills.test.ts && pnpm check:platform-ops`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/devices packages/kernel/src/platform packages/kernel/src/errors.ts packages/kernel/test
git commit -m "feat(kernel): offer the org's device providers and create devices on one

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 7: Projects: no hidden count, provider refusals

**Files:**
- Modify: `packages/kernel/src/devices/device-projects.service.ts:111-215` (`DeviceProjectList`, `list`), `:240-330` (`add`, candidates), and the `list` call that asks the provider
- Modify: `packages/kernel/src/devices/project-rules.ts` (delete `withinMode` if no caller remains)
- Modify: `packages/kernel/src/errors.ts` (`device.project_refused`: 422, if phase 1/2 did not add it)
- Modify: `packages/kernel/src/platform/ops/devices.ops.ts` (`devices.add-project` errors: `device.project_refused`, `next` "the device refused the path: the reason says why; pick another directory")
- Test: `packages/kernel/test/devices/projects.http.test.ts`

**Interfaces:**
- Consumes: `ProjectPathRefusedError(reason: { en: string; zh?: string })` (SDK); report `home`.
- Produces: `DeviceProjectList = { projects: DeviceProjectView[]; base: string | null; supported:
  boolean }` (`hidden` and `mode` gone; `base` = the report's `home` ?? the workspace);
  `DeviceProjectCandidates` loses `mode`. A `ProjectPathRefusedError` from the provider's `list`
  → 422 `device.project_refused`, message = `reason.en`, `details: [{ path: "path", message: reason.en }]`
  plus `reason` (the localized pair) in the error body's `data`.

- [ ] **Step 1: Write the failing tests**

```ts
it("lists every stored project; no hidden count, no mode", async () => {
  const r = (await get(`/devices/${d.id}/projects`)).json();
  expect(r).not.toHaveProperty("hidden");
  expect(r).not.toHaveProperty("mode");
  expect(r.projects.map((p) => p.name)).toEqual(["a", "b"]);
});
it("a provider refusal is 422 device.project_refused with its reason", async () => {
  fakeProvider.refuseList("/other", { en: "Another connection uses this directory", zh: "另一个连接在用这个目录" });
  const res = await post(`/devices/${d.id}/projects`, { path: "other" });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ code: "device.project_refused", data: { reason: { zh: "另一个连接在用这个目录" } } });
});
```

(`refuseList` is a scripted control on the phase 1 fake provider fixture; add it if missing.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run packages/kernel/test/devices/projects.http.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** as specified; the Platform `devices.list-projects` output follows.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run packages/kernel/test/devices/projects.http.test.ts packages/kernel/test/platform/ops-devices-skills.test.ts && pnpm check:platform-ops`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/devices packages/kernel/src/errors.ts packages/kernel/src/platform packages/kernel/test
git commit -m "feat(kernel): device projects without hidden entries; provider refusals

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 8: Network asks offer what the provider enforces **[review alone, most capable model]**

**Files:**
- Modify: `packages/kernel/src/tools/network-asks.ts:237-300` (`planNetworkAsk`: drop the machine-features `canAsk`, compute the offer)
- Modify: `packages/kernel/src/tools/pipeline.ts:2500-2625` (`networkBlocked`: pass the offer, `scopes` from it)
- Modify: `packages/kernel/src/tools/approvals.service.ts:114-131` (`NetworkAskDetail`), `:427-455` (`NetworkAskInput`, `NetworkDecision`), `:716-730` (`requestNetwork` check), `:1195-1290` (`decideNetwork`)
- Modify: `packages/kernel/src/channels/cards.ts:410-470`, `packages/kernel/src/channels/phrases.ts:83-105` (always label, applies line)
- Modify: `packages/kernel/src/sandbox/permission-facts.ts` only to expose the device's recorded permission support and `limitsApplyAt` to the pipeline if no accessor exists (`network.sandbox.hostRefusal` result gains `support` and `limitsApplyAt`)
- Test: `packages/kernel/test/tools/network-asks.unit.test.ts` (unit, listed), `packages/kernel/test/tools/network-approvals.test.ts`, `packages/kernel/test/channels/cards.test.ts`

**Interfaces:**
- Consumes: Task 3 `deviceListAddRefusal`, `hostGrantRefusal`; Task 4 `addNetworkHostsIn`; the
  device's recorded `SandboxPermissionSupport` and its provider's `limitsApplyAt`.
- Produces:

```ts
export type NetworkAppliesAt = "next-command" | "next-use" | "files-reset";
export interface NetworkAskOffer { scopes: ("once" | "always")[]; appliesAt: NetworkAppliesAt }
/** perOperationHosts → once (+ always when every asked host is list-addable), next-command;
 *  else always only, next-use (or files-reset when limitsApplyAt is "fileSystem"). */
export function networkAskOffer(
  support: { perOperationHosts: boolean }, limitsApplyAt: "instance" | "fileSystem" | undefined,
  listAddable: boolean,
): NetworkAskOffer | null;   // null: nothing to offer (list-only and not addable)
// NetworkAskDetail gains appliesAt: NetworkAppliesAt; outcome?: "once" | "always"
// NetworkAskInput.scopes: ("once" | "always")[]
```

  `planNetworkAsk`'s context gains `offer(hosts: string[]): NetworkAskOffer | null`; device-layer
  hosts are asked whenever the exec result carried a `network` report (no machine feature check);
  on a list-only device a host with a `deviceListAddRefusal` becomes an unavailable note.
  `decideNetwork`: `scope` must be in `ask.scopes`; `always` calls
  `devices.addNetworkHostsIn(orgId, accountId, deviceId, granted, via)` inside `decideIn`'s
  transaction (the network-ask `@WithLock` stays outside it), writes no run grant, and the settle
  note says the hosts were added and when they apply; `once` is unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
// network-asks.unit.test.ts
it("per-operation hosts: once and always, applies from the next command", () => {
  expect(networkAskOffer({ perOperationHosts: true }, undefined, true))
    .toEqual({ scopes: ["once", "always"], appliesAt: "next-command" });
  expect(networkAskOffer({ perOperationHosts: true }, undefined, false))
    .toEqual({ scopes: ["once"], appliesAt: "next-command" });
});
it("instance boundary: always only, next use or files reset; nothing when not addable", () => {
  expect(networkAskOffer({ perOperationHosts: false }, "instance", true))
    .toEqual({ scopes: ["always"], appliesAt: "next-use" });
  expect(networkAskOffer({ perOperationHosts: false }, "fileSystem", true))
    .toEqual({ scopes: ["always"], appliesAt: "files-reset" });
  expect(networkAskOffer({ perOperationHosts: false }, "instance", false)).toBeNull();
});
it("a device-layer block is asked without any machine feature", () => {
  const plan = planNetworkAsk([{ host: "a.dev", port: 443, layer: "device" }], RUN, { offer: () => OFFER });
  expect(plan.ask).toEqual([{ host: "a.dev", port: 443 }]);
});
// network-approvals.test.ts (device on a fake provider with perOperationHosts false, limitsApplyAt "fileSystem")
it("always on a fileSystem provider: appliesAt files-reset, hosts stored, pendingFilesReset", async () => {
  const ask = await blockedAsk(device, ["b.dev"]);
  expect(ask.scopes).toEqual(["always"]);
  expect(ask.detail.appliesAt).toBe("files-reset");
  await decide(ask.id, { decision: "approve", scope: "always" });
  const d = (await get(`/devices/${device.id}`)).json().device;
  expect(d.sandbox.allowedDomains).toContain("b.dev");
  expect(d.sandbox.pendingFilesReset).toBe(true);
  expect(await runGrantsOf(ask.runId)).toEqual([]);           // no run grant
  expect(await keptResultOf(ask)).toMatch(/added to this device's network list.*after the files are rebuilt/i);
});
it("once on a list-only device → 409 approval.scope_not_allowed", async () => {
  const ask = await blockedAsk(device, ["b.dev"]);
  expect(errCode(await decide(ask.id, { decision: "approve", scope: "once" }))).toBe("approval.scope_not_allowed");
});
it("always on a per-operation device adds the host and the run grant is not written", async () => {
  const ask = await blockedAsk(dialInDevice, ["b.dev"]);
  expect(ask.scopes).toEqual(["once", "always"]);
  await decide(ask.id, { decision: "approve", scope: "always" });
  expect((await get(`/devices/${dialInDevice.id}`)).json().device.sandbox.allowedDomains).toContain("b.dev");
});
// cards.test.ts
it("a network card labels always as add to this device's list, with the applies line", async () => {
  const card = await approvalCard(deps, listOnlyAsk.id, BASE, "zh");
  expect(card?.scopes).toEqual(["always"]);
  expect(card?.scopeLabels?.always).toBe("加入此设备的列表");
});
```

Delete the old test "an ask offers once only; always → 409" (network-approvals.test.ts ~:346).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run packages/kernel/test/tools/network-asks.unit.test.ts packages/kernel/test/tools/network-approvals.test.ts packages/kernel/test/channels/cards.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** as specified. Phrases: `networkAddToDevice` 加入此设备的列表 / Add to this
  device's list; `networkApplies.<appliesAt>` as in Task 2's design keys. The model-facing settle
  note (English) for `always`: "The person added {hosts} to this device's network list; it applies
  {from the next command | the next time the device is used | after the files are rebuilt}. This
  command is not run again."

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run packages/kernel/test/tools/network-asks.unit.test.ts packages/kernel/test/tools/network-approvals.test.ts packages/kernel/test/tools/network-ask.test.ts packages/kernel/test/tools/network-ask.dual.test.ts packages/kernel/test/channels`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/tools packages/kernel/src/channels packages/kernel/src/sandbox packages/kernel/test
git commit -m "feat(kernel): network asks offer this run only with per-operation hosts

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 9: Web devices model

**Files:**
- Modify: `apps/web/src/lib/devices.ts` (types :11-200, `deviceState` :209, `deviceName` :245, `deviceChoiceShown` :270, API :297-450, projects :451-533)
- Modify: `apps/web/src/lib/query/devices.ts` (doc of the list shape)
- Modify: `apps/web/src/components/use-device-name.ts`, `apps/web/src/components/conversation/useSelection.ts:282, 335`
- Test: `apps/web/test/devices-lib.test.ts` (create; joins no list: web tests are not listed)

**Interfaces:**
- Consumes: Task 6 shapes, Task 7 `DeviceProjectList`.
- Produces: `Device`, `DeviceList`, `DeviceProviderOption`, `DeviceReport` mirrored from Task 6
  (apps/web does not import the kernel); `createDevice(orgId: string, body: { name: string;
  provider: string })`; `setDeviceNetwork(orgId, id, network)` (renamed from
  `setCloudDeviceNetwork`); `deviceState(e)` = unavailable → filesLost → (`online !== null` ?
  online/offline : instance status / notStarted); `providerLabel(e: Pick<Device, "provider" |
  "providerDisplayName">, locale): string` (via `extensionLabel`); `deviceChoiceShown(list)` =
  `list.providers.length > 0 || list.items.length > 0`. Deleted: `revokeDeviceMachine`,
  `updateDevicePolicy`, `DevicePolicyPatch`, `DeviceOwnerCeiling*`, `deviceCeilingOf`,
  `DeviceMachine.name/mode`, `demotedFrom`, `source`, `cloudAvailable`, `projectBasePrefix`'s
  source argument, `DeviceProjectList.hidden/mode`. `deviceCeilingMark(e)` reads only
  `e.sandbox.outsideSandbox`.

- [ ] **Step 1: Write the failing tests**

```ts
it("deviceState: a dial-in device is online/offline, others follow the instance", () => {
  expect(deviceState(dev({ online: true }))).toBe("online");
  expect(deviceState(dev({ online: null, instance: null }))).toBe("notStarted");
  expect(deviceState(dev({ available: false, online: true }))).toBe("unavailable");
});
it("providerLabel uses the display name in the UI language, the plugin name without one", () => {
  expect(providerLabel({ provider: "device-e2b", providerDisplayName: { zh: "E2B 云端", en: "E2B cloud" } }, "zh")).toBe("E2B 云端");
  expect(providerLabel({ provider: "device-x", providerDisplayName: null }, "en")).toBe("device-x");
});
it("deviceChoiceShown: providers or devices", () => {
  expect(deviceChoiceShown(list({ providers: [], items: [] }))).toBe(false);
  expect(deviceChoiceShown(list({ providers: [OPTION], items: [] }))).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/web/test/devices-lib.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**; fix the compile errors in the files this task lists. The device
  dialog, list view and page (Tasks 10 and 11) stay broken against the new types until their
  task; no adapter is written for them.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run apps/web/test/devices-lib.test.ts apps/web/test/device-candidates-query.test.ts`
Expected: PASS. (`pnpm typecheck` goes green at the end of Task 11.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib apps/web/src/components/use-device-name.ts apps/web/src/components/conversation/useSelection.ts apps/web/test/devices-lib.test.ts
git commit -m "feat(web): device model follows its provider

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 10: 新建设备 with provider cards and guides; the devices list

**Files:**
- Modify: `apps/web/src/components/DeviceCreateDialog.tsx` (rewrite; delete `LocalSteps`, `CommandStep`)
- Modify: `apps/web/src/components/SetupGuideSection.tsx:49-104` (props), `:176-178` (full blocks for `device-connection`), `:237-256` (`renderAction`)
- Modify: `apps/web/src/lib/setup-guides.ts:13, 37-40` (place and block types)
- Modify: `apps/web/src/app/(app)/devices/view.tsx` (cards and empty state)
- Modify: `apps/web/src/lib/device-sign-in.ts` (delete `DEVICE_INSTALL_COMMAND`, `DEVICE_START_COMMAND`, `deviceLoginCommand` if no other caller)
- Modify: `apps/web/messages/en.json`, `apps/web/messages/zh.json` (`devices.create`, `devices.noCloud`, `devices.source`)
- Test: `apps/web/test/devices.test.tsx` (:108-300 list and create, :528-800 local), `apps/web/test/setup-guide-section.test.tsx`

**Interfaces:**
- Consumes: Task 9 model, Task 2 `renderAction`, Task 5 guide rendering, `useThisMachine()`
  (`{ cap, status }`, unchanged).
- Produces: `DeviceCreateDialog({ orgId, providers, onClose }: { orgId: string; providers:
  DeviceProviderOption[]; onClose(): void })`; `SetupGuideSectionProps.renderShellAction?:
  (action: "connect-this-machine", label: string) => ReactNode`.

Behaviour: `RadioGroup variant="card"` of the providers (label = display name, description =
catalog description), the first selected; under it the chosen provider's guide
(`<SetupGuideSection orgId guide={p.guide} query={{ audience: "member" }} renderShellAction={…} />`,
nothing when `guide` is null). Non-dial-in: 名称 field and 新建 (primary disabled until valid);
`createDevice(orgId, { name, provider })`; invalidate the list and the device; open it.
Dial-in: no name field, footer 关闭 only; the list is read every 3 s (`WAIT_POLL_MS`) and the first
item of that provider not seen when the guide opened, or whose `machine.id` changed, opens.
`renderShellAction` returns the primary 连接本机 button calling `cap.connect({ orgId })` inside a
`useAppMutation` only when `cap !== undefined`, else null. The status texts
`thisMachineOtherOrg` / `connectedElsewhere` / `thisMachineConnected` go. Devices list cards:
description = `providerLabel(e, locale)`; empty without providers: `t("noProviders.text")` /
`t("noProviders.hint")` (zh: 这个组织还没有可用的设备类型 / 请组织管理员在 扩展 中启用一个设备插件; en:
This organization has no device type yet / Ask an org admin to switch on a device plugin under
Extensions); the 新建设备 action is shown only when `providers.length > 0` (never a disabled
button).

- [ ] **Step 1: Write the failing tests**

```tsx
it("新建设备 with two providers: cards, the chosen guide, a name for a non-dial-in one", async () => {
  stubApi({ [`GET ${BASE}`]: () => json(200, list({ providers: [DOCKER, LOCAL] })), ...guide(DOCKER), ...guide(LOCAL) });
  await openCreate();
  expect(screen.getByRole("radio", { name: /Docker/ })).toBeChecked();
  expect(await screen.findByText(DOCKER_GUIDE_TEXT)).toBeTruthy();
  await userEvent.type(screen.getByLabelText(E.create.name), "Box");
  await userEvent.click(screen.getByRole("button", { name: E.create.submit }));
  expect(bodyOf(lastCall(`POST ${BASE}`))).toEqual({ name: "Box", provider: DOCKER.plugin });
});
it("a dial-in provider: no name field; waits for its new device and opens it", async () => {
  await openCreate(); await userEvent.click(screen.getByRole("radio", { name: /本机|Local/ }));
  expect(screen.queryByLabelText(E.create.name)).toBeNull();
  nextList(list({ items: [dev({ id: "n1", provider: LOCAL.plugin, online: true })] }));
  await advancePoll();
  expect(navigatedTo()).toBe("/devices/n1");
});
it("in the shell the shell-action block is a primary 连接本机 that calls connect({ orgId })", async () => {
  installShell({ connect: vi.fn().mockResolvedValue("connected") });
  await openCreate(); await pick(LOCAL);
  await userEvent.click(await screen.findByRole("button", { name: "Connect this machine" }));
  expect(shell.connect).toHaveBeenCalledWith({ orgId: "o1" });
});
it("browser: the shell-action block renders nothing", async () => {
  await openCreate(); await pick(LOCAL);
  await screen.findByText(LOCAL_GUIDE_TEXT);
  expect(screen.queryByRole("button", { name: "Connect this machine" })).toBeNull();
});
it("the list shows each device's provider display name", async () => {
  renderList(list({ items: [dev({ provider: "device-e2b", providerDisplayName: { zh: "E2B 云端", en: "E2B" } })] }));
  expect(await screen.findByText("E2B 云端")).toBeTruthy();
});
// setup-guide-section.test.tsx
it("a device-connection guide shows every block before save and passes shell actions to renderShellAction", async () => {
  /* blocks: markdown, ---, shell-action; expects both markdown parts and the rendered action */
});
```

Delete the old tests for 云端/本地 choice, `connected_elsewhere`, "another org" and the three
terminal command fields (`devices.test.tsx` :546-800).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/web/test/devices.test.tsx apps/web/test/setup-guide-section.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** as described; add/remove the `devices.create` / `devices.noProviders`
  keys in both message files; delete `devices.source` and `devices.noCloud`.

- [ ] **Step 4: Run tests and checks**

Run: `pnpm exec vitest run apps/web/test/devices.test.tsx apps/web/test/setup-guide-section.test.tsx && pnpm check:web-ui && pnpm check:i18n`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/messages apps/web/test
git commit -m "feat(web): 新建设备 offers the org's providers with their connection guides

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 11: One device page: 概览 / 网络 / 项目

**Files:**
- Modify: `apps/web/src/app/(app)/devices/[id]/view.tsx` (tabs, header actions, nameplate; delete `RevokeDialog`, the `revoke` mutation, `demotedFrom` callout, the local/cloud branches)
- Delete: `apps/web/src/components/DeviceModeSection.tsx`
- Create: `apps/web/src/components/DeviceOverviewSection.tsx`, `apps/web/src/components/DeviceNetworkSection.tsx`
- Modify: `apps/web/src/components/ThisMachineSection.tsx:180-230` (delete `useShellWidening`; the 本机 block stays)
- Modify: `apps/web/src/components/DeviceProjectsSection.tsx:68-90` (delete `HiddenNote`; `UnsupportedNote` without source; show `device.project_refused` reasons in the add dialog in the UI language)
- Modify: `apps/web/messages/en.json`, `apps/web/messages/zh.json` (`devices.detail`, `devices.network`, `devices.sandbox`, `devices.machine`, `devices.overview`, `devices.projects.hidden`, `devices.thisMachine.widened`)
- Delete: `apps/web/test/devices-mode.test.tsx`; Modify: `apps/web/test/devices-this-machine.test.tsx` (drop the `SANDBOX_COMMANDS` assertions), `apps/web/test/device-projects.test.tsx`, `apps/web/test/device-network-save.test.ts`
- Create: `apps/web/test/device-page.test.tsx`

**Interfaces:**
- Consumes: Task 9 model (`report`, `providerLabel`, `setDeviceNetwork`, `resetDeviceFiles`).
- Produces: `DeviceOverviewSection({ orgId, device }: { orgId: string; device: Device })` — the
  report's description line (`Text variant="prose"`, UI language, `en` fallback), its `limits`
  as `KeyValue` rows (read only; none: no block), files and suspension note, `RecentChanges`
  (kind `network` only), and `ThisMachineSection` on top; `DeviceNetworkSection({ orgId, device
  }: { orgId: string; device: Device })` — one `FormSection`: `RadioGroup` 跟随组织 / 开放互联网 /
  仅白名单 / 关闭 with options above `sandbox.networkCeiling` disabled naming their layer
  (平台 / 组织), the own host list (add with `allowHostProblem` validation, remove), saved through
  `setDeviceNetwork`, the pending notes (`pendingNextUse`, `pendingFilesReset`); identical for every
  provider.

Page: `DetailPage` tabs 概览 / 网络 / 项目 (`detail.tabOverview`, `detail.tabNetwork`,
`detail.tabProjects`); header actions 重命名, 重建文件 only when `report?.reset === true` and
(`filesLost` or `pendingFilesReset` or `reconcileRequired`) and `available`; the 概览 tab ends
with the `DangerZone` 删除设备 (one hint for every provider: `detail.deleteHint`, the default's
own hint kept). Nameplate: `origin={providerLabel(e, locale)}`, version and last seen from
`machine` when present, else `instance.lastUsedAt`. A provider unavailable: one `Callout` 这台设备
的设备类型（{provider}）在这个组织里没有启用，文件保留着 / This device's provider ({provider}) is not
on in this organization; its files are kept. Report null on an available device: the description
line says 设备没有回应 / The device's provider did not answer.

- [ ] **Step 1: Write the failing tests**

```tsx
it("the page has 概览 / 网络 / 项目 and no per-provider section", async () => {
  await renderDevice(dev({ provider: "device-local", online: true, report: REPORT }));
  expect(tabs()).toEqual([E.detail.tabOverview, E.detail.tabNetwork, E.detail.tabProjects]);
  expect(screen.queryByText(/capybara-device/)).toBeNull();
  expect(screen.queryByRole("button", { name: /断开|Disconnect this machine/ })).toBeNull();
  expect(findNestedBoxes(document.body)).toEqual([]);
});
it("概览 shows the provider's description and its limits read only", async () => {
  await renderDevice(dev({ report: { ...REPORT, limits: [{ label: { en: "Network", zh: "网络" }, value: "github.com" }] } }));
  expect(screen.getByText(REPORT.description.en)).toBeTruthy();
  expect(factRow("Network")?.textContent).toContain("github.com");
});
it("网络 is the same for a local device: open within the ceiling, saved with PATCH", async () => {
  await renderDevice(dev({ provider: "device-local", sandbox: sandbox({ networkCeiling: "open" }) }));
  await openTab(E.detail.tabNetwork);
  await userEvent.click(screen.getByRole("radio", { name: E.network.open }));
  await userEvent.click(screen.getByRole("button", { name: E.network.save }));
  expect(bodyOf(lastCall(`PATCH ${BASE}/e1`))).toEqual({ network: { mode: "open" } });
});
it("重建文件 only when the report allows it", async () => {
  await renderDevice(dev({ filesLost: true, report: { ...REPORT, reset: false } }));
  expect(screen.queryByRole("button", { name: E.detail.resetFiles })).toBeNull();
});
it("项目 shows no hidden count and a provider refusal in the UI language", async () => { /* … */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/web/test/device-page.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** as described; move `RecentChanges` into `DeviceOverviewSection.tsx`;
  update the message files (remove the keys of every deleted component).

- [ ] **Step 4: Run tests and checks**

Run: `pnpm exec vitest run apps/web/test/device-page.test.tsx apps/web/test/devices-this-machine.test.tsx apps/web/test/device-projects.test.tsx apps/web/test/device-network-save.test.ts apps/web/test/devices.test.tsx && pnpm typecheck && pnpm check:web-ui && pnpm check:i18n`
Expected: PASS; `pnpm typecheck` green for the whole repo.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/messages apps/web/test
git commit -m "feat(web): one device page for every provider (overview, network, projects)

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 12: Web network ask card: add to this device's list

**Files:**
- Modify: `apps/web/src/components/ApprovalCard.tsx:385-395` (scopes), `:628-650` (`networkAskOf` passes `appliesAt`)
- Modify: `apps/web/src/lib/` approval types for `NetworkAskView` (`appliesAt`, `outcome: "once" | "always"`) where they live (grep `grantedHosts` in `apps/web/src/lib`)
- Modify: `apps/web/messages/en.json`, `apps/web/messages/zh.json` (`networkAsk.*` keys that name the machine command, if any)
- Test: `apps/web/test/approval-card.test.tsx`

**Interfaces:**
- Consumes: Task 2 `NetworkAsk.appliesAt`, Task 8 detail and scopes.
- Produces: the card passes `scopes` exactly as the view lists them (no `always` filter for
  network asks) and `network.appliesAt`; deciding `always` posts `{ decision: "approve", scope:
  "always", hosts }`.

- [ ] **Step 1: Write the failing test**

```tsx
it("a list-only network ask offers add to this device's list and posts scope always", async () => {
  renderCard(networkView({ scopes: ["always"], detail: { appliesAt: "next-use" } }));
  await userEvent.click(screen.getByRole("button", { name: zhDesign["hitl.network.addToDevice"] }));
  expect(bodyOf(lastCall("POST /api/v1/orgs/o1/approvals/a1/decision"))).toMatchObject({ scope: "always" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run apps/web/test/approval-card.test.tsx`
Expected: FAIL (`always` filtered at ApprovalCard.tsx:394).

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run apps/web/test/approval-card.test.tsx && pnpm check:i18n`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/messages apps/web/test/approval-card.test.tsx
git commit -m "feat(web): network asks can add hosts to the device's list

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 13: i18n sweep, skill docs, changesets

**Files:**
- Modify: `apps/web/messages/en.json`, `apps/web/messages/zh.json` (`errors.device.ceiling_on_machine`, `policy_refused`, `policy_unsupported`, `owner_report_stale`, `project_outside_mode`; add `errors.device.provider_dial_in`, `errors.device.project_refused`; any key under `devices.*` no source references)
- Modify: `.agents/skills/writing-web-ui/SKILL.md` (the 设备 row of the template table and the "Device sandbox places" paragraph: one page 概览 / 网络 / 项目, provider origin, no machine section, `PATCH { network }` for every device, `device.ceiling_on_machine` gone)
- Modify: the device-provider skill (`.agents/skills/writing-device-providers/SKILL.md`, or `writing-sandbox-providers` if not renamed yet): network asks (`networkAskOffer`, `always` = add to list, `appliesAt`), one device layer
- Modify: `.agents/skills/writing-plugins/SKILL.md` (setup guide places: `device-connection`, `::shell-action`)
- Create: `.changeset/device-provider-p3.md` (`@capybara-hq/capybara`: patch — kernel and web images)
- Test: `apps/web/test/messages-parity.test.ts` (existing)

- [ ] **Step 1: Find unused keys**

For every leaf key under `devices`, `networkAsk` and `errors.device` in `apps/web/messages/en.json`,
grep `apps/web/src` for its last segment (and for the dynamic prefixes such as `` `state.${` ``);
list the ones with no use. Errors keys follow `packages/kernel/src/errors.ts`: a code removed
there loses its key.
Expected: a list of keys to delete, each confirmed by grep.

- [ ] **Step 2: Delete them in both files, add the error copy, update the skills.**

zh `errors.device.provider_dial_in`: 这种设备由那台电脑登录时创建：请按 新建设备 里的指南操作。 en: Devices
of this type are created when the computer signs in: follow the guide in New device.
zh `errors.device.project_refused`: 设备拒绝了这个目录。 en: The device refused this directory.

- [ ] **Step 3: Run the checks**

Run: `pnpm check && pnpm exec vitest run apps/web/test/messages-parity.test.ts && pnpm verify --fast`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/messages .agents/skills .changeset/device-provider-p3.md
git commit -m "docs: device page, network asks and connection guides in the skills

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

## Index issues

1. **Phase ownership not stated in the index.** The `device-connection` place and `::shell-action`
   (index "Setup guide"), `ProjectPathRefusedError` / `project.refused`, removing
   `restrictedProjectReach`, and removing `POST /devices/:id/policy` are not assigned to a phase.
   This plan takes each one conditionally (Tasks 1, 3, 4, 7) so it works whichever way phases 1
   and 2 land; the index should name the owner to avoid two phases editing the same code.
2. **Plugin guides are outside phase 3's repos.** Spec §6.4 needs `device-docker` / `device-e2b`
   short guides and `device-local`'s guide (today's `LocalSteps`) in capybara-hq/plugins, after
   the SDK release carrying Task 1. The index lists phase 3 as core only; a plugins follow-up PR
   (guides + SDK pin with the pnpm override) is needed after the release, or phases 1/2 add the
   guides if they already ship the place.
3. **`project.refused` naming.** Existing device project codes are `device.project_*`; the index
   fixes `project.refused`, which this plan uses as is. `device.project_refused` would match the
   registry's naming better.
4. **"Add to this device's list" uses scope `always`.** The index fixes no name for it; reusing the
   existing approval scope avoids a new enum and migration. The decided line and cards label it
   "add to this device's list", never "always".
