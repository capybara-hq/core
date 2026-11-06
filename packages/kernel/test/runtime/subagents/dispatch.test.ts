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
import { EventLog } from "../../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { KernelConfigService } from "../../../src/infra/config/kernel-config.service.js";
import { ModelPurposesService } from "../../../src/models/purposes.js";
import { BEHAVIOR_RULES } from "../../../src/runtime/context/build.js";
import { ProviderRegistry } from "../../../src/runtime/providers.js";
import { type DispatchDeps, dispatchSubagent } from "../../../src/runtime/subagents/dispatch.js";
import { SUBAGENT_PREAMBLE } from "../../../src/runtime/subagents/preamble.js";
import { SubagentsService } from "../../../src/runtime/subagents/subagents.service.js";
import { AGENT_REFUSALS, agentStartedText } from "../../../src/tools/builtins/agent.js";
import { hookDeniedText } from "../../../src/tools/pipeline.js";
import { type ScriptRule, scriptRules } from "../../fixtures/plugins/model-script/index.js";
import { legacyDbFor } from "../../helpers/conversations.js";
import { truncateTables } from "../../helpers/db.js";
import { accountsFor } from "../../helpers/identity.js";
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
  type TestKernel,
  waitFor,
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

const agentCall = (input: Record<string, unknown>) => ({ name: "Agent", input });

/** The static rules: children first (their system text carries the preamble). */
const RULES: ScriptRule[] = [
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "child-sbx", assistantTurns: 0 },
    reply: {
      toolCalls: [
        {
          name: "Write",
          input: { file_path: "/workspace/from-child.txt", content: "hi from child" },
        },
      ],
    },
  },
  {
    // the child's last step meets the parent's next step: the file is written by then
    when: { systemIncludes: CHILD, lastUserIncludes: "child-sbx", assistantTurns: 1 },
    reply: { text: "wrote it", barrier: { name: "sbx", count: 2, timeoutMs: 8000 } },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "par-" },
    reply: { text: "parallel ok", barrier: { name: "three", count: 3, timeoutMs: 8000 } },
  },
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
    when: { lastUserIncludes: "SCENARIO sandbox", lastToolResultIncludes: "in the background" },
    reply: {
      toolCalls: [{ name: "Read", input: { file_path: "/workspace/from-child.txt" } }],
      barrier: { name: "sbx", count: 2, timeoutMs: 8000 },
    },
  },
  { when: { lastToolResultIncludes: "hi from child" }, reply: { text: "parent saw the file" } },
  {
    when: { lastUserIncludes: "SCENARIO general", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "General task", prompt: "gp-task: do it" })] },
  },
  {
    when: { lastUserIncludes: "SCENARIO parallel", assistantTurns: 0 },
    reply: {
      toolCalls: [1, 2, 3].map((n) =>
        agentCall({ description: `Part ${n}`, prompt: `par-${n}: do part ${n}` }),
      ),
    },
  },
  {
    when: { lastUserIncludes: "SCENARIO parallel", lastToolResultIncludes: "in the background" },
    reply: { text: "all three dispatched" },
  },
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
  // the parent goes on after an immediate `Agent` result (agent map spec §4.1)
  { when: { lastToolResultIncludes: "in the background" }, reply: { text: "parent done" } },
];

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;
const capture = captureProviderRequests();

