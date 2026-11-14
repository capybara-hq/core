import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SandboxProvider, ToolError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import {
  mapSandboxError,
  SANDBOX_CREATE_FAILED_TEXT,
  SANDBOX_OPEN_NETWORK_REFUSED_TEXT,
} from "../../src/tools/builtins/sandbox/common.js";
import {
  createFakeSandbox,
  FAKE_REFUSAL_SECRET,
  type FakeSandboxOptions,
  fakeSandboxMeta,
  fakeSandboxState,
  readFakeSandboxLimits,
  readFakeSandboxOps,
  setFakeSandboxDelays,
  setFakeSandboxRefuseOpenEgress,
} from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { sandboxLeasesFor, sandboxServiceFor, seedDevice } from "../helpers/sandbox.js";

/**
 * Device modes and limits on cloud devices (auto mode spec §4.2, §4.3): an instance records the
 * mode and network kind it was made with; a use that finds another effective value updates the
 * instance (`update`), or recreates it on the kept files, or (a provider whose limits are fixed at
 * its file system, without `update`) keeps it and reports a pending file reset. A NULL record (an
 * instance made before auto mode) differs once. The host list, cpu and memory never trigger it.
 */

let pgc: TestContainer;
let rdc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let config: ReturnType<typeof KernelConfigSchema.parse>;
let root: string;
let provider: SandboxProvider;
const warned: string[] = [];
const log = { info() {}, warn: (m: string) => void warned.push(m), error() {} };
const signal = () => AbortSignal.timeout(30_000);

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rdc.url);
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

let orgId: string;
let accountId: string;
let deviceId: string;

