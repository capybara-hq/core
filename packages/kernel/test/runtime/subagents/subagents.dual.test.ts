import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { migrate } from "../../../src/db/migrator.js";
import { createDb } from "../../../src/db/pool.js";
import { AccountsService } from "../../../src/identity/accounts.js";
import type { Kernel } from "../../../src/kernel.js";
import {
  RUN_QUEUE_NAME,
  runJobId,
  SUBAGENT_RUN_QUEUE_NAME,
} from "../../../src/runtime/run-queue.js";
import { type ScriptRule, scriptRules } from "../../fixtures/plugins/model-script/index.js";
import { truncateTables } from "../../helpers/db.js";
import { asUser, cookieJar } from "../../helpers/http.js";
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
  waitFor,
  waitForRunJobDone,
  waitForTerminal,
} from "../../helpers/runs.js";
import {
  backdateRun,
  childRunsOf,
  dropChildJobs,
  finishChildByHand,
  parentWaiting,
} from "../../helpers/subagents.js";

/**
 * Phase C Task 9, two replicas (two in-process kernels sharing PG and Redis, each with its own
 * pool, HTTP app and workers):
 * - the parent suspends on A, A goes away, the children run on B and B resumes the parent;
 * - a child whose job stalls too often fails `run.stalled` and the parent gets that result;
 * - both replicas sweep at once: a lost resume resumes the parent once, a lost enqueue runs the
 *   child once;
 * - stopping the parent on one replica stops its children running on the other (Task 13).
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
        name: "agent",
        input: { description: `Part ${x}`, prompt: `task-hang-${x}` },
      })),
    },
  },
  {
    when: { lastUserIncludes: "SCENARIO two", assistantTurns: 0 },
    reply: {
      toolCalls: ["a", "b"].map((x) => ({
        name: "agent",
        input: { description: `Part ${x}`, prompt: `task-${x}` },
      })),
    },
  },
  {
    when: { lastUserIncludes: "SCENARIO one", assistantTurns: 0 },
    reply: { toolCalls: [{ name: "agent", input: { description: "Task", prompt: "task-one" } }] },
  },
  { when: { lastToolResultIncludes: "[agentId:" }, reply: { text: "parent done" } },
];

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let subQueue: Queue;
let runQueue: Queue;
const kernels: Kernel[] = [];

const config = (roles: ("api" | "worker")[] = ["api", "worker"]) =>
  runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles,
      extensions: [MODEL_FAKE, MODEL_SCRIPT],
      extensionConfig: { "model-script": { rules: RULES } },
    },
  );

async function boot(roles?: ("api" | "worker")[]): Promise<Kernel> {
  const k = await startKernel(config(roles));
  kernels.push(k);
  return k;
}

async function stopKernel(k: Kernel): Promise<void> {
  kernels.splice(kernels.indexOf(k), 1);
  await k.stop();
}

async function login(k: Kernel, jar = cookieJar()): Promise<Req> {
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
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  subQueue = new Queue(SUBAGENT_RUN_QUEUE_NAME, { connection: new Redis(rd.url) });
  runQueue = new Queue(RUN_QUEUE_NAME, { connection: new Redis(rd.url) });
}, 120_000);

afterAll(async () => {
  for (const k of kernels.splice(0)) await k.stop();
  await subQueue?.close();
  await runQueue?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let orgId: string;
let agentId: string;

beforeEach(async () => {
  for (const k of kernels.splice(0)) await k.stop();
  await subQueue.resume();
  scriptRules([]);
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
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
        tools: [{ kind: "builtin", name: "agent" }],
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

/** Posts `text` with the sub-agent queue paused; returns once the parent is idle in `waiting`. */
async function startPaused(req: Req, text: string, n: number) {
  await subQueue.pause();
  const conv = await createConv(req, orgId, agentId);
  await postMessage(req, orgId, conv, text);
  const w = await parentWaiting(db, conv, n);
  await waitForRunJobDone(db, runQueue, w.runId);
  return { conv, ...w };
}

