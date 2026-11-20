import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SANDBOX_ROOTS,
  type SandboxHandle,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { LocalInstanceBindings } from "../../src/local-devices/instance-bindings.js";
import { LocalDeviceRelay } from "../../src/local-devices/relay.js";
import { createLogger } from "../../src/log.js";
import { SandboxLeases } from "../../src/sandbox/leases.js";
import { LOCAL_PROVIDER, SandboxProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { readFakeSandboxOps } from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";
import { seedDevice } from "../helpers/sandbox.js";
import { seedConversation } from "../helpers/tool-fixtures.js";
import { stagedHello } from "../local-devices/fake-machine-v3.js";

/**
 * Two kernel replicas (two independent kernels in one process: own PG pools, Redis connections and
 * providers; shared PG and Redis) acquire the same staged local device at once (permission
 * activation plan B-8). The exclusive lifecycle lease serializes them: one generation is
 * committed, one `bindInstance` is sent (resent with the same binding id after a lost reply), and
 * the other replica enters only once the binding is installed. The B1 reconcile marker, written
 * under the exclusive lease on one replica, refuses the next acquire on both (B-11).
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

let pg: TestContainer, redis: TestContainer, raw: ReturnType<typeof createDb>;
let root: string;
const kernels: TestKernel[] = [];
beforeAll(async () => {
  [pg, redis] = await Promise.all([startTestPostgres(), startTestRedis()]);
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-binding-dual-"));
  const config = KernelConfigSchema.parse({
    db: { url: pg.url, poolMax: 6 },
    redis: { url: redis.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    roles: ["api"],
    extensions: [SANDBOX_FAKE],
    extensionConfig: { "sandbox-fake": { root } },
    extensionPermissions: { autoApprove: true },
  });
  for (let i = 0; i < 2; i++)
    kernels.push(
      await startKernel(config, { env: {}, logger: createLogger("error", { write: () => {} }) }),
    );
  raw = createDb(pg.url, 3);
});
afterAll(async () => {
  for (const k of kernels) await k.close();
  await raw?.destroy();
  await Promise.all([pg?.stop(), redis?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.devices, capybara.device_instances, capybara.outbox, capybara.device_generation_high_water, capybara.device_instance_bindings, capybara.device_permission_reports, capybara.device_retirement_members, capybara.device_retirement_obligations",
  );
});

const db = () => kernelDb(raw);
const signal = () => AbortSignal.timeout(30_000);
const ROOTS = { ...DEFAULT_SANDBOX_ROOTS, workspace: "/Users/owner/capybara" };

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

/** The machine's lifecycle as each replica's staged provider sees it. */
function fakeLocal(creates: string[]): SandboxProvider {
  const handle = (name: string): SandboxHandle => ({
    id: name.replace(/^cap-device-/, ""),
    roots: ROOTS,
  });
  return {
    concurrentExec: true,
    sessionIsolation: false,
    async createFileSystem({ name }: { name: string }) {
      return { id: name };
    },
    async destroyFileSystem() {},
    async destroyFileSystemByName() {},
    async create({ name }: { name: string }) {
      creates.push(name);
      return handle(name);
    },
    async resume() {
      return "resumed";
    },
    async suspend() {},
    async destroy() {},
    async destroyByName() {},
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false };
    },
    async killAll() {},
    async killTagged() {},
    async readFile() {
      return null;
    },
    async writeFile() {},
    async stat() {
      return null;
    },
  } as unknown as SandboxProvider;
}

/**
 * A staged local device both replicas reach: each registers its own provider with its own binder,
 * and each replica's relay delivers `bindInstance` to the same authenticated machine.
 */
