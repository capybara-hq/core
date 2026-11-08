# Environments Phase 2 (Connected Personal Environments) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository, run it through the `wave-planned-subagent-development` skill.

**Goal:** A person connects their own machine with `capybara-device login` and picks it as an environment; agents' sandbox tools run on that machine (OS sandbox or Docker), with real paths, through the gateway.

**Architecture:** The kernel gets a built-in sandbox provider `@device` that implements `sandbox@2` by relaying operations through Redis to the gateway replica holding the machine's WebSocket. A device authorization flow (RFC 8628 shape) issues a per-machine credential. A new published package `@capybara-hq/device` connects out, serves the operations through `@anthropic-ai/sandbox-runtime` or Docker, and enforces a local policy. Sandbox tools build paths from the instance's roots.

**Tech Stack:** TypeScript, NestJS + Fastify kernel, `@fastify/websocket`, ioredis, Kysely/PostgreSQL, Next web app with `@capybara-hq/design`, Node `ws`, `@anthropic-ai/sandbox-runtime` 0.0.81.

**Spec:** `docs/superpowers/specs/2026-11-07-environments-design.md`, §6 and §13 (phase 2 design), §14 (projects as a plugin, context only).

## Global Constraints

- English for code, comments, docs, commit messages; UI text through i18n zh + en; zh UI says 平台 / 超级管理员 / 智能体, never 企业 or `agent` (`pnpm check:i18n`).
- Multi-replica discipline (AGENTS.md): no in-process shared state across requests; every Redis key has a TTL; bus publishes / Redis calls in `afterCommit`; locks via `LockService`, never inside a transaction; long connections only on the `gateway` role.
- Migrations: plain SQL `0093_<desc>.sql`, `IF [NOT] EXISTS`, kernel schema `capybara` (writing-migrations skill). Applied migrations stay immutable.
- Kernel: `@Injectable` providers, explicit `@Inject`, DTOs via `createZodDto`, config through `KernelConfigService` (`pnpm check:kernel-conventions`).
- Every new HTTP route gets a Platform operation or an exclusion with a reason (`pnpm check:platform-ops`); new public routes go into `packages/kernel/test/identity/public-routes.test.ts`.
- SDK public API change → `pnpm gen:sdk-api` + changeset bumping `@capybara-hq/plugin-sdk`.
- Web: pages = template + design components; reads `defineQuery`, writes `useAppMutation`; thin `page.tsx` + client `view.tsx`; no styles in apps/web (`pnpm check:web-ui`).
- Model-visible changes follow the replay-evals skill: run the zero-drift fixture tests (`reconstruct.test.ts`, `rename-compat.test.ts`) before and after Task 7.
- Values pinned by the spec: provider name `@device`; credential prefix `cap_dev_`, device code prefix `cap_dvc_`; user code 8 chars from `BCDFGHJKLMNPQRSTVWXZ` shown `XXXX-XXXX`; poll `interval` 5 s, `slow_down` adds 5 s; code TTL 600 s; WebSocket path `/device/connect`; header `X-Capybara-Device-Protocol: 1`; ping 20 s; `environments.device.reconnectGraceSeconds` default 120; lease key `capk:device-lease:<environmentId>`; request list `capk:device-req:<environmentId>`; result key `capk:device-res:<requestId>`; Node ≥ 22.12 for `packages/device`; `@anthropic-ai/sandbox-runtime` exact `0.0.81`.
- Before 0.1.0: no compatibility layers.
- Commits: Conventional Commits, body lines ≤ 100 chars; changesets for published packages (`@capybara-hq/plugin-sdk`, `@capybara-hq/kernel`, new `@capybara-hq/device`, `@capybara-hq/capybara` for image-affecting changes).

## Review Focus

1. **A machine that drops mid-command and comes back within the grace** must deliver the result to the waiting tool call, and one that comes back after the grace must get the command killed; a person expects neither a hung tool call nor an orphaned process. → Task 4 test "result produced during a disconnect is delivered after reconnect" and Task 10 test "late reconnect receives the cancel".
2. **Two connections for one environment** (the old socket not yet noticed dead, a second laptop logging into the same environment) must end with exactly one holder, the newest. → Task 6 dual-replica test "newest connection wins across gateway replicas".
3. **A revoked machine or a deleted environment** must stop being usable at once: the socket closes, queued requests fail `environment.forbidden` / `environment.not_found`, the credential no longer connects. → Task 5 test "revoking closes the socket and refuses reconnects" (with Task 6).
4. **The cloud never loosens the local policy**: an org with `egress: "open"` and a policy allowing two domains yields exactly those two domains; a write outside the environment directory is refused with `policy`, never prompted. → Task 11 tests "egress is the intersection" and "write outside the root is refused".
5. **A machine whose directory was deleted by hand** must surface as 文件已丢失 (`environment.files_lost`), not as an empty workspace recreated silently. → Task 10 test "a vanished root answers fs_gone".

---

## File Structure

**SDK (`packages/plugin-sdk/src`)**
- Modify `sandbox.ts`: `SandboxRoots`, optional `SandboxHandle.roots`.
- Create `device-protocol.ts`: protocol v1 frame types, `DEVICE_PROTOCOL_VERSION`, `parseDeviceFrame`, `DeviceOp` arg/result types. Export from `index.ts`.

