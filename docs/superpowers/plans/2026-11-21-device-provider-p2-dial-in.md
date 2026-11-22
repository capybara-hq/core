# Device Providers Phase 2: Dial-in Channel, Report-driven Authority, `device-local`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task, layered with
> `wave-planned-subagent-development`. Steps use checkbox (`- [ ]`) syntax for tracking. Read the
> index [2026-11-21-device-provider.md](2026-11-21-device-provider.md) first: its Shared interfaces
> are fixed and this plan does not repeat them.

**Goal:** The kernel keeps a generic dial-in channel (sign-in, credentials, lease, relay) offered to
providers that declare `permissions.dialIn`, every `local` / `cloud` branch becomes one path driven
by the provider's report and its revision, and the local device semantics leave the kernel for the
new `device-local` plugin (capybara-hq/plugins).

**Architecture:** `packages/kernel/src/local-devices` splits: the generic files become
`src/dial-in` (`DialInModule`), which speaks a small kernel-owned envelope (`hello` / `req` /
`res` / `event` / `cancel` / `stop` / `ready`) and hands the opaque bodies to the device's provider
(`DialInHandler`); the provider calls `ctx.dialIn.request` and `ctx.devices.reportChanged`. The
kernel stores each device's last report revision; a changed revision bumps the device authority
epoch through the existing `PermissionCeilingWrites.publishLocked`. Everything that read
`device_machines.owner_report` / `features` / `roots` / `home` / `mode`, `devices.source`,
`LOCAL_PROVIDER` or `device_instance_bindings` reads the provider (`permissionSupport`, `report`)
instead; those columns and tables are dropped. `device-local` ports `local-device-provider.ts`,
`instance-bindings.ts`, the hello / owner-report handling and the protocol frames.

**Tech Stack:** TypeScript, NestJS + Fastify (`@fastify/websocket`), Kysely/PG, Redis (Valkey),
BullMQ, vitest; plugins repo with `@capybara-hq/testing` and the published `@capybara-hq/device`.

**Spec:** `docs/superpowers/specs/2026-11-21-device-provider-design.md` §5, §6.1 (scope, project
paths), §6.7, §7 (provider side only), §10 (bootstrap scope, protocol subpath).


## Reconciliation (index rulings; these win over the tasks below)

- R1: Task 12 drops its scope bullets (`plugin-sdk/src/sandbox-operation.ts` scope, `packages/device/src/exec/*`, the conformance suite and fixture scope, the scope test): phase 1 did them. Task 12 adds: remove read expansions (`PermissionExpansion.readDirectories` and their review, event and replay paths).
- R2: Task 6 does not set `DEVICE_PROTOCOL_VERSION` (phase 1 set 5); it changes protocol 5 in place.
- R3: Task 2 keeps only the subpath move; its setup-guide files and tests are phase 1's.
- R5: Task 9 creates no migration; `DeviceReports` exists (phase 1) and gains `changed`, comparing `devices.report->>'revision'`. Task 14's migration takes the next free number.
- R7: confirmed: policy ops are deleted, not moved.
- R9: Task 16 is dropped (phase 1 Tasks 14-15).
- R16: `fake-dial-in` lives in `packages/kernel/test/fixtures/plugins/`; `FakeDialInMachine` / `signInFakeMachine` in `packages/testing/src`.

## Global Constraints

All of the index's Global Constraints, plus:

- Depends on phase 1 being merged: `DeviceProviders` (`forDevice`, `onInOrg`, `defaultFor`),
  `DeviceProvider.report`, `DeviceRef`, `DeviceReport`, `ProjectPathRefusedError`, the
  `device-connection` guide place, and `devices.provider` holding plugin names exist.
- Dial-in protocol string: `capybara-device/5`, exported as `DEVICE_DIAL_IN_PROTOCOL` from
  `@capybara-hq/plugin-sdk/device-protocol`; `DEVICE_PROTOCOL_VERSION = 5`. The header stays
  `x-capybara-device-protocol`; its value is the full protocol string.
- The kernel never parses an envelope `body`; it bounds every frame by the negotiated
  `maxFrameBytes` before handing it to a provider.
- Machine credential prefix `cap_dev_`, close codes `DEVICE_CLOSE` (4002 replaced, 4003 revoked,
  4400 protocol, 4409 claim) and the partial unique index `device_machines_active_uq` are unchanged.
- New kernel migrations: `0174_device_report_revision.sql`, `0175_dial_in_contract.sql`.
- Routes: `GET /device/connect`, `api/v1/device/{authorize,token,pending/:userCode,confirm,deny}`
  stay; new `GET api/v1/device/providers` (session only). `POST /orgs/:orgId/devices/:id/policy`
  is removed with its Platform exclusion (the policy ops are subsumed by the kernel network
  setting, see Index issues). `DELETE /orgs/:orgId/devices/:id/machine` stays until phase 3.
- `device-local` tables live in schema `plugin_device_local`; the plugin holds no socket and no
  credential.

## Waves

| Wave | Tasks | Repo |
|---|---|---|
| 1 | T1 SDK dial-in contract · T2 SDK protocol subpath + `::shell-action` · T3 bootstrap `scope` | core |
| 2 | T4 kernel move to `src/dial-in` · T5 fake dial-in fixture | core |
| 3 | T6 `capybara-device` protocol 5 · T7 envelope, gateway, relay, `ctx.dialIn` · T8 sign-in by provider, `createDialIn` | core |
| 4 | T9 report revision and epoch | core |
| 5 | T12 authority rewrite (permission files) · T10 dual-replica dial-in test | core |
| 6 | T13 neutral devices / sandbox / tools / schedules · T11 web confirm page + device types | core |
| 7 | T14 delete local semantics + migration 0175 | core |
| — | core PR → SDK + device release | |
| 8 | T15 `device-local` provider · T16 `device-docker` / `device-e2b` scope | plugins |
| 9 | T17 `device-local` hello, owner report, report, migrations | plugins |
| 10 | T18 `device-local` guide + e2e with published `capybara-device` | plugins |
| — | plugins PR → release | |
| 11 | T19 core bootstrap pin `device-local` with `scope: "all"` | core |

## Review Focus

Index lines owned here:

- A report revision changing between an approval being asked and being granted must invalidate
  the approval, for docker as well as local (T9, test `approval asked under one report revision is
  stale after reportChanged`, sandbox-fake and fake-dial-in).

Phase-specific:

1. A provider calling `ctx.dialIn.request`, `stop` or `ctx.devices.reportChanged` for a device of
   another provider (or another org where it is off) must be refused without touching that device
   (T7, T9).
2. A credential presented with a protocol header that differs from its device provider's declared
   `dialIn.protocol`, or whose provider is off in the org or not loaded, never upgrades: 426 / 403
   before the socket opens (T7).
3. A hello the provider rejects (or whose `onHello` throws or exceeds `HELLO_TIMEOUT_MS`) closes
   4400 without claiming the lease; the device reads offline and no report is recorded (T7).
4. Two dial-in providers on in one org: the confirm page offers both only when both declare the
   machine's protocol; a device created for one is never served by the other's handler (T8, T10).
5. A machine replaced by a sign-in elsewhere: the old socket closes 4002, the provider's
   `onClose(deviceId, "replaced")` runs on the holder replica, the new hello's report revision bumps
   the epoch, and in-flight outside-sandbox work under the old revision is revoked (T9, T10).

---

### Task 1: SDK dial-in contract [review alone, most capable model]

**Files:**
- Create: `packages/plugin-sdk/src/dial-in.ts`
- Modify: `packages/plugin-sdk/src/index.ts` (export `./dial-in.js`), `packages/plugin-sdk/src/permissions.ts:8-58` (interface), `:97-109` (`KEYS`), `:131-272` (`validatePermissions`), `packages/plugin-sdk/src/ctx.ts:173-322` (`ExtensionContext`), `packages/plugin-sdk/src/device-provider.ts` (`dialIn?: DialInHandler` typed from this file), `packages/plugin-sdk/src/sandbox-operation.ts` (`DeviceRequestNotSentError` moves here from the kernel), `packages/kernel/src/sandbox/request-not-sent.ts` (re-imports from the SDK; delete the local class)
- Test: `packages/plugin-sdk/test/dial-in.test.ts`, `packages/plugin-sdk/test/permissions.test.ts`
- Generated: `packages/plugin-sdk/api/plugin-sdk.api.md`, `.changeset/device-provider-dial-in.md`

