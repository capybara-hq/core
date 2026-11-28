import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { withOrgScope } from "../../src/infra/database/org-scope.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import type { KernelOverride } from "../../src/overrides.js";
import { compactionProgressKey } from "../../src/runtime/compaction-progress.js";
import { ConversationLock } from "../../src/runtime/conversation-lock.js";
import { IdleCompactionJob } from "../../src/runtime/idle-compaction.js";
import {
  IDLE_COMPACTION_JOB,
  type IdleCompactionJobData,
} from "../../src/runtime/idle-compaction-jobs.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { RUN_QUEUE_NAME, RunQueue } from "../../src/runtime/run-queue.js";
import { RUN_HOOKS, type RunHooks } from "../../src/runtime/run-worker.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  eventsOf,
  gate,
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
 * Compaction on two replicas.
 *
 * Manual compaction (context compaction spec §4.7/§4.12): the compact run is claimed under the
 * conversation row lock, so concurrent requests on both replicas start one run and write one
 * `compaction_summary`, never two.
 *
 * Idle compaction (idle compaction spec §5.1, §5.2; plan invariants 2 and 5): two deliveries of
 * the same `idle-compact-<runId>` job on both replicas start at most one idle compact run, and a
 * message posted through one replica supersedes an idle compact run another replica's worker holds,
 * without pausing the queue. Each idle case arms a job the way a run finish does (the maintenance
 * queue's adds fail on both replicas, so the owed row stays in the outbox), reads the row's data,
 * then fires it through `IdleCompactionJob.fire`. model-fake declares `[300, 3600]` and passes the
 * in-context gate; the idle org turns the long cache tier on and the size floor down to the
 * settings' lowest (50,000 tokens, decision D6) over a seeded turn of about 220k characters.
 *
 * Compaction-model mode (compaction model spec §6.3): a third org maps its `compaction` purpose to
 * model-fake's fake-c with the long cache tier off, so the arming finish owes a `compaction_model`
 * job; fired on both replicas it starts one idle compact run (`idle_mode = 'compaction_model'`)
 * that writes one summary on fake-c.
 */

const HOOKS_PROBE = fileURLToPath(
  new URL("../fixtures/plugins/hooks-probe/index.ts", import.meta.url),
);

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
let ownerId: string;
let orgId: string;
let agentId: string;
let idleOrgId: string;
let idleAgentId: string;
let cOrgId: string;
let cAgentId: string;

const FAKE_C = { provider: "model-fake", model: "fake-c" };

/** Each replica's run worker seams: a test sets the ones it needs. */
const hooksA: RunHooks = {};
const hooksB: RunHooks = {};

/** About 220k characters: with the reply, the last call is over 50,000 tokens. */
const LONG_TEXT = "lorem ipsum dolor sit amet ".repeat(8_200);

const IDLE_SETTINGS = {
  idleMinTokensFloor: 50_000,
  idleMinWindowRatio: 0.1,
  keepRecentTurns: 1,
};

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  rawA = createDb(pgc.url, 3);
  rawB = createDb(pgc.url, 3);
  dbA = kernelDb(rawA);
  const cfg = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      extensions: [MODEL_FAKE, HOOKS_PROBE],
      extensionConfig: {
        "model-fake": {
          models: [
            { id: "fake-1", contextWindow: 400_000 },
            // the compaction model of the compaction-model org (200k window: eligible)
            { id: "fake-c", contextWindow: 200_000, cache: "none" },
          ],
        },
      },
    },
  );
  // the armed idle compaction rows stay owed: the tests fire their data themselves
  const holdMaintenance: KernelOverride = {
    provide: OUTBOX_DISPATCH_FAILS,
    useValue: (q: string) => q === MAINTENANCE_QUEUE_NAME,
  };
  a = await startKernel(cfg, {
    overrides: [holdMaintenance, { provide: RUN_HOOKS, useValue: hooksA }],
  });
  b = await startKernel(cfg, {
    overrides: [holdMaintenance, { provide: RUN_HOOKS, useValue: hooksB }],
  });
  redis = new Redis(rd.url);
  runQueue = new Queue(RUN_QUEUE_NAME, { connection: new Redis(rd.url) });
  ownerId = (await accountsFor(dbA).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  ownerA = await session(a, "owner");
  ownerB = await session(b, "owner");
  orgId = await createOrgWithProviders(a, ownerA);
  agentId = await createAgent(ownerA, orgId);

  idleOrgId = await createOrgWithProviders(a, ownerA, "Idle");
  const patched = await ownerA({
    method: "PATCH",
    url: `/api/v1/orgs/${idleOrgId}/settings`,
    payload: { promptCache: { longTtl: true }, compaction: IDLE_SETTINGS },
  });
  expect(patched.statusCode, patched.body).toBe(200);
  const enabled = await ownerA({
    method: "PUT",
    url: `/api/v1/orgs/${idleOrgId}/extensions/hooks-probe`,
    payload: { enabled: true },
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  idleAgentId = await createAgent(ownerA, idleOrgId);

  cOrgId = await createOrgWithProviders(a, ownerA, "Idle C");
  // longTtl off: cache mode alone would arm nothing, the compaction model arms
  const cPatched = await ownerA({
    method: "PATCH",
    url: `/api/v1/orgs/${cOrgId}/settings`,
    payload: { promptCache: { longTtl: false }, compaction: IDLE_SETTINGS },
  });
  expect(cPatched.statusCode, cPatched.body).toBe(200);
  const mapped = await ownerA({
    method: "PUT",
    url: `/api/v1/orgs/${cOrgId}/model-purposes/compaction`,
    payload: { target: { model: FAKE_C, params: {} } },
  });
  expect(mapped.statusCode, mapped.body).toBe(200);
  cAgentId = await createAgent(ownerA, cOrgId);
});
afterAll(async () => {
  await Promise.all([a?.close(), b?.close()]);
  await runQueue?.close();
  redis?.disconnect();
  await Promise.all([rawA?.destroy(), rawB?.destroy()]);
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  for (const h of [hooksA, hooksB]) delete h.beforeRunStarted;
  await holdModelCalls(0);
});

const compactUrl = (conv: string) => `/api/v1/orgs/${orgId}/conversations/${conv}/compact`;

const ev = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter(
    (e): e is ConversationEvent & { type: T; payload: EventPayload<T> } => e.type === type,
  );

const forRun = (events: ConversationEvent[], runId: string) =>
  events.filter((e) => e.runId === runId);

/** Holds every model call of the idle org in its `model.request` hook (stops early when aborted). */
async function holdModelCalls(sleepMs: number): Promise<void> {
  // hooks-probe keeps its config in ctx.kv (Redis): one request configures both replicas
  const configured = await ownerA({
    method: "POST",
    url: "/plugins/hooks-probe/config",
    payload: { orgId: idleOrgId, sleepMs, sleepIn: sleepMs > 0 ? ["model.request"] : [] },
  });
  expect(configured.statusCode, configured.body).toBe(200);
}

/** The data of the newest owed idle compaction row of the conversation. */
async function armedData(conv: string): Promise<IdleCompactionJobData> {
  const rows = await dbA
    .selectFrom("outbox")
    .select("data")
    .where("job_name", "=", IDLE_COMPACTION_JOB)
    .orderBy("id", "desc")
    .execute();
  const data = rows
    .map((r) => r.data as unknown as IdleCompactionJobData)
    .find((d) => d.conversationId === conv);
  if (!data) throw new Error("no idle compaction job owed");
  return data;
}

/**
 * A conversation of the idle org (or `org`) with a long seeded turn and one answered turn, armed:
 * the run's finish owed an `idle-compaction` job; returns its data.
 */
async function arm(
  org = idleOrgId,
  agent = idleAgentId,
): Promise<{ conv: string; data: IdleCompactionJobData }> {
  const conv = await createConv(ownerA, org, agent);
  const [e] = await withOrgScope(org, () =>
    a.app.get(EventLog).append(conv, [
      {
        type: "user_message",
        payload: { content: [{ type: "text", text: LONG_TEXT }], authorAccountId: ownerId },
      },
    ]),
  );
  await dbA
    .updateTable("conversations")
    .set({ consumed_seq: String(e?.seq) })
    .where("id", "=", conv)
    .execute();
  await postMessage(ownerA, org, conv, "echo:ok");
  await waitForTerminal(dbA, conv, 1, 30_000);
  return { conv, data: await armedData(conv) };
}

/** Fires the job's data on replica `x`, as its maintenance processor would (under the job's org). */
const fireOn = (x: TestKernel, data: IdleCompactionJobData) =>
  withOrgScope(data.orgId, () => x.app.get(IdleCompactionJob).fire(data));

const idleRuns = (conv: string) =>
  dbA
    .selectFrom("runs")
    .select(["id", "status", "idle_mode"])
    .where("conversation_id", "=", conv)
    .where("compact_origin", "=", "idle")
    .execute();

/**
 * Fires `data` on both replicas at once: both deliveries pass their unlocked checks and reach the
 * start before either goes on, so the conversation row lock alone decides which one starts the run.
 */
async function fireOnBoth(
  data: IdleCompactionJobData,
): Promise<Awaited<ReturnType<typeof fireOn>>[]> {
  const queues = [a.app.get(RunQueue), b.app.get(RunQueue)];
  const both = gate();
  let arrived = 0;
  for (const q of queues) {
    const original = q.startIdleCompaction.bind(q);
    q.startIdleCompaction = async (conversationId, armedSeq, mode) => {
      if (++arrived === 2) both.open();
      await both.promise;
      return original(conversationId, armedSeq, mode);
    };
  }
  try {
    const outcomes = await Promise.all([fireOn(a, data), fireOn(b, data)]);
    expect(arrived).toBe(2);
    return outcomes;
  } finally {
    // the own property shadowed the prototype method: removing it restores the original
    for (const q of queues)
      delete (q as Partial<Pick<RunQueue, "startIdleCompaction">>).startIdleCompaction;
  }
}

/** The conversation's idle compact runs, once there is one and all are completed. */
const idleRunsCompleted = (conv: string) =>
  waitFor(
    async () => {
      const rows = await idleRuns(conv);
      return rows.length > 0 && rows.every((r) => r.status === "completed") ? rows : null;
    },
    30_000,
    "the idle compact run completed",
  );

const runStatus = (runId: string, status: string) =>
  waitFor(
    async () => {
      const row = await dbA
        .selectFrom("runs")
        .select("status")
        .where("id", "=", runId)
        .executeTakeFirst();
      return row?.status === status ? row : null;
    },
    30_000,
    `run ${status}`,
  );

/** Waits until a compact run reached its summary call (progress phase `summarizing`). */
const summarizing = (runId: string) =>
  waitFor(
    async () => {
      const r = await redis.get(compactionProgressKey(runId));
      return r !== null && (JSON.parse(r) as { phase: string }).phase === "summarizing" ? r : null;
    },
    20_000,
    "the compaction reached its model call",
  );

/** The runs of a conversation after `afterId` (creation order), once the last one is terminal. */
const runsAfter = (conv: string, afterId: string) =>
  waitFor(
    async () => {
      const rows = await dbA
        .selectFrom("runs")
        .select(["id", "status", "trigger_seq", "compact"])
        .where("conversation_id", "=", conv)
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      const later = rows.slice(rows.findIndex((r) => r.id === afterId) + 1);
      return later.length >= 1 && later.every((r) => r.status === "completed") ? later : null;
    },
    30_000,
    "the runs after the idle run completed",
  );

describe("manual compaction on two replicas", () => {
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

describe("idle compaction on two replicas", () => {
  it("the same job fired concurrently on both replicas starts one idle compact run and writes one summary", async () => {
    const { conv, data } = await arm();
    const outcomes = await fireOnBoth(data);
    expect(outcomes.filter((o) => o === "started")).toHaveLength(1);
    expect(["obsolete", "busy"]).toContain(outcomes.find((o) => o !== "started"));

    const runs = await idleRunsCompleted(conv);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.idle_mode).toBe("cache");
    const events = await eventsOf(dbA, conv);
    const summaries = ev(events, "compaction_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.runId).toBe(runs[0]?.id);
    expect(ev(events, "usage").filter((e) => e.payload.purpose === "compaction")).toHaveLength(1);
    // a later delivery on either replica finds the run: obsolete
    expect(await fireOn(b, data)).toBe("obsolete");
    expect(await idleRuns(conv)).toHaveLength(1);
  });

  it("the same compaction-model job fired concurrently on both replicas starts one idle compact run and writes one summary on the compaction model", async () => {
    const { conv, data } = await arm(cOrgId, cAgentId);
    expect(data.mode).toBe("compaction_model");
    const outcomes = await fireOnBoth(data);
    expect(outcomes.filter((o) => o === "started")).toHaveLength(1);
    expect(["obsolete", "busy"]).toContain(outcomes.find((o) => o !== "started"));

    const runs = await idleRunsCompleted(conv);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.idle_mode).toBe("compaction_model");
    const events = await eventsOf(dbA, conv);
    const summaries = ev(events, "compaction_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.runId).toBe(runs[0]?.id);
    expect(summaries[0]?.payload).toMatchObject({ method: "transcript", model: FAKE_C });
    const usage = ev(events, "usage").filter((e) => e.payload.purpose === "compaction");
    expect(usage.length).toBeGreaterThan(0);
    for (const u of usage) expect(u.payload).toMatchObject(FAKE_C);
    // a later delivery on either replica finds the run: obsolete
    expect(await fireOn(a, data)).toBe("obsolete");
    expect(await fireOn(b, data)).toBe("obsolete");
    expect(await idleRuns(conv)).toHaveLength(1);
  });

  it("a message through one replica supersedes the idle compact run another replica's worker holds", async () => {
    const { conv, data } = await arm();
    // the worker that claims the idle run stops before its run_started: the test learns which
    // replica holds it, then lets it reach its (held) summary call. Every later run of the
    // conversation stops there too until the hold is lifted: model-call.ts records `summarizing`
    // before the `model.request` hook reads the probe's config, so the hold may only be lifted once
    // the idle run has ended, and before the next run can reach a model call
    const go = gate();
    const following = gate();
    let claimedId: string | undefined;
    let reached!: (claim: { runId: string; holder: "a" | "b" }) => void;
    const claimed = new Promise<{ runId: string; holder: "a" | "b" }>((r) => {
      reached = r;
    });
    for (const [h, holder] of [
      [hooksA, "a"],
      [hooksB, "b"],
    ] as const) {
      h.beforeRunStarted = async (runId, conversationId) => {
        if (conversationId !== conv) return;
        if (claimedId === undefined) {
          claimedId = runId;
          reached({ runId, holder });
          await go.promise;
        } else if (runId !== claimedId) {
          await following.promise;
        }
      };
    }
    let idle: string;
    try {
      expect(await fireOn(b, data)).toBe("started");
      const claim = await claimed;
      idle = claim.runId;
      const [idleRow] = await idleRuns(conv);
      expect(idleRow?.id).toBe(idle);
      await holdModelCalls(60_000);
      go.open();
      const holder = claim.holder === "a" ? a : b;
      const poster = claim.holder === "a" ? ownerB : ownerA;
      await summarizing(idle);
      // the lock record lives in the shared Redis, so either replica reads the same holder: this
      // proves the idle run holds the conversation lock, not which replica's worker runs it
      expect(await holder.app.get(ConversationLock).holder(conv)).toBe(idle);

      await postMessage(poster, idleOrgId, conv, "echo:after the pause");
      await runStatus(idle, "aborted");
    } finally {
      await holdModelCalls(0);
      for (const h of [hooksA, hooksB]) delete h.beforeRunStarted;
      go.open();
      following.open();
    }
    const [next] = await runsAfter(conv, idle);

    const events = await eventsOf(dbA, conv);
    expect(ev(forRun(events, idle), "run_aborted").map((e) => e.payload)).toEqual([
      { byAccountId: null, reason: "superseded" },
    ]);
    expect(ev(forRun(events, idle), "compaction_summary")).toEqual([]);
    expect(next?.compact).toBe(false);
    expect(Number(next?.trigger_seq)).toBe(ev(events, "user_message").at(-1)?.seq);
    expect(ev(forRun(events, next?.id as string), "run_finished")).toHaveLength(1);
    const row = await dbA
      .selectFrom("conversations")
      .select(["queue_paused", "tree_stopped_at"])
      .where("id", "=", conv)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ queue_paused: false, tree_stopped_at: null });
  });
});