**Kernel (`packages/kernel/src`)**
- `migrations/0093_connected_environments.sql`; `db/kernel-schema.ts`.
- `config/schema.ts`: `environments.device.*`.
- `errors.ts`: `environment.offline`, `environment.program_outdated`, `device.*`.
- `sandbox/providers.ts`, `sandbox/sandbox.service.ts`, `sandbox/jobs.ts`: per-environment provider resolution.
- `environments/*`: source `device`, views (`online`, `machine`), access.
- New `devices/` module:
  - `devices.module.ts`
  - `machines.ts` (MachinesService: rows, credential hash, revoke)
  - `device-auth.ts` + `device-auth.controller.ts` + `dto.ts` (authorization flow)
  - `relay.ts` (DeviceRelay: caller side)
  - `device-provider.ts` (DeviceSandboxProvider implements SandboxProvider)
  - `device-gateway.ts` (DeviceGateway: socket holder, lease, drain; gateway role only)
  - `device-routes.ts` (raw Fastify WebSocket route registered through `registerGatewayRoutes`)
- `tools/builtins/sandbox/*`, `tools/builtins/skill-load.ts`, `background/launch.ts`, `runtime/subagents/definition.ts`: roots instead of constants; `environment_paths` event.
- `platform/exclusions.ts`, `platform/ops/environments.ops.ts`.

**Web (`apps/web`)**
- `src/app/(auth)/device/{layout,page,view}.tsx`; `src/lib/devices.ts`; `src/lib/query/devices.ts`.
- `src/app/(app)/environments/view.tsx`, `[id]/view.tsx`, `src/components/EnvironmentCreateDialog.tsx`, `src/lib/environments.ts`, `src/components/conversation/useSelection.ts`; `src/lib/query/routes.ts`; `messages/{zh,en}.json`.

**Program (`packages/device`, new)**
- `package.json`, `tsconfig.json`, `bin/capybara-device.mjs`, `README.md`, `NOTICE`.
- `src/cli.ts`, `src/args.ts`, `src/state.ts`, `src/api.ts`, `src/commands/{login,logout,status,start,stop,drain,policy,service}.ts`.
- `src/client.ts` (connection, reconnect, frames), `src/server-ops.ts` (op dispatch, tags, result buffer).
- `src/policy.ts`, `src/exec/types.ts`, `src/exec/os.ts`, `src/exec/docker.ts`, `src/service/{launchd,systemd}.ts`.

**Checks and docs**
- `tools/checks`: dependency rule for `packages/device`; `tsconfig.json` references; `docs/architecture.md`, `AGENTS.md`, `.agents/skills/writing-sandbox-providers/SKILL.md`, `docs/deploy/README.md`.

---

### Task 1: SDK — instance roots and device protocol v1

**Files:**
- Modify: `packages/plugin-sdk/src/sandbox.ts`, `packages/plugin-sdk/src/index.ts`
- Create: `packages/plugin-sdk/src/device-protocol.ts`
- Test: `packages/plugin-sdk/test/device-protocol.test.ts`
- Generated: `packages/plugin-sdk/api/*` via `pnpm gen:sdk-api`; changeset (minor in pre mode) on `@capybara-hq/plugin-sdk`

**Interfaces:**
- Produces:
  - `interface SandboxRoots { workspace: string; skills: string; tmp: string }`; `SandboxHandle { id: string; roots?: SandboxRoots }`; `const DEFAULT_SANDBOX_ROOTS: SandboxRoots = { workspace: "/workspace", skills: "/skills", tmp: "/tmp" }`; `rootsOf(h: SandboxHandle): SandboxRoots`.
  - `DEVICE_PROTOCOL_VERSION = 1`; `type DeviceOp = "create" | "exec" | "readFile" | "writeFile" | "stat" | "killTagged" | "killAll" | "stop"`.
  - Frames: `DeviceHello { type: "hello"; protocol: number; programVersion: string; os: "darwin" | "linux"; arch: string; mode: "os" | "docker"; roots: SandboxRoots; sessionIsolation: boolean }`; `DeviceRes { type: "res"; id: string; ok: true; result: unknown } | { type: "res"; id: string; ok: false; error: { kind: "gone" | "fs_gone" | "policy" | "error"; message: string } }`; `KernelReq { type: "req"; id: string; op: DeviceOp; args: unknown; deadlineMs: number }`; `KernelCancel { type: "cancel"; id: string }`.
  - Op args/results: `exec` args `{ command: string; cwd?: string; env?: Record<string,string>; timeoutMs: number; maxOutputBytes: number; tag: string; actor: SandboxActor; limits: SandboxLimits }`, result `ExecResult`; `readFile` `{ path; maxBytes }` → `{ dataB64: string; truncated: boolean } | null`; `writeFile` `{ path; dataB64 }` → `null`; `stat` `{ path }` → `{ size; isDir } | null`; `killTagged` `{ tags: string[] }`; `killAll` `{}`; `create` `{ limits: SandboxLimits }` → `{ roots: SandboxRoots }`; `stop` `{ reason: "revoked" | "deleted" }`.
  - `parseDeviceFrame(raw: string, from: "device" | "kernel"): DeviceFrame` — throws `DeviceProtocolError` on bad JSON, unknown `type`, missing fields, or a frame of the wrong direction. Hand-written guards (the SDK has no zod).

- [ ] **Step 1: Write the failing tests** in `device-protocol.test.ts`: `parses a hello from the device`; `rejects a req sent by the device` (`from: "device"` with `type: "req"` throws `DeviceProtocolError`); `rejects a res without id`; `rootsOf falls back to DEFAULT_SANDBOX_ROOTS`; `rejects a hello with a relative root` (`roots.workspace: "workspace"` throws).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/device-protocol.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the types and `parseDeviceFrame` / `rootsOf`; export from `index.ts`.
- [ ] **Step 4: Run** the test — PASS; then `pnpm gen:sdk-api`, `pnpm check:sdk-api`.
- [ ] **Step 5: Commit** `feat(plugin-sdk): instance roots and the device protocol v1` with the changeset.

### Task 2: Kernel — schema, config, error codes

