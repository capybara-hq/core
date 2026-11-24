# Browser Use Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository, layer it with `wave-planned-subagent-development`.

**Goal:** Agents drive a headless Chromium with a persistent profile inside the conversation's device; the device's owner watches it live and takes over from an embed panel in the conversation's right area.

**Architecture:** The kernel gains three generic capabilities: a device **service** (one long-lived named process per device with its own state directory), **service requests** for tool calls, and **device streams** for viewers (relayed by the gateway role, never through Redis / PG). The `browser` plugin ships the daemon (Chromium + CDP), the agent tools and the embed panel; device providers (docker, e2b, local) implement the service and stream methods.

**Tech Stack:** TypeScript, NestJS + Fastify (`@fastify/websocket`, `ws`), Kysely / PG, ioredis, vitest; Chromium via `playwright-core` in the daemon (CDP only, no Playwright test runner); plain DOM + canvas in the embed page.

**Spec:** `docs/superpowers/specs/2026-11-23-browser-use-design.md` (with its 2026-11-23 amendments). Read it before any task.

**Repositories:** core = `capybara-hq/core` (this repo); plugins = `capybara-hq/plugins` (`/Users/grant/Capybara/plugins`). Tasks name their repo.

## Global Constraints

- Frames never pass through Redis or PG. Tool-call requests may (the existing dial-in relay).
- Browser tools work only when the run's trigger account is the conversation's owner (`ToolCallContext.accountId === ToolCallContext.ownerAccountId`); otherwise the English error: `Browser tools only run for the conversation's owner on their own device.`
- Tool policy: `navigate`, `tabs`, `snapshot`, `screenshot`, `wait`, `handoff` declare `defaultPolicy: "allow"`; `click`, `type`, `select`, `press`, `scroll`, `hover`, `upload`, `click_at`, `type_at` declare `defaultPolicy: "ask"` (the permission profile then decides).
- Browser network asks offer only the `always` scope (device allowlist); no `once`.
- Viewport fixed at 1280×800; the panel never changes it.
- No published port or address for the daemon or Chromium; the daemon listens only on a unix socket in its service state directory (macOS socket path ≤ 104 bytes: keep the state directory short).
- The panel never starts the service; only tool calls do.
- Chromium flags always include `--headless`, `--use-mock-keychain`, `--user-data-dir=<state>/profile`, `--remote-debugging-pipe` (no debugging port), `--proxy-server` only when the provider passes one in the service env.
- Tool keys contain no dots; English descriptions and actionable errors; model-visible text English; UI text zh + en through the plugin's i18n, zh says 智能体, never 企业.
- Multi-replica rules: no timers or in-process shared maps in kernel or extension code (the daemon inside the device may keep its own timers); every `ctx.kv` / Redis write has a TTL; queue names and job ids contain no `:`.
- Kernel: one Nest module per concern, explicit `@Inject` on every constructor parameter, DTOs via `createZodDto`, config through `KernelConfigService` (`pnpm check:kernel-conventions`).
- SDK public API changes: `pnpm gen:sdk-api` + a changeset bumping `@capybara-hq/plugin-sdk`; `packages/device` changes: a changeset bumping `@capybara-hq/device`.
- New unit / container tests join `packages/kernel/test/unit-tests.json` / `container-tests.json` in the same commit; integration is the default.
- Commits: Conventional Commits, body lines ≤ 100 chars, ending with `Co-Authored-By: Capybara <noreply@capybarahq.com>`.

## Review Focus

1. **A viewer ticket replayed or used by another account** (a copied URL, a second tab): the second open must fail with 401, and a ticket minted for one device must never open another device's stream. → Task 8 tests `ticket is single use` and `ticket bound to device and account`.
2. **The machine disconnects mid-stream** (laptop sleeps, Wi-Fi drops): the viewer gets a clean close with reason `device-offline` within the reconnect grace, never a hung socket, and the panel offers reconnect. → Task 3 test `stream closes when the machine socket drops`; Task 14 test `panel shows reconnect after device-offline close`.
3. **The person types into the address bar a host the allowlist refuses during takeover**: the panel shows the host with 允许 and nothing silently loads; after 允许 the reload succeeds. → Task 13 test `blocked navigation is reported with its host`; Task 14 test `allow button adds the host and reloads`.
4. **Two conversations on one device use the browser at once while the person has taken over from one of them**: both agents get the "user is controlling" error; neither drives the page. → Task 13 test `agent input refused while taken over from any viewer`.
5. **A huge page** (infinite feed, 50k nodes): the snapshot stays under its cap with a truncation marker and the screenshot stays under the device's frame capacity. → Task 13 tests `snapshot caps at 40000 chars with a marker` and `screenshot fits the frame capacity`.

---

## Waves

| Wave | Tasks | Repo | Notes |
|---|---|---|---|
| 0 | 1 | both (throwaway) | gate: if the spike fails on macOS, local-device tasks (10, 11) wait; docker path continues |
| 1 | 2 | core | SDK contracts; review alone (trust boundary) |
| 2 | 3, 4, 5, 6 | core | disjoint files, parallel; 3 and 5 reviewed on the most capable model (multi-replica, approvals) |
| 3 | 7, 8 | core | 7 then 8 share `device-access/`; run sequentially; both trust-boundary reviews |
| 4 | 9, 10 | core | 9 web bridge; 10 `packages/device` |
| 5 | 11, 12 | plugins | providers (docker + e2b in 12, local in 11) |
| 6 | 13, 14, 15 | plugins | daemon, plugin server, panel |
| 7 | 16 | both | end-to-end acceptance on the dev stack, release |

---

### Task 1: Spike: screencast and input in the target Chromium builds (throwaway)

**Repo:** scratch directory only; nothing committed except the result note.

**Files:**
- Create: `<scratchpad>/browser-spike/spike.mjs` (not committed)
- Modify: `docs/superpowers/plans/2026-11-23-browser-use.md` (append a "Spike results" section)

