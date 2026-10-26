import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { AccountsService } from "../../../src/identity/accounts.js";
import type { Kernel } from "../../../src/kernel.js";
import { finishRun } from "../../../src/runtime/run-finish.js";
import { RUN_QUEUE_NAME, SUBAGENT_RUN_QUEUE_NAME } from "../../../src/runtime/run-queue.js";
import { onChildFinished } from "../../../src/runtime/subagents/child.js";
import { resumeJobId } from "../../../src/runtime/waits.js";
import { type ScriptRule, scriptRules } from "../../fixtures/plugins/model-script/index.js";
import { truncateTables } from "../../helpers/db.js";
import { MODEL_FAKE } from "../../helpers/model-plugins.js";
import { captureProviderRequests } from "../../helpers/provider-capture.js";
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
  waitForEvent,
  waitForRunJobDone,
  waitForTerminal,
} from "../../helpers/runs.js";
import {
  backdateRun,
  childRunsOf,
  dropChildJobs,
  finishChildByHand,
  parentWaiting,
  runStatus,
} from "../../helpers/subagents.js";

/**
 * Phase C Task 9: a parent waiting on sub-agents resumes exactly once, with approvals in the same
 * step, after lost enqueues and lost resumes (the wait sweep), on a wait timeout, and the sweep
 * stops the children of a finished parent. One kernel; the sub-agent queue is paused by the test
 * whenever it needs a child to stay queued.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");

const CHILD = "You are a sub-agent";
const agentCall = (prompt: string) => ({
  name: "agent",
  input: { description: "Task", prompt },
});

const RULES: ScriptRule[] = [
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "task-write", assistantTurns: 0 },
    reply: {
      toolCalls: [{ name: "sandbox_write", input: { path: "/workspace/c.txt", content: "c" } }],
    },
  },
  { when: { systemIncludes: CHILD }, reply: { text: "child ok" } },
  {
    when: { lastUserIncludes: "SCENARIO write", assistantTurns: 0 },
    reply: { toolCalls: [agentCall("task-write")] },
  },
  {
    when: { lastUserIncludes: "SCENARIO one", assistantTurns: 0 },
    reply: { toolCalls: [agentCall("task-one")] },
  },
  {
    when: { lastUserIncludes: "SCENARIO three", assistantTurns: 0 },
    reply: { toolCalls: ["a", "b", "c"].map((x) => agentCall(`task-${x}`)) },
  },
  {
    when: { lastUserIncludes: "SCENARIO mixed", assistantTurns: 0 },
    reply: {
      toolCalls: [
        agentCall("task-mixed"),
        { name: "sandbox_write", input: { path: "/workspace/m.txt", content: "m" } },
      ],
    },
  },
  // the interjection follows the tool results in the parent's request after the resume
  { when: { lastUserIncludes: "interjection" }, reply: { text: "absorbed" } },
  { when: { lastToolResultIncludes: "[agentId:" }, reply: { text: "parent done" } },
];

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let k: Kernel;
let root: string;
let subQueue: Queue;
let runQueue: Queue;
const capture = captureProviderRequests();

beforeAll(async () => {
  capture.install();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  root = await mkdtemp(join(tmpdir(), "cap-subagents-resume-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE],
        extensionConfig: { "model-script": { rules: RULES }, "sandbox-fake": { root } },
        // the parent's own active time is tiny; its waits must not count against this
        runtime: { maxRunSeconds: 3 },
      },
    ),
  );
  subQueue = new Queue(SUBAGENT_RUN_QUEUE_NAME, { connection: new Redis(rd.url) });
  runQueue = new Queue(RUN_QUEUE_NAME, { connection: new Redis(rd.url) });
}, 180_000);

afterAll(async () => {
  capture.restore();
  await subQueue?.close();
  await runQueue?.close();
  await k?.stop();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

let owner: Req;
let orgId: string;
let agentId: string;

beforeEach(async () => {
  await subQueue.resume();
  await truncateTables(
    db,
    "capybara.audit_events, capybara.subagent_dispatches, capybara.sandboxes, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  capture.reset();
  scriptRules([]);
  await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Lead",
        instructions: "Lead the work.",
        model: { provider: "model-script", model: "script-1" },
        tools: ["agent", "sandbox_write"].map((name) => ({ kind: "builtin", name })),
        toolPolicies: { sandbox_write: "ask" },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterEach(async () => {
  await subQueue.resume();
  scriptRules([]);
});

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);
const agentResults = (events: ConversationEvent[]) =>
  ofType(events, "tool_result").filter((r) => r.payload.toolKey === "agent");
const finalText = (events: ConversationEvent[]) =>
  ofType(events, "assistant_message")
    .at(-1)
    ?.payload.content.flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("");

/**
 * Starts `text` in a new conversation with the sub-agent queue paused, so the children stay
 * queued; returns once the parent is `waiting` and its job is gone.
 */
