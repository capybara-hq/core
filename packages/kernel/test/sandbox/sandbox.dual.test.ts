import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { RETIRED_SCHEDULER_IDS } from "../../src/runtime/retired-schedulers.js";
import {
  SANDBOX_DESTROY_SCHEDULER_ID,
  SANDBOX_SUSPEND_SCHEDULER_ID,
} from "../../src/sandbox/job-ids.js";
import { SANDBOX_DESTROY_JOB, SANDBOX_SUSPEND_JOB } from "../../src/sandbox/jobs.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import {
  readFakeSandboxOps,
  setFakeSandboxDelays,
} from "../fixtures/plugins/sandbox-fake/index.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * 两个内核副本（同一进程里的两个独立 Kernel：各自的 PG 池、Redis 连接、插件实例；共享 PG / Redis 与
 * 假沙箱的「提供方后端」目录）同时首次使用同一对话的沙箱：只创建一个，另一边等锁后复用（审查重点 2）。
 *
 * 沙箱服务在 T7 还没有 HTTP 入口（T8 才有工具），所以不用子进程 harness，而是在同一进程里起两个 Kernel；
 * 服务本身没有进程内状态，两个实例之间只经 PG / Redis 协调，与两个进程等价。
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rdc: TestContainer;
let root: string;
const kernels: TestKernel[] = [];
let raw: ReturnType<typeof createDb>;

const cfg = (plugins: string[], roles: string[] = ["api"]) =>
  KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 5 },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    roles,
    extensions: plugins,
    extensionConfig: { "sandbox-fake": { root } },
    extensionPermissions: { autoApprove: true },
  });

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-dual-"));
  raw = createDb(pgc.url, 2);
}, 120_000);

afterAll(async () => {
  for (const k of kernels) await k.close();
  await raw?.destroy();
  await rm(root, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

async function seedConversation(): Promise<{ orgId: string; conversationId: string }> {
  const accountId = randomUUID();
  const orgId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'U')`.execute(
    raw,
  );
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${orgId}, ${`o-${orgId.slice(0, 8)}`}, 'O', ${accountId})`.execute(raw);
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agentId}, ${orgId}, ${accountId}, 'org', 1)`.execute(raw);
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${conversationId}, ${orgId}, ${agentId}, ${accountId})`.execute(raw);
  return { orgId, conversationId };
}

describe("沙箱（两个副本）", () => {
  it("两个副本同时首次使用同一对话：只创建一个沙箱，两边拿到同一个句柄", async () => {
    const [k1, k2] = await Promise.all([
      startKernel(cfg([SANDBOX_FAKE], ["api", "worker"])),
      startKernel(cfg([SANDBOX_FAKE])),
    ]);
    kernels.push(k1, k2);
    expect(k1.app.get(SandboxService).available).toBe(true);
    expect(k2.app.get(SandboxService).available).toBe(true);
    const ctx = await seedConversation();
    await setFakeSandboxDelays(root, { create: 300 });

    const use = (k: TestKernel) =>
      k.app
        .get(SandboxService)
        .withSandbox(ctx, async (h, _p, info) => ({ h, info }), AbortSignal.timeout(30_000));
    const [a, b] = await Promise.all([use(k1), use(k2)]);
    expect(a.h).toEqual(b.h);
    expect([a.info.fresh, b.info.fresh].sort()).toEqual([false, true]);
    expect((await readFakeSandboxOps(root)).filter((o) => o[0] === "create")).toHaveLength(1);
    const rows = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM capybara.sandboxes`.execute(raw);
    expect(rows.rows[0]?.n).toBe(1);
  });

  it("两个扫描是 @LockedCron 任务（每分钟 / 每小时）；旧的 job scheduler 已退役（名字不含 `:`）", async () => {
    // the worker kernel of the first case (crons instead of maintenance schedulers)
    const registry = kernels[0]?.app.get(SchedulerRegistry);
    if (!registry) throw new Error("the worker kernel of the first case is missing");
    expect(String(registry.getCronJob(SANDBOX_SUSPEND_JOB).cronTime.source)).toBe("* * * * *");
    expect(String(registry.getCronJob(SANDBOX_DESTROY_JOB).cronTime.source)).toBe("0 * * * *");
    expect(RETIRED_SCHEDULER_IDS).toEqual(
      expect.arrayContaining([SANDBOX_SUSPEND_SCHEDULER_ID, SANDBOX_DESTROY_SCHEDULER_ID]),
    );
    const q = new Queue(MAINTENANCE_QUEUE_NAME, {
      connection: new Redis(rdc.url, { maxRetriesPerRequest: null }),
    });
    try {
      const ids = (await q.getJobSchedulers()).map((s) => s.key);
      expect(ids).not.toContain(SANDBOX_SUSPEND_SCHEDULER_ID);
      expect(ids).not.toContain(SANDBOX_DESTROY_SCHEDULER_ID);
      for (const id of [
        SANDBOX_SUSPEND_SCHEDULER_ID,
        SANDBOX_DESTROY_SCHEDULER_ID,
        SANDBOX_SUSPEND_JOB,
        SANDBOX_DESTROY_JOB,
      ]) {
        expect(id).not.toContain(":");
      }
    } finally {
      await q.close();
    }
  });

  it("没有装沙箱插件的内核：available 为 false，使用时 503 sandbox.unavailable", async () => {
    const k = await startKernel(cfg([]));
    kernels.push(k);
    expect(k.app.get(SandboxService).available).toBe(false);
    const ctx = await seedConversation();
    const err = await k.app
      .get(SandboxService)
      .withSandbox(ctx, async () => 1, AbortSignal.timeout(5000))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect((err as ApiError).code).toBe("sandbox.unavailable");
  });
});