- [ ] **Step 1:** Write `spike.mjs` with `playwright-core`: launch Chromium headless over a pipe, open `https://example.com`, `Page.startScreencast({ format: "jpeg", quality: 60, maxWidth: 480, maxHeight: 300 })`, ack 20 frames and write them to disk, `Input.dispatchMouseEvent` a click on the "More information" link, assert the URL changed, `Target.createTarget` a second tab and list targets.
- [ ] **Step 2:** Run it on macOS under the local device sandbox: `capybara-device` running, then in a conversation on the local device have Bash run `node spike.mjs` with `chrome-headless-shell --single-process` (`PLAYWRIGHT_BROWSERS_PATH` under the workspace cache). Expected: 20 frame files, URL changed, 2 targets.
- [ ] **Step 3:** Run it in a docker device conversation the same way with Playwright's Chromium. Expected: same output.
- [ ] **Step 4:** Measure: median frame size (small and 1280×800), frames/s while scrolling, RSS of Chromium with 3 tabs. Append the numbers and pass/fail per platform to this plan under "Spike results"; commit `docs: browser use spike results`.

---

### Task 2: SDK contracts: services, service requests, streams, dial-in stream frames, `deviceAccess`

**Repo:** core

**Files:**
- Modify: `packages/plugin-sdk/src/device-provider.ts` (types + optional methods on `DeviceProvider`, near `exec` at :489)
- Modify: `packages/plugin-sdk/src/dial-in.ts` (frame unions :20 / :39, parser :94, `DialInChannel` :188)
- Modify: `packages/plugin-sdk/src/permissions.ts` (`deviceAccess`, allowed keys :116, validation near :289)
- Modify: `packages/plugin-sdk/src/ctx.ts` (add `deviceAccess: DeviceAccessCtx`)
- Create: `packages/plugin-sdk/src/device-service.ts` (framing helpers)
- Modify: `packages/plugin-sdk/src/index.ts`, API report via `pnpm gen:sdk-api`
- Create: `.changeset/browser-use-sdk.md` (minor-equivalent prerelease bump of `@capybara-hq/plugin-sdk`)
- Test: `packages/plugin-sdk/test/device-service.test.ts`, `packages/plugin-sdk/test/dial-in-stream-frames.test.ts`, `packages/plugin-sdk/test/permissions-device-access.test.ts`

**Interfaces:**
- Produces (exact):

```ts
// device-provider.ts
export interface DeviceServiceSpec {
  name: string;                        // /^[a-z][a-z0-9-]{0,31}$/
  runtime: "node";                     // the provider supplies Node ≥ 22
  entry: string;                       // relative path inside files
  args: string[];
  files: Record<string, Uint8Array>;   // written into the service state dir before start
  env?: Record<string, string>;
}
export interface DeviceServiceStatus { name: string; state: "running" | "stopped"; startedAt: string | null }
export interface DeviceStream {
  send(message: Uint8Array): Promise<void>;     // resolves when the peer has credit
  readonly messages: AsyncIterable<Uint8Array>;
  close(reason?: string): void;
  readonly closed: Promise<{ reason: string }>;
}
// on DeviceProvider (all optional):
ensureService?(h: SandboxHandle, spec: DeviceServiceSpec, signal: AbortSignal): Promise<DeviceServiceStatus>;
stopService?(h: SandboxHandle, name: string, signal: AbortSignal): Promise<void>;
serviceRequest?(h: SandboxHandle, name: string, body: Uint8Array,
                opts: { timeoutMs: number; signal: AbortSignal }): Promise<Uint8Array>;
openStream?(h: SandboxHandle, target: { service: string }, signal: AbortSignal): Promise<DeviceStream>;

// device-service.ts — the service socket protocol every provider and service speaks
export const DEVICE_SERVICE_SOCKET_ENV = "CAPYBARA_SERVICE_SOCKET";
export const DEVICE_SERVICE_STATE_ENV = "CAPYBARA_SERVICE_STATE";
export const DEVICE_SERVICE_MAX_MESSAGE = 8 * 1024 * 1024;
export function encodeServiceMessage(body: Uint8Array): Uint8Array;   // 4-byte big-endian length + body
export class ServiceMessageDecoder { push(chunk: Uint8Array): Uint8Array[] }  // throws on > MAX
// A connection whose first message is {"kind":"request"} JSON gets one reply then closes;
// {"kind":"stream"} keeps exchanging messages until either side closes.
export const SERVICE_CONNECTION_KINDS = ["request", "stream"] as const;

// dial-in.ts — new kernel→machine frames
| { type: "stream-open"; streamId: string; body: unknown }
| { type: "stream-data"; streamId: string; data: string }          // base64
| { type: "stream-credit"; streamId: string; messages: number }
| { type: "stream-close"; streamId: string; reason: string }
// new machine→kernel frames
| { type: "stream-opened"; streamId: string; ok: boolean; error?: string }
| { type: "stream-data" | "stream-credit" | "stream-close"; … same fields }
export const DIAL_IN_STREAM_INITIAL_CREDIT = 8;
// DialInChannel gains:
openStream(deviceId: string, body: unknown, opts: { signal: AbortSignal }): Promise<DeviceStream>;
export class DialInStreamElsewhereError extends Error { readonly code = "device.stream_elsewhere" }

// permissions.ts
deviceAccess?: { services: string[] };   // 1–4 names matching the service name rule

// ctx.ts
export type DeviceAccessScope = { conversationId: string; accountId: string };
export interface DeviceAccessCtx {
  ensureService(call: ToolCallContext, spec: DeviceServiceSpec): Promise<DeviceServiceStatus>;
  request(call: ToolCallContext, req: { service: string; body: Uint8Array; timeoutMs: number }): Promise<Uint8Array>;
  reportBlockedHosts(call: ToolCallContext, hosts: string[]): void;
  streamTicket(scope: DeviceAccessScope & { service: string }): Promise<{ url: string; expiresAt: string }>;
  addNetworkHosts(scope: DeviceAccessScope & { hosts: string[] }): Promise<void>;
  answerHandoff(scope: DeviceAccessScope & { callId: string; done: boolean }): Promise<void>;
}
export class DeviceAccessError extends Error {
  readonly code: "no_device" | "provider_unavailable" | "capability_missing" | "not_owner" | "service_not_declared";
}
```