async function newOrg(): Promise<{ orgId: string; accountId: string }> {
  const owner = randomUUID();
  const id = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${owner}, 'U')`.execute(raw);
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${id}, ${`o-${id.slice(0, 8)}`}, 'O', ${owner})`.execute(raw);
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${randomUUID()}, ${id}, ${owner}, 'org', 1)`.execute(raw);
  return { orgId: id, accountId: owner };
}

/** A provider over the shared root with the given limits behaviour. */
const fake = (o: FakeSandboxOptions = {}) => createFakeSandbox(root, o);

beforeEach(async () => {
  warned.length = 0;
  await redis.flushdb();
  await truncateTables(
    raw,
    "capybara.device_instances, capybara.devices, capybara.accounts, capybara.orgs, capybara.scheduled_tasks, capybara.scheduled_task_runs",
  );
  if (root) await rm(root, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-modes-"));
  provider = fake();
  config = KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });
  ({ orgId, accountId } = await newOrg());
  deviceId = await seedDevice(raw, orgId);
});

const service = (p: () => SandboxProvider = () => provider, lockTtlMs?: number) =>
  sandboxServiceFor({
    db,
    redis,
    provider: () => ({ plugin: "sandbox-fake", impl: p() }),
    config: () => config,
    log,
    lockPollMs: 20,
    ...(lockTtlMs !== undefined && { lockTtlMs }),
  });

/**
 * The org's mode switch. `off` also selects the allowlist network (the org's `cloudNetwork`),
 * because a cloud device in sandbox mode applies it; `allowed` is auto mode, which ignores it.
 */
const setAutoMode = (mode: "allowed" | "off") =>
  sql`UPDATE capybara.orgs SET settings = ${JSON.stringify({
    autoMode: mode,
    cloudNetwork: { mode: mode === "off" ? "allowlist" : "open" },
  })}::jsonb
    WHERE id = ${orgId}`.execute(raw);
const setOrgSettings = (value: unknown) =>
  sql`UPDATE capybara.orgs SET settings = ${JSON.stringify(value)}::jsonb
    WHERE id = ${orgId}`.execute(raw);
const record = async (id = deviceId) =>
  (
    await db
      .selectFrom("device_instances")
      .select("instance_limits")
      .where("device_id", "=", id)
      .executeTakeFirst()
  )?.instance_limits as Record<string, unknown> | null | undefined;
const modeOf = async (id = deviceId) => (await record(id))?.mode;
const networkKindOf = async (id = deviceId) =>
  ((await record(id))?.network as { kind?: string } | undefined)?.kind;

const use = (s: SandboxService, runId?: string, id = deviceId) =>
  s.withSandbox(
    {
      orgId,
      deviceId: id,
      holderConversationId: randomUUID(),
      actor: { accountId, conversationId: randomUUID(), ...(runId !== undefined && { runId }) },
    },
    async (h, _p, info) => ({ h, info }),
    signal(),
  );

const status = async (id = deviceId) =>
  (
    await db
      .selectFrom("device_instances")
      .select("status")
      .where("device_id", "=", id)
      .executeTakeFirst()
  )?.status;

const ops = async (op: string) => (await readFakeSandboxOps(root)).filter((o) => o[0] === op);

describe("creation records the effective mode and network", () => {
  it("a device follows the org: auto mode with the open public network, sandbox with the allowlist", async () => {
    const s = service();
    const a = await use(s);
    expect((await fakeSandboxMeta(root, a.h.id))?.limits).toMatchObject({
      mode: "auto",
      network: { kind: "open-public" },
    });
    expect(await modeOf()).toBe("auto");
    expect(await networkKindOf()).toBe("open-public");

    const other = await seedDevice(raw, orgId);
    await setAutoMode("off");
    const b = await use(s, undefined, other);
    expect((await fakeSandboxMeta(root, b.h.id))?.limits).toMatchObject({
      mode: "sandbox",
      network: { kind: "allowlist" },
    });
    expect(await modeOf(other)).toBe("sandbox");
    expect(await networkKindOf(other)).toBe("allowlist");
  });
});

describe("a changed mode on use", () => {
  it("update answers updated: the same instance, the new limits, no restart", async () => {
    provider = fake({ updateMode: "updated" });
    const s = service();
    const first = await use(s);
    await setAutoMode("off");
    const state = await s.limitsState({ orgId, deviceId });
    expect(state.applied).toMatchObject({ mode: "auto", network: { kind: "open-public" } });
    expect(state.effective).toMatchObject({ mode: "sandbox", network: { kind: "allowlist" } });
    expect(state.pendingNextUse).toBe(true);
    expect(state.pendingFilesReset).toBe(false);
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(again.info).toMatchObject({ fresh: false, restarted: false });
    expect(await ops("update")).toEqual([["update", first.h.id, "updated"]]);
    const updates = (await readFakeSandboxLimits(root)).filter((e) => e.op === "update");
    expect(updates.map((e) => [e.limits.mode, e.limits.network.kind])).toEqual([
      ["sandbox", "allowlist"],
    ]);
    expect(await modeOf()).toBe("sandbox");
    expect((await s.limitsState({ orgId, deviceId })).pendingNextUse).toBe(false);
    // applied once: the next use takes a shared lease and changes nothing
    await use(s);
    expect(await ops("update")).toHaveLength(1);
    expect(await ops("create")).toHaveLength(1);
  });

  it("update answers recreate: the instance is recreated on the kept files with a restart", async () => {
    provider = fake({ updateMode: "recreate" });
    const s = service();
    const first = await use(s);
    const fs = (await fakeSandboxMeta(root, first.h.id))?.fileSystem;
    await setAutoMode("off");
    const again = await use(s);
    expect(again.h).not.toEqual(first.h);
    expect(again.info).toMatchObject({ fresh: true, restarted: true });
    expect(await ops("update")).toEqual([["update", first.h.id, "recreate"]]);
    expect(await ops("destroy")).toEqual([["destroy", first.h.id]]);
    expect(await ops("create-fs")).toHaveLength(1);
    const meta = await fakeSandboxMeta(root, again.h.id);
    expect(meta?.fileSystem).toBe(fs);
    expect(meta?.limits).toMatchObject({ mode: "sandbox", network: { kind: "allowlist" } });
    expect(await modeOf()).toBe("sandbox");
  });

  it("no update (Docker today): destroy and create on the same files, files kept", async () => {
    const s = service();
    const first = await use(s);
    const fsOf = async (id: string) => (await fakeSandboxMeta(root, id))?.fileSystem;
    const fs = await fsOf(first.h.id);
    await setAutoMode("off");
    const again = await use(s);
    expect(again.info).toMatchObject({ fresh: true, restarted: true });
    expect(await fsOf(again.h.id)).toBe(fs);
    expect(await ops("create")).toHaveLength(2);
    expect(await modeOf()).toBe("sandbox");
  });

  it("a suspended instance is resumed, then gets the new mode", async () => {
    provider = fake({ updateMode: "updated" });
    const s = service();
    const first = await use(s);
    await s.suspendIdle(new Date(Date.now() + 24 * 60 * 60_000));
    expect(await ops("suspend")).toHaveLength(1);
    await setAutoMode("off");
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(await ops("resume")).toHaveLength(1);
    expect(await ops("update")).toEqual([["update", first.h.id, "updated"]]);
    expect(await modeOf()).toBe("sandbox");
  });

  it("limits fixed at the file system, no update: keeps running as is, pending a file reset", async () => {
    provider = fake({ limitsApplyAt: "fileSystem" });
    const s = service();
    const first = await use(s);
    expect(await modeOf()).toBe("auto");
    await setAutoMode("off");
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(again.info).toMatchObject({ fresh: false, restarted: false });
    expect(await ops("create")).toHaveLength(1);
    expect(await modeOf()).toBe("auto");
    const state = await s.limitsState({ orgId, deviceId });
    expect(state).toMatchObject({ pendingNextUse: false, pendingFilesReset: true });
    // a file reset applies it
    await s.resetFileSystem(deviceId);
    expect(await record()).toBeNull();
    await use(s);
    expect(await modeOf()).toBe("sandbox");
    expect((await s.limitsState({ orgId, deviceId })).pendingFilesReset).toBe(false);
  });

  it("limits fixed at the file system, update answers recreate: recorded unapplied, not retried", async () => {
    provider = fake({ limitsApplyAt: "fileSystem", updateMode: "recreate" });
    const s = service();
    const first = await use(s);
    await setAutoMode("off");
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(await ops("create")).toHaveLength(1);
    const rec = (await record()) as { unapplied?: { mode?: string } };
    expect(rec.unapplied).toMatchObject({ mode: "sandbox", network: { kind: "allowlist" } });
    expect((await s.limitsState({ orgId, deviceId })).pendingFilesReset).toBe(true);
    await use(s);
    expect(await ops("update")).toHaveLength(1);
  });

  it("a mode changed while a use waits for the lease is applied before that use runs", async () => {
    provider = fake({ updateMode: "updated" });
    const leases = sandboxLeasesFor({ redis, log: {}, pollMs: 20 });
    const s = sandboxServiceFor({
      db,
      redis,
      provider: () => ({ plugin: "sandbox-fake", impl: provider }),
      config: () => config,
      log,
      lockPollMs: 20,
      leases,
    });
    const first = await use(s);
    // another holder (a sweep) has the device alone: the use reads its limits, then waits
    const ex = await leases.tryExclusive(deviceId);
    expect(ex).not.toBeNull();
    const waiting = use(s);
    await new Promise((r) => setTimeout(r, 150));
    await setAutoMode("off");
    await ex?.release();
    const again = await waiting;
    expect(again.h).toEqual(first.h);
    expect(await ops("update")).toEqual([["update", first.h.id, "updated"]]);
    expect(await modeOf()).toBe("sandbox");
  });

  it("a NULL record (an instance made before auto mode) differs once", async () => {
    const s = service();
    await use(s);
    await sql`UPDATE capybara.device_instances SET instance_limits = NULL
      WHERE device_id = ${deviceId}`.execute(raw);
    const again = await use(s);
    expect(again.info).toMatchObject({ restarted: true });
    expect(await modeOf()).toBe("auto");
    await use(s);
    expect(await ops("create")).toHaveLength(2);
  });

  it("a changed host list, cpu or memory alone never touches the running instance", async () => {
    provider = fake({ updateMode: "updated" });
    const s = service();
    await setAutoMode("off");
    const first = await use(s);
    await setOrgSettings({
      autoMode: "off",
      cloudNetwork: { mode: "allowlist", allowHosts: ["example.com"] },
    });
    await sql`INSERT INTO capybara.deployment_settings (key, value)
      VALUES ('sandboxLimitOverrides', ${JSON.stringify({ [orgId]: { cpu: 4 } })}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(raw);
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(await ops("update")).toEqual([]);
    expect(await ops("create")).toHaveLength(1);
    await sql`DELETE FROM capybara.deployment_settings WHERE key = 'sandboxLimitOverrides'`.execute(
      raw,
    );
  });
});

