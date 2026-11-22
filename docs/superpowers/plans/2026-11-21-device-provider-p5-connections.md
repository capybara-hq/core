# Device Providers Phase 5: Many Connections per Machine, `device@2`, Desktop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task, layered with
> `wave-planned-subagent-development`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One machine holds many connections (different deployments, different orgs of one
deployment), each with its own state directory, runner, login service and limits, isolated from the
others; the desktop speaks `device@2` per connection and per deployment, and its tray shows every
connection.

**Architecture:** `capybara-device` keeps machine-wide `machine.json` and one
`connections/<deviceId>/` directory per connection; every command resolves one connection
(`--connection` / `-c`, implied when there is one) and then runs exactly as today against that
connection's directory, so most command bodies are unchanged. Each runner denies every other
connection's state and working directory. The SDK replaces `DeviceCapabilityV1` with
`DeviceCapabilityV2`; the web mirrors it and looks connections up by device; the desktop reads
every connection's control socket and answers a window only about its own deployment.

**Tech Stack:** TypeScript, Node 22 (`packages/device`), NestJS kernel (one small token change),
Next.js + TanStack Query web, Electron main process (capybara-hq/clients), vitest.

**Spec:** `docs/superpowers/specs/2026-11-21-device-provider-design.md` §7.2, §7.3, §7.4, §8, §9,
§13 (the spec wins). Index: `docs/superpowers/plans/2026-11-21-device-provider.md`.


## Reconciliation (index rulings; these win over the tasks below)

- R2: bump the protocol to 6 only if phase 4 has not already bumped it since the last `@capybara-hq/device` release.
- R10: Task 5 is dropped (phase 4 Tasks 6, 11); Task 9 only adds `-c` to `ceiling`.
- R11: the control socket is `$XDG_CONFIG_HOME/capybara-device/run/<first 16 hex of sha256(deviceId)>.sock` (`run/` 0700), pid file in `connections/<deviceId>/`; `status --json` carries `controlSocket` per connection and Task 12 reads socket paths from it.
- R12: `machine.json` is `{ "version": 1 }` only.
- R13, R14: as Task 3 already proposes (`useThisMachineDeviceIds`, `DeviceRunningOp`).
- R15: Task 6 replaces phase 3's `device@1.connect` wiring.

## Global Constraints

The index's Global Constraints apply in full. Phase-specific:

- Phase 2 is merged before this phase starts (protocol 5, the `device-protocol` SDK subpath,
  `device-local`, `src/dial-in/`). Phase 4 may run alongside: phase 4 owns `packages/device/src/exec/`
  and `policy*`; this phase changes `exec/operation-types.ts` (Task 5) and `owner-report.ts`
  (Task 10) first, and phase 4 rebases on them.
- Layout under `$XDG_CONFIG_HOME/capybara-device` (mode 0700): `machine.json` (`{ "version": 1 }`,
  0600) and `connections/<deviceId>/` (0700) holding `credential.json`, `policy.json`,
  `policy-ops.json`, `policy.json.lock`, `commands.log`, `service.log`, `control.sock`, `pid`, and the
  runner's other private files (owner report sidecar, operation journals, `projects.json`).
