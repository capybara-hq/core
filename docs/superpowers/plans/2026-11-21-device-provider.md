# Device Providers Implementation Plan (index)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task, layered with
> the `wave-planned-subagent-development` skill (AGENTS.md "How work is done"). Steps use checkbox
> (`- [ ]`) syntax for tracking. This file is the index: the shared interfaces, constraints, waves
> and release order. The tasks are in the five phase plans it links.

**Goal:** One `device-provider@1` extension point with coexisting implementers (`device-docker`,
`device-e2b`, `device-local`), a generic kernel dial-in channel, one device page for every
provider, and many connections per machine in the local provider.

**Architecture:** The SDK renames `sandbox@2` to `device-provider@1` (`multi`), adds a device
report and a dial-in channel. The kernel resolves each device's own provider, keeps approvals,
command review, network setting, project roots and the dial-in channel (sign-in, credentials,
lease, relay), and loses every `local` / `cloud` branch. The local device semantics move to the
`device-local` plugin (capybara-hq/plugins); `capybara-device` (core `packages/device`) gains
per-connection state and services; the desktop (capybara-hq/clients) speaks `device@2`.

**Tech Stack:** TypeScript, NestJS + Fastify kernel, Kysely/PG, Redis (Valkey), BullMQ, Next.js
web with TanStack Query and `@capybara-hq/design`, Electron, vitest.

**Spec:** `docs/superpowers/specs/2026-11-21-device-provider-design.md` (the spec wins over this
plan; executors read both).

## Phase plans

| Phase | Plan | Repos | Depends on |
|---|---|---|---|
| 1 | [Extension point and multi-provider kernel](2026-11-21-device-provider-p1-extension-point.md) | core, plugins (`device-docker`, `device-e2b`) | — |
| 2 | [Dial-in channel, report-driven authority, `device-local`](2026-11-21-device-provider-p2-dial-in.md) | core, plugins (`device-local`) | 1 |
| 3 | [Network setting, device page, 新建设备 with guides](2026-11-21-device-provider-p3-web.md) | core | 2 |
| 4 | [Local read model and per-connection project reach](2026-11-21-device-provider-p4-local-reads.md) | core (`packages/device`), plugins (`device-local`) | 2 |
| 5 | [Many connections per machine, `device@2`, desktop](2026-11-21-device-provider-p5-connections.md) | core (`packages/device`, SDK, web), clients | 2 (4 may run alongside) |

Phases 3, 4 and 5 run in parallel once phase 2 is merged; 4 and 5 both touch `packages/device`:
4 owns `exec/` and `policy*`, 5 owns `state.ts`, `cli.ts`, `args.ts`, `commands/`, `service/`,
`control/`, `pid.ts`. A file both need is changed by 5 first. Phase 4 also owns `server-ops.ts` and `owner-report.ts`.

## Global Constraints

- No compatibility of any kind (maintainer, 2026-11-21): no migration renaming rows, catalog
  items or config; no aliases for `sandbox@2`, `sandbox-docker`, `sandbox-e2b`, `@local`; no
  reading of the old flat device state layout; protocol bumps refuse the old version.
- Applied migrations stay immutable; new kernel migrations are plain SQL `NNNN_<snake_desc>.sql`
  with `IF [NOT] EXISTS` in schema `capybara`; `device-local`'s own tables in `plugin_device_local`.
- Extension point name `device-provider@1`, cardinality `multi`, `brokered: true`,
  `orgScoped: true`. The shell capability is `device@2` (never confused with the point).
- Plugin names `device-docker`, `device-e2b`, `device-local`; npm
  `@capybara-hq/plugin-device-docker`, `@capybara-hq/plugin-device-e2b`,
  `@capybara-hq/plugin-device-local`.
- Setup-guide place `device-connection`; directive `::shell-action connect-this-machine <label>`.
- Platform setting `devices.defaultProvider` (string plugin name or empty), org may override among
  providers on in it.
- Device program state: `$XDG_CONFIG_HOME/capybara-device/machine.json` and
  `connections/<deviceId>/` (0700); launchd label `top.capybara.device.<deviceId>`, systemd unit
  `capybara-device@<deviceId>.service`; CLI selector `--connection` / `-c`.
- Project reach values (local, per connection): `machine` (default) | `paths` | `workspace`;
  list key `projectPaths`.
- Network modes stay `open` and `allowlist`; address classes closed in both.
- Multi-replica rules of AGENTS.md hold (no in-process state across requests, queues for delayed
  work, outbox for owed work, locks never inside a transaction); long connections only on the
  gateway role.
- English code, comments, docs, commit messages; UI copy through i18n zh + en, zh says 平台 /
  设备 / 本机 / 智能体, never 企业 or `agent`.