**Files:**
- Create: `packages/kernel/src/migrations/0093_connected_environments.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts`, `packages/kernel/src/config/schema.ts`, `packages/kernel/src/errors.ts`, `docs/config.md` (regenerated), `apps/web/messages/{zh,en}.json` (`errors.environment.offline`, `errors.environment.program_outdated`, `errors.device.*`)
- Test: `packages/kernel/test/migrations/0093.test.ts`, `packages/kernel/test/config/environments-device.test.ts`

**Interfaces:**
- Produces:
  - `environments.source` CHECK `IN ('cloud','device')`. Kysely `source: "cloud" | "device"`.
  - Table `capybara.environment_machines`: `id uuid pk default gen_random_uuid()`, `org_id uuid not null references orgs`, `environment_id uuid not null references environments(id)`, `account_id uuid not null`, `credential_hash text not null unique`, `name text not null`, `os text not null`, `arch text not null`, `program_version text`, `mode text check (mode in ('os','docker'))`, `roots jsonb`, `session_isolation boolean not null default false`, `last_seen_at timestamptz`, `created_at timestamptz not null default now()`, `revoked_at timestamptz`; unique partial index `environment_machines_active_uq ON (environment_id) WHERE revoked_at IS NULL`.
  - Config `environments.device`: `reconnectGraceSeconds` (int, default 120, hot), `leaseTtlMs` (default 30000), `authCodeTtlSeconds` (default 600), `pollIntervalSeconds` (default 5), `maxFrameBytes` (default 16 MiB = 16777216). Validation: `leaseTtlMs >= 6000`.
  - Error codes → status: `environment.offline` 503, `environment.program_outdated` 426, `device.authorization_pending` 400, `device.slow_down` 400, `device.expired` 400, `device.denied` 400, `device.code_invalid` 404, `device.credential_invalid` 401.

