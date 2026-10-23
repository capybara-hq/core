import { fileURLToPath } from "node:url";
import type { UsageReportPayload } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import {
  narrowPending,
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
/** A second Valkey: standalone reporters there do not compete with the kernel's worker. */
let rd2: TestContainer;
let conn2: Redis;
let queue2: Queue;

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
  rd2 = await startTestRedis();
  conn2 = new Redis(rd2.url, { maxRetriesPerRequest: null });
  queue2 = new Queue(USAGE_REPORT_QUEUE, { connection: conn2 });
}, 180_000);

afterAll(async () => {
  await queue?.close();
  queueConn?.disconnect();
  await queue2?.close();
  conn2?.disconnect();
  await rd2?.stop();
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
      subscribers: async () => new Set(["hooks-probe", "usage-b"]),
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
      subscribers: async () => new Set(),
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

describe("sweeper (Ruling R13)", { timeout: 60_000 }, () => {
  it("a lost fast-path enqueue is caught up by the sweep, exactly once", async () => {
    await probe({});
    const reporter = k.usageReport as unknown as { enqueue: UsageReporter["enqueue"] };
    const original = reporter.enqueue;
    // the fast path "fails" (as a Redis error would: logged, nothing enqueued)
    reporter.enqueue = async () => {};
    let id: string;
    let conv: string;
    let seq: number;
    try {
      const t = await turn("echo:lost enqueue");
      const e = t.usage[0] as ConversationEvent;
      [id, conv, seq] = [idOf(e), t.conv, e.seq];
    } finally {
      reporter.enqueue = original;
    }
    await sleep(1000);
    expect((await probeUsage([id]))[id]?.calls).toBe(0);
    expect(await queue.getJob(usageReportJobId(conv, seq))).toBeUndefined();
    // the event is older than the 30 s lag at this "now"
    const now = Date.now() + 31_000;
    expect(await k.usageReport.sweep({ now })).toBeGreaterThan(0);
    await waitFor(async () => (await probeUsage([id]))[id]?.calls === 1, 10_000, "swept");
    await waitFor(async () => (await seenB(id)) === 1, 10_000, "swept to usage-b");
    // sweeping again (overlap) dedupes on the kept job
    await k.usageReport.sweep({ now: now + 1000 });
    await sleep(1000);
    expect((await probeUsage([id]))[id]?.calls).toBe(1);
    expect(await seenB(id)).toBe(1);
    const wm = await db.selectFrom("usage_report_sweep").select("watermark").executeTakeFirst();
    expect(new Date(wm?.watermark as Date).getTime()).toBe(now + 1000 - 30_000);
  });
});

describe("UsageReporter (standalone, own Valkey)", { timeout: 60_000 }, () => {
  const silent = createLogger("error", { write: () => {} });
  const reporters: UsageReporter[] = [];
  let ev: { conv: string; seq: number };

  beforeAll(async () => {
    const t = await turn("echo:standalone");
    const e = t.usage[0] as ConversationEvent;
    ev = { conv: t.conv, seq: e.seq };
  });
  afterAll(async () => {
    for (const r of reporters) await r.stop();
  });

  type H = (p: UsageReportPayload, s: AbortSignal) => Promise<void>;
  function reporter(
    handlers: Record<string, H>,
    subscribers: string[],
    opts: { attempts?: number; backoffMs?: number; error?: (m: string, f?: unknown) => void } = {},
  ): UsageReporter {
    const r = new UsageReporter({
      db,
      redisUrl: rd2.url,
      hooks: {
        handlers: () =>
          Object.entries(handlers).map(([plugin, handler]) => ({
            plugin,
            handler: handler as never,
          })),
      },
      subscribers: async () => new Set(subscribers),
      config: () => k.config,
      log: { ...silent, ...(opts.error && { error: opts.error }) },
      retry: { attempts: opts.attempts ?? 3, backoffMs: opts.backoffMs ?? 50 },
    });
    reporters.push(r);
    return r;
  }
  const jobOf = () => queue2.getJob(usageReportJobId(ev.conv, ev.seq));

  beforeEach(async () => {
    await conn2.flushdb();
  });

  it("retries exhausted: the plugin is called once per attempt, then an error is logged", async () => {
    const errors: [string, unknown][] = [];
    let calls = 0;
    const r = reporter(
      {
        x: async () => {
          calls++;
          throw new Error("always");
        },
      },
      ["x"],
      { attempts: 3, error: (m, f) => errors.push([m, f]) },
    );
    r.startWorker();
    await r.enqueue(ev.conv, ev.seq);
    await waitFor(async () => errors.length > 0, 10_000, "give-up log");
    expect(calls).toBe(3);
    expect(errors[0]?.[0]).toBe("usage report given up after retries");
    expect(errors[0]?.[1]).toMatchObject({ pending: ["x"], attempt: 3 });
    await r.stop();
  });

  it("two plugins: only the failed one is retried", async () => {
    const calls = { x: 0, y: 0 };
    const r = reporter(
      {
        x: async () => {
          calls.x++;
          if (calls.x === 1) throw new Error("first");
        },
        y: async () => {
          calls.y++;
        },
      },
      ["x", "y"],
    );
    r.startWorker();
    await r.enqueue(ev.conv, ev.seq);
    await waitFor(async () => calls.x === 2, 10_000, "retry of x");
    await sleep(300);
    expect(calls).toEqual({ x: 2, y: 1 });
    expect((await jobOf())?.data.pending).toEqual([]);
    await r.stop();
  });

  it("a subscriber loaded on replica A only: replica B fails it, replica A delivers it", async () => {
    const calls = { x: 0, y: 0 };
    const y: H = async () => {
      calls.y++;
    };
    // replica B: x subscribes (deployment state) but is not loaded here
    const b = reporter({ y }, ["x", "y"], { attempts: 5, backoffMs: 500 });
    b.startWorker();
    await b.enqueue(ev.conv, ev.seq);
    await waitFor(
      async () => JSON.stringify((await jobOf())?.data.pending) === '["x"]',
      10_000,
      "x left pending on B",
    );
    await b.stop();
    expect(calls).toEqual({ x: 0, y: 1 });
    // replica A has x loaded
    const a = reporter(
      {
        x: async () => {
          calls.x++;
        },
        y,
      },
      ["x", "y"],
      { attempts: 5, backoffMs: 500 },
    );
    a.startWorker();
    await waitFor(async () => calls.x === 1, 10_000, "x delivered on A");
    await sleep(300);
    expect(calls).toEqual({ x: 1, y: 1 });
    await a.stop();
  });

  it("a replica stopping mid-delivery does not use up an attempt", async () => {
    let started = 0;
    const hold = reporter(
      {
        x: (_p, s) =>
          new Promise<void>((resolve) => {
            started++;
            s.addEventListener("abort", () => resolve(), { once: true });
          }),
      },
      ["x"],
      { attempts: 2 },
    );
    hold.startWorker();
    await hold.enqueue(ev.conv, ev.seq);
    await waitFor(async () => started === 1, 10_000, "delivery started");
    await hold.stop();
    const j = await jobOf();
    expect(j?.attemptsMade ?? 0).toBe(0);
    expect(await j?.getState()).not.toBe("failed");
    let delivered = 0;
    const next = reporter(
      {
        x: async () => {
          delivered++;
        },
      },
      ["x"],
      { attempts: 2 },
    );
    next.startWorker();
    await waitFor(async () => delivered === 1, 10_000, "delivered after restart");
    await next.stop();
  });

  it("with no subscriber the sweep enqueues nothing but still advances the watermark", async () => {
    const r = reporter({}, []);
    const now = Date.now() + 3_600_000;
    expect(await r.sweep({ now })).toBe(0);
    expect(await queue2.getJobCounts("waiting", "delayed", "completed")).toEqual({
      waiting: 0,
      delayed: 0,
      completed: 0,
    });
    const wm = await db.selectFrom("usage_report_sweep").select("watermark").executeTakeFirst();
    expect(new Date(wm?.watermark as Date).getTime()).toBe(now - 30_000);
  });

  it("narrowPending never brings back a plugin another execution delivered", () => {
    expect(narrowPending(undefined, ["x", "y"])).toEqual(["x", "y"]);
    expect(narrowPending(["x"], ["x", "y"])).toEqual(["x"]);
    expect(narrowPending([], ["x"])).toEqual([]);
  });
});