**Interfaces:**
- Consumes: phase 1 `DeviceProvider`.
- Produces: `DialInHandler`, `DialInChannel`, `DevicesCtx` exactly as the index; `class DeviceOfflineError extends Error { readonly code = "device.offline" }`; `class DeviceRequestNotSentError extends Error` and `isDeviceRequestNotSent(e: unknown): boolean`; `ExtensionPermissions.dialIn?: { protocol: string }`; `ExtensionContext.dialIn: DialInChannel` and `ExtensionContext.devices: DevicesCtx` (gated, documented "requires permissions.dialIn" / "requires provides device-provider@1"); the envelope:

```ts
export type DialInMachineFrame =
  | { type: "hello"; protocol: string; programRunId: string;
      program: { version: string; os: string; arch: string; bootId?: string };
      transport: { maxFrameBytes: number }; body: unknown }
  | { type: "res"; id: string; body: unknown }
  | { type: "event"; body: unknown };
export type DialInKernelFrame =
  | { type: "ready"; connectionId: string }
  | { type: "req"; id: string; deadlineMs: number; body: unknown }
  | { type: "cancel"; id: string }
  | { type: "stop"; reason: "drain" | "stop" };
export const DIAL_IN_PROTOCOL_RE = /^[a-z][a-z0-9-]{0,40}\/[1-9][0-9]{0,3}$/;
export function parseDialInMachineFrame(text: string, maxBytes: number): DialInMachineFrame;
```

- [ ] **Step 1: Write the failing tests**

`dial-in.test.ts`:
- `parses a hello envelope and keeps the body opaque`: body `{ any: [1] }` comes back deep-equal.
- `rejects a frame over maxBytes before JSON.parse`: 2 KiB text, `maxBytes` 1024 → throws `/frame exceeds/`.
- `rejects unknown envelope types and extra top-level keys`: `{type:"policy"}` and a hello with `owner` → throw.
- `rejects a hello whose protocol does not match DIAL_IN_PROTOCOL_RE`: `"5"`, `"Capybara/5"` throw; `"capybara-device/5"` passes.
- `DeviceOfflineError and DeviceRequestNotSentError are recognizable across realms`: `isDeviceRequestNotSent({ name: "DeviceRequestNotSentError" })` true.

`permissions.test.ts`:
- `accepts permissions.dialIn with a protocol`: `{ dialIn: { protocol: "capybara-device/5" } }` valid.
- `rejects dialIn without provides device-provider@1`: error mentions `device-provider@1`.
- `rejects a malformed dialIn protocol`: `{ protocol: "x" }` → error.

- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/dial-in.test.ts packages/plugin-sdk/test/permissions.test.ts` — Expected: FAIL (module `../src/dial-in.js` not found).
- [ ] **Step 3: Implement** the types and parser in `src/dial-in.ts` (strict zod objects; byte length checked with `Buffer.byteLength` before parse); `dialIn` in `KEYS` and a validation block before `validatePermissions` returns, requiring the manifest's `provides` to include `DEVICE_PROVIDER_EXTENSION_POINT`.
- [ ] **Step 4: Run** the same command — Expected: PASS. Then `pnpm gen:sdk-api` and `pnpm changeset` (minor bump `@capybara-hq/plugin-sdk`: "dial-in channel contract").
- [ ] **Step 5: Commit**

```bash
git add packages/plugin-sdk packages/kernel/src/sandbox/request-not-sent.ts .changeset
git commit -m "feat(plugin-sdk): dial-in channel contract and permissions.dialIn

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

### Task 2: SDK `device-protocol` subpath and `::shell-action`

**Files:**
- Modify: `packages/plugin-sdk/src/device-protocol.ts` (whole file), `packages/plugin-sdk/src/index.ts:15` (drop the re-export), `packages/plugin-sdk/package.json:16-33` (`exports` and `publishConfig.exports` gain `"./device-protocol"`), `packages/plugin-sdk/src/setup-guide-parse.ts:37,116-216` (new `SHELL_ACTION_LINE_RE`), `packages/plugin-sdk/src/setup-guide.ts` (`GuideShellAction` type, `SHELL_ACTIONS = ["connect-this-machine"] as const`)
- Modify (import path only): every `from "@capybara-hq/plugin-sdk"` import of a device-protocol symbol in `packages/kernel/src/local-devices/*`, `packages/kernel/test/local-devices/*`, `packages/device/src/**`, `packages/testing/src/**`
- Test: `packages/plugin-sdk/test/device-protocol.test.ts`, `device-protocol-v4-shapes.test.ts` → renamed `device-protocol-shapes.test.ts`, `device-protocol-operations.test.ts`, `setup-guide.test.ts`, `plugin-package.test.ts`