async function startPaused(text: string, n = 1) {
  await subQueue.pause();
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, text);
  const w = await parentWaiting(db, conv, n);
  await waitForRunJobDone(db, runQueue, w.runId);
  return { conv, ...w };
}

const childDeps = () => ({ db, eventLog: k.runs.eventLog, waits: k.runs.waits, log: console });

describe("resume after sub-agents", () => {
  it.each([
    [0, 1, 2],
    [2, 0, 1],
    [1, 2, 0],
  ])(
    "the parent resumes exactly once when the last of three children finishes (order %j)",
    async (...order) => {
      const { conv, runId, children } = await startPaused("SCENARIO three", 3);
      expect(
        await dropChildJobs(
          subQueue,
          children.map((c) => c.conversationId),
        ),
      ).toBe(3);
      for (const [i, idx] of order.entries()) {
        const child = children[idx] as (typeof children)[number];
        await finishChildByHand(db, k.runs.eventLog, child, `reply ${idx}`);
        // every finisher tries (twice here, as a redelivery would); only the last one resumes
        await Promise.all([
          onChildFinished(childDeps(), child.runId),
          onChildFinished(childDeps(), child.runId),
        ]);
        if (i < 2) expect(await runStatus(db, runId)).toBe("waiting");
      }
      await waitForTerminal(db, conv, 1, 20_000);
      const run = await db
        .selectFrom("runs")
        .select(["status", "job_id"])
        .where("id", "=", runId)
        .executeTakeFirstOrThrow();
      const last = children[order[2] as number] as (typeof children)[number];
      expect(run).toEqual({ status: "completed", job_id: resumeJobId(conv, last.runId) });
      const events = await eventsOf(db, conv);
      expect(finalText(events)).toBe("parent done");
      expect(ofType(events, "subagent_finished")).toHaveLength(3);
      expect(
        agentResults(events)
          .map((r) => r.payload.content.split("\n\n")[0])
          .sort(),
      ).toEqual(["reply 0", "reply 1", "reply 2"]);
      // one resume: the step after the dispatches made one model call
      expect(ofType(events, "model_call").filter((e) => e.payload.step === 2)).toHaveLength(1);
    },
    60_000,
  );

  it("a step with an approval and a sub-agent resumes only after both (child first)", async () => {
    const { conv, runId, children } = await startPaused("SCENARIO mixed");
    const approval = (await waitForEvent(
      db,
      conv,
      (e) => e.type === "approval_requested",
    )) as Ev<"approval_requested">;
    await subQueue.resume();
    await waitForEvent(db, conv, (e) => e.type === "subagent_finished", 20_000);
    expect((await childRunsOf(db, conv))[0]?.status).toBe("completed");
    await sleep(300);
    expect(await runStatus(db, runId)).toBe("waiting");
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${approval.payload.approvalId}/decision`,
      payload: { decision: "approve" },
    });
    expect(res.statusCode, res.body).toBe(200);
    await waitForTerminal(db, conv, 1, 20_000);
    const events = await eventsOf(db, conv);
    expect(finalText(events)).toBe("parent done");
    expect(agentResults(events)).toHaveLength(1);
    expect(
      ofType(events, "tool_result")
        .map((r) => r.payload.toolKey)
        .sort(),
    ).toEqual(["agent", "sandbox_write"]);
    expect(children).toHaveLength(1);
  }, 60_000);

  it("a step with an approval and a sub-agent resumes only after both (approval first)", async () => {
    const { conv, runId } = await startPaused("SCENARIO mixed");
    const approval = (await waitForEvent(
      db,
      conv,
      (e) => e.type === "approval_requested",
    )) as Ev<"approval_requested">;
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${approval.payload.approvalId}/decision`,
      payload: { decision: "approve" },
    });
    expect(res.statusCode, res.body).toBe(200);
    await sleep(300);
    expect(await runStatus(db, runId)).toBe("waiting");
    await subQueue.resume();
    await waitForTerminal(db, conv, 1, 20_000);
    const events = await eventsOf(db, conv);
    expect(finalText(events)).toBe("parent done");
    expect(ofType(events, "model_call").filter((e) => e.payload.step === 2)).toHaveLength(1);
  }, 60_000);

  it("a user message during the wait starts no run and is absorbed after the resume", async () => {
    const { conv, runId } = await startPaused("SCENARIO one");
    await postMessage(owner, orgId, conv, "interjection: also check the tests");
    await sleep(300);
    const runs = await db
      .selectFrom("runs")
      .select(["id", "status"])
      .where("conversation_id", "=", conv)
      .execute();
    expect(runs).toEqual([{ id: runId, status: "waiting" }]);
    await subQueue.resume();
    await waitForTerminal(db, conv, 1, 20_000);
    const events = await eventsOf(db, conv);
    expect(finalText(events)).toBe("absorbed");
    // the parent's next request carried the message; still one run, and it consumed the message
    const req = capture.sent.findLast(
      (r: ModelRequest) => !r.system.some((s) => s.text.includes(CHILD)),
    ) as ModelRequest;
    expect(JSON.stringify(req.messages)).toContain("interjection: also check the tests");
    await sleep(300);
    expect(
      await db.selectFrom("runs").select("id").where("conversation_id", "=", conv).execute(),
    ).toEqual([{ id: runId }]);
  }, 60_000);

  it("waiting time goes into waited_ms, not the parent's deadline", async () => {
    const { conv, runId } = await startPaused("SCENARIO one");
    // longer than runtime.maxRunSeconds (3 s)
    await sleep(3_500);
    await subQueue.resume();
    const [t] = await waitForTerminal(db, conv, 1, 20_000);
    expect(t?.type).toBe("run_finished");
    expect(t?.payload).toMatchObject({ reason: "completed" });
    const run = await db
      .selectFrom("runs")
      .select("waited_ms")
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    expect(Number(run.waited_ms)).toBeGreaterThanOrEqual(3_000);
  }, 60_000);
});

