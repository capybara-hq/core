import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { RUN_QUEUE_NAME } from "../../src/runtime/run-queue.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createAgent,
  createConv,
  createOrg,
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
 * Manual compaction on two replicas (context compaction spec §4.7/§4.12): the compact run is
 * claimed under the conversation row lock, so concurrent requests on both replicas start one run
 * and write one `compaction_summary`, never two.
 */

let pgc: TestContainer;
let rd: TestContainer;
let a: TestKernel;
let b: TestKernel;
let rawA: ReturnType<typeof createDb>;
let rawB: ReturnType<typeof createDb>;
let dbA: KernelSchemaDb;
let redis: Redis;
let runQueue: Queue;
let ownerA: Req;
let ownerB: Req;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  rawA = createDb(pgc.url, 3);
  rawB = createDb(pgc.url, 3);
  dbA = kernelDb(rawA);
  const cfg = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] });
  a = await startKernel(cfg);
  b = await startKernel(cfg);
  redis = new Redis(rd.url);
  runQueue = new Queue(RUN_QUEUE_NAME, { connection: new Redis(rd.url) });
  await accountsFor(dbA).createLocal({ login: "owner", password: PW, displayName: "O" });
  ownerA = await session(a, "owner");
  ownerB = await session(b, "owner");
  orgId = await createOrg(ownerA);
  agentId = await createAgent(ownerA, orgId);
}, 180_000);
afterAll(async () => {
  await Promise.all([a?.close(), b?.close()]);
  await runQueue?.close();
  redis?.disconnect();
  await Promise.all([rawA?.destroy(), rawB?.destroy()]);
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const compactUrl = (conv: string) => `/api/v1/orgs/${orgId}/conversations/${conv}/compact`;

describe("manual compaction on two replicas", { timeout: 120_000 }, () => {
  it("concurrent requests to both replicas claim one compact run and write one summary", async () => {
    const conv = await createConv(ownerA, orgId, agentId);
    for (let i = 0; i < 5; i++) {
      await postMessage(ownerA, orgId, conv, `echo:turn ${i} ${"words ".repeat(40)}`);
      await waitForTerminal(dbA, conv, i + 1, 20_000);
    }
    // the queue paused: both requests see the same queued compact run instead of racing its end
    await runQueue.pause();
    try {
      const requests = Array.from({ length: 8 }, (_, i) =>
        (i % 2 === 0 ? ownerA : ownerB)({ method: "POST", url: compactUrl(conv), payload: {} }),
      );
      const responses = await Promise.all(requests);
      for (const r of responses) expect(r.statusCode, r.body).toBe(202);
      const ids = new Set(responses.map((r) => (r.json() as { runId: string }).runId));
      expect(ids.size).toBe(1);
    } finally {
      await runQueue.resume();
    }
    await waitFor(
      async () => {
        const rows = await dbA
          .selectFrom("runs")
          .select(["status", "compact"])
          .where("conversation_id", "=", conv)
          .execute();
        const compactRuns = rows.filter((r) => r.compact);
        return compactRuns.length === 1 && compactRuns[0]?.status === "completed" ? rows : null;
      },
      40_000,
      "the compact run completed",
    );
    const events = await eventsOf(dbA, conv);
    const summaries = events.filter(
      (e): e is ConversationEvent & { type: "compaction_summary" } =>
        e.type === "compaction_summary",
    );
    expect(summaries).toHaveLength(1);
    const usage = events.filter(
      (e) => e.type === "usage" && (e.payload as { purpose?: string }).purpose === "compaction",
    );
    expect(usage).toHaveLength(1);
  });
});
