import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DeviceHello,
  SandboxExecutionRef,
  SandboxPermissionSupport,
  SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { BackgroundTaskStopper } from "../../src/background/stop.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { LocalDeviceGateway } from "../../src/local-devices/local-device-gateway.js";
import { LocalDeviceProvider } from "../../src/local-devices/local-device-provider.js";
import { LocalDeviceRelay } from "../../src/local-devices/relay.js";
import { createLogger } from "../../src/log.js";
import { SandboxOperationIntents } from "../../src/sandbox/operation-intents.js";
import { SandboxOperationReconcileJob } from "../../src/sandbox/operation-reconcile.job.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { runInBackgroundManaged } from "../../src/tools/builtins/sandbox/bash.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { seedInstalledEvidence } from "../helpers/installed-evidence.js";
import {
  MANAGED_GENERATION,
  MANAGED_PROVIDER,
  managedOutputProvider,
  managedTaskFixture,
} from "../helpers/managed-background.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * B3 evidence across a disconnect (permission activation B-6): two kernels on one database and
 * Redis drive two real managed background tasks through the real staged (protocol 3) path: the
 * local device provider's staged adapter, the relay, the gateway's staged connection and the
 * device's own staged session (`serveStagedSession`, one `StagedSessionStates` state per
 * credential) over its real operation backend; only the backend's worker process is a fixture.
 * A revocation written while the device is disconnected stays owed, is delivered on reconnect and
 * stops exactly the revoked task by its operation identity; the sibling keeps its grant and runs.
 * A start queued for a connection the device has since replaced is refused by the gateway as not
 * sent (B-5): a definite pre-effect failure, never an unknown outcome, also on a retry.
 */

const PW = "correct horse battery";
const silent = () => createLogger("error", { write: () => {} });

let pgc: TestContainer;
let rd: TestContainer;
let a: TestKernel;
let b: TestKernel;
let raw: ReturnType<typeof createDb>;
let redis: Redis;
let accounts: AccountsService;
let owner: Account;
const cleanups: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const config = KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 6 },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    roles: ["api"],
    ...MODEL_PLUGINS_CONFIG,
  });
  a = await startKernel(config, { env: {}, logger: silent() });
  b = await startKernel(config, { env: {}, logger: silent() });
  raw = createDb(pgc.url, 6);
  redis = new Redis(rd.url);
  accounts = accountsFor(kernelDb(raw));
});
afterAll(async () => {
  await b?.close();
  await a?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await redis.flushdb();
  owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
});
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const SUPPORT: SandboxPermissionSupport = {
  version: 1,
  restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
  fullAccess: true,
  background: true,
};

/** One launched execution as the device's worker fixture sees it. */
interface Worker {
  operationId: string;
  cancelled: boolean;
  finish: () => void;
}

/**
 * The device half: the real staged session over the real operation backend, one session state
 * per credential across reconnects, connected through the gateway's staged accept. The backend's
 * worker is the only fixture: it launches at once, and its cancellation ends it.
 */