describe("a provider that refuses the open public network (openEgress off)", () => {
  /** The refusal and the tool text it becomes; the provider's own message never reaches it. */
  const refused = async (err: unknown) => {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("sandbox.open_network_refused");
    expect((err as Error).message).not.toContain(FAKE_REFUSAL_SECRET);
    const tool = mapSandboxError(err, undefined) as Error;
    expect(tool).toBeInstanceOf(ToolError);
    expect(tool.message).toBe(SANDBOX_OPEN_NETWORK_REFUSED_TEXT);
    expect(tool.message).not.toContain(FAKE_REFUSAL_SECRET);
    expect(tool.message).not.toContain("openEgress");
    expect(warned.some((m) => m.includes("refused an instance with the open public network"))).toBe(
      true,
    );
  };

  it("a new instance in auto mode: the create is refused; sandbox mode works on the same provider", async () => {
    await setFakeSandboxRefuseOpenEgress(root, true);
    await refused(await use(service()).catch((e: unknown) => e));
    await setAutoMode("off");
    expect((await use(service())).info).toMatchObject({ fresh: true });
  });

  it("a running instance moved to auto mode: the failed update recreates, and that create is refused", async () => {
    await setAutoMode("off");
    provider = fake({ updateMode: "updated" });
    const s = service();
    await use(s);
    await setFakeSandboxRefuseOpenEgress(root, true);
    await setAutoMode("allowed");
    await refused(await use(s).catch((e: unknown) => e));
  });

  it("limits fixed at the file system: a new file system in auto mode is refused", async () => {
    provider = fake({ limitsApplyAt: "fileSystem" });
    await setFakeSandboxRefuseOpenEgress(root, true);
    await refused(await use(service()).catch((e: unknown) => e));
    expect(await ops("create-fs")).toEqual([]);
  });

  it("limits fixed at the file system: a refused update suspends the instance with the error", async () => {
    await setAutoMode("off");
    provider = fake({ updateMode: "updated", limitsApplyAt: "fileSystem" });
    const s = service();
    await use(s);
    await setFakeSandboxRefuseOpenEgress(root, true);
    await setAutoMode("allowed");
    await refused(await use(s).catch((e: unknown) => e));
    expect(await status()).toBe("suspended");
    expect(await modeOf()).toBe("sandbox");
  });

  it("any other create failure becomes sandbox.create_failed without the provider's message", async () => {
    await setAutoMode("off");
    const failing = fake();
    const p: SandboxProvider = Object.create(failing);
    p.create = async () => {
      throw new Error(`no image configured (${FAKE_REFUSAL_SECRET})`);
    };
    const err = await use(service(() => p)).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("sandbox.create_failed");
    expect((err as Error).message).not.toContain(FAKE_REFUSAL_SECRET);
    expect((mapSandboxError(err, undefined) as Error).message).toBe(SANDBOX_CREATE_FAILED_TEXT);
    expect(warned).toContain("the sandbox provider failed to create a device's sandbox");
  });
});

