import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { LegacyRetirementStore } from "../../src/sandbox/legacy-retirement.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { createFakeSandbox } from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { retirementFor } from "../helpers/identity.js";
import { sandboxServiceFor, seedDevice } from "../helpers/sandbox.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

/**
 * Legacy retirement across two replicas (permission runtime cutover 8.5). Each replica is a
 * `SandboxService` and a retirement store with its own PG pool and Redis connection, sharing PG,
 * Redis and the fake provider's root: the service keeps no state in process, so this equals two
 * processes. The worker's retirement on one replica and ordinary acquisitions on the other never
 * reuse the old incarnation and destroy it exactly once; the freeze fences concurrent dispatch
 * admissions on the other replica.
 */

vi.setConfig({ testTimeout: 60_000 });

let pgc: TestContainer;
let rdc: TestContainer;
let root: string;
let config: KernelConfig;
let raw: ReturnType<typeof createDb>;
let seed: Awaited<ReturnType<typeof seedConversation>>;
let calls: string[];
let destroyFails: boolean;
let provider: SandboxProvider;
const pools: ReturnType<typeof createDb>[] = [];
const clients: Redis[] = [];

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 2);
});

afterAll(async () => {
  for (const c of clients) c.disconnect();
  for (const p of pools) await p.destroy();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  const r = new Redis(rdc.url);
  await r.flushdb();
  r.disconnect();
  await truncateTables(
    raw,
    "capybara.device_retirement_members, capybara.device_retirement_obligations, capybara.device_instance_destructions, capybara.legacy_launch_freeze, capybara.device_instances, capybara.devices, capybara.accounts, capybara.orgs",
  );
  if (root) await rm(root, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), "cap-protocol-upgrade-dual-"));
  calls = [];
  destroyFails = false;
  const impl = createFakeSandbox(root);
  provider = Object.create(impl) as SandboxProvider;
  provider.destroy = async (h, s) => {
    calls.push(`destroy ${h.id}`);
    if (destroyFails) throw new Error("provider refused the destroy");
    return impl.destroy(h, s);
  };
  provider.create = async (args) => {
    const h = await impl.create(args);
    calls.push(`create ${h.id}`);
    return h;
  };
  config = KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    sandbox: { maxConcurrentCommands: 4 },
  });
  seed = await seedConversation(raw);
});

/** One replica: its own pool, Redis connection, sandbox service and retirement store. */
function replica(): { s: SandboxService; store: LegacyRetirementStore } {
  const pool = createDb(pgc.url, 4);
  const redis = new Redis(rdc.url);
  pools.push(pool);
  clients.push(redis);
  const store = retirementFor(pool);
  const s = sandboxServiceFor({
    db: kernelDb(pool),
    redis,
    provider: () => ({ plugin: "sandbox-fake", impl: provider }),
    lookup: (plugin) => (plugin === "sandbox-fake" ? provider : undefined),
    config: () => config,
    log: {},
    lockPollMs: 20,
    retirement: store,
  });
  return { s, store };
}

const signal = () => AbortSignal.timeout(50_000);
/** The incarnation a racing dispatch is admitted for. */
const AT = { provider: "sandbox-fake", generation: "1763370000123" };
const use = (s: SandboxService, deviceId: string) =>
  s.withSandbox(
    {
      orgId: seed.orgId,
      deviceId,
      holderConversationId: seed.conversationId,
      actor: { accountId: seed.accountId, conversationId: seed.conversationId },
    },
    async (h) => h.id,
    signal(),
  );
const instanceCreatedAt = async (deviceId: string): Promise<Date> =>
  (
    await sql<{ created_at: Date }>`SELECT created_at FROM capybara.device_instances
      WHERE device_id = ${deviceId}`.execute(raw)
  ).rows[0]?.created_at as Date;
async function runningLegacyRow(deviceId: string, createdAt: Date | null): Promise<string> {
  const id = `bt_${randomUUID()
    .replace(/[^a-z2-7]/g, "")
    .slice(0, 6)
    .padEnd(6, "a")}`;
  await sql`INSERT INTO capybara.background_tasks (id, org_id, conversation_id,
      sandbox_conversation_id, device_id, run_id, call_id, trigger_account_id, description, command,
      sid, output_path, status, deadline_at, sandbox_created_at, legacy_dispatch)
    VALUES (${id}, ${seed.orgId}, ${seed.conversationId}, ${seed.conversationId}, ${deviceId},
      'run-1', ${`call-${id}`}, ${seed.accountId}, 'd', 'sleep 600',
      ${createdAt === null ? null : "4242"}, ${`.capybara/tasks/${id}.out`}, 'running',
      now() + interval '1 hour', ${createdAt}, ${createdAt === null ? "reserved" : "unknown"})`.execute(
    raw,
  );
  return id;
}

