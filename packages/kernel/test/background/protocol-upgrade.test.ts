import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxExecutionRef, SandboxHandle, SandboxProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundLaunchLock } from "../../src/background/launch-lock.js";
import { RetireLegacyTasksJob } from "../../src/background/retire-legacy-tasks.job.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { XactLock } from "../../src/infra/database/xact-lock.js";
import type { CloudPermissionSnapshots } from "../../src/sandbox/cloud-permission-snapshot.js";
import type { LegacyRetirementStore } from "../../src/sandbox/legacy-retirement.js";
import { appliedOf } from "../../src/sandbox/modes.js";
import type { SandboxOperationIntents } from "../../src/sandbox/operation-intents.js";
import { LOCAL_PROVIDER } from "../../src/sandbox/providers.js";
import { RetirementPendingError, type SandboxService } from "../../src/sandbox/sandbox.service.js";
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
let destroyByNameFails: boolean;

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
  w.destroyByName = async (n, s) => {
    calls.push(`${name} destroy-by-name ${n}`);
    if (destroyByNameFails) throw new Error("provider refused the destroy by name");
    return impl.destroyByName(n, s);
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

const service = (snapshots?: Pick<CloudPermissionSnapshots, "reconcileHeld">): SandboxService =>
  sandboxServiceFor({
    ...(snapshots !== undefined && { snapshots }),
    db,
    redis,
    provider: () => ({ plugin: "sandbox-fake", impl: cloud }),
    lookup: (plugin) => (plugin === "sandbox-fake" || plugin === "old-fake" ? cloud : undefined),
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
  destroyByNameFails = false;
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
/** A cloud incarnation no evidence can cover: recreate the device. */
const recreate = { code: "device.recreate_required" };
/** A local device whose computer never reported a boot identity: replace it. */
const replace = { code: "device.replace_required" };

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

    // the freeze itself enumerates before it returns: no worker scan is needed
    await retirement.freeze("test");
    expect(await members()).toEqual(
      [running, reservedUnknown, stopping, killPending, failedMaybeDispatched]
        .map((id) => `legacy-task ${id}`)
        .sort(),
    );
    // historical reservations name no incarnation: `unknown`, never the instance current now
    // (whose provider is not theirs either)
    expect(
      (await obligations(dev)).map((o) => [o.provider, o.instance_generation, o.state]).sort(),
    ).toEqual(
      [
        ["sandbox-fake", String(g.getTime()), "open"],
        ["unknown", "unknown", "open"],
      ].sort(),
    );
    // the rows themselves are untouched: no SID becomes an execution reference
    const rows = await db
      .selectFrom("background_tasks")
      .select(["launch_state", "execution_ref", "sid"])
      .execute();
    expect(rows.every((r) => r.launch_state === "legacy" && r.execution_ref === null)).toBe(true);
    expect(await retirement.scanUntilStable()).toEqual({ added: 0, stable: true });
  });

  it("a reservation an R1 kernel admitted for dispatch owes retirement on its admitted incarnation", async () => {
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    // reserved by the fenced R1 launcher and never admitted: owes nothing
    await legacyRow(dev, { sid: null, dispatch: "reserved" });
    // admitted by the R1 launcher before the freeze: carries the incarnation it was admitted for
    const admitted = await legacyRow(dev, { sid: null, dispatch: "dispatched" });
    const at = { provider: "sandbox-fake", generation: "1763370000123" };
    await sql`UPDATE capybara.background_tasks SET legacy_dispatch_provider = ${at.provider},
      legacy_dispatch_generation = ${at.generation} WHERE id = ${admitted}`.execute(raw);
    await retirement.freeze("test");
    await retirement.scanUntilStable();
    // the admitted reservation's obligation is keyed by the incarnation it was admitted for
    expect(await obligations(dev)).toMatchObject([
      { provider: "sandbox-fake", instance_generation: at.generation },
    ]);
  });

  it("the gate enumerates on its own: a row written after the freeze (no worker scan) is retired before use and keeps its kill mark", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    const old = await use(s, dev);
    const g = (await instance(dev)).created_at;
    await retirement.freeze("test");
    // an old, unfenced replica's row of an earlier incarnation, after the freeze's own scan
    const late = await legacyRow(dev, {
      status: "lost",
      createdAt: new Date(g.getTime() - 60_000),
      killPending: true,
    });
    expect(await obligations(dev)).toEqual([]);
    expect(await retirement.hasUnresolved(dev)).toBe(true);
    calls = [];
    // its incarnation names no provider (unknown): under the freeze the current incarnation is
    // destroyed with confirmation before anything runs, then a fresh one is made (R1-I1)
    const fresh = await use(s, dev);
    expect(calls).toEqual([`cloud destroy ${old.id}`, `cloud create ${fresh.id}`]);
    expect(await members()).toEqual([`legacy-task ${late}`]);
    expect((await tasks.get(late))?.killPending).toBe(true);
  });

  it("an incarnation under an obligation refuses legacy SID callers; exact-ref drains go on", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    await use(s, dev);
    const g = (await instance(dev)).created_at;
    await legacyRow(dev, { createdAt: g });
    await retirement.freeze("test");
    let ran = 0;
    const fn = async () => {
      ran++;
      return "ran";
    };
    await expect(s.ifRunning(dev, { createdAt: g }, fn)).rejects.toBeInstanceOf(
      RetirementPendingError,
    );
    expect(ran).toBe(0);
    expect(await s.ifRunning(dev, { createdAt: g, exactRef: true }, fn)).toEqual({
      kind: "ran",
      value: "ran",
    });
  });

  it("a confirmed destroy of a previous provider's incarnation is recorded", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    await use(s, dev);
    const g = (await instance(dev)).created_at;
    // the instance was made by a provider the deployment has since replaced (still loaded)
    await sql`UPDATE capybara.device_instances SET provider = 'old-fake'
      WHERE device_id = ${dev}`.execute(raw);
    await s.destroyInactive(new Date(Date.now() + 365 * DAY));
    expect(await db.selectFrom("device_instance_destructions").selectAll().execute()).toMatchObject(
      [{ device_id: dev, provider: "old-fake", instance_generation: String(g.getTime()) }],
    );
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

    await expect(use(s, dev)).rejects.toMatchObject(replace);
    expect(await obligations(dev)).toMatchObject([{ state: "quarantined" }]);
    expect(calls).toEqual([]);

    // the reset destroys through the local provider (a no-op on a machine): no evidence
    await s.resetFileSystem(dev);
    await expect(use(s, dev)).rejects.toMatchObject(replace);
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
    await expect(use(s, dev)).rejects.toMatchObject(replace);
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
    await expect(use(s, dev)).rejects.toMatchObject(recreate);
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

/** The worker's job over this file's store and service. */
const jobFor = (s: SandboxService) =>
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

describe("cloud incarnations the kernel cannot name (R1-I1)", () => {
  it("resolve once the current incarnation is destroyed with confirmation under the freeze", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    const old = await use(s, dev);
    const g = (await instance(dev)).created_at;
    // a historical reservation that may have dispatched somewhere: (unknown, unknown)
    await legacyRow(dev, { sid: null, status: "failed" });
    expect((await retirement.report()).cloudUnknown).toEqual([
      { deviceId: dev, prevHandle: false, noInstance: false, currentUnconfirmed: false },
    ]);
    await retirement.freeze("test");
    expect(await obligations(dev)).toMatchObject([
      { provider: "unknown", instance_generation: "unknown", state: "open" },
    ]);
    calls = [];
    const fresh = await use(s, dev);
    expect(calls).toEqual([`cloud destroy ${old.id}`, `cloud create ${fresh.id}`]);
    expect(await obligations(dev)).toMatchObject([
      { state: "resolved", resolution: "provider-destroyed" },
    ]);
    expect(await db.selectFrom("device_instance_destructions").selectAll().execute()).toMatchObject(
      [{ device_id: dev, provider: "sandbox-fake", instance_generation: String(g.getTime()) }],
    );
  });

  it("stay blocked while an earlier provider's instance may exist", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    const old = await use(s, dev);
    await sql`UPDATE capybara.device_instances SET prev_provider = 'old-fake',
      prev_handle = handle WHERE device_id = ${dev}`.execute(raw);
    await legacyRow(dev, { sid: null, status: "failed" });
    expect((await retirement.report()).cloudUnknown).toEqual([
      { deviceId: dev, prevHandle: true, noInstance: false, currentUnconfirmed: false },
    ]);
    await retirement.freeze("test");
    calls = [];
    await expect(use(s, dev)).rejects.toMatchObject(recreate);
    expect(calls).toEqual([]);
    expect(await obligations(dev)).toMatchObject([
      { state: "quarantined", reason: expect.stringMatching(/earlier provider/) },
    ]);
    expect(old.id).toBeDefined();
  });

  it("stay blocked when recorded before the freeze", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    await use(s, dev);
    // a revoked start with an unreadable generation is enumerated before any freeze
    await revokedStart(dev, "sandbox-fake", "not-a-generation");
    await retirement.scanUntilStable();
    expect(await obligations(dev)).toMatchObject([{ instance_generation: "unknown" }]);
    await retirement.freeze("test");
    calls = [];
    await expect(use(s, dev)).rejects.toMatchObject(recreate);
    expect(calls).toEqual([]);
    expect(await obligations(dev)).toMatchObject([
      { state: "quarantined", reason: expect.stringMatching(/before the freeze/) },
    ]);
  });

  it("stay blocked without an instance record to destroy", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    await legacyRow(dev, { sid: null, status: "failed" });
    expect((await retirement.report()).cloudUnknown).toEqual([
      { deviceId: dev, prevHandle: false, noInstance: true, currentUnconfirmed: false },
    ]);
    await retirement.freeze("test");
    expect(await s.retireLegacy(dev)).toBe("unavailable");
    calls = [];
    await expect(use(s, dev)).rejects.toMatchObject(recreate);
    expect(calls).toEqual([]);
  });

  it("a failed destroy keeps them open and answers unavailable (a retry may succeed)", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    await use(s, dev);
    await legacyRow(dev, { sid: null, status: "failed" });
    await retirement.freeze("test");
    destroyFails = true;
    await expect(use(s, dev)).rejects.toMatchObject(unavailable);
    expect(await obligations(dev)).toMatchObject([{ state: "open", resolution: null }]);
  });
});