async function stagedDevice(deviceId: string) {
  const { StagedSessionStates, serveStagedSession } = await import(
    "../../../device/src/staged-session.js"
  );
  const { createMacOperationBackend } = await import(
    "../../../device/src/exec/mac-operation-backend.js"
  );
  const dir = await realpath(await mkdtemp(join(tmpdir(), "cap-revocation-reconnect-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const roots = {
    workspace: join(dir, "work"),
    skills: join(dir, "skills"),
    tmp: join(dir, "tmp"),
  };
  for (const r of Object.values(roots)) await mkdir(r, { recursive: true });
  const workers: Worker[] = [];
  const generation = String(MANAGED_GENERATION);
  const backend = await createMacOperationBackend(
    {
      deviceId,
      instanceGeneration: generation,
      stateDir: join(dir, "state"),
      roots,
      pythonPath: "/usr/bin/python3",
      runtimeHash: "a".repeat(64),
      readOwnerCeiling: async () => ({
        revision: "owner-1",
        fullAccess: true,
        roots,
        restrictedProjectReach: "os-user",
        restrictedAllowedDomains: [],
        restrictedDeniedReadRoots: [],
        preparation: { skillsRoot: roots.skills, attachmentsBase: join(roots.workspace, "a") },
        fullNetwork: "environment",
      }),
    },
    {
      platform: "darwin",
      restrictedSupported: true,
      watch: () => () => {},
      startWorker: async (r) => {
        await r.beforeLaunch();
        await r.onLaunch({ pid: 4242, token: `worker-${workers.length}` });
        if (r.kind === "native")
          return {
            ready: Promise.resolve(),
            completion: Promise.resolve(null),
            cancel: async () => {},
          };
        let finish!: () => void;
        const completion = new Promise<{
          stdout: string;
          stderr: string;
          exitCode: number | null;
          timedOut: boolean;
          truncated: boolean;
        }>((resolve) => {
          finish = () =>
            resolve({ stdout: "", stderr: "", exitCode: 143, timedOut: false, truncated: false });
        });
        const w: Worker = { operationId: r.scope.operationId, cancelled: false, finish };
        workers.push(w);
        return {
          ready: Promise.resolve(),
          completion,
          cancel: async () => {
            w.cancelled = true;
            w.finish();
          },
        };
      },
    },
  );
  cleanups.push(async () => {
    // finish every worker, then wait until the backend persisted each outcome and give its
    // journal up: removing the state directory while a completion is still being written races
    // the supervisor (ENOTEMPTY)
    for (const w of workers) w.finish();
    await backend.lifecycle.settle(AbortSignal.timeout(30_000));
    backend.lifecycle.dispose();
  });
  const credential = randomUUID();
  const states = new StagedSessionStates();
  const hello: Omit<DeviceHello, "transport"> = {
    type: "hello",
    protocol: 3,
    programVersion: "fixture",
    os: "darwin",
    arch: "arm64",
    mode: "os",
    roots,
    sessionIsolation: false,
    permissionSupport: SUPPORT,
    ownerCeiling: {
      version: 2,
      sequence: 1,
      restrictedProjectReach: "os-user",
      revision: "owner-1",
      fullAccess: true,
      restrictedAllowedDomains: [],
    },
    instanceGeneration: generation,
  };
  /** Records the exact refs of every stop the device's session serves. */
  const recordStops = () => {
    const stops: SandboxExecutionRef[] = [];
    const stop = backend.background.stop.bind(backend.background);
    backend.background.stop = async (h, ref, opts) => {
      stops.push(ref);
      return stop(h, ref, opts);
    };
    return stops;
  };
  /** Holds the next stop on the device until released (the answer goes out after that). */
  const holdStops = () => {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const stop = backend.background.stop.bind(backend.background);
    backend.background.stop = async (h, ref, opts) => {
      entered();
      await gate;
      return stop(h, ref, opts);
    };
    return { entered: reached, release };
  };
  return {
    roots,
    workers,
    backend,
    credential,
    states,
    hello,
    serveStagedSession,
    recordStops,
    holdStops,
  };
}

/**
 * The gateway replica holding the machine's connection: the real gateway's staged accept on its
 * own Redis connections, sharing the kernels' Redis (the relays of both replicas reach it).
 */
async function gatewayFor(
  device: Awaited<ReturnType<typeof stagedDevice>>,
  identity: { deviceId: string; orgId: string; accountId: string },
) {
  const gr = new Redis(rd.url);
  const sub = createBusSubscriber(() => new Redis(rd.url));
  const locks = new LockService(gr, silent());
  const config = {
    get: () => ({
      devices: { local: { maxFrameBytes: 100000, leaseTtlMs: 6000, reconnectGraceSeconds: 30 } },
    }),
  } as KernelConfigService;
  const gateway = new LocalDeviceGateway(
    {
      authenticate: async (c) =>
        c === device.credential ? { ...identity, machineId: "machine" } : null,
      recordHelloV3: async () => {},
      recordPolicyV3: async () => {},
      touch: async () => {},
    },
    locks,
    createBus(gr, sub, "kernel"),
    gr,
    config,
    silent(),
  );
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no address");
  server.on("connection", (socket) => {
    void gateway.accept(socket, device.credential);
  });
  cleanups.push(async () => {
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
    await gateway.stop();
    await sub.close();
    gr.disconnect();
  });
  let socket: WebSocket | undefined;
  /** Connects the device (a new socket served with the credential's same session state). */
  const connect = async () => {
    socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(socket, "open");
    const session = device.serveStagedSession(
      socket,
      device.hello,
      { maxFrameBytes: 100000 },
      device.backend,
      { id: identity.deviceId },
      device.states.for({
        url: "ws://fixture",
        orgId: identity.orgId,
        deviceId: identity.deviceId,
        credential: device.credential,
        reconnectGraceSeconds: 30,
      }),
    );
    await expect.poll(() => session.ready(), { timeout: 10_000 }).toBeDefined();
    await expect.poll(() => gateway.connectionCount(), { timeout: 10_000 }).toBe(1);
  };
  const disconnect = async () => {
    if (!socket) return;
    const closed = once(socket, "close");
    socket.close();
    await closed;
    await expect.poll(() => gateway.connectionCount(), { timeout: 10_000 }).toBe(0);
  };
  cleanups.push(async () => socket?.terminate());
  return { connect, disconnect, gateway };
}

/** The staged provider each replica dispatches through: its own provider, relay and Redis. */
function stagedProviderOf(k: TestKernel): SandboxProvider {
  const relay = k.app.get(LocalDeviceRelay);
  const staged = k.app.get(LocalDeviceProvider).stagedOperations({
    call: relay.callV3.bind(relay),
    permissionSupport: async () => SUPPORT,
  });
  const base = managedOutputProvider().impl;
  return Object.assign(Object.create(null), base, {
    permissionSupport: async () => SUPPORT,
    revokeOperation: staged.revokeOperation,
    background: staged.background,
  }) as SandboxProvider;
}

async function fixture() {
  const f = await managedTaskFixture({
    kernels: [a, b],
    raw,
    login: "owner",
    password: PW,
    accountId: owner.id,
    launch: false,
  });
  for (const k of [a, b])
    k.app
      .get(SandboxProviders)
      .register({ plugin: MANAGED_PROVIDER, version: "test-1", impl: stagedProviderOf(k) });
  const device = await stagedDevice(f.deviceId);
  // the kernel's instance and machine name the device's own roots
  await f.db
    .updateTable("device_instances")
    .set({ handle: JSON.stringify({ id: f.deviceId, roots: device.roots }) })
    .where("device_id", "=", f.deviceId)
    .execute();
  await f.db
    .updateTable("device_machines")
    .set({ roots: JSON.stringify(device.roots) })
    .where("device_id", "=", f.deviceId)
    .execute();
  // admission proves the installed environment (B-16) for the instance as it now is: its
  // committed roots, the runtime report of its generation and its installed binding
  await seedInstalledEvidence(a, raw, {
    orgId: f.orgId,
    deviceId: f.deviceId,
    provider: MANAGED_PROVIDER,
    version: "test-1",
    report: SUPPORT,
  });
  const gw = await gatewayFor(device, {
    deviceId: f.deviceId,
    orgId: f.orgId,
    accountId: owner.id,
  });
  await gw.connect();
  return { ...f, device, gw };
}

const reconcileJob = (k: TestKernel) =>
  new SandboxOperationReconcileJob(
    k.app.get(SandboxOperationIntents),
    k.app.get(KernelDb),
    k.app.get(SandboxProviders),
    k.app.get(SandboxService),
    k.app.get(BackgroundTaskStore),
    k.app.get(BackgroundTaskStopper),
    k.app.get(KernelConfigService),
  );

/** Revokes exactly `operationId` with the device-level writer, written on replica `k`. */
async function revokeOne(
  k: TestKernel,
  f: Awaited<ReturnType<typeof fixture>>,
  operationId: string,
) {
  await k.app.get(TransactionHost).run(async () => {
    const ceiling = k.app.get(PermissionCeilingWrites);
    const subject = { orgId: f.orgId, deviceId: f.deviceId };
    await ceiling.lock(subject, "device");
    await ceiling.publishLocked(
      subject,
      "device",
      (_scope, row) => row.operation_id === operationId,
    );
  });
}

const intentOf = (f: Awaited<ReturnType<typeof fixture>>, operationId: string) =>
  f.db
    .selectFrom("sandbox_operation_intents")
    .selectAll()
    .where("operation_id", "=", operationId)
    .executeTakeFirstOrThrow();
const taskOf = (f: Awaited<ReturnType<typeof fixture>>, operationId: string) =>
  f.db
    .selectFrom("background_tasks")
    .selectAll()
    .where("operation_id", "=", operationId)
    .executeTakeFirstOrThrow();

/**
 * The relay's staged calls of `op` read `stale` as the machine's connection (the one the caller
 * read just before the device reconnected); every other call reads the current one. Scoped to
 * the call by async context, not by call order.
 */
function staleFor(
  relay: LocalDeviceRelay,
  op: string,
  stale: Awaited<ReturnType<LocalDeviceRelay["connection"]>>,
) {
  type Codec = (deviceId: string, op: string, ...rest: unknown[]) => Promise<unknown>;
  const internal = relay as unknown as { callWithCodec: Codec };
  const scope = new AsyncLocalStorage<string>();
  const codec = internal.callWithCodec.bind(relay);
  const connection = relay.connection.bind(relay);
  let used = 0;
  // every call of the relay (also through callers that bound callV3 earlier) passes here
  const calls = vi
    .spyOn(internal, "callWithCodec")
    .mockImplementation((deviceId, called, ...rest) =>
      scope.run(called, () => codec(deviceId, called, ...rest)),
    );
  const reads = vi.spyOn(relay, "connection").mockImplementation(async (deviceId) => {
    if (scope.getStore() !== op) return connection(deviceId);
    used++;
    return stale;
  });
  return {
    used: () => used,
    restore: () => {
      calls.mockRestore();
      reads.mockRestore();
    },
  };
}

/** Launches two real tasks through the staged path: the fixture's call, then another call. */
async function launchTwo(f: Awaited<ReturnType<typeof fixture>>) {
  await runInBackgroundManaged(f.depsOf(a), await f.ctxFor(), {
    command: "npm run dev",
    description: "Serve",
    run_in_background: true,
  });
  const secondTask = await f.launchAnother();
  const second = (
    await f.db
      .selectFrom("background_tasks")
      .select("operation_id")
      .where("id", "=", secondTask)
      .executeTakeFirstOrThrow()
  ).operation_id as string;
  const first = f.operationId;
  expect(f.device.workers.map((w) => w.operationId).sort()).toEqual([first, second].sort());
  for (const op of [first, second]) {
    expect(await intentOf(f, op)).toMatchObject({ state: "background-running" });
    expect(await taskOf(f, op)).toMatchObject({ status: "running", launch_state: "acknowledged" });
  }
  return { first, second };
}

const refOf = async (f: Awaited<ReturnType<typeof fixture>>, operationId: string) =>
  (await taskOf(f, operationId)).execution_ref as unknown as SandboxExecutionRef;
const workerOf = (f: Awaited<ReturnType<typeof fixture>>, operationId: string) =>
  f.device.workers.find((w) => w.operationId === operationId);

describe("revocation across a disconnect on the real staged session", () => {
  it("is delivered on reconnect and stops exactly the revoked task; the sibling keeps running", async () => {
    const f = await fixture();
    const stops = f.device.recordStops();
    const { first: revoked, second: sibling } = await launchTwo(f);

    // the device goes away; replica b writes the revocation and its worker tries to apply it
    await f.gw.disconnect();
    await revokeOne(b, f, revoked);
    expect(await intentOf(f, revoked)).toMatchObject({
      state: "revoked",
      revoke_acknowledged: false,
    });
    expect(await taskOf(f, revoked)).toMatchObject({ launch_state: "cancel-pending" });
    await reconcileJob(b).revoke(revoked);
    // not deliverable now: still owed (a deferred attempt is queued), nothing reached the device
    expect(await intentOf(f, revoked)).toMatchObject({
      state: "revoked",
      revoke_acknowledged: false,
      reconcile_attempt: 1,
    });
    expect(await taskOf(f, revoked)).toMatchObject({ status: "running", stopping_at: null });
    const deferred = await f.db
      .selectFrom("outbox")
      .select("job_id")
      .where("job_id", "=", `sandbox-operation-revoke-${revoked}-1`)
      .execute();
    expect(deferred).toHaveLength(1);
    expect(stops).toEqual([]);
    expect(f.device.workers.every((w) => !w.cancelled)).toBe(true);

    // the device reconnects with the same session state; replica a's worker applies the owed stop
    await f.gw.connect();
    await reconcileJob(a).revoke(revoked);
    // exactly one stop, by the revoked task's exact ref, reached the device
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      operationId: revoked,
      instanceId: f.deviceId,
      instanceGeneration: String(MANAGED_GENERATION),
    });
    expect((await taskOf(f, revoked)).execution_ref).toEqual(stops[0]);
    expect(f.device.workers.find((w) => w.operationId === revoked)?.cancelled).toBe(true);
    expect(await intentOf(f, revoked)).toMatchObject({
      state: "revoked",
      revoke_acknowledged: true,
    });
    expect(await taskOf(f, revoked)).toMatchObject({ status: "stopped", launch_state: "terminal" });

    // the sibling keeps its grant and keeps running on the device
    expect(f.device.workers.find((w) => w.operationId === sibling)?.cancelled).toBe(false);
    expect(await intentOf(f, sibling)).toMatchObject({
      state: "background-running",
      revoke_acknowledged: false,
    });
    expect(await taskOf(f, sibling)).toMatchObject({
      status: "running",
      launch_state: "acknowledged",
    });
    const status = await f.device.backend.background.status(
      { id: f.deviceId },
      (await taskOf(f, sibling)).execution_ref as unknown as SandboxExecutionRef,
      AbortSignal.timeout(5000),
    );
    expect(status).toEqual({ state: "running" });

    // a duplicate delivery of the revoke on either replica changes nothing
    await Promise.all([reconcileJob(a).revoke(revoked), reconcileJob(b).revoke(revoked)]);
    expect(stops).toHaveLength(1);
    expect(f.device.workers.find((w) => w.operationId === sibling)?.cancelled).toBe(false);
  });

  it("a revocation while connected stops exactly that task at once, written and applied on other replicas", async () => {
    const f = await fixture();
    const stops = f.device.recordStops();
    const { first: sibling, second: revoked } = await launchTwo(f);
    await revokeOne(a, f, revoked);
    await reconcileJob(b).revoke(revoked);
    expect(stops).toEqual([await refOf(f, revoked)]);
    expect(workerOf(f, revoked)?.cancelled).toBe(true);
    expect(workerOf(f, sibling)?.cancelled).toBe(false);
    expect(await intentOf(f, revoked)).toMatchObject({ revoke_acknowledged: true });
    expect(await taskOf(f, revoked)).toMatchObject({ status: "stopped", launch_state: "terminal" });
    expect(await intentOf(f, sibling)).toMatchObject({ state: "background-running" });
    expect(await taskOf(f, sibling)).toMatchObject({ status: "running" });
  });

  it("a reconnect without a revocation keeps both tasks running with their grants", async () => {
    const f = await fixture();
    const stops = f.device.recordStops();
    const { first, second } = await launchTwo(f);
    await f.gw.disconnect();
    await f.gw.connect();
    // both replicas read the exact status of both tasks over the new connection
    for (const k of [a, b])
      for (const op of [first, second])
        expect(
          await stagedProviderOf(k).background?.status(
            { id: f.deviceId },
            await refOf(f, op),
            AbortSignal.timeout(10_000),
          ),
        ).toEqual({ state: "running" });
    expect(stops).toEqual([]);
    expect(f.device.workers.every((w) => !w.cancelled)).toBe(true);
    for (const op of [first, second])
      expect(await intentOf(f, op)).toMatchObject({
        state: "background-running",
        revoke_acknowledged: false,
      });
  });

  it("a stop in flight when the device disconnects is answered after the reconnect and settles the revocation", async () => {
    const f = await fixture();
    const stops = f.device.recordStops();
    const { first: revoked, second: sibling } = await launchTwo(f);
    const held = f.device.holdStops();
    await revokeOne(b, f, revoked);
    const applying = reconcileJob(a).revoke(revoked);
    await held.entered;
    // the stop reached the device; its socket closes before the answer goes out
    await f.gw.disconnect();
    await f.gw.connect();
    held.release();
    await applying;
    // the answer the session held for the next socket settled the revocation: one exact stop
    expect(stops).toEqual([await refOf(f, revoked)]);
    expect(await intentOf(f, revoked)).toMatchObject({
      revoke_acknowledged: true,
      reconcile_attempt: 0,
    });
    expect(await taskOf(f, revoked)).toMatchObject({ status: "stopped", launch_state: "terminal" });
    expect(workerOf(f, sibling)?.cancelled).toBe(false);
    expect(await taskOf(f, sibling)).toMatchObject({ status: "running" });
  });

  it("revoking both tasks while disconnected stops each by its own ref, once, after the reconnect", async () => {
    const f = await fixture();
    const stops = f.device.recordStops();
    const { first, second } = await launchTwo(f);
    await f.gw.disconnect();
    // the root-level writer revokes everything the conversation runs
    await a.app.get(TransactionHost).run(async () => {
      const ceiling = a.app.get(PermissionCeilingWrites);
      const subject = { orgId: f.orgId, rootConversationId: f.conversationId };
      await ceiling.lock(subject, "root");
      await ceiling.publishLocked(subject, "root");
    });
    await Promise.all([reconcileJob(a).revoke(first), reconcileJob(b).revoke(second)]);
    expect(stops).toEqual([]);
    for (const op of [first, second])
      expect(await intentOf(f, op)).toMatchObject({ state: "revoked", revoke_acknowledged: false });
    await f.gw.connect();
    // each replica applies one owed stop, and each also redelivers the other's
    await Promise.all([reconcileJob(b).revoke(first), reconcileJob(a).revoke(second)]);
    await Promise.all([reconcileJob(a).revoke(first), reconcileJob(b).revoke(second)]);
    expect(stops).toHaveLength(2);
    expect(new Set(stops.map((r) => r.operationId))).toEqual(new Set([first, second]));
    for (const op of [first, second]) {
      expect(stops.find((r) => r.operationId === op)).toEqual(await refOf(f, op));
      expect(workerOf(f, op)?.cancelled).toBe(true);
      expect(await intentOf(f, op)).toMatchObject({ revoke_acknowledged: true });
      expect(await taskOf(f, op)).toMatchObject({ status: "stopped", launch_state: "terminal" });
    }
  });
});

