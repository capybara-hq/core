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
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { UNATTENDED_OPEN_TIER_ERROR } from "../../src/schedules/unattended.js";
import {
  mapSandboxError,
  SANDBOX_CREATE_FAILED_TEXT,
  sandboxTierRefusedText,
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
 * Sandbox tiers on cloud devices (sandbox dev tiers spec §7.1, §11.4, §12): an instance records
 * the tier and egress mode it was made with; a use that finds another effective value updates the
 * instance (`update`), or recreates it on the kept files, or (a provider whose limits are fixed at
 * its file system, without `update`) keeps it and reports a pending file reset. A NULL record (an
 * instance made before migration 0117) differs once. Host list, cpu and memory changes never
 * trigger it. A scheduled run on an open cloud device needs the task's `tier:open` grant.
 */

let pgc: TestContainer;
let rdc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let config: KernelConfig;
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
    "capybara.device_instances, capybara.devices, capybara.accounts, capybara.orgs, capybara.scheduled_tasks",
  );
  if (root) await rm(root, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-tiers-"));
  provider = fake();
  config = KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    sandbox: { tiers: { max: "open", default: "dev" } },
  });
  ({ orgId, accountId } = await newOrg());
  // the org may reach open (the platform allows it)
  await setOrgSettings({ sandboxTier: { max: "open" } });
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

const setOrgSettings = (value: unknown) =>
  sql`UPDATE capybara.orgs SET settings = ${JSON.stringify(value)}::jsonb
    WHERE id = ${orgId}`.execute(raw);
/** What the device route (task C2) writes: the device's own tier, null = follow the org. */
const setTier = (tier: string | null, id = deviceId) =>
  sql`UPDATE capybara.devices SET tier = ${tier} WHERE id = ${id}`.execute(raw);
const record = async (id = deviceId) =>
  (
    await db
      .selectFrom("device_instances")
      .select("instance_limits")
      .where("device_id", "=", id)
      .executeTakeFirst()
  )?.instance_limits;

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

describe("creation records the effective tier and egress mode", () => {
  it("a device follows the org's default; its own tier wins within the ceiling", async () => {
    const s = service();
    const a = await use(s);
    expect((await fakeSandboxMeta(root, a.h.id))?.limits).toMatchObject({
      tier: "dev",
      egress: "allowlist",
    });
    expect(await record()).toEqual({ tier: "dev", egress: "allowlist" });

    const other = await seedDevice(raw, orgId);
    await setTier("open", other);
    const b = await use(s, undefined, other);
    expect((await fakeSandboxMeta(root, b.h.id))?.limits).toMatchObject({
      tier: "open",
      egress: "open",
      allowHosts: [],
    });
    expect(await record(other)).toEqual({ tier: "open", egress: "open" });
  });
});

