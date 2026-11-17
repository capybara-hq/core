import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SANDBOX_ROOTS,
  type SandboxBrowseScope,
  type SandboxHandle,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { LocalInstanceBindings } from "../../src/local-devices/instance-bindings.js";
import { LocalDeviceRelay } from "../../src/local-devices/relay.js";
import { createLogger } from "../../src/log.js";
import { SandboxLeases } from "../../src/sandbox/leases.js";
import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import {
  LOCAL_PROVIDER,
  type SandboxProviderEntry,
  SandboxProviders,
} from "../../src/sandbox/providers.js";
import type { OperationSessionInvocation } from "../../src/sandbox/sandbox.service.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { readFakeSandboxOps } from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";
import { seedDevice } from "../helpers/sandbox.js";
import { seedConversation } from "../helpers/tool-fixtures.js";
import { stagedHello } from "../local-devices/fake-machine.js";

/**
 * The SandboxService acquire gates of the permission activation plan (W1-E):
 * - B-11: a device carrying `permission_reconcile_required` is refused on every acquire path
 *   (raw use, managed operations, trusted preparation, owner browse) before any provider call,
 *   checked under the lease the B1 snapshot writer excludes.
 * - B-8: on the staged v3 path (a provider entry with an instance binder) the exclusive holder
 *   binds the committed generation before it downgrades; a lost reply is resent with the same
 *   binding id by the next use; an open legacy obligation means no bind. Protocol 2 (no binder)
 *   never binds.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

let pg: TestContainer, redis: TestContainer, k: TestKernel, raw: ReturnType<typeof createDb>;
let root: string;
beforeAll(async () => {
  [pg, redis] = await Promise.all([startTestPostgres(), startTestRedis()]);
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-gates-"));
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pg.url, poolMax: 8 },
      redis: { url: redis.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      roles: ["api"],
      extensions: [SANDBOX_FAKE],
      extensionConfig: { "sandbox-fake": { root } },
      extensionPermissions: { autoApprove: true },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pg.url, 5);
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pg?.stop(), redis?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

let original: SandboxProviderEntry | undefined;
beforeEach(async () => {
  vi.restoreAllMocks();
  original = k.app.get(SandboxProviders).forName(LOCAL_PROVIDER);
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.devices, capybara.device_instances, capybara.outbox, capybara.device_generation_high_water, capybara.device_instance_bindings, capybara.device_permission_reports, capybara.device_retirement_members, capybara.device_retirement_obligations",
  );
});
afterEach(() => {
  if (original) k.app.get(SandboxProviders).register(original);
});

const db = () => kernelDb(raw);
const signal = () => AbortSignal.timeout(20_000);
const ops = async () => (await readFakeSandboxOps(root)).map((o) => o.join(" "));
const marked = (deviceId: string, on = true) =>
  db()
    .updateTable("devices")
    .set({ permission_reconcile_required: on })
    .where("id", "=", deviceId)
    .execute();
const RECONCILE = { code: "device.permission_reconcile_required" };
/** A local machine's quarantined earlier incarnation that never reported a boot (8.5). */
const LEGACY = { name: "RetirementPendingError", code: "device.replace_required" };

async function cloudDevice() {
  const seed = await seedConversation(raw);
  const deviceId = await seedDevice(raw, seed.orgId, seed.accountId, "cloud");
  const ctx = {
    orgId: seed.orgId,
    deviceId,
    holderConversationId: seed.conversationId,
    actor: { accountId: seed.accountId, conversationId: seed.conversationId },
  };
  return { ...seed, deviceId, ctx };
}

/** A managed invocation shape; the gate refuses before anything reads it. */
const invocation = (orgId: string, conversationId: string): OperationSessionInvocation => ({
  claim: {
    orgId,
    conversationId,
    rootId: conversationId,
    runId: randomUUID(),
    executionId: randomUUID(),
  },
  callId: "call",
  deadlineMs: Date.now() + 60_000,
});

