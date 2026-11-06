import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { KernelConfigService } from "../../../src/infra/config/kernel-config.service.js";
import { SUBAGENT_RUN_QUEUE_NAME } from "../../../src/runtime/run-queue.js";
import { StepLog } from "../../../src/runtime/step-log.js";
import type { DispatchCommit } from "../../../src/runtime/subagents/dispatch.js";
import {
  budgetRunOf,
  subagentBudgetUsedUp,
  subagentLimits,
} from "../../../src/runtime/subagents/limits.js";
import { SubagentsService } from "../../../src/runtime/subagents/subagents.service.js";
import { AGENT_REFUSALS, type AgentToolInputT } from "../../../src/tools/builtins/agent.js";
import type { ToolStepContext } from "../../../src/tools/pipeline.js";
import { type ScriptRule, scriptRules } from "../../fixtures/plugins/model-script/index.js";
import { truncateTables } from "../../helpers/db.js";
import { accountsFor } from "../../helpers/identity.js";
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
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../../helpers/runs.js";
import { childRunsOf, finishedDeliveries } from "../../helpers/subagents.js";

/**
 * Phase C Task 10: the per-run sub-agent limits (concurrency, dispatch count, tokens), the
 * organization overrides, the parent run's token counter and the `budget` finish of a child.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");

const CHILD = "You are a sub-agent";
const call = (prompt: string) => ({ name: "Agent", input: { description: "Task", prompt } });
const calls = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => call(`${prefix}${i + 1}`));

const RULES: ScriptRule[] = [
  // children
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "use-" },
    reply: { text: "used", usage: { inputTokens: 1000, outputTokens: 500 } },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "big-" },
    reply: { text: "big done", usage: { inputTokens: 12_000 } },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "loop-", assistantTurns: 0 },
    reply: {
      text: "working",
      toolCalls: [{ name: "Write", input: { file_path: "/workspace/l.txt", content: "l" } }],
      usage: { inputTokens: 12_000 },
    },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "loop-" },
    reply: { text: "a second request after the cap" },
  },
  { when: { systemIncludes: CHILD }, reply: { text: "child ok" } },
  // parents
  {
    when: { lastUserIncludes: "SCENARIO five", assistantTurns: 0 },
    reply: { toolCalls: calls("lim-", 5) },
  },
  {
    when: { lastUserIncludes: "SCENARIO one", assistantTurns: 0 },
    reply: { toolCalls: calls("one-", 1) },
  },
  {
    when: { lastUserIncludes: "SCENARIO two", assistantTurns: 0 },
    reply: { toolCalls: calls("lim-", 2) },
  },
  {
    when: { lastUserIncludes: "SCENARIO many", assistantTurns: 0 },
    reply: { toolCalls: calls("m1-", 3) },
  },
  {
    when: { lastUserIncludes: "SCENARIO many", assistantTurns: 1 },
    reply: { toolCalls: calls("m2-", 3) },
  },
  {
    when: { lastUserIncludes: "SCENARIO usage", assistantTurns: 0 },
    reply: { toolCalls: calls("use-", 2) },
  },
  {
    when: { lastUserIncludes: "SCENARIO over", assistantTurns: 0 },
    reply: { toolCalls: [call("loop-1")] },
  },
  {
    when: { lastUserIncludes: "SCENARIO cap", assistantTurns: 0 },
    reply: { toolCalls: [call("big-1")] },
  },
  {
    // a call that asks: the parent waits on its approval while the child finishes
    when: { lastUserIncludes: "SCENARIO cap", assistantTurns: 1 },
    reply: {
      toolCalls: [{ name: "Write", input: { file_path: "/workspace/p.txt", content: "p" } }],
    },
  },
  {
    when: { lastUserIncludes: "SCENARIO cap", assistantTurns: 2 },
    reply: { toolCalls: [call("big-2")] },
  },
  { when: { lastToolResultIncludes: "agentId" }, reply: { text: "parent done" } },
  { when: { lastToolResultIncludes: "Sub-agents" }, reply: { text: "parent done" } },
];

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;
let subQueue: Queue;
/**
 * The client the queue above uses. A queue given a client does not close it, so afterAll quits it
 * before Redis stops: an open client without an error listener reports "[ioredis] Unhandled error
 * event" on every reconnect, which can land after Vitest tore the worker down.
 */
