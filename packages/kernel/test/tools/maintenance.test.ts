import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import {
  deleteExpiredOutputs,
  MAINTENANCE_QUEUE_NAME,
  Maintenance,
  OUTPUT_CLEANUP_EVERY_MS,
  OUTPUT_CLEANUP_JOB,
  OUTPUT_CLEANUP_SCHEDULER_ID,
} from "../../src/runtime/maintenance.js";
import { truncateTables } from "../helpers/db.js";
import { waitFor } from "../helpers/runs.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

/** Task 10：内核维护队列（`cap-kernel-maintenance`）与输出存档的每小时清理。 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let probe: Queue;
let seed: Awaited<ReturnType<typeof seedConversation>>;
const instances: Maintenance[] = [];
const log = createLogger("error", { write: () => {} });

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  probe = new Queue(MAINTENANCE_QUEUE_NAME, { connection: new Redis(rd.url) });
}, 120_000);
afterAll(async () => {
  await probe?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  await probe.obliterate({ force: true });
  seed = await seedConversation(raw);
});
afterEach(async () => {
  for (const m of instances.splice(0)) await m.close();
});

const maintenance = () => {
  const m = new Maintenance({ db, redisUrl: rd.url, log });
  instances.push(m);
  return m;
};

/** 插入 n 条输出存档，到期时间为 now() + offsetSeconds。 */
async function insertOutputs(n: number, offsetSeconds: number, prefix: string): Promise<void> {
  await sql`INSERT INTO capybara.tool_outputs
      (id, org_id, conversation_id, call_id, size_chars, line_count, content, expires_at)
    SELECT ${prefix} || g, ${seed.orgId}, ${seed.conversationId}, 'c', 1, 1, 'x',
      now() + ${offsetSeconds}::integer * interval '1 second'
    FROM generate_series(1, ${n}) AS g`.execute(raw);
}

async function countOutputs(prefix: string): Promise<number> {
  const r = await sql<{ n: string }>`SELECT count(*)::text AS n FROM capybara.tool_outputs
    WHERE id LIKE ${`${prefix}%`}`.execute(raw);
  return Number(r.rows[0]?.n ?? 0);
}

describe("deleteExpiredOutputs", () => {
  it("分批删除已过期的存档，保留未过期的", async () => {
    await insertOutputs(25, -60, "old-");
    await insertOutputs(3, 3600, "new-");
    expect(await deleteExpiredOutputs(db, 10)).toBe(25);
    expect(await countOutputs("old-")).toBe(0);
    expect(await countOutputs("new-")).toBe(3);
    expect(await deleteExpiredOutputs(db, 10)).toBe(0);
  });
});

describe("Maintenance", () => {
  it("每小时一次的 job scheduler：id 不含冒号，多副本重复 upsert 只有一个", async () => {
    expect(MAINTENANCE_QUEUE_NAME).not.toContain(":");
    expect(OUTPUT_CLEANUP_SCHEDULER_ID).not.toContain(":");
    expect(OUTPUT_CLEANUP_EVERY_MS).toBe(3_600_000);
    await Promise.all([maintenance().ensureSchedules(), maintenance().ensureSchedules()]);
    await maintenance().ensureSchedules();
    const schedulers = await probe.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: OUTPUT_CLEANUP_SCHEDULER_ID,
      name: OUTPUT_CLEANUP_JOB,
      every: OUTPUT_CLEANUP_EVERY_MS,
    });
  });

  it("worker 执行清理任务：删除过期存档、保留未过期的", async () => {
    await insertOutputs(5, -60, "old-");
    await insertOutputs(2, 3600, "new-");
    const m = maintenance();
    m.startWorker();
    await probe.add(OUTPUT_CLEANUP_JOB, {}, { removeOnComplete: true });
    await waitFor(async () => (await countOutputs("old-")) === 0, 10_000, "expired outputs gone");
    expect(await countOutputs("new-")).toBe(2);
  });

  it("未启动 worker 的实例（非 worker 角色）不处理任务", async () => {
    await insertOutputs(2, -60, "old-");
    maintenance();
    await probe.add(OUTPUT_CLEANUP_JOB, {}, { jobId: "cleanup-probe" });
    await new Promise((r) => setTimeout(r, 500));
    expect(await countOutputs("old-")).toBe(2);
    expect(await (await probe.getJob("cleanup-probe"))?.getState()).toBe("waiting");
  });
});