- [ ] **Step 1: Write failing tests**
  - `device-service.test.ts`: `encode then decode round-trips three messages split across arbitrary chunk boundaries`; `decoder throws on a declared length above DEVICE_SERVICE_MAX_MESSAGE`.
  - `dial-in-stream-frames.test.ts`: `parses stream-opened / stream-data / stream-credit / stream-close`; `rejects stream-data without streamId`; `rejects a frame above maxBytes` (existing size rule).
  - `permissions-device-access.test.ts`: `accepts deviceAccess with services ["browser"]`; `rejects an empty services list`; `rejects "Browser" and a 33-char name`; `rejects more than 4 services`.
- [ ] **Step 2:** `pnpm exec vitest run packages/plugin-sdk/test/device-service.test.ts packages/plugin-sdk/test/dial-in-stream-frames.test.ts packages/plugin-sdk/test/permissions-device-access.test.ts` → FAIL (missing exports).
- [ ] **Step 3:** Implement the types and helpers above. `deviceAccess` does not require `provides`.
- [ ] **Step 4:** Rerun → PASS. Run `pnpm gen:sdk-api`, `pnpm typecheck` (kernel compiles: `createExtensionContext` gets a placeholder `deviceAccess` that throws `DeviceAccessError("capability_missing")`, replaced in Task 7).
- [ ] **Step 5:** Add the changeset; commit `feat(sdk): device services, streams and deviceAccess contracts`.

---

### Task 3: Dial-in direct streams on the holding gateway replica

**Repo:** core

**Files:**
- Create: `packages/kernel/src/dial-in/streams.ts` (`DialInStreams`: per-connection stream table, credit accounting)
- Modify: `packages/kernel/src/dial-in/gateway.ts` (`DeviceConnection.onFrame` :246 routes `stream-*` before `store`; send helpers; `DialInGateway.openStream(deviceId, body, signal)`; write holder address next to the lease refresh at :462-482)
- Modify: `packages/kernel/src/dial-in/keys.ts` (`deviceHolderAddrKey(deviceId) = "capk:device-holder-addr:" + deviceId`)
- Modify: `packages/kernel/src/ctx/create-ctx.ts` (`ctx.dialIn.openStream` at :544-581, same `serves` gate)
- Modify: `packages/kernel/src/config/schema.ts` (`gateway.internalUrl`: optional URL, description "Origin other gateway replicas use to reach this replica for device stream hops, e.g. http://10.0.0.5:8080; default http://<hostname>:<http.port>"); `docs/config.md` regenerated
- Modify: `packages/testing/src/fake-dial-in-machine.ts` (`onStream(handler: (open: unknown, s: FakeMachineStream) => void)`, honours credit)
- Modify: `.agents/skills/writing-device-providers/SKILL.md` and `writing-extensions/SKILL.md` (one paragraph each: dial-in streams)
- Test: `packages/kernel/test/dial-in/streams.test.ts` (integration), `packages/kernel/test/dial-in/streams.dual.test.ts` (container; add to `container-tests.json`)

**Interfaces:**
- Consumes: Task 2 frame types, `DeviceStream`, `DialInStreamElsewhereError`.
- Produces: `DialInGateway.openStream(deviceId: string, body: unknown, signal: AbortSignal): Promise<DeviceStream>`; `DialInGateway.holderAddress(deviceId: string): Promise<string | null>` (reads `capk:device-holder-addr`); `DialInGateway.holdsLocally(deviceId: string): boolean`.

