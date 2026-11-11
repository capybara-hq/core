import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { DiscoveryService } from "@nestjs/core";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AdminHealthService, KERNEL_QUEUE_NAMES } from "../../src/admin/health.service.js";
import { ChannelSupervisor } from "../../src/channels/supervisor.js";
import { TITLE_QUEUE } from "../../src/conversations/titles.js";
import { createDb } from "../../src/db/pool.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { PRESENCE_INTERVAL_MS } from "../../src/infra/presence/replica-presence.js";
import { bullConnectionOptions } from "../../src/infra/queue/redis-connection.js";
import { LocalDeviceGateway } from "../../src/local-devices/local-device-gateway.js";
import { RUN_QUEUE_NAME } from "../../src/runtime/run-jobs.js";
import { KERNEL_VERSION } from "../../src/version.js";
import { runConfig, startKernel, type TestKernel, waitFor } from "../helpers/runs.js";
import { seedDevice } from "../helpers/sandbox.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

/**
 * `AdminHealthService.read()` (admin overview spec §4.2, §5.2, §6.2, §9): live replicas by role,
 * kernel queue counts (failedLastDay by the failed set's finishedOn score), channel / device /
 * sandbox counts; Redis not answering degrades only the Redis numbers; never job data.
 */

let pgc: TestContainer;
let rdc: TestContainer;
let raw: Kysely<unknown>;
let redis: Redis;
let k: TestKernel;
const queues: Queue[] = [];

const SECRET = "conversation-secret-payload";
const FAILURE = "failure text quoting user input";

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3) as unknown as Kysely<unknown>;
  redis = new Redis(rdc.url);
  // api + gateway, no worker: the seeded jobs stay where they are
  k = await startKernel(runConfig({ pg: pgc.url, redis: rdc.url }, { roles: ["api", "gateway"] }), {
    overrides: [{ provide: PRESENCE_INTERVAL_MS, useValue: 200 }],
  });
}, 180_000);