describe("a staged request refused as not sent (B-5)", () => {
  it("is a definite pre-effect failure; a retry keeps the same operation and no unknown outcome", async () => {
    const f = await fixture();
    const relay = a.app.get(LocalDeviceRelay);
    // the connection the caller read just before the device reconnected
    const stale = await relay.connection(f.deviceId);
    await f.gw.disconnect();
    await f.gw.connect();
    expect((await relay.connection(f.deviceId)).connectionId).not.toBe(stale.connectionId);
    const read = staleFor(relay, "backgroundStart", stale);
    const first = await runInBackgroundManaged(f.depsOf(a), await f.ctxFor(), {
      command: "npm run dev",
      description: "Serve",
      run_in_background: true,
    }).catch((e: unknown) => e as Error);
    read.restore();
    expect(read.used()).toBe(1);
    // the gateway refused the frame of the old connection: the device never saw the start
    expect(f.device.workers).toEqual([]);
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toMatch(/was not started/);
    // the kernel's own text: nothing was sent, a retry is safe
    expect((first as Error).message).toMatch(/reconnected before the start was sent/);
    expect(await intentOf(f, f.operationId)).toMatchObject({
      state: "completed",
      outcome_unknown: false,
    });
    expect(await taskOf(f, f.operationId)).toMatchObject({
      status: "failed",
      launch_state: "terminal",
    });

    // the same call again: the same operation identity, a definite answer, never unknown
    const retry = await runInBackgroundManaged(f.depsOf(b), await f.ctxFor(), {
      command: "npm run dev",
      description: "Serve",
      run_in_background: true,
    }).catch((e: unknown) => e as Error);
    expect((retry as Error).message).toMatch(/was not started/);
    const intents = await f.db
      .selectFrom("sandbox_operation_intents")
      .select(["operation_id", "state", "outcome_unknown"])
      .where("org_id", "=", f.orgId)
      .execute();
    expect(intents).toEqual([
      { operation_id: f.operationId, state: "completed", outcome_unknown: false },
    ]);
    expect(f.device.workers).toEqual([]);
  });

  it("refusing a recovery's request as not sent keeps the start unknown; the next recovery finds it", async () => {
    const f = await fixture();
    // replica a's start reaches the device, but its answer is lost on the way back
    const staged = stagedProviderOf(a);
    const start = staged.background?.start.bind(staged.background);
    if (!start) throw new Error("no staged start");
    a.app.get(SandboxProviders).register({
      plugin: MANAGED_PROVIDER,
      version: "test-1",
      impl: Object.assign(Object.create(null), staged, {
        background: {
          ...staged.background,
          start: async (...args: Parameters<typeof start>) => {
            await start(...args);
            throw new Error("the answer was lost");
          },
        },
      }) as SandboxProvider,
    });
    await expect(
      runInBackgroundManaged(f.depsOf(a), await f.ctxFor(), {
        command: "npm run dev",
        description: "Serve",
        run_in_background: true,
      }),
    ).rejects.toThrow(/may have started/);
    expect(f.device.workers.map((w) => w.operationId)).toEqual([f.operationId]);
    expect(await intentOf(f, f.operationId)).toMatchObject({
      state: "started-or-unknown",
      outcome_unknown: true,
    });

    // replica b's recovery asks under a connection the device has since replaced: not sent
    const relay = b.app.get(LocalDeviceRelay);
    const stale = await relay.connection(f.deviceId);
    await f.gw.disconnect();
    await f.gw.connect();
    const read = staleFor(relay, "backgroundStart", stale);
    await reconcileJob(b).reconcile(f.operationId);
    read.restore();
    expect(read.used()).toBe(1);
    // a recovery that was never sent proves nothing about the first dispatch: still unknown
    expect(await intentOf(f, f.operationId)).toMatchObject({
      state: "started-or-unknown",
      outcome_unknown: true,
      reconcile_attempt: 1,
    });
    expect(await taskOf(f, f.operationId)).toMatchObject({
      status: "running",
      launch_state: "dispatched",
    });

    // the next recovery reaches the device, which answers the original launch's ref
    await reconcileJob(b).reconcile(f.operationId);
    expect(f.device.workers.map((w) => w.operationId)).toEqual([f.operationId]);
    expect(await intentOf(f, f.operationId)).toMatchObject({
      state: "background-running",
      outcome_unknown: false,
    });
    expect(await taskOf(f, f.operationId)).toMatchObject({
      status: "running",
      launch_state: "acknowledged",
    });
  });
});