- [ ] **Step 1: Write failing tests** (`streams.test.ts`, one app, `FakeDialInMachine` echoing each message):
  - `stream echoes 100 messages in order` — send 100, collect 100 equal buffers.
  - `sender waits for credit` — machine withholds credit after 8; the 9th `send` stays pending until the machine grants 1 (assert via a resolved-flag, no sleeps: await the machine's `received(8)` promise).
  - `message above the connection's maxFrameBytes is refused` — `send` rejects with `/frame capacity/`.
  - `stream closes when the machine socket drops` — machine `close()`; `closed` resolves `{ reason: "device-offline" }`.
  - `requests still flow while a stream is saturated` — with a stream at zero credit, `ctx.dialIn.request` round-trips.
  - `holder address is written with the lease` — Redis `capk:device-holder-addr:<id>` equals the configured `gateway.internalUrl` and has a TTL.
  - `openStream on a replica without the socket throws DialInStreamElsewhereError`.
  - (`streams.dual.test.ts`) `the replica that does not hold the machine reports the holder's address`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/dial-in/streams.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Data frames carry base64 of one message; a message larger than `maxFrameBytes` minus envelope overhead is refused, not split (the daemon keeps screencast frames small by `maxWidth`). Credit: the receiver grants `DIAL_IN_STREAM_INITIAL_CREDIT` on open and one per consumed message.
- [ ] **Step 4:** Rerun both files (`pnpm exec vitest run packages/kernel/test/dial-in/streams.test.ts packages/kernel/test/dial-in/streams.dual.test.ts`) → PASS; `pnpm gen:config-docs` and `pnpm check`.
- [ ] **Step 5:** Commit `feat(kernel): dial-in device streams on the holding gateway replica`.

---

### Task 4: SandboxService: services and stream holds; device-fake support

**Repo:** core

**Files:**
- Create: `packages/kernel/src/sandbox/device-services.ts` (`DeviceServices` provider: `ensure`, `request`, `stop`; capability checks)
- Modify: `packages/kernel/src/sandbox/sandbox.service.ts` (public `holdForStream`; services killed on suspend / destroy go through the provider; register in `sandbox.module.ts`)
- Modify: `packages/kernel/test/fixtures/plugins/device-fake/index.ts` (implement `ensureService` by spawning `node <stateDir>/<entry>` in the fake directory, `serviceRequest` / `openStream` over the unix socket with the Task 2 framing, `stopService`; kill services in `suspend` / `destroy`)
- Create: `packages/kernel/test/fixtures/services/echo-service.mjs` (a framed echo server used by tests)
- Test: `packages/kernel/test/sandbox/device-services.test.ts` (integration)

**Interfaces:**
- Consumes: Task 2 types.
- Produces:

```ts
// device-services.ts
ensure(use: SandboxUseContext, spec: DeviceServiceSpec, signal: AbortSignal): Promise<DeviceServiceStatus>;
request(use: SandboxUseContext, name: string, body: Uint8Array, timeoutMs: number, signal: AbortSignal): Promise<Uint8Array>;
// sandbox.service.ts
holdForStream(deviceId: string, signal: AbortSignal):
  Promise<{ h: SandboxHandle; p: HeldProvider; release(): Promise<void> }>;
```

`holdForStream` never creates or resumes (like `ifRunning` :1032): it throws `DeviceAccessError("provider_unavailable")` when the instance is not running, registers a holder through `SandboxLeases.registerHolder` and renews it until `release()` or `signal` aborts, then moves `last_used_at` like `leave` (:2323).

- [ ] **Step 1: Write failing tests** (device-fake):
  - `ensure starts the echo service once` — two `ensure` calls → one process (fake exposes a start counter), state `running`.
  - `request round-trips through the service socket`.
  - `files are written into the service state dir, not the project root`.
  - `provider without ensureService throws capability_missing` (device-fake-b without the methods).
  - `idle suspension skips a device held for a stream` — hold, run `suspendIdle(now + 1 day)` → 0 suspended; release; rerun → 1.
  - `suspend kills the service` — after suspend, `serviceStatus` is `stopped`.
  - `holdForStream refuses a suspended instance`.
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/sandbox/device-services.test.ts` → FAIL.
- [ ] **Step 3:** Implement. `ensure` runs inside `withSandbox` (so it resumes a suspended instance like any tool use).
- [ ] **Step 4:** Rerun → PASS; `pnpm test:unit` still green.
- [ ] **Step 5:** Commit `feat(kernel): device services and stream holds in SandboxService`.

---

### Task 5: Network asks for extension calls (always-only)

**Repo:** core

**Files:**
- Modify: `packages/kernel/src/tools/approvals.service.ts` (`requestNetwork` :889: `NetworkAskInput` gains `toolKey: string` and `detail.kind: "command" | "service"`; `service` detail = `{ kind: "service"; service: string; url: string | null; hosts: string[] }`; replace the fixed `NETWORK_ASK_TOOL_KEY` with the input's key)
- Modify: `packages/kernel/src/tools/pipeline.ts` (after execute, read blocked hosts for **any** source from the call scope; feed the existing `networkBlocked` path with `scopes: ["always"]` when the report came from a service)
- Create: `packages/kernel/src/tools/call-scope.ts` (`CALL_SCOPE = Symbol("capybara.callScope")`; `interface CallScope { blocked: { deviceId: string; hosts: Set<string> } | null }`; `attachCallScope(ctx: ToolCallContext): CallScope`; `callScopeOf(ctx: ToolCallContext): CallScope | null`) — the scope lives on the call's context object, written and read in the same call, never in a module map
- Modify: the web approval card copy for `kind: "service"` (`apps/web` i18n zh/en: "智能体的浏览器想访问 {host}" / "The agent's browser wants to reach {host}", note "开放网络模式下不会再询问")
- Test: `packages/kernel/test/tools/network-asks-service.test.ts` (integration, with a new fixture extension `packages/kernel/test/fixtures/extensions/fake-device-access/` whose tool calls `ctx.deviceAccess.reportBlockedHosts`)

**Interfaces:**
- Consumes: Task 2 `DeviceAccessCtx.reportBlockedHosts` (the fixture uses a stub ctx until Task 7 wires it: the test injects through `attachCallScope` directly).
- Produces: `attachCallScope`, `callScopeOf` (Task 7 writes into them); `NetworkAskInput.toolKey`, `detail.kind`.

- [ ] **Step 1: Write failing tests:**
  - `blocked hosts from an extension call raise an always-only ask in the call's conversation` — approval record `toolKey === "browser__navigate"`, `scopes` equals `["always"]`, `detail.hosts` `["example.org"]`.
  - `approving adds the host to the device allowlist and re-runs the call` — after `decide(always)`, `devices.network_hosts` contains `example.org` and the tool handler ran twice.
  - `a host outside the org ceiling is refused without an ask` (existing `hostRefusal` path).
  - `Bash asks are unchanged` — existing network ask tests pass untouched.
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/tools/network-asks-service.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun + `pnpm exec vitest run packages/kernel/test/tools` → PASS; `pnpm check:i18n`.
- [ ] **Step 5:** Commit `feat(kernel): network asks for extension service calls`.

---

### Task 6: Web proxy: forward `/device/stream` upgrades to the gateway

**Repo:** core

**Files:**
- Modify: `apps/web/src/lib/device-connect-proxy.ts` (export `DEVICE_STREAM_PATH = "/device/stream"`; the upgrade matcher accepts it with a query string; the query is never logged)
- Modify: `apps/web/server.mjs` (route both paths)
- Modify: `docker/` compose and `docs/deploy/*` (one line: external proxies route `/device/stream` like `/device/connect`)
- Test: `apps/web/test/device-connect-proxy.test.ts` (extend)

- [ ] **Step 1: Failing tests:** `forwards /device/stream?ticket=x upgrades to the gateway with the query intact`; `drops cookies on /device/stream`; `still refuses other upgrade paths`.
- [ ] **Step 2:** `pnpm exec vitest run apps/web/test/device-connect-proxy.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5:** Commit `feat(web): forward device stream upgrades to the gateway`.

---

### Task 7: `ctx.deviceAccess`

**Repo:** core

**Files:**
- Create: `packages/kernel/src/device-access/device-access.module.ts`, `device-access.service.ts`
- Modify: `packages/kernel/src/ctx/create-ctx.ts` (replace the Task 2 placeholder; gate with `gated("deviceAccess", …)` (:1077); every call also checks the service name is in `permissions.deviceAccess.services`)
- Modify: `packages/kernel/src/ctx/create-ctx.ts` deps type (:126) for the new service
- Modify: `.agents/skills/writing-extensions/SKILL.md` (deviceAccess paragraph)
- Test: `packages/kernel/test/device-access/device-access.test.ts` (integration, `fake-device-access` fixture from Task 5 extended, device-fake + echo service)

**Interfaces:**
- Consumes: Task 4 `DeviceServices.ensure/request`, `holdForStream`; Task 5 `attachCallScope/callScopeOf`; `CommandReviewService.review` (`packages/kernel/src/sandbox/review/review.service.ts:233`); `devices.forTool` and the owner check `assertDeviceOfRunAccount` used by `inSandboxWith` (`packages/kernel/src/tools/builtins/sandbox/common.ts:815`); `DevicesService.addNetworkHostsIn` (`devices.service.ts:833`); `QuestionsService.answer` (`questions.service.ts:228`); `audit` (`identity/audit.ts:8`).
- Produces: `DeviceAccessService` methods mirroring `DeviceAccessCtx`, plus `mintTicket(scope, service, extension): Promise<{ id: string; url: string; expiresAt: string }>` used by Task 8. Ticket record: Redis `capk:device-stream-ticket:<id>` → `{ orgId, accountId, deviceId, providerName, service, extension }`, TTL 60 s, consumed with `GETDEL`. `url` = `<http.publicUrl>/device/stream?ticket=<id>`.

- [ ] **Step 1: Failing tests:**
  - `ensureService runs the command review once per start and starts the service` — review spy called with argv `["node", "<entry>", …args]`; second call while running → no review.
  - `review refusal fails closed` — review returns ask/deny → `ensureService` rejects, service not started.
  - `non-owner trigger is refused` — `call.accountId !== call.ownerAccountId` → `DeviceAccessError` code `not_owner`, message equals the Global Constraints text.
  - `undeclared service name is refused` — code `service_not_declared`.
  - `request round-trips to the echo service`.
  - `reportBlockedHosts lands in the call scope` — `callScopeOf(call).blocked.hosts` has the host.
  - `streamTicket refuses a non-owner and mints a single-use 60 s ticket` (Redis TTL ≤ 60).
  - `addNetworkHosts by the owner writes the device allowlist and audits device.network_changed`; by another member → `not_owner`.
  - `answerHandoff answers the call's question with done=true` — question status `answered`, answer `{ done: true }`.
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/device-access/device-access.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun → PASS; `pnpm check:kernel-conventions`.
- [ ] **Step 5:** Commit `feat(kernel): ctx.deviceAccess for extension services`.

---

### Task 8: Viewer endpoint `/device/stream` and the replica hop

**Repo:** core

**Files:**
- Create: `packages/kernel/src/device-access/viewer-routes.ts` (`registerDeviceStreamRoutes(fastify, opts)`: public `GET /device/stream?ticket=` and internal `GET /internal/device-stream/:ticketId`)
- Modify: `packages/kernel/src/http/gateway-routes.ts` (:22, register on the gateway role)
- Modify: `packages/kernel/src/dial-in/routes.ts` (:101-105 the root upgrade hook allows the two new paths)
- Modify: request logging so the `ticket` query value is redacted (`log-config.ts` serializer)
- Test: `packages/kernel/test/device-access/viewer.test.ts` (integration), `packages/kernel/test/device-access/viewer.dual.test.ts` (container; add to `container-tests.json`)

**Interfaces:**
- Consumes: Task 7 tickets; Task 4 `holdForStream`; Task 3 `DialInGateway.holdsLocally/holderAddress/openStream`; provider `openStream`.
- Produces: the WebSocket protocol to the panel: binary messages = the service's stream messages unchanged; close codes `4401` (bad / used ticket), `4404` (device or service gone), `4409` (`device-offline`), `1001` (replica shutdown).

Routing: if the device's provider declares `permissions.dialIn` and this replica does not hold the machine (`holdsLocally` false), open a `ws` client to `<holderAddress>/internal/device-stream/<ticketId>` with header `X-Capybara-Hop: <hex HMAC-SHA256(key, ticketId)>`, key = HKDF-SHA256(master key from `secrets` config :391, info `"device-stream-hop"`), and pipe; the holder validates the HMAC, consumes nothing (the ticket was consumed by the first replica, which forwards the decoded record in the hop's first message) and opens locally. Otherwise call the provider's `openStream` directly. Audit `browser.view` (open) with `{ deviceId, service }` and `browser.view_closed` with duration; frames not audited.

