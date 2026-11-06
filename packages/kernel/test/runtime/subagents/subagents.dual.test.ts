import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../../src/db/kernel-schema.js";
import { migrate } from "../../../src/db/migrator.js";
import { createDb } from "../../../src/db/pool.js";
import { KERNEL_BUS } from "../../../src/infra/tokens.js";
import {
  RUN_QUEUE_NAME,
  runJobId,
  SUBAGENT_RUN_QUEUE_NAME,
} from "../../../src/runtime/run-queue.js";
import { Waits } from "../../../src/runtime/waits.js";
import {
  openBarrier,
  type ScriptRule,
  scriptRules,
} from "../../fixtures/plugins/model-script/index.js";
import { eventLogFor, legacyDbFor } from "../../helpers/conversations.js";
import { truncateTables } from "../../helpers/db.js";
import { asUser, cookieJar } from "../../helpers/http.js";
import { accountsFor } from "../../helpers/identity.js";
import { MODEL_FAKE } from "../../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  sleep,
  startKernel,
  type TestKernel,
  waitFor,
  waitForRunJobDone,
  waitForTerminal,
} from "../../helpers/runs.js";
import {
  backdateRun,
  type ChildRun,
  childRunsOf,
  dropChildJobs,
  finishChildByHand,
  finishedDeliveries,
} from "../../helpers/subagents.js";

/**
 * Phase C Task 9 with background sub-agents (agent map spec §5.4, §10), two replicas (two
 * in-process kernels sharing PG and Redis, each with its own pool, HTTP app and workers):
 * - the parent dispatches on A and ends, A goes away, the children run on B and deliver;
 * - a child whose job stalls too often fails `run.stalled` and delivers that failure;
 * - both replicas sweep at once: a lost finish delivery is written once, a lost enqueue runs the
 *   child once;
 * - stopping a child on one replica stops it running on the other (Task 13).
 */

const MODEL_SCRIPT = fileURLToPath(
  new URL("../../fixtures/plugins/model-script/index.ts", import.meta.url),
);

const CHILD = "You are a sub-agent";
const RULES: ScriptRule[] = [
  // a child that keeps running until it is stopped (the barrier is never reached)
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "task-hang" },
    reply: { text: "hung", barrier: { name: "hang", count: 99, timeoutMs: 60_000 } },
  },
  { when: { systemIncludes: CHILD }, reply: { text: "child ok" } },
  {
    when: { lastUserIncludes: "SCENARIO hang", assistantTurns: 0 },
    reply: {
      toolCalls: ["a", "b"].map((x) => ({
        name: "Agent",
        input: { description: `Part ${x}`, prompt: `task-hang-${x}` },
      })),
    },
  },
  {
    when: { lastUserIncludes: "SCENARIO two", assistantTurns: 0 },
    reply: {
      toolCalls: ["a", "b"].map((x) => ({
        name: "Agent",
        input: { description: `Part ${x}`, prompt: `task-${x}` },
      })),
    },
  },
  {
    when: { lastUserIncludes: "SCENARIO one", assistantTurns: 0 },
    reply: { toolCalls: [{ name: "Agent", input: { description: "Task", prompt: "task-one" } }] },
  },
  { when: { lastToolResultIncludes: "in the background" }, reply: { text: "parent done" } },
];

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let subQueue: Queue;
let runQueue: Queue;
/**
 * The clients the queues above use. A queue given a client does not close it, so afterAll quits
 * them before Redis stops: an open client without an error listener reports "[ioredis] Unhandled
 * error event" on every reconnect, which can land after Vitest tore the worker down.
 */
const redisClients: Redis[] = [];
const redisClient = (): Redis => {
  const c = new Redis(rd.url);
  redisClients.push(c);
  return c;
};
const kernels: TestKernel[] = [];

const config = (roles: ("api" | "worker")[] = ["api", "worker"]) =>
  runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles,
      extensions: [MODEL_FAKE, MODEL_SCRIPT],
      extensionConfig: { "model-script": { rules: RULES } },
    },
  );

async function boot(roles?: ("api" | "worker")[]): Promise<TestKernel> {
  const k = await startKernel(config(roles));
  kernels.push(k);
  return k;
}

async function stopKernel(k: TestKernel): Promise<void> {
  kernels.splice(kernels.indexOf(k), 1);
  await k.close();
}