describe("a failed limits change", () => {
  it("an update that fails on a provider bound to instances recreates it; nothing claims the update", async () => {
    provider = fake({ updateMode: "throw" });
    const s = service();
    const first = await use(s);
    await setAutoMode("off");
    const again = await use(s);
    expect(again.h).not.toEqual(first.h);
    expect(again.info).toMatchObject({ fresh: true, restarted: true });
    expect(await ops("update")).toEqual([["update", first.h.id, "throw"]]);
    // recorded by the create that applied it
    expect(await modeOf()).toBe("sandbox");
    expect((await fakeSandboxMeta(root, again.h.id))?.limits.mode).toBe("sandbox");
    expect(warned.some((m) => m.includes("update failed"))).toBe(true);
  });

  it("an update aborted on a provider bound to instances suspends the instance instead of recreating it", async () => {
    provider = fake({ updateMode: "throw" });
    const s = service();
    const first = await use(s);
    await setAutoMode("off");
    await setFakeSandboxDelays(root, { update: 5000 });
    const ac = new AbortController();
    const run = s
      .withSandbox(
        {
          orgId,
          deviceId,
          holderConversationId: randomUUID(),
          actor: { accountId, conversationId: randomUUID() },
        },
        async (h) => h,
        ac.signal,
      )
      .catch((e: unknown) => e);
    // aborted while the update runs: the instance may hold half-applied limits
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    expect(await run).toBeInstanceOf(Error);
    await setFakeSandboxDelays(root, {});
    expect(await ops("update")).toEqual([]);
    expect(await ops("create")).toHaveLength(1);
    expect(await fakeSandboxState(root, first.h.id)).toBe("suspended");
    expect(await status()).toBe("suspended");
    expect(await modeOf()).toBe("auto");
  });

  it("an update that fails on a provider bound to its file system suspends the instance and throws", async () => {
    provider = fake({ updateMode: "throw", limitsApplyAt: "fileSystem" });
    const s = service();
    const first = await use(s);
    await setAutoMode("off");
    const err = await use(s).catch((e: unknown) => e);
    expect((err as Error).message).toBe("fake update failed");
    expect(await fakeSandboxState(root, first.h.id)).toBe("suspended");
    expect(await status()).toBe("suspended");
    expect(await modeOf()).toBe("auto");
    // the next use resumes it, tries again, and leaves it suspended when that fails too
    await use(s).catch(() => undefined);
    expect(await ops("resume")).toHaveLength(1);
    expect(await ops("update")).toHaveLength(2);
    expect(await status()).toBe("suspended");
    expect(await ops("create")).toHaveLength(1);
  });

  it("a lease lost during update records nothing and stops the instance", async () => {
    provider = fake({ updateMode: "updated" });
    const s = service(undefined, 300);
    const first = await use(s);
    await setAutoMode("off");
    await setFakeSandboxDelays(root, { update: 2000 });
    const run = use(s).catch((e: unknown) => e);
    // the exclusive lease expires under the slow update
    await new Promise((r) => setTimeout(r, 150));
    await redis.del(`capk:sandbox:${deviceId}`, `capk:sandbox-users:${deviceId}`);
    const err = await run;
    expect(err).toBeInstanceOf(Error);
    await setFakeSandboxDelays(root, {});
    expect(await modeOf()).toBe("auto");
    expect(await ops("update")).toEqual([]);
    expect(await fakeSandboxState(root, first.h.id)).toBe("suspended");
  });

  it("a file reset clears the record of an instance provider; the next create records again", async () => {
    const s = service();
    await use(s);
    expect(await modeOf()).toBe("auto");
    await s.resetFileSystem(deviceId);
    expect(await record()).toBeNull();
    await setAutoMode("off");
    await use(s);
    expect(await modeOf()).toBe("sandbox");
  });
});

