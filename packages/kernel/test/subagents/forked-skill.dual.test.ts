import { fileURLToPath } from "node:url";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { Kernel } from "../../src/kernel.js";
import { RUN_QUEUE_NAME, SUBAGENT_RUN_QUEUE_NAME } from "../../src/runtime/run-queue.js";
import { type ScriptRule, scriptRules } from "../fixtures/plugins/model-script/index.js";
import { truncateTables } from "../helpers/db.js";
import { seedForkedSkill } from "../helpers/forked-skills.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  runsOf,
  sleep,
  startKernel,
  waitFor,
  waitForRunJobDone,
  waitForTerminal,
} from "../helpers/runs.js";
import { backdateRun, childRunsOf, dropChildJobs, parentWaiting } from "../helpers/subagents.js";

/**
 * Phase D Task 6, two replicas (two in-process kernels sharing PG, Redis and S3): a forked skill
 * invoked on A suspends its run on A, the sub-agent runs on B, and the parent resumes on A (a new
 * process of it); a lost enqueue of the sub-agent is repaired by the wait sweep of both replicas.
 */

const MODEL_SCRIPT = fileURLToPath(
  new URL("../fixtures/plugins/model-script/index.ts", import.meta.url),
);
const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

const RULES: ScriptRule[] = [
  { when: { systemIncludes: "You are a sub-agent" }, reply: { text: "child report" } },
  { when: { lastUserIncludes: "Report from the sub-agent" }, reply: { text: "parent answered" } },
];

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let subQueue: Queue;
let runQueue: Queue;
const kernels: Kernel[] = [];

const config = () =>
  runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      extensions: [MODEL_FAKE, MODEL_SCRIPT, OBJECT_STORE],
      extensionConfig: {
        "model-script": { rules: RULES },
        "fake-object-store": {
          endpoint: s3.endpoint,
          region: s3.region,
          bucket: s3.bucket,
          accessKeyId: s3.accessKey,
          secretAccessKey: s3.secretKey,
          forcePathStyle: true,
        },
      },
    },
  );

async function boot(): Promise<Kernel> {
  const k = await startKernel(config());
  kernels.push(k);
  return k;
}

async function stopKernel(k: Kernel): Promise<void> {
  kernels.splice(kernels.indexOf(k), 1);
  await k.stop();
}

async function login(k: Kernel): Promise<Req> {
  const req = asUser(k.http, cookieJar());
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  subQueue = new Queue(SUBAGENT_RUN_QUEUE_NAME, { connection: new Redis(rd.url) });
  runQueue = new Queue(RUN_QUEUE_NAME, { connection: new Redis(rd.url) });
}, 180_000);

afterAll(async () => {
  for (const k of kernels.splice(0)) await k.stop();
  await subQueue?.close();
  await runQueue?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

let ownerId: string;

beforeEach(async () => {
  for (const k of kernels.splice(0)) await k.stop();
  await subQueue.resume();
  await runQueue.resume();
  scriptRules([]);
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
});

/** An org with an agent selecting one forked skill; returns the conversation. */
async function setup(k: Kernel, req: Req): Promise<{ orgId: string; conv: string }> {
  const orgId = await createOrg(req);
  const skill = await seedForkedSkill(
    { db, storage: k.storage, orgId, ownerId },
    "review",
    "Review $ARGUMENTS.",
  );
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Lead",
        instructions: "Lead the work.",
        model: { provider: "model-script", model: "script-1" },
        tools: [],
        skills: { orgSkills: [skill.id] },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const agentId = (res.json() as { agent: { id: string } }).agent.id;
  return { orgId, conv: await createConv(req, orgId, agentId) };
}

async function invoke(req: Req, orgId: string, conv: string): Promise<number> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
    payload: { text: "src", skill: { name: "review" } },
  });
  expect(res.statusCode, res.body).toBe(202);
  return (res.json() as { event: { seq: number } }).event.seq;
}

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);

describe("forked skills across two replicas", () => {
  it("invoked on A, the sub-agent runs on B, the parent resumes on A", async () => {
    const a = await boot();
    const reqA = await login(a);
    const { orgId, conv } = await setup(a, reqA);
    await subQueue.pause();
    const seq = await invoke(reqA, orgId, conv);
    const { runId, children } = await parentWaiting(db, conv, 1);
    await waitForRunJobDone(db, runQueue, runId);
    await stopKernel(a);
    // B runs the child; the parent's resume waits in the paused run queue for A
    await runQueue.pause();
    const b = await boot();
    await subQueue.resume();
    await waitFor(
      async () => {
        const [run] = await runsOf(db, conv);
        const [child] = await childRunsOf(db, conv);
        return (run?.status === "queued" && child?.status === "completed") || null;
      },
      30_000,
      "child done on B, parent resumed",
    );
    await stopKernel(b);
    const a2 = await boot();
    await runQueue.resume();
    await waitForTerminal(db, conv, 1, 30_000);
    const events = await eventsOf(db, conv);
    const report = ofType(events, "skill_fork_result");
    expect(report.map((r) => r.payload.invokedSeq)).toEqual([seq]);
    expect(report[0]?.payload.childRunId).toBe(children[0]?.runId);
    expect(report[0]?.payload.text).toContain("child report");
    expect(ofType(events, "subagent_dispatched")).toHaveLength(1);
    expect(ofType(events, "model_call").map((e) => e.payload.step)).toEqual([1]);
    expect(ofType(events, "assistant_message").at(-1)?.payload.content).toEqual([
      { type: "text", text: "parent answered" },
    ]);
    expect(a2).toBeDefined();
  }, 120_000);

  it("a lost enqueue of the sub-agent: both replicas sweep, it runs once and the parent answers", async () => {
    const a = await boot();
    const b = await boot();
    const reqA = await login(a);
    const { orgId, conv } = await setup(a, reqA);
    await subQueue.pause();
    await invoke(reqA, orgId, conv);
    const { runId, children } = await parentWaiting(db, conv, 1);
    await waitForRunJobDone(db, runQueue, runId);
    const child = children[0] as (typeof children)[number];
    await dropChildJobs(subQueue, [child.conversationId]);
    await backdateRun(db, child.runId);
    await subQueue.resume();
    const [ra, rb] = await Promise.all([a.runs.waits.sweep(), b.runs.waits.sweep()]);
    expect(ra.requeued + rb.requeued).toBeGreaterThanOrEqual(1);
    await waitForTerminal(db, conv, 1, 30_000);
    await sleep(500);
    const cev = await eventsOf(db, child.conversationId);
    expect(ofType(cev, "run_started")).toHaveLength(1);
    const events = await eventsOf(db, conv);
    expect(ofType(events, "subagent_dispatched")).toHaveLength(1);
    expect(ofType(events, "skill_fork_result")).toHaveLength(1);
    expect(ofType(events, "run_finished")).toHaveLength(1);
    expect(ofType(events, "assistant_message").at(-1)?.payload.content).toEqual([
      { type: "text", text: "parent answered" },
    ]);
  }, 90_000);
});
