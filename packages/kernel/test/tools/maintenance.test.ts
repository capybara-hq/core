import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import {
  MAINTENANCE_QUEUE_NAME,
  Maintenance,
  RETIRED_SCHEDULER_IDS,
} from "../../src/runtime/maintenance.js";
import {
  DRIFT_SCHEDULER_ID,
  OUTPUT_CLEANUP_JOB,
  OUTPUT_CLEANUP_SCHEDULER_ID,
} from "../../src/tools/job-ids.js";
import { ToolJobs } from "../../src/tools/jobs.js";
import { deleteExpiredOutputs } from "../../src/tools/outputs.js";
import { truncateTables } from "../helpers/db.js";
import { seedConversation } from "../helpers/tool-fixtures.js";
import { configFrom, kernelDbFor } from "../helpers/tools.js";

/**
 * Task 10：内核维护队列（`cap-kernel-maintenance`）与输出存档的每小时清理（nest kernel 3.5: the cleanup
 * is a `@LockedCron` of `ToolJobs`, its old scheduler retired).
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let probe: Queue;
let seed: Awaited<ReturnType<typeof seedConversation>>;
const instances: Maintenance[] = [];
const log = createLogger("error", { write: () => {} });

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
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

describe("output-cleanup", () => {
  it("the old hourly scheduler is retired: a worker start removes it (and the drift scan's)", async () => {
    expect(MAINTENANCE_QUEUE_NAME).not.toContain(":");
    expect(OUTPUT_CLEANUP_SCHEDULER_ID).not.toContain(":");
    expect(RETIRED_SCHEDULER_IDS).toEqual(
      expect.arrayContaining([OUTPUT_CLEANUP_SCHEDULER_ID, DRIFT_SCHEDULER_ID]),
    );
    await probe.upsertJobScheduler(
      OUTPUT_CLEANUP_SCHEDULER_ID,
      { every: 3_600_000 },
      { name: OUTPUT_CLEANUP_JOB, data: {} },
    );
    await Promise.all([maintenance().ensureSchedules(), maintenance().ensureSchedules()]);
    expect(await probe.getJobSchedulers()).toHaveLength(0);
  });

  it("the @LockedCron job deletes expired archives and keeps the others", async () => {
    await insertOutputs(5, -60, "old-");
    await insertOutputs(2, 3600, "new-");
    const redis = new Redis(rd.url);
    try {
      const jobs = new ToolJobs(
        { scan: async () => 0 },
        kernelDbFor(raw),
        configFrom(() => ({})) as never,
        new LockService(redis, log),
        log,
      );
      await jobs.cleanupOutputs();
      expect(await countOutputs("old-")).toBe(0);
      expect(await countOutputs("new-")).toBe(2);
    } finally {
      redis.disconnect();
    }
  });

  it("未启动 worker 的实例（非 worker 角色）不处理维护任务", async () => {
    maintenance();
    await probe.add("some-job", {}, { jobId: "cleanup-probe" });
    await new Promise((r) => setTimeout(r, 500));
    expect(await (await probe.getJob("cleanup-probe"))?.getState()).toBe("waiting");
  });
});