describe("scheduled runs use the effective mode like any use", () => {
  it("an unattended run needs no mode grant: it uses the effective mode and records no missing grant", async () => {
    const s = service();
    await setAutoMode("off");
    const taskId = randomUUID();
    const taskRunId = randomUUID();
    const runId = randomUUID();
    const conversationId = randomUUID();
    await sql`INSERT INTO capybara.scheduled_tasks (id, org_id, account_id, agent_id, name, prompt,
        trigger, mode, device_id)
      VALUES (${taskId}, ${orgId}, ${accountId}, 'agent', 'T', 'p',
        ${JSON.stringify({ kind: "cron", expr: "0 9 * * *", timeZone: "UTC" })}::jsonb, 'new',
        ${deviceId})`.execute(raw);
    await sql`INSERT INTO capybara.scheduled_task_runs (id, task_id, org_id, scheduled_for, trial,
        status)
      VALUES (${taskRunId}, ${taskId}, ${orgId}, now(), false, 'running')`.execute(raw);
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
      SELECT ${conversationId}, ${orgId}, a.id, ${accountId}
      FROM capybara.agents a WHERE a.org_id = ${orgId} LIMIT 1`.execute(raw);
    await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version,
        trigger_account_id, trigger_seq, scheduled_task_run_id)
      VALUES (${runId}, ${conversationId}, 'running', 1, ${accountId}, 0, ${taskRunId})`.execute(
      raw,
    );
    await use(s, runId);
    expect(await modeOf()).toBe("sandbox");
    const row = await db
      .selectFrom("scheduled_task_runs")
      .select("missing_grants")
      .where("id", "=", taskRunId)
      .executeTakeFirstOrThrow();
    expect(row.missing_grants).toEqual([]);
  });
});
