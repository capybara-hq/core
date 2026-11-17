import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BackgroundLaunchLock } from "../../src/background/launch-lock.js";
import { RetireLegacyTasksJob } from "../../src/background/retire-legacy-tasks.job.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { XactLock } from "../../src/infra/database/xact-lock.js";
import type { LegacyRetirementStore } from "../../src/sandbox/legacy-retirement.js";
import type { SandboxOperationIntents } from "../../src/sandbox/operation-intents.js";
import { LOCAL_PROVIDER } from "../../src/sandbox/providers.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { createFakeSandbox } from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { handlesFor, retirementFor } from "../helpers/identity.js";
import { sandboxServiceFor, seedDevice } from "../helpers/sandbox.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

/**
 * Legacy retirement and the fail-closed reuse barrier (permission runtime cutover phase 8.5):
 * pre-upgrade SID rows, possibly dispatched reservations and kill_pending rows become durable
 * obligations of their exact device incarnation once the legacy-launch freeze is published; every
 * lifecycle acquisition is gated on them; a cloud incarnation is retired only by its provider's
 * confirmed whole-instance destroy, a local or unverifiable one stays quarantined.
 */

let pgc: TestContainer;
let rdc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let config: KernelConfig;
let root: string;
let seed: Awaited<ReturnType<typeof seedConversation>>;
let retirement: LegacyRetirementStore;
let tasks: BackgroundTaskStore;
/** Lifecycle calls the providers saw, `<provider> <op> [<instance>]`. */
let calls: string[];
let destroyFails: boolean;

const signal = () => AbortSignal.timeout(30_000);
const DAY = 24 * 3600_000;

/** A fake provider whose lifecycle calls are recorded; `destroy` fails while `destroyFails`. */
function spied(name: string, impl: SandboxProvider): SandboxProvider {
  const w = Object.create(impl) as SandboxProvider;
  w.create = async (args) => {
    const h = await impl.create(args);
    calls.push(`${name} create ${h.id}`);
    return h;
  };
  w.resume = (h, s) => {
    calls.push(`${name} resume ${h.id}`);
    return impl.resume(h, s);
  };
  w.destroy = async (h, s) => {
    calls.push(`${name} destroy ${h.id}`);
    if (destroyFails) throw new Error("provider refused the destroy");
    return impl.destroy(h, s);
  };
  w.killAll = (h, s) => {
    calls.push(`${name} killAll ${h.id}`);
    return impl.killAll(h, s);
  };
  w.killTagged = (h, tags, s) => {
    calls.push(`${name} killTagged ${h.id}`);
    return impl.killTagged(h, tags, s);
  };
  return w;
}

let cloud: SandboxProvider;
let local: SandboxProvider;

const service = (): SandboxService =>
  sandboxServiceFor({
    db,
    redis,
    provider: () => ({ plugin: "sandbox-fake", impl: cloud }),
    lookup: (plugin) => (plugin === "sandbox-fake" ? cloud : undefined),
    internal: [{ plugin: LOCAL_PROVIDER, impl: local }],
    config: () => config,
    log: {},
    lockPollMs: 20,
    retirement,
  });

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rdc.url);
  retirement = retirementFor(raw);
  const h = handlesFor(raw);
  tasks = new BackgroundTaskStore(
    h.db,
    h.txHost,
    new BackgroundLaunchLock(new XactLock(h.db, h.txHost), h.txHost),
  );
});

afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await redis.flushdb();
  await truncateTables(
    raw,
    "capybara.device_retirement_members, capybara.device_retirement_obligations, capybara.device_instance_destructions, capybara.legacy_launch_freeze, capybara.sandbox_operation_intents, capybara.device_instances, capybara.devices, capybara.accounts, capybara.orgs",
  );
  if (root) await rm(root, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), "cap-protocol-upgrade-"));
  calls = [];
  destroyFails = false;
  cloud = spied("cloud", createFakeSandbox(join(root, "cloud")));
  local = spied("local", createFakeSandbox(join(root, "local")));
  config = KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });
  seed = await seedConversation(raw);
});

const ctxFor = (deviceId: string) => ({
  orgId: seed.orgId,
  deviceId,
  holderConversationId: seed.conversationId,
  actor: { accountId: seed.accountId, conversationId: seed.conversationId },
});
/** One ordinary use: the instance it ran on. */
const use = (s: SandboxService, deviceId: string) =>
  s.withSandbox(
    ctxFor(deviceId),
    async (h, _p, info) => ({ id: h.id, fresh: info.fresh }),
    signal(),
  );
const instance = (deviceId: string) =>
  db
    .selectFrom("device_instances")
    .selectAll()
    .where("device_id", "=", deviceId)
    .executeTakeFirstOrThrow();