- [ ] **Step 1: Failing tests:**
  - `ticket is single use` — second connect with the same ticket closes `4401`.
  - `ticket bound to device and account` — a ticket for device A never reaches device B's service (the record carries the device; tamper test: edit the Redis record's account → `4401` because the session check compares the record's account with the conversation's owner again).
  - `viewer pipes messages both ways to the echo service`.
  - `open viewer holds the device` — `suspendIdle` skips it while connected.
  - `ticket value never appears in the request log` — capture logs, assert no ticket id.
  - (`viewer.dual.test.ts`) `viewer on the non-holding gateway hops to the holder` with a `FakeDialInMachine` device; `hop with a bad HMAC is refused`.
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/device-access/viewer.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun both files → PASS; `pnpm verify --fast`.
- [ ] **Step 5:** Commit `feat(kernel): device stream viewer endpoint with replica hop`.

---

### Task 9: Embed bridge: panel full mode

**Repo:** core

**Files:**
- Modify: `apps/web/src/lib/embed-bridge.ts` (:372: accept `{ type: "panel-mode", full: boolean }` only from `conversation.panel` embeds; call `o.onPanelMode`)
- Modify: `apps/web/src/components/conversation/RightArea.tsx` (wire `onPanelMode` to `setFull`, :308)
- Modify: `.agents/skills/writing-extension-ui/SKILL.md` and the plugins-facing doc of the bridge messages
- Test: `apps/web/test/embed-bridge.test.ts` (extend), `apps/web/test/right-area-panel-mode.test.tsx`

- [ ] **Step 1: Failing tests:** `panel-mode full=true from a conversation.panel embed maximises the panel`; `panel-mode from another slot is ignored`; `full=false restores`.
- [ ] **Step 2:** `pnpm exec vitest run apps/web/test/embed-bridge.test.ts apps/web/test/right-area-panel-mode.test.tsx` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun → PASS; `pnpm check:web-ui`.
- [ ] **Step 5:** Commit `feat(web): embeds may switch the panel's full mode`.

---

### Task 10: `capybara-device`: services and streams on the machine

**Repo:** core (`packages/device`)