describe("a child stopped outside its worker reports to the parent at once", () => {
  const abortChild = (child: string) =>
    owner({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations/${child}/abort` });

  it("stopping a child that waits on an approval resumes the parent without the sweep", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO write");
    const { children } = await parentWaiting(db, conv, 1);
    const child = children[0] as (typeof children)[number];
    await waitFor(
      async () => (await runStatus(db, child.runId)) === "waiting",
      20_000,
      "child waiting on its approval",
    );
    const res = await abortChild(child.conversationId);
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, conv, 1, 10_000);
    const events = await eventsOf(db, conv);
    expect(ofType(events, "subagent_finished")[0]?.payload.status).toBe("aborted");
    expect(agentResults(events)[0]?.payload.content).toContain("stopped by the user");
    expect(finalText(events)).toBe("parent done");
  }, 60_000);

  it("stopping a queued child no worker holds resumes the parent without the sweep", async () => {
    const { conv, children } = await startPaused("SCENARIO one");
    const child = children[0] as (typeof children)[number];
    await dropChildJobs(subQueue, [child.conversationId]);
    await backdateRun(db, child.runId);
    const res = await abortChild(child.conversationId);
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, conv, 1, 10_000);
    expect(await runStatus(db, child.runId)).toBe("aborted");
    const events = await eventsOf(db, conv);
    expect(agentResults(events)[0]?.payload.content).toContain("stopped by the user");
  }, 60_000);
});

describe("recovery by the wait sweep", () => {
  it("crash after the dispatch commit, before the enqueue: the sweep re-enqueues, no second dispatch", async () => {
    const { conv, children } = await startPaused("SCENARIO one");
    const child = children[0] as (typeof children)[number];
    expect(await dropChildJobs(subQueue, [child.conversationId])).toBe(1);
    await subQueue.resume();
    await sleep(300);
    expect(await runStatus(db, child.runId)).toBe("queued");
    // within the grace period nothing happens
    expect((await k.runs.waits.sweep()).requeued).toBe(0);
    await backdateRun(db, child.runId);
    const out = await k.runs.waits.sweep();
    expect(out.requeued).toBe(1);
    await waitForTerminal(db, conv, 1, 20_000);
    const events = await eventsOf(db, conv);
    expect(finalText(events)).toBe("parent done");
    expect(agentResults(events)[0]?.payload.content).toMatch(/^child ok\n\n\[agentId: /);
    expect(await childRunsOf(db, conv)).toEqual([{ ...child, status: "completed" }]);
    expect(ofType(events, "subagent_dispatched")).toHaveLength(1);
  }, 60_000);

  it("a running child without job or lock: the sweep fails it run.orphaned and the parent resumes", async () => {
    const { conv, children } = await startPaused("SCENARIO one");
    const child = children[0] as (typeof children)[number];
    await dropChildJobs(subQueue, [child.conversationId]);
    await db
      .updateTable("runs")
      .set({ status: "running", started_at: new Date() })
      .where("id", "=", child.runId)
      .execute();
    await backdateRun(db, child.runId);
    const out = await k.runs.waits.sweep();
    expect(out.orphaned).toBe(1);
    await waitForTerminal(db, conv, 1, 20_000);
    const cev = await eventsOf(db, child.conversationId);
    expect(ofType(cev, "run_failed")[0]?.payload.error.code).toBe("run.orphaned");
    const events = await eventsOf(db, conv);
    expect(agentResults(events)[0]?.payload).toMatchObject({ isError: true });
    expect(agentResults(events)[0]?.payload.content).toContain("failed (run.orphaned)");
    expect(finalText(events)).toBe("parent done");
  }, 60_000);

  it("child finisher crash: the sweep resumes the parent, which writes the missing subagent_finished", async () => {
    const { conv, runId, children } = await startPaused("SCENARIO one");
    const child = children[0] as (typeof children)[number];
    await dropChildJobs(subQueue, [child.conversationId]);
    await finishChildByHand(db, k.runs.eventLog, child, "finished alone");
    await sleep(300);
    expect(await runStatus(db, runId)).toBe("waiting");
    expect(ofType(await eventsOf(db, conv), "subagent_finished")).toEqual([]);
    expect((await k.runs.waits.sweep()).resumed).toBe(0);
    await backdateRun(db, runId);
    expect((await k.runs.waits.sweep()).resumed).toBe(1);
    await waitForTerminal(db, conv, 1, 20_000);
    const events = await eventsOf(db, conv);
    expect(finalText(events)).toBe("parent done");
    expect(ofType(events, "subagent_finished")).toHaveLength(1);
    expect(agentResults(events)[0]?.payload.content).toMatch(/^finished alone\n\n/);
    // the resume job is named after the child, as the finisher would have named it
    const run = await db
      .selectFrom("runs")
      .select("job_id")
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    expect(run.job_id).toBe(resumeJobId(conv, child.runId));
  }, 60_000);

  it("the sweep leaves a parent alone while a child is still active", async () => {
    const { runId } = await startPaused("SCENARIO one");
    await backdateRun(db, runId);
    const out = await k.runs.waits.sweep();
    expect(out).toMatchObject({ resumed: 0, requeued: 0, orphaned: 0, stopped: 0 });
    expect(await runStatus(db, runId)).toBe("waiting");
  }, 60_000);

  it("the sweep stops the active children of a finished parent", async () => {
    const { conv, runId, children } = await startPaused("SCENARIO one");
    const child = children[0] as (typeof children)[number];
    // the parent ended without stopping its child (e.g. a crash between the two)
    await finishRun(db, k.runs.eventLog, {
      conversationId: conv,
      runId,
      status: "aborted",
      consumed: null,
      event: { type: "run_aborted", payload: { byAccountId: null, reason: "user" } },
    });
    expect((await k.runs.waits.sweep()).stopped).toBe(0);
    await backdateRun(db, runId);
    expect((await k.runs.waits.sweep()).stopped).toBe(1);
    await subQueue.resume();
    await waitFor(
      async () => (await runStatus(db, child.runId)) === "aborted",
      20_000,
      "child aborted",
    );
    // the stop can land during the child's first request (its reply then ends "aborted")
    const cev = await eventsOf(db, child.conversationId);
    expect(ofType(cev, "run_aborted")).toHaveLength(1);
    expect(ofType(cev, "run_finished")).toEqual([]);
    expect(ofType(cev, "assistant_message").map((m) => m.payload.stopReason)).not.toContain(
      "end_turn",
    );
    // the finished parent still gets the child's record, and is not resumed
    await waitForEvent(db, conv, (e) => e.type === "subagent_finished", 10_000);
    expect(await runStatus(db, runId)).toBe("aborted");
  }, 60_000);

  it("a sub-agents wait timeout stops the remaining children and the parent goes on", async () => {
    const { conv, runId, children } = await startPaused("SCENARIO one");
    const child = children[0] as (typeof children)[number];
    await k.runs.waits.expire("subagents", `sa-${runId}-1`, { runId, step: 1 });
    await subQueue.resume();
    await waitForTerminal(db, conv, 1, 20_000);
    expect(await runStatus(db, child.runId)).toBe("aborted");
    const events = await eventsOf(db, conv);
    expect(agentResults(events)[0]?.payload).toMatchObject({ isError: true });
    expect(finalText(events)).toBe("parent done");
  }, 60_000);

  it("a timeout of an earlier step's wait stops nothing", async () => {
    const { runId, children } = await startPaused("SCENARIO one");
    await k.runs.waits.expire("subagents", `sa-${runId}-7`, { runId, step: 7 });
    await sleep(300);
    expect(await runStatus(db, (children[0] as (typeof children)[number]).runId)).toBe("queued");
    expect(await runStatus(db, runId)).toBe("waiting");
  }, 60_000);
});
