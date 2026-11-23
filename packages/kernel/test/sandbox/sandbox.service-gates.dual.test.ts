import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SANDBOX_ROOTS,
  type DeviceProvider,
  type SandboxBrowseScope,
  type SandboxHandle,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import { SandboxLeases } from "../../src/sandbox/leases.js";
import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { DeviceProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { KERNEL_VERSION } from "../../src/version.js";
import { readFakeSandboxOps } from "../fixtures/plugins/device-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { managedUseOn } from "../helpers/managed-calls.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";
import { seedDevice } from "../helpers/sandbox.js";
import { seedConversation as seedRootConversation } from "../helpers/tool-fixtures.js";

/**
 * The SandboxService acquire gates (permission activation plan W1-E), on two kernel replicas (two
 * independent kernels in one process: own PG pools, Redis connections and providers; shared PG and
 * Redis): the exclusive lifecycle lease serializes a race on one device (one instance is created
 * and both enter it); a device carrying `permission_reconcile_required` (B-11) is refused on every
 * acquire path (managed operations, a managed call's start, trusted preparation, owner browse)
 * before any provider call, checked under the lease the B1 snapshot writer excludes, and a marker
 * written under one replica's exclusive lease refuses the next acquire on both. Uses go through
 * the managed route a tool call takes (`managedUseOn`: a claimed run of the holder conversation,
 * then `withOperations` under the real admission).
 */

/** The in-process provider both replicas register for the racing device. */
const PROVIDER = "@lease-dual-test";

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/device-fake/index.ts", import.meta.url),
);