afterAll(async () => {
  await Promise.all(queues.map((q) => q.close()));
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

function queue(name: string): Queue {
  const q = new Queue(name, { connection: bullConnectionOptions(rdc.url) });
  queues.push(q);
  return q;
}

// biome-ignore lint/suspicious/noExplicitAny: test databases have no schema types
const db = () => raw as Kysely<any>;

async function seedChannel(
  orgId: string,
  agentId: string,
  createdBy: string,
  status: "active" | "disabled" | "error",
  mode: "long_connection" | "webhook",
  deleted = false,
): Promise<void> {
  await db()
    .withSchema("capybara")
    .insertInto("channel_connections")
    .values({
      id: randomUUID(),
      org_id: orgId,
      plugin: "fake-im",
      name: `c-${randomUUID().slice(0, 8)}`,
      agent_id: agentId,
      config: JSON.stringify({}),
      status,
      inbound_mode: mode,
      created_by: createdBy,
      ...(deleted && { deleted_at: new Date() }),
    })
    .execute();
}

async function seedInstance(
  orgId: string,
  provider: string,
  status: "running" | "suspended" | "destroyed",
): Promise<void> {
  const deviceId = await seedDevice(db(), orgId);
  await sql`INSERT INTO capybara.device_instances (device_id, org_id, provider, status)
    VALUES (${deviceId}, ${orgId}, ${provider}, ${status})`.execute(db());
}

describe("AdminHealthService.read", () => {
  it("answers replicas, queues, channels, devices and sandboxes, counts only", async () => {
    const { accountId, orgId, agentId } = await seedConversation(db());
    // channels: 3 active long connections (2 held), 1 webhook, 1 disabled, 2 error, 1 deleted
    for (let i = 0; i < 3; i++)
      await seedChannel(orgId, agentId, accountId, "active", "long_connection");
    await seedChannel(orgId, agentId, accountId, "active", "webhook");
    await seedChannel(orgId, agentId, accountId, "disabled", "long_connection");
    await seedChannel(orgId, agentId, accountId, "error", "long_connection");
    await seedChannel(orgId, agentId, accountId, "error", "webhook");
    await seedChannel(orgId, agentId, accountId, "active", "long_connection", true);
    // devices: 2 local (1 connected), 1 cloud
    await seedDevice(db(), orgId, undefined, "local");
    await seedDevice(db(), orgId, undefined, "local");
    // sandboxes: docker 2 running + 1 suspended, e2b 1 running, 1 destroyed (not counted)
    await seedInstance(orgId, "sandbox-docker", "running");
    await seedInstance(orgId, "sandbox-docker", "running");
    await seedInstance(orgId, "sandbox-docker", "suspended");
    await seedInstance(orgId, "sandbox-e2b", "running");
    await seedInstance(orgId, "sandbox-e2b", "destroyed");
    // a deleted org's running instance is not counted
    const gone = await seedConversation(db());
    await seedInstance(gone.orgId, "sandbox-docker", "running");
    await sql`UPDATE capybara.orgs SET deleted_at = now() WHERE id = ${gone.orgId}`.execute(db());

    vi.spyOn(k.app.get(ChannelSupervisor), "heldCount").mockReturnValue(2);
    vi.spyOn(k.app.get(LocalDeviceGateway), "connectionCount").mockReturnValue(1);

    // queues: runs 2 waiting + 1 delayed; titles: one failure now, one 25 h ago
    const runs = queue(RUN_QUEUE_NAME);
    await runs.add("run", { conversationId: SECRET });
    await runs.add("run", { conversationId: SECRET });
    await runs.add("run", { conversationId: SECRET }, { delay: 3_600_000 });
    const titles = queue(TITLE_QUEUE);
    const worker = new Worker(
      TITLE_QUEUE,
      async () => {
        throw new Error(FAILURE);
      },
      { connection: bullConnectionOptions(rdc.url) },
    );
    const failedIds: string[] = [];
    worker.on("failed", (job) => {
      if (job?.id) failedIds.push(job.id);
    });
    await titles.add("title", { conversationId: SECRET }, { attempts: 1 });
    await titles.add("title", { conversationId: SECRET }, { attempts: 1 });
    await waitFor(async () => failedIds.length === 2);
    await worker.close();
    // pins the assumption failedLastDay relies on: the failed set's score is finishedOn
    const [old, recent] = failedIds as [string, string];
    const job = await titles.getJob(recent);
    expect(Number(await redis.zscore(titles.toKey("failed"), recent))).toBe(job?.finishedOn);
    // the other one failed 25 h ago
    await redis.zadd(titles.toKey("failed"), Date.now() - 25 * 3_600_000, old);

    const svc = k.app.get(AdminHealthService);
    // the presence beat (200 ms) carries the mocked counts
    const h = await waitFor(async () => {
      const r = await svc.read();
      return r.channels.online === 2 ? r : undefined;
    });

    expect(h.unavailable).toEqual([]);
    expect(h.kernel).toEqual({ version: KERNEL_VERSION });
    expect(h.replicas).toHaveLength(1);
    expect(Object.keys(h.replicas?.[0] ?? {}).sort()).toEqual([
      "httpReplicaId",
      "id",
      "roles",
      "startedAt",
      "version",
    ]);
    expect(h.replicas?.[0]).toMatchObject({ roles: ["api", "gateway"], version: KERNEL_VERSION });
    expect(h.roles).toEqual({ api: 1, worker: 0, gateway: 1 });

    expect(h.queues?.map((q) => q.name)).toEqual([...KERNEL_QUEUE_NAMES]);
    expect(h.queues?.find((q) => q.name === RUN_QUEUE_NAME)).toEqual({
      name: RUN_QUEUE_NAME,
      waiting: 2,
      active: 0,
      delayed: 1,
      failed: 0,
      failedLastDay: 0,
    });
    expect(h.queues?.find((q) => q.name === TITLE_QUEUE)).toMatchObject({
      waiting: 0,
      failed: 2,
      failedLastDay: 1,
    });

    expect(h.channels).toEqual({ online: 2, offline: 1, webhook: 1, disabled: 1, error: 2 });
    expect(h.devices).toEqual({ online: 1, local: 2 });
    expect(h.sandboxes).toEqual({
      running: 3,
      suspended: 1,
      byProvider: [
        { provider: "sandbox-docker", running: 2 },
        { provider: "sandbox-e2b", running: 1 },
      ],
    });

    // no job data, no failure text (spec §9)
    const text = JSON.stringify(h);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(FAILURE);
  }, 60_000);

  it("reads the queue instances their owners registered (no queue connection of its own)", () => {
    const names = k.app
      .get(DiscoveryService)
      .getProviders()
      .map((w) => w.instance)
      .filter((i): i is Queue => i instanceof Queue)
      .map((q) => q.name);
    // the maintenance queue is registered by several modules already; the others exactly once
    for (const name of KERNEL_QUEUE_NAMES.filter((n) => n !== "cap-kernel-maintenance")) {
      expect(
        names.filter((n) => n === name),
        name,
      ).toHaveLength(1);
    }
  });

  it("the database failing: its numbers are null, the Redis numbers stay", async () => {
    const svc = k.app.get(AdminHealthService);
    const spy = vi.spyOn(k.app.get(KernelDb), "db", "get").mockImplementation(() => {
      throw new Error("database down");
    });
    try {
      const h = await svc.read();
      expect(h.unavailable).toEqual(["database"]);
      expect(h.channels).toEqual({
        online: 2,
        offline: null,
        webhook: null,
        disabled: null,
        error: null,
      });
      expect(h.devices).toEqual({ online: 1, local: null });
      expect(h.sandboxes).toBeNull();
      expect(h.replicas).toHaveLength(1);
      expect(h.roles).toEqual({ api: 1, worker: 0, gateway: 1 });
      expect(h.queues).toHaveLength(KERNEL_QUEUE_NAMES.length);
    } finally {
      spy.mockRestore();
    }
  });

  it("Redis not answering: the Redis numbers are null, the database numbers stay", async () => {
    const svc = k.app.get(AdminHealthService);
    const pause = new Redis(rdc.url);
    try {
      // every client but this one waits 5 s (longer than the read's 3 s limit)
      await pause.call("CLIENT", "PAUSE", "5000", "ALL");
      const h = await svc.read();
      expect(h.unavailable).toEqual(["redis"]);
      expect(h.replicas).toBeNull();
      expect(h.roles).toBeNull();
      expect(h.queues).toBeNull();
      expect(h.channels).toEqual({
        online: null,
        offline: null,
        webhook: 1,
        disabled: 1,
        error: 2,
      });
      expect(h.devices).toEqual({ online: null, local: 2 });
      expect(h.sandboxes?.running).toBe(3);
    } finally {
      await pause.call("CLIENT", "UNPAUSE");
      pause.disconnect();
    }
  }, 30_000);
});
