import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxLimits, SandboxProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { readSandboxLimitOverride } from "../../src/identity/settings.js";
import { effectiveSandboxLimits, OrgSettingsService } from "../../src/orgs/settings.service.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { createFakeSandbox, fakeSandboxMeta } from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";

/**
 * 组织级沙箱 cpu / 内存（C19 / Ruling M16）：企业管理员在部署设置 `sandboxLimitOverrides` 里按组织覆盖，
 * 创建沙箱时生效（只影响之后新建的）；组织设置 GET 只读地带回实际生效值与来源。
 */

const DEPLOYMENT: SandboxLimits = {
  cpu: 1,
  memoryMb: 1024,
  diskMb: 2048,
  egress: "allowlist",
  allowHosts: ["registry.npmjs.org"],
};

describe("effectiveSandboxLimits", () => {
  it("没有覆盖 → 部署默认（返回新对象，不共享 allowHosts 数组）", () => {
    const got = effectiveSandboxLimits(DEPLOYMENT, undefined);
    expect(got).toEqual(DEPLOYMENT);
    expect(got).not.toBe(DEPLOYMENT);
    expect(got.allowHosts).not.toBe(DEPLOYMENT.allowHosts);
  });

  it("只覆盖 cpu / 只覆盖内存 / 两项都覆盖；未给的项用部署默认；disk 与出站不变", () => {
    expect(effectiveSandboxLimits(DEPLOYMENT, { cpu: 4 })).toEqual({ ...DEPLOYMENT, cpu: 4 });
    expect(effectiveSandboxLimits(DEPLOYMENT, { memoryMb: 8192 })).toEqual({
      ...DEPLOYMENT,
      memoryMb: 8192,
    });
    expect(effectiveSandboxLimits(DEPLOYMENT, { cpu: 0.5, memoryMb: 512 })).toEqual({
      ...DEPLOYMENT,
      cpu: 0.5,
      memoryMb: 512,
    });
  });
});

let pgc: TestContainer;
let rdc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let config: KernelConfig;
let root: string;
let provider: SandboxProvider;
const log = { info() {}, warn() {}, error() {} };
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

async function newOrg(): Promise<string> {
  const accountId = randomUUID();
  const id = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'U')`.execute(
    raw,
  );
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${id}, ${`o-${id.slice(0, 8)}`}, 'O', ${accountId})`.execute(raw);
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${randomUUID()}, ${id}, ${accountId}, 'org', 1)`.execute(raw);
  return id;
}

async function newConversation(org = orgId): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    SELECT ${id}, o.id, (SELECT a.id FROM capybara.agents a WHERE a.org_id = o.id LIMIT 1), o.created_by
    FROM capybara.orgs o WHERE o.id = ${org}`.execute(raw);
  return id;
}

/** 直接写部署设置（等同企业管理员 PUT /admin/settings 的结果）。 */
const setOverrides = (value: unknown) =>
  sql`INSERT INTO capybara.deployment_settings (key, value)
    VALUES ('sandboxLimitOverrides', ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(raw);

const service = () =>
  new SandboxService({
    db,
    redis,
    provider: () => ({ plugin: "sandbox-fake", impl: provider }),
    config: () => config,
    log,
    lockPollMs: 20,
  });

const use = (s: SandboxService, conversationId: string, org = orgId) =>
  s.withSandbox({ orgId: org, conversationId }, async (h) => h, signal());
const limitsOf = async (s: SandboxService, conversationId: string, org = orgId) =>
  (await fakeSandboxMeta(root, (await use(s, conversationId, org)).id))?.limits;

beforeEach(async () => {
  await redis.flushdb();
  await truncateTables(
    raw,
    "capybara.sandboxes, capybara.accounts, capybara.orgs, capybara.deployment_settings",
  );
  if (root) await rm(root, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-limits-"));
  provider = createFakeSandbox(root);
  config = KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });
  orgId = await newOrg();
});

describe("readSandboxLimitOverride", () => {
  it("没有设置 / 组织不在其中 → undefined；有 → 该组织的覆盖；存量非法 → undefined", async () => {
    expect(await readSandboxLimitOverride(db, orgId)).toBeUndefined();
    await setOverrides({ other: { cpu: 2 } });
    expect(await readSandboxLimitOverride(db, orgId)).toBeUndefined();
    await setOverrides({ [orgId]: { memoryMb: 4096 } });
    expect(await readSandboxLimitOverride(db, orgId)).toEqual({ memoryMb: 4096 });
    await setOverrides({ [orgId]: { cpu: 1000 } });
    expect(await readSandboxLimitOverride(db, orgId)).toBeUndefined();
  });

  it("逐条解析：别的组织的存量值非法不影响本组织的覆盖", async () => {
    await setOverrides({ broken: { cpu: "lots" }, [orgId]: { cpu: 2 } });
    expect(await readSandboxLimitOverride(db, orgId)).toEqual({ cpu: 2 });
    await setOverrides({ [orgId]: "nope" });
    expect(await readSandboxLimitOverride(db, orgId)).toBeUndefined();
  });
});

describe("创建沙箱时按组织覆盖 cpu / memoryMb", () => {
  it("设置覆盖后新建的沙箱收到覆盖值；其他组织仍用部署默认", async () => {
    const other = await newOrg();
    await setOverrides({ [orgId]: { cpu: 2.5, memoryMb: 3072 } });
    const s = service();
    expect(await limitsOf(s, await newConversation())).toMatchObject({
      cpu: 2.5,
      memoryMb: 3072,
      diskMb: config.sandbox.limits.diskMb,
      egress: config.sandbox.limits.egress,
    });
    expect(await limitsOf(s, await newConversation(other), other)).toMatchObject({
      cpu: config.sandbox.limits.cpu,
      memoryMb: config.sandbox.limits.memoryMb,
    });
  });

  it("只覆盖 memoryMb：cpu 用部署默认", async () => {
    await setOverrides({ [orgId]: { memoryMb: 8192 } });
    expect(await limitsOf(service(), await newConversation())).toMatchObject({
      cpu: config.sandbox.limits.cpu,
      memoryMb: 8192,
    });
  });

  it("只对之后新建的沙箱生效：已有的沿用创建时的限额", async () => {
    const s = service();
    const conv = await newConversation();
    const first = await use(s, conv);
    await setOverrides({ [orgId]: { cpu: 4 } });
    const again = await use(s, conv);
    expect(again).toEqual(first);
    expect((await fakeSandboxMeta(root, again.id))?.limits.cpu).toBe(config.sandbox.limits.cpu);
    expect(await limitsOf(s, await newConversation())).toMatchObject({ cpu: 4 });
  });
});

describe("组织设置只读地带回实际生效的沙箱限额", () => {
  it("没有覆盖 → source deployment；有覆盖 → source override，未给的项用部署默认", async () => {
    const settings = new OrgSettingsService(db, () => config);
    expect(await settings.sandboxLimits(orgId)).toEqual({
      cpu: config.sandbox.limits.cpu,
      memoryMb: config.sandbox.limits.memoryMb,
      source: "deployment",
    });
    await setOverrides({ [orgId]: { cpu: 8 } });
    expect(await settings.sandboxLimits(orgId)).toEqual({
      cpu: 8,
      memoryMb: config.sandbox.limits.memoryMb,
      source: "override",
    });
  });
});