describe("cloud incarnations the kernel cannot name, current row not live (R2-I1)", () => {
  /** The row as the pre-0157 inactivity sweep or a failed create left it: nothing recorded. */
  const notLive = {
    destroyed: (dev: string) =>
      sql`UPDATE capybara.device_instances SET status = 'destroyed', destroyed_at = now(),
        running_since = NULL, suspended_at = NULL WHERE device_id = ${dev}`.execute(raw),
    "creating without a handle": (dev: string) =>
      sql`UPDATE capybara.device_instances SET status = 'creating', handle = NULL,
        running_since = NULL WHERE device_id = ${dev}`.execute(raw),
  };

  for (const [shape, leave] of Object.entries(notLive)) {
    it(`${shape}: the provider's destroy by name confirms it, then a fresh instance is built`, async () => {
      const s = service();
      const dev = await seedDevice(raw, seed.orgId, seed.accountId);
      await use(s, dev);
      const g = String((await instance(dev)).created_at.getTime());
      await leave(dev);
      await legacyRow(dev, { sid: null, status: "failed" });
      expect((await retirement.report()).cloudUnknown).toEqual([
        { deviceId: dev, prevHandle: false, noInstance: false, currentUnconfirmed: true },
      ]);
      await retirement.freeze("test");
      calls = [];
      const fresh = await use(s, dev);
      expect(calls).toEqual([
        `cloud destroy-by-name cap-device-${dev}`,
        `cloud create ${fresh.id}`,
      ]);
      expect(await obligations(dev)).toMatchObject([
        { state: "resolved", resolution: "provider-destroyed" },
      ]);
      expect(
        await db.selectFrom("device_instance_destructions").selectAll().execute(),
      ).toMatchObject([{ device_id: dev, provider: "sandbox-fake", instance_generation: g }]);
    });
  }

  it("a failed destroy by name keeps the obligation open and answers unavailable", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    await use(s, dev);
    await notLive.destroyed(dev);
    await legacyRow(dev, { sid: null, status: "failed" });
    await retirement.freeze("test");
    destroyByNameFails = true;
    calls = [];
    await expect(use(s, dev)).rejects.toMatchObject(unavailable);
    expect(calls).toEqual([`cloud destroy-by-name cap-device-${dev}`]);
    expect(await obligations(dev)).toMatchObject([{ state: "open", resolution: null }]);
    expect(await db.selectFrom("device_instance_destructions").selectAll().execute()).toEqual([]);
    // the provider is back: the next use confirms and builds fresh
    destroyByNameFails = false;
    await use(s, dev);
    expect(await obligations(dev)).toMatchObject([{ state: "resolved" }]);
  });
});

