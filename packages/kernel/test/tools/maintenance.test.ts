import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { removeRetiredSchedulers } from "../../src/infra/queue/retired-schedulers.js";
import { KernelModule } from "../../src/kernel.module.js";
import { createLogger } from "../../src/log.js";
import { logContext } from "../../src/log-context.js";
import { WorkerModule } from "../../src/roles/worker.module.js";
import { MaintenanceModule, MaintenanceProcessor } from "../../src/runtime/maintenance.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { RETIRED_SCHEDULER_IDS } from "../../src/runtime/retired-schedulers.js";
import { SANDBOX_SUSPEND_JOB } from "../../src/sandbox/jobs.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import {
  DRIFT_SCHEDULER_ID,
  OUTPUT_CLEANUP_JOB,
  OUTPUT_CLEANUP_SCHEDULER_ID,
} from "../../src/tools/job-ids.js";
import { ToolJobs } from "../../src/tools/jobs.js";
import { deleteExpiredOutputs } from "../../src/tools/outputs.js";
import { truncateTables } from "../helpers/db.js";
import { runConfig, startKernel, waitFor } from "../helpers/runs.js";
import { seedConversation } from "../helpers/tool-fixtures.js";
import { configFrom, kernelDbFor } from "../helpers/tools.js";

/**
 * The kernel maintenance queue (`cap-kernel-maintenance`) and the hourly cleanup of output
 * archives (a `@LockedCron` of `ToolJobs`; its old scheduler is retired).
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let probe: Queue;
let seed: Awaited<ReturnType<typeof seedConversation>>;
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
    // two worker replicas starting together
    await Promise.all([
      removeRetiredSchedulers(probe, RETIRED_SCHEDULER_IDS),
      removeRetiredSchedulers(probe, RETIRED_SCHEDULER_IDS),
    ]);
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
    // the maintenance processor's module is imported by the worker role only
    const config = (roles: string[]) =>
      KernelConfigSchema.parse({
        db: { url: pgc.url },
        redis: { url: rd.url },
        masterKey: Buffer.alloc(32, 7).toString("base64"),
        roles,
      });
    const imports = (roles: string[]) =>
      (KernelModule.forRoot(config(roles), { logger: log }).imports ?? []).map(
        (m) => (m as { module?: unknown }).module ?? m,
      );
    expect(imports(["api", "gateway"])).not.toContain(WorkerModule);
    expect(imports(["worker"])).toContain(WorkerModule);
    expect(WorkerModule.forRoot(config(["worker"])).imports).toContain(MaintenanceModule);
    expect(
      (Reflect.getMetadata("providers", MaintenanceModule) as { provide: unknown }[]).map(
        (p) => p.provide,
      ),
    ).toEqual([MaintenanceProcessor]);
  });
});

describe("MaintenanceProcessor (the one consumer)", () => {
  it("dispatches each one-off job by name to its domain, a periodic job's name to its body; an unknown name is only warned", async () => {
    const calls: unknown[][] = [];
    const warned: unknown[][] = [];
    const processor = new MaintenanceProcessor(
      { processTimeout: async (job, token) => void calls.push(["wait", job.data, token]) },
      { destroyFor: async (id) => void calls.push(["sandbox", id]) },
      {
        check: async (...a) => {
          calls.push(["drift", ...a]);
          return undefined as never;
        },
      },
      { runSyncJob: async (d) => void calls.push(["directory", d]) },
      {
        runNow: async (name) => {
          if (name !== "sandbox-suspend-idle") return false;
          calls.push(["periodic", name]);
          return true;
        },
      },
      { error: () => {}, warn: (...a: unknown[]) => void warned.push(a) },
      { removeJobScheduler: async () => true },
    );
    const job = (name: string, data: unknown) => ({ name, data, id: `${name}-1` }) as never;
    await processor.process(job("wait-timeout", { waitId: "w" }), "tok");
    await processor.process(job("sandbox-destroy-for", { conversationIds: ["c1"] }));
    await processor.process(
      job("drift-connector", { orgId: "o", connectorId: "k", trigger: "schedule" }),
    );
    await processor.process(job("directory-sync", { orgId: "o" }));
    await processor.process(job("sandbox-suspend-idle", {}));
    await processor.process(job("no-such-job", {}));
    expect(calls).toEqual([
      ["wait", { waitId: "w" }, "tok"],
      ["sandbox", "c1"],
      ["drift", "o", "k", "schedule"],
      ["directory", { orgId: "o" }],
      ["periodic", "sandbox-suspend-idle"],
    ]);
    expect(warned).toEqual([
      ["unknown maintenance job", { name: "no-such-job", jobId: "no-such-job-1" }],
    ]);
  });
});

describe("a periodic job's name on the maintenance queue", () => {
  it("runs that job's body once (sandbox-suspend-idle runs the suspend sweep)", async () => {
    const k = await startKernel(
      runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] }),
    );
    try {
      // every suspend sweep, with the maintenance job it ran in (the cron's own ticks have none)
      const sweeps: (string | undefined)[] = [];
      const sandbox = k.app.get(SandboxService) as unknown as {
        suspendIdle: (now: Date) => Promise<number>;
      };
      sandbox.suspendIdle = async () => {
        sweeps.push(logContext()?.jobId);
        return 0;
      };
      const job = await probe.add(SANDBOX_SUSPEND_JOB, {}, { jobId: "suspend-now" });
      await waitFor(
        async () => (await probe.getJobState(job.id as string)) === "completed",
        10_000,
        "maintenance job completed",
      );
      expect(sweeps).toContain("suspend-now");
    } finally {
      await k.close();
    }
  }, 60_000);
});
