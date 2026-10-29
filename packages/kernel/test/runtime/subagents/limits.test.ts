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
import { type KernelSchemaDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import type { Kernel } from "../../../src/kernel.js";
import { SUBAGENT_RUN_QUEUE_NAME } from "../../../src/runtime/run-queue.js";
import { subagentLimits } from "../../../src/runtime/subagents/limits.js";
import { AGENT_REFUSALS } from "../../../src/tools/builtins/agent.js";
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
  waitForTerminal,
} from "../../helpers/runs.js";
import { childRunsOf, parentWaiting } from "../../helpers/subagents.js";

/**
 * Phase C Task 10: the per-run sub-agent limits (concurrency, dispatch count, tokens), the
 * organization overrides, the parent run's token counter and the `budget` finish of a child.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");

const CHILD = "You are a sub-agent";
const call = (prompt: string) => ({ name: "agent", input: { description: "Task", prompt } });
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
      toolCalls: [{ name: "sandbox_write", input: { path: "/workspace/l.txt", content: "l" } }],
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
    when: { lastUserIncludes: "SCENARIO two", assistantTurns: 0 },
    reply: { toolCalls: calls("lim-", 2) },
  },
  {
    when: { lastUserIncludes: "SCENARIO many", assistantTurns: 0 },
    reply: { toolCalls: calls("m1-", 20) },
  },
  {
    when: { lastUserIncludes: "SCENARIO many", assistantTurns: 1 },
    reply: { toolCalls: calls("m2-", 20) },
  },
  {
    when: { lastUserIncludes: "SCENARIO many", assistantTurns: 2 },
    reply: { toolCalls: calls("m3-", 11) },
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
    when: { lastUserIncludes: "SCENARIO cap", assistantTurns: 1 },
    reply: { toolCalls: [call("big-2")] },
  },
  { when: { lastToolResultIncludes: "agentId" }, reply: { text: "parent done" } },
  { when: { lastToolResultIncludes: "Sub-agents" }, reply: { text: "parent done" } },
];

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: Kernel;
let root: string;
let subQueue: Queue;
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
        runtime: { orgConcurrency: 30, workerConcurrency: 20 },
      },
    ),
  );
  subQueue = new Queue(SUBAGENT_RUN_QUEUE_NAME, { connection: new Redis(rd.url) });
}, 180_000);

afterAll(async () => {
  capture.restore();
  await subQueue?.close();
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
    "capybara.deployment_settings, capybara.audit_events, capybara.subagent_dispatches, capybara.sandboxes, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  capture.reset();
  scriptRules([]);
  await accountsFor(db).createLocal({
    login: "owner",
    password: PW,
    displayName: "O",
    enterpriseAdmin: true,
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
        tools: ["agent", "sandbox_write"].map((name) => ({ kind: "builtin", name })),
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
  ofType(events, "tool_result").filter((r) => r.payload.toolKey === "agent");
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
  const run = await db
    .selectFrom("runs")
    .select(["id", "subagent_tokens_used"])
    .where("conversation_id", "=", conv)
    .executeTakeFirstOrThrow();
  return { conv, run, events: await eventsOf(db, conv) };
}

describe("subagentLimits", () => {
  it("the config values, then the organization's override value by value", async () => {
    expect(await subagentLimits(db, { get: () => k.config }, orgId)).toEqual({
      maxConcurrentPerRun: 4,
      maxDispatchesPerRun: 50,
      maxTokensPerRun: 5_000_000,
    });
    await override({ maxTokensPerRun: 20_000 });
    expect(await subagentLimits(db, { get: () => k.config }, orgId)).toEqual({
      maxConcurrentPerRun: 4,
      maxDispatchesPerRun: 50,
      maxTokensPerRun: 20_000,
    });
    expect((await subagentLimits(db, { get: () => k.config }, "another-org")).maxTokensPerRun).toBe(
      5_000_000,
    );
    // out of bounds or unknown keys are refused; null removes the override
    for (const bad of [
      { maxConcurrentPerRun: 21 },
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
    expect((await subagentLimits(db, { get: () => k.config }, orgId)).maxTokensPerRun).toBe(
      5_000_000,
    );
  });
});

describe("concurrency", () => {
  it("five calls with maxConcurrentPerRun 3: three dispatched, two refused with the exact text", async () => {
    await override({ maxConcurrentPerRun: 3 });
    await subQueue.pause();
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO five");
    await parentWaiting(db, conv, 3);
    // the refusals are written before the wait, the dispatched calls stay open
    const waiting = agentResults(await eventsOf(db, conv));
    expect(waiting.map((r) => [r.payload.content, r.payload.isError])).toEqual([
      [AGENT_REFUSALS.tooManyConcurrent(3), true],
      [AGENT_REFUSALS.tooManyConcurrent(3), true],
    ]);
    await subQueue.resume();
    await waitForTerminal(db, conv, 1, 30_000);
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
    expect(req.tools?.find((t) => t.name === "agent")?.description).toContain(
      "(at most 3 at a time)",
    );
  }, 60_000);

  it("an org override lowers the cap, and the agent tool description shows it", async () => {
    const before = await converse("SCENARIO two");
    expect(agentResults(before.events).every((r) => !r.payload.isError)).toBe(true);
    const first = capture.sent.find((r) => !isChildRequest(r)) as ModelRequest;
    expect(first.tools?.find((t) => t.name === "agent")?.description).toContain(
      "(at most 4 at a time)",
    );
    await override({ maxConcurrentPerRun: 1 });
    capture.reset();
    await subQueue.pause();
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO two");
    await parentWaiting(db, conv, 1);
    await subQueue.resume();
    await waitForTerminal(db, conv, 1, 30_000);
    const events = await eventsOf(db, conv);
    expect(agentResults(events).map((r) => r.payload.isError)).toEqual([true, false]);
    expect(agentResults(events)[0]?.payload.content).toBe(AGENT_REFUSALS.tooManyConcurrent(1));
    const req = capture.sent.find((r) => !isChildRequest(r)) as ModelRequest;
    expect(req.tools?.find((t) => t.name === "agent")?.description).toContain(
      "(at most 1 at a time)",
    );
  }, 60_000);
});

describe("dispatch count", () => {
  it("the 51st dispatch of a run is refused", async () => {
    await override({ maxConcurrentPerRun: 20 });
    const { conv, events } = await converse("SCENARIO many", 120_000);
    expect(finalText(events)).toBe("parent done");
    expect(await childRunsOf(db, conv)).toHaveLength(50);
    // exactly one refusal: the last call of the third response
    const refused = agentResults(events).filter((r) => r.payload.isError);
    expect(refused.map((r) => r.payload.content)).toEqual([AGENT_REFUSALS.tooManyDispatches(50)]);
    const third = ofType(events, "assistant_message")[2]?.payload.content.flatMap((b) =>
      b.type === "tool_call" ? [b.id] : [],
    );
    expect(refused[0]?.payload.callId).toBe(third?.at(-1));
  }, 180_000);
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
    const [result] = agentResults(events);
    expect(result?.payload.isError).toBe(true);
    expect(result?.payload.content).toMatch(
      /^working\n\n\[agentId: [^ ]+ · stopped: token budget used up · 1 tool call · /,
    );
  }, 60_000);

  it("a dispatch at the cap is refused", async () => {
    await override({ maxTokensPerRun: 10_000 });
    const { conv, events } = await converse("SCENARIO cap");
    expect(finalText(events)).toBe("parent done");
    expect(await childRunsOf(db, conv)).toHaveLength(1);
    const results = agentResults(events);
    expect(results[0]?.payload.content).toMatch(/^big done\n\n/);
    expect(results[1]?.payload).toMatchObject({
      isError: true,
      content: AGENT_REFUSALS.budget(10_000),
    });
    expect(AGENT_REFUSALS.budget(10_000)).toBe(
      "Sub-agents of this run have used their token budget (10,000 tokens); do the remaining work yourself.",
    );
  }, 60_000);
});
