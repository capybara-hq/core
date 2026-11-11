import { randomUUID } from "node:crypto";
import {
  createDualReplicaHarness,
  type Harness,
  replicaOf,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { SCHED_SCAN_JOB } from "../../src/schedules/job-ids.js";
import { type ScheduledTaskInsert, ScheduledTaskStore } from "../../src/schedules/store.js";
import type { ScheduledTask, TaskRun } from "../../src/schedules/types.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, sleep, waitFor } from "../helpers/runs.js";

/**
 * Scheduled tasks spec §6, §13 on two replicas (Task 6): both replicas scan at once (the scan's
 * name enqueued on the maintenance queue runs its body with no tick lock, so the row locks and the
 * unique tick key alone keep it exactly once), and a long outage fires one catch-up run and
 * records the missed ticks as one skipped run.
 */

const store = new ScheduledTaskStore();
const HOUR = 3_600_000;
const FIVE_MIN = 5 * 60_000;

let pgc: TestContainer;
let rdc: TestContainer;
let h: Harness;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let maint: Queue;
let cookie = "";
let orgId = "";
let ownerId = "";
let agentId = "";

const at = async (i: 0 | 1, method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${h.replicas[i].port}${path}`, {
    method,
    headers: {
      "x-capybara-csrf": "1",
      ...(cookie !== "" && { cookie }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  expect(replicaOf(res)).toBe(i);
  const text = await res.text();
  return {
    status: res.status,
    json: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>,
  };
};

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  h = await createDualReplicaHarness({
    extensions: [MODEL_FAKE],
    pgUrl: pgc.url,
    redisUrl: rdc.url,
    config: { auth: { cookieSecure: false } },
  });
  raw = createDb(h.dbUrl, 3);
  db = kernelDb(raw);
  redis = new Redis(rdc.url, { maxRetriesPerRequest: null });
  maint = new Queue(MAINTENANCE_QUEUE_NAME, { connection: redis });
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "o" }))
    .id;
  const login = await h.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "x-capybara-csrf": "1", "content-type": "application/json" },
    body: JSON.stringify({ login: "owner", password: PW }),
  });
  expect(login.status).toBe(200);
  await login.body?.cancel();
  cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const org = await at(0, "POST", "/api/v1/orgs", { name: "Acme" });
  orgId = (org.json.org as { id: string }).id;
  const agent = await at(1, "POST", `/api/v1/orgs/${orgId}/agents`, {
    definition: {
      name: "Helper",
      instructions: "Be helpful.",
      model: { provider: "model-fake", model: "fake-1" },
      disabledTools: builtinsOff(),
    },
    visibility: "org",
  });
  expect(agent.status, JSON.stringify(agent.json)).toBe(201);
  agentId = (agent.json.agent as { id: string }).id;
}, 300_000);

afterAll(async () => {
  await maint?.close();
  redis?.disconnect();
  await raw?.destroy();
  await h?.stop();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
}, 120_000);

async function task(over: Partial<ScheduledTaskInsert>): Promise<ScheduledTask> {
  return store.insertTask(db, {
    id: randomUUID(),
    orgId,
    accountId: ownerId,
    agentId,
    name: "Digest",
    prompt: "echo:digest",
    trigger: { kind: "cron", expr: "*/5 * * * *", timeZone: "UTC" },
    mode: "new",
    conversationId: null,
    chat: null,
    model: null,
    effort: null,
    deviceId: null,
    status: "active",
    nextRunAt: null,
    jitterSeconds: 0,
    expiresAt: null,
    ...over,
  });
}

/** Many scans at once, spread over both replicas' maintenance workers. */
async function scanEverywhere(n = 12): Promise<void> {
  const tag = randomUUID().slice(0, 8);
  await Promise.all(
    Array.from({ length: n }, (_, i) =>
      maint.add(SCHED_SCAN_JOB, {}, { jobId: `scan-${tag}-${i}`, removeOnComplete: true }),
    ),
  );
}

const settledRuns = (taskId: string, n: number) =>
  waitFor(
    async () => {
      const runs = await store.listRuns(db, taskId, 50);
      return runs.length >= n && runs.every((r) => r.status !== "pending" && r.status !== "running")
        ? runs
        : null;
    },
    30_000,
    `${n} settled task runs`,
    100,
  );

const kernelRunsOf = async (r: TaskRun) =>
  db.selectFrom("runs").select("id").where("scheduled_task_run_id", "=", r.id).execute();

describe("scheduled task scan on two replicas", { timeout: 120_000 }, () => {
  it("two replicas fire one run per tick", async () => {
    expect(h.replicas.map((r) => r.roles.includes("worker"))).toEqual([true, true]);
    const tick = new Date(Math.floor(Date.now() / FIVE_MIN) * FIVE_MIN);
    const t = await task({ nextRunAt: tick });
    await scanEverywhere();
    const runs = await settledRuns(t.id, 1);
    // later scans on either replica change nothing
    await scanEverywhere();
    await sleep(2_000);
    const after = await store.listRuns(db, t.id, 50);
    expect(after).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "completed", scheduledFor: tick });
    const convs = await db
      .selectFrom("conversations")
      .select("id")
      .where("scheduled_task_id", "=", t.id)
      .execute();
    expect(convs).toHaveLength(1);
    expect(await kernelRunsOf(runs[0] as TaskRun)).toHaveLength(1);
    expect((await store.getTask(db, orgId, t.id))?.nextRunAt?.getTime()).toBe(
      tick.getTime() + FIVE_MIN,
    );
  });

  it("three hours of downtime produce one fired and one skipped run", async () => {
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    const t = await task({
      trigger: { kind: "cron", expr: "0 * * * *", timeZone: "UTC" },
      nextRunAt: new Date(hour - 3 * HOUR),
    });
    await scanEverywhere();
    const runs = await settledRuns(t.id, 2);
    await scanEverywhere();
    await sleep(2_000);
    expect(await store.listRuns(db, t.id, 50)).toHaveLength(2);
    const [fired, skipped] = runs;
    expect(fired).toMatchObject({ status: "completed", scheduledFor: new Date(hour) });
    expect(skipped).toMatchObject({
      status: "skipped",
      skipReason: "missed",
      scheduledFor: new Date(hour - 3 * HOUR),
      firedAt: null,
    });
    expect(await kernelRunsOf(fired as TaskRun)).toHaveLength(1);
    expect((await store.getTask(db, orgId, t.id))?.nextRunAt?.getTime()).toBe(hour + HOUR);
  });
});
