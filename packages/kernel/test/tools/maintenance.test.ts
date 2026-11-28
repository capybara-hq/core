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
import { KernelModule } from "../../src/kernel.module.js";
import { createLogger } from "../../src/log.js";
import { logContext } from "../../src/log-context.js";
import { WorkerModule } from "../../src/roles/worker.module.js";
import { MaintenanceModule, MaintenanceProcessor } from "../../src/runtime/maintenance.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { SANDBOX_SUSPEND_JOB } from "../../src/sandbox/jobs.js";
import { SandboxOperationReconcileJob } from "../../src/sandbox/operation-reconcile.job.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { OUTPUT_CLEANUP_JOB } from "../../src/tools/job-ids.js";
import { ToolJobs } from "../../src/tools/jobs.js";
import { deleteExpiredOutputs } from "../../src/tools/outputs.js";
import { truncateTables } from "../helpers/db.js";
import { runConfig, startKernel, waitFor } from "../helpers/runs.js";
import { seedConversation } from "../helpers/tool-fixtures.js";
import { configFrom, kernelDbFor } from "../helpers/tools.js";

/**
 * The kernel maintenance queue (`cap-kernel-maintenance`) and the hourly cleanup of output
 * archives (a `@LockedCron` of `ToolJobs`).
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let probe: Queue;
/**
 * The client the queue above uses. A queue given a client does not close it, so afterAll quits it
 * before Redis stops: an open client without an error listener reports "[ioredis] Unhandled error
 * event" on every reconnect, which can land after Vitest tore the worker down.
 */
const redisClients: Redis[] = [];
const redisClient = (): Redis => {
  const c = new Redis(rd.url);
  redisClients.push(c);
  return c;
};
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
  probe = new Queue(MAINTENANCE_QUEUE_NAME, { connection: redisClient() });
});
afterAll(async () => {
  await probe?.close();
  await Promise.all(redisClients.splice(0).map((c) => c.quit()));
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
  it("the maintenance queue and the cleanup job have no `:` in their names", () => {
    expect(MAINTENANCE_QUEUE_NAME).not.toContain(":");
    expect(OUTPUT_CLEANUP_JOB).not.toContain(":");
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
        (p) => p.provide ?? p,
      ),
    ).toEqual([SandboxOperationReconcileJob, MaintenanceProcessor]);
  });
});