**Files:**
- Create: `packages/device/src/services/supervisor.ts` (start / stop / status of named services under the local sandbox with `process.execPath` as the Node runtime; state dir `<device state>/svc/<name>` kept short for the 104-byte socket limit; restart never automatic)
- Create: `packages/device/src/services/stream-bridge.ts` (dial-in `stream-*` frames ↔ unix socket connections, credit)
- Modify: the device's frame dispatcher (handle `stream-open/data/credit/close`, and provider request bodies `service.ensure | service.stop | service.request` from Task 11)
- Create: `.changeset/device-services.md`
- Test: `packages/device/test/services.test.ts`, `packages/device/test/stream-bridge.test.ts`

**Interfaces:**
- Consumes: Task 2 framing and frames; the existing local sandbox launcher used for operations.
- Produces (request bodies on the existing relay, Task 11 sends them): `{ op: "service.ensure", spec: { name, entry, args, files: Record<string, string /*base64*/>, env } }` → `DeviceServiceStatus`; `{ op: "service.stop", name }`; `{ op: "service.request", name, body: string /*base64*/, timeoutMs }` → `{ body: string }`; `stream-open` body `{ service: string }`.

- [ ] **Step 1: Failing tests:** `ensure writes files and starts the service under the sandbox launcher` (launcher spy receives write roots `[stateDir, <workspace>/downloads]`); `second ensure is a no-op while running`; `service.request round-trips via the socket`; `stream bridge relays messages and honours credit`; `stream closes when the service exits`; `state dir path length stays under 104 bytes for a 32-char service name`.
- [ ] **Step 2:** `pnpm exec vitest run packages/device/test/services.test.ts packages/device/test/stream-bridge.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Network: the service's process gets the same proxy env the sandbox gives operations, and the device reports refused hosts back in `service.request` replies only through the daemon (no new path).
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5:** Commit `feat(device): services and dial-in streams`.

---

### Task 11: `device-local`: service and stream methods

**Repo:** plugins (`plugins/device-local`); needs core Tasks 2, 3, 10 released as prereleases (bump `@capybara-hq/plugin-sdk` with the repo's pnpm override, see memory "plugins repo: one plugin-sdk instance").

**Files:**
- Modify: `plugins/device-local/src/provider.ts` (`ensureService`, `stopService`, `serviceRequest` via `ctx.dialIn.request` with the Task 10 bodies; `openStream` via `ctx.dialIn.openStream(deviceId, { service })`)
- Modify: `plugins/device-local/src/frames.ts` (body types)
- Test: `plugins/device-local/test/services.test.ts`

- [ ] **Step 1: Failing tests** (fake `ctx.dialIn`): `ensureService sends service.ensure with base64 files`; `serviceRequest decodes the reply body`; `openStream delegates to ctx.dialIn.openStream with { service }`; `an offline machine surfaces DeviceOfflineError unchanged`.
- [ ] **Step 2:** `pnpm exec vitest run plugins/device-local/test/services.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun → PASS; `pnpm verify` in plugins.
- [ ] **Step 5:** Commit `feat(device-local): services and streams`; changeset.

---

### Task 12: `device-docker` and `device-e2b`: service and stream methods

**Repo:** plugins

