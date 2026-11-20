import { randomUUID } from "node:crypto";
import type { PushMessage } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { Job, Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { ReplicaStatusStore } from "../../src/extensions/sources.js";
import type { Account } from "../../src/identity/accounts.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OutboxService } from "../../src/infra/outbox/outbox.service.js";
import { createLogger } from "../../src/log.js";
import { PUSH_SEND_TIMEOUT_MS } from "../../src/push/delivery.js";
import {
  conversationEventId,
  PUSH_DELIVER_JOB,
  PUSH_QUEUE,
  type PushDeliverData,
  pushDeliverJobId,
} from "../../src/push/jobs.js";
import { PushTokenStore } from "../../src/push/token-store.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { PW, startKernel, type TestKernel, waitFor } from "../helpers/runs.js";

/**
 * Push delivery on `cap-push-deliver` (mobile app spec §9.4, plan task C6): one `push-deliver`
 * job per event and registration, owed through the outbox, sending through the provider the
 * registration names (the `fake-push` fixture, scripted by token prefix). Retries back off from
 * 10 s; the test promotes a delayed job instead of waiting the backoff out.
 */

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let alice: Account;
let queue: Queue<PushDeliverData>;
/** The send time limit the kernel reads at every send (the hang case shortens it). */
let sendTimeoutMs = 15_000;
/** Every log record the kernel wrote, as JSON lines. */
const lines: string[] = [];

/** The fake's in-process record of send attempts (`fakePushProbe()` of the fixture). */
function sends(): { registrationId: string; token: string; message: PushMessage }[] {
  const g = globalThis as {
    __fakePush?: { sends: { registrationId: string; token: string; message: PushMessage }[] };
  };
  g.__fakePush ??= { sends: [] };
  return g.__fakePush.sends;
}
const sendsTo = (registrationId: string) =>
  sends().filter((s) => s.registrationId === registrationId);

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      extensions: [fakeExtensionEntry("fake-push")],
      extensionPermissions: { autoApprove: true },
    }),
    {
      env: {},
      logger: createLogger("debug", { write: (l) => lines.push(l) }),
      overrides: [{ provide: PUSH_SEND_TIMEOUT_MS, useValue: () => sendTimeoutMs }],
    },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  queue = k.app.get<Queue<PushDeliverData>>(getQueueToken(PUSH_QUEUE), { strict: false });
});
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.platform_notices");
  sendTimeoutMs = 15_000;
  alice = await accountsFor(db).createLocal({ login: "alice", password: PW, displayName: "A" });
});

const message: PushMessage = {
  title: "Helper",
  body: "finished",
  path: "/chat/c1?org=o1",
  threadId: "c1",
  collapseId: "conv-c1-1",
  origin: "http://localhost:3000",
};