let pg: TestContainer, redis: TestContainer, raw: ReturnType<typeof createDb>;
let root: string;
const kernels: TestKernel[] = [];
beforeAll(async () => {
  [pg, redis] = await Promise.all([startTestPostgres(), startTestRedis()]);
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-gates-dual-"));
  const config = KernelConfigSchema.parse({
    db: { url: pg.url, poolMax: 6 },
    redis: { url: redis.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    roles: ["api"],
    extensions: [SANDBOX_FAKE],
    extensionConfig: { "device-fake": { root } },
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
    "capybara.accounts, capybara.orgs, capybara.devices, capybara.device_instances, capybara.outbox, capybara.device_generation_high_water, capybara.device_permission_reports, capybara.device_retirement_members, capybara.device_retirement_obligations",
  );
});

const db = () => kernelDb(raw);

/** A root conversation of a member account (a managed call's actor must be an org member). */
async function seedConversation(r: typeof raw) {
  const seed = await seedRootConversation(r);
  await kernelDb(r)
    .insertInto("memberships")
    .values({ org_id: seed.orgId, account_id: seed.accountId, role: "owner" })
    .execute();
  return seed;
}

/** Another root conversation of the holder's account on its device (a second holder). */
async function secondHolder(ctx: UseCtx, agentId: string): Promise<UseCtx> {
  const conversationId = randomUUID();
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id, device_id)
    VALUES (${conversationId}, ${ctx.orgId}, ${agentId}, ${ctx.actor.accountId},
      ${ctx.deviceId})`.execute(raw);
  return { ...ctx, holderConversationId: conversationId, actor: { ...ctx.actor, conversationId } };
}

interface UseCtx {
  orgId: string;
  deviceId: string;
  holderConversationId: string;
  actor: { accountId: string; conversationId: string };
}
const signal = () => AbortSignal.timeout(30_000);
const ROOTS = { ...DEFAULT_SANDBOX_ROOTS, workspace: "/Users/owner/capybara" };

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

/** One device's lifecycle as each replica's in-process provider sees it (creates recorded). */
function fakeProvider(creates: string[]): DeviceProvider {
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
  } as unknown as DeviceProvider;
}

/** A device of {@link PROVIDER} both replicas reach, each with its own registered provider. */
async function device() {
  const seed = await seedConversation(raw);
  const deviceId = randomUUID();
  await db()
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: seed.orgId,
      owner_kind: "personal",
      owner_account_id: seed.accountId,
      provider: PROVIDER,
      name: "Laptop",
    })
    .execute();
  const creates: string[] = [];
  for (const k of kernels)
    k.app
      .get(DeviceProviders)
      .register({ plugin: PROVIDER, version: KERNEL_VERSION, impl: fakeProvider(creates) });
  const ctx = {
    orgId: seed.orgId,
    deviceId,
    holderConversationId: seed.conversationId,
    actor: { accountId: seed.accountId, conversationId: seed.conversationId },
  };
  return { ...seed, deviceId, ctx, creates };
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

/** The replica's kernel. */
const kernel = (replica: number): TestKernel => {
  const k = kernels[replica];
  if (!k) throw new Error("missing replica");
  return k;
};

/**
 * One managed use of the device on `replica` (a tool call of a claimed run of the holder), whose
 * run then ends: a conversation has one active run at most, so the holder's next use starts its
 * own.
 */
const use = async <T = string>(
  replica: number,
  ctx: UseCtx,
  fn: () => Promise<T> = async () => "entered" as T,
): Promise<T> => {
  try {
    return await managedUseOn(kernel(replica), raw, ctx, fn, signal());
  } finally {
    await db()
      .updateTable("runs")
      .set({ status: "completed" })
      .where("conversation_id", "=", ctx.holderConversationId)
      .where("status", "=", "running")
      .execute();
  }
};

it("two replicas racing on a fresh device create one instance and both enter it", async () => {
  const f = await device();
  // each replica's use is a tool call of its own conversation on the device
  const other = await secondHolder(f.ctx, f.agentId);
  const tried = leaseAttempt(1);
  const first = use(0, f.ctx);
  const second = use(1, other);
  await tried;
  expect(await Promise.all([first, second])).toEqual(["entered", "entered"]);
  expect(f.creates).toHaveLength(1);
});

it("a reconcile marker written under one replica's exclusive lease refuses both replicas", async () => {
  const seed = await seedConversation(raw);
  const deviceId = await seedDevice(raw, seed.orgId, seed.accountId);
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
  await sandbox(0).ensureRunning(ctx, signal());
  // replica 0 holds a shared use while replica 1 (the snapshot writer) waits for the exclusive lease
  const inUse = barrier();
  const done = barrier();
  const holding = use(0, ctx, async () => {
    inUse.resolve();
    await done.promise;
    return "held";
  });
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
  for (const replica of [0, 1]) {
    await expect(use(replica, ctx, fn)).rejects.toMatchObject({
      code: "device.permission_reconcile_required",
    });
    await expect(sandbox(replica).ensureRunning(ctx, signal())).rejects.toMatchObject({
      code: "device.permission_reconcile_required",
    });
  }
  expect(fn).not.toHaveBeenCalled();
  expect(await readFakeSandboxOps(root)).toEqual(before);
});

it("an acquire waiting while the snapshot writer holds the lease is refused once it marks", async () => {
  const seed = await seedConversation(raw);
  const deviceId = await seedDevice(raw, seed.orgId, seed.accountId);
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
  await sandbox(0).ensureRunning(ctx, signal());
  const leases = kernels[1]?.app.get(SandboxLeases);
  if (!leases) throw new Error("missing replica");
  // replica 1 is the B1 snapshot writer: it holds the exclusive lease while it decides
  const lease = await leases.acquireExclusive(deviceId, signal(), undefined, { intent: true });
  const before = await readFakeSandboxOps(root);
  const tried = leaseAttempt(0);
  const fn = vi.fn(async () => "ran");
  const waiting = use(0, ctx, fn);
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

/** The first replica's app (the single-replica gates run there). */
const app = () => (kernels[0] as TestKernel).app;

const ops = async () => (await readFakeSandboxOps(root)).map((o) => o.join(" "));
const marked = (deviceId: string, on = true) =>
  db()
    .updateTable("devices")
    .set({ permission_reconcile_required: on })
    .where("id", "=", deviceId)
    .execute();
const RECONCILE = { code: "device.permission_reconcile_required" };

async function cloudDevice() {
  const seed = await seedConversation(raw);
  const deviceId = await seedDevice(raw, seed.orgId, seed.accountId);
  const ctx = {
    orgId: seed.orgId,
    deviceId,
    holderConversationId: seed.conversationId,
    actor: { accountId: seed.accountId, conversationId: seed.conversationId },
  };
  return { ...seed, deviceId, ctx };
}

describe("the permission_reconcile_required marker refuses every acquire path (B-11)", () => {
  it("managed operations, a managed call's start and trusted preparation make no provider call", async () => {
    const f = await cloudDevice();
    await marked(f.deviceId);
    const before = await ops();
    const sandbox = app().get(SandboxService);
    const fn = vi.fn(async () => "ran");
    await expect(use(0, f.ctx, fn)).rejects.toMatchObject(RECONCILE);
    await expect(sandbox.ensureRunning(f.ctx, signal())).rejects.toMatchObject(RECONCILE);
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
    const sandbox = app().get(SandboxService);
    await sandbox.ensureRunning(f.ctx, signal());
    await marked(f.deviceId);
    const before = await ops();
    const fn = vi.fn(async () => "ran");
    // running: the shared fast path
    await expect(use(0, f.ctx, fn)).rejects.toMatchObject(RECONCILE);
    // suspended: the exclusive path would resume it
    await db()
      .updateTable("device_instances")
      .set({ status: "suspended" })
      .where("device_id", "=", f.deviceId)
      .execute();
    await expect(use(0, f.ctx, fn)).rejects.toMatchObject(RECONCILE);
    await expect(sandbox.ensureRunning(f.ctx, signal())).rejects.toMatchObject(RECONCILE);
    await expect(
      sandbox.withPreparation(f.ctx, "skills", [DEFAULT_SANDBOX_ROOTS.skills], fn, signal()),
    ).rejects.toMatchObject(RECONCILE);
    expect(fn).not.toHaveBeenCalled();
    expect(await ops()).toEqual(before);
    // once a lifecycle action cleared the marker the device is usable again
    await marked(f.deviceId, false);
    expect(await use(0, f.ctx, async () => "ran")).toBe("ran");
  });

  it("an owner browse refuses a marker that landed after its authority resolved", async () => {
    const f = await cloudDevice();
    const sandbox = app().get(SandboxService);
    await sandbox.ensureRunning(f.ctx, signal());
    // the B1 snapshot commits the marker between the browse authority and the lease
    vi.spyOn(app().get(SandboxOperationAuthority), "resolveBrowse").mockImplementation(async () => {
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
    const sandbox = app().get(SandboxService);
    await sandbox.ensureRunning(f.ctx, signal());
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