describe("obligations of deleted devices", () => {
  it("are abandoned, never resolved, and kept out of `retired` but not out of `cleanRetirement`", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId, "local");
    await use(s, dev);
    const task = await legacyRow(dev, {
      status: "lost",
      createdAt: (await instance(dev)).created_at,
      killPending: true,
    });
    await retirement.freeze("test");
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${dev}`.execute(raw);
    const r = await jobFor(s).runOnce();
    expect(r.abandoned).toBe(1);
    expect(await obligations(dev)).toMatchObject([{ state: "abandoned", resolution: null }]);
    // abandonment is no evidence: the member stays unsettled, its kill mark kept
    expect((await tasks.get(task))?.killPending).toBe(true);
    expect(await retirement.report()).toMatchObject({
      frozen: true,
      open: 0,
      quarantined: 0,
      unsettledMembers: 0,
      abandoned: 1,
      abandonedMembers: 1,
      retired: true,
      cleanRetirement: false,
      abandonedList: [{ deviceId: dev, provider: LOCAL_PROVIDER, local: true, bootKnown: false }],
    });
    // a later tick changes nothing
    expect((await jobFor(s).runOnce()).abandoned).toBe(0);
    expect(await obligations(dev)).toMatchObject([{ state: "abandoned" }]);
  });

  it("a deleted cloud device whose incarnation's destruction is recorded resolves as provider-destroyed", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    await use(s, dev);
    await legacyRow(dev, { createdAt: (await instance(dev)).created_at });
    await retirement.freeze("test");
    // the device's deletion destroys its instance with the provider (recorded) and its files
    await s.destroyDevice(dev);
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${dev}`.execute(raw);
    const r = await jobFor(s).runOnce();
    expect(r.abandoned).toBe(0);
    expect(await obligations(dev)).toMatchObject([
      { state: "resolved", resolution: "provider-destroyed" },
    ]);
    expect(await retirement.report()).toMatchObject({ abandoned: 0, cleanRetirement: true });
  });
});

