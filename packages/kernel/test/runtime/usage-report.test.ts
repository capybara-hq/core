import { fileURLToPath } from "node:url";
import type { UsageReportPayload } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import {
  USAGE_REPORT_QUEUE,
  UsageReporter,
  usageReportJobId,
} from "../../src/runtime/usage-report.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  sleep,
  startKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * T16: `usage.report` metering through queue `cap-kernel-usage-report` (F11, P-17): one job per `usage`
 * event, payload read from the log at execution time, per-plugin retries, delivery only to plugins
 * the organization enabled.
 */

const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const TOOL = "hooks-probe__probe_echo";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let k: Kernel;
let owner: Req;
let orgId: string;
let agentId: string;
let queueConn: Redis;
let queue: Queue;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api", "worker"], plugins: [MODEL_FAKE, fx("hooks-probe"), fx("usage-b")] },
    ),
  );
  await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await enable("hooks-probe", true);
  await enable("usage-b", true);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Metered",
        instructions: "Use tools.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "plugin", plugin: "hooks-probe", name: "probe_echo" }],
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
  queueConn = new Redis(rd.url, { maxRetriesPerRequest: null });
  queue = new Queue(USAGE_REPORT_QUEUE, { connection: queueConn });
}, 180_000);

afterAll(async () => {
  await queue?.close();
  queueConn?.disconnect();
  await k?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function enable(plugin: string, enabled: boolean): Promise<void> {
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/plugins/${plugin}`,
    payload: { enabled },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function probe(cfg: Record<string, unknown>): Promise<void> {
  const res = await owner({
    method: "POST",
    url: "/plugins/hooks-probe/config",
    payload: { orgId, ...cfg },
  });
  expect(res.statusCode, res.body).toBe(200);
}

type Delivery = { calls: number; last: UsageReportPayload | null; holder: string | null };

async function probeUsage(ids: string[]): Promise<Record<string, Delivery>> {
  const res = await owner({ method: "GET", url: `/plugins/hooks-probe/usage?eventIds=${ids}` });
  return res.json() as Record<string, Delivery>;
}

async function seenB(id: string): Promise<number> {
  const res = await owner({ method: "GET", url: `/plugins/usage-b/seen?eventId=${id}` });
  return (res.json() as { calls: number }).calls;
}

async function turn(text: string): Promise<{ conv: string; usage: ConversationEvent[] }> {
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, text);
  await waitForTerminal(db, conv, 1, 20_000);
  return { conv, usage: (await eventsOf(db, conv)).filter((e) => e.type === "usage") };
}

const idOf = (e: ConversationEvent) => `${e.conversationId}/${e.seq}`;

describe("usage.report delivery", { timeout: 60_000 }, () => {
  it("a two-step turn: each plugin gets each usage event exactly once, payload from the log", async () => {
    await probe({});
    const { conv, usage } = await turn(`tool:${TOOL}:{"text":"x"}`);
    expect(usage).toHaveLength(2);
    const ids = usage.map(idOf);
    const got = await waitFor(
      async () => {
        const d = await probeUsage(ids);
        return ids.every((id) => d[id]?.calls === 1) ? d : null;
      },
      10_000,
      "probe deliveries",
    );
    for (const e of usage) {
      const p = got[idOf(e)]?.last as UsageReportPayload;
      const u = e.payload as unknown as Record<string, number>;
      expect(p).toMatchObject({
        eventId: `${conv}/${e.seq}`,
        orgId,
        agentId,
        conversationId: conv,
        conversationKind: "chat",
        runId: e.runId,
        provider: "model-fake",
        model: "fake-1",
        usage: {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheWriteTokens: u.cacheWriteTokens,
        },
      });
      expect(p.occurredAt).toBe(e.createdAt.toISOString());
      await waitFor(async () => (await seenB(idOf(e))) === 1, 10_000, "usage-b delivery");
    }
    // nothing is written to the event log by delivery (usage reports are never model-visible)
    await sleep(300);
    expect((await eventsOf(db, conv)).filter((e) => e.type === "hook_denied")).toEqual([]);
  });

  it("a failing plugin is retried alone: the other plugin receives the event once", async () => {
    await probe({ usageThrowOnce: true });
    const { usage } = await turn("echo:retry me");
    expect(usage).toHaveLength(1);
    const id = idOf(usage[0] as ConversationEvent);
    // first delivery fails, the retry (2 s backoff) succeeds
    await waitFor(async () => (await probeUsage([id]))[id]?.calls === 2, 15_000, "retry");
    await sleep(500);
    expect((await probeUsage([id]))[id]?.calls).toBe(2);
    expect(await seenB(id)).toBe(1);
    await probe({});
  });

  it("enqueueing the same usage event again runs once (job id dedupe)", async () => {
    await probe({});
    const { conv, usage } = await turn("echo:once");
    const e = usage[0] as ConversationEvent;
    const id = idOf(e);
    await waitFor(async () => (await probeUsage([id]))[id]?.calls === 1, 10_000, "delivered");
    const producer = new UsageReporter({
      db,
      redisUrl: rd.url,
      hooks: k.host.hooks,
      enabledPlugins: (o) => k.host.enabledPlugins(o),
      config: () => k.config,
      log: createLogger("error", { write: () => {} }),
    });
    try {
      await producer.enqueue(conv, e.seq);
      await producer.enqueue(conv, e.seq);
    } finally {
      await producer.stop();
    }
    await sleep(1000);
    expect((await probeUsage([id]))[id]?.calls).toBe(1);
    expect(await seenB(id)).toBe(1);
  });

  it("a plugin the organization disabled receives nothing", async () => {
    await probe({});
    await enable("usage-b", false);
    try {
      const { usage } = await turn("echo:b off");
      const id = idOf(usage[0] as ConversationEvent);
      await waitFor(async () => (await probeUsage([id]))[id]?.calls === 1, 10_000, "probe");
      await sleep(500);
      expect(await seenB(id)).toBe(0);
    } finally {
      await enable("usage-b", true);
    }
  });

  it("with no usage.report handler nothing is enqueued", async () => {
    const conversationId = "00000000-0000-4000-8000-000000000001";
    const producer = new UsageReporter({
      db,
      redisUrl: rd.url,
      hooks: { handlers: () => [] },
      enabledPlugins: async () => new Set(),
      config: () => k.config,
      log: createLogger("error", { write: () => {} }),
    });
    try {
      await producer.enqueue(conversationId, 7);
    } finally {
      await producer.stop();
    }
    expect(await queue.getJob(usageReportJobId(conversationId, 7))).toBeUndefined();
  });
});