const obligations = (deviceId: string) =>
  db
    .selectFrom("device_retirement_obligations")
    .selectAll()
    .where("device_id", "=", deviceId)
    .orderBy("created_at")
    .execute();
const members = async () =>
  (
    await db
      .selectFrom("device_retirement_members")
      .select(["kind", "ref_id"])
      .orderBy("ref_id")
      .execute()
  ).map((m) => `${m.kind} ${m.ref_id}`);
const unavailable = { code: "device.unavailable" };

/** A legacy (SID-era) row as an older kernel wrote it (`legacy_dispatch` left at its default). */
async function legacyRow(
  deviceId: string,
  o: {
    sid?: string | null;
    status?: string;
    createdAt?: Date | null;
    killPending?: boolean;
    stopping?: boolean;
    dispatch?: "unknown" | "reserved" | "dispatched";
  } = {},
): Promise<string> {
  const id = `bt_${randomUUID()
    .replace(/[^a-z2-7]/g, "")
    .slice(0, 6)
    .padEnd(6, "a")}`;
  const status = o.status ?? "running";
  await sql`INSERT INTO capybara.background_tasks (id, org_id, conversation_id,
      sandbox_conversation_id, device_id, run_id, call_id, trigger_account_id, description, command,
      sid, output_path, status, finished_at, deadline_at, sandbox_created_at, kill_pending,
      stopping_at, legacy_dispatch)
    VALUES (${id}, ${seed.orgId}, ${seed.conversationId}, ${seed.conversationId}, ${deviceId},
      'run-1', ${`call-${id}`}, ${seed.accountId}, 'd', 'sleep 600', ${o.sid === undefined ? "4242" : o.sid},
      ${`/workspace/.capybara/tasks/${id}.out`}, ${status},
      ${status === "running" ? null : new Date()}, now() + interval '1 hour',
      ${o.createdAt === undefined ? null : o.createdAt}, ${o.killPending ?? false},
      ${o.stopping ? new Date() : null}, ${o.dispatch ?? "unknown"})`.execute(raw);
  return id;
}

/** A revoked managed background start whose exact cancellation is still owed (8.4 handoff). */
async function revokedStart(deviceId: string, provider: string, generation: string) {
  const operationId = randomUUID();
  const ref = { operationId, instanceId: "fake-old", instanceGeneration: generation };
  await sql`INSERT INTO capybara.sandbox_operation_intents (operation_id, org_id, account_id,
      device_id, ordinal, method, input_hash, admission_hash, input, scope, epochs, provider,
      provider_version, instance_generation, deadline, retain_until, state, execution_id,
      execution_ref, outcome_unknown)
    VALUES (${operationId}, ${seed.orgId}, ${seed.accountId}, ${deviceId}, 0, 'backgroundStart',
      'h', 'a', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, ${provider}, '1', ${generation},
      now() + interval '1 hour', now() + interval '1 day', 'revoked', ${randomUUID()},
      ${JSON.stringify(ref)}::jsonb, true)`.execute(raw);
  return operationId;
}

describe("enumeration under the legacy-launch freeze", () => {
  it("records running SID, possibly dispatched, stopping and kill_pending rows (terminal too), never converting a SID", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    await use(s, dev);
    const g = (await instance(dev)).created_at;
    const running = await legacyRow(dev, { createdAt: g });
    const reservedUnknown = await legacyRow(dev, { sid: null });
    const stopping = await legacyRow(dev, { createdAt: g, stopping: true });
    const killPending = await legacyRow(dev, { status: "lost", createdAt: g, killPending: true });
    const failedMaybeDispatched = await legacyRow(dev, { sid: null, status: "failed" });
    // reserved by the fenced launcher and never admitted for dispatch: owes nothing
    await legacyRow(dev, { sid: null, dispatch: "reserved" });
    // finished by the legacy poller with nothing left to kill
    await legacyRow(dev, { status: "completed", createdAt: g });

    // nothing is enumerated before the freeze is published
    expect(await retirement.scanUntilStable()).toEqual({ added: 0, stable: true });
    expect(await obligations(dev)).toEqual([]);

    await retirement.freeze("test");
    expect(await retirement.scanUntilStable()).toEqual({ added: 5, stable: true });
    expect(await members()).toEqual(
      [running, reservedUnknown, stopping, killPending, failedMaybeDispatched]
        .map((id) => `legacy-task ${id}`)
        .sort(),
    );
    const [o] = await obligations(dev);
    expect(o).toMatchObject({
      provider: "sandbox-fake",
      instance_generation: String(g.getTime()),
      state: "open",
    });
    expect(await obligations(dev)).toHaveLength(1);
    // the rows themselves are untouched: no SID becomes an execution reference
    const rows = await db
      .selectFrom("background_tasks")
      .select(["launch_state", "execution_ref", "sid"])
      .execute();
    expect(rows.every((r) => r.launch_state === "legacy" && r.execution_ref === null)).toBe(true);
    expect(await retirement.scanUntilStable()).toEqual({ added: 0, stable: true });
  });

  it("the freeze refuses a reserved legacy dispatch and marks an admitted one dispatched", async () => {
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    const before = await legacyRow(dev, { sid: null, dispatch: "reserved" });
    const after = await legacyRow(dev, { sid: null, dispatch: "reserved" });
    expect(await retirement.admitLegacyDispatch(seed.orgId, before)).toBe("admitted");
    await retirement.freeze("test");
    expect(await retirement.admitLegacyDispatch(seed.orgId, after)).toBe("frozen");
    const marks = await db
      .selectFrom("background_tasks")
      .select(["id", "legacy_dispatch"])
      .orderBy("id")
      .execute();
    expect(Object.fromEntries(marks.map((m) => [m.id, m.legacy_dispatch]))).toEqual({
      [before]: "dispatched",
      [after]: "reserved",
    });
  });
});