**Files:**
- Modify: `plugins/device-docker/src/provider.ts`, `operations.ts` (service: a supervised process started by `exec` of `node <stateDir>/<entry>` detached under the instance's sandbox user, state dir `/home/user/.capybara/svc/<name>` on the device's persistent volume, pid file; `serviceRequest` / `openStream`: an exec of the bundled relay `capybara-socket-relay <socket>` whose stdin/stdout carry the Task 2 framing)
- Create: `plugins/device-docker/image/capybara-socket-relay.mjs` (+ image build line)
- Modify: `plugins/device-docker/egress-proxy` docs: the service env gets `HTTPS_PROXY` / `HTTP_PROXY` of the egress proxy so `--proxy-server` reaches it
- Modify: `plugins/device-e2b/src/provider.ts` (same via the e2b SDK's background process + stdin/stdout stream)
- Test: `plugins/device-docker/test/services.test.ts` (against the real image in the docker test tier), `plugins/device-e2b/test/services.test.ts` (live, only with `CAPYBARA_TEST_E2B_*`)

- [ ] **Step 1: Failing tests:** `service survives across exec calls and stops on suspend`; `serviceRequest round-trips an echo service`; `openStream relays 50 messages`; `service files land on the persistent volume`; `relay exits when the socket closes`.
- [ ] **Step 2:** `pnpm exec vitest run plugins/device-docker/test/services.test.ts` → FAIL.
- [ ] **Step 3:** Implement docker, then e2b.
- [ ] **Step 4:** Rerun → PASS; e2b live test with the key file loaded only inside the command.
- [ ] **Step 5:** Commit `feat(device-docker,device-e2b): services and streams`; changesets.

---

### Task 13: The browser daemon

**Repo:** plugins (`plugins/browser/daemon`)

**Files:**
- Create: `plugins/browser/daemon/main.ts` (socket server per Task 2 framing; dispatch `request` / `stream` connections)
- Create: `plugins/browser/daemon/chromium.ts` (install-on-first-start into `<state>/browsers` via `playwright-core`'s registry, launch with the Global Constraints flags; macOS uses `chrome-headless-shell --single-process`)
- Create: `plugins/browser/daemon/snapshot.ts` (accessibility tree → text with refs `e<N>`, cap 40000 chars, marker `[truncated: N more nodes]`)
- Create: `plugins/browser/daemon/actions.ts` (navigate, tabs, click / type / select / press / scroll / hover / upload by ref, click_at / type_at, wait, screenshot)
- Create: `plugins/browser/daemon/viewer.ts` (per viewer stream: screencast at the viewer's `maxWidth/maxHeight`, ack-driven; input events; `takeover` / `handback`; tab + navigation state messages; blocked-host messages)
- Create: `plugins/browser/daemon/state.ts` (takeover holder; idle stop after 15 min without requests or viewers; takeover ends 60 s after the last viewer closes)
- Create: `plugins/browser/daemon/protocol.ts` (shared message types, also imported by the panel and the server)
- Test: `plugins/browser/test/daemon/*.test.ts` (real headless Chromium via `playwright-core`, local fixture pages served from a test HTTP server)

**Interfaces:**
- Produces (`protocol.ts`, JSON in each message):

```ts
type ToolRequest =
  | { op: "navigate"; url?: string; action?: "back" | "forward" | "reload" }
  | { op: "tabs"; action: "list" | "open" | "switch" | "close"; tabId?: string; url?: string }
  | { op: "snapshot" }
  | { op: "click" | "hover"; ref: string } | { op: "type"; ref: string; text: string; submit?: boolean }
  | { op: "select"; ref: string; values: string[] } | { op: "press"; key: string }
  | { op: "scroll"; ref?: string; dy: number } | { op: "upload"; ref: string; path: string }
  | { op: "click_at"; x: number; y: number } | { op: "type_at"; x: number; y: number; text: string }
  | { op: "wait"; text?: string; ref?: string; navigation?: boolean; timeoutMs: number }
  | { op: "screenshot"; fullPage?: boolean; maxBytes: number };
type ToolReply =
  | { ok: true; page: { url: string; title: string; tabId: string }; text?: string; image?: string /*base64 jpeg*/;
      blockedHosts: string[]; userControlledSince?: string }
  | { ok: false; error: "taken_over" | "no_such_ref" | "timeout" | "blocked" | "failed"; message: string; blockedHosts: string[] };
type ViewerIn  = { t: "hello"; maxWidth: number; maxHeight: number } | { t: "resize"; maxWidth: number; maxHeight: number }
  | { t: "mouse"; kind: "move" | "down" | "up" | "wheel"; x: number; y: number; button?: "left" | "right"; dx?: number; dy?: number }
  | { t: "key"; kind: "down" | "up" | "char"; key: string; code?: string; text?: string }
  | { t: "nav"; url?: string; action?: "back" | "forward" | "reload" } | { t: "tab"; action: "open" | "switch" | "close"; tabId?: string }
  | { t: "takeover" } | { t: "handback" } | { t: "frame-ack"; seq: number };
type ViewerOut = { t: "frame"; seq: number; jpeg: string; width: number; height: number }
  | { t: "state"; tabs: { id: string; title: string; url: string; active: boolean }[]; loading: boolean; secure: boolean;
      control: "agent" | "user"; lastClick?: { x: number; y: number } }
  | { t: "blocked"; host: string; url: string } | { t: "dialog"; kind: "alert" | "confirm" | "prompt" | "file"; message: string };
```

- [ ] **Step 1: Failing tests:**
  - `navigate then snapshot lists the fixture's button as a ref`.
  - `click by ref submits the fixture form`.
  - `snapshot caps at 40000 chars with a marker` (fixture with 50k nodes).
  - `screenshot fits the frame capacity` — `maxBytes: 200000` → base64-decoded size ≤ 200000 (quality / scale reduced until it fits).
  - `viewport stays 1280x800 after a viewer resize` — `window.innerWidth` 1280 after `resize` to 400×250.
  - `viewer receives frames no larger than its maxWidth`.
  - `agent input refused while taken over from any viewer` — two request connections both get `taken_over`.
  - `takeover ends 60 s after the last viewer closes` — use the state module with an injected clock.
  - `blocked navigation is reported with its host` — a proxy fixture refusing `blocked.test` → reply `blockedHosts: ["blocked.test"]` and a viewer `blocked` message.
  - `alert dialog surfaces to tool reply and viewer`.
  - `profile persists across daemon restarts` — set a cookie, restart, cookie present.
- [ ] **Step 2:** `pnpm exec vitest run plugins/browser/test/daemon` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5:** Commit `feat(browser): daemon`.

---

### Task 14: The browser panel (embed page)

**Repo:** plugins (`plugins/browser/src/panel`)

**Files:**
- Create: `plugins/browser/src/panel/page.ts` (HTML of `/ui/browser`), `panel.ts` (canvas renderer, scale and letterbox, coordinate mapping, input capture, tab strip, address bar, back / forward / reload, status line, last-click flash, 接管 / 交还智能体, `Esc`, blocked-host bar with 允许, empty state, reconnect), `i18n.ts` (zh / en)
- Test: `plugins/browser/test/panel/*.test.ts` (jsdom, a fake WebSocket and fake embed bridge)

**Interfaces:**
- Consumes: Task 13 `ViewerIn` / `ViewerOut`; plugin routes from Task 15 (`POST /ui/stream-ticket` → `{ url }`, `POST /ui/network-hosts` `{ hosts }`, `POST /ui/handoff-answer` `{ callId, done }`); Task 9 bridge message `{ type: "panel-mode", full }`.

- [ ] **Step 1: Failing tests:**
  - `maps a click at canvas (240,150) in a 480x300 view to page (640,400)`.
  - `letterboxes a 16:10 frame inside a 480x400 panel`.
  - `takeover sends takeover and asks the host for panel-mode full`; `Esc sends handback and panel-mode full=false`.
  - `typing in the address bar and Enter sends nav with the url`.
  - `allow button adds the host and reloads` — posts `/ui/network-hosts` then sends `nav reload`.
  - `panel shows reconnect after device-offline close` (close code 4409) and fetches a new ticket on click.
  - `empty state when the ticket route answers service_not_running`.
  - `all visible strings come from i18n in zh and en`; zh strings contain no `企业` and no Latin `agent`.
- [ ] **Step 2:** `pnpm exec vitest run plugins/browser/test/panel` → FAIL.
- [ ] **Step 3:** Implement. If the sandboxed embed (opaque origin, `connect-src 'self'`) cannot open the WebSocket in Chromium and WebKit headless checks, add the web origin's `ws(s)` URL to the plugin-ui CSP in core (`apps/web/src/lib/plugin-ui-proxy.ts:58`) as a follow-up commit in Task 9's area.
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5:** Commit `feat(browser): panel`.

---

### Task 15: The browser plugin server: tools, routes, manifest

**Repo:** plugins (`plugins/browser`)

**Files:**
- Create: `plugins/browser/.capybara-plugin/plugin.json`, `package.json`, `README.md`, `icon.svg`
- Create: `plugins/browser/src/index.ts` (`defineExtension`: `permissions.deviceAccess: { services: ["browser"] }`, `permissions.http` embed routes, `ui: [{ id: "browser", slot: "conversation.panel", kind: "embed", path: "/ui/browser", icon: "globe", title: { zh: "浏览器", en: "Browser" } }]`)
- Create: `plugins/browser/src/tools.ts` (the 15 tools; each handler: owner check → `ensureService` (daemon bundle as `files`) → `request` → `reportBlockedHosts(reply.blockedHosts)` → result; `taken_over` → `ToolError("The user is controlling the browser; call browser_wait or browser_handoff.")`; first result after a takeover prefixed `The user controlled the browser from <time>; now at <url> (<title>).`; screenshot returns an image block)
- Create: `plugins/browser/src/handoff.ts` (`browser_handoff`: `InputRequired` with form `{ done: boolean }` labelled 完成 / 取消 and the message; on resume, reply the new page state or `ToolError("The user cancelled the handoff.")`)
- Create: `plugins/browser/src/routes.ts` (`/ui/stream-ticket`, `/ui/network-hosts`, `/ui/handoff-answer` → `ctx.deviceAccess.*` with `caller.accountId` and `caller.conversationId`)
- Modify: `.capybara-plugin/marketplace.json` (optional plugin entry)
- Test: `plugins/browser/test/tools.test.ts`, `plugins/browser/test/routes.test.ts`

**Interfaces:**
- Tool keys (no dots): `browser_navigate`, `browser_tabs`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_select`, `browser_press`, `browser_scroll`, `browser_hover`, `browser_upload`, `browser_click_at`, `browser_type_at`, `browser_wait`, `browser_handoff`; policies per Global Constraints.

- [ ] **Step 1: Failing tests** (fake `ctx.deviceAccess`):
  - `navigate ensures the service then requests navigate`.
  - `non-owner trigger fails with the owner message`.
  - `blocked hosts are reported to deviceAccess`.
  - `taken_over maps to the actionable ToolError`.
  - `first result after takeover carries the user-control note`.
  - `click declares defaultPolicy ask and snapshot declares allow` (all 15 checked against the table).
  - `handoff returns InputRequired then resumes with the page state`; `cancel resumes with the cancel error`.
  - `stream-ticket route passes caller account and conversation`; `routes refuse a platform-scope caller`.
  - `tool descriptions are English and pass validateToolSpec`.
- [ ] **Step 2:** `pnpm exec vitest run plugins/browser/test/tools.test.ts plugins/browser/test/routes.test.ts` → FAIL.
- [ ] **Step 3:** Implement; `capybara-plugin check` passes.
- [ ] **Step 4:** Rerun → PASS; `pnpm verify` in plugins.
- [ ] **Step 5:** Commit `feat(browser): plugin tools, routes and manifest`; changeset (first prerelease `0.1.0-rc.0`).

---

### Task 16: End-to-end acceptance and release

**Repo:** both

- [ ] **Step 1:** Release core prereleases (sdk, kernel, device) through the Version Packages PR; release plugins (device-local, device-docker, device-e2b, browser).
- [ ] **Step 2:** Dev stack (local yaml config, never the main `.env`): import `browser`, switch it on in the test org; with a docker device, ask the agent to open a public page, snapshot, click; open the panel, watch frames, take over, type a URL, hand back. Expected: frames under ~200 KB/s in the side panel; agent resumes with the user-control note.
- [ ] **Step 3:** Same with the local Mac device; log in to a test site in takeover, start a new conversation, confirm the agent is logged in (profile persisted).
- [ ] **Step 4:** Allowlist device: navigate to a new host from a tool call → ask in the conversation with only "always"; approve → host in the device page's list. During takeover → panel bar 允许.
- [ ] **Step 5:** Second account sends a message in the owner's group conversation → browser tool fails with the owner message.
- [ ] **Step 6:** Two gateway replicas (compose scale) + local device: open the viewer repeatedly until it lands on the non-holding replica; frames flow (hop); Redis `MONITOR` shows no frame traffic.
- [ ] **Step 7:** Record results in the PR; open follow-up issues for phase 2 (viewport switch, touch takeover, auto-open panel on handoff).

## Spike results

Task 1, run 2026-11-24 with `playwright-core` 1.65.1, Chromium/headless-shell 159.0.8154.6, over a pipe. By controller ruling the script ran directly on this Mac and in a plain container, not through a conversation or `capybara-device`. Setup: viewport 1280×800, `launchPersistentContext` with a scratch profile, `Page.startScreencast` JPEG quality 60, every frame acked.

| | macOS headless-shell, `--single-process --use-mock-keychain` | docker (Playwright image, linux headless-shell, default flags) |
|---|---|---|
| 20 frames written, acked | pass | pass |
| mouse click via `Input.dispatchMouseEvent` navigates (example.com to iana.org) | pass | pass |
| `Target.createTarget` + second page, `Target.getTargets` lists pages | pass (3 pages) | pass (3 pages) |
| median frame, maxWidth 480×300 (example.com) | 7.1 KB | 6.2 KB |
| median frame, 1280×800 (colorful tall page, scrolling) | 169 KB | 162 KB |
| fps while wheel-scrolling, 480×300 (wheel event every 16 ms) | 60 | 60 |
| fps while wheel-scrolling, 1280×800 | 60 | 60 |
| median frame while scrolling, 480×300 / 1280×800 | 39 KB / 170 KB | 38 KB / 163 KB |
| RSS, 3 tabs (sum of `ps`) | 304 MB | 634 MB (multi-process, shared pages counted per process) |

Result: pass on both platforms.

Gotchas:
- Screencast emits frames only when the page changes; a static page gives 1 or 2 frames and then nothing. The viewer must not treat a quiet stream as a dead one (keep the last frame; use a keepalive or `Page.captureScreenshot` on connect).
- `--user-data-dir` cannot be passed as an arg through Playwright's `launch()`; use `launchPersistentContext(dir)`, which is also what the profile persistence needs.
- Wheel scrolling at full 1280×800 produces about 10 MB/s of frames at 60 fps (170 KB each), far over the ~200 KB/s target. The viewer needs a frame-rate cap (a few fps, ack-paced) and a small `maxWidth`; at 480×300 and 5 fps scrolling is about 200 KB/s, so the target holds only with that cap.
- `--single-process` ran stably on macOS for the whole script, including navigation, a click and tab creation. Docker ran without it and without `--no-sandbox` problems under the Playwright image (root user, Playwright adds `--no-sandbox`).
- The chromium build resolved by playwright-core 1.65 for `headless: true` is `chromium-headless-shell` on both platforms; a full Chromium "new headless" build was not exercised.