describe("obligations of deleted devices whose destroy is still owed (R2-I2)", () => {
  it("production order: deletion, a tick while the provider is down, the owed destroy, a tick -> resolved", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    await use(s, dev);
    await legacyRow(dev, { createdAt: (await instance(dev)).created_at });
    await retirement.freeze("test");
    // the device is deleted first; its destroy goes through the outbox later
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${dev}`.execute(raw);
    destroyFails = true;
    const first = await jobFor(s).runOnce();
    expect(first.abandoned).toBe(0);
    expect(await obligations(dev)).toMatchObject([{ state: "open" }]);
    destroyFails = false;
    await s.destroyDevice(dev);
    const second = await jobFor(s).runOnce();
    expect(second.abandoned).toBe(0);
    expect(await obligations(dev)).toMatchObject([
      { state: "resolved", resolution: "provider-destroyed" },
    ]);
    expect(await retirement.report()).toMatchObject({ abandoned: 0, cleanRetirement: true });
  });

  it("an already abandoned cloud obligation resolves once a matching destruction is recorded", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    await use(s, dev);
    const g = String((await instance(dev)).created_at.getTime());
    const task = await legacyRow(dev, {
      status: "lost",
      createdAt: (await instance(dev)).created_at,
      killPending: true,
    });
    await retirement.freeze("test");
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${dev}`.execute(raw);
    await sql`UPDATE capybara.device_retirement_obligations SET state = 'abandoned',
      abandoned_at = now() WHERE device_id = ${dev}`.execute(raw);
    await retirement.recordDestruction(dev, "sandbox-fake", g);
    await jobFor(s).runOnce();
    expect(await obligations(dev)).toMatchObject([
      { state: "resolved", resolution: "provider-destroyed", abandoned_at: null },
    ]);
    // provider evidence: the member settles like any resolved one
    expect((await tasks.get(task))?.killPending).toBe(false);
    expect(await retirement.report()).toMatchObject({ abandoned: 0, cleanRetirement: true });
  });

  it("a device of a soft-deleted org is abandoned like a deleted device (m5)", async () => {
    const s = service();
    const dev = await seedDevice(raw, seed.orgId, seed.accountId, "local");
    await use(s, dev);
    await legacyRow(dev, {
      status: "lost",
      createdAt: (await instance(dev)).created_at,
      killPending: true,
    });
    await retirement.freeze("test");
    await sql`UPDATE capybara.orgs SET deleted_at = now() WHERE id = ${seed.orgId}`.execute(raw);
    expect((await jobFor(s).runOnce()).abandoned).toBe(1);
    expect(await obligations(dev)).toMatchObject([{ state: "abandoned" }]);
  });

  it("abandons at most `limit` obligations per call (m4)", async () => {
    const s = service();
    const a = await seedDevice(raw, seed.orgId, seed.accountId, "local");
    const b = await seedDevice(raw, seed.orgId, seed.accountId, "local");
    for (const dev of [a, b]) {
      await use(s, dev);
      await legacyRow(dev, {
        status: "lost",
        createdAt: (await instance(dev)).created_at,
        killPending: true,
      });
    }
    await retirement.freeze("test");
    await sql`UPDATE capybara.devices SET deleted_at = now()`.execute(raw);
    expect(await retirement.abandonDeleted(1)).toMatchObject({ abandoned: 1 });
    expect(await retirement.abandonDeleted(1)).toMatchObject({ abandoned: 1 });
    expect(await retirement.abandonDeleted(1)).toMatchObject({ abandoned: 0 });
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
    // the next use would create a new generation: the gate enumerates the device itself first
    // (no worker scan), resolves the destroyed one and refuses for the stale one
    await expect(use(s, dev)).rejects.toMatchObject(recreate);
    expect(await acknowledged(destroyed)).toBe(false);

    const r = await job(s).runOnce();
    expect(r.settled).toBe(1);
    expect(await acknowledged(destroyed)).toBe(true);
    expect(await acknowledged(stale)).toBe(false);
    expect((await obligations(dev)).map((o) => [o.instance_generation === g1, o.state])).toEqual(
      expect.arrayContaining([
        [true, "resolved"],
        [false, "quarantined"],
      ]),
    );
    await expect(use(s, dev)).rejects.toMatchObject(recreate);
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
    // the freeze enumerated it already
    expect(r).toMatchObject({ added: 0, cleared: 1, settled: 1 });
    expect(calls).toEqual([`cloud destroy ${old.id}`]);
    expect((await tasks.get(task))?.killPending).toBe(false);
    expect(await retirement.report()).toMatchObject({ frozen: true, open: 0, retired: true });
  });
});