- SDK public API changes: `pnpm gen:sdk-api` + a changeset bumping `@capybara-hq/plugin-sdk`;
  `packages/device` changes: a changeset on `@capybara-hq/device`; image-only changes: a changeset
  on `@capybara-hq/capybara`.
- Plugins repo: bumping the SDK needs the pnpm override so only one `plugin-sdk` instance exists.
- Clients repo depends on published core packages at exact versions only.
- Core tests load no official plugin except `model-fake`; kernel tests use fixtures in
  `packages/testing/fixtures/extensions/*`. New unit / container tests join their checked-in lists.
- Never touch this Mac's real `~/.config/capybara-device` (it serves prod): device program tests
  and manual runs use a temporary `XDG_CONFIG_HOME` and `HOME`.
- Merges are done by the maintainer's main session: report repo, PR number, head sha and merge
  order when green; never merge, never force-push.

## Shared interfaces

These names are fixed for every phase. Phase plans refer here instead of redefining them.

### SDK (`packages/plugin-sdk`)

`src/sandbox.ts` → `src/device-provider.ts`, `src/sandbox-operation.ts` →
`src/device-operation.ts`. Types keep their member shapes and are renamed `Sandbox*` → `Device*`
only where listed; the rest keep their names (`SandboxHandle`, `SandboxLimits`, `SandboxExec*`,
`SandboxOperation*`, `SandboxPermissionSupport`, errors) to keep the diff reviewable.

```ts
export const DEVICE_PROVIDER_EXTENSION_POINT = "device-provider@1";

/** Today's SandboxProvider, renamed, plus report and dialIn. */
export interface DeviceProvider {
  /* every member of today's SandboxProvider, unchanged */
  report(device: DeviceRef, signal: AbortSignal): Promise<DeviceReport>;
  readonly dialIn?: DialInHandler;
}

export interface DeviceRef { deviceId: string; orgId: string; handle: SandboxHandle | null }

export interface DeviceReport {
  /** Opaque; changes whenever any field below or the provider's enforcement changes. */
  revision: string;
  /** One line for the device page; `en` required, `zh` optional. */
  description: { en: string; zh?: string };
  /** Base for the project picker; null = the workspace. */
  home: string | null;
  /** Limits applied on top (provider or machine owner), shown read only. */
  limits: Array<{ label: { en: string; zh?: string }; value: string }>;
  /** Whether 重建文件 exists for this device. */
  reset: boolean;
}
```

Capability facts the spec lists under the report (`outsideSandbox`, `network.allowlist`,
`openPublic`, `perOperationHosts`) stay in the existing `SandboxPermissionSupport` returned by
`permissionSupport`; `report` does not duplicate them. `device-provider@1` requires
`permissionSupport().network.allowlist === true` (checked at load through a probe-free static
declaration `readonly networkAllowlist: true` on the provider).

Operation scope: `SandboxOperationScope.filesystem` `scoped{readRoots, writeRoots}` becomes
`scoped{ projectRoot: string | null; writeRoots: string[] }`; read roots are gone.

Project refusal: a provider's `list(path)` may throw `ProjectPathRefusedError(reason: { en: string;
zh?: string })` (new, exported); the kernel maps it to `device.project_refused` (422).

```ts
/** Manifest: permissions.dialIn = { protocol: "<name>/<major>" }. */
export interface DialInHandler {
  /** Called on the gateway replica holding the socket, after the kernel authenticated it. */
  onHello(deviceId: string, hello: unknown, signal: AbortSignal):
    Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /** Unsolicited frames from the machine (not responses to requests). */
  onFrame?(deviceId: string, frame: unknown): Promise<void>;
  onClose?(deviceId: string, reason: "offline" | "replaced" | "revoked" | "deleted"): void;
}

/** On ctx as ctx.dialIn when permissions.dialIn is declared. */
export interface DialInChannel {
  request(deviceId: string, frame: unknown, opts: { timeoutMs: number; signal?: AbortSignal }):
    Promise<unknown>; // throws DeviceOfflineError (new, exported) when no holder within grace
  online(deviceId: string): Promise<boolean>;
  stop(deviceId: string, reason: "drain" | "stop"): Promise<void>;
}