/** Inserts a registration with a sealed `token`; returns its id. */
async function register(
  token: string,
  opts: { appId?: string; provider?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const sealed = k.app.get(PushTokenStore).seal(id, token);
  await db
    .insertInto("push_registrations")
    .values({
      id,
      account_id: alice.id,
      session_id: null,
      platform: "ios",
      app_id: opts.appId ?? "com.example.app",
      provider: opts.provider ?? "fake-push",
      token_hash: sealed.tokenHash,
      master_key_id: sealed.masterKeyId,
      token_ciphertext: sealed.ciphertext,
      locale: "en",
      device_name: "Phone",
    })
    .execute();
  return id;
}

/** Owes one delivery through the outbox in a transaction of its own; returns its job id. */
async function owe(registrationId: string, eventId = conversationEventId(randomUUID(), 1)) {
  const jobId = pushDeliverJobId(eventId, registrationId);
  await k.app.get(TransactionHost).run(async () => {
    await k.app.get(OutboxService).add<PushDeliverData>({
      queue: PUSH_QUEUE,
      name: PUSH_DELIVER_JOB,
      jobId,
      data: { eventId, registrationId, message },
    });
  });
  return { jobId, eventId };
}

/**
 * Waits until the job is completed or failed for good, promoting it whenever it waits out a retry
 * backoff (the registry's 10 s doubling). The job is read again once its state is final.
 */
async function settled(jobId: string): Promise<Job<PushDeliverData>> {
  return waitFor(
    async () => {
      const job = await queue.getJob(jobId);
      if (job === undefined) return null;
      const state = await job.getState();
      if (state === "delayed") {
        await job.promote().catch(() => {});
        return null;
      }
      if (state !== "completed" && state !== "failed") return null;
      // read again: the snapshot above may predate the finish (no return value, attempts behind)
      return (await queue.getJob(jobId)) ?? null;
    },
    30_000,
    `push job ${jobId} settled`,
  );
}

const registrationExists = async (id: string) =>
  (await db.selectFrom("push_registrations").select("id").where("id", "=", id).execute()).length ===
  1;

const authNotices = () =>
  db
    .selectFrom("platform_notices")
    .select(["detail", "dismissed_at"])
    .where("kind", "=", "push_auth_failed")
    .execute();

describe("push delivery", () => {
  it("sends the opened token once through the registration's provider: delivered", async () => {
    const id = await register("plain-token-Qx7");
    const { jobId } = await owe(id);
    const job = await settled(jobId);
    expect(await job.getState()).toBe("completed");
    expect(job.returnvalue).toBe("delivered");
    expect(job.attemptsMade).toBe(1);
    expect(sendsTo(id)).toEqual([{ registrationId: id, token: "plain-token-Qx7", message }]);
    expect(await registrationExists(id)).toBe(true);
  });

  it("deletes a registration whose token the provider reports dead", async () => {
    const id = await register("dead:tok");
    const job = await settled((await owe(id)).jobId);
    expect(job.returnvalue).toBe("unregistered");
    expect(await registrationExists(id)).toBe(false);
  });

  it("completes on an auth failure with one platform notice per plugin while it is open", async () => {
    const a = await register("auth:one");
    const b = await register("auth:two");
    const first = await settled((await owe(a)).jobId);
    expect(await first.getState()).toBe("completed");
    expect(first.returnvalue).toBe("auth");
    expect(await authNotices()).toEqual([{ detail: { plugin: "fake-push" }, dismissed_at: null }]);
    expect((await settled((await owe(b)).jobId)).returnvalue).toBe("auth");
    expect(await authNotices()).toHaveLength(1);
    // the registration stays: the credentials are wrong, not the token
    expect(await registrationExists(a)).toBe(true);
    // once dismissed, the next auth failure tells the platform again
    await db
      .updateTable("platform_notices")
      .set({ dismissed_at: sql<Date>`now()` })
      .where("kind", "=", "push_auth_failed")
      .execute();
    expect((await settled((await owe(a)).jobId)).returnvalue).toBe("auth");
    expect((await authNotices()).filter((n) => n.dismissed_at === null)).toHaveLength(1);
  });

  it("retries a transient failure: two failed attempts, then delivered, three sends", async () => {
    const id = await register("flaky:2:tok");
    const job = await settled((await owe(id)).jobId);
    expect(await job.getState()).toBe("completed");
    expect(job.returnvalue).toBe("delivered");
    expect(job.attemptsMade).toBe(3);
    expect(sendsTo(id)).toHaveLength(3);
  });

  it("gives up on a rate limit after 5 attempts and keeps the registration", async () => {
    const id = await register("rate:tok");
    const job = await settled((await owe(id)).jobId);
    expect(await job.getState()).toBe("failed");
    expect(job.attemptsMade).toBe(5);
    expect(sendsTo(id)).toHaveLength(5);
    expect(await registrationExists(id)).toBe(true);
  });

  it("drops the job without a send when the registration is gone", async () => {
    const job = await settled((await owe(randomUUID())).jobId);
    expect(await job.getState()).toBe("completed");
    expect(job.returnvalue).toBe("dropped");
  });

  it("drops without a send, keeping the registration, when its provider is not enabled", async () => {
    const id = await register("plain-gone", { provider: "push-gone" });
    const job = await settled((await owe(id)).jobId);
    expect(job.returnvalue).toBe("dropped");
    expect(sendsTo(id)).toHaveLength(0);
    expect(await registrationExists(id)).toBe(true);
  });

  it("drops without a send, keeping the registration, when the provider no longer covers the app", async () => {
    const id = await register("plain-other", { appId: "com.other.app" });
    const job = await settled((await owe(id)).jobId);
    expect(job.returnvalue).toBe("dropped");
    expect(sendsTo(id)).toHaveLength(0);
    expect(await registrationExists(id)).toBe(true);
  });

  it("aborts a send past the time limit and retries it", async () => {
    sendTimeoutMs = 50;
    const id = await register("hang:tok");
    const job = await settled((await owe(id)).jobId);
    expect(await job.getState()).toBe("failed");
    expect(job.attemptsMade).toBe(5);
    expect(job.failedReason).toContain("timed out");
    expect(sendsTo(id)).toHaveLength(5);
    expect(await registrationExists(id)).toBe(true);
  });

  it("never puts the token in a log line, the job data or a failure reason", async () => {
    const tokens = ["plain-Secret-Zr81", "flaky:1:Secret-Wq52", "throw:Secret-Lk33"];
    const ids = await Promise.all(tokens.map((t) => register(t)));
    const jobs = await Promise.all(ids.map(async (id) => settled((await owe(id)).jobId)));
    const stored = await Promise.all(
      jobs.map(async (j) => JSON.stringify(await redis.hgetall(`bull:${PUSH_QUEUE}:${j.id}`))),
    );
    for (const t of tokens) {
      expect(lines.join("\n")).not.toContain(t);
      for (const s of stored) expect(s).not.toContain(t);
      for (const j of jobs) expect(j.failedReason ?? "").not.toContain(t);
    }
    // the plain throw is retried like a transient failure
    expect(jobs[2]?.attemptsMade).toBe(5);
  });

  it("sends once when the same delivery is owed twice (the finished job is kept a day)", async () => {
    const id = await register("plain-twice");
    const eventId = conversationEventId(randomUUID(), 7);
    const { jobId } = await owe(id, eventId);
    await settled(jobId);
    await owe(id, eventId);
    // the second add is swallowed by the kept job: the owed row goes, no second send
    await waitFor(
      async () =>
        (await db.selectFrom("outbox").select("id").where("job_id", "=", jobId).execute())
          .length === 0,
      10_000,
      "the second owed row delivered",
    );
    expect((await queue.getJob(jobId))?.attemptsMade).toBe(1);
    expect(sendsTo(id)).toHaveLength(1);
  });

  it("retries while another live replica reports the absent provider loaded (a rolling deploy)", async () => {
    await db
      .insertInto("extension_replica_status")
      .values({
        replica_id: "other-replica",
        plugin: "push-later",
        version: "1.0.0",
        sha256: null,
        source: "config",
        state: "loaded",
        reason: null,
        detail: null,
        http_replica_id: null,
        heartbeat_at: sql<Date>`now()`,
      })
      .execute();
    const id = await register("plain-later", { provider: "push-later" });
    const { jobId } = await owe(id);
    // the first attempt fails and waits out its backoff (not promoted here)
    const retried = await waitFor(
      async () => {
        const job = await queue.getJob(jobId);
        return job !== undefined && (await job.getState()) === "delayed" ? job : null;
      },
      10_000,
      "the first attempt retried",
    );
    expect(retried.attemptsMade).toBe(1);
    expect(retried.failedReason).toContain("not loaded on this replica");
    expect(await registrationExists(id)).toBe(true);
    // the other replica is gone: the next attempt drops it
    await db
      .deleteFrom("extension_replica_status")
      .where("replica_id", "=", "other-replica")
      .execute();
    const job = await settled(jobId);
    expect(job.returnvalue).toBe("dropped");
    expect(await registrationExists(id)).toBe(true);
  });

  it("drops without a send, keeping the registration, when fake-push is unloaded here (its own status row aside)", async () => {
    const host = k.app.get(ExtensionHost);
    const id = await register("plain-unloaded");
    await host.unload("fake-push");
    // this replica's own row still claiming `loaded` (a heartbeat racing the unload) must not
    // count as another replica serving it
    await db
      .updateTable("extension_replica_status")
      .set({ state: "loaded", heartbeat_at: sql<Date>`now()` })
      .where("replica_id", "=", k.app.get(ReplicaStatusStore).replicaId)
      .where("plugin", "=", "fake-push")
      .execute();
    try {
      const job = await settled((await owe(id)).jobId);
      expect(job.returnvalue).toBe("dropped");
      expect(job.attemptsMade).toBe(1);
      expect(sendsTo(id)).toHaveLength(0);
      expect(await registrationExists(id)).toBe(true);
    } finally {
      await host.reload("fake-push");
    }
  });
});