describe("the permission_reconcile_required marker refuses every acquire path (B-11)", () => {
  it("raw use, managed operations and trusted preparation make no provider call", async () => {
    const f = await cloudDevice();
    await marked(f.deviceId);
    const before = await ops();
    const sandbox = k.app.get(SandboxService);
    const fn = vi.fn(async () => "ran");
    await expect(sandbox.withSandbox(f.ctx, fn, signal())).rejects.toMatchObject(RECONCILE);
    await expect(
      sandbox.withOperations(f.ctx, invocation(f.orgId, f.conversationId), fn, signal()),
    ).rejects.toMatchObject(RECONCILE);
    await expect(
      sandbox.withPreparation(f.ctx, "skills", [DEFAULT_SANDBOX_ROOTS.skills], fn, signal()),
    ).rejects.toMatchObject(RECONCILE);
    expect(fn).not.toHaveBeenCalled();
    expect(await ops()).toEqual(before);
    // no instance row was manufactured for the refused device
    expect(
      await db()
        .selectFrom("device_instances")
        .select("status")
        .where("device_id", "=", f.deviceId)
        .execute(),
    ).toEqual([]);
  });

  it("a running or suspended instance is neither entered, killed nor resumed", async () => {
    const f = await cloudDevice();
    const sandbox = k.app.get(SandboxService);
    await sandbox.withSandbox(f.ctx, async () => "created", signal());
    await marked(f.deviceId);
    const before = await ops();
    const fn = vi.fn(async () => "ran");
    // running: the shared fast path
    await expect(sandbox.withSandbox(f.ctx, fn, signal())).rejects.toMatchObject(RECONCILE);
    // suspended: the exclusive path would resume it
    await db()
      .updateTable("device_instances")
      .set({ status: "suspended" })
      .where("device_id", "=", f.deviceId)
      .execute();
    await expect(sandbox.withSandbox(f.ctx, fn, signal())).rejects.toMatchObject(RECONCILE);
    await expect(
      sandbox.withPreparation(f.ctx, "skills", [DEFAULT_SANDBOX_ROOTS.skills], fn, signal()),
    ).rejects.toMatchObject(RECONCILE);
    expect(fn).not.toHaveBeenCalled();
    expect(await ops()).toEqual(before);
    // once a lifecycle action cleared the marker the device is usable again
    await marked(f.deviceId, false);
    expect(await sandbox.withSandbox(f.ctx, async () => "ran", signal())).toBe("ran");
  });

  it("an owner browse refuses a marker that landed after its authority resolved", async () => {
    const f = await cloudDevice();
    const sandbox = k.app.get(SandboxService);
    await sandbox.withSandbox(f.ctx, async () => "created", signal());
    // the B1 snapshot commits the marker between the browse authority and the lease
    vi.spyOn(k.app.get(SandboxOperationAuthority), "resolveBrowse").mockImplementation(async () => {
      await marked(f.deviceId);
      return {} as SandboxBrowseScope;
    });
    const before = await ops();
    const fn = vi.fn(async () => "browsed");
    await expect(
      sandbox.withBrowse({ ...f.ctx, accountId: f.accountId }, fn, signal()),
    ).rejects.toMatchObject(RECONCILE);
    expect(fn).not.toHaveBeenCalled();
    expect(await ops()).toEqual(before);
  });

  it("an exact-ref drain still reaches the instance of a marked device", async () => {
    const f = await cloudDevice();
    const sandbox = k.app.get(SandboxService);
    await sandbox.withSandbox(f.ctx, async () => "created", signal());
    await marked(f.deviceId);
    const instance = await sandbox.currentInstance(f.deviceId);
    if (!instance) throw new Error("expected the running instance");
    const drained = await sandbox.ifRunning(
      f.deviceId,
      { createdAt: instance.createdAt, exactRef: true },
      async () => "stopped",
      signal(),
    );
    expect(drained).toEqual({ kind: "ran", value: "stopped" });
  });
});