const redisClients: Redis[] = [];
const redisClient = (): Redis => {
  const c = new Redis(rd.url);
  redisClients.push(c);
  return c;
};
const capture = captureProviderRequests();

beforeAll(async () => {
  capture.install();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  root = await mkdtemp(join(tmpdir(), "cap-subagents-limits-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE],
        extensionConfig: { "model-script": { rules: RULES }, "sandbox-fake": { root } },
        // these tests are about dispatch, not waking (subagents/wake.test.ts): a parent woken by
        // its children's deliveries would race their last-reply and one-run assertions
        runtime: { orgConcurrency: 30, workerConcurrency: 20, wakeOnBackgroundTask: false },
      },
    ),
  );
  subQueue = new Queue(SUBAGENT_RUN_QUEUE_NAME, { connection: redisClient() });
}, 180_000);

afterAll(async () => {
  capture.restore();
  await subQueue?.close();
  await Promise.all(redisClients.splice(0).map((c) => c.quit()));
  await k?.close();
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
    "capybara.deployment_settings, capybara.audit_events, capybara.subagent_dispatches, capybara.sandboxes, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  capture.reset();
  scriptRules([]);
  await accountsFor(db).createLocal({
    login: "owner",
    password: PW,
    displayName: "O",
    superAdmin: true,
  });
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
        tools: ["Agent", "Write"].map((name) => ({ kind: "builtin", name })),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterEach(async () => {
  await subQueue.resume();
});

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);
const agentResults = (events: ConversationEvent[]) =>
  ofType(events, "tool_result").filter((r) => r.payload.toolKey === "Agent");
const finalText = (events: ConversationEvent[]) =>
  ofType(events, "assistant_message")
    .at(-1)
    ?.payload.content.flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("");
const isChildRequest = (r: ModelRequest) => r.system.some((s) => s.text.includes(CHILD));

/** Sets this organization's sub-agent limit override through the admin API. */
async function override(o: Record<string, number> | null): Promise<void> {
  const res = await owner({
    method: "PUT",
    url: "/api/v1/admin/settings",
    payload: { subagentLimitOverrides: { [orgId]: o } },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function converse(text: string, timeoutMs = 30_000) {
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, text);
  await waitForTerminal(db, conv, 1, timeoutMs);
  // the children run in the background: wait for every one's finished delivery
  const dispatched = ofType(await eventsOf(db, conv), "subagent_dispatched").length;
  if (dispatched > 0) await finishedDeliveries(db, conv, dispatched, timeoutMs);
  const run = await db
    .selectFrom("runs")
    .select(["id", "subagent_tokens_used"])
    .where("conversation_id", "=", conv)
    .executeTakeFirstOrThrow();
  return { conv, run, events: await eventsOf(db, conv) };
}

const liveConfig = () => ({ get: () => k.app.get(KernelConfigService).get() });

async function accountOf(conv: string): Promise<string> {
  return (
    await db
      .selectFrom("conversations")
      .select("account_id")
      .where("id", "=", conv)
      .executeTakeFirstOrThrow()
  ).account_id;
}

/** Inserts a run of `conv` directly (no queue job); `budget` is its `budget_run_id`. */
async function seedRun(
  conv: string,
  status: "running" | "completed",
  budget: string | null,
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("runs")
    .values({
      id,
      conversation_id: conv,
      status,
      agent_version: 1,
      trigger_account_id: await accountOf(conv),
      trigger_seq: 0,
      budget_run_id: budget,
    })
    .execute();
  return id;
}

/** Inserts a child conversation of `parentConv` dispatched by `parentRun`, with its run. */
async function seedChild(
  parentConv: string,
  parentRun: string,
  budget: string,
  status: "running" | "completed",
): Promise<{ conv: string; run: string }> {
  const conv = randomUUID();
  await db
    .insertInto("conversations")
    .values({
      id: conv,
      org_id: orgId,
      agent_id: agentId,
      account_id: await accountOf(parentConv),
      kind: "subagent",
      parent_conversation_id: parentConv,
      subagent_type: "general-purpose",
    })
    .execute();
  const run = await seedRun(conv, status, budget);
  await db
    .insertInto("subagent_dispatches")
    .values({
      parent_run_id: parentRun,
      parent_call_id: randomUUID(),
      parent_conversation_id: parentConv,
      step: 0,
      child_conversation_id: conv,
      child_run_id: run,
      budget_run_id: budget,
    })
    .execute();
  return { conv, run };
}

/** One dispatch transaction of a general-purpose child from run `runId` of `conv`. */
async function dispatchFrom(
  conv: string,
  runId: string,
): Promise<{ out: DispatchCommit | null; childConv: string }> {
  const eventLog = k.app.get(EventLog);
  const account = await accountOf(conv);
  const childConv = randomUUID();
  const ctx = {
    orgId,
    conversationId: conv,
    runId,
    step: 0,
    agentId,
    agentVersion: 1,
    accountId: account,
  } as unknown as ToolStepContext;
  const out = await k.app.get(SubagentsService).commitDispatch(
    { ctx, callId: randomUUID(), input: { description: "Task", prompt: "p" } as AgentToolInputT },
    {
      childConversationId: childConv,
      agentType: "general-purpose",
      source: "general",
      agentId,
      agentVersion: 1,
      resumed: false,
      model: { provider: "model-script", model: "script-1" },
      tierFallback: false,
    },
    async (t) => {
      await t
        .insertInto("conversations")
        .values({
          id: childConv,
          org_id: orgId,
          agent_id: agentId,
          account_id: account,
          kind: "subagent",
          parent_conversation_id: conv,
          subagent_type: "general-purpose",
        })
        .execute();
      const [task] = await eventLog.appendIn(childConv, [
        {
          type: "user_message",
          payload: { content: [{ type: "text", text: "p" }], authorAccountId: account },
        },
      ]);
      return task ?? null;
    },
  );
  return { out, childConv };
}

describe("subagentLimits", () => {
  it("the config values, then the organization's override value by value", async () => {
    expect(
      await subagentLimits(db, { get: () => k.app.get(KernelConfigService).get() }, orgId),
    ).toEqual({
      maxDepth: 3,
      maxConcurrentPerConversation: 4,
      maxDispatchesPerRun: 50,
      maxTokensPerRun: 5_000_000,
    });
    await override({ maxTokensPerRun: 20_000 });
    expect(
      await subagentLimits(db, { get: () => k.app.get(KernelConfigService).get() }, orgId),
    ).toEqual({
      maxDepth: 3,
      maxConcurrentPerConversation: 4,
      maxDispatchesPerRun: 50,
      maxTokensPerRun: 20_000,
    });
    expect(
      (await subagentLimits(db, { get: () => k.app.get(KernelConfigService).get() }, "another-org"))
        .maxTokensPerRun,
    ).toBe(5_000_000);
    // out of bounds or unknown keys are refused; null removes the override
    for (const bad of [
      { maxConcurrentPerConversation: 21 },
      { maxConcurrentPerRun: 2 },
      { maxDepth: 0 },
      { maxDepth: 6 },
      { maxDispatchesPerRun: 0 },
      { maxTokensPerRun: 9_999 },
      { other: 1 },
      {},
    ]) {
      const res = await owner({
        method: "PUT",
        url: "/api/v1/admin/settings",
        payload: { subagentLimitOverrides: { [orgId]: bad } },
      });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    await override(null);
    expect(
      (await subagentLimits(db, { get: () => k.app.get(KernelConfigService).get() }, orgId))
        .maxTokensPerRun,
    ).toBe(5_000_000);
  });
});

describe("depth", () => {
  it("maxDepth defaults to 3 and an org override wins", async () => {
    expect((await subagentLimits(db, liveConfig(), orgId)).maxDepth).toBe(3);
    await override({ maxDepth: 1 });
    expect((await subagentLimits(db, liveConfig(), orgId)).maxDepth).toBe(1);
    expect((await subagentLimits(db, liveConfig(), "another-org")).maxDepth).toBe(3);
    await override({ maxDepth: 5 });
    expect((await subagentLimits(db, liveConfig(), orgId)).maxDepth).toBe(5);
  });
});

describe("concurrency", () => {
  it("concurrency counts active children of the parent conversation across its runs", async () => {
    const conv = await createConv(owner, orgId, agentId);
    // an earlier run of this conversation ended while four of its children still work
    const earlier = await seedRun(conv, "completed", null);
    for (let i = 0; i < 4; i++) await seedChild(conv, earlier, earlier, "running");
    await postMessage(owner, orgId, conv, "SCENARIO one");
    await waitForTerminal(db, conv, 1, 30_000);
    const events = await eventsOf(db, conv);
    expect(ofType(events, "subagent_dispatched")).toHaveLength(0);
    expect(agentResults(events).map((r) => [r.payload.content, r.payload.isError])).toEqual([
      [AGENT_REFUSALS.tooManyConcurrent(4), true],
    ]);
  }, 60_000);

  it("five calls with maxConcurrentPerConversation 3: three dispatched, two refused with the exact text", async () => {
    await override({ maxConcurrentPerConversation: 3 });
    await subQueue.pause();
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO five");
    // the parent never waits: its run ends while its three children are still queued
    await waitForTerminal(db, conv, 1, 30_000);
    const queued = agentResults(await eventsOf(db, conv));
    expect(queued.map((r) => r.payload.isError)).toEqual([false, false, false, true, true]);
    expect(queued.slice(3).map((r) => r.payload.content)).toEqual([
      AGENT_REFUSALS.tooManyConcurrent(3),
      AGENT_REFUSALS.tooManyConcurrent(3),
    ]);
    await subQueue.resume();
    await finishedDeliveries(db, conv, 3);
    const events = await eventsOf(db, conv);
    expect(finalText(events)).toBe("parent done");
    expect(ofType(events, "subagent_dispatched")).toHaveLength(3);
    // the calls beyond the limit are the last two of the response
    const step1 = ofType(events, "assistant_message")[0]?.payload.content.flatMap((b) =>
      b.type === "tool_call" ? [b.id] : [],
    ) as string[];
    const refused = agentResults(events)
      .filter((r) => r.payload.content === AGENT_REFUSALS.tooManyConcurrent(3))
      .map((r) => r.payload.callId);
    expect(refused).toEqual(step1.slice(3));
    // the description names the limit
    const req = capture.sent.find((r) => !isChildRequest(r)) as ModelRequest;
    expect(req.tools?.find((t) => t.name === "Agent")?.description).toContain(
      "(at most 3 of your sub-agents run at a time)",
    );
  }, 60_000);

  it("an org override lowers the cap, and the agent tool description shows it", async () => {
    const before = await converse("SCENARIO two");
    expect(agentResults(before.events).every((r) => !r.payload.isError)).toBe(true);
    const first = capture.sent.find((r) => !isChildRequest(r)) as ModelRequest;
    expect(first.tools?.find((t) => t.name === "Agent")?.description).toContain(
      "(at most 4 of your sub-agents run at a time)",
    );
    await override({ maxConcurrentPerConversation: 1 });
    capture.reset();
    await subQueue.pause();
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO two");
    await waitForTerminal(db, conv, 1, 30_000);
    await subQueue.resume();
    await finishedDeliveries(db, conv, 1);
    const events = await eventsOf(db, conv);
    expect(agentResults(events).map((r) => r.payload.isError)).toEqual([false, true]);
    expect(agentResults(events)[1]?.payload.content).toBe(AGENT_REFUSALS.tooManyConcurrent(1));
    const req = capture.sent.find((r) => !isChildRequest(r)) as ModelRequest;
    expect(req.tools?.find((t) => t.name === "Agent")?.description).toContain(
      "(at most 1 of your sub-agents run at a time)",
    );
  }, 60_000);
});

describe("dispatch count", () => {
  it("the dispatch past maxDispatchesPerRun is refused", async () => {
    // children of the first response may still run during the second: concurrency allows both
    await override({ maxConcurrentPerConversation: 20, maxDispatchesPerRun: 5 });
    const { conv, events } = await converse("SCENARIO many", 60_000);
    expect(finalText(events)).toBe("parent done");
    expect(await childRunsOf(db, conv)).toHaveLength(5);
    // exactly one refusal: the last call of the second response
    const refused = agentResults(events).filter((r) => r.payload.isError);
    expect(refused.map((r) => r.payload.content)).toEqual([AGENT_REFUSALS.tooManyDispatches(5)]);
    const second = ofType(events, "assistant_message")[1]?.payload.content.flatMap((b) =>
      b.type === "tool_call" ? [b.id] : [],
    );
    expect(refused[0]?.payload.callId).toBe(second?.at(-1));
  }, 90_000);
});

describe("tree budget", () => {
  it("dispatch and token caps count the whole tree on the budget run", async () => {
    await override({ maxConcurrentPerConversation: 20, maxTokensPerRun: 20_000 });
    const conv = await createConv(owner, orgId, agentId);
    // the person's run (its own budget run) dispatched 48 children; one of them still works
    const root = await seedRun(conv, "completed", null);
    for (let i = 0; i < 47; i++) await seedChild(conv, root, root, "completed");
    const child = await seedChild(conv, root, root, "running");
    // a later run of the root conversation that is not a person's (a wake run)
    const wake = await seedRun(conv, "running", root);
    expect(await budgetRunOf(db, root)).toBe(root);
    expect(await budgetRunOf(db, child.run)).toBe(root);
    expect(await budgetRunOf(db, wake)).toBe(root);

    // the child's dispatch: the 49th of the tree, counted on the root run
    const fromChild = await dispatchFrom(child.conv, child.run);
    expect(fromChild.out?.kind).toBe("written");
    const grandchildRun = (fromChild.out as { childRunId: string }).childRunId;
    const childRow = await db
      .selectFrom("subagent_dispatches")
      .select("budget_run_id")
      .where("child_run_id", "=", grandchildRun)
      .executeTakeFirstOrThrow();
    expect(childRow.budget_run_id).toBe(root);
    expect(await budgetRunOf(db, grandchildRun)).toBe(root);

    // the wake run's dispatch: the 50th
    const fromWake = await dispatchFrom(conv, wake);
    expect(fromWake.out?.kind).toBe("written");
    // the 51st, from either run, is refused
    for (const [c, r] of [
      [conv, wake],
      [child.conv, child.run],
    ] as const) {
      expect((await dispatchFrom(c, r)).out).toEqual({
        kind: "limit",
        content: AGENT_REFUSALS.tooManyDispatches(50),
      });
    }

    // the grandchild's usage is counted on the root run, not on the child run that dispatched it
    await k.app.get(StepLog).appendCounted(fromChild.childConv, { parentRunId: child.run }, [
      {
        type: "usage",
        payload: {
          step: 0,
          provider: "model-script",
          model: "script-1",
          inputTokens: 20_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    ]);
    const counters = await db
      .selectFrom("runs")
      .select(["id", "subagent_tokens_used"])
      .where("id", "in", [root, child.run])
      .execute();
    expect(Object.fromEntries(counters.map((r) => [r.id, Number(r.subagent_tokens_used)]))).toEqual(
      { [root]: 20_000, [child.run]: 0 },
    );
    expect(await subagentBudgetUsedUp(db, liveConfig(), orgId, root)).toBe(true);
    // at the token cap the tree's next dispatch is refused with the budget text
    expect((await dispatchFrom(child.conv, child.run)).out).toEqual({
      kind: "limit",
      content: AGENT_REFUSALS.budget(20_000),
    });
    await db
      .updateTable("runs")
      .set({ subagent_tokens_used: sql<string>`0` })
      .where("id", "=", root)
      .execute();
    expect(await subagentBudgetUsedUp(db, liveConfig(), orgId, root)).toBe(false);
  }, 60_000);
});

describe("tokens", () => {
  it("child usage sums into the parent run's counter", async () => {
    const { run, events } = await converse("SCENARIO usage");
    expect(finalText(events)).toBe("parent done");
    expect(Number(run.subagent_tokens_used)).toBe(3_000);
    // the parent's own usage is not counted
    expect(ofType(events, "usage").length).toBeGreaterThan(0);
  }, 60_000);

  it("over the cap a running child ends with budget and the parent's result says so", async () => {
    await override({ maxTokensPerRun: 10_000 });
    const { conv, run, events } = await converse("SCENARIO over");
    expect(finalText(events)).toBe("parent done");
    expect(Number(run.subagent_tokens_used)).toBe(12_005);
    const [child] = await childRunsOf(db, conv);
    const cev = await eventsOf(db, child?.conversationId as string);
    expect(ofType(cev, "run_finished")[0]?.payload.reason).toBe("budget");
    // no request after the cap
    expect(ofType(cev, "model_call")).toHaveLength(1);
    expect(ofType(events, "subagent_finished")[0]?.payload.status).toBe("budget");
    // its finish reaches the parent as a delivery with what it replied before the cap
    expect(ofType(events, "subagent_delivery").map((d) => d.payload)).toMatchObject([
      { kind: "finished", status: "budget", text: "working" },
    ]);
  }, 60_000);

  it("a dispatch at the cap is refused", async () => {
    await override({ maxTokensPerRun: 10_000 });
    const save = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: {
        definition: {
          name: "Lead",
          instructions: "Lead the work.",
          model: { provider: "model-script", model: "script-1" },
          tools: ["Agent", "Write"].map((name) => ({ kind: "builtin", name })),
          toolPolicies: { Write: "ask" },
        },
      },
    });
    expect(save.statusCode, save.body).toBe(200);
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO cap");
    // the first child finishes (its tokens counted) while the parent waits on its approval
    await finishedDeliveries(db, conv, 1);
    const approval = await waitFor(
      () =>
        db
          .selectFrom("approvals")
          .select("id")
          .where("conversation_id", "=", conv)
          .where("status", "=", "pending")
          .executeTakeFirst(),
      20_000,
      "the parent's approval",
    );
    const decided = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${approval.id}/decision`,
      payload: { decision: "approve", scope: "once" },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    await waitForTerminal(db, conv, 1, 30_000);
    const events = await eventsOf(db, conv);
    expect(finalText(events)).toBe("parent done");
    expect(await childRunsOf(db, conv)).toHaveLength(1);
    const results = agentResults(events);
    expect(results[0]?.payload.content).toContain("(running in the background)");
    expect(ofType(events, "subagent_delivery").map((d) => d.payload.text)).toEqual(["big done"]);
    expect(results[1]?.payload).toMatchObject({
      isError: true,
      content: AGENT_REFUSALS.budget(10_000),
    });
    expect(AGENT_REFUSALS.budget(10_000)).toBe(
      "Sub-agents have used their token budget since the user's latest message (10,000 tokens, counted across all levels of sub-agents); do the remaining work yourself.",
    );
  }, 60_000);
});
