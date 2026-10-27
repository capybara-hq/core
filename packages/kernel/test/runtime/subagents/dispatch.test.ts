import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeStoredDefinition } from "../../../src/agents/definition.js";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { AccountsService } from "../../../src/identity/accounts.js";
import type { Kernel } from "../../../src/kernel.js";
import { BEHAVIOR_RULES } from "../../../src/runtime/context/build.js";
import { type DispatchDeps, dispatchSubagent } from "../../../src/runtime/subagents/dispatch.js";
import { SUBAGENT_PREAMBLE } from "../../../src/runtime/subagents/preamble.js";
import { AGENT_REFUSALS } from "../../../src/tools/builtins/agent.js";
import { hookDeniedText } from "../../../src/tools/pipeline.js";
import { type ScriptRule, scriptRules } from "../../fixtures/plugins/model-script/index.js";
import { truncateTables } from "../../helpers/db.js";
import { testMembers } from "../../helpers/members.js";
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

/**
 * Phase C Task 8: dispatching sub-agents as child runs on one kernel (`model-script` scripts the
 * parent and the children, `sandbox-fake` is the shared sandbox, `hooks-probe` the policy hook).
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");
const HOOKS_PROBE = fixture("hooks-probe");

const CHILD = "You are a sub-agent";
const INSTRUCTIONS = "Lead the work.";

const agentCall = (input: Record<string, unknown>) => ({ name: "agent", input });

/** The static rules: children first (their system text carries the preamble). */
const RULES: ScriptRule[] = [
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "child-sbx", assistantTurns: 0 },
    reply: {
      toolCalls: [
        {
          name: "sandbox_write",
          input: { path: "/workspace/from-child.txt", content: "hi from child" },
        },
      ],
    },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "child-sbx", assistantTurns: 1 },
    reply: { text: "wrote it" },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "par-" },
    reply: { text: "parallel ok", barrier: { name: "three", count: 3, timeoutMs: 8000 } },
  },
  { when: { systemIncludes: CHILD, lastUserIncludes: "what word" }, reply: { text: "recalled" } },
  { when: { systemIncludes: CHILD, lastUserIncludes: "remember" }, reply: { text: "noted" } },
  { when: { systemIncludes: CHILD, lastUserIncludes: "gp-task" }, reply: { text: "gp reply" } },
  { when: { systemIncludes: CHILD, lastUserIncludes: "loop-task" }, reply: { text: "looped" } },
  // parents
  {
    when: { lastUserIncludes: "SCENARIO sandbox", assistantTurns: 0 },
    reply: {
      toolCalls: [agentCall({ description: "Write a file", prompt: "child-sbx: write the file" })],
    },
  },
  {
    when: { lastToolResultIncludes: "wrote it" },
    reply: { toolCalls: [{ name: "sandbox_read", input: { path: "/workspace/from-child.txt" } }] },
  },
  { when: { lastToolResultIncludes: "hi from child" }, reply: { text: "parent saw the file" } },
  {
    when: { lastUserIncludes: "SCENARIO general", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "General task", prompt: "gp-task: do it" })] },
  },
  { when: { lastToolResultIncludes: "gp reply" }, reply: { text: "parent done" } },
  {
    when: { lastUserIncludes: "SCENARIO parallel", assistantTurns: 0 },
    reply: {
      toolCalls: [1, 2, 3].map((n) =>
        agentCall({ description: `Part ${n}`, prompt: `par-${n}: do part ${n}` }),
      ),
    },
  },
  { when: { lastToolResultIncludes: "parallel ok" }, reply: { text: "all three done" } },
  {
    when: { lastUserIncludes: "SCENARIO resume", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Memo", prompt: "remember the word kiwi" })] },
  },
  {
    when: { lastUserIncludes: "SCENARIO base", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Memo", prompt: "remember the word kiwi" })] },
  },
  {
    when: { lastUserIncludes: "SCENARIO base", lastToolResultIncludes: "noted" },
    reply: { text: "base done" },
  },
  {
    when: { lastToolResultIncludes: "noted" },
    reply: {
      toolCalls: [
        agentCall({
          description: "Follow up",
          prompt: "what word did I give you?",
          resume: "{{lastAgentId}}",
        }),
      ],
    },
  },
  { when: { lastToolResultIncludes: "recalled" }, reply: { text: "resume done" } },
  {
    when: { lastUserIncludes: "SCENARIO hook", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Hooked", prompt: "gp-task: hooked" })] },
  },
  { when: { lastToolResultIncludes: "policy hook" }, reply: { text: "hook seen" } },
  {
    when: { lastUserIncludes: "SCENARIO steps", assistantTurns: 0 },
    reply: {
      toolCalls: [
        agentCall({ description: "Loop", prompt: "loop-task: go", subagent_type: "looper" }),
      ],
    },
  },
  { when: { lastToolResultIncludes: "looped" }, reply: { text: "steps done" } },
  // a later run of the same conversation sends the earlier child a follow-up (final review I1)
  {
    when: { lastUserIncludes: "SCENARIO again" },
    reply: {
      toolCalls: [
        agentCall({
          description: "Follow up",
          prompt: "what word did I give you?",
          resume: "{{lastAgentId}}",
        }),
      ],
    },
  },
];

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let k: Kernel;
let root: string;
const capture = captureProviderRequests();

beforeAll(async () => {
  capture.install();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  root = await mkdtemp(join(tmpdir(), "cap-subagents-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE, HOOKS_PROBE],
        extensionConfig: { "model-script": { rules: RULES }, "sandbox-fake": { root } },
      },
    ),
  );
}, 180_000);

afterAll(async () => {
  capture.restore();
  await k?.stop();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

let owner: Req;
let ownerId: string;
let otherId: string;
let orgId: string;
let agentId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.audit_events, capybara.subagent_dispatches, capybara.sandboxes, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  capture.reset();
  scriptRules([]);
  const accounts = new AccountsService(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  otherId = (await accounts.createLocal({ login: "other", password: PW, displayName: "X" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, otherId, "member", ownerId);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Lead",
        instructions: INSTRUCTIONS,
        model: { provider: "model-script", model: "script-1" },
        tools: ["agent", "sandbox_write", "sandbox_read", "sandbox_deliver"].map((name) => ({
          kind: "builtin",
          name,
        })),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterEach(() => {
  scriptRules([]);
});

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};

const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);

const toolResults = (events: ConversationEvent[]) => ofType(events, "tool_result");

async function children(parent: string): Promise<{ id: string; subagent_type: string | null }[]> {
  return db
    .selectFrom("conversations")
    .select(["id", "subagent_type"])
    .where("parent_conversation_id", "=", parent)
    .orderBy("created_at")
    .execute();
}

/** Starts a conversation of the Lead agent with `text` and waits for its first terminal event. */
async function converse(
  text: string,
  n = 1,
): Promise<{ conv: string; events: ConversationEvent[] }> {
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, text);
  await waitForTerminal(db, conv, n, 30_000);
  return { conv, events: await eventsOf(db, conv) };
}

const finalText = (events: ConversationEvent[]) =>
  ofType(events, "assistant_message")
    .at(-1)
    ?.payload.content.flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("");

const isChildRequest = (r: ModelRequest) => r.system.some((s) => s.text.includes(CHILD));

describe("dispatch", () => {
  it("a child's sandbox_write lands in the parent conversation's sandbox", async () => {
    const { conv, events } = await converse("SCENARIO sandbox");
    expect(finalText(events)).toBe("parent saw the file");
    const read = toolResults(events).find((r) => r.payload.toolKey === "sandbox_read");
    expect(read?.payload.content).toContain("hi from child");
    const [child] = await children(conv);
    const sandboxes = await db.selectFrom("sandboxes").select("conversation_id").execute();
    expect(sandboxes.map((s) => s.conversation_id)).toEqual([conv]);
    expect(child).toBeDefined();
  }, 60_000);

  it("a general-purpose dispatch: child log, the child's first request and the parent's result", async () => {
    const { conv, events } = await converse("SCENARIO general");
    expect(finalText(events)).toBe("parent done");
    const kids = await children(conv);
    expect(kids).toHaveLength(1);
    const child = kids[0] as { id: string; subagent_type: string | null };
    expect(child.subagent_type).toBe("general-purpose");

    const cev = await eventsOf(db, child.id);
    expect(cev.slice(0, 2).map((e) => e.type)).toEqual(["subagent_started", "user_message"]);
    const started = cev[0] as Ev<"subagent_started">;
    const run = await db
      .selectFrom("runs")
      .select(["id", "trigger_account_id", "agent_version"])
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    expect(started.payload).toMatchObject({
      agentType: "general-purpose",
      template: { source: "general" },
      preamble: SUBAGENT_PREAMBLE,
      parent: { conversationId: conv, runId: run.id, step: 1 },
    });
    expect(started.payload.definition.tools.map((t) => (t as { name: string }).name)).toEqual([
      "sandbox_write",
      "sandbox_read",
    ]);
    const task = cev[1] as Ev<"user_message">;
    expect(task.payload).toMatchObject({
      content: [{ type: "text", text: "gp-task: do it" }],
      authorAccountId: ownerId,
      dispatch: { parentConversationId: conv, parentRunId: run.id },
    });

    // the child's first request: system = rules + preamble + instructions, then only the prompt
    const first = capture.sent.find(isChildRequest) as ModelRequest;
    expect(first.system.map((s) => s.text)).toEqual([
      `${BEHAVIOR_RULES}\n\n${SUBAGENT_PREAMBLE}\n\n${INSTRUCTIONS}`,
    ]);
    expect(first.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "gp-task: do it" }] },
    ]);
    // a child never sees the agent tool; the parent does
    expect(first.tools?.map((t) => t.name).sort()).toEqual(["sandbox_read", "sandbox_write"]);
    const parentReq = capture.sent.find((r) => !isChildRequest(r)) as ModelRequest;
    expect(parentReq.tools?.map((t) => t.name)).toContain("agent");

    // the parent's result: the reply plus the status line
    const result = toolResults(events).find((r) => r.payload.toolKey === "agent");
    expect(result?.payload.isError).toBe(false);
    expect(result?.payload.content).toMatch(
      new RegExp(
        `^gp reply\\n\\n\\[agentId: ${child.id} · completed · 0 tool calls · \\d+s · 15 tokens\\. Pass the agentId as resume to send this sub-agent a follow-up\\.\\]$`,
      ),
    );
    // agent calls write no tool_call_started
    expect(
      ofType(events, "tool_call_started").filter((e) => e.payload.toolKey === "agent"),
    ).toEqual([]);
    // parent log: subagent_dispatched then subagent_finished
    const dispatched = ofType(events, "subagent_dispatched");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.payload).toMatchObject({
      subagentId: child.id,
      agentType: "general-purpose",
      description: "General task",
      resumed: false,
      model: { provider: "model-script", model: "script-1" },
    });
    const finished = ofType(events, "subagent_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload).toMatchObject({
      subagentId: child.id,
      status: "completed",
      toolCalls: 0,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    // the audit row
    const rows = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "target", "detail"])
      .where("action", "=", "subagent.dispatched")
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_account_id: ownerId, target: child.id });
    expect(rows[0]?.detail).toMatchObject({
      parentConversationId: conv,
      parentRunId: run.id,
      agentType: "general-purpose",
      source: "general",
    });
  }, 60_000);

  it("three agent calls in one response run concurrently and the parent continues once", async () => {
    const { conv, events } = await converse("SCENARIO parallel");
    expect(finalText(events)).toBe("all three done");
    expect(await children(conv)).toHaveLength(3);
    const results = toolResults(events).filter((r) => r.payload.toolKey === "agent");
    expect(results).toHaveLength(3);
    // the barrier only opens when all three requests are in flight at once
    for (const r of results) expect(r.payload.content.startsWith("parallel ok\n\n")).toBe(true);
    // one run; the step after the dispatches made one model call
    const runs = await db
      .selectFrom("runs")
      .select("status")
      .where("conversation_id", "=", conv)
      .execute();
    expect(runs).toEqual([{ status: "completed" }]);
    expect(ofType(events, "model_call").filter((e) => e.payload.step === 2)).toHaveLength(1);
    expect(ofType(events, "subagent_finished")).toHaveLength(3);
  }, 60_000);

  it("resume appends a message to the same child conversation and the child sees its earlier history", async () => {
    const { conv, events } = await converse("SCENARIO resume");
    expect(finalText(events)).toBe("resume done");
    const kids = await children(conv);
    expect(kids).toHaveLength(1);
    const child = (kids[0] as { id: string }).id;
    const cev = await eventsOf(db, child);
    expect(ofType(cev, "user_message").map((e) => e.payload.content)).toEqual([
      [{ type: "text", text: "remember the word kiwi" }],
      [{ type: "text", text: "what word did I give you?" }],
    ]);
    expect(ofType(cev, "subagent_started")).toHaveLength(1);
    const childRuns = await db
      .selectFrom("runs")
      .select("status")
      .where("conversation_id", "=", child)
      .execute();
    expect(childRuns).toHaveLength(2);
    const rows = await db
      .selectFrom("subagent_dispatches")
      .select(["resumed", "child_conversation_id"])
      .where("parent_conversation_id", "=", conv)
      .orderBy("created_at")
      .execute();
    expect(rows).toEqual([
      { resumed: false, child_conversation_id: child },
      { resumed: true, child_conversation_id: child },
    ]);
    const followUp = capture.sent.find(
      (r) => isChildRequest(r) && JSON.stringify(r.messages).includes("what word"),
    ) as ModelRequest;
    expect(JSON.stringify(followUp.messages)).toContain("remember the word kiwi");
    expect(JSON.stringify(followUp.messages)).toContain("noted");
    const dispatched = ofType(events, "subagent_dispatched");
    expect(dispatched.map((d) => d.payload.resumed)).toEqual([false, true]);
  }, 60_000);

  it("a follow-up runs with the tools the parent's current version still has (final review I1)", async () => {
    const { conv, events } = await converse("SCENARIO base");
    expect(finalText(events)).toBe("base done");
    const save = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: {
        definition: {
          name: "Lead",
          instructions: INSTRUCTIONS,
          model: { provider: "model-script", model: "script-1" },
          tools: ["agent", "sandbox_read", "sandbox_deliver"].map((name) => ({
            kind: "builtin",
            name,
          })),
        },
      },
    });
    expect(save.statusCode, save.body).toBe(200);
    await postMessage(owner, orgId, conv, "SCENARIO again");
    await waitForTerminal(db, conv, 2, 30_000);
    expect(finalText(await eventsOf(db, conv))).toBe("resume done");
    const toolNames = (r: ModelRequest) => r.tools.map((t) => t.name).sort();
    const childRequests = capture.sent.filter(isChildRequest);
    const first = childRequests.find((r) => JSON.stringify(r.messages).includes("kiwi"));
    const followUp = childRequests.find((r) => JSON.stringify(r.messages).includes("what word"));
    expect(toolNames(first as ModelRequest)).toContain("sandbox_write");
    expect(toolNames(followUp as ModelRequest)).toContain("sandbox_read");
    expect(toolNames(followUp as ModelRequest)).not.toContain("sandbox_write");
    // the narrowed set is in the child's log, on the follow-up's task message
    const [child] = await children(conv);
    const tasks = ofType(await eventsOf(db, (child as { id: string }).id), "user_message");
    expect(tasks[0]?.payload.dispatch?.narrowed).toBeUndefined();
    expect(tasks[1]?.payload.dispatch?.narrowed?.tools).toEqual([
      { kind: "builtin", name: "sandbox_read" },
    ]);
  }, 60_000);

  it("a child's step reminder counts against its own maxSteps (final review m4)", async () => {
    const save = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: {
        definition: {
          name: "Lead",
          instructions: INSTRUCTIONS,
          model: { provider: "model-script", model: "script-1" },
          tools: ["agent", "sandbox_read"].map((name) => ({ kind: "builtin", name })),
          subagents: {
            inline: [
              { name: "looper", description: "Loops.", instructions: "You loop.", maxSteps: 3 },
            ],
          },
        },
      },
    });
    expect(save.statusCode, save.body).toBe(200);
    const { conv, events } = await converse("SCENARIO steps");
    expect(finalText(events)).toBe("steps done");
    const child = capture.sent.find(
      (r) => isChildRequest(r) && JSON.stringify(r.messages).includes("loop-task"),
    );
    expect(JSON.stringify(child)).toContain("step limit for this turn (step 1 of 3)");
    const [kid] = await children(conv);
    const reminders = ofType(await eventsOf(db, (kid as { id: string }).id), "reminder");
    expect(reminders.map((r) => r.payload.text).join("\n")).toContain("(step 1 of 3)");
  }, 60_000);

  it("refuses forged or foreign resume ids with the §4.5 text and starts nothing", async () => {
    // P1 with a finished child C1; P2 (same owner) with its child C2; C3 belongs to another person
    const p1 = await converse("SCENARIO base");
    expect(finalText(p1.events)).toBe("base done");
    const p2 = await converse("SCENARIO base");
    const c1 = ((await children(p1.conv))[0] as { id: string }).id;
    const c2 = ((await children(p2.conv))[0] as { id: string }).id;
    const otherConv = randomUUID();
    const c3 = randomUUID();
    await db
      .insertInto("conversations")
      .values([
        { id: otherConv, org_id: orgId, agent_id: agentId, account_id: otherId },
        {
          id: c3,
          org_id: orgId,
          agent_id: agentId,
          account_id: otherId,
          kind: "subagent",
          parent_conversation_id: otherConv,
          subagent_type: "general-purpose",
        },
      ])
      .execute();
    const resume = (id: string, extra: Record<string, unknown> = {}) =>
      agentCall({
        description: "Follow up",
        prompt: "what word did I give you?",
        resume: id,
        ...extra,
      });
    scriptRules([
      {
        when: { lastUserIncludes: "SCENARIO refuse", assistantTurns: 2 },
        reply: {
          toolCalls: [
            resume(c2),
            resume("not-an-id"),
            resume(c3),
            resume(c1, { subagent_type: "general-purpose" }),
            resume(c1),
            resume(c1),
          ],
        },
      },
      { when: { lastToolResultIncludes: "No sub-agent" }, reply: { text: "refusals seen" } },
    ]);
    const before = await db.selectFrom("subagent_dispatches").select("child_run_id").execute();
    await postMessage(owner, orgId, p1.conv, "SCENARIO refuse");
    await waitForTerminal(db, p1.conv, 2, 30_000);
    const events = await eventsOf(db, p1.conv);
    expect(finalText(events)).toBe("refusals seen");
    const step = ofType(events, "assistant_message").find((m) =>
      m.payload.content.some((b) => b.type === "tool_call" && JSON.stringify(b.input).includes(c2)),
    ) as Ev<"assistant_message">;
    const callIds = step.payload.content.flatMap((b) => (b.type === "tool_call" ? [b.id] : []));
    const byCall = new Map(toolResults(events).map((r) => [r.payload.callId, r.payload]));
    const results = callIds.map((id) => byCall.get(id));
    expect(results.map((r) => [r?.content, r?.isError])).toEqual([
      [AGENT_REFUSALS.noSuchAgent(c2), true],
      [AGENT_REFUSALS.noSuchAgent("not-an-id"), true],
      [AGENT_REFUSALS.noSuchAgent(c3), true],
      [AGENT_REFUSALS.resumeWithType, true],
      [expect.stringMatching(/^recalled\n\n\[agentId: /), false],
      [AGENT_REFUSALS.stillRunning(c1), true],
    ]);
    // exactly one new dispatch (the valid resume of C1); the foreign children got nothing
    const after = await db.selectFrom("subagent_dispatches").select("child_run_id").execute();
    expect(after.length - before.length).toBe(1);
    expect(ofType(await eventsOf(db, c2), "user_message")).toHaveLength(1);
    expect(ofType(await eventsOf(db, c3), "user_message")).toHaveLength(0);
    expect(
      await db.selectFrom("runs").select("id").where("conversation_id", "=", c3).execute(),
    ).toEqual([]);
  }, 90_000);

  it("posting to a child conversation is 409 conversation.read_only; reading it works", async () => {
    const { conv } = await converse("SCENARIO general");
    const child = ((await children(conv))[0] as { id: string }).id;
    const get = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/conversations/${child}` });
    expect(get.statusCode, get.body).toBe(200);
    const post = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${child}/messages`,
      payload: { text: "hello child" },
    });
    expect(post.statusCode, post.body).toBe(409);
    expect((post.json() as { error: { code: string } }).error.code).toBe("conversation.read_only");
    expect(ofType(await eventsOf(db, child), "user_message")).toHaveLength(1);
    // children are not listed as conversations of their own
    const list = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/conversations` });
    const ids = (list.json() as { conversations: { id: string }[] }).conversations.map((c) => c.id);
    expect(ids).toEqual([conv]);
  }, 60_000);

  it("a dispatch refused by tool.preExecute starts nothing", async () => {
    const enable = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/hooks-probe`,
      payload: { enabled: true },
    });
    expect(enable.statusCode, enable.body).toBe(200);
    const cfg = await owner({
      method: "POST",
      url: "/plugins/hooks-probe/config",
      payload: { orgId, denyTools: ["agent"] },
    });
    expect(cfg.statusCode, cfg.body).toBe(200);
    const { conv, events } = await converse("SCENARIO hook");
    expect(finalText(events)).toBe("hook seen");
    const result = toolResults(events).find((r) => r.payload.toolKey === "agent");
    expect(result?.payload).toMatchObject({
      content: hookDeniedText("hooks-probe", "nope"),
      isError: true,
    });
    expect(await children(conv)).toEqual([]);
    expect(ofType(events, "subagent_dispatched")).toEqual([]);
    expect(await db.selectFrom("subagent_dispatches").select("child_run_id").execute()).toEqual([]);
  }, 60_000);
});