/** On ctx for every device provider. */
export interface DevicesCtx { reportChanged(deviceId: string): Promise<void> }
```

`src/device-protocol.ts` (protocol frames) moves to the subpath export
`@capybara-hq/plugin-sdk/device-protocol`, bumps `DEVICE_PROTOCOL_VERSION` to 5 in phase 2, and is
no longer re-exported from the package root.

Setup guide: `SETUP_GUIDE_PLACES` gains `"device-connection"` with audience `member`, variables
`publicUrl`, `orgId`, `orgName`, `pluginName`, checks allowed, no drift; the parser accepts
`::shell-action <action> <label>` with `action` in `["connect-this-machine"]`.

Shell (phase 5): `DeviceCapabilityV2` replaces `DeviceCapabilityV1` (spec §9):

```ts
export interface ThisMachineConnection {
  deviceId: string; orgId: string; mode: "os" | "docker";
  connection: "starting" | "online" | "offline" | "draining" | "stopped";
  offlineReason?: string; serviceInstalled: boolean;
  keepAwake: { mode: "off" | "while-busy" | "connected"; held: boolean; unavailable?: string };
  lastWakeAt?: string;
}
export interface DeviceCapabilityV2 {
  status(): Promise<{ connections: ThisMachineConnection[] }>;
  onStatus(cb: () => void): () => void;
  running(a: { deviceId: string }): Promise<DeviceRunningOp[]>;
  connect(a: { orgId: string }): Promise<"connected" | "cancelled" | { error: string }>;
  pause(a: { deviceId: string }): Promise<void>;
  resume(a: { deviceId: string }): Promise<"resumed" | "cancelled">;
  disconnect(a: { deviceId: string }): Promise<void>;
  requestCeiling(a: { deviceId: string } & DeviceCeilingRequest): Promise<"applied" | "cancelled">;
  setKeepAwake(a: { deviceId: string; mode: "off" | "while-busy" | "connected" }):
    Promise<"applied" | "cancelled">;
}
```

### Kernel (`packages/kernel`)

- `src/sandbox/providers.ts` → `DeviceProviders` (`@Injectable`, a pure registry):
  `forDevice(provider: string): DeviceProviderEntry | undefined`, `loaded()`, `register(entry)`.
  `src/devices/device-provider-selection.ts` → `DeviceProviderSelection` (`@Injectable`, own
  module; ruling during phase 1 execution, avoids a module cycle):
  `onInOrg(orgId: string): Promise<DeviceProviderEntry[]>`, `isOnInOrg(orgId, plugin)`,
  `defaultFor(orgId: string): Promise<DeviceProviderEntry | undefined>`;
  `DeviceProviderEntry = { plugin: string; version: string; impl: DeviceProvider }`.
  `cloud()`, `providerForDevice`, `LOCAL_PROVIDER`, `isInternalProvider` are deleted.
- `src/dial-in/` (phase 2): `DialInModule` with `DialInAuthService` (from `device-auth.ts`),
  `DialInMachines` (from `machines.ts`), `DialInGateway` (from `local-device-gateway.ts`),
  `DialInRelay` (from `relay.ts`), routes `GET /device/connect` and `api/v1/device/*`.
  `createLocal` becomes `DevicesService.createDialIn(orgId, accountId, provider, name)`.
- Device authority epoch bumps on `ctx.devices.reportChanged` for every provider (phase 2).
- Removed route: `DELETE /orgs/:orgId/devices/:id/machine` (phase 3).

### Data

- `devices.provider` holds a plugin name for every device (no `@` names).
- `device_machines` keeps generic columns; `features`, `local_policy`, `owner_report`,
  `pending_policy_ops`, `home`, `roots`, `mode` are dropped by a phase 2 migration (no
  expand-then-contract needed: nothing released). `device-local` keeps what it needs in
  `plugin_device_local`.

## Review Focus

- A sandboxed command of connection A reading connection B's working directory or state on the
  same machine must fail, also with project reach `machine` and with a project directory that is a
  symlink into B (phase 4, owner ceiling and per-OS read tasks; phase 4 also owns
  `server-ops.ts` and `owner-report.ts` in `packages/device`).
- A provider switched off for an org (or uninstalled) while its devices are bound to conversations:
  tools answer an actionable "device provider is off" error, the device page shows it unavailable,
  files are kept, nothing is demoted or recreated (phase 1).
- A report revision changing between an approval being asked and being granted must invalidate
  the approval, for docker as well as local (phase 2).
- `login` into a device this machine already serves through another connection must be refused
  locally; from another machine it replaces the first (phase 5).
- A page in the desktop must never learn connections to other deployments, and `device@2` calls
  naming a device of another deployment must refuse (phase 5).

## Ownership rulings (after the phase plans; these win over any phase plan text)

Each phase plan starts with a "Reconciliation" block applying the rulings that touch it.

- **R1 Operation scope** `{ projectRoot, writeRoots }` (SDK, kernel intersect, device program,
  conformance suite, fixtures): phase 1 Task 4. Phase 2 Task 12 does not touch the scope; it
  additionally removes read expansions (`PermissionExpansion.readDirectories` and their review,
  event and replay paths), since reads are the provider's rule. Between phase 1 and phase 4 an
  approved read outside the project on a local device is refused by the machine: accepted (main
  only; no `@capybara-hq/device` release in between).
- **R2 Protocol version**: phase 1 Task 4 sets `DEVICE_PROTOCOL_VERSION = 5`. Phase 2 changes
  protocol 5 in place (envelope, `DEVICE_DIAL_IN_PROTOCOL = "capybara-device/5"`) and bumps
  nothing. The first `@capybara-hq/device` release speaking 5 is at the end of phase 2. After it,
  whichever of phases 4 and 5 changes the protocol first bumps to 6; the other changes 6 in place
  if it lands before the next device release.
- **R3 Guide place** `device-connection` and `::shell-action` parsing: phase 1 Task 2. Phase 2
  Task 2 keeps only the subpath move; phase 3 Task 1 keeps only what is not on main.
- **R4 Project refusals**: `ProjectPathRefusedError` and its kernel mapping are phase 1 (Tasks 3,
  10); the error code is `device.project_refused` (422) everywhere. Phase 3 Task 7 owns the hidden
  count, `mode` and `withinMode` removal in `device-projects.service.ts` / `project-rules.ts`.
- **R5 Stored report**: phase 1 Task 9 (`devices.report jsonb`, `report_at`; migration
  `0174_device_report.sql`) owns storage. Phase 2 Task 9 adds no migration: it extends phase 1's
  `DeviceReports` with `changed` and compare-and-sets on `devices.report->>'revision'`. Migration
  numbers are taken at execution time (the next free number); the numbers in phase plans are
  placeholders.
- **R6 Network device layer** read from `devices.network_mode` / `network_hosts` for every device
  (`permission-facts.ts`, `device-sandbox.ts`): phase 2 Task 12. Phase 3 Task 3 does only what is
  left (fail-closed `providerLayerOf(null)`, `owner` parameter removal, `deviceListAddRefusal`).
- **R7 Policy ops** (kernel → machine `policy` request, `device-policy.service.ts`, its resolver
  and outbox entry, `POST /orgs/:orgId/devices/:id/policy`): deleted by phase 2 (Tasks 6, 14), not
  moved to `device-local` (spec §5 amended). Phase 3 Task 4 skips them.
- **R8 Project reach in the kernel** (`restrictedProjectReach`, `projectReachOf`, reach in
  `permission-facts.ts` / `modes.ts`): phase 2 Task 12. The device side is phase 4.
- **R9 docker / e2b scope and rename**: phase 1 Tasks 14, 15. Phase 2 Task 16 is dropped.
- **R10 Deny other connections and the risk text**: phase 4 Tasks 6 and 11. Phase 5 Task 5 is
  dropped; phase 5 Task 9 only adds `-c` to `ceiling`.
- **R11 Control socket path** (avoids the 103-byte limit): `$XDG_CONFIG_HOME/capybara-device/run/<first 16 hex
  of sha256(deviceId)>.sock`, `run/` mode 0700; the pid file stays in `connections/<deviceId>/`.
  `status --json` gives each connection's `controlSocket`; the desktop reads socket paths from it,
  never by globbing. Phase 5 Tasks 1, 12.
- **R12** `machine.json` is `{ "version": 1 }` only (no `defaultConnection`; with several
  connections and no `-c`, commands refuse). Spec §7.2 amended.
- **R13** Web: `useThisMachineDeviceIds(orgId): ReadonlySet<string>` replaces
  `useThisMachineDeviceId` (two connections into one org are possible).
- **R14** `DeviceRunningOp` is today's `RunningOperationView`, renamed (phase 5 Task 3).
- **R15** Phase 3 Task 10 wires the shell-action button to the shell's current `device@1.connect`;
  phase 5 Task 6 switches it to `device@2`.
- **R16** The kernel test fixtures live in `packages/kernel/test/fixtures/plugins/` (`device-fake`,
  `device-fake-b`, `fake-dial-in`), not in `packages/testing`; reusable helpers (machine
  simulators) live in `packages/testing/src`.
- **R17** `device-local` file names are the ones phase 2 Tasks 15 and 17 create; phases 4 and 5
  adapt their paths to them.

## Release order

1. Core PR P1 (SDK `device-provider@1`) → SDK release → plugins PR (`device-docker`, `device-e2b`
   with the SDK override) → release → core bootstrap pins (same core PR train).
2. Core PR P2 (dial-in channel, protocol 5 subpath) → SDK + device release → plugins PR
   `device-local` → release → core pin `device-local` in `bootstrap.json` with `scope: "all"`.
3. P3, P4, P5 PRs in any order; P5's clients PR after the SDK release carrying `DeviceCapabilityV2`
   and the `@capybara-hq/device` release with connections.

Each PR goes to the maintainer as "repo, PR number, head sha, merge order".