// ---- B-8: post-commit binding on the staged path

const ROOTS = { ...DEFAULT_SANDBOX_ROOTS, workspace: "/Users/owner/capybara" };
const support = {
  version: 1 as const,
  restricted: null,
  fullAccess: true,
  background: true,
  unavailableReason: "Restricted per-instance validation pending",
};

/** A connected machine's lifecycle as the staged provider sees it (the handle is the device). */
function fakeLocal(events: string[]): SandboxProvider {
  const handle = (name: string): SandboxHandle => ({
    id: name.replace(/^cap-device-/, ""),
    roots: ROOTS,
  });
  return {
    concurrentExec: true,
    sessionIsolation: false,
    async createFileSystem({ name }: { name: string }) {
      events.push("createFileSystem");
      return { id: name };
    },
    async destroyFileSystem() {},
    async destroyFileSystemByName() {},
    async create({ name }: { name: string }) {
      events.push("create");
      return handle(name);
    },
    async resume() {
      events.push("resume");
      return "resumed";
    },
    async suspend() {},
    async destroy() {},
    async destroyByName() {},
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false };
    },
    async killAll() {
      events.push("killAll");
    },
    async killTagged() {
      events.push("killTagged");
    },
    async readFile() {
      return null;
    },
    async writeFile() {},
    async stat() {
      return null;
    },
    async browse() {
      events.push("browse");
      return {
        stat: async () => null,
        list: async () => [],
        scan: async () => [],
      };
    },
  } as unknown as SandboxProvider;
}

async function localDevice(opts: { binder?: boolean } = {}) {
  const seed = await seedConversation(raw);
  const deviceId = randomUUID();
  await db()
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: seed.orgId,
      owner_kind: "personal",
      owner_account_id: seed.accountId,
      source: "local",
      provider: LOCAL_PROVIDER,
      name: "Laptop",
    })
    .execute();
  await db()
    .insertInto("device_machines")
    .values({
      org_id: seed.orgId,
      device_id: deviceId,
      account_id: seed.accountId,
      credential_hash: randomUUID(),
      name: "Laptop",
      os: "darwin",
      arch: "arm64",
      program_version: "0.1.0",
      roots: JSON.stringify(ROOTS),
    })
    .execute();
  const events: string[] = [];
  k.app.get(SandboxProviders).register({
    plugin: LOCAL_PROVIDER,
    impl: fakeLocal(events),
    ...(opts.binder !== false && { binder: k.app.get(LocalInstanceBindings) }),
  });
  // every exclusive lease records its downgrade
  const leases = k.app.get(SandboxLeases);
  const tryExclusive = leases.tryExclusive.bind(leases);
  vi.spyOn(leases, "tryExclusive").mockImplementation(async (...args) => {
    const lease = await tryExclusive(...args);
    if (lease) {
      const downgrade = lease.downgrade.bind(lease);
      lease.downgrade = async () => {
        events.push("downgrade");
        return downgrade();
      };
    }
    return lease;
  });
  const ctx = {
    orgId: seed.orgId,
    deviceId,
    holderConversationId: seed.conversationId,
    actor: { accountId: seed.accountId, conversationId: seed.conversationId },
  };
  const bindings = () =>
    db()
      .selectFrom("device_instance_bindings")
      .select(["instance_generation", "binding_id", "status"])
      .where("device_id", "=", deviceId)
      .execute();
  return { ...seed, deviceId, ctx, events, bindings };
}