async function device(opts: { binder?: boolean } = {}) {
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
  const creates: string[] = [];
  const machine = {
    sent: [] as { replica: number; bindingId: string }[],
    lose: false,
    /** Resolved when a bind reaches the machine; the answer waits for `release`. */
    reached: barrier(),
    release: Promise.resolve() as Promise<void>,
  };
  kernels.forEach((k, replica) => {
    k.app.get(SandboxProviders).register({
      plugin: LOCAL_PROVIDER,
      impl: fakeLocal(creates),
      ...(opts.binder !== false && { binder: k.app.get(LocalInstanceBindings) }),
    });
    const relay = k.app.get(LocalDeviceRelay);
    vi.spyOn(relay, "connection").mockResolvedValue({ connectionId: "c1", maxFrameBytes: 69632 });
    vi.spyOn(relay, "callV3").mockImplementation(async (_d, op, args) => {
      expect(op).toBe("bindInstance");
      machine.sent.push({ replica, bindingId: args.bindingId as string });
      machine.reached.resolve();
      await machine.release;
      if (machine.lose) throw new Error("device.offline: the answer was lost");
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
        permissionSupport: {
          version: 2 as const,
          restricted: null,
          boundary: "operation",
          network: { openPublic: false, allowlist: false, perOperationHosts: false },
          outsideSandbox: true,
          background: true,
          unavailableReason: "Restricted per-instance validation pending",
        },
        ownerCeiling: stagedHello().ownerCeiling,
      };
    });
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
      .select(["binding_id", "status"])
      .where("device_id", "=", deviceId)
      .execute();
  return { ...seed, deviceId, ctx, creates, machine, bindings };
}

/** Resolves once `replica` has tried to take a lease on the device. */
function leaseAttempt(replica: number) {
  const tried = barrier();
  const leases = kernels[replica]?.app.get(SandboxLeases);
  if (!leases) throw new Error("missing replica");
  for (const method of ["tryExclusive", "tryShared"] as const) {
    const original = leases[method].bind(leases) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(leases, method).mockImplementation((async (...args: unknown[]) => {
      tried.resolve();
      return original(...args);
    }) as never);
  }
  return tried.promise;
}

const use = (replica: number, ctx: Awaited<ReturnType<typeof device>>["ctx"]) =>
  kernels[replica]?.app.get(SandboxService).withSandbox(
    ctx,
    async () => {
      // every holder runs on an installed binding
      const rows = await db()
        .selectFrom("device_instance_bindings")
        .select("status")
        .where("device_id", "=", ctx.deviceId)
        .execute();
      return rows.map((r) => r.status);
    },
    signal(),
  );

it("two replicas racing on a fresh device commit one generation and send one binding", async () => {
  const f = await device();
  const release = barrier();
  f.machine.release = release.promise;
  const first = use(0, f.ctx);
  // replica 0 holds the exclusive lease with its bind in flight; replica 1 arrives meanwhile
  await f.machine.reached.promise;
  const tried = leaseAttempt(1);
  const second = use(1, f.ctx);
  await tried;
  release.resolve();
  expect(await first).toEqual(["installed"]);
  expect(await second).toEqual(["installed"]);
  const rows = await f.bindings();
  expect(rows).toMatchObject([{ status: "installed" }]);
  expect(f.creates).toHaveLength(1);
  expect(f.machine.sent).toEqual([{ replica: 0, bindingId: rows[0]?.binding_id }]);
});

it("after a lost reply both replicas resend the same binding id once between them", async () => {
  const f = await device();
  f.machine.lose = true;
  await expect(use(0, f.ctx)).rejects.toThrow("lost");
  const [awaiting] = await f.bindings();
  expect(awaiting?.status).toBe("awaiting-device");
  f.machine.lose = false;
  f.machine.reached = barrier();
  const release = barrier();
  f.machine.release = release.promise;
  const a = use(0, f.ctx);
  const b = use(1, f.ctx);
  await f.machine.reached.promise;
  release.resolve();
  expect(await a).toEqual(["installed"]);
  expect(await b).toEqual(["installed"]);
  expect(f.creates).toHaveLength(1);
  expect(f.machine.sent.map((s) => s.bindingId)).toEqual([
    awaiting?.binding_id,
    awaiting?.binding_id,
  ]);
  expect(await f.bindings()).toMatchObject([
    { binding_id: awaiting?.binding_id, status: "installed" },
  ]);
});

it("lost replies on both replicas keep one generation and one binding id until it installs", async () => {
  const f = await device();
  f.machine.lose = true;
  const results = await Promise.allSettled([use(0, f.ctx), use(1, f.ctx)]);
  expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  const [awaiting] = await f.bindings();
  expect(awaiting?.status).toBe("awaiting-device");
  f.machine.lose = false;
  expect(await use(1, f.ctx)).toEqual(["installed"]);
  expect(f.creates).toHaveLength(1);
  expect(new Set(f.machine.sent.map((s) => s.bindingId))).toEqual(new Set([awaiting?.binding_id]));
  expect(f.machine.sent).toHaveLength(3);
  expect(await f.bindings()).toMatchObject([{ status: "installed" }]);
});

it("an open legacy obligation refuses both replicas and sends no bind", async () => {
  const f = await device();
  f.machine.lose = true;
  await expect(use(0, f.ctx)).rejects.toThrow("lost");
  const generation = (
    await db()
      .selectFrom("device_instance_bindings")
      .select("instance_generation")
      .where("device_id", "=", f.deviceId)
      .executeTakeFirstOrThrow()
  ).instance_generation;
  await db()
    .insertInto("device_retirement_obligations")
    .values({
      device_id: f.deviceId,
      org_id: f.orgId,
      provider: LOCAL_PROVIDER,
      instance_generation: String(Number(generation) - 1),
      state: "quarantined",
    })
    .execute();
  f.machine.lose = false;
  const results = await Promise.allSettled([use(0, f.ctx), use(1, f.ctx)]);
  for (const r of results)
    expect(r.status === "rejected" && r.reason).toMatchObject({
      name: "RetirementPendingError",
      code: "device.replace_required",
    });
  expect(f.machine.sent).toHaveLength(1);
  expect(await f.bindings()).toMatchObject([{ status: "awaiting-device" }]);
});

it("protocol 2 (no binder) on both replicas: one instance, no bind", async () => {
  const f = await device({ binder: false });
  const [a, b] = await Promise.all([use(0, f.ctx), use(1, f.ctx)]);
  expect(a).toEqual(["awaiting-device"]);
  expect(b).toEqual(["awaiting-device"]);
  expect(f.creates).toHaveLength(1);
  expect(f.machine.sent).toEqual([]);
});

it("a reconcile marker written under one replica's exclusive lease refuses both replicas", async () => {
  const seed = await seedConversation(raw);
  const deviceId = await seedDevice(raw, seed.orgId, seed.accountId, "cloud");
  const ctx = {
    orgId: seed.orgId,
    deviceId,
    holderConversationId: seed.conversationId,
    actor: { accountId: seed.accountId, conversationId: seed.conversationId },
  };
  const sandbox = (replica: number) => {
    const s = kernels[replica]?.app.get(SandboxService);
    if (!s) throw new Error("missing replica");
    return s;
  };
  await sandbox(0).withSandbox(ctx, async () => "created", signal());
  // replica 0 holds a shared use while replica 1 (the snapshot writer) waits for the exclusive lease
  const inUse = barrier();
  const done = barrier();
  const holding = sandbox(0).withSandbox(
    ctx,
    async () => {
      inUse.resolve();
      await done.promise;
      return "held";
    },
    signal(),
  );
  await inUse.promise;
  const leases = kernels[1]?.app.get(SandboxLeases);
  if (!leases) throw new Error("missing replica");
  const writer = leases.acquireExclusive(deviceId, signal(), undefined, { intent: true });
  done.resolve();
  expect(await holding).toBe("held");
  const lease = await writer;
  await db()
    .updateTable("devices")
    .set({ permission_reconcile_required: true })
    .where("id", "=", deviceId)
    .execute();
  await lease.release();
  const before = await readFakeSandboxOps(root);
  const fn = vi.fn(async () => "ran");
  for (const replica of [0, 1])
    await expect(sandbox(replica).withSandbox(ctx, fn, signal())).rejects.toMatchObject({
      code: "device.permission_reconcile_required",
    });
  expect(fn).not.toHaveBeenCalled();
  expect(await readFakeSandboxOps(root)).toEqual(before);
});

it("an acquire waiting while the snapshot writer holds the lease is refused once it marks", async () => {
  const seed = await seedConversation(raw);
  const deviceId = await seedDevice(raw, seed.orgId, seed.accountId, "cloud");
  const ctx = {
    orgId: seed.orgId,
    deviceId,
    holderConversationId: seed.conversationId,
    actor: { accountId: seed.accountId, conversationId: seed.conversationId },
  };
  const sandbox = (replica: number) => {
    const s = kernels[replica]?.app.get(SandboxService);
    if (!s) throw new Error("missing replica");
    return s;
  };
  await sandbox(0).withSandbox(ctx, async () => "created", signal());
  const leases = kernels[1]?.app.get(SandboxLeases);
  if (!leases) throw new Error("missing replica");
  // replica 1 is the B1 snapshot writer: it holds the exclusive lease while it decides
  const lease = await leases.acquireExclusive(deviceId, signal(), undefined, { intent: true });
  const before = await readFakeSandboxOps(root);
  const tried = leaseAttempt(0);
  const fn = vi.fn(async () => "ran");
  const waiting = sandbox(0).withSandbox(ctx, fn, signal());
  await tried;
  await db()
    .updateTable("devices")
    .set({ permission_reconcile_required: true })
    .where("id", "=", deviceId)
    .execute();
  await lease.release();
  await expect(waiting).rejects.toMatchObject({ code: "device.permission_reconcile_required" });
  expect(fn).not.toHaveBeenCalled();
  expect(await readFakeSandboxOps(root)).toEqual(before);
});