describe("a changed tier on use", () => {
  it("update answers updated: the same instance, the new limits, no restart", async () => {
    provider = fake({ updateMode: "updated" });
    const s = service();
    const first = await use(s);
    await setTier("strict");
    expect(await s.limitsState({ orgId, deviceId })).toEqual({
      applied: { tier: "dev", egress: "allowlist" },
      effective: { tier: "strict", egress: "allowlist" },
      pendingNextUse: true,
      pendingFilesReset: false,
    });
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(again.info).toMatchObject({ fresh: false, restarted: false });
    expect(await ops("update")).toEqual([["update", first.h.id, "updated"]]);
    const updates = (await readFakeSandboxLimits(root)).filter((e) => e.op === "update");
    expect(updates.map((e) => e.limits.tier)).toEqual(["strict"]);
    expect(await record()).toEqual({ tier: "strict", egress: "allowlist" });
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
    await setTier("open");
    const again = await use(s);
    expect(again.h).not.toEqual(first.h);
    expect(again.info).toMatchObject({ fresh: true, restarted: true });
    expect(await ops("update")).toEqual([["update", first.h.id, "recreate"]]);
    expect(await ops("destroy")).toEqual([["destroy", first.h.id]]);
    expect(await ops("create-fs")).toHaveLength(1);
    const meta = await fakeSandboxMeta(root, again.h.id);
    expect(meta?.fileSystem).toBe(fs);
    expect(meta?.limits).toMatchObject({ tier: "open", egress: "open" });
    expect(await record()).toEqual({ tier: "open", egress: "open" });
  });

  it("no update (Docker today): destroy and create on the same files, files kept", async () => {
    const s = service();
    const first = await use(s);
    const fsOf = async (id: string) => (await fakeSandboxMeta(root, id))?.fileSystem;
    const fs = await fsOf(first.h.id);
    await setOrgSettings({ sandboxTier: { max: "open", default: "strict" } });
    const again = await use(s);
    expect(again.info).toMatchObject({ fresh: true, restarted: true });
    expect(await fsOf(again.h.id)).toBe(fs);
    expect(await ops("create")).toHaveLength(2);
    expect(await record()).toEqual({ tier: "strict", egress: "allowlist" });
  });

  it("a suspended instance is resumed, then gets the new tier", async () => {
    provider = fake({ updateMode: "updated" });
    const s = service();
    const first = await use(s);
    await s.suspendIdle(new Date(Date.now() + 24 * 60 * 60_000));
    expect(await ops("suspend")).toHaveLength(1);
    await setTier("open");
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(await ops("resume")).toHaveLength(1);
    expect(await ops("update")).toEqual([["update", first.h.id, "updated"]]);
    expect(await record()).toEqual({ tier: "open", egress: "open" });
  });

  it("limits fixed at the file system, no update: keeps running as is, pending a file reset", async () => {
    provider = fake({ limitsApplyAt: "fileSystem" });
    const s = service();
    const first = await use(s);
    // recorded with the file system
    expect(await record()).toEqual({ tier: "dev", egress: "allowlist" });
    await setTier("strict");
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(again.info).toMatchObject({ fresh: false, restarted: false });
    expect(await ops("create")).toHaveLength(1);
    expect(await record()).toEqual({ tier: "dev", egress: "allowlist" });
    expect(await s.limitsState({ orgId, deviceId })).toEqual({
      applied: { tier: "dev", egress: "allowlist" },
      effective: { tier: "strict", egress: "allowlist" },
      pendingNextUse: false,
      pendingFilesReset: true,
    });
    // a file reset applies it
    await s.resetFileSystem(deviceId);
    expect(await record()).toBeNull();
    await use(s);
    expect(await record()).toEqual({ tier: "strict", egress: "allowlist" });
    expect((await s.limitsState({ orgId, deviceId })).pendingFilesReset).toBe(false);
  });

  it("limits fixed at the file system, update answers recreate: recorded unapplied, not retried", async () => {
    provider = fake({ limitsApplyAt: "fileSystem", updateMode: "recreate" });
    const s = service();
    const first = await use(s);
    await setTier("open");
    const again = await use(s);
    expect(again.h).toEqual(first.h);
    expect(await ops("create")).toHaveLength(1);
    expect(await record()).toEqual({
      tier: "dev",
      egress: "allowlist",
      unapplied: { tier: "open", egress: "open" },
    });
    expect((await s.limitsState({ orgId, deviceId })).pendingFilesReset).toBe(true);
    await use(s);
    expect(await ops("update")).toHaveLength(1);
  });

  it("a tier narrowed while a use waits for the lease is applied before that use runs", async () => {
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
    await setTier("strict");
    await ex?.release();
    const again = await waiting;
    expect(again.h).toEqual(first.h);
    expect(await ops("update")).toEqual([["update", first.h.id, "updated"]]);
    expect(await record()).toEqual({ tier: "strict", egress: "allowlist" });
  });

  it("a NULL record (an instance made before the upgrade) differs once", async () => {
    const s = service();
    await use(s);
    await sql`UPDATE capybara.device_instances SET instance_limits = NULL
      WHERE device_id = ${deviceId}`.execute(raw);
    const again = await use(s);
    expect(again.info).toMatchObject({ restarted: true });
    expect(await record()).toEqual({ tier: "dev", egress: "allowlist" });
    await use(s);
    expect(await ops("create")).toHaveLength(2);
  });

  it("a changed host list, cpu or memory alone never touches the running instance", async () => {
    provider = fake({ updateMode: "updated" });
    const s = service();
    const first = await use(s);
    await setOrgSettings({
      sandboxTier: { max: "open" },
      sandboxEgress: { mode: "allowlist", allowHosts: ["example.com"] },
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

describe("a provider that refuses the open tier (openEgress off, spec §5.3)", () => {
  /** The refusal and the tool text it becomes; the provider's own message never reaches it. */
  const refused = async (err: unknown) => {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("sandbox.tier_refused");
    expect((err as ApiError).details).toEqual([{ tier: "open" }]);
    expect((err as Error).message).not.toContain(FAKE_REFUSAL_SECRET);
    const tool = mapSandboxError(err, undefined) as Error;
    expect(tool).toBeInstanceOf(ToolError);
    expect(tool.message).toBe(sandboxTierRefusedText("open"));
    expect(tool.message).not.toContain(FAKE_REFUSAL_SECRET);
    expect(tool.message).not.toContain("openEgress");
    expect(warned.some((m) => m.includes("refused an instance in the open tier"))).toBe(true);
  };

  it("a new instance at open: the create is refused with the tier error", async () => {
    await setFakeSandboxRefuseOpenEgress(root, true);
    await setTier("open");
    await refused(await use(service()).catch((e: unknown) => e));
    // dev still works on the same provider
    await setTier("dev");
    expect((await use(service())).info).toMatchObject({ fresh: true });
  });

  it("a running instance moved to open: the failed update recreates, and that create is refused", async () => {
    provider = fake({ updateMode: "updated" });
    const s = service();
    await use(s);
    await setFakeSandboxRefuseOpenEgress(root, true);
    await setTier("open");
    await refused(await use(s).catch((e: unknown) => e));
  });

  it("limits fixed at the file system: a new file system at open is refused", async () => {
    provider = fake({ limitsApplyAt: "fileSystem" });
    await setFakeSandboxRefuseOpenEgress(root, true);
    await setTier("open");
    await refused(await use(service()).catch((e: unknown) => e));
    expect(await ops("create-fs")).toEqual([]);
  });

  it("limits fixed at the file system: a refused update suspends the instance with the tier error", async () => {
    provider = fake({ updateMode: "updated", limitsApplyAt: "fileSystem" });
    const s = service();
    await use(s);
    await setFakeSandboxRefuseOpenEgress(root, true);
    await setTier("open");
    await refused(await use(s).catch((e: unknown) => e));
    expect(await status()).toBe("suspended");
    expect(await record()).toEqual({ tier: "dev", egress: "allowlist" });
  });

  it("any other create failure becomes sandbox.create_failed without the provider's message", async () => {
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
    await setTier("strict");
    const again = await use(s);
    expect(again.h).not.toEqual(first.h);
    expect(again.info).toMatchObject({ fresh: true, restarted: true });
    expect(await ops("update")).toEqual([["update", first.h.id, "throw"]]);
    // recorded by the create that applied it
    expect(await record()).toEqual({ tier: "strict", egress: "allowlist" });
    expect((await fakeSandboxMeta(root, again.h.id))?.limits.tier).toBe("strict");
    expect(warned.some((m) => m.includes("update failed"))).toBe(true);
  });

  it("an update aborted on a provider bound to instances suspends the instance instead of recreating it", async () => {
    provider = fake({ updateMode: "throw" });
    const s = service();
    const first = await use(s);
    await setTier("strict");
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
    expect(await record()).toEqual({ tier: "dev", egress: "allowlist" });
  });

  it("an update that fails on a provider bound to its file system suspends the instance and throws", async () => {
    provider = fake({ updateMode: "throw", limitsApplyAt: "fileSystem" });
    const s = service();
    const first = await use(s);
    await setTier("strict");
    const err = await use(s).catch((e: unknown) => e);
    expect((err as Error).message).toBe("fake update failed");
    expect(await fakeSandboxState(root, first.h.id)).toBe("suspended");
    expect(await status()).toBe("suspended");
    expect(await record()).toEqual({ tier: "dev", egress: "allowlist" });
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
    await setTier("strict");
    await setFakeSandboxDelays(root, { update: 2000 });
    const run = use(s).catch((e: unknown) => e);
    // the exclusive lease expires under the slow update
    await new Promise((r) => setTimeout(r, 150));
    await redis.del(`capk:sandbox:${deviceId}`, `capk:sandbox-users:${deviceId}`);
    const err = await run;
    expect(err).toBeInstanceOf(Error);
    await setFakeSandboxDelays(root, {});
    expect(await record()).toEqual({ tier: "dev", egress: "allowlist" });
    expect(await ops("update")).toEqual([]);
    expect(await fakeSandboxState(root, first.h.id)).toBe("suspended");
  });

  it("a file reset clears the record of an instance provider; the next create records again", async () => {
    const s = service();
    await use(s);
    expect(await record()).toEqual({ tier: "dev", egress: "allowlist" });
    await s.resetFileSystem(deviceId);
    expect(await record()).toBeNull();
    await setTier("open");
    await use(s);
    expect(await record()).toEqual({ tier: "open", egress: "open" });
  });
});

describe("scheduled runs on an open cloud device (spec §11.4)", () => {
  /** A task of the org's creator on `deviceId`, a task run and a kernel run serving it. */
  async function scheduledRun(
    trial = false,
  ): Promise<{ taskId: string; taskRunId: string; runId: string }> {
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
      VALUES (${taskRunId}, ${taskId}, ${orgId}, now(), ${trial}, 'running')`.execute(raw);
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
      SELECT ${conversationId}, ${orgId}, a.id, ${accountId}
      FROM capybara.agents a WHERE a.org_id = ${orgId} LIMIT 1`.execute(raw);
    await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version,
        trigger_account_id, trigger_seq, scheduled_task_run_id)
      VALUES (${runId}, ${conversationId}, 'running', 1, ${accountId}, 0, ${taskRunId})`.execute(
      raw,
    );
    return { taskId, taskRunId, runId };
  }
  const missing = async (taskRunId: string) =>
    (
      await db
        .selectFrom("scheduled_task_runs")
        .select("missing_grants")
        .where("id", "=", taskRunId)
        .executeTakeFirstOrThrow()
    ).missing_grants;

  it("without tier:open the sandbox is refused and the grant recorded missing; the grant allows it", async () => {
    const s = service();
    await setTier("open");
    const run = await scheduledRun();
    const err = await use(s, run.runId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("device.tier_not_granted");
    expect((err as ApiError).message).toBe(UNATTENDED_OPEN_TIER_ERROR);
    // the tools give the model the same text
    expect((mapSandboxError(err, undefined) as Error).message).toBe(UNATTENDED_OPEN_TIER_ERROR);
    expect(await missing(run.taskRunId)).toEqual(["tier:open"]);
    // nothing was created or switched
    expect(await ops("create")).toEqual([]);

    await sql`INSERT INTO capybara.scheduled_task_grants (task_id, tool_key, spec_hash)
      VALUES (${run.taskId}, 'tier:open', 'tier')`.execute(raw);
    const ok = await use(s, run.runId);
    expect((await fakeSandboxMeta(root, ok.h.id))?.limits).toMatchObject({ tier: "open" });
  });

  it("a device below open, a trial run and an attended run are never refused", async () => {
    const s = service();
    const run = await scheduledRun();
    await use(s, run.runId);
    await setTier("open");
    const trial = await scheduledRun(true);
    await use(s, trial.runId);
    await use(s);
    expect(await missing(run.taskRunId)).toEqual([]);
  });

  it("a provider bound to its file system that may still run open is refused (record open or unknown)", async () => {
    provider = fake({ limitsApplyAt: "fileSystem" });
    const s = service();
    await setTier("open");
    await use(s);
    expect(await record()).toEqual({ tier: "open", egress: "open" });
    // narrowed, but only a file reset applies it: the file system still runs open
    await setTier("dev");
    const run = await scheduledRun();
    const err = await use(s, run.runId).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("device.tier_not_granted");
    // an unknown record (made before the upgrade) counts as open too
    await sql`UPDATE capybara.device_instances SET instance_limits = NULL
      WHERE device_id = ${deviceId}`.execute(raw);
    const err2 = await use(s, run.runId).catch((e: unknown) => e);
    expect((err2 as ApiError).code).toBe("device.tier_not_granted");
    // after a file reset it runs dev
    await s.resetFileSystem(deviceId);
    await use(s, run.runId);
    expect(await record()).toEqual({ tier: "dev", egress: "allowlist" });
  });
});