/** The staged transport answers bindInstance as the authenticated machine; `lose` drops it. */
function deviceAnswers(events: string[]) {
  const relay = k.app.get(LocalDeviceRelay);
  const state = { lose: false, sent: [] as Record<string, unknown>[] };
  vi.spyOn(relay, "connection").mockResolvedValue({ connectionId: "c1", maxFrameBytes: 69632 });
  vi.spyOn(relay, "callV3").mockImplementation(async (_d, op, args) => {
    expect(op).toBe("bindInstance");
    events.push("bindInstance");
    state.sent.push(args);
    if (state.lose) throw new Error("device.offline: the answer was lost");
    const g = args.instanceGeneration as string;
    return {
      instanceId: args.instanceId as string,
      instanceGeneration: g,
      bindingId: args.bindingId as string,
      runtimeIdentity: {
        runtimeHash: "a".repeat(64),
        helperHash: "b".repeat(64),
        imageFingerprint: "c".repeat(64),
        instanceGeneration: g,
      },
      permissionSupport: support,
      ownerCeiling: stagedHello().ownerCeiling,
    };
  });
  return state;
}

describe("the exclusive holder binds before it downgrades (B-8, staged path)", () => {
  it("create, commit, bindInstance, installed, then downgrade; later uses send nothing", async () => {
    const f = await localDevice();
    const device = deviceAnswers(f.events);
    const sandbox = k.app.get(SandboxService);
    const run = async () => {
      // the callback runs on the shared lease: by then the binding is installed
      f.events.push(`fn:${(await f.bindings())[0]?.status}`);
      return "ran";
    };
    expect(await sandbox.withSandbox(f.ctx, run, signal())).toBe("ran");
    expect(f.events).toEqual([
      "createFileSystem",
      "create",
      "bindInstance",
      "downgrade",
      "fn:installed",
    ]);
    const [binding] = await f.bindings();
    expect(device.sent).toEqual([
      {
        instanceId: f.deviceId,
        instanceGeneration: binding?.instance_generation,
        bindingId: binding?.binding_id,
        expectedPreviousGeneration: null,
      },
    ]);
    // the shared fast path: no further bind
    expect(await sandbox.withSandbox(f.ctx, run, signal())).toBe("ran");
    expect(device.sent).toHaveLength(1);
  });

  it("a lost reply fails the use; the next use resends the same binding id, no new generation", async () => {
    const f = await localDevice();
    const device = deviceAnswers(f.events);
    const sandbox = k.app.get(SandboxService);
    device.lose = true;
    const fn = vi.fn(async () => "ran");
    await expect(sandbox.withSandbox(f.ctx, fn, signal())).rejects.toThrow("lost");
    expect(fn).not.toHaveBeenCalled();
    expect(await f.bindings()).toMatchObject([{ status: "awaiting-device" }]);
    device.lose = false;
    expect(await sandbox.withSandbox(f.ctx, fn, signal())).toBe("ran");
    const rows = await f.bindings();
    expect(rows).toMatchObject([{ status: "installed" }]);
    expect(device.sent.map((s) => s.bindingId)).toEqual([rows[0]?.binding_id, rows[0]?.binding_id]);
    expect(f.events.filter((e) => e === "create")).toHaveLength(1);
    expect(f.events.indexOf("downgrade")).toBeGreaterThan(f.events.lastIndexOf("bindInstance"));
  });

  it("an open legacy obligation refuses the use and sends no bind", async () => {
    const f = await localDevice();
    const device = deviceAnswers(f.events);
    const sandbox = k.app.get(SandboxService);
    device.lose = true;
    await expect(sandbox.withSandbox(f.ctx, async () => "ran", signal())).rejects.toThrow("lost");
    const [awaiting] = await f.bindings();
    // an earlier incarnation of the device may still run legacy work
    await db()
      .insertInto("device_retirement_obligations")
      .values({
        device_id: f.deviceId,
        org_id: f.orgId,
        provider: LOCAL_PROVIDER,
        instance_generation: String(Number(awaiting?.instance_generation) - 1),
        state: "quarantined",
      })
      .execute();
    device.lose = false;
    const fn = vi.fn(async () => "ran");
    await expect(sandbox.withSandbox(f.ctx, fn, signal())).rejects.toMatchObject(LEGACY);
    expect(fn).not.toHaveBeenCalled();
    expect(device.sent).toHaveLength(1);
    expect(await f.bindings()).toMatchObject([{ status: "awaiting-device" }]);
  });

  it("owner browse fails closed while the instance's binding is not installed", async () => {
    const f = await localDevice();
    const device = deviceAnswers(f.events);
    const sandbox = k.app.get(SandboxService);
    device.lose = true;
    await expect(sandbox.withSandbox(f.ctx, async () => "ran", signal())).rejects.toThrow("lost");
    vi.spyOn(k.app.get(SandboxOperationAuthority), "resolveBrowse").mockResolvedValue(
      {} as SandboxBrowseScope,
    );
    const fn = vi.fn(async (p: { stat(path: string, s: AbortSignal): Promise<unknown> }) =>
      p.stat("/Users/owner/capybara", signal()),
    );
    await expect(
      sandbox.withBrowse({ ...f.ctx, accountId: f.accountId }, fn, signal()),
    ).rejects.toMatchObject({
      name: "SandboxPermissionUnsupportedError",
      message: "The device instance is not running",
    });
    expect(fn).not.toHaveBeenCalled();
    expect(f.events).not.toContain("browse");
    expect(device.sent).toHaveLength(1);
  });

  it("a running local instance from before the binder gets a new generation and binds", async () => {
    const f = await localDevice();
    const device = deviceAnswers(f.events);
    // the activation path: an instance committed under protocol 2 has no binding
    await db()
      .insertInto("device_instances")
      .values({
        device_id: f.deviceId,
        org_id: f.orgId,
        provider: LOCAL_PROVIDER,
        status: "running",
        fs_status: "ready",
        fs_handle: JSON.stringify({ id: `cap-device-${f.deviceId}` }),
        handle: JSON.stringify({ id: f.deviceId, roots: ROOTS }),
        had_instance: true,
      })
      .execute();
    const sandbox = k.app.get(SandboxService);
    expect(await sandbox.withSandbox(f.ctx, async () => "ran", signal())).toBe("ran");
    expect(f.events).toEqual(["create", "bindInstance", "downgrade"]);
    const rows = await f.bindings();
    expect(rows).toMatchObject([{ status: "installed" }]);
    expect(device.sent.map((s) => s.bindingId)).toEqual([rows[0]?.binding_id]);
  });

  it("a bind lost after a resume never skips the resume cleanup on the retry", async () => {
    const f = await localDevice();
    const device = deviceAnswers(f.events);
    const sandbox = k.app.get(SandboxService);
    device.lose = true;
    await expect(sandbox.withSandbox(f.ctx, async () => "ran", signal())).rejects.toThrow("lost");
    await db()
      .updateTable("device_instances")
      .set({ status: "suspended" })
      .where("device_id", "=", f.deviceId)
      .execute();
    f.events.length = 0;
    // the resume succeeds, the bind answer is lost again
    await expect(sandbox.withSandbox(f.ctx, async () => "ran", signal())).rejects.toThrow("lost");
    device.lose = false;
    expect(await sandbox.withSandbox(f.ctx, async () => "ran", signal())).toBe("ran");
    expect(f.events.filter((e) => e === "resume")).toHaveLength(1);
    // the processes a resume may bring back were killed exactly once, before any bind
    expect(f.events.filter((e) => e === "killAll")).toHaveLength(1);
    expect(f.events.indexOf("killAll")).toBeLessThan(f.events.indexOf("bindInstance"));
  });

  it("protocol 2 (no binder) never binds and keeps its behaviour", async () => {
    const f = await localDevice({ binder: false });
    const device = deviceAnswers(f.events);
    const sandbox = k.app.get(SandboxService);
    expect(await sandbox.withSandbox(f.ctx, async () => "ran", signal())).toBe("ran");
    expect(await sandbox.withSandbox(f.ctx, async () => "ran", signal())).toBe("ran");
    expect(device.sent).toEqual([]);
    expect(f.events).toEqual(["createFileSystem", "create", "downgrade"]);
    expect(await f.bindings()).toMatchObject([{ status: "awaiting-device" }]);
  });
});
