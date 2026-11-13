import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppendEvent } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { PLUGINS_CHANGED_TOPIC } from "../../src/extensions/lifecycle-topics.js";
import {
  USAGE_SUBSCRIBERS_CLOCK,
  USAGE_SUBSCRIBERS_TTL_MS,
  UsageSubscribers,
} from "../../src/extensions/usage-subscribers.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { KERNEL_BUS } from "../../src/infra/tokens.js";
import type { KernelOverride } from "../../src/overrides.js";
import { StepLog } from "../../src/runtime/step-log.js";
import {
  modelUsageJobId,
  USAGE_REPORT_QUEUE,
  usageReportJobId,
} from "../../src/runtime/usage-report.js";
import { embedConsumer } from "../fixtures/plugins/embed-consumer/index.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { drainOutbox } from "../helpers/outbox.js";
import {
  createAgent,
  createConv,
  createOrg,
  enableExtensions,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Transactional outbox spec §8.1: a `usage.report` delivery is owed in the transaction that writes
 * the usage it reports (a `usage` event or a `model_usage` row), only while the deployment has a
 * subscriber (`UsageSubscribers`, read from PG, cached per replica for 30 s, cleared on
 * `PLUGINS_CHANGED`). Every kernel's queue adds to `cap-kernel-usage-report` fail while
 * `failUsage` is set (the `OUTBOX_DISPATCH_FAILS` seam): the fast path delivers nothing, and the
 * owed row is delivered by a relay pass (`OutboxDispatcher.dispatchDue`) once it is cleared. The
 * background relay (`OutboxRelay`, every 2 s on each worker kernel) runs alongside the explicit
 * passes, so a test that expects a row delivered waits for it ({@link relayUntilSent}).
 */

const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const PURPOSE = "embed-consumer.memory";
const PROBE = { model: { provider: "model-embed-probe", model: "probe-embed" }, params: {} };

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let usageQueue: Queue;
/** While true, every kernel's outbox adds to the usage report queue fail. */
let failUsage = true;
/** Added to the subscriber cache's clock of the kernels started with {@link seams}. */
let clockShift = 0;
let orgId: string;
let agentId: string;
/**
 * The usage events written while no plugin subscribed (never reported). Filled by the "no
 * subscriber, then one" describe and read by the last test of "a subscriber is enabled": the two
 * describes run in file order and share the kernels, so they are not independent.
 */
let unreported: { conv: string; seq: number }[] = [];

const urls = () => ({ pg: pgc.url, redis: rd.url });
const seams = (): { overrides: KernelOverride[] } => ({
  overrides: [
    {
      provide: OUTBOX_DISPATCH_FAILS,
      useValue: (queue) => failUsage && queue === USAGE_REPORT_QUEUE,
    },
    { provide: USAGE_SUBSCRIBERS_CLOCK, useValue: () => Date.now() + clockShift },
  ],
});

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  redis = new Redis(rd.url, { maxRetriesPerRequest: null });
  usageQueue = new Queue(USAGE_REPORT_QUEUE, { connection: redis });
});