describe("a suspended cloud instance with a revoked managed start (B-22)", () => {
  /** What each exact stop answers once resumed, by operation id; absent: `stopped`. */
  let stopAnswers: Map<string, "stopped" | "cancel-pending" | "lost" | "throw">;
  /** What each exact stop answers while suspended, by operation id; absent: `cancel-pending`. */
  let preStopAnswers: Map<string, "cancel-pending" | "lost" | "throw">;
  /** The executions the stub provider still runs (exact refs by operation id). */
  let running: Set<string>;
  /** `update` calls (B-12 lifecycle reconcile). */
  let updates: number;
  /** Instances the stub's `stop` saw suspended: an exact stop there only persists the cancel. */
  const suspended = async (id: string) =>
    (await instance(id)).status === "suspended" && !calls.some((c) => c.includes(" resume "));

  /** The cloud provider with exact background supervision: `stop` is recorded. */
  const withBackground = (deviceId: string) => {
    const base = cloud;
    const w = Object.create(base) as SandboxProvider;
    w.background = {
      stop: async (h: SandboxHandle, ref: SandboxExecutionRef) => {
        calls.push(`cloud stop ${ref.operationId} ${h.id}`);
        if (await suspended(deviceId)) {
          const pre = preStopAnswers.get(ref.operationId) ?? "cancel-pending";
          if (pre === "throw") throw new Error("the provider did not record the cancel");
          return { outcome: pre } as { outcome: "cancel-pending" };
        }
        const answer = stopAnswers.get(ref.operationId) ?? "stopped";
        if (answer === "throw") throw new Error("the device did not answer the stop");
        if (answer === "stopped") running.delete(ref.operationId);
        return { outcome: answer } as { outcome: "stopped" };
      },
    } as unknown as NonNullable<SandboxProvider["background"]>;
    w.update = async () => {
      updates++;
      return "updated";
    };
    w.suspend = (h, s) => {
      calls.push(`cloud suspend ${h.id}`);
      return base.suspend(h, s);
    };
    cloud = w;
  };

  /** A managed background start on the device's instance (`revoked`: its cancel is owed). */
  async function managedStart(
    deviceId: string,
    instanceId: string,
    generation: string,
    state: "revoked" | "completed",
  ) {
    const operationId = randomUUID();
    const ref = {
      executionId: randomUUID(),
      operationId,
      instanceId,
      instanceGeneration: generation,
    };
    await sql`INSERT INTO capybara.sandbox_operation_intents (operation_id, org_id, account_id,
        device_id, ordinal, method, input_hash, admission_hash, input, scope, epochs, provider,
        provider_version, instance_generation, deadline, retain_until, state, execution_id,
        execution_ref, outcome_unknown)
      VALUES (${operationId}, ${seed.orgId}, ${seed.accountId}, ${deviceId}, 0, 'backgroundStart',
        'h', 'a', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'sandbox-fake', '1', ${generation},
        now() + interval '1 hour', now() + interval '1 day', ${state}, ${ref.executionId},
        ${JSON.stringify(ref)}::jsonb, false)`.execute(raw);
    return operationId;
  }
  const intent = async (op: string) =>
    (
      await sql<{ state: string; revoke_acknowledged: boolean }>`SELECT state, revoke_acknowledged
        FROM capybara.sandbox_operation_intents WHERE operation_id = ${op}`.execute(raw)
    ).rows[0];
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

  /** A used device, then suspended, with a revoked start and a running sibling on its instance. */
  async function suspendedWithRevoked() {
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    withBackground(dev);
    const s = service();
    const first = await use(s, dev);
    const g = String((await instance(dev)).created_at.getTime());
    const revoked = await managedStart(dev, first.id, g, "revoked");
    const sibling = await managedStart(dev, first.id, g, "completed");
    // both executions run in the instance (the revoked one until its exact stop)
    running.add(revoked);
    running.add(sibling);
    expect(await s.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
    calls = [];
    return { s, dev, first, g, revoked, sibling };
  }

  beforeEach(() => {
    stopAnswers = new Map();
    preStopAnswers = new Map();
    running = new Set();
    updates = 0;
  });

  it("the use resumes, cancels exactly the revoked ref with confirmation and keeps the instance: the sibling survives", async () => {
    const { s, dev, first, g, revoked, sibling } = await suspendedWithRevoked();
    const again = await use(s, dev);
    // the same instance: never destroyed or recreated; only the revoked ref is stopped (first
    // persisted while suspended, then confirmed once resumed), never the sibling
    expect(again.id).toBe(first.id);
    expect(calls).toEqual([
      `cloud stop ${revoked} ${first.id}`,
      `cloud resume ${first.id}`,
      `cloud stop ${revoked} ${first.id}`,
    ]);
    // the resume's cleanup is exact (B-1): no broad kill reaches the sibling
    expect(calls.some((c) => c.includes(sibling))).toBe(false);
    // the sibling execution keeps running; only the revoked one was stopped
    expect([...running]).toEqual([sibling]);
    expect(await obligations(dev)).toMatchObject([
      { instance_generation: g, state: "resolved", resolution: "exact-cancelled" },
    ]);
    expect(await intent(sibling)).toEqual({ state: "completed", revoke_acknowledged: false });
    expect((await instance(dev)).status).toBe("running");
    // the worker settles the cancelled member: its revocation is acknowledged
    expect((await job(s).runOnce()).settled).toBe(1);
    expect(await intent(revoked)).toEqual({ state: "revoked", revoke_acknowledged: true });
  });

  it("a cancel that is not confirmed keeps the obligation and falls back to the whole-instance destroy", async () => {
    const { s, dev, first, revoked } = await suspendedWithRevoked();
    stopAnswers.set(revoked, "cancel-pending");
    const fresh = await use(s, dev);
    expect(fresh.id).not.toBe(first.id);
    expect(calls).toEqual([
      `cloud stop ${revoked} ${first.id}`,
      `cloud resume ${first.id}`,
      `cloud stop ${revoked} ${first.id}`,
      `cloud destroy ${first.id}`,
      `cloud create ${fresh.id}`,
    ]);
    expect(await obligations(dev)).toMatchObject([
      { state: "resolved", resolution: "provider-destroyed" },
    ]);
  });

  it("a failed cancel and a failed destroy keep the obligation: the device is unavailable, the instance suspended again", async () => {
    const { s, dev, first, revoked } = await suspendedWithRevoked();
    stopAnswers.set(revoked, "throw");
    destroyFails = true;
    await expect(use(s, dev)).rejects.toMatchObject(unavailable);
    expect(calls).toEqual([
      `cloud stop ${revoked} ${first.id}`,
      `cloud resume ${first.id}`,
      `cloud stop ${revoked} ${first.id}`,
      `cloud destroy ${first.id}`,
      `cloud suspend ${first.id}`,
    ]);
    expect(await obligations(dev)).toMatchObject([{ state: "open", attempts: 2 }]);
    expect((await instance(dev)).status).toBe("suspended");
  });

  it("the worker cancels on its own and suspends the instance again; a later revoked start reopens the obligation", async () => {
    const { s, dev, first, g, revoked } = await suspendedWithRevoked();
    expect(await s.retireLegacy(dev)).toBe("clear");
    expect(calls).toEqual([
      `cloud stop ${revoked} ${first.id}`,
      `cloud resume ${first.id}`,
      `cloud stop ${revoked} ${first.id}`,
      `cloud suspend ${first.id}`,
    ]);
    expect((await instance(dev)).status).toBe("suspended");
    expect(await obligations(dev)).toMatchObject([{ state: "resolved" }]);
    expect((await job(s).runOnce()).settled).toBe(1);
    // the instance lives on: a cancel owed later on the same incarnation is not covered (the
    // settled member is not stopped again)
    const later = await managedStart(dev, first.id, g, "revoked");
    await retirement.scanUntilStable(5, dev);
    expect(await obligations(dev)).toMatchObject([{ state: "open", resolution: null }]);
    calls = [];
    expect(await s.retireLegacy(dev)).toBe("clear");
    expect(calls.filter((c) => c.startsWith("cloud stop"))).toEqual([
      `cloud stop ${later} ${first.id}`,
      `cloud stop ${later} ${first.id}`,
    ]);
  });

  it("a legacy task on the same incarnation keeps the whole-instance destroy", async () => {
    const { s, dev, first } = await suspendedWithRevoked();
    await legacyRow(dev, {
      status: "lost",
      createdAt: (await instance(dev)).created_at,
      killPending: true,
    });
    await retirement.freeze("test");
    calls = [];
    const fresh = await use(s, dev);
    expect(calls).toEqual([`cloud destroy ${first.id}`, `cloud create ${fresh.id}`]);
  });

  it.each(["lost", "throw"] as const)(
    "a pre-resume stop answering %s destroys the instance while still suspended",
    async (answer) => {
      const { s, dev, first, revoked } = await suspendedWithRevoked();
      preStopAnswers.set(revoked, answer);
      const fresh = await use(s, dev);
      expect(calls).toEqual([
        `cloud stop ${revoked} ${first.id}`,
        `cloud destroy ${first.id}`,
        `cloud create ${fresh.id}`,
      ]);
      expect(await obligations(dev)).toMatchObject([
        { state: "resolved", resolution: "provider-destroyed", attempts: 1 },
      ]);
      // never resumed into the revoked work
      expect(calls.some((c) => c.includes(" resume "))).toBe(false);
    },
  );

  it("a use that fails after the gate resumed the instance suspends it again and the row stays suspended", async () => {
    const { s, dev, first, revoked } = await suspendedWithRevoked();
    // the files are lost: the use refuses after the gate's exact cancel, before `running`
    await sql`UPDATE capybara.device_instances SET fs_status = 'lost'
      WHERE device_id = ${dev}`.execute(raw);
    await expect(use(s, dev)).rejects.toMatchObject({ code: "device.files_lost" });
    expect(calls).toEqual([
      `cloud stop ${revoked} ${first.id}`,
      `cloud resume ${first.id}`,
      `cloud stop ${revoked} ${first.id}`,
      `cloud suspend ${first.id}`,
    ]);
    expect((await instance(dev)).status).toBe("suspended");
  });

  it("a member added while the cancel runs is never resolved unstopped: the instance is destroyed instead", async () => {
    const { s, dev, first, g, revoked } = await suspendedWithRevoked();
    let late = "";
    const read = retirement.membersOf.bind(retirement);
    const spy = vi.spyOn(retirement, "membersOf").mockImplementationOnce(async (id) => {
      const members = await read(id);
      // a concurrent scan records another revoked start of the same incarnation
      late = await managedStart(dev, first.id, g, "revoked");
      await retirement.scanUntilStable(5, dev);
      return members;
    });
    try {
      const fresh = await use(s, dev);
      expect(calls).toEqual([
        `cloud stop ${revoked} ${first.id}`,
        `cloud resume ${first.id}`,
        `cloud stop ${revoked} ${first.id}`,
        `cloud destroy ${first.id}`,
        `cloud create ${fresh.id}`,
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(await obligations(dev)).toMatchObject([
      { state: "resolved", resolution: "provider-destroyed" },
    ]);
    expect(await intent(late)).toEqual({ state: "revoked", revoke_acknowledged: false });
  });

  it("a member an old replica added after an exact cancel reopens the obligation on the next scan (rolling upgrade)", async () => {
    const { s, dev, first, g } = await suspendedWithRevoked();
    expect(await s.retireLegacy(dev)).toBe("clear");
    const [o] = await obligations(dev);
    expect(o).toMatchObject({ state: "resolved", resolution: "exact-cancelled" });
    // an old replica's addMember: the member row only, the obligation left resolved
    const late = await managedStart(dev, first.id, g, "revoked");
    await sql`INSERT INTO capybara.device_retirement_members (obligation_id, kind, ref_id)
      VALUES (${o?.id}, 'revoked-start', ${late})`.execute(raw);
    // never settled (acknowledged unstopped) while it waits
    expect((await retirement.unsettledMembers(100)).map((m) => m.refId)).not.toContain(late);
    expect(await retirement.hasUnresolved(dev)).toBe(true);
    await retirement.scan(dev);
    expect(await obligations(dev)).toMatchObject([{ state: "open", resolution: null }]);
  });

  it("a revoked-start member whose intent row is missing counts as never stopped (fail closed)", async () => {
    const { s, dev } = await suspendedWithRevoked();
    expect(await s.retireLegacy(dev)).toBe("clear");
    const [o] = await obligations(dev);
    const ghost = randomUUID();
    await sql`INSERT INTO capybara.device_retirement_members (obligation_id, kind, ref_id)
      VALUES (${o?.id}, 'revoked-start', ${ghost})`.execute(raw);
    expect((await retirement.unsettledMembers(100)).map((m) => m.refId)).not.toContain(ghost);
    expect(await retirement.hasUnresolved(dev)).toBe(true);
    await retirement.scan(dev);
    expect(await obligations(dev)).toMatchObject([{ state: "open", resolution: null }]);
  });

  it("the lifecycle reconcile of a marked device never resumes past an open retirement obligation (C1)", async () => {
    const { dev, first } = await suspendedWithRevoked();
    const policy = await service().devicePolicy({ orgId: seed.orgId, deviceId: dev });
    const target = appliedOf({ mode: policy.mode, network: policy.network });
    const s = service({
      reconcileHeld: async () => ({ state: "reconcile-required", action: "reset-files", target }),
    });
    expect(await s.reconcileLimits(dev)).toMatchObject({ state: "reconcile-required" });
    expect(calls.filter((c) => c.includes(" resume "))).toEqual([]);
    expect(updates).toBe(0);
    expect((await instance(dev)).status).toBe("suspended");
    expect(first.id).toBeTruthy();
  });
});

describe("the cutover operator surface (B-26)", () => {
  it("the freeze reports its enumeration and records when it completed; a rerun keeps the first publication", async () => {
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    await legacyRow(dev, { sid: null });
    expect(await retirement.freezeState()).toEqual({ frozenAt: null, enumeratedAt: null });
    const first = await retirement.freeze("operator");
    expect(first).toMatchObject({ frozenAt: expect.any(Date), added: 1, stable: true });
    const state = await retirement.freezeState();
    expect(state.frozenAt).toEqual(first.frozenAt);
    expect(state.enumeratedAt).toBeInstanceOf(Date);
    const again = await retirement.freeze("someone else");
    expect(again).toMatchObject({ frozenAt: first.frozenAt, added: 0, stable: true });
  });

  it("an enumeration that never settles fails the freeze: published, never marked enumerated", async () => {
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    await legacyRow(dev, { sid: null });
    // an old, unfenced replica that keeps writing legacy rows during every pass
    const spy = vi.spyOn(retirement, "scan").mockResolvedValue({ added: 1 });
    try {
      await expect(retirement.freeze("operator")).rejects.toThrow(
        /did not settle.*kept appearing/s,
      );
    } finally {
      spy.mockRestore();
    }
    expect(await retirement.freezeState()).toMatchObject({
      frozenAt: expect.any(Date),
      enumeratedAt: null,
    });
    await expect(retirement.assertCutoverBarrier()).rejects.toThrow(/enumerat/);
    // the rerun completes it once the writer is gone
    await retirement.freeze("operator");
    await expect(retirement.assertCutoverBarrier()).resolves.toBeUndefined();
  });

  it("the barrier refuses before the freeze, and after a freeze published without its enumeration", async () => {
    await expect(retirement.assertCutoverBarrier()).rejects.toThrow(/freeze/);
    await sql`INSERT INTO capybara.legacy_launch_freeze (id, frozen_by) VALUES ('platform', 'crash')`.execute(
      raw,
    );
    await expect(retirement.assertCutoverBarrier()).rejects.toThrow(/enumerat/);
  });

  it("an unsettled rerun after a settled freeze closes the barrier again and clears the stale date", async () => {
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    await legacyRow(dev, { sid: null });
    await retirement.freeze("operator");
    await expect(retirement.assertCutoverBarrier()).resolves.toBeUndefined();
    const spy = vi.spyOn(retirement, "scan").mockResolvedValue({ added: 1 });
    try {
      await expect(retirement.freeze("operator")).rejects.toThrow(/did not settle/);
    } finally {
      spy.mockRestore();
    }
    await expect(retirement.assertCutoverBarrier()).rejects.toThrow(/enumerat/);
    expect((await retirement.report()).freezeEnumeratedAt).toBeNull();
  });

  it("an unmarked legacy row started after the enumeration closes the barrier until the freeze reruns", async () => {
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    await retirement.freeze("operator");
    await expect(retirement.assertCutoverBarrier()).resolves.toBeUndefined();
    // an old, unfenced replica starts a legacy task after the enumeration completed
    await legacyRow(dev, { sid: null });
    await expect(retirement.assertCutoverBarrier()).rejects.toThrow(/after the freeze/);
    await retirement.freeze("operator");
    await expect(retirement.assertCutoverBarrier()).resolves.toBeUndefined();
  });

  it("the report shows the freeze, fenced reservations and rows only an unfenced replica writes", async () => {
    const dev = await seedDevice(raw, seed.orgId, seed.accountId);
    // reserved by fenced code and never admitted: the freeze refuses its dispatch
    await legacyRow(dev, { sid: null, dispatch: "reserved" });
    // admitted by fenced code: carries the marker
    await legacyRow(dev, { sid: null, dispatch: "dispatched" });
    // no marker, written after migration 0157: only a replica without the 8.5 code writes these
    await legacyRow(dev, { sid: null });
    const before = await retirement.report();
    expect(before).toMatchObject({
      frozen: false,
      frozenAt: null,
      freezeEnumeratedAt: null,
      fencedReservations: 1,
      unfencedWriters: {
        sinceMigration: 1,
        afterFreeze: 0,
        recent: 1,
        latestAt: expect.any(Date),
      },
    });
    await retirement.freeze("operator");
    await legacyRow(dev, { status: "lost", killPending: true });
    const after = await retirement.report();
    expect(after).toMatchObject({
      frozen: true,
      frozenAt: expect.any(Date),
      freezeEnumeratedAt: expect.any(Date),
      unfencedWriters: { sinceMigration: 2, afterFreeze: 1 },
    });
  });
});
