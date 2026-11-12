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
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { UNATTENDED_OPEN_TIER_ERROR } from "../../src/schedules/unattended.js";
import { mapSandboxError } from "../../src/tools/builtins/sandbox/common.js";
import {
  createFakeSandbox,
  type FakeSandboxOptions,
  fakeSandboxMeta,
  readFakeSandboxLimits,
  readFakeSandboxOps,
} from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { sandboxServiceFor, seedDevice } from "../helpers/sandbox.js";

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

const service = (p: () => SandboxProvider = () => provider) =>
  sandboxServiceFor({
    db,
    redis,
    provider: () => ({ plugin: "sandbox-fake", impl: p() }),
    config: () => config,
    log,
    lockPollMs: 20,
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

  it("warns when the provider does not create an open-tier instance", async () => {
    const refusing = fake();
    const p: SandboxProvider = Object.create(refusing);
    p.create = async (args) => {
      if (args.limits.egress === "open") throw new Error("open egress is off");
      return refusing.create(args);
    };
    await setTier("open");
    const err = await use(service(() => p)).catch((e: unknown) => e);
    expect((err as Error).message).toBe("open egress is off");
    expect(warned.some((m) => m.includes("open tier"))).toBe(true);
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
});