**Interfaces:**
- Produces: `@capybara-hq/plugin-sdk/device-protocol` (all of today's protocol exports; `LEGACY_DEVICE_PROTOCOL_VERSION`, `LegacyDeviceHello`, `parseLegacyDeviceFrame` are deleted); `DEVICE_DIAL_IN_PROTOCOL = "capybara-device/5"` (value used from T6 on; `DEVICE_PROTOCOL_VERSION` becomes 5 in T6); parsed guide node `{ kind: "shell-action"; action: "connect-this-machine"; label: string }`.

- [ ] **Step 1: Write the failing tests**
- `plugin-package.test.ts` `the device-protocol subpath resolves and the root no longer exports protocol frames`: `import("@capybara-hq/plugin-sdk/device-protocol")` has `parseDeviceFrame`; root module has no `parseDeviceFrame`.
- `setup-guide.test.ts` `parses ::shell-action connect-this-machine with a label`: node deep-equals `{ kind: "shell-action", action: "connect-this-machine", label: "Connect this machine" }`; `rejects an unknown shell action`: `::shell-action format-disk Go` → parse error naming the allowed actions; `::shell-action is allowed only in device-connection guides`: same line in a `connector-template` guide → error.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test` — Expected: FAIL on the three new tests.
- [ ] **Step 3: Implement** the subpath export (source condition `@capybara-hq/source` → `src/device-protocol.ts`, like `"."`), the legacy deletions, the directive (per-place allowance in `SETUP_GUIDE_PLACE_INFO["device-connection"].shellActions = true`), and update importers.
- [ ] **Step 4: Run** `pnpm exec vitest run packages/plugin-sdk/test && pnpm typecheck` — Expected: PASS. `pnpm gen:sdk-api`; add to the T1 changeset.
- [ ] **Step 5: Commit** `refactor(plugin-sdk): protocol frames move to the device-protocol subpath` (+ `feat` line for `::shell-action` in the body), Co-Authored-By line.

### Task 3: bootstrap `scope` for preinstalls

**Files:**
- Modify: `packages/plugin-sdk/src/bootstrap.ts:38-64,81-151` (`scope?: "all" | "optional"` on both entry kinds; superRefine: `scope` only when neither `required` nor `builtin`), `packages/plugin-sdk/schemas/bootstrap.v1.schema.json` (`pnpm gen:package-schemas`), `tools/checks/src/bootstrap.ts:77` (`bootstrap-scope` rule), `packages/kernel/src/extensions/bootstrap.ts:590-675,720-760` (`deploy` / `importOnly` pass `scope: e.scope ?? "optional"` to `imports.confirm`), `packages/kernel/src/catalog/plugin-import.ts:1300-1303` (accept the passed scope for `kind: "bootstrap"`)
- Test: `packages/plugin-sdk/test/bootstrap.test.ts`, `tools/checks/test/bootstrap.test.ts` + fixture `tools/checks/fixtures/bootstrap/scope-on-builtin.json`, `packages/kernel/test/extensions/bootstrap.test.ts`

**Interfaces:** Produces `BootstrapEntry.scope?: "all" | "optional"`.

- [ ] **Step 1: Write the failing tests**
- SDK `accepts scope all on an optional preinstall` / `rejects scope on a builtin or required entry` (message `scope applies only to optional preinstalls`).
- checks `bootstrap-scope fails on scope with builtin: true` using the new fixture (proven red first).
- kernel `a preinstall with scope all is on in every org and switchable`: catalog item `scope = "all"`, `builtin = false`; an org admin switch-off succeeds; `a preinstall without scope stays optional and off`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/bootstrap.test.ts tools/checks/test/bootstrap.test.ts packages/kernel/test/extensions/bootstrap.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** as listed; a later change of `scope` in `bootstrap.json` for an already imported item does not rewrite the catalog item's scope (the super admin owns it after import); document that in the `bootstrap.ts` header doc (lines 45-107) and in the `writing-plugins` skill's bootstrap section.
- [ ] **Step 4: Run** the same command — Expected: PASS. `pnpm gen:sdk-api`; add to the changeset.
- [ ] **Step 5: Commit** `feat(bootstrap): scope for optional preinstalls`, Co-Authored-By line.

### Task 4: move the generic files to `src/dial-in` (no behavior change)

**Files:**
- Move (git mv + class rename): `local-devices/device-auth.ts` → `dial-in/auth.service.ts` (`DialInAuthService`), `device-auth.controller.ts` → `dial-in/auth.controller.ts` (`DialInAuthController`), `device-auth.module.ts` → `dial-in/auth.module.ts` (`DialInAuthModule`), `dto.ts` → `dial-in/dto.ts`, `machines.ts` → `dial-in/machines.ts` (`DialInMachines`), `local-device-gateway.ts` → `dial-in/gateway.ts` (`DialInGateway`), `relay.ts` → `dial-in/relay.ts` (`DialInRelay`), `device-routes.ts` → `dial-in/routes.ts`, `keys.ts`, `targets.ts` → `dial-in/`; new `dial-in/dial-in.module.ts` (`DialInModule`: `DeviceTargets`, `DialInRelay`, `DialInMachines`; exports them)
- Move: `local-devices/network-grants.ts` + `.module.ts` → `packages/kernel/src/sandbox/network-grants.ts` / `network-grants.module.ts` (run grants are kernel-wide), minus `reportedMode` (221-235, test-only) which is deleted; `relayer` (258-280) stays in `local-devices/local-device-provider.ts` (its only caller)
- Modify (imports): every file in the "imports of local-devices" list of this plan's appendix
- Move tests: `test/local-devices/{device-auth,machines,local-device-gateway,local-device-gateway.dual,relay,network-grants}.test.ts` → `test/dial-in/` and `test/sandbox/network-grants.test.ts`; `container-tests.json:33` path updated
- `LocalDevicesModule` keeps the local files and imports `DialInModule`

**Interfaces:** Produces the class names of the index (`DialInAuthService`, `DialInMachines`, `DialInGateway`, `DialInRelay`, `DialInModule`), `NetworkGrants` at `src/sandbox/network-grants.ts`.

- [ ] **Step 1:** Run `pnpm exec vitest run packages/kernel/test/local-devices` and record the pass list (baseline).
- [ ] **Step 2:** Do the moves and renames; `pnpm typecheck` — Expected: PASS.
- [ ] **Step 3: Run** `pnpm exec vitest run packages/kernel/test/dial-in packages/kernel/test/local-devices packages/kernel/test/sandbox/network-grants.test.ts && pnpm check:test-portfolio` — Expected: the same tests pass as the baseline.
- [ ] **Step 4: Commit** `refactor(kernel): generic dial-in files move to src/dial-in`, Co-Authored-By line.

### Task 5: fake dial-in provider fixture

**Files:**
- Create: `packages/testing/fixtures/extensions/fake-dial-in/{package.json,index.ts}`, `packages/testing/src/fake-dial-in-machine.ts`
- Modify: `packages/testing/src/fixtures.ts:32-56` (`FAKE_EXTENSIONS` gains `"fake-dial-in"`), `packages/testing/src/index.ts` (export)
- Test: `packages/testing/test/fake-dial-in-machine.test.ts` (unit: envelope round trip against a local `ws` server)

**Interfaces:**
- Consumes: T1 types.
- Produces:
  - fixture `fake-dial-in`: `provides: ["device-provider@1"]`, `permissions.dialIn = { protocol: "fake-dial-in/1" }`; implements `DeviceProvider` by relaying each op as `{ op, args }` through `ctx.dialIn.request`; `onHello` accepts bodies `{ revision: string; outsideSandbox: boolean; refuse?: string }` (stores them in `ctx.kv` with TTL 1 h under `hello:<deviceId>`, calls `ctx.devices.reportChanged`), refuses with `code: "fake.refused"` when `refuse` is set; `report()` returns `{ revision, description: { en: "Fake dial-in device" }, home: null, limits: [], reset: false }` from the stored hello; `onFrame` bodies `{ revision }` update it and call `reportChanged`.
  - `class FakeDialInMachine { static connect(opts: { url: string; credential: string; protocol?: string; hello: unknown; maxFrameBytes?: number }): Promise<FakeDialInMachine>; onRequest(fn: (body: unknown) => unknown | Promise<unknown>): void; send(event: unknown): Promise<void>; closed: Promise<{ code: number; reason: string }>; close(): Promise<void> }`
  - `signInFakeMachine(kernel: TestKernel, opts: { orgId: string; session: string; provider: string; protocol: string; name?: string }): Promise<{ credential: string; deviceId: string }>` (drives authorize → confirm → token over HTTP).
- [ ] **Step 1: Write the failing test** `fake machine answers a req with res carrying the same id`, `fake machine closes with the server's code`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/testing/test/fake-dial-in-machine.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement**; the test joins the testing package's unit set (it needs no containers).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `test(testing): fake dial-in provider and machine`, Co-Authored-By line.

### Task 6: `capybara-device` speaks protocol 5

**Files:**
- Modify: `packages/plugin-sdk/src/device-protocol.ts` (`DEVICE_PROTOCOL_VERSION = 5`; `DeviceHello` becomes the hello **body**: drops `type`, `protocol`, `programVersion`, `os`, `arch`, `bootId`, `programRunId`, `transport` (now envelope fields) and the `policy` request op with `DevicePolicyArgs/Result/Status`; `ownerCeiling` stays in the body, read by `device-local`, never by the kernel; `parseDeviceFrame` parses bodies; test `packages/plugin-sdk/test/device-protocol-shapes.test.ts` `parseDeviceFrame rejects a body with a policy op`), `packages/device/src/staged-connect.ts:210` (header `DEVICE_DIAL_IN_PROTOCOL`, envelope via `parseDialInMachineFrame` / kernel frames), `packages/device/src/staged-device.ts:172-344` (`report()` builds `{ envelope, body }`), `packages/device/src/client.ts:6-27` (426 texts read the protocol string), `packages/device/src/commands/login.ts` (authorize sends `protocol: DEVICE_DIAL_IN_PROTOCOL`), `packages/device/src/server-ops.ts` (no `policy` op)
- Test: `packages/device/test/client.test.ts`, `packages/device/test/fake-kernel.ts` (speaks the envelope), `packages/device/test/staged-connect.test.ts` (or the existing session test that asserts the header)
- Changeset: `@capybara-hq/device` minor

**Interfaces:**
- Consumes: T1 envelope, T2 subpath.
- Produces: protocol 5 machine side and the v5 body types T7's interim kernel codec uses. T6 and T7 land in the same wave; `pnpm typecheck` is the wave's gate, not each task's.
- [ ] **Step 1: Write the failing tests**: `sends x-capybara-device-protocol capybara-device/5`; `hello envelope carries program facts and the body carries ownerCeiling`; `a kernel 426 naming capybara-device/4 says update the deployment` (newer program) and `/6` says update the program.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the same command, plus `pnpm exec vitest run --project device-os` where available — Expected: PASS.
- [ ] **Step 5: Commit** `feat(device): protocol 5 envelope and hello`, Co-Authored-By line.

### Task 7: envelope, gateway, relay and `ctx.dialIn` [review alone, most capable model]

**Files:**
- Modify: `packages/kernel/src/dial-in/gateway.ts` (whole: `onFrame` 218-295 parses `DialInMachineFrame`; hello → `DialInMachines.recordConnect` then the provider's `onHello`; `event` → `onFrame`; close paths call `onClose`), `dial-in/relay.ts` (`callWithCodec` 319-495 becomes `request(deviceId, body, opts): Promise<unknown>` returning the `res` body; delete `callV3`, `call`, `stagedTransport`, `POLICY_REFUSAL_PREFIX`, `ON_MACHINE_PREFIX`), `dial-in/routes.ts:72-141` (provider lookup + protocol check), `dial-in/machines.ts` (delete `recordHello`, `recordHelloV3`, `backfillOps`, `boundIdentityLocked`, `replaceUnattestedLocked`, `recordPolicy*`, `reportedPolicy`; add `recordConnect`), `dial-in/targets.ts` (delete `machineRoots`, `machineFeatures`, `sameRoots`), `packages/kernel/src/ctx/create-ctx.ts:446-476,976` (`dialIn` gate), `packages/kernel/src/extensions/permission-set.ts:25-60,191-204,217-247` (key `permissions.dialin:<protocol>`), `packages/kernel/src/extensions/permission-view.ts:40-46,248-260`, `packages/kernel/src/local-devices/local-device-provider.ts` (`staged` transport now `DialInRelay.request` plus the body codec that used to live in the relay; interim until T14)
- Create: `packages/kernel/src/dial-in/handlers.ts` (`DialInHandlers`)
- Test: `packages/kernel/test/dial-in/gateway.test.ts`, `dial-in/relay.test.ts`, `extensions/ctx-permissions.test.ts`, `extensions/permission-set.test.ts`, new `test/dial-in/envelope.test.ts` (unit; joins `unit-tests.json`)

**Interfaces:**
- Consumes: T1, T4, T5, T6 (v5 body types); phase 1 `DeviceProviders.forDevice`.
- Produces:
  - `DialInHandlers` (`@Injectable`): `forDevice(deviceId: string): Promise<{ plugin: string; protocol: string; handler: DialInHandler } | { unavailable: "not-dial-in" | "off" | "unloaded" }>` (reads `devices.provider`, the loaded provider's manifest `permissions.dialIn`, and `DeviceProviders.onInOrg`).
  - `DialInMachines.recordConnect(machineId: string, program: { version: string; os: string; arch: string; bootId?: string }): Promise<void>` (writes `program_version`, `os`, `arch`, `boot_id`, `last_seen_at`).
  - `DialInRelay.request(deviceId: string, body: unknown, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown>` (throws SDK `DeviceOfflineError` / `DeviceRequestNotSentError`), `DialInRelay.online(deviceId: string): Promise<boolean>` (the lease holder check), `DialInRelay.stop(deviceId: string, reason: "drain" | "stop"): Promise<void>`.
  - `ctx.dialIn` for an extension declaring `permissions.dialIn`: each method first checks `devices.provider = <calling plugin>` and the org has the plugin on; otherwise throws `ExtensionPermissionError("device <id> is not served by <plugin>")`.
- [ ] **Step 1: Write the failing tests** (integration unless noted; fake-dial-in loaded):
  - `routes a credential to its device provider and opens the socket` (FakeDialInMachine with `fake-dial-in/1` gets `ready`).
  - `answers 426 when the protocol header differs from the provider's declaration` (header `capybara-device/5` → 426 `device.program_outdated`, body names `fake-dial-in/1`).
  - `answers 403 device.provider_unavailable when the device's provider is off in the org` (switch fake-dial-in off for the org, then connect).
  - `closes 4400 with the provider's code when onHello refuses, without claiming the lease` (`refuse: "nope"`; `close.reason` contains `fake.refused`; `DialInRelay.online` false).
  - `closes 4400 on a frame over maxFrameBytes without calling onFrame` (spy on the fixture via ctx.kv marker: absent).
  - `ctx.dialIn.request relays a body and resolves the machine's res body`.
  - `ctx.dialIn.request throws DeviceOfflineError after the reconnect grace with no holder`.
  - `ctx.dialIn.request for a device of another provider throws ExtensionPermissionError` (a sandbox-fake device id).
  - `onClose receives replaced when the device signs in from another machine` (second sign-in; first closes 4002).
  - unit `envelope.test.ts`: `the gateway envelope strips kernel-internal fields before the provider sees a body`.
  - `ctx-permissions.test.ts`: `ctx.dialIn without permissions.dialIn throws ExtensionPermissionError`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/dial-in packages/kernel/test/extensions/ctx-permissions.test.ts packages/kernel/test/extensions/permission-set.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**. `onHello` runs on the gateway replica holding the socket, after `claim()` succeeds and before `ready` is sent; a refusal or `HELLO_TIMEOUT_MS` releases the lease and closes 4400. `onClose` reasons map from `DEVICE_CLOSE` (4002 `replaced`, 4003 `revoked` or `deleted` by the revocation topic payload, else `offline`). The relay keeps its Redis lists, taken keys, `notSent`, cancel and reconnect grace unchanged; only the frame codec becomes the envelope.
- [ ] **Step 4: Run** the same command and `pnpm exec vitest run packages/kernel/test/local-devices` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): generic dial-in envelope, provider routing and ctx.dialIn`, Co-Authored-By line.

### Task 8: sign-in by provider and `createDialIn` [review alone, most capable model]

**Files:**
- Modify: `packages/kernel/src/dial-in/auth.service.ts:84-130` (`DeviceMachineInfo.protocol: string`), `:301-335` (`confirm` input gains `provider: string`), `:387-435` (`confirmIn`: existing device lookup by `provider = input.provider` instead of `LOCAL_PROVIDER`; calls `createDialIn`), `dial-in/auth.controller.ts:55-131` (new `GET providers`), `dial-in/dto.ts:6-51` (`DeviceAuthorizeBody.protocol` matching `DIAL_IN_PROTOCOL_RE`; `DeviceConfirmBody.provider`; `DeviceProvidersQuery { orgId, userCode }`), `packages/kernel/src/devices/devices.service.ts:409-415` (`createLocal` → `createDialIn`)
- Test: `packages/kernel/test/dial-in/auth.test.ts` (moved `device-auth.test.ts`)

**Interfaces:**
- Consumes: T7 `DialInHandlers`; phase 1 `DeviceProviders.onInOrg`.
- Produces:
  - `DevicesService.createDialIn(orgId: string, accountId: string, provider: string, name: string): Promise<{ id: string }>` (`@Transactional`, `devices.maxPersonal` and name checks as `createLocal`; refuses `device.provider_unavailable` unless `provider` is on in the org and declares `dialIn`).
  - `GET api/v1/device/providers?orgId&userCode` → `{ providers: Array<{ plugin: string; displayName: { en: string; zh?: string }; devices: Array<{ id: string; name: string }> }> }`: the providers on in the org whose `dialIn.protocol` equals the pending code's `protocol`, each with the person's existing devices of that provider (`@SessionOnly`, `agents.use` in that org).
- [ ] **Step 1: Write the failing tests**: `lists only providers on in the org that declare the machine's protocol` (fake-dial-in on, a second fixture provider with another protocol absent); `confirm with a provider off in the org answers device.provider_unavailable`; `confirm into an existing device of the provider replaces its machine` (revokes the old credential, 4002 on its socket); `confirm creates the device with devices.provider = fake-dial-in`; `authorize without protocol answers 400`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/dial-in/auth.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; `device.machine_connected` audit gains `provider`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): device sign-in chooses a dial-in provider`, Co-Authored-By line.

### Task 9: report revision and the provider-neutral authority epoch [review alone, most capable model]

**Files:**
- Create: `packages/kernel/src/migrations/0174_device_report_revision.sql` (`ALTER TABLE devices ADD COLUMN IF NOT EXISTS report_revision text;`), `packages/kernel/src/sandbox/device-reports.ts` (`DeviceReports`), `device-reports.module.ts`
- Modify: `packages/kernel/src/db/kernel-schema.ts:1276-1290` (`report_revision`), `packages/kernel/src/ctx/create-ctx.ts` (`ctx.devices` for extensions providing `device-provider@1`), `packages/kernel/src/sandbox/permission-ceiling-writes.ts:80-110` (`publishLocked` accepts the revoke predicate `reportNarrowed`)
- Test: `packages/kernel/test/sandbox/device-reports.test.ts`

**Interfaces:**
- Consumes: phase 1 `DeviceProviders.forDevice`, `DeviceProvider.report`, `permissionSupport`; `PermissionCeilingWrites.lock` / `publishLocked`, `PermissionAuthorityEpochStore`.
- Produces: `DeviceReports.changed(plugin: string, deviceId: string): Promise<"bumped" | "same">` and `DeviceReports.current(deviceId: string): Promise<{ revision: string; support: SandboxPermissionSupport } | null>`; `ctx.devices.reportChanged(deviceId)` calls `changed(<calling plugin>, deviceId)`.
- Behavior: refuse (`ExtensionPermissionError`) unless `devices.provider = plugin`; call `report()` and `permissionSupport()` **outside** any transaction; then in one `@Transactional` method under `PermissionCeilingWrites.lock({ device })`: compare-and-set `devices.report_revision`; on change `publishLocked(device, { revoke: (intent) => intent.outsideSandbox && !support.outsideSandbox || intent.perOperationHosts && !support.network.perOperationHosts, invalidateFullConsent: !support.outsideSandbox })`. Multi-replica: no in-process cache; every read goes to PG.
- [ ] **Step 1: Write the failing tests**:
  - `approval asked under one report revision is stale after reportChanged` — twice, `describe.each(["sandbox-fake", "fake-dial-in"])`: ask an outside-sandbox approval, change the fixture's revision and call `reportChanged`, grant → `PermissionAdmissionStale` / the conversation sees the ask expire.
  - `reportChanged with an unchanged revision does not bump the device epoch` (epoch row revision equal).
  - `reportChanged for a device of another provider is refused and bumps nothing`.
  - `a revision change that removes outsideSandbox revokes running outside-sandbox work and resets full consent` (`sandbox_operation_intents.state = 'revoked'`, `full_revision` + 1).
  - `a revision change that keeps the support bumps the epoch but revokes nothing`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/sandbox/device-reports.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; `sandbox-fake` (kernel fixture) gains a test seam to change its report revision (phase 1 gave it `report()`).
- [ ] **Step 4: Run** — Expected: PASS; `pnpm check` (migrations lint) PASS.
- [ ] **Step 5: Commit** `feat(kernel): device report revisions drive the authority epoch`, Co-Authored-By line.

### Task 10: dual-replica dial-in test [review alone, most capable model]

**Files:**
- Modify: `packages/kernel/test/dial-in/gateway.dual.test.ts` (moved in T4; rewritten on `FakeDialInMachine` + fake-dial-in), `packages/kernel/test/container-tests.json`
- Test: the same file

**Interfaces:** Consumes T5, T7, T9.

- [ ] **Step 1: Write the failing tests** (`dualReplicaHarness`, gateway role on replica A, API on B):
  - `a request made on replica B reaches the machine held by replica A and resolves`.
  - `a takeover on replica B closes the socket on A with 4409 and the provider's onClose runs once`.
  - `reportChanged on replica A invalidates an approval being granted on replica B`.
  - `deleting the device on B revokes and closes 4003 on A; ctx.dialIn.request then throws DeviceOfflineError`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/dial-in/gateway.dual.test.ts --project kernel-container` — Expected: FAIL (old helpers gone after the rewrite).
- [ ] **Step 3: Implement** the rewrite; no fixed sleeps (wait on `closed` promises and bus topics).
- [ ] **Step 4: Run** — Expected: PASS; `pnpm check:test-portfolio` PASS.
- [ ] **Step 5: Commit** `test(kernel): dual-replica dial-in channel on the fake provider`, Co-Authored-By line.

### Task 11: web confirm page and device types

**Files:**
- Modify: `apps/web/src/app/(auth)/devices/link/view.tsx:148-340` (`ConfirmForm`: provider select from `deviceProvidersQuery`, hidden when one; device select lists that provider's devices; confirm sends `provider`), `apps/web/src/lib/query/device-sign-in.ts` (`deviceProvidersQuery(orgId, userCode)`), `apps/web/src/lib/device-sign-in.ts` (`DeviceConfirmInput.provider`), `apps/web/src/lib/devices.ts` (device types follow T13's `DeviceView`: `source` → `dialIn: boolean`, `provider`; `machine` keeps `name`, `os`, `arch`, `programVersion`, `lastSeenAt`; `ownerCeiling`, `network.features`, `network.policy`, `machine.mode`, `sessionIsolation` removed), the readers of those fields (`components/DeviceModeSection.tsx`, `components/DeviceCreateDialog.tsx`, `components/DeviceProjectsSection.tsx`, `app/(app)/devices/[id]/view.tsx`, `dev/catalog/device-blocks.tsx`: `source === "local"` → `dialIn`; rows reading removed fields are removed, not replaced: phase 3 rewrites the page), i18n zh/en keys for the provider select (`设备提供方` / "Device provider")
- Test: `apps/web/test/device-link-page.test.tsx`, `apps/web/test/devices.test.tsx`

**Interfaces:** Consumes T8 route and payload; T13 `DeviceView`.

- [ ] **Step 1: Write the failing tests**: `confirm page offers a provider select when two dial-in providers are on`; `confirm page hides the provider select with one provider and sends it`; `devices list marks a dial-in device online from dialIn and online`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/device-link-page.test.tsx apps/web/test/devices.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** with design components only (`check:web-ui`).
- [ ] **Step 4: Run** the same command plus `pnpm check:i18n && pnpm check:web-ui` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): device sign-in chooses the provider`, Co-Authored-By line.

### Task 12: authority rewrite, one report-driven path [review alone, most capable model]

**Files (modify):**
- `packages/kernel/src/sandbox/operation-authority.ts`: `withheldScope` 120-145 (compare `applied.revision` instead of `location`; delete the "local device cannot report an instance boundary" refusal at 137), 220 `restrictedReadRoots` (delete), `intersectPermissionScope` 173 (scope `{ projectRoot, writeRoots }`), 254-255 / 696-697 / 1132-1133 (delete `assertOwnerReportUsable` calls), `isolatedRuntime` 608-619 (`support.boundary === "instance"`), 750 / 764 / 1161-1211 (no `location`; `outsideSandbox = support.outsideSandbox`), 857-872 / 962-974 (no `projectReachOf`)
- `sandbox/permission-facts.ts`: `readDevice` 115-149 (no machine join; `home` from `DeviceReports`/`report().home`), `deviceSandboxFacts` 171-237 (device layer = `devices.network_mode` / `network_hosts` for every device), `assertOwnerReportUsable` 342-356 (delete), `deviceChosenMode` 364-384 (`cloudChosenMode` for every device, renamed `chosenMode`), `availability` 390-417 (version = provider version for every device), `machineRoots` 503-513 (delete), `projectScope` 515-571 (`supported` = provider has `list`; `home` from the report; no reach), 580, `scope` 601-674 (no `broadProjectReach`), `readAppliedEnvironment` 774-859 + `cloudAppliedLocked` 873-913 (one path: `readCurrentReport` + the stored `report_revision`); delete imports 26-27
- `sandbox/permission-runtime-reports.ts`: 217-260 one identity rule (`runtimeIdentity` = kernel-built identity incl. `report_revision`; rename `cloudRuntimeIdentity` → `runtimeIdentityOf`, `cloudEnforceable` → `enforceable`, `recordCloud` → `recordSupport`, `clearCloud` → `clearSupport`, `cloudReportOwed` → `reportOwed`); delete `record` (local-only)
- `sandbox/permission-context-types.ts:40` (`AppliedEnvironment`: `location` removed, `revision: string` added, `bindingId` removed)
- `sandbox/permission-instance-writes.ts:85-129,181,280-320` (no `displayedRoots`, no `awaitDevice` path)
- `sandbox/permission-ceiling-writes.ts:9,194-228,256-263` (delete `localMachineRoots`, `outsideMachineRoots` use, `requiresBroadProjectReach`; `cloudDevicesFollowingDefault` → `devicesFollowingDefault`, no source filter)
- `sandbox/permission-config-publication.ts:390,484-543,593` (no local roots revocation; kill switch and network pins for every device)
- `sandbox/legacy-retirement.ts:233,260,639-817,1196-1201` (delete the boot machinery, `localWithoutBoot`, `isCloudProvider`; obligations for every provider) and `legacy-retirement.module.ts`
- `sandbox/device-sandbox.ts:62-78,163-259` (one `DeviceSandboxDeviceLayer`; `providerLayerOf(support)` without location)
- `sandbox/modes.ts:132-139` (delete `projectReachOf`)
- `sandbox/cloud-permission-snapshot.ts:97,464` (no source filter)
- `sandbox/review/permission-candidate.ts:145,157-170,256` (`escalationCeilingWhy` by `support.outsideSandbox` / boundary; `ESCALATION_DEVICE_OFF_WHY` says "This device's provider does not allow running outside the sandbox now: <report.description.en>")
- `packages/kernel/src/conversations/events.ts:112,146,267-299,1262-1265` (scope and sandbox events carry `boundary` instead of `location`)
- `packages/kernel/src/runtime/context/permission-profile.ts:79,200` (wording by `boundary === "operation"`)
- `packages/plugin-sdk/src/sandbox-operation.ts:103,230,397-405,512-522` (`scoped{ projectRoot, writeRoots }` per the index), `packages/device/src/exec/operation-types.ts:50,229-271`, `exec/mac-operation-backend.ts:286-347`, `exec/linux-operation-worker.ts:222`, `exec/mac-self-check.ts:122-130` (the program derives its read roots itself as today's set: `writeRoots` ∪ tool directories ∪ its machine read rule; phase 4 replaces this; changeset on `@capybara-hq/device`), `packages/testing/src/sandbox-permission-conformance.ts`, `packages/kernel/test/fixtures/plugins/sandbox-fake/index.ts` (scope)
- Tests: `test/sandbox/{operation-authority,device-sandbox,kernel-reads,permission-wiring,sandbox.service-gates,approval-only-profiles.dual,permission-profiles.dual,review.dual,operation-scopes,operation-scopes.dual,managed-device-context}.test.ts`, `test/tools/permission-escalation.test.ts`, `test/platform/permission-lock-order.test.ts`, `test/runtime/permission-context-recorder.test.ts`, `test/helpers/{owner-report,installed-evidence,sandbox,permission-policy}.ts` (owner-report helper deleted), the replay fixtures under `test/runtime/reconstruct*`

**Interfaces:**
- Consumes: T9 `DeviceReports.current`; phase 1 `DeviceProviders`.
- Produces: `AppliedEnvironment { revision: string; boundary: "operation" | "instance"; outerNetwork; … }` (no `location`); `PermissionFacts.projectScope(deviceId): Promise<{ supported: boolean; home: string | null }>`; the renamed runtime-report functions above.

- [ ] **Step 1: Write the failing tests**:
  - `operation-authority.test.ts` `outside-sandbox escalation follows the provider's support, whatever the provider`: `describe.each` sandbox-fake with `outsideSandbox` true / false → candidate allowed / `ESCALATION_DEVICE_OFF_WHY`.
  - `an operation-boundary provider gets the host-environment outer network; an instance-boundary one its instance network` (fixture support switched).
  - `kernel reads use the isolated route exactly for instance-boundary providers`.
  - `a scoped operation carries projectRoot and writeRoots and no read roots` (`operation-scopes.test.ts`, `Object.keys(scope.filesystem)` equals `["kind", "projectRoot", "writeRoots"]`).
  - `no file under packages/kernel/src/sandbox mentions LOCAL_PROVIDER, owner_report or location: "local"` (`grep`-style unit test in `test/sandbox/no-local-branches.test.ts`, joins `unit-tests.json`).
  - Existing local-only cases (`owner browse…`, `running local instance from before the binder…`, `devices.delete of a local device…`, Docker-mode host reads) are deleted; their behavior is the plugin's (T15, T17).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/sandbox packages/kernel/test/tools/permission-escalation.test.ts packages/kernel/test/platform/permission-lock-order.test.ts packages/kernel/test/runtime` — Expected: FAIL on the new cases.
- [ ] **Step 3: Implement**. Run the zero-drift fixture tests before and after (replay-evals skill): the model-visible wording in `permission-profile.ts` changes only through `boundary`; record in the commit body that no `DriftReason` is needed because logs from before this change are not replayed pre-0.1.0.
- [ ] **Step 4: Run** the same command plus `pnpm exec vitest run packages/kernel/test/sandbox --project kernel-container` — Expected: PASS.
- [ ] **Step 5: Commit** `refactor(kernel): one report-driven permission path for every device provider`, Co-Authored-By line.

### Task 13: neutral devices, sandbox service, tools and schedules [review alone, most capable model]

**Files (modify):**
- `packages/kernel/src/devices/devices.service.ts`: 27-31, 52 (imports), 82-110 / 263-271 (`DeviceView`: `source` → `dialIn: boolean` + `provider`; `online` for dial-in devices from `DialInRelay.online`; machine view without `mode`; no `network.features/policy`, `ownerCeiling`, `sessionIsolation`), 319-322 (no `DevicePolicyService`), 409-415 done in T8, 425/457 (`insertNamed` without `source`), 633-659 (`checkNetwork`/`planNetwork`: delete the `device.ceiling_on_machine` refusal), 769-822 (`projectReach`, `modeLevel` without machine join), 950-972 (`changePolicy` deleted), 1093, 1285-1450 (`views`), 1561-1602 (`refuseDeviceReset` by `report().reset`), 1767-1806 (`sandboxViewOf` one shape, `ownerCeilingViewOf` deleted)
- `devices/device-projects.service.ts:23-24,231,284,323,336,515-517,614,677` (provider `ProjectPathRefusedError` → `project.refused`; `projectsUnsupported()` one text; `aboveHome` with the report's home only)
- `devices/project-rules.ts:4-64` (`DeviceProjectScope { home: string | null }`; delete `homeBased`, `withinMode`)
- `devices/access.ts:4,26,69,109-114`, `devices/conversation-devices.ts:13,153-168,243,285,348-356` (no internal provider; usable = `DeviceProviders.forDevice` loaded and on in the org)
- `devices/devices.controller.ts:176-189`, `devices/dto.ts:57-88,132`, `devices/devices.schemas.ts:10-16` (policy route and body deleted), `devices/errors.ts:10-26` (texts name the provider, not capybara-device)
- `packages/kernel/src/platform/ops/devices.ops.ts:38,68-75,139,158,300,408-409,502-557` (no `source`, `ceiling_on_machine`, capybara-device hints; exclusion for the policy route removed), `platform/ops` parity test fixtures
- `sandbox/sandbox.service.ts:139-140,322-331,375,783-830,904,1466,1495,2051,2580-2588,2805-2814,2889,3192-3203,3487,3644-3666,3725` (no `LOCAL_PROVIDER`; `deviceFilesLost()` one shape; `deviceLimits` from `devices.network_*` for every device; sweeps per provider; `retireIncarnations` without boot quarantine)
- `sandbox/managed-device-context.ts:210-225` (`goneError`: a dial-in device with no active machine → `machineRevoked()` via `DialInMachines.activeFor`)
- `background/tasks.service.ts:91,289-296` (`environment` → `provider: string`)
- `schedules/fire.ts:21,156,681-689` (`deviceOffline` = provider declares dialIn and `!DialInRelay.online`), `schedules/grant-rules.ts:3`, `schedules/scheduled-tasks.service.ts:20,116-121` (`deviceRefuses` deleted), `schedules/schedules.module.ts:5,33` (imports `DialInModule`, `NetworkGrantsModule`)
- `tools/builtins/sandbox/common.ts:34-35,233-588,630,669-697` (no `InstanceBindingError`; texts name the provider's description), `tools/builtins/sandbox/bash.ts:20,426` and `sandbox/operation-reconcile.job.ts:18,149,166` (SDK `isDeviceRequestNotSent`), `runtime/project/knowledge.ts:10,140,164` (no `POLICY_REFUSAL_PREFIX`; a `ProjectPathRefusedError` is the refusal)
- `tools/pipeline.ts:44-45,513-514,942-944,1909-1911,2111,2143,2265-2266,2533-2538` (no `DevicePolicyService`; network run state from `NetworkGrants` + the device's kernel network; `deviceHome` from the report), `tools/network-asks.ts:8,159-160,251-254` (asks gated by `support.network.allowlist` instead of machine features), `admin/health.service.ts:308-315` (devices counted per provider), `catalog/requests.service.ts:18` (import path)
- Tests: `test/devices/*.test.ts` touching `source` / local, `test/tools/network-ask.dual.test.ts` and `network-asks*.test.ts` (on fake-dial-in), `test/schedules/*fire*.test.ts`, `test/platform/platform-parity.test.ts`, `test/local-devices/device-tools.test.ts` → `test/dial-in/device-tools.test.ts` (on fake-dial-in)

**Interfaces:** Consumes T7 (`DialInRelay.online`), T9, T12. Produces `DeviceView` as listed (used by T11).

- [ ] **Step 1: Write the failing tests**:
  - `devices list shows dialIn and online for a fake-dial-in device and no machine-only fields`.
  - `a provider refusal of a project path answers project.refused with the provider's text`.
  - `the device network route accepts a dial-in device` (no `device.ceiling_on_machine`).
  - `a schedule on an offline dial-in device does not fire and records device offline`.
  - `a network ask on a provider without perOperationHosts offers only add-to-device` (`network-ask.dual.test.ts`).
  - `no file under packages/kernel/src outside dial-in mentions LOCAL_PROVIDER, isInternalProvider or source === "local"` (extend `no-local-branches.test.ts`).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/devices packages/kernel/test/tools packages/kernel/test/schedules packages/kernel/test/platform packages/kernel/test/dial-in` — Expected: FAIL.
- [ ] **Step 3: Implement**; i18n not touched in the kernel; Platform operation descriptions in English.
- [ ] **Step 4: Run** the same command plus `pnpm check:platform-ops` — Expected: PASS.
- [ ] **Step 5: Commit** `refactor(kernel): devices, tools and schedules without local branches`, Co-Authored-By line.

### Task 14: delete the local semantics and the local columns [review alone, most capable model]

**Files:**
- Delete: `packages/kernel/src/local-devices/` (`local-device-provider.ts`, `instance-bindings.ts`, `device-policy.service.ts`, `policy-op-jobs.ts`, `policy-summary.ts`, `owner-report.ts`, `owner-reports.ts`, `local-devices.module.ts`), `packages/kernel/src/tools/device-op-resolver.ts`, `test/local-devices/` (all remaining files incl. `fake-machine.ts`, `fake-machine-v3.ts`, `test-holder.ts`), the `unit-tests.json` entries `local-devices/owner-report.test.ts`, `local-devices/policy-summary.test.ts`
- Create: `packages/kernel/src/migrations/0175_dial_in_contract.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts:1276-1290,1363-1397,2003` (drop `devices.source`; `DeviceMachinesTable` keeps `id, boot_id, org_id, device_id, account_id, credential_hash, name, os, arch, program_version, last_seen_at, created_at, revoked_at`; drop `DeviceInstanceBindingsTable`, `DeviceMachineBootsTable`), `kernel.module.ts:36,130-131` (`DialInModule`), `devices/devices.module.ts:3,25`, `tools/tools.module.ts:10,78`, `roles/gateway.module.ts:6-19`, `roles/gateway-role.ts:10,35` (`DialInGateway`), `http/api.module.ts:84-85,229,263` (`DialInAuthController`, `DialInAuthModule`), `http/gateway-routes.ts:5-35`, `runtime/maintenance.ts:14-17,57,122,231-232`, `infra/outbox/registry.ts:344-357` (`device-op-resolve` entry removed), `overrides.ts:21,68,115,160` (`DEVICE_POLICY_AFTER_CALL` removed), `sandbox/providers.ts` (`binder` removed from the entry if phase 1 kept it), `.agents/skills/writing-sandbox-providers/SKILL.md` (or its phase 1 successor `writing-device-providers`: dial-in section), `.agents/skills/writing-extensions/SKILL.md` (`ctx.dialIn`, `ctx.devices`), `AGENTS.md` (Sandboxes and Extensions lines per the spec's "AGENTS.md rules touched"), `docs/architecture.md` (`src/dial-in`)
- Test: `packages/kernel/test/migrations/0175-dial-in-contract.test.ts` (or the repo's migration test location), `test/sandbox/no-local-branches.test.ts`

Migration content (each destructive line carries `-- capybara:allow-destructive local device semantics moved to device-local; project not released, no compatibility layer` directly above it):

```sql
ALTER TABLE device_machines DROP COLUMN IF EXISTS features;
ALTER TABLE device_machines DROP COLUMN IF EXISTS local_policy;
ALTER TABLE device_machines DROP COLUMN IF EXISTS owner_report;
ALTER TABLE device_machines DROP COLUMN IF EXISTS pending_policy_ops;
ALTER TABLE device_machines DROP COLUMN IF EXISTS home;
ALTER TABLE device_machines DROP COLUMN IF EXISTS roots;
ALTER TABLE device_machines DROP COLUMN IF EXISTS mode;
ALTER TABLE device_machines DROP COLUMN IF EXISTS session_isolation;
DROP TABLE IF EXISTS device_machine_boots;
DROP TABLE IF EXISTS device_instance_bindings;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_source_check;
ALTER TABLE devices DROP COLUMN IF EXISTS source;
```

**Interfaces:** Consumes T7, T12, T13 (nothing in the kernel reads these any more).

- [ ] **Step 1: Write the failing tests**: migration test `after 0175 device_machines has only the generic columns` (`information_schema.columns` set equals the list above) and `0175 is idempotent` (run twice); `no-local-branches.test.ts` gains `packages/kernel/src/local-devices does not exist`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/migrations packages/kernel/test/sandbox/no-local-branches.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the deletions, wiring and migration.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm check && pnpm exec vitest run packages/kernel/test/dial-in packages/kernel/test/sandbox packages/kernel/test/devices` then `pnpm verify` — Expected: PASS.
- [ ] **Step 5: Commit** `refactor(kernel)!: local device semantics leave the kernel`, body lists the dropped columns, tables and route; Co-Authored-By line. Open the core PR; after merge the SDK and `@capybara-hq/device` release (index release order step 2).

### Task 15: `device-local` provider (plugins) [review alone, most capable model]

**Files (plugins repo):**
- Create: `plugins/device-local/{package.json,README.md,tsconfig.json}`, `.capybara-plugin/plugin.json` (name `device-local`, displayName zh `本机` / en "This machine", `setupGuides: [{ id: "connect", place: "device-connection" }]`), `src/index.ts` (`defineExtension`: `provides: [DEVICE_PROVIDER_EXTENSION_POINT]`, `permissions: { dialIn: { protocol: DEVICE_DIAL_IN_PROTOCOL } }`, `migrations: "../migrations"`), `src/provider.ts` (port of core `local-device-provider.ts`: ops → protocol 5 bodies through `ctx.dialIn.request`; `EXEC_DEADLINE_MARGIN_MS`, `OP_DEADLINE_MS`, `FRAME_ENVELOPE_BYTES`, `maxReadBytes`, `relayer`), `src/bindings.ts` (port of `instance-bindings.ts`: binds every committed generation before shared use, inside `create` / `resume`), `src/frames.ts` (validates every response body with `parseOperationResult` / `parseDeviceFrame` from the subpath)
- Modify: `pnpm-workspace.yaml` (override `@capybara-hq/plugin-sdk` to the released version), `.capybara-plugin/marketplace.json` (entry, `permissions.keys` incl. `provides:device-provider@1`, `permissions.dialin:capybara-device/5`)
- Test: `plugins/device-local/test/provider.test.ts` (fake `DialInChannel`: ported cases of core `local-device-provider.test.ts`), `test/bindings.test.ts` (ported `instance-bindings.test.ts`)

**Interfaces:**
- Consumes: released SDK (`DeviceProvider`, `DialInChannel`, `DialInHandler`, `@capybara-hq/plugin-sdk/device-protocol`).
- Produces: `createDeviceLocalProvider(ctx: ExtensionContext, store: DeviceLocalStore): DeviceProvider` (store from T17; this task uses an interface `DeviceLocalStore { binding(deviceId): Promise<Binding | null>; saveBinding(...): Promise<void> }`).
- [ ] **Step 1: Write the failing tests**: `exec relays a protocol 5 exec body and parses the result strictly`; `a malformed result body throws a ToolError naming the machine, never passes through`; `a read larger than maxReadBytes is refused before the request`; `create binds the committed generation before returning`; `DeviceOfflineError from the channel surfaces as the kernel's offline error`; `a request the gateway never sent rethrows DeviceRequestNotSentError unchanged`.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/device-local/test` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the same command plus `pnpm exec capybara-plugin check plugins/device-local` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(device-local): device provider over the dial-in channel`, Co-Authored-By line.

### Task 16: `device-docker` / `device-e2b` take the new scope (plugins)

**Files:** `plugins/device-docker/src/operations.ts`, `plugins/device-e2b/src/operations.ts`, `plugins/device-e2b/src/operation-agent-source.ts` (read rule: the instance is the boundary; reads everywhere inside the instance, writes only in `writeRoots`), tests `plugins/device-docker/test/permission-scopes.test.ts`, `plugins/device-e2b/test/permission-scopes.test.ts`, `plugins/device-e2b/test/live/permission-scopes.live.test.ts`, changesets for both plugins.

**Interfaces:** Consumes the SDK scope `{ projectRoot, writeRoots }`.

- [ ] **Step 1:** Update the tests: `scoped scope without readRoots writes only under writeRoots` and `reads outside writeRoots inside the instance succeed`.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/device-docker/test/permission-scopes.test.ts plugins/device-e2b/test/permission-scopes.test.ts` — Expected: FAIL (type error / `readRoots` undefined).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS (Docker-dependent cases skip without Docker, as today).
- [ ] **Step 5: Commit** `feat(device-docker,device-e2b): operation scope without read roots`, Co-Authored-By line.

### Task 17: `device-local` hello, owner report and report (plugins) [review alone, most capable model]

**Files (plugins repo):**
- Create: `plugins/device-local/migrations/0001_init.sql` (schema `plugin_device_local`: `connections(device_id text primary key, org_id text not null, connection_id text, mode text not null check (mode in ('os','docker')), roots jsonb not null, home text, session_isolation text, features text[] not null, permission_support jsonb not null, owner_report jsonb not null, runtime_identity jsonb, revision text not null, updated_at timestamptz not null)`, `bindings(device_id text primary key, generation text not null, status text not null check (status in ('awaiting-device','installed')), installed_connection_id text, identity jsonb, updated_at timestamptz not null)`), `src/store.ts` (`DeviceLocalStore` over `ctx.db`), `src/hello.ts` (`DialInHandler`), `src/owner-report.ts` (port of core `owner-report.ts` + `owner-reports.ts`: `decideOwnerReport`, `ownerFactsOf`, stale / conflict / revoked outcomes), `src/report.ts` (`report()` and `permissionSupport()`)
- Modify: `plugins/device-local/src/index.ts` (wire `dialIn`, `report`, `permissionSupport`)
- Test: `test/hello.test.ts`, `test/owner-report.test.ts` (ported core `owner-report.test.ts`, `owner-reach.test.ts` cases that are about the report), `test/kernel.test.ts` (`startTestKernel` with the plugin loaded from source and a `FakeDialInMachine` speaking `capybara-device/5`)

**Interfaces:**
- Consumes: T15 provider; SDK `parseDeviceFrame` (hello body, `policy` event body), `parseOwnerCeilingReport`, `parseSandboxPermissionSupport`.
- Produces: `onHello(deviceId, body)`: strict parse (refuse `local.invalid_hello`), runtime identity check against the stored binding (refuse `local.identity_mismatch`), store, `ctx.devices.reportChanged(deviceId)` when the computed revision changed; `onFrame` for the machine's `policy` event (owner ceiling changed on the machine): same validation and `reportChanged`; `report()`: `revision = sha256(owner_report.revision, connection_id, bindings.generation)`, `description` from the owner ceiling (en + zh, e.g. "Reads the whole machine except secrets; writes only in the project; runs outside the sandbox only per approved call"), `home` (os mode), `limits` from the owner narrowing (allowed domains count, project reach), `reset: false`; `permissionSupport()`: `boundary: "instance"` in docker mode, else `"operation"`; `outsideSandbox` from the owner ceiling; `network.perOperationHosts: true`; `networkAllowlist: true`.
- [ ] **Step 1: Write the failing tests**: `a hello with a stale owner ceiling sequence is refused and nothing is stored`; `a hello whose runtime identity differs from the installed binding is refused with local.identity_mismatch`; `an owner policy event that turns outside-sandbox off changes the revision and calls reportChanged once`; `the same hello twice does not call reportChanged the second time`; `report describes outside-sandbox off in en and zh`; kernel test `a device signed in with capybara-device/5 reads online and its report revision reaches devices.report_revision`; `a sibling org cannot see the connection row` (`plugin_device_local.connections` read through ctx for another org returns nothing).
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/device-local/test` — Expected: FAIL.
- [ ] **Step 3: Implement**; every ctx.kv write (if any) has a TTL; no in-process maps across requests.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(device-local): hello validation, owner report and device report`, Co-Authored-By line.

### Task 18: `device-local` guide and e2e with the published `capybara-device` (plugins)

**Files (plugins repo):**
- Create: `plugins/device-local/guides/connect.md` and `connect.zh.md` (today's `LocalSteps` and `apps/web/src/lib/device-sign-in.ts` commands as markdown: `npm install -g @capybara-hq/device@next`, `capybara-device login --url {{publicUrl}}`, `capybara-device start` / `capybara-device service install`; first line `::shell-action connect-this-machine Connect this machine` (zh `连接本机`); OS mode has no CPU / memory limits (spec §8)), `plugins/device-local/test/e2e.test.ts`
- Modify: `plugins/device-local/package.json` (devDependency `@capybara-hq/device` at the exact released version)

**Interfaces:** Consumes the released `@capybara-hq/device` (T6) and T15/T17.

- [ ] **Step 1: Write the failing tests**: `guide parses for place device-connection with the shell action and publicUrl` (SDK `parseGuideMarkdown`); e2e (`describe.skipIf(!process.env.CAPYBARA_TEST_DEVICE_LOCAL_E2E)`): starts a test kernel with the plugin, runs the published `capybara-device login --url <kernel>` under a temporary `XDG_CONFIG_HOME` and `HOME` (never the real ones), confirms the code over HTTP, runs `capybara-device start`, then `Bash` `echo hi` through a conversation on model-fake → output `hi`; deleting the device makes the program exit with the revoked message.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/device-local/test/e2e.test.ts plugins/device-local/test/guide.test.ts` with `CAPYBARA_TEST_DEVICE_LOCAL_E2E=1` — Expected: FAIL.
- [ ] **Step 3: Implement** the guide and the e2e harness (wait on the program's stdout lines and HTTP state, no fixed sleeps; kill the program in `afterAll`).
- [ ] **Step 4: Run** the same — Expected: PASS; `pnpm exec capybara-plugin check plugins/device-local` PASS.
- [ ] **Step 5: Commit** `feat(device-local): connection guide and end-to-end test`, Co-Authored-By line. Open the plugins PR; after merge release `@capybara-hq/plugin-device-local`.

### Task 19: pin `device-local` in `bootstrap.json` with `scope: "all"`

**Files:** `packages/kernel/bootstrap.json` (marketplace commit bumped; entry `{ "name": "device-local", "source": "npm", "npm": "@capybara-hq/plugin-device-local", "version": "<released>", "integrity": "<sha512>", "required": false, "scope": "all" }`), `.changeset/device-local-bootstrap.md` (`@capybara-hq/capybara`, image-only), test `packages/kernel/test/extensions/bootstrap-from-builtin.test.ts` (or `bootstrap.test.ts`) case `device-local preinstall is on in a new org`.

- [ ] **Step 1:** Add the test `the bootstrap manifest pins device-local with scope all` (reads `bootstrap.json`; asserts the entry and `required: false`, no `builtin`).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/extensions/bootstrap.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Pin with `pnpm check:bootstrap --write --network`.
- [ ] **Step 4: Run** the test and `pnpm check:bootstrap --network` — Expected: PASS.
- [ ] **Step 5: Commit** `chore(bootstrap): preinstall device-local in every org`, Co-Authored-By line.

---

## Appendix: kernel importers of `local-devices` (for T4, T13, T14)

`catalog/requests.service.ts`, `devices/device-projects.service.ts`, `devices/devices.module.ts`,
`devices/devices.service.ts`, `http/api.module.ts`, `http/gateway-routes.ts`,
`infra/outbox/registry.ts`, `kernel.module.ts`, `overrides.ts`, `roles/gateway-role.ts`,
`roles/gateway.module.ts`, `runtime/maintenance.ts`, `runtime/project/knowledge.ts`,
`sandbox/operation-authority.module.ts`, `sandbox/operation-authority.ts`,
`sandbox/operation-reconcile.job.ts`, `sandbox/permission-ceiling-writes.ts`,
`sandbox/permission-facts.ts`, `schedules/fire.ts`, `schedules/grant-rules.ts`,
`schedules/scheduled-tasks.service.ts`, `schedules/schedules.module.ts`,
`tools/builtins/sandbox/bash.ts`, `tools/builtins/sandbox/common.ts`,
`tools/device-op-resolver.ts`, `tools/network-asks.ts`, `tools/pipeline.ts`, `tools/tools.module.ts`
(all under `packages/kernel/src`).

## Index issues

1. **Policy ops.** The brief and spec §5 move `device-policy.service.ts` / `policy-op-jobs.ts` to
   `device-local`. Those ops exist so the web can narrow the machine's network policy; with the
   network list a kernel setting for every device (spec §6.3) they have no remaining caller. This
   plan deletes them (kernel service, `DeviceOpResolver`, outbox entry, the `policy` request op in
   protocol 5, `POST /orgs/:orgId/devices/:id/policy`) and keeps only the machine-to-kernel `policy`
   **event** (the owner changed the ceiling on the machine), which `device-local` validates and turns
   into `reportChanged`. If the maintainer wants kernel-to-machine narrowing kept, T15 gains a port
   of `device-policy.service.ts` on `ctx.dialIn.request`.
2. **Network boundary between phases 2 and 3.** Removing the owner report forces phase 2 to read
   `devices.network_mode` / `network_hosts` for every device (T12) and to drop
   `device.ceiling_on_machine` (T13). Phase 3 keeps the page, the asks' "this run" / "add to list"
   choice and the platform tool texts.
3. **Extra SDK name.** `DeviceRequestNotSentError` / `isDeviceRequestNotSent` move from the kernel to
   the SDK (T1): the kernel's recovery (`operation-reconcile.job.ts`, `bash.ts`) must recognize the
   error after it passes through `device-local`. The index lists only `DeviceOfflineError`.
4. **Envelope types.** The index does not name the kernel-owned frame envelope; this plan adds
   `DialInMachineFrame`, `DialInKernelFrame`, `DIAL_IN_PROTOCOL_RE`, `parseDialInMachineFrame` to
   the SDK root (T1) so a third-party agent program can speak the channel, and
   `DEVICE_DIAL_IN_PROTOCOL` to the subpath (T2).
5. **Extra dropped data.** Besides the index's column list, T14 drops `device_machines.session_isolation`,
   the tables `device_instance_bindings` and `device_machine_boots`, and `devices.source` (its
   readers are the `source === "local"` branches this phase removes). `boot_id` stays, as the spec
   lists it generic, though no kernel reader remains after the boot machinery goes.
6. **Operation scope and `::shell-action` ownership.** The index lists the `{ projectRoot,
   writeRoots }` scope and the directive without a phase; this plan takes both (T12, T2) because the
   brief puts "scope without read roots" and the guide's shell action here. Phase 1 must not also
   change them; phase 3 renders the directive.
7. **`DeviceView.source`.** Replaced by `dialIn: boolean` + `provider` in phase 2 (T13), with the web
   readers adjusted minimally (T11); phase 3 rewrites the device page.