- [ ] **Step 1: Write the failing tests:** `0093 adds device to environments.source` (insert with `source='device'` succeeds; `'x'` fails); `one active machine per environment` (second active insert violates `environment_machines_active_uq`, a revoked one does not); config test `environments.device defaults` asserting the five defaults and that `leaseTtlMs: 1000` is rejected.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/migrations/0093.test.ts packages/kernel/test/config/environments-device.test.ts` — FAIL.
- [ ] **Step 3: Implement** the migration (alter the CHECK by dropping and re-adding the named constraint with `IF EXISTS`), schema types, config with `meta` descriptions (adding-config skill), error codes, web error messages.
- [ ] **Step 4: Run** the tests, `pnpm gen:config-docs`, `pnpm check:i18n` — PASS.
- [ ] **Step 5: Commit** `feat(kernel): schema, config and error codes for connected environments`.

### Task 3: Kernel — provider per environment (risk: high)

**Files:**
- Modify: `packages/kernel/src/sandbox/providers.ts`, `packages/kernel/src/sandbox/sandbox.service.ts`, `packages/kernel/src/sandbox/jobs.ts`, `packages/kernel/src/environments/environments.service.ts`, `packages/kernel/src/environments/access.ts`, `packages/kernel/src/environments/conversation-environments.ts`, `packages/kernel/src/environments/legacy-cleanup.job.ts`
- Test: `packages/kernel/test/sandbox/providers-per-environment.test.ts`, extend `packages/kernel/test/environments/*.test.ts`

**Interfaces:**
- Consumes: Task 2 schema.
- Produces:
  - `DEVICE_PROVIDER = "@device"` (exported from `sandbox/providers.ts`).
  - `SandboxProviders.register(entry: SandboxProviderEntry): void` (kernel-internal providers; called by `DevicesModule` on init), `SandboxProviders.forName(name: string): SandboxProviderEntry | undefined` (internal providers first, then loaded `sandbox@2` extensions by plugin name; replaces `lookup`), `SandboxProviders.cloud(): SandboxProviderEntry | undefined` (renamed `current`, extensions only).
  - `SandboxService` resolves the entry from `environments.provider` for `withSandbox`, `ifRunning`, `resetFileSystem`, `destroyEnvironment`; `available` becomes `availableFor(envId): Promise<boolean>`; sweeps (`suspendIdle`, `destroyInactive`) iterate cloud only (`@device` never swept).
  - `EnvironmentView` gains `source: "cloud" | "device"`, `online: boolean | null` (null for cloud), `machine: { id; name; os; mode; programVersion; lastSeenAt } | null`; `EnvironmentList.cloudAvailable` unchanged.
  - `EnvironmentsService.createDevice(orgId, accountId, name): Promise<{ id: string }>` (used by Task 5, inside its transaction) with `source='device'`, `provider='@device'`, counted against `environments.maxPersonal`.
  - `EnvironmentAccess.usable` treats `@device` as available when registered; online-ness is the relay's concern (Task 4), not access.

- [ ] **Step 1: Write the failing tests:** `an environment on @device resolves the device provider while the cloud provider is docker` (fake internal provider registered; `withSandbox` calls it, not the cloud fake); `idle sweeps never touch @device environments`; `a device environment stays available when no cloud provider is loaded`; `list shows source, online null for cloud`; existing phase 1 environment tests still pass.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/sandbox packages/kernel/test/environments` — new tests FAIL.
- [ ] **Step 3: Implement.** Keep the `p: SandboxProviderEntry` parameters of `usable`/`ensure`/`create`/`destroyInstance`/`destroyFiles`; replace the `current()` / `require()` call sites with a per-row resolution; `ConversationEnvironments.forTool` / `forNew` stop failing on a missing cloud provider when the bound environment is `@device`.
- [ ] **Step 4: Run** the sandbox, environments, tools and background test folders — PASS.
- [ ] **Step 5: Commit** `refactor(kernel): resolve the sandbox provider per environment`.

### Task 4: Kernel — device relay and the `@device` provider (risk: high)

**Files:**
- Create: `packages/kernel/src/devices/relay.ts`, `packages/kernel/src/devices/device-provider.ts`, `packages/kernel/src/devices/devices.module.ts`
- Modify: `packages/kernel/src/kernel.module.ts` (import `DevicesModule` on every role)
- Test: `packages/kernel/test/devices/relay.test.ts`, `packages/kernel/test/devices/device-provider.test.ts`

**Interfaces:**
- Consumes: Task 1 frame and op types; Task 3 `SandboxProviders.register`, `DEVICE_PROVIDER`; `LockService.holderOf`, `REDIS`, `KERNEL_BUS`.
- Produces:
  - `DeviceRelay.call<T>(environmentId: string, op: DeviceOp, args: unknown, opts: { deadlineMs: number; signal: AbortSignal }): Promise<T>` — throws `environmentOffline()` when `capk:device-lease:<environmentId>` has no holder at send time; throws mapped errors for `res.ok === false` (`gone` → `SandboxGoneError`, `fs_gone` → `FileSystemGoneError`, `policy` → `ToolError`-style message "Refused by the machine's local policy: …", `error` → `Error`); on abort or grace expiry pushes `{type:"cancel", id}` onto the request list and throws (abort reason / `environmentOffline()`).
  - Wire format of a queued item: `KernelReq | KernelCancel` JSON, `RPUSH capk:device-req:<env>` then `PEXPIRE` to `(reconnectGraceSeconds*1000) + deadlineMs`; bus topic `device.req.<env>`.
  - Result: caller subscribes `device.res.<requestId>` first, then `GET capk:device-res:<requestId>`; resolves on either; deadline = `deadlineMs + reconnectGraceSeconds*1000`.
  - `DeviceRelay.holderLive(environmentId): Promise<boolean>`.
  - `DeviceSandboxProvider implements SandboxProvider` (`concurrentExec: true`, `sessionIsolation: false`): `createFileSystem` → `{ id: environmentId }` without a call; `create` → relay `create`, returns `{ id: machineId, roots }`; `resume` → `"resumed"` if `holderLive` else throws `environmentOffline()`; `suspend`/`destroy`/`destroyByName` no-ops; `destroyFileSystem`/`destroyFileSystemByName` → relay `stop {reason:"deleted"}` when live, else no-op; `exec`/`readFile`/`writeFile`/`stat`/`killTagged`/`killAll` → relay with `deadlineMs = timeoutMs + 5000` for exec, 30000 for the others. Bytes as base64.

- [ ] **Step 1: Write the failing tests** (real Redis via `@capybara-hq/testing`, a test holder that reads the list and answers): `offline when no holder`; `exec round-trip returns the ExecResult`; `result produced during a disconnect is delivered after reconnect` (holder answers after releasing and re-taking the lease 2 s later, grace 5 s); `grace exceeded queues a cancel and throws environment.offline`; `abort queues a cancel`; `fs_gone maps to FileSystemGoneError`; `every key written has a TTL` (inspect `PTTL` of the list and result keys > 0).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/devices` — FAIL.
- [ ] **Step 3: Implement** `DeviceRelay` (no in-process maps shared across requests; one subscription per call, removed in `finally`) and `DeviceSandboxProvider`; `DevicesModule` registers the provider in `onModuleInit`.
- [ ] **Step 4: Run** the device and sandbox tests — PASS.
- [ ] **Step 5: Commit** `feat(kernel): the @device provider relays sandbox operations through Redis`.

### Task 5: Kernel — device authorization and machines (risk: high)

**Files:**
- Create: `packages/kernel/src/devices/machines.ts`, `packages/kernel/src/devices/device-auth.ts`, `packages/kernel/src/devices/device-auth.controller.ts`, `packages/kernel/src/devices/dto.ts`
- Modify: `packages/kernel/src/devices/devices.module.ts`, `packages/kernel/src/http/api.module.ts` (controller), `packages/kernel/src/infra/throttler/named-throttlers.ts`, `packages/kernel/src/environments/environments.controller.ts` (machine revoke route), `packages/kernel/src/environments/environments.service.ts` (`remove` revokes the machine and relays `stop`), `packages/kernel/src/platform/exclusions.ts`, `packages/kernel/test/identity/public-routes.test.ts`
- Test: `packages/kernel/test/devices/device-auth.test.ts`, `packages/kernel/test/devices/machines.test.ts`

**Interfaces:**
- Consumes: Task 2 table and codes; Task 3 `EnvironmentsService.createDevice`; `audit()`; `CredentialThrottler`.
- Produces:
  - `MachinesService`: `issue(tx, { orgId, environmentId, accountId, name, os, arch, programVersion }): Promise<{ machineId; credential }>` (revokes the environment's active machine first); `authenticate(credential: string): Promise<{ machineId; orgId; environmentId; accountId } | null>` (prefix `cap_dev_`, sha256, not revoked, environment not deleted, account active in the org); `recordHello(machineId, hello: DeviceHello)`; `touch(machineId)` (last_seen at most every 60 s); `revoke(orgId, accountId, environmentId)`; `activeFor(environmentId)`.
  - Routes:
    - `POST /api/v1/device/authorize` `@Public`, body `{ name: string(1..64), os: "darwin"|"linux", arch: string, programVersion: string }` → `{ deviceCode, userCode, verificationUri, verificationUriComplete, interval: 5, expiresIn: 600 }`. Throttled `device-authorize-ip` (20 / 15 min).
    - `POST /api/v1/device/token` `@Public`, body `{ deviceCode }` → error codes of §13.3 or `{ credential, orgId, environmentId, connectUrl }`. `connectUrl` = public base URL with `wss`/`ws` + `/device/connect`. Polling faster than the current interval → `device.slow_down` and interval + 5.
    - `GET /api/v1/device/pending/:userCode` `@SessionOnly` → `{ machine: { name, os, arch, programVersion }, expiresAt }`; `device.code_invalid` when unknown/expired. Throttled `device-code-account` (10 / 15 min, refund on success).
    - `POST /api/v1/device/confirm` `@SessionOnly`, body `{ userCode, orgId, environmentId?: uuid, name?: string }` (exactly one of `environmentId` / `name`) → `{ environmentId }`. Checks org membership (`agents.use`) and, for `environmentId`, that it is the caller's own `source='device'` environment. One transaction: create environment if `name`, `MachinesService.issue`, audit `environment.machine_connected`; `afterCommit`: park the credential in the code's Redis entry.
    - `POST /api/v1/device/deny` `@SessionOnly`, body `{ userCode }`.
    - `DELETE /api/v1/orgs/:orgId/environments/:id/machine` `@OrgAction("agents.use")` → 204; revokes, audit `environment.machine_revoked`, `afterCommit` relay `stop {reason:"revoked"}` and bus `device.revoked.<env>`.
  - Redis: `capk:device-auth:<sha256(deviceCode)>` (JSON state: machine info, userCode, interval, lastPollAt, status `pending|approved|denied`, parked credential) and `capk:device-user:<userCode>` → hash; both TTL `authCodeTtlSeconds`; the parked credential is read with a Lua get-and-delete of the field.
  - Platform: exclusions with category `human-only` for confirm/deny/pending/revoke and `transport` for authorize/token, each with a reason.

- [ ] **Step 1: Write the failing tests:** `full flow: authorize → pending → confirm with a new name → token returns a working credential once` (second token call → `device.expired` or code gone); `token before confirm is authorization_pending`; `polling twice within 5 s is slow_down and the interval grows to 10`; `deny ends with device.denied`; `confirm into another person's environment is environment.not_found`; `a new login replaces the machine and the old credential stops authenticating`; `revoke audits and the credential no longer authenticates`; `deleting a device environment revokes its machine`; `user code alphabet and format` (`/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/`); public-routes test lists the two public routes.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/devices packages/kernel/test/identity/public-routes.test.ts` — FAIL.
- [ ] **Step 3: Implement**; CLI callers send `X-Capybara-Csrf: 1` on the public POSTs (documented in the route doc comment).
- [ ] **Step 4: Run** the tests plus `pnpm check:platform-ops`, `pnpm check:kernel-conventions` — PASS.
- [ ] **Step 5: Commit** `feat(kernel): device authorization and machine credentials`.

### Task 6: Kernel — gateway WebSocket holder (risk: high)

**Files:**
- Create: `packages/kernel/src/devices/device-gateway.ts`, `packages/kernel/src/devices/device-routes.ts`
- Modify: `packages/kernel/package.json` (`@fastify/websocket`), `packages/kernel/src/http/gateway-routes.ts`, `packages/kernel/src/roles/gateway.module.ts`, `packages/kernel/src/lifecycle/kernel-lifecycle.ts` (start/stop of `DeviceGateway` with the gateway parts), `packages/kernel/src/platform/exclusions.ts`
- Test: `packages/kernel/test/devices/device-gateway.test.ts`, `packages/kernel/test/devices/device-gateway.dual.test.ts`

**Interfaces:**
- Consumes: Task 1 `parseDeviceFrame`; Task 4 key names and topics; Task 5 `MachinesService.authenticate / recordHello / touch`; `LockService.hold`.
- Produces:
  - `GET /device/connect`: before upgrade, `authenticate(Bearer)` (401 `device.credential_invalid`), header protocol `!== "1"` → 426 `environment.program_outdated` JSON. After upgrade: wait for `hello` (10 s, else close 4400), `recordHello`, claim the lease (takeover: publish `device.takeover.<env>`, retry `hold` every 250 ms for 5 s, else close 4409).
  - While holding: subscribe `device.req.<env>`, `device.takeover.<env>`, `device.revoked.<env>`; drain the list with `LPOP` on each nudge and after claiming; forward frames; on `res` write `capk:device-res:<id>` with TTL and publish `device.res.<id>`; ping every 20 s, close after 2 missed pongs; `touch` on traffic.
  - Lease lost / takeover / revoked / shutdown → close the socket (codes 4001 lost, 4002 replaced, 4003 revoked, 1001 shutdown) and release. Frames over `maxFrameBytes` → close 1009.
  - `DeviceGateway.stop()` within the kernel stop budget, before Redis closes.
  - Exclusion for `/device/connect` category `transport`.

- [ ] **Step 1: Write the failing tests:** single kernel with a `ws` client: `unknown credential is 401 before upgrade`; `protocol 2 is 426 program_outdated`; `hello then a relayed exec round-trip`; `revoking closes the socket with 4003 and refuses reconnects`; dual-replica (`roles: [["api","worker"],["gateway"]]` plus `startExtraReplica(["gateway"])`): `newest connection wins across gateway replicas` (two clients for one environment on two gateway replicas: exactly one holds, the first closes 4002); `a relayed call from the api replica reaches the socket on the gateway replica`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/devices` — FAIL.
- [ ] **Step 3: Implement**, registering the route through `registerGatewayRoutes` (gateway role only) and `DeviceGateway` in `GatewayModule`.
- [ ] **Step 4: Run** the device tests and `packages/kernel/test/lifecycle/roles.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(kernel): the gateway holds device connections`.

### Task 7: Kernel — real paths in sandbox tools (risk: normal; replay-sensitive)

**Files:**
- Modify: `packages/kernel/src/tools/builtins/sandbox/{common,bash,read,write,edit,glob,grep,task-output,task-stop}.ts`, `packages/kernel/src/tools/builtins/skill-load.ts`, `packages/kernel/src/tools/builtins/skill-write.ts`, `packages/kernel/src/background/{launch,tasks.service,stop}.ts`, `packages/kernel/src/runtime/subagents/definition.ts`, `packages/kernel/src/sandbox/sandbox.service.ts` (`withSandbox` passes `roots` in `info`), `packages/kernel/src/conversations/event-log.ts` (event type), `packages/kernel/src/runtime/context/build.ts` (render), `packages/kernel/src/evals/trajectory.ts` if it lists event kinds
- Test: extend `packages/kernel/test/tools/sandbox-*.test.ts`; new `packages/kernel/test/runtime/environment-paths.test.ts`; existing `reconstruct.test.ts`, `rename-compat.test.ts`

**Interfaces:**
- Consumes: Task 1 `rootsOf`; Task 3 per-environment `withSandbox`.
- Produces:
  - `SandboxUseInfo.roots: SandboxRoots` passed to every `withSandbox` callback.
  - Attachments dir `<roots.workspace>/attachments/<conv12>`; skills `<roots.skills>/<name>@<digest12>/`; markers `<roots.skills>/.capybara/…`.
  - Path checks (`checkPath` and friends) accept only absolute paths under one of the three roots of the held instance.
  - Event `environment_paths { roots: SandboxRoots }`, appended once per root conversation before the first sandbox tool result when `roots` ≠ `DEFAULT_SANDBOX_ROOTS`; rendered as a system line: `This environment's directories: workspace <w>, skills <s> (read only), temporary files <t>. Use these paths in commands and tool calls.`
  - Tool descriptions mention "the workspace directory" instead of `/workspace` (no environment-specific text in descriptions).

- [ ] **Step 1: Run the zero-drift fixture tests first:** `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/evals/rename-compat.test.ts` — PASS (baseline).
- [ ] **Step 2: Write the failing tests:** `Write under custom roots lands in the device workspace` (fake provider with roots `/Users/u/capybara-device/e1/{workspace,skills,tmp}`); `a /workspace path is refused under custom roots with an actionable error naming the real workspace`; `attachments copy to <workspace>/attachments/<conv12>`; `environment_paths is recorded once and rendered as a system line`; `default roots record no environment_paths event`.
- [ ] **Step 3: Run** them — FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the new tests, the tools/background/runtime folders and the two zero-drift tests — PASS.
- [ ] **Step 6: Commit** `feat(kernel): sandbox tools use the instance's real paths`.

### Task 8: Web — connected environments and `/device`

**Files:**
- Create: `apps/web/src/app/(auth)/device/{layout,page,view}.tsx`, `apps/web/src/lib/devices.ts`, `apps/web/src/lib/query/devices.ts`
- Modify: `apps/web/src/lib/environments.ts`, `apps/web/src/app/(app)/environments/view.tsx`, `apps/web/src/app/(app)/environments/[id]/view.tsx`, `apps/web/src/components/EnvironmentCreateDialog.tsx`, `apps/web/src/components/conversation/useSelection.ts`, `apps/web/src/lib/query/routes.ts`, `apps/web/src/lib/routes.ts` (no change to `PUBLIC_PREFIXES`: `/device` needs sign-in, its layout redirects through `loginPathFor`), `apps/web/messages/{zh,en}.json`
- Test: `apps/web/test/device-page.test.tsx`, extend `apps/web/test/environments*.test.tsx`; e2e `apps/web/e2e/device-connect.spec.ts` (kernel test helper drives authorize/token)

**Interfaces:**
- Consumes: Task 3 view fields; Task 5 routes.
- Produces (copy, zh / en):
  - Source label `接入设备` / `Connected device`; states `在线` / `Online`, `离线` / `Offline`.
  - 新建环境 dialog gets two choices `云端沙箱` / `接入设备`; 接入设备 shows the steps `npm install -g @capybara-hq/device` and `capybara-device login --url <origin>` with copy buttons and waits (environments query refetch) until a new device environment appears.
  - `/device` page (`AuthPage`): the code (`XXXX-XXXX`) to compare with the terminal, machine name / OS / program version, org select, `新建环境` name (default machine name) or an existing device environment, the disclosure: `确认后，你和你的智能体可以在这台机器上运行命令。命令输出和智能体读到的文件内容会进入对话并发送给模型。随时可以在环境页断开，或在这台机器上运行 capybara-device stop。` and the English equivalent; buttons 确认连接 / 拒绝.
  - Environment page (device): machine row (name, OS, mode 系统沙箱 / Docker, program version, last seen) and 断开这台机器 (confirm dialog); delete dialog states the files on the machine stay.
  - Picker: device environments listed with 在线/离线; offline not selectable for sending; the picker shows when `cloudAvailable` **or** any device environment exists.

- [ ] **Step 1: Write the failing tests:** `device page shows the code and the disclosure and confirms into a new environment`; `device page shows the expired state for an unknown code`; `picker disables an offline device environment`; `environment page shows the machine and revokes it`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/device-page.test.tsx apps/web/test/environments` — FAIL.
- [ ] **Step 3: Implement** with design components only (writing-web-ui skill); register the routes in the route table.
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui`, `pnpm check:i18n` — PASS. Visual baselines and reference images are rendered later by the `visual-update` / `reference-update` workflows.
- [ ] **Step 5: Commit** `feat(web): connected environments and the device confirmation page`.

### Task 9: Program — package, state and `login` / `logout` / `status`

**Files:**
- Create: `packages/device/{package.json,tsconfig.json,README.md,NOTICE}`, `packages/device/bin/capybara-device.mjs`, `packages/device/src/{cli.ts,args.ts,state.ts,api.ts}`, `packages/device/src/commands/{login,logout,status}.ts`
- Modify: root `tsconfig.json` (reference), `tools/checks` dependency rule for `packages/device` (allowed `@capybara-hq/*`: `plugin-sdk` only) with a failing fixture first, `docs/architecture.md`, `AGENTS.md` (repository map + dependency line), `.changeset/` (new package)
- Test: `packages/device/test/{args,state,login}.test.ts`, `tools/checks/test/device-deps.test.ts`

**Interfaces:**
- Consumes: Task 5 HTTP contract (fake server in tests via `node:http`).
- Produces:
  - `package.json`: name `@capybara-hq/device`, `bin: { "capybara-device": "./bin/capybara-device.mjs" }`, `engines.node >=22.12`, `files: ["bin","dist","README.md","NOTICE"]`, deps `@capybara-hq/plugin-sdk` (workspace), `ws`, `@anthropic-ai/sandbox-runtime` `0.0.81` exact; release metadata as `check:release-metadata` requires; `exports`/`publishConfig` like `packages/plugin-tools`.
  - `parseArgs`-based CLI (no framework), commands `login --url <url> [--no-browser] [--dir <path>] [--mode os|docker]`, `logout`, `status [--json]`, `start`, `stop`, `drain`, `policy [show|set <key> <value>]`, `service install|uninstall`.
  - `stateDir(): string` = `$XDG_CONFIG_HOME/capybara-device` or `~/.config/capybara-device`; `credential.json` `{ url, connectUrl, credential, orgId, environmentId, dir, mode }` written 0600 (refuse to read a group/world-readable file); `policy.json` defaults `{ allowedDomains: [], allowCredentials: [], cpu: null, memoryMb: null }`.
  - `login`: authorize → print `userCode` and `verificationUriComplete`, open the browser unless `--no-browser` (`open` / `xdg-open`), poll honouring `interval` and `slow_down`, write state, create `dir` (default `~/capybara-device/<environmentId>`) with `workspace/`, `skills/`, `tmp/`.
  - Native Windows: every command exits 1 with `capybara-device runs on macOS and Linux. On Windows use WSL or Docker.`

- [ ] **Step 1: Write the failing tests:** `login polls until approved and writes a 0600 credential`; `login slows down on device.slow_down`; `login stops on device.denied with exit 1`; `status reports not logged in`; `refuses a credential file readable by others`; the deps check fixture `packages/device importing @capybara-hq/kernel fails check:deps`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/device tools/checks/test/device-deps.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, `pnpm check`, `pnpm typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(device): the capybara-device package, login, logout and status`.

### Task 10: Program — connection, ops, results across reconnects

**Files:**
- Create: `packages/device/src/{client.ts,server-ops.ts}`, `packages/device/src/exec/types.ts`, `packages/device/src/commands/{start,stop,drain}.ts`
- Test: `packages/device/test/{client,server-ops}.test.ts`

**Interfaces:**
- Consumes: Task 1 frames; Task 6 wire behaviour (fake WebSocket server in tests with `ws`).
- Produces:
  - `interface Executor { readonly mode: "os" | "docker"; readonly roots: SandboxRoots; exec(args, signal): Promise<ExecResult>; readFile(path, maxBytes); writeFile(path, data); stat(path); killTagged(tags); killAll(); ensureRoot(): Promise<"ok" | "gone"> }`.
  - `connect(state, executor)`: headers of §13.4; `hello` first; reconnect with backoff 1 s doubling to 60 s with jitter; on 426 exit with `This capybara-device is too old for the deployment. Upgrade it: npm install -g @capybara-hq/device`; on 401 / close 4003 exit with `This machine was disconnected from the deployment. Run capybara-device login again.`
  - Ops run concurrently; each `exec` tracked by `tag`; `cancel` kills the request's process tree; results of requests that finish while disconnected kept up to `reconnectGraceSeconds` (taken from the token response, default 120) and sent after `hello` on reconnect.
  - `ensureRoot`: a root that existed (marker file `<dir>/.capybara-device`) and is gone → every op answers `fs_gone`; never recreated silently.
  - `start` runs in the foreground, writes a pid file in the state dir; `stop` signals it (SIGTERM); `drain` sends SIGUSR2 → no new ops (`error` kind `error`, message "draining"), exit when running ops finish.
  - Local log: one JSON line per op (`time, op, tag, actor.accountId, exitCode`) in `<stateDir>/commands.log`, rotated at 10 MiB.

- [ ] **Step 1: Write the failing tests:** `sends hello and answers an exec`; `result produced while disconnected is sent after reconnect`; `late reconnect receives the cancel and kills the process`; `a vanished root answers fs_gone`; `426 exits with the upgrade message`; `drain refuses new ops and exits after running ones`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/device` — FAIL.
- [ ] **Step 3: Implement** (with a fake executor for these tests).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(device): connection, operations and reconnect`.

### Task 11: Program — OS sandbox executor and the local policy (risk: high)

**Files:**
- Create: `packages/device/src/exec/os.ts`, `packages/device/src/policy.ts`, `packages/device/src/commands/policy.ts`
- Test: `packages/device/test/policy.test.ts`, `packages/device/test/exec-os.test.ts` (runs only where `SandboxManager.isSupportedPlatform()` and dependencies pass; macOS and Linux CI with bubblewrap)

**Interfaces:**
- Consumes: Task 10 `Executor`; `@anthropic-ai/sandbox-runtime` `SandboxManager.initialize`, `wrapWithSandbox`, `cleanupAfterCommand`.
- Produces:
  - `effectiveEgress(policy, limits): string[]` — `limits.egress === "none"` → `[]`; `"allowlist"` → intersection of `policy.allowedDomains` and `limits.allowHosts` (exact host match, `*.` suffix patterns from the policy apply); `"open"` → `policy.allowedDomains`.
  - `srtConfig(policy, roots, egress)`: `filesystem.allowWrite = [roots.workspace, roots.tmp]`, `filesystem.denyWrite = [roots.skills]`, `filesystem.denyRead = DENIED_SECRET_PATHS` (the list of §13.6, `~` expanded, browser profiles: `~/Library/Application Support/Google/Chrome`, `~/Library/Application Support/Firefox`, `~/.mozilla`, `~/.config/google-chrome`, `~/.config/chromium`), `network.allowedDomains = egress`, `network.deniedDomains = []`.
  - Commands run via `/bin/bash -c` wrapped by `wrapWithSandbox`, cwd default `roots.workspace`, env `HOME=<roots.workspace>`, `TMPDIR=<roots.tmp>`, plus the request's env; timeout kills the process group; output capped at `maxOutputBytes` on a UTF-8 boundary.
  - File ops (`readFile` / `writeFile` / `stat`) check the path is under a root after `realpath` (symlinks resolved). `roots.skills` is read only to commands (`denyWrite`); `writeFile` may write there, because the kernel writes skill files through it.
  - `policy` command: `show` prints the file; `set allowedDomains a.com,b.com`; the cloud never writes the policy.

- [ ] **Step 1: Write the failing tests:** `egress is the intersection` (policy `[a.com, b.com]`, limits allowlist `[b.com, c.com]` → `[b.com]`; open → `[a.com, b.com]`; none → `[]`); `write outside the root is refused` (command `touch ~/x` exits non-zero and `~/x` does not exist); `reading ~/.ssh is denied`; `a symlink in the workspace pointing outside is refused by readFile`; `timeout kills the command and its children`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/policy.test.ts packages/device/test/exec-os.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS (the OS test skipped with a logged reason where the platform is unsupported).
- [ ] **Step 5: Commit** `feat(device): OS sandbox mode and the local policy`.

### Task 12: Program — Docker mode and system service

**Files:**
- Create: `packages/device/src/exec/docker.ts`, `packages/device/src/service/{launchd,systemd}.ts`, `packages/device/src/commands/service.ts`
- Test: `packages/device/test/exec-docker.test.ts` (runs when `docker info` succeeds), `packages/device/test/service.test.ts`

**Interfaces:**
- Consumes: Task 10 `Executor`; Task 11 `effectiveEgress`.
- Produces:
  - Docker executor through the `docker` CLI (no Engine API client dependency): one container per environment named `capybara-device-<environmentId>`, image `ghcr.io/capybara-hq/capybara-sandbox:<tag>` where `<tag>` is a constant `SANDBOX_IMAGE_TAG` in `exec/docker.ts` (the sandbox images' current version, `0.1.0-rc.5`), `--network none` when egress is `[]`, otherwise the default bridge with `HTTPS_PROXY` unset (domain allowlisting in Docker mode is a stated limitation in the README), mounts `<dir>/workspace:/workspace`, `<dir>/skills:/skills:ro`, `<dir>/tmp:/tmp`, `--cpus` / `--memory` from the policy; exec through `docker exec` with the same wrapper semantics (tags, kill by tag); roots = `DEFAULT_SANDBOX_ROOTS`.
  - `service install` writes `~/Library/LaunchAgents/top.capybara.device.plist` (macOS, `launchctl bootstrap gui/<uid>`) or `~/.config/systemd/user/capybara-device.service` (`systemctl --user enable --now`), running `capybara-device start`; `uninstall` reverses it. Tests check the generated file content only.

- [ ] **Step 1: Write the failing tests:** `docker exec runs in /workspace and files land in the environment dir`; `killTagged stops only that tag`; `launchd plist runs start with the node path`; `systemd unit restarts on failure`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/exec-docker.test.ts packages/device/test/service.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(device): Docker mode and the system service`.

### Task 13: Docs, skills and the live checklist

**Files:**
- Modify: `.agents/skills/writing-sandbox-providers/SKILL.md` (kernel-internal `@device`, roots), `docs/deploy/README.md` (the gateway must be reachable over `wss://` at `/device/connect`; proxies must allow WebSocket upgrade), `packages/device/README.md` (install, login, modes, policy, limitations: no domain allowlist in Docker mode, no process isolation between sessions, Windows via WSL/Docker), `docs/superpowers/plans/environments-phase-1-live-acceptance-checklist.md` → new `environments-phase-2-live-acceptance-checklist.md`
- Changeset: `@capybara-hq/capybara` patch (image ships the kernel with the gateway route)

- [ ] **Step 1: Write** the checklist: login with a browser on macOS; login `--no-browser` on Linux; a conversation on the device runs `Bash` / `Write` with real paths; Wi-Fi off for 30 s mid-command → result delivered; off for 3 min → `environment.offline`, process killed on return; revoke from the web closes the program; policy change narrows egress; Docker mode on a machine with Docker; `service install` survives a reboot.
- [ ] **Step 2: Run** `pnpm check` (agent docs, terms) — PASS.
- [ ] **Step 3: Commit** `docs: connected environments`.

---

## Execution notes

- Waves (for `wave-planned-subagent-development`): W1 Task 1, Task 2 (disjoint) · W2 Task 3 (high, alone) · W3 Task 4 (high), Task 9 (disjoint) · W4 Task 5 (high), Task 10 · W5 Task 6 (high), Task 11 (high) · W6 Task 7, Task 12 · W7 Task 8, Task 13. High-risk tasks are reviewed alone on the most capable model.
- One core PR is expected (all in this repository); publishing `@capybara-hq/device` for the first time needs the `NPM_TOKEN` secret (docs/deploy/release.md), so the first release asks the maintainer.
- Live gates before calling phase 2 done: the checklist of Task 13 on this maintainer's macOS machine and one Linux machine.