it("the worker on one replica and acquisitions on the other destroy the old incarnation once and never reuse it", async () => {
  const a = replica();
  const b = replica();
  const dev = await seedDevice(raw, seed.orgId, seed.accountId);
  const old = await use(b.s, dev);
  await runningLegacyRow(dev, await instanceCreatedAt(dev));
  await a.store.freeze("replica-a");
  await a.store.scanUntilStable();
  calls = [];

  const retire = (async () => {
    for (let i = 0; i < 1000; i++) {
      const r = await a.s.retireLegacy(dev);
      if (r !== "busy") return r;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return "busy";
  })();
  const used = await Promise.all([1, 2, 3, 4, 5].map(() => use(b.s, dev)));
  expect(await retire).toBe("clear");

  expect(used.every((id) => id !== old)).toBe(true);
  expect(calls.filter((c) => c === `destroy ${old}`)).toHaveLength(1);
  // the fresh instance was created only after the confirmed destroy
  expect(calls.indexOf(`destroy ${old}`)).toBeLessThan(
    calls.findIndex((c) => c.startsWith("create ")),
  );
  const states = await sql<{ state: string }>`SELECT state
    FROM capybara.device_retirement_obligations`.execute(raw);
  expect(states.rows).toEqual([{ state: "resolved" }]);
});

it("a failing destroy keeps both replicas out: no acquisition reuses or replaces the old incarnation", async () => {
  const a = replica();
  const b = replica();
  const dev = await seedDevice(raw, seed.orgId, seed.accountId);
  const old = await use(a.s, dev);
  await runningLegacyRow(dev, await instanceCreatedAt(dev));
  await b.store.freeze("replica-b");
  await b.store.scanUntilStable();
  destroyFails = true;
  calls = [];
  const results = await Promise.allSettled([
    use(a.s, dev),
    use(b.s, dev),
    a.s.retireLegacy(dev),
    b.s.retireLegacy(dev),
  ]);
  for (const r of results.slice(0, 2))
    expect(r).toMatchObject({ status: "rejected", reason: { code: "device.unavailable" } });
  for (const r of results.slice(2))
    expect(r.status === "fulfilled" && ["unavailable", "busy"].includes(r.value)).toBe(true);
  expect(calls.every((c) => c === `destroy ${old}`)).toBe(true);
  expect(calls.length).toBeGreaterThan(0);
});

it("the freeze on one replica fences dispatch admissions racing it on the other", async () => {
  const a = replica();
  const b = replica();
  const dev = await seedDevice(raw, seed.orgId, seed.accountId);
  const ids = await Promise.all(Array.from({ length: 12 }, () => runningLegacyRow(dev, null)));
  const [admissions] = await Promise.all([
    Promise.all(ids.map((id) => b.store.admitLegacyDispatch(seed.orgId, id, AT))),
    a.store.freeze("replica-a"),
  ]);
  // after the freeze committed nothing more is admitted
  expect(await b.store.admitLegacyDispatch(seed.orgId, ids[0] as string, AT)).toBe("frozen");
  await a.store.scanUntilStable();
  const admitted = ids.filter((_, i) => admissions[i] === "admitted").sort();
  const members = await sql<{ ref_id: string }>`SELECT ref_id
    FROM capybara.device_retirement_members ORDER BY ref_id`.execute(raw);
  // every reservation the other replica admitted before the freeze owes retirement, and only those
  expect(members.rows.map((m) => m.ref_id)).toEqual(admitted);
  for (const [i, id] of ids.entries()) {
    const mark = await sql<{ legacy_dispatch: string }>`SELECT legacy_dispatch
      FROM capybara.background_tasks WHERE id = ${id}`.execute(raw);
    expect(mark.rows[0]?.legacy_dispatch).toBe(
      admissions[i] === "admitted" ? "dispatched" : "reserved",
    );
  }
});