describe("sub-agents across two replicas", () => {
  it("the parent suspends on A; with A gone, the children run on B and B resumes the parent", async () => {
    const a = await boot();
    const jar = cookieJar();
    const reqA = await login(a, jar);
    await setup(reqA);
    const { conv, runId } = await startPaused(reqA, "SCENARIO two", 2);
    await stopKernel(a);
    const b = await boot();
    await subQueue.resume();
    await waitForTerminal(db, conv, 1, 30_000);
    const events = await eventsOf(db, conv);
    expect(finalText(events)).toBe("parent done");
    expect(ofType(events, "run_finished").map((e) => e.runId)).toEqual([runId]);
    expect(ofType(events, "subagent_finished")).toHaveLength(2);
    // step 1 ran on A, step 2 (after the resume) on B: each step's model call once
    expect(ofType(events, "model_call").map((e) => e.payload.step)).toEqual([1, 2]);
    expect((await childRunsOf(db, conv)).map((c) => c.status)).toEqual(["completed", "completed"]);
    expect(b).toBeDefined();
  }, 90_000);

  it("a child whose job stalls too often fails run.stalled and the parent gets that result", async () => {
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
    await waitForTerminal(db, conv, 1, 30_000);
    const cev = await eventsOf(db, child.conversationId);
    expect(ofType(cev, "run_failed")[0]?.payload.error.code).toBe("run.stalled");
    const events = await eventsOf(db, conv);
    const result = ofType(events, "tool_result").find((r) => r.payload.toolKey === "agent");
    expect(result?.payload.isError).toBe(true);
    expect(result?.payload.content).toContain("failed (run.stalled)");
    expect(ofType(events, "subagent_finished")[0]?.payload).toMatchObject({
      status: "failed",
      errorCode: "run.stalled",
    });
    expect(finalText(events)).toBe("parent done");
  }, 90_000);

  it("a child finished while its resume was lost: both replicas sweep, the parent resumes once", async () => {
    const a = await boot();
    const b = await boot();
    const reqA = await login(a);
    await setup(reqA);
    const { conv, runId, children } = await startPaused(reqA, "SCENARIO two", 2);
    await dropChildJobs(
      subQueue,
      children.map((c) => c.conversationId),
    );
    for (const c of children) await finishChildByHand(db, a.runs.eventLog, c, `by hand ${c.runId}`);
    await backdateRun(db, runId);
    const [ra, rb] = await Promise.all([a.runs.waits.sweep(), b.runs.waits.sweep()]);
    expect(ra.resumed + rb.resumed).toBe(1);
    await waitForTerminal(db, conv, 1, 30_000);
    await sleep(500);
    const events = await eventsOf(db, conv);
    expect(finalText(events)).toBe("parent done");
    expect(ofType(events, "run_finished")).toHaveLength(1);
    expect(ofType(events, "subagent_finished")).toHaveLength(2);
    expect(ofType(events, "model_call").map((e) => e.payload.step)).toEqual([1, 2]);
  }, 90_000);

  it("a lost enqueue: both replicas sweep, the child runs once and the parent resumes once", async () => {
    const a = await boot();
    const b = await boot();
    const reqA = await login(a);
    await setup(reqA);
    const { conv, children } = await startPaused(reqA, "SCENARIO one", 1);
    const child = children[0] as (typeof children)[number];
    await dropChildJobs(subQueue, [child.conversationId]);
    await backdateRun(db, child.runId);
    await subQueue.resume();
    const [ra, rb] = await Promise.all([a.runs.waits.sweep(), b.runs.waits.sweep()]);
    // both may see the orphan; BullMQ keeps one job per id, so the child still runs once
    expect(ra.requeued + rb.requeued).toBeGreaterThanOrEqual(1);
    await waitForTerminal(db, conv, 1, 30_000);
    await sleep(500);
    const cev = await eventsOf(db, child.conversationId);
    expect(ofType(cev, "run_started")).toHaveLength(1);
    expect(ofType(cev, "assistant_message")).toHaveLength(1);
    const events = await eventsOf(db, conv);
    expect(finalText(events)).toBe("parent done");
    expect(ofType(events, "subagent_dispatched")).toHaveLength(1);
    expect(ofType(events, "run_finished")).toHaveLength(1);
  }, 90_000);

  it("stopping the parent on A stops its children running on B (Task 13)", async () => {
    // A takes HTTP only; every run, the children included, runs on B
    const a = await boot(["api"]);
    await boot();
    const reqA = await login(a);
    await setup(reqA);
    const conv = await createConv(reqA, orgId, agentId);
    await postMessage(reqA, orgId, conv, "SCENARIO hang");
    const { runId, children } = await parentWaiting(db, conv, 2);
    await waitFor(
      async () => {
        const all = await childRunsOf(db, conv);
        return all.every((c) => c.status === "running") || null;
      },
      20_000,
      "children running on B",
    );
    const res = await reqA({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    await waitFor(
      async () => {
        const all = await childRunsOf(db, conv);
        return all.every((c) => c.status === "aborted") || null;
      },
      10_000,
      "children aborted",
    );
    const events = await eventsOf(db, conv);
    expect(ofType(events, "run_aborted")).toHaveLength(1);
    const results = ofType(events, "tool_result").filter((r) => r.payload.toolKey === "agent");
    expect(results.map((r) => r.payload.content)).toEqual([
      "The run was stopped while this sub-agent was working; it was stopped too.",
      "The run was stopped while this sub-agent was working; it was stopped too.",
    ]);
    for (const c of children) {
      const cev = await eventsOf(db, c.conversationId);
      expect(ofType(cev, "run_aborted").map((e) => e.payload.byAccountId)).toEqual([null]);
    }
    expect(
      (await db.selectFrom("runs").select("status").where("id", "=", runId).executeTakeFirst())
        ?.status,
    ).toBe("aborted");
  }, 60_000);
});