afterAll(async () => {
  await usageQueue?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** The owed usage report rows, oldest first. */
const owed = () =>
  db
    .selectFrom("outbox")
    .select(["queue", "job_name", "job_id", "data", "org_id"])
    .where("job_name", "=", "usage-report")
    .orderBy("created_at")
    .orderBy("id")
    .execute();

/** The owed usage report rows of one conversation's events. */
const owedOf = async (conv: string) =>
  (await owed()).filter((r) => (r.data as { conversationId?: string }).conversationId === conv);

/**
 * One relay pass of `k` over the owed usage report rows (their backoff from failed passes reset),
 * waiting until they are delivered (another kernel's pass may hold some: {@link drainOutbox}).
 */
async function relay(k: TestKernel): Promise<void> {
  await db
    .updateTable("outbox")
    .set({ next_attempt_at: sql<Date>`now()` as unknown as Date })
    .where("job_name", "=", "usage-report")
    .execute();
  await drainOutbox(k.app, { jobName: "usage-report" });
}

/**
 * Relay passes of `k` until the row of `jobId` is no longer owed (bounded). One pass does not
 * settle the table: the background relay may hold the row (the explicit pass skips locked rows,
 * and the row stays until that pass commits), or record the failure of a pass it began while
 * `failUsage` was set after {@link relay} reset the backoff, leaving the row not yet due.
 */
async function relayUntilSent(k: TestKernel, jobId: string): Promise<void> {
  await waitFor(
    async () => {
      await relay(k);
      return !(await owed()).some((r) => r.job_id === jobId);
    },
    15_000,
    `outbox row ${jobId} relayed`,
    100,
  );
}

/** A usage event written through the step writes of `k` (the site the model call uses). */
async function writeUsage(k: TestKernel, conv: string, key: string): Promise<ConversationEvent> {
  const event: AppendEvent = {
    type: "usage",
    idemKey: `usage_test:${key}`,
    payload: {
      step: 0,
      provider: "model-fake",
      model: "fake-1",
      inputTokens: 3,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  };
  const { written } = await k.app.get(StepLog).appendReported(conv, [event]);
  const [e] = written;
  if (!e) throw new Error("usage not appended");
  return e;
}

/** A subscriber in deployment state only: an approved manifest with the hook, declared by config. */
async function ghostSubscriber(on: boolean): Promise<void> {
  if (!on) {
    await db.deleteFrom("extension_replica_status").where("plugin", "=", "ghost").execute();
    await db.deleteFrom("extension_permission_snapshots").where("plugin", "=", "ghost").execute();
    return;
  }
  await db
    .insertInto("extension_permission_snapshots")
    .values({
      plugin: "ghost",
      version: "1.0.0",
      permissions: JSON.stringify({ permissions: { hooks: ["usage.report"] } }),
      source: "auto",
    })
    .execute();
  await db
    .insertInto("extension_replica_status")
    .values({
      replica_id: "replica-ghost",
      plugin: "ghost",
      version: "1.0.0",
      sha256: null,
      source: "config",
      state: "loaded",
      reason: null,
      detail: null,
      http_replica_id: null,
    })
    .execute();
}

describe("no subscriber, then one", () => {
  let plain: TestKernel;
  let owner: Req;

  beforeAll(async () => {
    plain = await startKernel(
      runConfig(urls(), { roles: ["api", "worker"], extensions: [MODEL_FAKE] }),
      seams(),
    );
    // the first kernel migrated the database; the account serves every kernel of the file
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
    owner = await session(plain, "owner");
    orgId = await createOrg(owner);
    agentId = await createAgent(owner, orgId);
  });

  afterAll(async () => {
    await plain?.close();
    await ghostSubscriber(false);
    await db.deleteFrom("outbox").where("job_name", "=", "usage-report").execute();
  });

  it("no outbox row is written while no plugin subscribes", async () => {
    expect(plain.app.get(ExtensionHost).hooks.has("usage.report")).toBe(false);
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "echo:nobody meters this");
    await waitForTerminal(db, conv, 1, 20_000);
    const usage = (await eventsOf(db, conv)).filter((e) => e.type === "usage");
    expect(usage.length).toBeGreaterThan(0);
    unreported = usage.map((e) => ({ conv, seq: e.seq }));
    expect(await owed()).toEqual([]);
  });

  it("enabling a subscriber makes the next event owed within 30 s", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const subs = plain.app.get(UsageSubscribers);
    expect(await subs.any()).toBe(false);
    await ghostSubscriber(true);
    // this replica still has "no subscriber" cached (no PLUGINS_CHANGED was published)
    const early = await writeUsage(plain, conv, "early");
    expect(await owedOf(conv)).toEqual([]);
    unreported.push({ conv, seq: early.seq });
    // once the cache is older than 30 s the next event reads PG again and is owed
    clockShift += USAGE_SUBSCRIBERS_TTL_MS + 1000;
    const next = await writeUsage(plain, conv, "next");
    expect(await owedOf(conv)).toEqual([
      {
        queue: USAGE_REPORT_QUEUE,
        job_name: "usage-report",
        job_id: usageReportJobId(conv, next.seq),
        data: { conversationId: conv, seq: next.seq },
        org_id: orgId,
      },
    ]);
    // PLUGINS_CHANGED clears the cache at once: the subscriber's removal counts for the next event
    await ghostSubscriber(false);
    expect(await subs.any()).toBe(true);
    await plain.app.get(KERNEL_BUS).publish(PLUGINS_CHANGED_TOPIC, { plugin: "ghost" });
    await waitFor(async () => !(await subs.any()), 5_000, "the cache cleared by PLUGINS_CHANGED");
    const after = await writeUsage(plain, conv, "after");
    unreported.push({ conv, seq: after.seq });
    expect((await owedOf(conv)).map((r) => r.job_id)).toEqual([usageReportJobId(conv, next.seq)]);
  });
});

describe("a subscriber is enabled", () => {
  let sub: TestKernel;
  let owner: Req;

  beforeAll(async () => {
    failUsage = true;
    sub = await startKernel(
      runConfig(urls(), {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, fx("usage-b"), fx("model-embed-probe"), fx("embed-consumer")],
      }),
      seams(),
    );
    owner = await session(sub, "owner");
    await enableExtensions(raw, orgId, "usage-b", "embed-consumer");
  });

  afterAll(async () => {
    await sub?.close();
  });

  async function seenB(id: string): Promise<number> {
    const res = await owner({ method: "GET", url: `/plugins/usage-b/seen?eventId=${id}` });
    return (res.json() as { calls: number }).calls;
  }

  it("a usage event is reported with the fast path disabled", async () => {
    failUsage = true;
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "echo:metered");
    await waitForTerminal(db, conv, 1, 20_000);
    const step = (await eventsOf(db, conv)).find(
      (e) => e.type === "usage" && (e.payload as { purpose?: string }).purpose === undefined,
    );
    if (!step) throw new Error("no step usage event");
    const jobId = usageReportJobId(conv, step.seq);
    // committed with the event; the fast path's add failed, so the row is still owed
    const row = (await owed()).find((r) => r.job_id === jobId);
    expect(row).toEqual({
      queue: USAGE_REPORT_QUEUE,
      job_name: "usage-report",
      job_id: jobId,
      data: { conversationId: conv, seq: step.seq },
      org_id: orgId,
    });
    expect(await usageQueue.getJob(jobId)).toBeUndefined();
    failUsage = false;
    await relayUntilSent(sub, jobId);
    const id = `${conv}/${step.seq}`;
    await waitFor(async () => (await seenB(id)) === 1, 15_000, "usage-b delivery");
  });

  it("an embedding's model_usage row is reported with the fast path disabled", async () => {
    failUsage = true;
    const res = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/model-purposes/${encodeURIComponent(PURPOSE)}`,
      payload: { target: PROBE },
    });
    expect(res.statusCode, res.body).toBe(200);
    const c = embedConsumer().ctx;
    if (!c) throw new Error("embed-consumer is not set up");
    await c.models.embed({ orgId, purpose: PURPOSE, input: ["t1", "t2"] });
    const row = await db
      .selectFrom("model_usage")
      .select(["id", "reported_at"])
      .where("org_id", "=", orgId)
      .executeTakeFirstOrThrow();
    const jobId = modelUsageJobId(row.id);
    expect((await owed()).find((r) => r.job_id === jobId)).toEqual({
      queue: USAGE_REPORT_QUEUE,
      job_name: "usage-report",
      job_id: jobId,
      data: { usageId: row.id },
      org_id: orgId,
    });
    failUsage = false;
    await relayUntilSent(sub, jobId);
    await waitFor(async () => (await seenB(row.id)) === 1, 15_000, "usage-b delivery");
    await waitFor(
      async () =>
        (
          await db
            .selectFrom("model_usage")
            .select("reported_at")
            .where("id", "=", row.id)
            .executeTakeFirstOrThrow()
        ).reported_at !== null,
      10_000,
      "reported_at",
    );
  });

  it("events written while no plugin subscribed are not reported later", async () => {
    failUsage = false;
    expect(unreported.length).toBeGreaterThan(1);
    await relay(sub);
    for (const { conv, seq } of unreported) {
      expect(await usageQueue.getJob(usageReportJobId(conv, seq))).toBeUndefined();
      expect(await seenB(`${conv}/${seq}`)).toBe(0);
      expect((await owedOf(conv)).map((r) => r.job_id)).not.toContain(usageReportJobId(conv, seq));
    }
  });

  it("a replica without the handler still owes the row and another replica delivers it", async () => {
    failUsage = true;
    const bare = await startKernel(
      runConfig(urls(), { roles: ["api", "worker"], extensions: [MODEL_FAKE] }),
      seams(),
    );
    try {
      expect(bare.app.get(ExtensionHost).hooks.has("usage.report")).toBe(false);
      const conv = await createConv(owner, orgId, agentId);
      const e = await writeUsage(bare, conv, "bare");
      const jobId = usageReportJobId(conv, e.seq);
      expect((await owedOf(conv)).map((r) => r.job_id)).toEqual([jobId]);
      failUsage = false;
      await relayUntilSent(bare, jobId);
      expect(await owedOf(conv)).toEqual([]);
      await waitFor(async () => (await seenB(`${conv}/${e.seq}`)) === 1, 30_000, "delivered");
    } finally {
      await bare.close();
    }
  });
});