async function login(k: TestKernel, jar = cookieJar()): Promise<Req> {
  const req = asUser(k.http, jar);
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  subQueue = new Queue(SUBAGENT_RUN_QUEUE_NAME, { connection: redisClient() });
  runQueue = new Queue(RUN_QUEUE_NAME, { connection: redisClient() });
}, 120_000);

afterAll(async () => {
  for (const k of kernels.splice(0)) await k.close();
  await subQueue?.close();
  await runQueue?.close();
  await Promise.all(redisClients.splice(0).map((c) => c.quit()));
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let orgId: string;
let agentId: string;

beforeEach(async () => {
  for (const k of kernels.splice(0)) await k.close();
  await subQueue.resume();
  scriptRules([]);
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
});

async function setup(req: Req): Promise<void> {
  orgId = await createOrg(req);
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Lead",
        instructions: "Lead the work.",
        model: { provider: "model-script", model: "script-1" },
        tools: [{ kind: "builtin", name: "Agent" }],
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
}

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);
const finalText = (events: ConversationEvent[]) =>
  ofType(events, "assistant_message")
    .at(-1)
    ?.payload.content.flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("");

/**
 * Posts `text` with the sub-agent queue paused; returns once the parent's run ended (it never
 * waits on its children) with its `n` children queued.
 */
async function startPaused(req: Req, text: string, n: number) {
  await subQueue.pause();
  const conv = await createConv(req, orgId, agentId);
  await postMessage(req, orgId, conv, text);
  await waitForTerminal(db, conv, 1, 30_000);
  const run = await db
    .selectFrom("runs")
    .select("id")
    .where("conversation_id", "=", conv)
    .executeTakeFirstOrThrow();
  await waitForRunJobDone(db, runQueue, run.id);
  const children = await childRunsOf(db, conv);
  expect(children).toHaveLength(n);
  return { conv, runId: run.id, children };
}

describe("sub-agents across two replicas", () => {
  it("the parent dispatches on A and ends; with A gone, the children run on B and deliver", async () => {
    const a = await boot();
    const jar = cookieJar();
    const reqA = await login(a, jar);
    await setup(reqA);
    const { conv, runId } = await startPaused(reqA, "SCENARIO two", 2);
    await stopKernel(a);
    const b = await boot();
    await subQueue.resume();
    const ds = await finishedDeliveries(db, conv, 2);
    expect(ds.map((d) => d.text)).toEqual(["child ok", "child ok"]);
    const events = await eventsOf(db, conv);
    expect(finalText(events)).toBe("parent done");
    expect(ofType(events, "run_finished").map((e) => e.runId)).toEqual([runId]);
    expect(ofType(events, "subagent_finished")).toHaveLength(2);
    // both of the parent's steps ran on A, before the children
    expect(ofType(events, "model_call").map((e) => e.payload.step)).toEqual([1, 2]);
    expect((await childRunsOf(db, conv)).map((c) => c.status)).toEqual(["completed", "completed"]);
    expect(b).toBeDefined();
  }, 90_000);

  it("a child whose job stalls too often fails run.stalled and delivers that failure", async () => {
    const a = await boot();
    await boot();
    const reqA = await login(a);
    await setup(reqA);
    const { conv, children } = await startPaused(reqA, "SCENARIO one", 1);
    const child = children[0] as (typeof children)[number];
    const seq = Number(
      (
        await db
          .selectFrom("runs")
          .select("trigger_seq")
          .where("id", "=", child.runId)
          .executeTakeFirstOrThrow()
      ).trigger_seq,
    );
    // as if the replicas holding it kept dying: BullMQ marks the job failed on its next pickup
    await redis.hset(
      `bull:${SUBAGENT_RUN_QUEUE_NAME}:${runJobId(child.conversationId, seq)}`,
      "defa",
      "job stalled more than allowable limit",
    );
    await subQueue.resume();
    const [d] = await finishedDeliveries(db, conv, 1);
    const cev = await eventsOf(db, child.conversationId);
    expect(ofType(cev, "run_failed")[0]?.payload.error.code).toBe("run.stalled");
    expect(d).toMatchObject({ status: "failed", errorCode: "run.stalled" });
    expect(ofType(await eventsOf(db, conv), "subagent_finished")[0]?.payload).toMatchObject({
      status: "failed",
      errorCode: "run.stalled",
    });
  }, 90_000);

  it("children finished while their deliveries were lost: both replicas sweep, each delivered once, one wake", async () => {
    const a = await boot();
    const b = await boot();
    const reqA = await login(a);
    await setup(reqA);
    const { conv, children } = await startPaused(reqA, "SCENARIO two", 2);
    await dropChildJobs(
      subQueue,
      children.map((c) => c.conversationId),
    );
    for (const c of children) {
      await finishChildByHand(
        db,
        eventLogFor(db, a.app.get<ExtensionContext["bus"]>(KERNEL_BUS)),
        c,
        `by hand ${c.runId}`,
      );
      await backdateRun(db, c.runId);
    }
    const [ra, rb] = await Promise.all([a.app.get(Waits).sweep(), b.app.get(Waits).sweep()]);
    expect(ra.delivered + rb.delivered).toBeGreaterThanOrEqual(2);
    await sleep(500);
    const events = await eventsOf(db, conv);
    const ds = ofType(events, "subagent_delivery");
    expect(ds.map((d) => d.payload.text).sort()).toEqual(
      children.map((c) => `by hand ${c.runId}`).sort(),
    );
    expect(ofType(events, "subagent_finished")).toHaveLength(2);
    // the idle parent is woken once (agent map spec §5.3): both replicas' deliveries reach
    // ensureRun, which the conversation row lock and the 60 s window serialize
    await waitForTerminal(db, conv, 2, 30_000);
    await sleep(500);
    const parentRuns = await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .orderBy("created_at")
      .execute();
    expect(parentRuns).toHaveLength(2);
    const after = await eventsOf(db, conv);
    expect(ofType(after, "run_finished")).toHaveLength(2);
    const wakeStart = ofType(after, "run_started").find((e) => e.runId === parentRuns[1]?.id);
    expect(wakeStart?.payload.trigger).toBe("subagent");
    expect(ds.map((d) => d.seq)).toContain(wakeStart?.payload.triggerSeq);
  }, 90_000);

  it("a lost enqueue: both replicas sweep, the child runs once and delivers once", async () => {
    const a = await boot();
    const b = await boot();
    const reqA = await login(a);
    await setup(reqA);
    const { conv, children } = await startPaused(reqA, "SCENARIO one", 1);
    const child = children[0] as (typeof children)[number];
    await dropChildJobs(subQueue, [child.conversationId]);
    await backdateRun(db, child.runId);
    await subQueue.resume();
    const [ra, rb] = await Promise.all([a.app.get(Waits).sweep(), b.app.get(Waits).sweep()]);
    // both may see the orphan; BullMQ keeps one job per id, so the child still runs once
    expect(ra.requeued + rb.requeued).toBeGreaterThanOrEqual(1);
    await finishedDeliveries(db, conv, 1);
    await sleep(500);
    const cev = await eventsOf(db, child.conversationId);
    expect(ofType(cev, "run_started")).toHaveLength(1);
    expect(ofType(cev, "assistant_message")).toHaveLength(1);
    const events = await eventsOf(db, conv);
    expect(ofType(events, "subagent_dispatched")).toHaveLength(1);
    expect(ofType(events, "subagent_delivery")).toHaveLength(1);
  }, 90_000);

  it("stopping a child on A stops it running on B (Task 13)", async () => {
    // A takes HTTP only; every run, the children included, runs on B
    const a = await boot(["api"]);
    await boot();
    const reqA = await login(a);
    await setup(reqA);
    const conv = await createConv(reqA, orgId, agentId);
    await postMessage(reqA, orgId, conv, "SCENARIO hang");
    await waitForTerminal(db, conv, 1, 30_000);
    const children = await waitFor(
      async () => {
        const all = await childRunsOf(db, conv);
        return all.length === 2 && all.every((c) => c.status === "running") ? all : null;
      },
      20_000,
      "children running on B",
    );
    const [first, second] = children as [ChildRun, ChildRun];
    const res = await reqA({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${first.conversationId}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    const [d] = await finishedDeliveries(db, conv, 1);
    expect(d).toMatchObject({ subagentId: first.conversationId, status: "aborted" });
    const cev = await eventsOf(db, first.conversationId);
    expect(ofType(cev, "run_aborted").length).toBe(1);
    // its sibling keeps running
    expect((await childRunsOf(db, conv)).find((c) => c.runId === second.runId)?.status).toBe(
      "running",
    );
    openBarrier("hang");
    await finishedDeliveries(db, conv, 2);
  }, 60_000);
});