describe("MaintenanceProcessor (the one consumer)", () => {
  it("dispatches each one-off job by name to its domain, a periodic job's name to its body; an unknown name fails", async () => {
    const calls: unknown[][] = [];
    const warned: unknown[][] = [];
    const processor = new MaintenanceProcessor(
      { recheck: async (data) => void calls.push(["permission-recheck", data]) },
      {
        processTimeout: async (job, token) => void calls.push(["wait", job.data, token]),
        childFinished: async (id) => {
          calls.push(["deliver", id]);
          return false;
        },
        stopChildren: async (id, by) => {
          calls.push(["stop-children", id, by]);
          return 0;
        },
        stopDescendantsOfStopped: async (id) => {
          calls.push(["stop-descendants", id]);
          return 0;
        },
        stopTree: async (id, by, opts) => {
          calls.push(["stop-tree", id, by, opts]);
          return 0;
        },
      },
      {
        destroyDevice: async (id) => void calls.push(["sandbox", id]),
        resetFileSystem: async (id) => void calls.push(["reset", id]),
        revokeDeadHolder: async (id, token) => void calls.push(["revoke-holder", id, token]),
      },
      {
        check: async (...a) => {
          calls.push(["drift", ...a]);
          return undefined as never;
        },
      },
      { runSyncJob: async (d) => void calls.push(["directory", d]) },
      {
        stopOrg: async (d) => void calls.push(["stop-org", d]),
        stopTree: async (id, by) => void calls.push(["stop-deleted-tree", id, by]),
      },
      { stopRun: async (d) => void calls.push(["run-stop", d]) },
      {
        ensureRun: async (id) => {
          calls.push(["wake", id]);
          return null;
        },
      },
      { run: async (id) => void calls.push(["owned-cleanup", id]) },
      {
        fire: async (id) => void calls.push(["automation-fire", id]),
        settle: async (d) => void calls.push(["automation-settle", d]),
      },
      {
        runNow: async (name) => {
          if (name !== "sandbox-suspend-idle") return false;
          calls.push(["periodic", name]);
          return true;
        },
      },
      { error: () => {}, warn: (...a: unknown[]) => void warned.push(a) },
      { reconcile: async () => {}, revoke: async () => {} },
      { deleteObject: async (d) => void calls.push(["share-object-delete", d]) },
      {
        deleteBlob: async (d) => void calls.push(["blob-delete", d]),
        deleteStaging: async (d) => void calls.push(["file-staging-delete", d]),
        releaseFile: async (d) => void calls.push(["file-release", d]),
      },
      {
        dispatch: async () => {
          calls.push(["file-library-hash"]);
          return 0;
        },
        runOrgBatch: async (d) => {
          calls.push(["file-library-hash-org", d]);
          return { ran: true, outcomes: {}, next: null };
        },
      },
      {
        run: async () => {
          calls.push(["file-library-backfill"]);
          return "copied";
        },
      },
      { deleteObject: async (d) => void calls.push(["platform-icon-delete", d]) },
      {
        attempt: async (orgId, noticeId, opts) => {
          calls.push(["conversation-notice", orgId, noticeId, opts?.timeoutMs]);
          return "delivered";
        },
      },
      { dispatch: async (d) => void calls.push(["trigger-dispatch", d]) },
      { flush: async (d) => void calls.push(["automation-coalesce", d]) },
      {
        fire: async (d) => {
          calls.push(["idle-compaction", d]);
          return "obsolete";
        },
      },
      { refresh: async (d) => void calls.push(["loopback-refresh", d]) },
    );
    const job = (name: string, data: unknown) => ({ name, data, id: `${name}-1` }) as never;
    await processor.process(job("wait-timeout", { waitId: "w" }), "tok");
    await processor.process(job("sandbox-destroy-for", { deviceIds: ["c1"] }));
    await processor.process(job("sandbox-reset-files", { deviceId: "e1" }));
    await processor.process(job("sandbox-holder-revoke", { deviceId: "e1", token: "t1" }));
    await processor.process(
      job("drift-connector", { orgId: "o", connectorId: "k", trigger: "schedule" }),
    );
    await processor.process(job("directory-sync", { orgId: "o" }));
    await processor.process(job("run-stop", { conversationId: "c4", runId: "r4" }));
    await processor.process(job("bg-wake", { conversationId: "c2" }));
    await processor.process(job("stop-tree", { runId: "r1" }));
    await processor.process(job("stop-tree", { conversationId: "c3", byAccountId: "a1" }));
    await processor.process(job("deliver-to-parent", { childRunId: "r2" }));
    await processor.process(job("owned-plugin-cleanup", { itemId: "i1" }));
    await processor.process(job("automation-fire", { taskRunId: "tr1" }));
    await processor.process(job("automation-settle", { taskRunId: "tr1", check: 2 }));
    const shareObject = { orgId: "o", shareId: "s1", generation: 1, objectKey: "shares/s1/1" };
    await processor.process(job("share-object-delete", shareObject));
    await processor.process(job("blob-delete", { orgId: "o", blobId: "b1" }));
    const staging = { orgId: "o", fileId: "f1", objectKey: "uploads/f1" };
    await processor.process(job("file-staging-delete", staging));
    await processor.process(job("file-release", { orgId: "o", fileId: "f2" }));
    await processor.process(job("file-library-hash", null));
    await processor.process(job("file-library-hash-org", { orgId: "o", after: null }));
    await processor.process(job("file-library-backfill", null));
    const iconObject = { purpose: "app", objectKey: `platform-icons/app-${"a".repeat(64)}.png` };
    await processor.process(job("platform-icon-delete", iconObject));
    await processor.process(job("device-conversation-notice", { orgId: "o", noticeId: "n1" }));
    await processor.process(job("trigger-dispatch", { orgId: "o", eventId: "e1" }));
    const pair = { orgId: "o", automationId: "a1", subjectKey: "item-0123456789abcdef" };
    await processor.process(job("automation-coalesce", pair));
    const idle = {
      orgId: "o",
      conversationId: "c5",
      runId: "r5",
      armedSeq: 9,
      cacheCallSeq: 7,
      expiresAt: 1,
    };
    await processor.process(job("idle-compaction", idle));
    const loopback = { orgId: "o", deviceId: "d1", serviceId: "browser.daemon" };
    await processor.process(job("device-loopback-refresh", loopback));
    await processor.process(job("sandbox-suspend-idle", {}));
    // an unknown name fails (BullMQ retries it, a newer replica knows it), never completes unrun
    await expect(processor.process(job("no-such-job", {}))).rejects.toThrow(
      'unknown maintenance job "no-such-job"',
    );
    expect(calls).toEqual([
      ["wait", { waitId: "w" }, "tok"],
      ["sandbox", "c1"],
      ["reset", "e1"],
      ["revoke-holder", "e1", "t1"],
      ["drift", "o", "k", "schedule"],
      ["directory", { orgId: "o" }],
      ["run-stop", { conversationId: "c4", runId: "r4" }],
      ["wake", "c2"],
      ["stop-children", "r1", null],
      ["stop-descendants", "r1"],
      ["stop-deleted-tree", "c3", "a1"],
      ["deliver", "r2"],
      ["owned-cleanup", "i1"],
      ["automation-fire", "tr1"],
      ["automation-settle", { taskRunId: "tr1", check: 2 }],
      ["share-object-delete", shareObject],
      ["blob-delete", { orgId: "o", blobId: "b1" }],
      ["file-staging-delete", staging],
      ["file-release", { orgId: "o", fileId: "f2" }],
      ["file-library-hash"],
      ["file-library-hash-org", { orgId: "o", after: null }],
      ["file-library-backfill"],
      ["platform-icon-delete", iconObject],
      // the prompt attempt runs on a short device budget
      ["conversation-notice", "o", "n1", 5_000],
      ["trigger-dispatch", { orgId: "o", eventId: "e1" }],
      ["automation-coalesce", pair],
      ["idle-compaction", idle],
      ["loopback-refresh", loopback],
      ["periodic", "sandbox-suspend-idle"],
    ]);
    expect(warned).toEqual([]);
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
  });
});