describe("dispatch idempotency under the parent run lock", () => {
  /** A `running` parent run of a new conversation, and the tool step context of its step 1. */
  async function parentRun() {
    const conv = await createConv(owner, orgId, agentId);
    const runId = randomUUID();
    await db
      .insertInto("runs")
      .values({
        id: runId,
        conversation_id: conv,
        status: "running",
        agent_version: 1,
        trigger_account_id: ownerId,
        trigger_seq: 0,
      })
      .execute();
    const v = await db
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", agentId)
      .where("version", "=", 1)
      .executeTakeFirstOrThrow();
    const ctx = {
      orgId,
      conversationId: conv,
      runId,
      step: 1,
      agentId,
      agentVersion: 1,
      agent: normalizeStoredDefinition(v.definition),
      accountId: ownerId,
      signal: new AbortController().signal,
    };
    return { conv, runId, ctx };
  }

  const enqueued: string[] = [];
  const deps = (): DispatchDeps => ({
    db,
    eventLog: k.runs.eventLog,
    purposes: k.purposes,
    registry: k.runs.registry,
    config: () => k.config,
    // the child runs are not executed here
    enqueue: async (_data, jobId) => {
      enqueued.push(jobId);
    },
    log: { error: () => {}, warn: () => {} },
  });
  const input = { description: "Task", prompt: "gp-task: twice" };

  it("the same call dispatched twice, in turn and at once: one child, the same childRunId", async () => {
    enqueued.length = 0;
    const { conv, ctx } = await parentRun();
    const first = await dispatchSubagent(deps(), { ctx, callId: "c1", input });
    const again = await dispatchSubagent(deps(), { ctx, callId: "c1", input });
    expect(first.kind).toBe("dispatched");
    expect(again).toEqual(first);
    const both = await Promise.all([
      dispatchSubagent(deps(), { ctx, callId: "c2", input }),
      dispatchSubagent(deps(), { ctx, callId: "c2", input }),
    ]);
    expect(both[0].kind).toBe("dispatched");
    expect(both[1]).toEqual(both[0]);
    expect(await children(conv)).toHaveLength(2);
    const rows = await db
      .selectFrom("subagent_dispatches")
      .select(["parent_call_id", "child_run_id"])
      .where("parent_conversation_id", "=", conv)
      .orderBy("parent_call_id")
      .execute();
    expect(rows.map((r) => r.parent_call_id)).toEqual(["c1", "c2"]);
    expect(ofType(await eventsOf(db, conv), "subagent_dispatched")).toHaveLength(2);
    // a call found already dispatched with its child still queued enqueues it again under the
    // same job id (BullMQ dedupes it; review M4): two distinct jobs
    expect(new Set(enqueued).size).toBe(2);
    expect(enqueued.length).toBeGreaterThan(2);
  }, 60_000);

  it("a follow-up to a child that is appending its usage is refused without a lock cycle (review I1)", async () => {
    const { conv, runId, ctx } = await parentRun();
    const first = await dispatchSubagent(deps(), { ctx, callId: "c1", input });
    if (first.kind !== "dispatched") throw new Error("not dispatched");
    const [child] = await children(conv);
    const childId = (child as { id: string }).id;
    // the child's run started and is in appendCounted: its conversation row, then the parent run
    await db
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", first.childRunId)
      .execute();
    let locked!: () => void;
    const holding = new Promise<void>((r) => {
      locked = r;
    });
    const append = db.transaction().execute(async (t) => {
      await t
        .selectFrom("conversations")
        .select("id")
        .where("id", "=", childId)
        .forUpdate()
        .executeTakeFirst();
      locked();
      await new Promise((r) => setTimeout(r, 300));
      await t
        .updateTable("runs")
        .set({ subagent_tokens_used: sql<string>`subagent_tokens_used + 1` })
        .where("id", "=", runId)
        .execute();
    });
    await holding;
    const followUp = dispatchSubagent(deps(), {
      ctx,
      callId: "c2",
      input: { description: "Again", prompt: "more", resume: childId },
    });
    const [out] = await Promise.all([followUp, append]);
    expect(out).toEqual({ kind: "refused", content: AGENT_REFUSALS.stillRunning(childId) });
  }, 60_000);

  /** Marks the child run of `out` finished, so a follow-up may start. */
  const settle = async (out: { kind: string; childRunId?: string }) => {
    if (out.kind !== "dispatched" || out.childRunId === undefined) throw new Error("refused");
    await db
      .updateTable("runs")
      .set({ status: "completed" })
      .where("id", "=", out.childRunId)
      .execute();
  };
  const followUpTask = async (childId: string) =>
    ofType(await eventsOf(db, childId), "user_message").at(-1)?.payload.dispatch;

  it("a follow-up drops a connector the parent lost and narrows `all` to its names (final review I1)", async () => {
    const { conv, ctx } = await parentRun();
    const gone = randomUUID();
    const kept = randomUUID();
    const v1 = {
      ...ctx.agent,
      tools: [
        ...ctx.agent.tools,
        { kind: "connector" as const, connectorId: gone, tools: "all" as const },
        { kind: "connector" as const, connectorId: kept, tools: "all" as const },
      ],
      // a general-purpose child takes the parent's org skills (and pins nothing)
      skills: { orgSkills: ["s-gone", "s-kept"] },
    };
    const first = await dispatchSubagent(deps(), {
      ctx: { ...ctx, agent: v1 },
      callId: "c1",
      input,
    });
    await settle(first);
    const [child] = await children(conv);
    const childId = (child as { id: string }).id;
    const v2 = {
      ...ctx.agent,
      tools: [
        ...ctx.agent.tools.filter((t) => t.kind !== "builtin" || t.name !== "sandbox_write"),
        { kind: "connector" as const, connectorId: kept, tools: ["lookup"] },
      ],
      skills: { orgSkills: ["s-kept"] },
    };
    const again = await dispatchSubagent(deps(), {
      ctx: { ...ctx, agent: v2 },
      callId: "c2",
      input: { description: "Again", prompt: "more", resume: childId },
    });
    expect(again.kind).toBe("dispatched");
    expect((await followUpTask(childId))?.narrowed).toEqual({
      tools: [
        { kind: "builtin", name: "sandbox_read" },
        { kind: "connector", connectorId: kept, tools: ["lookup"] },
      ],
      skills: { orgSkills: ["s-kept"] },
    });
  }, 60_000);

  it("a follow-up to a type the roster no longer offers is refused as unknown (final review I1)", async () => {
    const { conv, ctx } = await parentRun();
    const inline = {
      name: "rev",
      description: "Reviews",
      instructions: "Review it.",
    };
    const v1 = { ...ctx.agent, subagents: { inline: [inline] } };
    const first = await dispatchSubagent(deps(), {
      ctx: { ...ctx, agent: v1 },
      callId: "c1",
      input: { ...input, subagent_type: "rev" },
    });
    await settle(first);
    const general = await dispatchSubagent(deps(), {
      ctx: { ...ctx, agent: v1 },
      callId: "c2",
      input,
    });
    await settle(general);
    const [rev, gp] = (await children(conv)).map((c) => c.id) as [string, string];
    const v2 = { ...ctx.agent, subagents: { general: false } };
    const resume = (id: string, callId: string) =>
      dispatchSubagent(deps(), {
        ctx: { ...ctx, agent: v2 },
        callId,
        input: { description: "Again", prompt: "more", resume: id },
      });
    expect(await resume(rev, "c3")).toEqual({
      kind: "refused",
      content: AGENT_REFUSALS.unknownType("rev", []),
    });
    expect(await resume(gp, "c4")).toEqual({
      kind: "refused",
      content: AGENT_REFUSALS.unknownType("general-purpose", []),
    });
    // an inline template edited (not removed) keeps the type: the follow-up runs
    const v3 = { ...ctx.agent, subagents: { inline: [{ ...inline, instructions: "Changed." }] } };
    const ok = await dispatchSubagent(deps(), {
      ctx: { ...ctx, agent: v3 },
      callId: "c6",
      input: { description: "Again", prompt: "more", resume: rev },
    });
    expect(ok.kind).toBe("dispatched");
  }, 60_000);

  it("the dispatch locks the parent conversation before the parent run (final review m2)", async () => {
    const { conv, runId, ctx } = await parentRun();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const holding = new Promise<void>((r) => {
      locked = r;
    });
    // a stop path holds the conversation row (conversation -> run, run-finish.ts)
    const stop = db.transaction().execute(async (t) => {
      await t
        .selectFrom("conversations")
        .select("id")
        .where("id", "=", conv)
        .forUpdate()
        .executeTakeFirst();
      locked();
      await held;
    });
    await holding;
    const dispatch = dispatchSubagent(deps(), { ctx, callId: "c1", input });
    await new Promise((r) => setTimeout(r, 300));
    // while the dispatch waits for the conversation row it holds no lock on the run row
    const free = await db.transaction().execute(async (t) =>
      sql`select id from capybara.runs where id = ${runId} for update nowait`.execute(t).then(
        () => true,
        () => false,
      ),
    );
    release();
    await stop;
    expect(free).toBe(true);
    expect((await dispatch).kind).toBe("dispatched");
  }, 60_000);

  it("a parent run that is no longer running dispatches nothing", async () => {
    const { conv, runId, ctx } = await parentRun();
    await db.updateTable("runs").set({ status: "aborted" }).where("id", "=", runId).execute();
    const out = await dispatchSubagent(deps(), { ctx, callId: "c1", input });
    expect(out).toEqual({ kind: "refused", content: AGENT_REFUSALS.notAvailableHere });
    expect(await children(conv)).toEqual([]);
  }, 60_000);
});