describe("the retirement gate", () => {
  it("cloud: a failed destroy keeps the obligation and refuses every acquire path; a confirmed destroy then builds fresh on the kept files", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    const old = await use(s, dev);
    const before = await instance(dev);
    await legacyRow(dev, { createdAt: before.created_at });
    await retirement.freeze("test");
    await retirement.scanUntilStable();
    calls = [];
    destroyFails = true;

    await expect(use(s, dev)).rejects.toMatchObject(unavailable);
    await expect(
      s.withPreparation(ctxFor(dev), "skills", ["/x"], async () => "prepared", signal()),
    ).rejects.toMatchObject(unavailable);
    expect(await s.retireLegacy(dev)).toBe("unavailable");
    const [held] = await obligations(dev);
    expect(held).toMatchObject({ state: "open", resolution: null });
    expect(held?.attempts).toBeGreaterThanOrEqual(3);
    expect(held?.last_error).toMatch(/refused the destroy/);
    // only the whole-instance destroy was tried: no resume, no broad kill, no new instance
    expect(calls.every((c) => c === `cloud destroy ${old.id}`)).toBe(true);
    expect((await instance(dev)).status).toBe("running");

    destroyFails = false;
    calls = [];
    const fresh = await use(s, dev);
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.fresh).toBe(true);
    expect(calls).toEqual([`cloud destroy ${old.id}`, `cloud create ${fresh.id}`]);
    const after = await instance(dev);
    expect(after.fs_handle).toEqual(before.fs_handle);
    expect(after.fs_status).toBe("ready");
    expect(await obligations(dev)).toMatchObject([
      { state: "resolved", resolution: "provider-destroyed" },
    ]);
    expect(await db.selectFrom("device_instance_destructions").selectAll().execute()).toMatchObject(
      [
        {
          device_id: dev,
          provider: "sandbox-fake",
          instance_generation: String(before.created_at.getTime()),
        },
      ],
    );
  });

  it("suspended: the old incarnation is destroyed whole before a fresh one, never resumed", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    const old = await use(s, dev);
    const g = (await instance(dev)).created_at;
    expect(await s.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
    await legacyRow(dev, { status: "lost", createdAt: g, killPending: true });
    await retirement.freeze("test");
    await retirement.scanUntilStable();
    calls = [];
    const fresh = await use(s, dev);
    expect(calls).toEqual([`cloud destroy ${old.id}`, `cloud create ${fresh.id}`]);
  });

  it("local: a no-op destroy, a reset or a new generation never clears; the device stays unavailable", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId, "local");
    await use(s, dev);
    await legacyRow(dev, { createdAt: (await instance(dev)).created_at });
    await retirement.freeze("test");
    await retirement.scanUntilStable();
    expect(await obligations(dev)).toMatchObject([{ provider: LOCAL_PROVIDER, state: "open" }]);
    calls = [];

    await expect(use(s, dev)).rejects.toMatchObject(unavailable);
    expect(await obligations(dev)).toMatchObject([{ state: "quarantined" }]);
    expect(calls).toEqual([]);

    // the reset destroys through the local provider (a no-op on a machine): no evidence
    await s.resetFileSystem(dev);
    await expect(use(s, dev)).rejects.toMatchObject(unavailable);
    expect(await s.retireLegacy(dev)).toBe("unavailable");
    expect(await obligations(dev)).toMatchObject([{ state: "quarantined", resolution: null }]);
    expect(await db.selectFrom("device_instance_destructions").selectAll().execute()).toEqual([]);
    await expect(
      retirement.recordDestruction(dev, LOCAL_PROVIDER, String(Date.now())),
    ).rejects.toThrow(/not evidence/);
  });

  it("offline: the obligation survives output pruning and later scans", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId, "local");
    await use(s, dev);
    const task = await legacyRow(dev, {
      status: "lost",
      createdAt: (await instance(dev)).created_at,
      killPending: true,
    });
    await retirement.freeze("test");
    await retirement.scanUntilStable();
    await sql`UPDATE capybara.background_tasks SET finished_at = now() - interval '400 days'`.execute(
      raw,
    );
    expect(await tasks.pruneFinished(new Date())).toBe(1);
    expect(await tasks.get(task)).toBeUndefined();
    expect(await retirement.scanUntilStable()).toEqual({ added: 0, stable: true });
    expect(await members()).toEqual([`legacy-task ${task}`]);
    await expect(use(s, dev)).rejects.toMatchObject(unavailable);
    expect(await retirement.report()).toMatchObject({
      frozen: true,
      quarantined: 1,
      retired: false,
    });
  });

  it("a reused provider handle with a changed generation is neither destroyed nor trusted", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    const old = await use(s, dev);
    const g1 = (await instance(dev)).created_at;
    await legacyRow(dev, { createdAt: g1 });
    await retirement.freeze("test");
    await retirement.scanUntilStable();
    // a rebuild by a provider that names instances by device: the same handle, a new generation
    await sql`UPDATE capybara.device_instances SET created_at = created_at + interval '5 seconds'
      WHERE device_id = ${dev}`.execute(raw);
    calls = [];
    await expect(use(s, dev)).rejects.toMatchObject(unavailable);
    expect(calls).toEqual([]);
    expect(await obligations(dev)).toMatchObject([
      { state: "quarantined", reason: expect.stringMatching(/replaced/) },
    ]);
    // only a recorded confirmed destruction of exactly the old generation clears it
    await retirement.recordDestruction(dev, "sandbox-fake", String(g1.getTime()));
    expect((await use(s, dev)).id).toBe(old.id);
    expect(calls).toEqual([]);
    expect(await obligations(dev)).toMatchObject([{ state: "resolved" }]);
  });
});