beforeAll(async () => {
  capture.install();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
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
  await k?.close();
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
  const accounts = accountsFor(db);
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
        tools: ["Agent", "Write", "Read", "Deliver"].map((name) => ({
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

/** Waits until the parent has `n` finished deliveries (every child has ended); its log after. */
async function delivered(conv: string, n = 1): Promise<ConversationEvent[]> {
  return waitFor(
    async () => {
      const events = await eventsOf(db, conv);
      const finished = ofType(events, "subagent_delivery").filter(
        (e) => e.payload.kind === "finished",
      );
      return finished.length >= n ? events : null;
    },
    30_000,
    `${n} finished deliveries`,
  );
}

const deliveries = (events: ConversationEvent[]) => ofType(events, "subagent_delivery");

const finalText = (events: ConversationEvent[]) =>
  ofType(events, "assistant_message")
    .at(-1)
    ?.payload.content.flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("");

const isChildRequest = (r: ModelRequest) => r.system.some((s) => s.text.includes(CHILD));

describe("dispatch", () => {
  it("a child's Write lands in the parent conversation's sandbox", async () => {
    const { conv, events } = await converse("SCENARIO sandbox");
    // the parent went on while the child worked, and read the child's file
    expect(finalText(events)).toBe("parent saw the file");
    const read = toolResults(events).find((r) => r.payload.toolKey === "Read");
    expect(read?.payload.content).toContain("hi from child");
    const [child] = await children(conv);
    const sandboxes = await db.selectFrom("sandboxes").select("conversation_id").execute();
    expect(sandboxes.map((s) => s.conversation_id)).toEqual([conv]);
    expect(child).toBeDefined();
  }, 60_000);

  it("a general-purpose dispatch: child log, the child's first request and the parent's result", async () => {
    const { conv } = await converse("SCENARIO general");
    const events = await delivered(conv);
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
      "Agent",
      "Write",
      "Read",
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
    // a child at depth 1 keeps the agent tool below maxDepth (agent map spec §4.1)
    expect(first.tools?.map((t) => t.name).sort()).toEqual(["Agent", "Read", "Write"]);
    const parentReq = capture.sent.find((r) => !isChildRequest(r)) as ModelRequest;
    expect(parentReq.tools?.map((t) => t.name)).toContain("Agent");

    // the parent's result is immediate; the reply arrives as a finished delivery
    const result = toolResults(events).find((r) => r.payload.toolKey === "Agent");
    expect(result?.payload.isError).toBe(false);
    expect(result?.payload.content).toBe(agentStartedText(child.id));
    expect(deliveries(events).map((d) => d.payload)).toEqual([
      {
        subagentId: child.id,
        childRunId: expect.any(String),
        description: "General task",
        kind: "finished",
        status: "completed",
        text: "gp reply",
        triggerAccountId: ownerId,
      },
    ]);
    // agent calls write no tool_call_started
    expect(
      ofType(events, "tool_call_started").filter((e) => e.payload.toolKey === "Agent"),
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

  it("a general-purpose child and a tier fallback inherit the parent's switched model", async () => {
    const save = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: {
        definition: {
          name: "Lead",
          instructions: INSTRUCTIONS,
          model: { provider: "model-script", model: "script-1" },
          tools: ["Agent", "Read"].map((name) => ({ kind: "builtin", name })),
          // `fast` is unmapped here: the tier falls back to the parent's model
          subagents: {
            inline: [
              { name: "looper", description: "Loops.", instructions: "You loop.", model: "fast" },
            ],
          },
        },
      },
    });
    expect(save.statusCode, save.body).toBe(200);
    const SCRIPT_2 = { provider: "model-script", model: "script-2" };
    for (const text of ["SCENARIO general", "SCENARIO steps"]) {
      const conv = await createConv(owner, orgId, agentId);
      const res = await owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
        payload: { text, model: SCRIPT_2 },
      });
      expect(res.statusCode, res.body).toBe(202);
      await waitForTerminal(db, conv, 1, 30_000);
      const events = await delivered(conv);
      expect(ofType(events, "run_started")[0]?.payload.model).toEqual(SCRIPT_2);
      const dispatched = ofType(events, "subagent_dispatched")[0];
      expect(dispatched?.payload.model, text).toEqual(SCRIPT_2);
      const kid = ((await children(conv))[0] as { id: string }).id;
      const cev = await eventsOf(db, kid);
      // the child's frozen definition records the model, so a replay of the child is exact
      expect((cev[0] as Ev<"subagent_started">).payload.definition.model).toEqual(SCRIPT_2);
      expect(ofType(cev, "run_started")[0]?.payload.model).toEqual(SCRIPT_2);
      expect(ofType(cev, "model_switched")).toEqual([]);
    }
  }, 90_000);

  it("three agent calls in one response run concurrently and the parent continues once", async () => {
    const { conv } = await converse("SCENARIO parallel");
    const events = await delivered(conv, 3);
    expect(finalText(events)).toBe("all three dispatched");
    expect(await children(conv)).toHaveLength(3);
    const results = toolResults(events).filter((r) => r.payload.toolKey === "Agent");
    expect(results).toHaveLength(3);
    for (const r of results) expect(r.payload.content).toContain("(running in the background)");
    // the barrier only opens when all three requests are in flight at once
    expect(deliveries(events).map((d) => d.payload.text)).toEqual([
      "parallel ok",
      "parallel ok",
      "parallel ok",
    ]);
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

  it("a child's step reminder counts against its own maxSteps (final review m4)", async () => {
    const save = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: {
        definition: {
          name: "Lead",
          instructions: INSTRUCTIONS,
          model: { provider: "model-script", model: "script-1" },
          tools: ["Agent", "Read"].map((name) => ({ kind: "builtin", name })),
          subagents: {
            inline: [
              { name: "looper", description: "Loops.", instructions: "You loop.", maxSteps: 3 },
            ],
          },
        },
      },
    });
    expect(save.statusCode, save.body).toBe(200);
    const { conv } = await converse("SCENARIO steps");
    const events = await delivered(conv);
    expect(finalText(events)).toBe("parent done");
    const child = capture.sent.find(
      (r) => isChildRequest(r) && JSON.stringify(r.messages).includes("loop-task"),
    );
    expect(JSON.stringify(child)).toContain("step limit for this turn (step 1 of 3)");
    const [kid] = await children(conv);
    const reminders = ofType(await eventsOf(db, (kid as { id: string }).id), "reminder");
    expect(reminders.map((r) => r.payload.text).join("\n")).toContain("(step 1 of 3)");
  }, 60_000);

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
    // UI refresh B's writes refuse a child too: rename, queue, a model switch with a message
    const base = `/api/v1/orgs/${orgId}/conversations/${child}`;
    const writes = [
      await owner({ method: "PATCH", url: base, payload: { title: "Renamed" } }),
      await owner({
        method: "POST",
        url: `${base}/queue`,
        payload: { text: "later", clientMessageId: randomUUID() },
      }),
      await owner({
        method: "POST",
        url: `${base}/messages`,
        payload: { text: "switch", model: { provider: "model-script", model: "script-2" } },
      }),
    ];
    for (const w of writes) {
      expect(w.statusCode, w.body).toBe(409);
      expect((w.json() as { error: { code: string } }).error.code).toBe("conversation.read_only");
    }
    // and its reads go through the parent's access
    const queue = await owner({ method: "GET", url: `${base}/queue` });
    expect(queue.statusCode, queue.body).toBe(200);
    expect(queue.json()).toMatchObject({ items: [] });
    expect((await owner({ method: "GET", url: `${base}/files` })).statusCode).toBe(200);
    const row = await db
      .selectFrom("conversations")
      .select(["title", "selection"])
      .where("id", "=", child)
      .executeTakeFirstOrThrow();
    expect(row.title).not.toBe("Renamed");
    expect(row.selection).toBeNull();
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
      payload: { orgId, denyTools: ["Agent"] },
    });
    expect(cfg.statusCode, cfg.body).toBe(200);
    const { conv, events } = await converse("SCENARIO hook");
    expect(finalText(events)).toBe("hook seen");
    const result = toolResults(events).find((r) => r.payload.toolKey === "Agent");
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
    // the kernel's event log: the dispatch's writes run in the kernel's transaction
    eventLog: k.app.get(EventLog),
    purposes: k.app.get(ModelPurposesService),
    registry: k.app.get(ProviderRegistry),
    config: { get: () => k.app.get(KernelConfigService).get() },
    // the child runs are not executed here
    enqueue: async (_data, jobId) => {
      enqueued.push(jobId);
    },
    log: { error: () => {}, warn: () => {} },
    // the dispatch's writes in the kernel's own transaction (the same database)
    commitDispatch: (a, plan, child) => k.app.get(SubagentsService).commitDispatch(a, plan, child),
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