- A `deviceId` becomes a path segment only after matching `/^[A-Za-z0-9_-]{1,128}$/`
  (`DEVICE_ID_PATTERN`, the desktop's existing `ID_PATTERN`).
- The flat layout (`credential.json` / `policy.json` directly in the state directory) is never read,
  moved or deleted; the old `top.capybara.device` agent and `capybara-device.service` unit are
  never touched.
- `login` never refuses because a connection exists; `logout -c X` removes only X's credential and
  login service (X's `policy.json` stays for a re-login into the same device).
- Exit codes: a command whose selector finds nothing exits 1, except `start`, which exits 0 (a
  service of a logged-out connection must stay stopped).
- Every device test runs under a fresh `mkdtemp` `XDG_CONFIG_HOME` and `HOME` passed through
  `CliEnv.env` / `CliEnv.home` or the function's `machineDir` argument; no test reads `process.env.HOME`
  or the real `~/.config/capybara-device`. Service tests use the injected `runSystem`; desktop tests
  use `test/device/fake-device.ts`, never launchctl or the Keychain.
- Clients: `@capybara-hq/device` and `@capybara-hq/plugin-sdk` at the exact versions the core
  release of this phase publishes (Tasks 12, 13).

## Review Focus

- (index) A sandboxed command of connection A reading connection B's working directory or state
  must fail, also with project reach `machine` and with a project directory that is a symlink into
  B: Task 5 pins it (unit + macOS OS test + Linux OS test).
- (index) `login` into a device this machine already serves must never create a second connection
  of that device; it replaces the credential in place (same directory, same policy): Task 7.
- (index) A desktop page must never learn connections to other deployments, and a `device@2` call
  naming a device of another deployment must refuse: Task 13.
- A deployment answering the token with a `deviceId` such as `../x` or `a/b`: nothing is written
  outside `connections/`, login fails with `invalid_device_id`: Tasks 1 and 7.
- A long home directory: `connections/<uuid>/control.sock` passes the 103-byte socket limit when
  the user name is longer than about 10 characters on macOS; the runner keeps serving and `status`
  says why there is no live state (existing `controlUnavailableReason`): Task 8 pins it (see Index
  issues).
- One connection's unreadable `credential.json` (mode 0644, bad JSON) must not hide or block the
  others; `status` names it and `logout -c <deviceId>` still removes it: Tasks 1, 8, 9.
- A login service whose connection was logged out (`start -c <id>` with no credential) exits 0 and
  is not restarted by launchd / systemd: Task 9.

---

## Waves

| Wave | Tasks | Repo | Notes |
|---|---|---|---|
| 1 | 1, 2, 3 | core | disjoint: device layout; kernel token; SDK + web types |
| 2 | 4, 5, 6 | core | 5 is reviewed alone |
| 3 | 7 | core | login.ts, api.ts, its cli.ts line |
| 4 | 8 | core | status.ts, its cli.ts line (serial with 7: both touch cli.ts) |
| 5 | 9, 10 | core | cli/args/commands / project roots + owner report + SDK protocol |
| — | core PR → SDK + device release (index Release order 3) | | |
| 6 | 11, 12 | plugins / clients | 11 after the SDK release; 12 after the device release |
| 7 | 13 | clients | reviewed alone |
| 8 | 14 | clients | tray |

Tasks 12–14 are one clients PR; Task 12 leaves `readMachine` / `Machine` in place for Task 14 to
remove (they are internal to the desktop, not a compatibility layer).

---

### Task 1: Connection layout and resolver (`packages/device`)

**Files:**
- Create: `packages/device/src/connections.ts`
- Modify: `packages/device/src/state.ts:22-35` (Credential gains two optional fields), `:157-185`
  (path helpers stay, now applied to a connection directory)
- Modify: `packages/device/src/pid.ts:6-8` (`pidPath` → `join(dir, "pid")`)
- Modify: `packages/device/src/index.ts` (export the connection API and `ConnectionInfo`)
- Test: `packages/device/test/connections.test.ts` (new); `packages/device/test/state.test.ts`
  (pid path)

**Interfaces:**
- Produces (in `src/connections.ts`):
  ```ts
  export const CONNECTIONS_DIR = "connections";
  export const MACHINE_FILE = "machine.json";
  export const MACHINE_FORMAT_VERSION = 1;
  export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
  export interface ConnectionInfo {
    deviceId: string; orgId: string; url: string; /** URL host[:port] */ host: string;
    deviceName: string | null; orgName: string | null;
    /** connections/<deviceId> */ stateDir: string; /** the credential's working directory */ workDir: string;
    mode: DeviceMode;
  }
  export function connectionsDir(machineDir: string): string;
  /** Throws Error("Invalid device id …") unless DEVICE_ID_PATTERN matches. */
  export function connectionDir(machineDir: string, deviceId: string): string;
  export function machineDirOfConnection(connectionStateDir: string): string;
  /** Creates machineDir (0700) and machine.json {version:1} (0600) when absent; throws on another version. */
  export function ensureMachineFile(machineDir: string): void;
  /** Readable connections, sorted by host, then deviceName, then deviceId. Skips non-directories,
   *  symlinks, names failing DEVICE_ID_PATTERN, dirs without credential.json, unreadable ones. */
  export function listConnections(machineDir?: string /* default stateDir() */): ConnectionInfo[];
  export function unreadableConnections(machineDir?: string): Array<{ deviceId: string; reason: string }>;
  export class ConnectionSelectError extends Error {
    readonly code: "no_connection" | "not_found" | "ambiguous";
    readonly candidates: ConnectionInfo[];
  }
  /** deviceId exact, else deviceName exact, else host exact; implied when exactly one exists. */
  export function resolveConnection(selector?: string, machineDir?: string): ConnectionInfo;
  /** "host · orgName|orgId · deviceName|deviceId (deviceId)": one line of a listing. */
  export function connectionLine(c: ConnectionInfo): string;
  ```
- Produces (in `src/state.ts`): `Credential` gains `deviceName?: string; orgName?: string`
  (validated as strings when present). `credentialPath`, `policyPath`, `policyOpsPath`,
  `policyLockPath`, `writeCredential`, `readCredential`, `readPolicy*`, `withPolicyLock` keep their
  signatures; their `dir` argument is now a connection's `stateDir`.

- [ ] **Step 1: Write the failing tests** (`test/connections.test.ts`; every test builds its
  machine dir under `mkdtemp`, writes credentials with `writeCredential(connectionDir(m, id), …)`)

  ```ts
  it("lists every connection under connections/ and ignores the old flat files", () => {
    // flat credential.json + policy.json in m, connections dev-a (a.example.com) and dev-b (b.example.com)
    expect(listConnections(m).map((c) => c.deviceId)).toEqual(["dev-a", "dev-b"]);
    expect(listConnections(m)[0]).toMatchObject({ host: "a.example.com", stateDir: join(m, "connections", "dev-a") });
  });
  it("resolves by deviceId, device name or host", () => {
    expect(resolveConnection("dev-b", m).deviceId).toBe("dev-b");
    expect(resolveConnection("Laptop B", m).deviceId).toBe("dev-b");     // deviceName
    expect(resolveConnection("a.example.com", m).deviceId).toBe("dev-a");
  });
  it("implies the only connection", () => { /* one dir */ expect(resolveConnection(undefined, m).deviceId).toBe("dev-a"); });
  it("refuses with several and none given, listing them", () => {
    const e = catchError(() => resolveConnection(undefined, m)) as ConnectionSelectError;
    expect(e.code).toBe("ambiguous");
    expect(e.message).toContain(connectionLine(listConnections(m)[0]!));
    expect(e.message).toContain("--connection");
  });
  it("a host shared by two connections is ambiguous; an unknown selector is not_found; none is no_connection", …);
  it("connectionDir refuses an id that is not a safe path segment", () => {
    for (const id of ["../x", "a/b", "", ".", "x".repeat(129)]) expect(() => connectionDir(m, id)).toThrow(/Invalid device id/);
  });
  it("skips a connection directory that is a symlink and lists an unreadable one separately", () => {
    // symlink connections/dev-s -> elsewhere; dev-u credential chmod 0644
    expect(listConnections(m).map((c) => c.deviceId)).toEqual(["dev-a"]);
    expect(unreadableConnections(m)).toEqual([{ deviceId: "dev-u", reason: expect.stringContaining("readable by other users") }]);
  });
  it("machine.json is written 0600 with version 1; another version is refused", …);
  it("each connection's pid, control socket and policy live in its own directory", () => {
    const d = connectionDir(m, "dev-a");
    expect([pidPath(d), controlSocketPath(d), policyPath(d)]).toEqual([join(d, "pid"), join(d, "control.sock"), join(d, "policy.json")]);
  });
  ```

- [ ] **Step 2: Run to verify failure**

  Run: `pnpm exec vitest run packages/device/test/connections.test.ts packages/device/test/state.test.ts`
  Expected: FAIL, `Cannot find module '../src/connections.js'`.

- [ ] **Step 3: Implement** the signatures above in `src/connections.ts`; `pidPath` returns
  `join(dir, "pid")`; `readCredential` accepts the optional names. `listConnections` uses
  `lstatSync` (never follows a link) and `readCredential` per directory; a throw moves that id to
  `unreadableConnections`. Export `ConnectionInfo`, `listConnections`, `resolveConnection`,
  `connectionDir`, `connectionsDir`, `DEVICE_ID_PATTERN` from `src/index.ts`.

- [ ] **Step 4: Run to verify pass** (same command). Expected: PASS. Fix the existing tests that
  named `capybara-device.pid` (`grep -rl "capybara-device.pid" packages/device/test`).

- [ ] **Step 5: Commit**

  ```bash
  git add packages/device/src/connections.ts packages/device/src/state.ts packages/device/src/pid.ts packages/device/src/index.ts packages/device/test
  git commit -m "feat(device): per-connection state layout and connection resolver

  Co-Authored-By: Capybara <noreply@capybarahq.com>"
  ```

---

### Task 2: The token names the device and the org (`packages/kernel`)

**Files:**
- Modify: the `token` method of `DialInAuthService` (phase 2's move of
  `packages/kernel/src/local-devices/device-auth.ts:233-265`) and its `DeviceGrant` interface
  (`:127-138`); the controller's doc comment of `POST /token`
- Test: the dial-in auth integration test (phase 2's move of
  `packages/kernel/test/local-devices/device-auth.test.ts`)
- Create: `.changeset/device-token-names.md` (`@capybara-hq/kernel` patch)

**Interfaces:**
- Produces: `DeviceGrant` gains `deviceName: string` (the device row's `name`, or the
  provider's display fallback when null) and `orgName: string` (`orgs.name`). The device program
  stores them (Task 7) for `status` and the selector.

- [ ] **Step 1: Write the failing test** in the existing "full flow" block:

  ```ts
  it("the token names the device and the organization", async () => {
    // authorize → confirm with name "Build box" in org "Acme" → token
    expect(grant).toMatchObject({ deviceName: "Build box", orgName: "Acme" });
  });
  ```

- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/dial-in/device-auth.test.ts`
  (or the moved path). Expected: FAIL, `deviceName` undefined.

- [ ] **Step 3: Implement**: in the `approved` branch read `devices.name` by `(grant.orgId,
  grant.deviceId)` and `orgs.name` by `grant.orgId` in the same `Promise.all` as the policy reads;
  both are scoped by the grant's own ids (no other org is read).

- [ ] **Step 4: Run** (same). Expected: PASS.

- [ ] **Step 5: Commit** `feat(kernel): device token carries the device and organization names`
  with the Co-Authored-By line.

---

### Task 3: `device@2` in the SDK and the web

**Files:**
- Modify: `packages/plugin-sdk/src/shell-capabilities.ts:10-80` (key, types)
- Modify: `packages/plugin-sdk/src/shell-environment.ts:48` (`"device@2"`)
- Modify: `packages/plugin-sdk/test/shell-capabilities.test.ts`,
  `packages/plugin-sdk/test/shell-environment.test.ts:11`
- Modify: `packages/plugin-sdk/api/plugin-sdk.api.md` (by `pnpm gen:sdk-api`)
- Create: `.changeset/shell-device-v2.md` (`@capybara-hq/plugin-sdk` minor)
- Modify: `apps/web/src/lib/shell.ts:190-270,438-439` (mirror; `useDeviceCapability` returns
  `DeviceCapabilityV2 | undefined`)
- Modify: `apps/web/src/lib/use-this-machine.ts` (whole file),
  `apps/web/src/lib/query/device-status.ts`, `apps/web/src/lib/query/device-running.ts`,
  `apps/web/src/lib/query/keys.ts:525-527`
- Modify: `apps/web/src/components/ThisMachineSection.tsx:55-222`,
  `apps/web/src/app/(app)/devices/view.tsx:40,74`,
  `apps/web/src/components/conversation/useSelection.ts:246,271`,
  `apps/web/src/components/DeviceCreateDialog.tsx` (only the `connect` call and the
  `connected_elsewhere` block, if phase 3 left them), `apps/web/messages/{en,zh}.json`
  (`devices.create.connectedElsewhere` deleted if still present)
- Test: `apps/web/test/shell-types-mirror.test.ts` (unchanged, must pass),
  `apps/web/test/devices-this-machine.test.tsx`, `apps/web/test/devices.test.tsx`,
  `apps/web/test/shell-adapter.test.tsx`

**Interfaces:**
- Produces (SDK, exactly the index's shapes): `SHELL_CAPABILITY_KEYS.device = "device@2"`;
  `ThisMachineConnection`; `DeviceCapabilityV2`; `DeviceRunningOp` (today's
  `RunningOperationView`, renamed, same fields); `KeepAwakeMode` and `DeviceConnection` stay.
  Deleted: `ThisMachineStatus`, `DeviceCapabilityV1`, `RunningOperationView`.
  `DeviceCeilingRequest` = exactly the fields `capybara-device ceiling set` takes after phases 2
  and 4 (expected `{ outsideSandbox?: boolean; projectReach?: "machine" | "paths" | "workspace" }`;
  if phase 4 already changed it, keep phase 4's).
- Produces (web, `use-this-machine.ts`):
  ```ts
  export function useThisMachine(): { cap: DeviceCapabilityV2 | undefined; connections: ThisMachineConnection[] | undefined };
  export function useIsThisMachine(orgId: string, deviceId: string):
    { cap: DeviceCapabilityV2; connection: ThisMachineConnection } | undefined;
  /** This machine's device ids in the org (empty in a browser); see Index issues. */
  export function useThisMachineDeviceIds(orgId: string): ReadonlySet<string>;
  ```
  `keys.shell().running(deviceId: string)`; `deviceRunningQuery(cap, deviceId)` calls
  `cap.running({ deviceId })`; `deviceStatusQuery(cap)` returns `{ connections }`.

- [ ] **Step 1: Write the failing tests**

  SDK (`shell-capabilities.test.ts`):
  ```ts
  it("names the capability keys as name@major", () => expect(SHELL_CAPABILITY_KEYS.device).toBe("device@2"));
  it("device@2 acts per device and connects by org", () => {
    expectTypeOf<DeviceCapabilityV2["pause"]>().parameters.toEqualTypeOf<[{ deviceId: string }]>();
    expectTypeOf<Awaited<ReturnType<DeviceCapabilityV2["status"]>>>().toEqualTypeOf<{ connections: ThisMachineConnection[] }>();
    expectTypeOf<Awaited<ReturnType<DeviceCapabilityV2["connect"]>>>().toEqualTypeOf<"connected" | "cancelled" | { error: string }>();
  });
  ```
  Web (`devices-this-machine.test.tsx`, fake shell with two connections `dev-1` and `dev-2` in
  `org_1`):
  ```ts
  it("本机 on each of this machine's devices, with that device's running list and actions", …
    // device page dev-2: running list from running({deviceId:"dev-2"}); 暂停 calls pause({deviceId:"dev-2"})
  it("the device list marks both of this machine's devices 本机", …
  it("the new-conversation picker tags both devices 本机", …
  it("a keep-awake choice calls setKeepAwake({ deviceId, mode })", …
  it("another device, another org, or a browser: no 本机", …
  ```

- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/shell-capabilities.test.ts apps/web/test/devices-this-machine.test.tsx apps/web/test/shell-types-mirror.test.ts`
  Expected: FAIL (key is `device@1`; hooks answer the old shape).

- [ ] **Step 3: Implement** the SDK types; copy the SDK slice byte for byte into `lib/shell.ts`
  (the mirror test compares from `SHELL_CAPABILITY_KEYS` to `useDeviceCapability`); rewrite the
  hooks and their callers to the signatures above (`ThisMachineSection` passes `device.id` into every
  call and the running query). `pnpm gen:sdk-api`; write the changeset.

- [ ] **Step 4: Run** the Step 2 command plus `pnpm exec vitest run apps/web/test/devices.test.tsx apps/web/test/shell-adapter.test.tsx packages/plugin-sdk/test/shell-environment.test.ts`
  and `pnpm check:sdk-api`, `pnpm check:web-ui`, `pnpm check:i18n`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(plugin-sdk,web): device@2 shell capability, per-connection lookups`
  with the Co-Authored-By line.

---

### Task 4: One login service per connection (`packages/device`)

**Files:**
- Modify: `packages/device/src/service/launchd.ts:4-74`, `service/systemd.ts:4-33`,
  `service/installed.ts:9-13`, `service/manager.ts:18-128`, `src/commands/service.ts`
  (every `plistPath` / `unitPath` / `SYSTEMD_UNIT` / `launchdTarget` use)
- Modify (call sites only): `src/commands/start.ts:98-108`, `src/commands/stop.ts:21-42`,
  `src/commands/login.ts:293-297`
- Test: `packages/device/test/service.test.ts`, `packages/device/test/service-control.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const LAUNCHD_LABEL_PREFIX = "top.capybara.device.";
  export function launchdLabel(deviceId: string): string;            // top.capybara.device.<deviceId>
  export function plistPath(home: string, deviceId: string): string; // ~/Library/LaunchAgents/<label>.plist
  export interface ServiceSpec { nodePath: string; binPath: string; stateDir: string /* connection dir */; deviceId: string; env: Record<string, string> }
  export const SYSTEMD_TEMPLATE = "capybara-device@.service";
  export function systemdUnit(deviceId: string): string;            // capybara-device@<deviceId>.service
  export function unitPath(home: string): string;                   // the template file
  export function unitWantsLink(home: string, deviceId: string): string; // default.target.wants/<unit>
  export function hasLoginService(home: string, platform: NodeJS.Platform, deviceId: string): boolean;
  export interface ServiceWhere { home: string; platform: NodeJS.Platform; uid?: number; deviceId: string }
  export function launchdTarget(uid: number | undefined, deviceId: string): { domain: string; service: string };
  export function startedByServiceManager(env: Record<string, string | undefined>, deviceId: string, pid?: number): boolean;
  export interface ServiceDeps { /* today's fields */ deviceId: string }  // stateDir = connection dir
  ```
  `plistContent` runs `[node, bin, "start", "--connection", deviceId]`, logs to
  `<stateDir>/service.log`; the systemd template's `ExecStart` ends with `start --connection %i`
  (the `%i` written unescaped; every other word still through `word()`). Install writes the
  template when absent and `systemctl --user enable` + `restart` of `systemdUnit(id)`; uninstall
  `disable --now` the instance and removes the template only when no
  `capybara-device@*.service` link remains in `default.target.wants`.

- [ ] **Step 1: Write the failing tests**

  ```ts
  it("the plist's label and arguments name the connection", () => {
    const c = plistContent({ ...spec, deviceId: "dev-1", stateDir: join(m, "connections", "dev-1") });
    expect(c).toContain("<string>top.capybara.device.dev-1</string>");
    expect(c).toMatch(/<string>start<\/string>\s*<string>--connection<\/string>\s*<string>dev-1<\/string>/);
    expect(c).toContain(join(m, "connections", "dev-1", "service.log"));
  });
  it("two connections install two agents side by side; uninstalling one leaves the other", async () => {
    // runSystem fake records calls; plist files exist for dev-1 and dev-2 after both installs
    expect(calls).toContainEqual(["launchctl", ["bootstrap", "gui/501", plistPath(home, "dev-2")]]);
    // uninstall dev-1: dev-2's plist remains, no call names gui/501/top.capybara.device.dev-2
  });
  it("systemd: one template, one enabled instance per connection", async () => {
    expect(readFileSync(unitPath(home), "utf8")).toMatch(/ExecStart=.* start --connection %i$/m);
    expect(calls).toContainEqual(["systemctl", ["--user", "enable", "capybara-device@dev-1.service"]]);
    // uninstall of the last instance removes the template; of a non-last one keeps it
  });
  it("startedByServiceManager matches only this connection's label", () => {
    expect(startedByServiceManager({ XPC_SERVICE_NAME: "top.capybara.device.dev-1" }, "dev-1")).toBe(true);
    expect(startedByServiceManager({ XPC_SERVICE_NAME: "top.capybara.device.dev-2" }, "dev-1")).toBe(false);
    expect(startedByServiceManager({ XPC_SERVICE_NAME: "top.capybara.device" }, "dev-1")).toBe(false);
  });
  it("the old top.capybara.device agent and capybara-device.service unit are never touched", async () => {
    // install + uninstall for dev-1 with an old plist present: no call argument equals
    // "gui/501/top.capybara.device" or "capybara-device.service"; the old plist file is unchanged
  });
  ```

- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/service.test.ts packages/device/test/service-control.test.ts`
  Expected: FAIL (`launchdLabel` not exported; label is `top.capybara.device`).

- [ ] **Step 3: Implement** the signatures; `start.ts` passes `cred.deviceId`, `stop.ts` reads the
  connection's credential for its `deviceId` (no credential: `signalRunning` as today),
  `login.ts` passes `granted.deviceId`.

- [ ] **Step 4: Run** (same, plus `packages/device/test/start.test.ts packages/device/test/login.test.ts`).
  Expected: PASS.

- [ ] **Step 5: Commit** `feat(device): one launchd agent / systemd instance per connection`
  with the Co-Authored-By line.

---

### Task 5: Each runner denies the other connections [review alone, most capable model]

Trust boundary: what one deployment's sandboxed work can read of another deployment's connection.

**Files:**
- Modify: `packages/device/src/connections.ts` (add `otherConnectionPaths`)
- Modify: `packages/device/src/exec/operation-types.ts:75-115` (`readStrictOwnerCeilingSync`:
  denied roots and revision), `:137-160` (`checkRoots`: canonical form of each root)
- Modify: `packages/device/src/commands/ceiling.ts:8-21` and the widening path (extra risk text)
- Test: `packages/device/test/connection-isolation.test.ts` (new, unit);
  `packages/device/test/mac-read-scope.test.ts` and `packages/device/test/linux-operation-backend.test.ts`
  (OS tests, already in `test/os-tests.json`)

**Interfaces:**
- Consumes: Task 1 `listConnections`, `unreadableConnections`, `connectionDir`,
  `machineDirOfConnection`.
- Produces:
  ```ts
  /** Every other connection's working directory (readable or not: an unreadable one's
   *  connectionDir is covered by the machine dir), canonical forms included. */
  export function otherConnectionPaths(machineDir: string, selfDeviceId: string): string[];
  export const OTHER_CONNECTIONS_RISK_TEXT: string; // in commands/ceiling.ts
  ```
  `restrictedDeniedReadRoots = withCanonicalForms([...deniedSecretPaths(home),
  resolve(machineDirOfConnection(stateDir)), ...otherConnectionPaths(machineDir, deviceId)])`
  (the whole state root replaces today's `resolve(input.stateDir)`); the revision digest includes
  the denied roots, so a connection added or removed changes the revision and the next
  `readOwnerCeiling()` (called fresh per operation in `staged-device.ts:184`) applies it.
  `checkRoots` refuses a root whose canonical form (`withCanonicalForms([root])`) is within a
  denied root. `OTHER_CONNECTIONS_RISK_TEXT` = "Other connections on this computer (to other
  platforms or organizations) keep their files here: a call running outside the sandbox can read
  them too." — appended to the widening text of `ceiling set --outside-sandbox on` when
  `listConnections(machine).length > 1`.

- [ ] **Step 1: Write the failing tests** (`connection-isolation.test.ts`; two connections
  `dev-a` (workDir `<home>/capybara-device/dev-a`) and `dev-b` under a temp machine dir)

  ```ts
  it("the strict ceiling denies the machine state root and the other connection's working directory", () => {
    const c = readStrictOwnerCeilingSync({ stateDir: connectionDir(m, "dev-a"), deviceId: "dev-a", dir: workA, home });
    expect(c.restrictedDeniedReadRoots).toEqual(expect.arrayContaining([m, workB]));
    expect(c.restrictedDeniedReadRoots).not.toContain(workA);
  });
  it("a project root that is a symlink into the other connection's working directory is refused", () => {
    symlinkSync(join(workB, "workspace"), join(home, "proj"));
    expect(() => checkRoots([join(home, "proj")], [], c)).toThrow(/denied by the owner/);
  });
  it("adding or removing a connection changes the revision", …);
  it("a directory both connections use as a project stays allowed", () => {
    expect(() => checkRoots([join(home, "code", "shared")], [join(home, "code", "shared")], c)).not.toThrow();
  });
  it("ceiling set --outside-sandbox on names the other connections when there are any", async () => {
    // with dev-b present: out contains OTHER_CONNECTIONS_RISK_TEXT; with dev-a alone: it does not
  });
  ```
  OS tests (each skips on the other platform as the files already do):
  ```ts
  it("a restricted command cannot read another connection's working directory or state, also through a symlinked project", …
    // grant from readStrictOwnerCeilingSync for dev-a; `cat <workB>/workspace/secret`, `cat <m>/connections/dev-b/credential.json`,
    // and `cat <projA>/link/secret` (link -> workB) all exit non-zero and print no file content
  ```

- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/connection-isolation.test.ts`
  and, on a Mac, `pnpm exec vitest run packages/device/test/mac-read-scope.test.ts`
  (Linux: `packages/device/test/linux-operation-backend.test.ts`). Expected: FAIL (workB not denied).

- [ ] **Step 3: Implement** the interfaces above.

- [ ] **Step 4: Run** (same, plus `packages/device/test/owner-ceiling.test.ts`). Expected: PASS.

- [ ] **Step 5: Commit** `feat(device): runners deny other connections' state and working directories`
  with the Co-Authored-By line.

---

### Task 6: The guide's 「连接本机」 button calls `device@2.connect` (`apps/web`)

Phase 3 renders `::shell-action connect-this-machine <label>` in the device-local guide of
新建设备; this task gives it the hook.

**Files:**
- Modify: `apps/web/src/lib/use-this-machine.ts` (add `useConnectThisMachine`)
- Modify: phase 3's shell-action renderer (the component that renders the directive inside
  `SetupGuideSection` for the `device-connection` place) to use the hook
- Modify: `apps/web/messages/{en,zh}.json` (`devices.create.connectFailed` reused; no new key unless
  phase 3 has none)
- Test: `apps/web/test/devices.test.tsx` (the create dialog block phase 3 added)

**Interfaces:**
- Consumes: Task 3 `useDeviceCapability`, `DeviceCapabilityV2`.
- Produces:
  ```ts
  export function useConnectThisMachine(orgId: string): {
    offered: boolean;           // the shell offers device@2
    pending: boolean;
    failed: boolean;            // the last connect answered { error } or rejected (not cancelled)
    connect(): void;            // runs cap.connect({ orgId }) inside the click's mutation
  };
  ```
  The renderer shows the button only when `offered`; `connected` leaves the dialog waiting for the
  new device (phase 3's poll), `cancelled` shows nothing, `{ error }` or a rejection other than
  `{ code: "cancelled" }` shows `devices.create.connectFailed`. The shell's error string is never
  rendered.

- [ ] **Step 1: Write the failing tests**

  ```ts
  it("in the desktop shell the local guide's 连接本机 calls connect({ orgId })", …  // expect(cap.connect).toHaveBeenCalledWith({ orgId: "org_1" })
  it("in a browser the shell action is not rendered", …
  it("an { error } answer says the connection failed, without the shell's text", …
  it("a cancelled connect shows nothing", …
  ```

- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/devices.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement** the hook with `useAppMutation` (invalidates
  `keys.shell().deviceStatus()` and the org's device list) and wire the renderer.

- [ ] **Step 4: Run** (same) and `pnpm check:web-ui`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(web): the connection guide's shell action connects this machine`
  with the Co-Authored-By line.

---

### Task 7: `login` adds a connection, or replaces a served one in place (`packages/device`)

**Files:**
- Modify: `packages/device/src/commands/login.ts:121-298` (no `already_logged_in`; the
  connection dir; replace in place)
- Modify: `packages/device/src/api.ts:12-25` (`TokenResponse` gains `deviceName?`, `orgName?`)
- Modify: `packages/device/src/cli.ts:101-112` (login gets `machineDir: dir` instead of
  `stateDir: dir`; the only cli.ts line this task touches)
- Test: `packages/device/test/login.test.ts` (rewrite the "refuses a second login" and
  "already_logged_in" cases)

**Interfaces:**
- Consumes: Task 1 `connectionDir`, `ensureMachineFile`, `listConnections`, `connectionLine`,
  `DEVICE_ID_PATTERN`; Task 4 `hasLoginService(home, platform, deviceId)`.
- Produces: `LoginDeps.machineDir: string` replaces `LoginDeps.stateDir`. The JSON `done` event
  gains `replaced: boolean`. New error code `invalid_device_id` (exit 1, nothing written).
  Behaviour after the token:
  1. `granted.deviceId` must match `DEVICE_ID_PATTERN`, else `invalid_device_id`.
  2. `connDir = connectionDir(machineDir, deviceId)`; `ensureMachineFile(machineDir)`.
  3. A readable `credential.json` there (re-login into a served device): keep its `dir` and `mode`;
     a `--dir` / `--mode` that differs is not applied and prints "This machine already serves
     device <id> (<connectionLine>): it keeps its directory <dir> and mode <mode>. Log out of it
     first to change them." (the kernel has already replaced the credential, so refusing the whole
     login would leave the device without one). `policy.json` is kept.
  4. Otherwise a new connection: `prepareDeviceDir(dir)`, default policy written as today.
  5. `resetOwnerReport(connDir)`; `writeCredential(connDir, { …, deviceName, orgName })`.
  6. Last line: re-login with an installed service → "restart it: capybara-device service restart
     -c <deviceId>"; otherwise "capybara-device start -c <deviceId>" / "service install -c <deviceId>".

- [ ] **Step 1: Write the failing tests**

  ```ts
  it("a second login adds a second connection", async () => {
    // fake token answers dev-a, then dev-b (another deployment url)
    expect(listConnections(m).map((c) => [c.deviceId, c.host])).toEqual([["dev-a", "a.example.com"], ["dev-b", "b.example.com"]]);
  });
  it("logging in again into a served device replaces its credential in place, keeping directory and policy", async () => {
    // dev-a with policy keepAwake "connected" and dir /x; login answers dev-a with credential "new"
    expect(readCredential(connectionDir(m, "dev-a"))).toMatchObject({ credential: "new", dir: "/x" });
    expect(readPolicy(connectionDir(m, "dev-a")).keepAwake).toBe("connected");
    expect(events.at(-1)).toMatchObject({ event: "done", deviceId: "dev-a", replaced: true });
    expect(readdirSync(join(m, "connections"))).toEqual(["dev-a"]);
  });
  it("--dir or --mode differing from the served connection is not applied, and says so", …
  it("a device id that is not a safe path segment is refused and nothing is written", async () => {
    // token deviceId "../evil"
    expect(code).toBe(1);
    expect(events.at(-1)).toMatchObject({ event: "error", code: "invalid_device_id" });
    expect(existsSync(join(m, "evil"))).toBe(false);
    expect(existsSync(join(m, "connections"))).toBe(false);
  });
  it("stores the device and organization names from the token", …
  it("the old flat credential.json does not stop a login and is left untouched", …
  ```

- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/login.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the behaviour above.

- [ ] **Step 4: Run** (same). Expected: PASS.

- [ ] **Step 5: Commit** `feat(device): login adds a connection or replaces a served one in place`
  with the Co-Authored-By line.

---

### Task 8: `status` lists every connection (`packages/device`)

**Files:**
- Modify: `packages/device/src/commands/status.ts` (whole file)
- Modify: `packages/device/src/cli.ts:120-124` (the `status` call: `status(dir, undefined,
  cmd.json, out, err, { home, platform, … })`; Task 9 passes `cmd.connection`)
- Modify: `packages/device/src/index.ts` (export `ConnectionStatusJson`, `MachineStatusJson`)
- Test: `packages/device/test/status.test.ts`

**Interfaces:**
- Consumes: Task 1 `listConnections`, `unreadableConnections`, `resolveConnection`,
  `connectionLine`; Task 4 `hasLoginService`.
- Produces:
  ```ts
  export interface ConnectionStatusJson {
    deviceId: string; orgId: string; orgName: string | null; deviceName: string | null;
    url: string; host: string; mode: "os" | "docker"; dir: string;
    serviceInstalled: boolean;
    control: "ok" | "absent" | "unavailable"; controlReason?: string; live: LiveStatus | null;
  }
  export interface MachineStatusJson { connections: ConnectionStatusJson[]; unreadable: Array<{ deviceId: string; reason: string }> }
  export function status(
    machineDir: string, selector: string | undefined, json: boolean,
    out: (l: string) => void, err: (l: string) => void,
    opts: StatusOptions & { home: string; platform: NodeJS.Platform },
  ): Promise<number>;
  ```
  No selector: text is one line per connection, `connectionLine(c) · <state>` (state: the live
  `connection`, `stopped` when no runner, `no live status (<reason>)` when unavailable), then one
  line per unreadable connection `<deviceId>: unreadable (<reason>)`; JSON is `MachineStatusJson`.
  Exit 0 with at least one connection, 1 with none ("No connection. Run capybara-device login
  --url <url>." / `{"connections":[],"unreadable":[]}`). With a selector: today's detail block for
  that connection (adding device and organization names) or one `ConnectionStatusJson`; a
  `ConnectionSelectError` prints its message on stderr and exits 1. Until Task 9, `logout`, `start`
  and the other commands still receive the machine dir (they find no credential there); Task 9
  resolves the connection for them. The credential is never printed.
  Each connection's control socket is asked with `queryControl(c.stateDir, "status", 500)`
  concurrently.

- [ ] **Step 1: Write the failing tests**

  ```ts
  it("lists every connection, one line each: host, org, device, state", …
    // two connections, a live fake control server for dev-a only: lines end "· online" and "· stopped"
  it("--json lists every connection with its live state and never a credential", …
    // JSON.parse(out).connections.length === 2; out does not contain "cap_dev_" credential value
  it("-c dev-b --json answers that connection alone", …
  it("with no connection says so and exits 1; the old flat credential.json is ignored", …
  it("an unreadable connection is named with its reason and the others are still shown", …
  it("a connection whose socket path is too long reports why there is no live state", async () => {
    // XDG_CONFIG_HOME = mkdtemp + "/" + "h".repeat(60); fake running pid via opts.running
    expect(JSON.parse(line).connections[0]).toMatchObject({ control: "unavailable", controlReason: expect.stringContaining("103 bytes") });
  });
  ```

- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/status.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the signature above (the per-connection control logic of today's
  `controlState` is kept, now per connection dir).

- [ ] **Step 4: Run** (same). Expected: PASS.

- [ ] **Step 5: Commit** `feat(device): status lists every connection`
  with the Co-Authored-By line.

---

### Task 9: `--connection` / `-c` on every command (`packages/device`)

**Files:**
- Modify: `packages/device/src/args.ts:8-100` (Command variants, USAGE), `:113-286` (parsing)
- Modify: `packages/device/src/cli.ts:78-193` (resolution and dispatch)
- Modify: `packages/device/src/commands/logout.ts` (stop, uninstall the connection's service,
  remove the credential)
- Modify: `packages/device/src/commands/start.ts:76-93` (no connection: exit 0)
- Modify: `packages/device/README.md` (commands, layout, the upgrade note of spec §7.4)
- Create: `.changeset/device-connections.md` (`@capybara-hq/device` minor)
- Test: `packages/device/test/args.test.ts`, `packages/device/test/cli-connections.test.ts` (new),
  `packages/device/test/start.test.ts`, `packages/device/test/keep-awake.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 4, 7, 8.
- Produces: every `Command` variant except `login` and `help` has `connection?: string`, parsed
  from `--connection <selector>` / `-c <selector>` (an empty value is a `UsageError`). In
  `runCli`: `machineDir = stateDir(env, home)`; `status` gets `(machineDir, cmd.connection, …)`;
  every other command gets `resolveConnection(cmd.connection, machineDir).stateDir` where it took
  `dir` before, and `service` also gets `deviceId`. A `ConnectionSelectError` prints its message
  and exits 1, except for `start` (exit 0, message "No connection <selector> on this machine;
  nothing to start."). `logout -c <deviceId>` naming an id in `unreadableConnections` uses
  `connectionDir(machineDir, id)` directly.
  ```ts
  export async function logout(conn: { stateDir: string; deviceId: string }, deps: LogoutDeps & {
    home: string; platform: NodeJS.Platform; run?: RunSystem;
  }): Promise<number>;
  ```
  `logout`: when `hasLoginService(home, platform, deviceId)`, `serviceCommand("uninstall", …)`
  (which stops it); else SIGTERM a running runner as today; then `removeCredential(stateDir)`.
  `policy.json`, logs and the working directory stay.

- [ ] **Step 1: Write the failing tests**

  ```ts
  // args.test.ts
  it("every command but login and help takes --connection and -c", () => {
    for (const line of [["status"], ["logout"], ["start"], ["stop"], ["drain"], ["policy"], ["ceiling"], ["keep-awake"], ["service", "status"]])
      expect(parseCommandLine([...line, "-c", "dev-1"])).toMatchObject({ connection: "dev-1" });
    expect(() => parseCommandLine(["login", "--url", "https://x", "-c", "a"])).toThrow(UsageError);
  });
  // cli-connections.test.ts (runCli with env.XDG_CONFIG_HOME and home from mkdtemp)
  it("with one connection the selector is implied", …            // policy show prints dev-a's policy
  it("with two and none given, a command refuses and lists both", …   // exit 1; err has both connectionLine values
  it("start without any connection exits 0, and so does start -c of a logged-out connection", …
  it("logout -c dev-a stops its runner, removes its login service and credential, and keeps dev-b", …
  it("logout -c names an unreadable connection by its id and still removes it", …
  it("keep-awake is set per connection", async () => {
    await runCli(["keep-awake", "connected", "--yes", "-c", "dev-a"], io);
    expect(readPolicy(connectionDir(m, "dev-a")).keepAwake).toBe("connected");
    expect(readPolicy(connectionDir(m, "dev-b")).keepAwake).toBe("while-busy");
  });
  // start.test.ts
  it("two runners each hold their own keep-awake assertion and their own pid and control socket", …
    // two start() calls with keepAwakeSpawn fakes, one per connection dir: two holders spawned,
    // pid files in connections/dev-a/pid and connections/dev-b/pid
  ```

- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/args.test.ts packages/device/test/cli-connections.test.ts packages/device/test/start.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement**; USAGE gains the `[-c <connection>]` option on each line and the line
  "With several connections, name one with -c <device id | device name | host>."

- [ ] **Step 4: Run** `pnpm exec vitest run packages/device/test` (the whole non-OS device suite).
  Expected: PASS.

- [ ] **Step 5: Commit** `feat(device): --connection selects one connection for every command`
  with the Co-Authored-By line.

---

### Task 10: Shared project directories are marked (`packages/device`, SDK protocol)

A directory two connections both use as a project stays allowed; `status` and the device page say
"also used by another connection on this machine" without naming that connection.

**Files:**
- Create: `packages/device/src/project-roots.ts`
- Modify: `packages/device/src/staged-device.ts` (record the scope's `projectRoot` when an
  operation is admitted)
- Modify: `packages/device/src/exec/operation-types.ts` (strict ceiling gains
  `sharedProjectRoots`, included in the revision)
- Modify: `packages/device/src/owner-report.ts:85-115` (report carries it)
- Modify: `packages/device/src/commands/status.ts` (mark)
- Modify: the owner report parser in `@capybara-hq/plugin-sdk/device-protocol` (phase 2's subpath
  file, today `parseOwnerCeilingReport` in `packages/plugin-sdk/src/device-protocol.ts`); its api
  report via `pnpm gen:sdk-api`; `.changeset/shell-device-v2.md` extended to name it
- Test: `packages/device/test/project-roots.test.ts` (new), `packages/device/test/owner-ceiling.test.ts`,
  `packages/device/test/status.test.ts`, the SDK device-protocol test

**Interfaces:**
- Produces:
  ```ts
  export const PROJECT_ROOTS_MAX = 256;
  export function projectRootsPath(connectionStateDir: string): string;    // <dir>/projects.json
  /** Most recent first, deduplicated, at most PROJECT_ROOTS_MAX, written atomically 0600. */
  export function recordProjectRoot(connectionStateDir: string, root: string): void;
  export function readProjectRoots(connectionStateDir: string): string[];   // [] when absent or invalid
  /** This connection's roots that another connection's projects.json also lists (compared by realpath). */
  export function sharedProjectRoots(machineDir: string, selfDeviceId: string): string[];
  ```
  Owner report field `sharedProjectRoots: string[]` (absolute paths, each passing
  `validateSandboxPathShape`, at most 256; the parser refuses anything else). `ConnectionStatusJson`
  (Task 8) gains `sharedProjects: string[]`; the text status adds "(N project directories also used
  by another connection on this machine)" to a connection's line when N > 0. The existing periodic
  owner-report check (`staged-connect.ts:269-280`) pushes the changed report; no new timer.

- [ ] **Step 1: Write the failing tests**

  ```ts
  it("records project roots most recent first, deduplicated and bounded", …
  it("a root both connections recorded is shared; the other connection's own roots are never returned", () => {
    // dev-a: /p/shared, /p/a ; dev-b: /p/shared, /p/b
    expect(sharedProjectRoots(m, "dev-a")).toEqual(["/p/shared"]);
  });
  it("the owner report carries the shared roots and its revision changes with them", …   // owner-ceiling.test.ts
  it("the parser refuses a relative or oversized sharedProjectRoots", …                 // SDK test
  it("status marks a connection whose project directory another connection also uses, without naming it", …
    // line for dev-a contains "also used by another connection"; does not contain dev-b's deviceId or host
  ```

- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/project-roots.test.ts packages/device/test/owner-ceiling.test.ts packages/device/test/status.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement** the interfaces above; `pnpm gen:sdk-api`.

- [ ] **Step 4: Run** (same, plus the SDK device-protocol test) and `pnpm check:sdk-api`.
  Expected: PASS.

- [ ] **Step 5: Commit** `feat(device): mark project directories shared with another connection`
  with the Co-Authored-By line.

Then: core PR for Tasks 1–10 → release of `@capybara-hq/plugin-sdk` and `@capybara-hq/device`
(index Release order 3). Record both exact versions for Tasks 11–13.

---

### Task 11: `device-local` shows the shared-project limit (capybara-hq/plugins)

**Files:**
- Modify: `plugins/device-local/src/report.ts` (phase 2's file holding `report()`; the owner
  report parse already lives in the plugin)
- Modify: `plugins/device-local/package.json`, `pnpm-workspace.yaml` override (the SDK version from
  the release above)
- Create: `.changeset/device-local-shared-projects.md` (`@capybara-hq/plugin-device-local` patch)
- Test: `plugins/device-local/test/report.test.ts`

**Interfaces:**
- Consumes: the SDK's `sharedProjectRoots` report field (Task 10).
- Produces: when the machine's last report has a non-empty `sharedProjectRoots`, `report().limits`
  gains `{ label: { en: "Also used by another connection on this computer", zh: "本机的另一个连接也在使用" },
  value: roots.join(", ") }`; `revision` changes with it and the plugin calls
  `ctx.devices.reportChanged(deviceId)` when it changes.

- [ ] **Step 1: Write the failing test**

  ```ts
  it("names the shared project directories in the limits, never the other connection", async () => {
    const r = await provider.report({ deviceId: "d1", orgId: "o1", handle: null }, signal);
    expect(r.limits).toContainEqual({ label: expect.objectContaining({ en: "Also used by another connection on this computer" }), value: "/p/shared" });
  });
  it("a report change calls reportChanged once", …
  ```

- [ ] **Step 2: Run** `pnpm exec vitest run plugins/device-local/test/report.test.ts` (plugins
  root). Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** (same) and `pnpm typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(device-local): show project directories shared on the machine`
  with the Co-Authored-By line.

---

### Task 12: The desktop reads every connection; bundle bump (capybara-hq/clients)

**Files:**
- Modify: `apps/desktop/package.json:17-18` (`@capybara-hq/device`, `@capybara-hq/plugin-sdk` exact
  versions from the core release)
- Modify: `apps/desktop/src/main/device/availability.ts:15` (`BUNDLED_DEVICE_PROTOCOL = 5`)
- Modify: `apps/desktop/src/main/device/control.ts:31-40,151` (connection paths; one client per
  connection; `subscribeAll`)
- Modify: `apps/desktop/src/main/device/machine.ts` (add the connection readers below; keep
  `readMachine` / `Machine` for Task 14)
- Test: `apps/desktop/test/device/control.test.ts`, `apps/desktop/test/device/bundle.test.ts`,
  `apps/desktop/test/device/capability.test.ts` (only the `machine.ts` reader cases)

**Interfaces:**
- Consumes: `@capybara-hq/device` `ConnectionStatusJson`, `MachineStatusJson`, `LiveStatus`.
- Produces (`control.ts`):
  ```ts
  export function connectionsDir(stateDir: string): string;               // restated, pinned against the package
  export function connectionDir(stateDir: string, deviceId: string): string; // throws unless ID_PATTERN
  export interface ConnectionControls {
    forDevice(deviceId: string): ControlClient;                           // controlClient(connectionDir(…))
    /** cb on any connection's status change and when a connection appears or goes (rescan every RESCAN_MS). */
    subscribeAll(cb: () => void): () => void;
  }
  export const RESCAN_MS = 5000;
  export function createConnectionControls(stateDir: string, deps?: ControlClientDeps & {
    listDir?: (path: string) => string[];
  }): ConnectionControls;
  ```
  (`machine.ts`):
  ```ts
  export interface MachineConnection {
    deviceId: string; orgId: string; orgName: string | null; deviceName: string | null;
    url: string; host: string; mode: "os" | "docker"; serviceInstalled: boolean;
    control: "ok" | "absent" | "unavailable"; controlReason?: string; live: LiveStatus | null;
  }
  export const readConnections: (cli: DeviceCli) => Promise<MachineConnection[]>; // `status --json`, keeps only these fields
  export function connectionsHere(all: MachineConnection[], profile: Profile): MachineConnection[]; // origin equal
  export function connectionView(c: MachineConnection, keepAwakeMode: KeepAwakeMode): ThisMachineConnection;
  export const readKeepAwake: (cli: DeviceCli, deviceId: string) => Promise<KeepAwakeMode>; // keep-awake show -c id --json
  export const readCeiling: (cli: DeviceCli, deviceId: string) => Promise<OwnerCeiling>;     // ceiling show -c id --json
  export function ceilingSetArgs(deviceId: string, req: DeviceCeilingRequest): string[];
  ```
  `readConnections` drops entries whose `deviceId` fails `ID_PATTERN`; `connectionView` keeps
  today's `machineStatus` rules per connection (offline reason clipped to 300, `stopped` with no
  runner, `offline` when unavailable).

- [ ] **Step 1: Write the failing tests**

  ```ts
  it("the connection path rules equal the package's", () => {
    expect(connectionDir("/s", "dev-1")).toBe(join("/s", "connections", "dev-1"));
    expect(controlSocketPath(connectionDir("/s", "dev-1"))).toBe(pkgControlSocketPath(join("/s", "connections", "dev-1")));
  });
  it("subscribeAll follows every connection's socket and notices a new one at the next rescan", …
  it("readConnections keeps only the named fields and drops an unsafe device id", …
  it("connectionsHere keeps only the profile's own origin", …
  it("the bundled device speaks protocol 5", …   // bundle.test.ts reads the bundled package's DEVICE_PROTOCOL_VERSION
  ```

- [ ] **Step 2: Run** `pnpm exec vitest run apps/desktop/test/device/control.test.ts apps/desktop/test/device/bundle.test.ts`
  (clients root). Expected: FAIL.

- [ ] **Step 3: Implement**; `pnpm install` for the bumped versions.

- [ ] **Step 4: Run** (same). Expected: PASS.

- [ ] **Step 5: Commit** `feat(desktop): read every device connection of this machine`
  with the Co-Authored-By line.

---

### Task 13: `device@2` in the desktop [review alone, most capable model]

Cross-deployment boundary: a window must only see and act on its own deployment's connections.

**Files:**
- Modify: `apps/desktop/src/main/device/capability.ts` (whole file)
- Modify: `apps/desktop/src/main/device/connect.ts:55-194` (drop `stopAndLogout`, the
  "already here" short-cut and the other-platform step; per-connection service)
- Modify: `apps/desktop/src/main/device/service.ts:69-229` (every function takes `deviceId`;
  `repairService` / `afterUpdate` loop over `readConnections`)
- Modify: `apps/desktop/src/main/device/dialogs.ts:16-195` (drop `confirmDisconnectOther`;
  `confirmRemoveDevice(parent, profile, count)`)
- Modify: `apps/desktop/src/main/remove-profile.ts:25` (doc), `apps/desktop/src/main/onboarding.ts:95-98`
  (`deviceConnected`: any connection here), `apps/desktop/src/main/index.ts:411-440` (wiring)
- Modify: `packages/shell/src/i18n/{en,zh}.json` (delete `device.disconnect_other.*`;
  `device.remove.message` with `{count}`)
- Delete from `machine.ts`: `machineStatus`, `hereOrNull`, `isThisDeployment`
- Test: `apps/desktop/test/device/capability.test.ts`, `connect.test.ts`, `service.test.ts`,
  `dialogs.test.ts`, `apps/desktop/test/remove-profile.test.ts`, `test/device/fake-device.ts`
  (fake `status --json` with several connections)

**Interfaces:**
- Consumes: Task 12 `createConnectionControls`, `readConnections`, `connectionsHere`,
  `connectionView`, `readKeepAwake`, `readCeiling`, `ceilingSetArgs`; SDK `DeviceCapabilityV2`.
- Produces: `createDeviceCapability(deps)` with `deps.controls: ConnectionControls` (replaces
  `deps.control`) and `deps.service: Pick<DeviceService, "ensureService" | "status">`; its `impl`
  implements `DeviceCapabilityV2` with the bridge's `ctx` first:
  - `status(ctx)` → `{ connections: connectionsHere(all, ctx.profile).map(connectionView) }`.
  - `running(ctx, { deviceId })`, `pause`, `resume`, `disconnect`, `requestCeiling`,
    `setKeepAwake` go through `connectionHere(profile, deviceId)`, which throws `failed()` when the
    id fails `ID_PATTERN` or is not among `connectionsHere(...)`; every CLI call they make carries
    `-c <deviceId>`; control calls use `controls.forDevice(deviceId)`.
  - `connect(ctx, { orgId })` → `confirmConnect` dialog, `login --json --url <base>`, then from
    the `done` event's `deviceId` (checked with `ID_PATTERN`): `service.ensureService(deviceId)` and
    `service start -c <deviceId>`. Answers `"connected"`, `"cancelled"` (dialog declined, window
    closed, denied), or `{ error: "login_failed" | "service_failed" | "app_location" }`; rejects
    only `{ code: "busy" }` (a login already running).
  - `onStatus` emits with no payload, per profile, only when that profile's own connection views
    changed.
  - `beforeRemoveProfile(profile, parent)`: no connection here → nothing; else one
    `confirmRemoveDevice(parent, profile, n)`; yes → `logout -c <id>` for each, in order, continuing
    after a failure (logged).
  - `DeviceService`: `status(deviceId)`, `ensureService(deviceId)` (`service install -c <id>`),
    `repairService()` and `afterUpdate()` over every connection.

- [ ] **Step 1: Write the failing tests** (fake machine: `dev_a1`, `dev_a2` at
  `https://a.example.com/team`, `dev_b1` at `https://b.example.com`)

  ```ts
  it("status answers only this deployment's connections and never names another", async () => {
    const s = await impl.status(ctxA);
    expect(s.connections.map((c) => c.deviceId)).toEqual(["dev_a1", "dev_a2"]);
    expect(JSON.stringify(s)).not.toMatch(/b\.example\.com|dev_b1/);
  });
  it("every per-device call naming another deployment's device refuses and runs nothing", async () => {
    for (const call of [() => impl.pause(ctxA, { deviceId: "dev_b1" }), () => impl.resume(ctxA, { deviceId: "dev_b1" }),
      () => impl.disconnect(ctxA, { deviceId: "dev_b1" }), () => impl.running(ctxA, { deviceId: "dev_b1" }),
      () => impl.requestCeiling(ctxA, { deviceId: "dev_b1", outsideSandbox: false }),
      () => impl.setKeepAwake(ctxA, { deviceId: "dev_b1", mode: "off" })])
      await expect(call()).rejects.toEqual({ code: "failed" });
    expect(cli.calls.flat()).not.toContain("dev_b1");
  });
  it("an unsafe or unknown device id refuses the same way", …
  it("two connections to one deployment act separately", …   // pause dev_a2 drains only forDevice("dev_a2")
  it("connect adds a connection without touching another platform's", async () => {
    // machine has dev_b1; connect from A: only confirmConnect shown, no "logout" call,
    // then ["service","install","-c","dev_new"] and ["service","start","-c","dev_new"]
  });
  it("connect answers { error: 'service_failed' } when the login service does not start", …
  it("removing a profile asks once and logs out each of its connections, not another deployment's", …
  it("onStatus fires for a profile only when its own connections changed", …
  it("no function returns the credential", …   // existing case, now over all functions with deviceId
  ```

- [ ] **Step 2: Run** `pnpm exec vitest run apps/desktop/test/device apps/desktop/test/remove-profile.test.ts`
  (clients root). Expected: FAIL.

- [ ] **Step 3: Implement** the interfaces above; zh `device.remove.message`:
  "同时断开本机在这个平台上的 {count} 个设备并退出登录？", en "Also disconnect this computer's
  {count} devices on this platform and log them out?".

- [ ] **Step 4: Run** (same), `pnpm typecheck`, `pnpm check:i18n`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(desktop): device@2, one connection per deployment window`
  with the Co-Authored-By line.

---

### Task 14: Tray rows per connection, worst-state icon (capybara-hq/clients)

**Files:**
- Modify: `apps/desktop/src/main/tray.ts:24-170` (`TrayState.devices`, rows, icon)
- Modify: `apps/desktop/src/main/device/tray-device.ts` (whole file)
- Modify: `apps/desktop/src/main/index.ts:567-580` (wiring)
- Modify: `apps/desktop/src/main/device/machine.ts` (delete `readMachine`, `Machine`,
  `LoggedInMachine`)
- Modify: `packages/shell/src/i18n/{en,zh}.json` (`tray.device.row`)
- Test: `apps/desktop/test/tray.test.ts`, `apps/desktop/test/device/tray-device.test.ts`

**Interfaces:**
- Consumes: Task 12 `ConnectionControls`, `readConnections`, `MachineConnection`; Task 13 impl.
- Produces:
  ```ts
  export interface TrayDevice {          // tray.ts: one per connection
    deviceId: string; host: string; orgLabel: string; /* orgName ?? orgId */
    icon: Exclude<TrayIconState, "not_connected">; running: number; keepAwake: KeepAwakeMode;
    profileId?: string | undefined;      // the saved profile of that deployment; absent: no actions
  }
  export interface TrayState { /* … */ devices: TrayDevice[] }   // replaces `device`
  /** offline > busy > paused > online; no devices: not_connected. */
  export function worstIcon(devices: readonly TrayDevice[]): TrayIconState;
  export interface TrayDeviceActions {
    pause(profileId: string, deviceId: string): unknown; resume(…): unknown; disconnect(…): unknown;
    setKeepAwake(profileId: string, deviceId: string, mode: KeepAwakeMode): unknown;
    openDevicePage(profileId: string, deviceId: string): unknown;
  }
  export function trayDevicesFrom(input: {
    connections: MachineConnection[]; running: ReadonlyMap<string, number>; profiles: Profile[];
  }): TrayDevice[];
  ```
  Each row's label is `tray.device.row` (en "{host} · {org} · {state}", zh "{host} · {org} ·
  {state}" with the state's existing zh text) and its submenu holds today's items (running count,
  暂停 / 恢复, 断开, keep-awake radio, 「本机」 page) for that connection. `createTrayDevice` uses
  `controls.subscribeAll` and polls `running` per online connection every `RUNNING_POLL_MS`.

- [ ] **Step 1: Write the failing tests**

  ```ts
  it("one row per connection: host · org · state, each with its own submenu", …
  it("the icon shows the worst state: offline over busy over paused over online", () => {
    expect(worstIcon([d("online"), d("busy")])).toBe("busy");
    expect(worstIcon([d("busy"), d("offline")])).toBe("offline");
    expect(worstIcon([d("online"), d("paused")])).toBe("paused");
    expect(worstIcon([])).toBe("not_connected");
  });
  it("an action on a row runs for that connection only", …  // impl.pause called with ({profile}, { deviceId: "dev_a2" })
  it("a connection to a deployment without a saved profile shows its row without actions", …
  it("the tooltip names the worst state and the total running count", …
  ```

- [ ] **Step 2: Run** `pnpm exec vitest run apps/desktop/test/tray.test.ts apps/desktop/test/device/tray-device.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck`, `pnpm check:i18n` (clients root). Expected: PASS.

- [ ] **Step 5: Commit** `feat(desktop): one tray row per device connection, worst-state icon`
  with the Co-Authored-By line. Add a changeset for `@capybara-hq/desktop` and `@capybara-hq/shell`.

---

## Index issues

1. **Control socket path length.** `connections/<uuid>/control.sock` under
   `/Users/<name>/.config/capybara-device` is 98 bytes for a 10-character user name; the macOS limit
   is 103, so user names over about 15 characters (or a deeper `XDG_CONFIG_HOME`) lose the control
   socket, and with it the desktop's live status. This plan keeps the index's layout and pins the
   explanation (Task 8). Recommended follow-up for the maintainer: bind the socket at a short
   machine-level path, e.g. `<stateDir>/s/<first 12 hex of sha256(deviceId)>.sock`, keeping
   everything else per connection.
2. **"Two connections of one device are refused."** The layout is keyed by `deviceId`, so a second
   connection of one device cannot exist; a re-login into a served device replaces its credential in
   place. A `--dir` / `--mode` that differs is not applied (with a message) rather than failing the
   login, because by then the kernel has already replaced the device's credential, and failing would
   leave the device with none (Task 7).
3. **`machine.json`'s `defaultConnection`** (spec §7.2) contradicts "with several and none given
   they refuse", and nothing would set it; this plan writes `{ "version": 1 }` only.
4. **`useThisMachineDeviceId(orgId)`** (spec §9) cannot be a single id: two connections into one org
   are allowed (`login` always adds). This plan names it `useThisMachineDeviceIds(orgId):
   ReadonlySet<string>` (Task 3).
5. **`DeviceRunningOp`** in the index's `DeviceCapabilityV2` is not defined elsewhere; this plan
   defines it as today's `RunningOperationView`, renamed.
6. **Phase 3 coupling.** Phase 3 renders the `::shell-action connect-this-machine` button but
   `device@2` arrives here; phase 3 should render it from a placeholder that this phase replaces with
   `useConnectThisMachine(orgId).offered` (Task 6).
7. **Device and org names.** `status` and the selector need the device and org names, which the
   token does not return today; Task 2 adds them in the kernel (phase 2's `dial-in` token).
8. **Shared-project mark on the device page** goes through the machine's owner report and
   `device-local`'s `report().limits` (Tasks 10, 11), since the kernel has no machine identity across
   devices; it is a read-only limits row, not a per-project badge.