describe("revoked managed starts on an incarnation that no longer runs (8.4 handoff)", () => {
  const job = (s: SandboxService) =>
    new RetireLegacyTasksJob(
      retirement,
      s,
      {
        acknowledgeRevocation: async (id: string) => {
          await sql`UPDATE capybara.sandbox_operation_intents SET revoke_acknowledged = true
            WHERE operation_id = ${id} AND state = 'revoked'`.execute(raw);
        },
      } as Pick<SandboxOperationIntents, "acknowledgeRevocation"> as SandboxOperationIntents,
      tasks,
      {} as never,
      {} as never,
      { info() {}, warn() {} } as never,
    );
  const acknowledged = async (op: string) =>
    (
      await sql<{ revoke_acknowledged: boolean }>`SELECT revoke_acknowledged
        FROM capybara.sandbox_operation_intents WHERE operation_id = ${op}`.execute(raw)
    ).rows[0]?.revoke_acknowledged;

  it("a new generation alone never clears it; a confirmed destroy of exactly it does", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    await use(s, dev);
    const g1 = String((await instance(dev)).created_at.getTime());
    const stale = await revokedStart(dev, "sandbox-fake", String(Number(g1) - 60_000));
    const destroyed = await revokedStart(dev, "sandbox-fake", g1);
    // the instance it ran on is destroyed by the kernel's own path (confirmed, recorded) and
    // replaced by a new generation
    await s.destroyInactive(new Date(Date.now() + 365 * DAY));
    await use(s, dev);

    const r = await job(s).runOnce();
    expect(r.added).toBe(2);
    expect(await acknowledged(destroyed)).toBe(true);
    expect(await acknowledged(stale)).toBe(false);
    expect((await obligations(dev)).map((o) => [o.instance_generation === g1, o.state])).toEqual(
      expect.arrayContaining([
        [true, "resolved"],
        [false, "quarantined"],
      ]),
    );
    await expect(use(s, dev)).rejects.toMatchObject(unavailable);
  });

  it("the worker destroys a cloud incarnation with legacy work, then settles its members", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    const old = await use(s, dev);
    const task = await legacyRow(dev, {
      status: "lost",
      createdAt: (await instance(dev)).created_at,
      killPending: true,
    });
    await retirement.freeze("test");
    calls = [];
    const r = await job(s).runOnce();
    expect(r).toMatchObject({ added: 1, cleared: 1, settled: 1 });
    expect(calls).toEqual([`cloud destroy ${old.id}`]);
    expect((await tasks.get(task))?.killPending).toBe(false);
    expect(await retirement.report()).toMatchObject({ frozen: true, open: 0, retired: true });
  });
});
