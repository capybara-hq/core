import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR, KERNEL_SCHEMA } from "../../src/kernel.js";
import { OrgQuota, orgRunLimit } from "../../src/runtime/quota.js";
import { settingsFor } from "../helpers/identity.js";

let pgc: TestContainer;
let rd: TestContainer;
let redis: Redis;
let raw: ReturnType<typeof createDb>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, { schema: KERNEL_SCHEMA, dir: KERNEL_MIGRATIONS_DIR });
  redis = new Redis(rd.url);
  raw = createDb(pgc.url, 3);
});
afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await redis.flushdb();
  await sql`TRUNCATE capybara.deployment_settings`.execute(raw);
});

const config = KernelConfigSchema.parse({
  db: { url: "postgres://x" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
  runtime: { orgConcurrency: 3 },
});

describe("OrgQuota", () => {
  it("limit 2：第 3 个 tryEnter 返回 false；leave 后可以进入；键带 TTL", async () => {
    const q = new OrgQuota(redis);
    expect(await q.tryEnter("o1", "r1", 2)).toBe(true);
    expect(await q.tryEnter("o1", "r2", 2)).toBe(true);
    expect(await q.tryEnter("o1", "r3", 2)).toBe(false);
    const ttl = await redis.pttl("capk:org-runs:o1");
    expect(ttl).toBeGreaterThan(60_000);
    expect(ttl).toBeLessThanOrEqual(120_000);
    // 同一 runId 重复进入不额外占名额
    expect(await q.tryEnter("o1", "r1", 2)).toBe(true);
    expect(await redis.zcard("capk:org-runs:o1")).toBe(2);
    await q.leave("o1", "r1");
    expect(await q.tryEnter("o1", "r3", 2)).toBe(true);
    // 其他组织不受影响
    expect(await q.tryEnter("o2", "r9", 2)).toBe(true);
  });

  it("不 leave、租约过期后可以进入（崩溃不泄漏）；renew 延长租约", async () => {
    const q = new OrgQuota(redis);
    expect(await q.tryEnter("o1", "r1", 1, 300)).toBe(true);
    expect(await q.tryEnter("o1", "r2", 1, 300)).toBe(false);
    await sleep(200);
    expect(await q.renew("o1", "r1", 300)).toBe(true);
    await sleep(200);
    expect(await q.tryEnter("o1", "r2", 1, 300)).toBe(false);
    await sleep(250);
    expect(await q.tryEnter("o1", "r2", 1, 300)).toBe(true);
    // r1 已被清理：renew 返回 false
    expect(await q.renew("o1", "r1", 300)).toBe(false);
  });

  it("runConcurrencyOverrides 对某个组织生效，其他组织用 runtime.orgConcurrency", async () => {
    const db = kernelDb(raw);
    await db
      .insertInto("deployment_settings")
      .values({ key: "runConcurrencyOverrides", value: JSON.stringify({ oA: 1 }) })
      .execute();
    const settings = settingsFor(db);
    const limitOf = (org: string) => orgRunLimit(settings, () => config, org);
    expect(await limitOf("oA")).toBe(1);
    expect(await limitOf("oB")).toBe(3);

    const q = new OrgQuota(redis);
    expect(await q.tryEnter("oA", "a1", await limitOf("oA"))).toBe(true);
    expect(await q.tryEnter("oA", "a2", await limitOf("oA"))).toBe(false);
    for (const r of ["b1", "b2", "b3"]) {
      expect(await q.tryEnter("oB", r, await limitOf("oB"))).toBe(true);
    }
    expect(await q.tryEnter("oB", "b4", await limitOf("oB"))).toBe(false);
  });

  it("runConcurrencyOverrides 值非法时整键回落默认值（逐键校验）", async () => {
    const db = kernelDb(raw);
    await db
      .insertInto("deployment_settings")
      .values({ key: "runConcurrencyOverrides", value: JSON.stringify({ oA: 0 }) })
      .execute();
    const settings = settingsFor(db);
    expect((await settings.get()).runConcurrencyOverrides).toEqual({});
    expect(await orgRunLimit(settings, () => config, "oA")).toBe(3);
  });
});
