import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { normalizeStoredDefinition } from "../../src/agents/definition.js";
import { newTaskId, taskOutputPath } from "../../src/background/launch.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { RUN_HOOKS } from "../../src/runtime/run-worker.js";
import { SUBAGENT_MESSAGES_HOOKS, SubagentMessages } from "../../src/runtime/subagents/messages.js";
import { SubagentsService } from "../../src/runtime/subagents/subagents.service.js";
import { Waits } from "../../src/runtime/waits.js";
import { AGENT_REFUSALS } from "../../src/tools/builtins/agent.js";
import {
  SEND_MESSAGE_REFUSALS,
  SENT_TO_PARENT_TEXT,
  sentToIdleText,
  sentToRunningText,
} from "../../src/tools/builtins/send-message.js";
import type { ToolStepContext } from "../../src/tools/pipeline.js";
import type { ScriptRule } from "../fixtures/plugins/model-script/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Agent map spec §4.2, §5.1, §5.2, §6, §10 (Task A6): `SendMessage`. A message to a working
 * sub-agent is a `user_message` it absorbs at its next model call; one to an idle sub-agent starts
 * it again as a follow-up dispatch (counted, refused at the limits); a message racing a run's end
 * is never lost; a sub-agent sends notes to `"parent"`. The parent runs are made by hand (a
 * `running` run no worker holds), so each test drives `SubagentMessages` directly; the children
 * run for real on `model-script`.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");

const CHILD = "You are a sub-agent";
const held = (name: string) => ({ name, count: 99, timeoutMs: 60_000 });
const READ = { name: "Read", input: { file_path: "/workspace/none.txt" } };

const RULES: ScriptRule[] = [
  // messages the children answer (tried first: they are the last user text once absorbed)
  { when: { systemIncludes: CHILD, lastUserIncludes: "PING-STEP" }, reply: { text: "absorbed" } },
  { when: { systemIncludes: CHILD, lastUserIncludes: "FOLLOW-UP" }, reply: { text: "followed" } },
  { when: { systemIncludes: CHILD, lastUserIncludes: "LATE-MSG" }, reply: { text: "late seen" } },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "LATE-HOLD" },
    reply: { text: "late held", barrier: held("late-hold") },
  },
  { when: { systemIncludes: CHILD, lastUserIncludes: "RACE-MSG" }, reply: { text: "race seen" } },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "AFTER-STOP" },
    reply: { text: "after stop", barrier: held("after-stop") },
  },
  // tasks
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "step-hold", assistantTurns: 0 },
    reply: { toolCalls: [READ], barrier: held("step") },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "end-hold" },
    reply: { text: "end reply", barrier: held("end") },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "hold-task" },
    reply: { text: "held", barrier: held("hold") },
  },
  { when: { systemIncludes: CHILD, lastUserIncludes: "quick-task" }, reply: { text: "quick" } },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "note-task", assistantTurns: 0 },
    reply: {
      toolCalls: [{ name: "SendMessage", input: { to: "parent", message: "NOTE: halfway" } }],
    },
  },
  { when: { systemIncludes: CHILD, lastUserIncludes: "note-task" }, reply: { text: "noted" } },
];

type Barriers = Map<string, { arrived: number; waiters: (() => void)[] }>;
const barriers = (): Barriers | undefined =>
  (globalThis as { __modelScript?: { barriers: Barriers } }).__modelScript?.barriers;
/** Waits until a model call is held at barrier `name` right now. */
const waiting = (name: string) =>
  waitFor(async () => (barriers()?.get(name)?.waiters.length ?? 0) >= 1, 20_000, `held at ${name}`);
const release = (name: string) => {
  for (const w of barriers()?.get(name)?.waiters.splice(0) ?? []) w();
};

/** Post-run `ensureRun` attempts per conversation; those in `dropEnsure` fail (a lost replica). */
const ensureAttempts = new Map<string, number>();
const dropEnsure = new Set<string>();

/** The race seam: called once by the next send after its status read, then cleared. */
let afterStatusRead: ((childId: string) => Promise<void>) | undefined;

const capture = captureProviderRequests();

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
let root: string;

beforeAll(async () => {
  capture.install();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-send-message-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE],
        extensionConfig: { "model-script": { rules: RULES }, "sandbox-fake": { root } },
        sandbox: { background: { pollSeconds: 3600 } },
      },
    ),
    {
      overrides: [
        {
          provide: RUN_HOOKS,
          useValue: {
            beforeEnsureRun: async (conversationId: string) => {
              ensureAttempts.set(conversationId, (ensureAttempts.get(conversationId) ?? 0) + 1);
              if (dropEnsure.has(conversationId)) throw new Error("replica lost");
            },
          },
        },
        {
          provide: SUBAGENT_MESSAGES_HOOKS,
          useValue: {
            afterStatusRead: async (childId: string) => {
              const hook = afterStatusRead;
              afterStatusRead = undefined;
              await hook?.(childId);
            },
          },
        },
      ],
    },
  );
  ownerId = (
    await accountsFor(db).createLocal({
      login: "owner",
      password: PW,
      displayName: "O",
      enterpriseAdmin: true,
    })
  ).id;
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
        tools: ["Agent", "Read"].map((name) => ({ kind: "builtin", name })),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
}, 180_000);

afterEach(async () => {
  afterStatusRead = undefined;
  for (const name of barriers()?.keys() ?? []) release(name);
  await limits(null);
});

afterAll(async () => {
  for (const name of barriers()?.keys() ?? []) release(name);
  capture.restore();
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);

/** Sets (or with null clears) this organization's sub-agent limit override. */
async function limits(o: Record<string, number> | null): Promise<void> {
  const res = await owner({
    method: "PUT",
    url: "/api/v1/admin/settings",
    payload: { subagentLimitOverrides: { [orgId]: o } },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** The agent's current definition and version. */
async function current(): Promise<{ version: number; agent: ToolStepContext["agent"] }> {
  const a = await db
    .selectFrom("agents")
    .select("current_version")
    .where("id", "=", agentId)
    .executeTakeFirstOrThrow();
  const v = await db
    .selectFrom("agent_versions")
    .select("definition")
    .where("agent_id", "=", agentId)
    .where("version", "=", a.current_version)
    .executeTakeFirstOrThrow();
  return { version: a.current_version, agent: normalizeStoredDefinition(v.definition) };
}

/** A `running` parent run of a new conversation that no worker holds, and its step context. */
async function parentRun(): Promise<{ conv: string; runId: string; ctx: ToolStepContext }> {
  const conv = await createConv(owner, orgId, agentId);
  const runId = randomUUID();
  const { version, agent } = await current();
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: conv,
      status: "running",
      agent_version: version,
      trigger_account_id: ownerId,
      trigger_seq: 0,
    })
    .execute();
  const ctx: ToolStepContext = {
    orgId,
    conversationId: conv,
    runId,
    step: 1,
    agentId,
    agentVersion: version,
    agent,
    accountId: ownerId,
    signal: new AbortController().signal,
  };
  return { conv, runId, ctx };
}

/** Dispatches a sub-agent from `ctx` (its call `callId`); its conversation and first run. */
async function dispatch(
  ctx: ToolStepContext,
  callId: string,
  prompt: string,
  description = "Helper",
): Promise<{ childId: string; childRunId: string }> {
  const out = await k.app
    .get(SubagentsService)
    .dispatch({ ctx, callId, input: { description, prompt } });
  if (out.kind !== "dispatched") throw new Error(out.content);
  return { childId: out.childConversationId, childRunId: out.childRunId };
}

const send = (ctx: ToolStepContext, callId: string, to: string, text: string) =>
  k.app.get(SubagentMessages).toChild(ctx, callId, to, text);

type RunRow = { id: string; status: string; trigger_seq: string; budget_run_id: string | null };
const runRows = (conversationId: string): Promise<RunRow[]> =>
  db
    .selectFrom("runs")
    .select(["id", "status", "trigger_seq", "budget_run_id"])
    .where("conversation_id", "=", conversationId)
    .orderBy("created_at")
    .execute();

/** Waits until the conversation has `n` runs, all terminal. */
const settled = (conversationId: string, n: number) =>
  waitFor(
    async () => {
      const rows = await runRows(conversationId);
      return rows.length === n &&
        rows.every((r) => !["queued", "running", "waiting"].includes(r.status))
        ? rows
        : null;
    },
    30_000,
    `${n} terminal runs of ${conversationId}`,
  );

const finalText = (events: ConversationEvent[], runId: string) =>
  ofType(events, "assistant_message")
    .filter((e) => e.runId === runId)
    .at(-1)
    ?.payload.content.flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("");

const dispatchRows = (parentConv: string) =>
  db
    .selectFrom("subagent_dispatches")
    .select(["parent_call_id", "child_run_id", "resumed", "budget_run_id"])
    .where("parent_conversation_id", "=", parentConv)
    .orderBy("created_at")
    .execute();

const childRequests = (marker: string): ModelRequest[] =>
  capture.sent.filter(
    (r) => r.system.some((s) => s.text.includes(CHILD)) && JSON.stringify(r).includes(marker),
  );

describe("SendMessage to a sub-agent", { timeout: 90_000 }, () => {
  it('to a running child appends a user_message with dispatch.kind "message" and the child absorbs it at its next step', async () => {
    const { conv, runId, ctx } = await parentRun();
    const { childId, childRunId } = await dispatch(ctx, "c1", "step-hold: go", "Stepper");
    await waiting("step");
    const out = await send(ctx, "s1", childId, "PING-STEP: also check the README");
    expect(out).toEqual({
      content: sentToRunningText({ id: childId, description: "Stepper" }),
      isError: false,
    });
    release("step");
    const [run] = await settled(childId, 1);
    expect(run?.id).toBe(childRunId);
    const events = await eventsOf(db, childId);
    const messages = ofType(events, "user_message");
    expect(messages).toHaveLength(2);
    expect(messages[1]?.payload).toEqual({
      content: [{ type: "text", text: "PING-STEP: also check the README" }],
      authorAccountId: ownerId,
      dispatch: {
        parentConversationId: conv,
        parentRunId: runId,
        callId: "s1",
        kind: "message",
        narrowed: expect.any(Object),
      },
    });
    // absorbed by the same run at its second model call, after the tool step
    expect(finalText(events, childRunId)).toBe("absorbed");
    const finished = ofType(events, "run_finished")[0];
    expect(finished?.payload.consumedUpToSeq).toBeGreaterThanOrEqual(messages[1]?.seq ?? 0);
    const second = childRequests("PING-STEP").at(-1);
    expect(second?.messages.at(-1)?.role).toBe("user");
    // a message to a running child is no dispatch: one row
    expect(await dispatchRows(conv)).toHaveLength(1);
  });

  it("to an idle child starts a child run with the frozen definition", async () => {
    const { conv, runId, ctx } = await parentRun();
    const { childId, childRunId } = await dispatch(ctx, "c1", "quick-task: go", "Quick");
    await settled(childId, 1);
    const first = childRequests("quick-task: go")[0];
    // the owner edits the agent after the dispatch: the child keeps its frozen instructions
    const save = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: {
        definition: {
          name: "Lead",
          instructions: "Lead the work, edited.",
          model: { provider: "model-script", model: "script-1" },
          tools: ["Agent", "Read"].map((name) => ({ kind: "builtin", name })),
        },
      },
    });
    expect(save.statusCode, save.body).toBe(200);
    const out = await send(ctx, "s1", childId, "FOLLOW-UP: one more thing");
    expect(out).toEqual({
      content: sentToIdleText({ id: childId, description: "Quick" }),
      isError: false,
      logged: true,
    });
    const rows = await settled(childId, 2);
    const events = await eventsOf(db, childId);
    const message = ofType(events, "user_message")[1];
    expect(message?.payload.dispatch?.kind).toBe("message");
    expect(Number(rows[1]?.trigger_seq)).toBe(message?.seq);
    expect(rows[1]?.budget_run_id).toBe(runId);
    expect(finalText(events, rows[1]?.id as string)).toBe("followed");
    // a follow-up dispatch: recorded, its result and audit written with it
    expect((await dispatchRows(conv)).map((r) => [r.parent_call_id, r.resumed])).toEqual([
      ["c1", false],
      ["s1", true],
    ]);
    const parent = await eventsOf(db, conv);
    const result = ofType(parent, "tool_result").find((r) => r.payload.callId === "s1");
    expect(result?.payload).toMatchObject({ toolKey: "SendMessage", content: out.content });
    const dispatched = ofType(parent, "subagent_dispatched").find((d) => d.payload.callId === "s1");
    expect(dispatched?.payload).toMatchObject({
      subagentId: childId,
      resumed: true,
      description: "Quick",
    });
    const audits = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "tool.called")
      .where(sql<string>`detail ->> 'callId'`, "=", "s1")
      .execute();
    expect(audits.map((a) => (a.detail as { toolKey: string }).toolKey)).toEqual(["SendMessage"]);
    // the restart's request: the frozen system text and tools, with the earlier history
    const followUp = childRequests("FOLLOW-UP").at(-1);
    expect(followUp?.system).toEqual(first?.system);
    expect(followUp?.tools).toEqual(first?.tools);
    expect(JSON.stringify(followUp?.messages)).toContain("quick-task: go");
    expect(JSON.stringify(followUp?.system)).not.toContain("edited");
    expect(childRunId).not.toBe(rows[1]?.id);
  });

  it("a child run a message starts acts for the sender's account, not the dispatcher's (spec §7)", async () => {
    const { conv, ctx } = await parentRun();
    const { childId } = await dispatch(ctx, "ta1", "quick-task: speaker", "Speaker");
    await settled(childId, 1);
    // another speaker's later run of the same conversation (an IM group) messages the child
    const speakerId = (
      await accountsFor(db).createLocal({ login: "speaker", password: PW, displayName: "S" })
    ).id;
    await testMembers(db).add(orgId, speakerId, "member", ownerId);
    await db
      .updateTable("runs")
      .set({ status: "completed", finished_at: new Date() })
      .where("id", "=", ctx.runId)
      .execute();
    const laterRunId = randomUUID();
    await db
      .insertInto("runs")
      .values({
        id: laterRunId,
        conversation_id: conv,
        status: "running",
        agent_version: ctx.agentVersion,
        trigger_account_id: speakerId,
        trigger_seq: 0,
      })
      .execute();
    const later: ToolStepContext = { ...ctx, runId: laterRunId, accountId: speakerId };
    const out = await send(later, "ts1", childId, "FOLLOW-UP: from the speaker");
    expect(out.isError, out.content).toBe(false);
    await settled(childId, 2);
    const runs = await db
      .selectFrom("runs")
      .select("trigger_account_id")
      .where("conversation_id", "=", childId)
      .orderBy("created_at")
      .execute();
    // the approver of the restarted run follows the account it acts for
    expect(runs.map((r) => r.trigger_account_id)).toEqual([ownerId, speakerId]);
  });

  it("to an idle child at the concurrency cap is refused, nothing written", async () => {
    await limits({ maxConcurrentPerConversation: 1 });
    const { conv, ctx } = await parentRun();
    const { childId } = await dispatch(ctx, "c1", "quick-task: go", "Quick");
    await settled(childId, 1);
    const { childId: busy } = await dispatch(ctx, "c2", "hold-task: go", "Busy");
    await waiting("hold");
    const before = (await eventsOf(db, childId)).length;
    const out = await send(ctx, "s1", childId, "FOLLOW-UP: more");
    expect(out).toEqual({ content: SEND_MESSAGE_REFUSALS.tooManyConcurrent(1), isError: true });
    expect(await eventsOf(db, childId)).toHaveLength(before);
    expect(await runRows(childId)).toHaveLength(1);
    expect(await dispatchRows(conv)).toHaveLength(2);
    const parent = await eventsOf(db, conv);
    expect(ofType(parent, "tool_result").filter((r) => r.payload.callId === "s1")).toEqual([]);
    // a message to the running one is still delivered (no slot needed)
    const ok = await send(ctx, "s2", busy, "LATE-MSG: and this");
    expect(ok.isError).toBe(false);
    release("hold");
    await settled(busy, 2);
  });

  it("the send counts as a dispatch on the budget run", async () => {
    await limits({ maxDispatchesPerRun: 2 });
    const { conv, runId, ctx } = await parentRun();
    const { childId } = await dispatch(ctx, "c1", "quick-task: go", "Quick");
    await settled(childId, 1);
    expect((await send(ctx, "s1", childId, "FOLLOW-UP: again")).isError).toBe(false);
    await settled(childId, 2);
    const rows = await dispatchRows(conv);
    expect(rows.map((r) => r.budget_run_id)).toEqual([runId, runId]);
    // the third start of the tree is over the cap
    const out = await send(ctx, "s2", childId, "FOLLOW-UP: once more");
    expect(out).toEqual({ content: SEND_MESSAGE_REFUSALS.tooManyDispatches(2), isError: true });
    expect(await runRows(childId)).toHaveLength(2);
  });

  it('to an unknown id is refused listing the valid targets (own children by id and description, and "parent")', async () => {
    const { conv, ctx } = await parentRun();
    const a = await dispatch(ctx, "c1", "quick-task: a", "First helper");
    const b = await dispatch(ctx, "c2", "quick-task: b", "Second helper");
    await settled(a.childId, 1);
    await settled(b.childId, 1);
    const targets = [
      { id: b.childId, description: "Second helper" },
      { id: a.childId, description: "First helper" },
    ];
    expect(await send(ctx, "s1", "nope", "hello")).toEqual({
      content: SEND_MESSAGE_REFUSALS.unknownTarget("nope", targets, { hasParent: false, more: 0 }),
      isError: true,
    });
    // the root has no parent
    expect((await send(ctx, "s2", "parent", "hello")).content).toBe(
      SEND_MESSAGE_REFUSALS.unknownTarget("parent", targets, { hasParent: false, more: 0 }),
    );
    expect(SEND_MESSAGE_REFUSALS.unknownTarget("x", targets, { hasParent: true, more: 0 })).toBe(
      `There is no agent "x" you can send to. Pass one of these as to: ${b.childId} ("Second helper"), ${a.childId} ("First helper"), "parent" (the agent that dispatched you).`,
    );
    // a root without sub-agents is told to dispatch one
    const lone = await parentRun();
    expect((await send(lone.ctx, "s3", a.childId, "hello")).content).toBe(
      SEND_MESSAGE_REFUSALS.unknownTarget(a.childId, [], { hasParent: false, more: 0 }),
    );
    expect(await dispatchRows(conv)).toHaveLength(2);
    expect(ofType(await eventsOf(db, a.childId), "user_message")).toHaveLength(1);
  });

  it("to a sibling or grandchild is refused", async () => {
    const { conv, runId, ctx } = await parentRun();
    const a = await dispatch(ctx, "c1", "quick-task: a", "Sibling A");
    const b = await dispatch(ctx, "c2", "quick-task: b", "Sibling B");
    await settled(a.childId, 1);
    await settled(b.childId, 1);
    // a grandchild below A, made by hand
    const grandchild = randomUUID();
    await sql`INSERT INTO capybara.conversations
        (id, org_id, agent_id, account_id, kind, parent_conversation_id, title, subagent_depth)
      VALUES (${grandchild}, ${orgId}, ${agentId}, ${ownerId}, 'subagent', ${a.childId}, 'Grand', 2)`.execute(
      raw,
    );
    const childCtx: ToolStepContext = {
      ...ctx,
      conversationId: a.childId,
      runId: a.childRunId,
      parent: { conversationId: conv, runId, callId: "c1", depth: 0, rootConversationId: conv },
    };
    // A to its sibling B: A's only targets are its grandchild and its parent
    expect((await send(childCtx, "s1", b.childId, "hi sibling")).content).toBe(
      SEND_MESSAGE_REFUSALS.unknownTarget(b.childId, [{ id: grandchild, description: "Grand" }], {
        hasParent: true,
        more: 0,
      }),
    );
    // the root to its grandchild
    expect((await send(ctx, "s2", grandchild, "hi grandchild")).isError).toBe(true);
    expect(ofType(await eventsOf(db, b.childId), "user_message")).toHaveLength(1);
    expect(await eventsOf(db, grandchild)).toEqual([]);
  });

  it('"parent" from a child appends a note delivery to the parent', async () => {
    capture.reset();
    const { conv, ctx } = await parentRun();
    const { childId, childRunId } = await dispatch(ctx, "c1", "note-task: go", "Noter");
    await settled(childId, 1);
    const child = await eventsOf(db, childId);
    const result = ofType(child, "tool_result")[0];
    expect(result?.payload).toMatchObject({
      toolKey: "SendMessage",
      content: SENT_TO_PARENT_TEXT,
      isError: false,
    });
    expect(finalText(child, childRunId)).toBe("noted");
    // the finish is delivered after the run's terminal commit
    const deliveries = await waitFor(
      async () => {
        const d = ofType(await eventsOf(db, conv), "subagent_delivery");
        return d.length >= 2 ? d : null;
      },
      20_000,
      "the note and the finish",
    );
    expect(deliveries.map((d) => d.payload)).toEqual([
      {
        subagentId: childId,
        childRunId,
        description: "Noter",
        kind: "note",
        text: "NOTE: halfway",
        triggerAccountId: ownerId,
      },
      expect.objectContaining({ kind: "finished", status: "completed", text: "noted" }),
    ]);
    // the note is idempotent by the call: delivering it again writes nothing
    const childCtx: ToolStepContext = {
      ...ctx,
      conversationId: childId,
      runId: childRunId,
      parent: {
        conversationId: conv,
        runId: ctx.runId,
        callId: "c1",
        depth: 0,
        rootConversationId: conv,
      },
    };
    const callId = ofType(child, "tool_result")[0]?.payload.callId as string;
    await k.app.get(SubagentMessages).toParent(childCtx, "note", "NOTE: halfway", callId);
    expect(ofType(await eventsOf(db, conv), "subagent_delivery")).toHaveLength(2);
    // the child was offered both message tools; the audit names SendMessage
    const req = childRequests("note-task: go")[0];
    expect(req?.tools?.map((t) => t.name)).toEqual(
      expect.arrayContaining(["SendMessage", "SubagentHandback"]),
    );
  });

  it("message racing a child finish starts a run", async () => {
    const { conv, ctx } = await parentRun();
    const { childId, childRunId } = await dispatch(ctx, "c1", "end-hold: go", "Racer");
    await waiting("end");
    // the send reads the run as active; the run then ends before the message is appended
    afterStatusRead = async () => {
      release("end");
      await settled(childId, 1);
    };
    const out = await send(ctx, "s1", childId, "RACE-MSG: here");
    expect(out).toEqual({
      content: sentToIdleText({ id: childId, description: "Racer" }),
      isError: false,
      logged: true,
    });
    const rows = await settled(childId, 2);
    expect(rows[0]?.id).toBe(childRunId);
    const events = await eventsOf(db, childId);
    const message = ofType(events, "user_message").find((m) => m.payload.dispatch?.callId === "s1");
    expect(Number(rows[1]?.trigger_seq)).toBe(message?.seq);
    expect(finalText(events, rows[1]?.id as string)).toBe("race seen");
    expect(await dispatchRows(conv)).toHaveLength(2);
  });

  it("a message reaching a run after its last model call starts the next run from it", async () => {
    const { conv, runId, ctx } = await parentRun();
    const { childId, childRunId } = await dispatch(ctx, "c1", "end-hold: go", "Closer");
    await waiting("end");
    // the run is in its last model call (a reply without tools): the message is not absorbed
    const out = await send(ctx, "s1", childId, "LATE-MSG: one more");
    expect(out.content).toBe(sentToRunningText({ id: childId, description: "Closer" }));
    release("end");
    const rows = await settled(childId, 2);
    expect(rows[0]?.id).toBe(childRunId);
    const events = await eventsOf(db, childId);
    expect(finalText(events, childRunId)).toBe("end reply");
    const message = ofType(events, "user_message").find((m) => m.payload.dispatch?.callId === "s1");
    expect(Number(rows[1]?.trigger_seq)).toBe(message?.seq);
    expect(rows[1]?.budget_run_id).toBe(runId);
    expect(finalText(events, rows[1]?.id as string)).toBe("late seen");
    // no dispatch for it, and both runs delivered their finish
    expect(await dispatchRows(conv)).toHaveLength(1);
    const delivered = await waitFor(
      async () => {
        const d = ofType(await eventsOf(db, conv), "subagent_delivery");
        return d.length >= 2 ? d : null;
      },
      20_000,
      "two finished deliveries",
    );
    expect(delivered.map((d) => [d.payload.childRunId, d.payload.text])).toEqual([
      [childRunId, "end reply"],
      [rows[1]?.id, "late seen"],
    ]);
  });

  it("the wait sweep starts a parked message no run took (a lost post-run ensureRun)", async () => {
    const { ctx } = await parentRun();
    const { childId } = await dispatch(ctx, "c1", "end-hold: go", "Parked");
    await waiting("end");
    // the message reaches the run in its last model call; every post-run ensureRun then fails
    // (the replica died after the terminal commit)
    expect((await send(ctx, "s1", childId, "LATE-MSG: parked")).isError).toBe(false);
    dropEnsure.add(childId);
    release("end");
    await waitFor(
      async () => (ensureAttempts.get(childId) ?? 0) >= 4,
      20_000,
      "the post-run ensureRun given up",
    );
    expect((await runRows(childId)).map((r) => r.status)).toEqual(["completed"]);
    const message = ofType(await eventsOf(db, childId), "user_message").find(
      (m) => m.payload.dispatch?.callId === "s1",
    );
    // not before the grace period
    expect((await k.app.get(Waits).sweep()).restarted).toBe(0);
    await sql`UPDATE capybara.conversation_events SET created_at = now() - interval '5 minutes'
      WHERE conversation_id = ${childId} AND seq = ${message?.seq}`.execute(raw);
    expect((await k.app.get(Waits).sweep()).restarted).toBe(1);
    const rows = await settled(childId, 2);
    expect(Number(rows[1]?.trigger_seq)).toBe(message?.seq);
    expect(finalText(await eventsOf(db, childId), rows[1]?.id as string)).toBe("late seen");
    // consumed now: the next sweep starts nothing
    expect((await k.app.get(Waits).sweep()).restarted).toBe(0);
  });

  it("a run started from a message holds its sub-agent's concurrency slot", async () => {
    await limits({ maxConcurrentPerConversation: 1 });
    const { ctx } = await parentRun();
    const { childId } = await dispatch(ctx, "c1", "end-hold: go", "Busy");
    await waiting("end");
    expect((await send(ctx, "s1", childId, "LATE-HOLD: one more")).isError).toBe(false);
    release("end");
    // the message's run (no dispatch row of its own) is working now
    await waiting("late-hold");
    expect((await runRows(childId)).map((r) => r.status)).toEqual(["completed", "running"]);
    const out = await k.app
      .get(SubagentsService)
      .dispatch({ ctx, callId: "c2", input: { description: "Another", prompt: "quick-task: x" } });
    expect(out).toEqual({ kind: "refused", content: AGENT_REFUSALS.tooManyConcurrent(1) });
    release("late-hold");
    await settled(childId, 2);
  });

  it("a late finish of a stopped run stops its own tasks and leaves those of the run a message started", async () => {
    const { ctx } = await parentRun();
    const { childId, childRunId } = await dispatch(ctx, "c1", "hold-task: go", "Stopped");
    await waiting("hold");
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${childId}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    release("hold");
    await settled(childId, 1);
    expect((await runRows(childId))[0]?.status).toBe("aborted");
    const out = await send(ctx, "s1", childId, "AFTER-STOP: carry on");
    expect(out.content).toBe(sentToIdleText({ id: childId, description: "Stopped" }));
    await waiting("after-stop");
    const later = (await runRows(childId))[1] as RunRow;
    // a task of each run, then the old run's finish handling arrives late
    const store = k.app.get(BackgroundTaskStore);
    const task = async (runId: string) => {
      const id = newTaskId();
      const startedAt = new Date();
      await store.insert({
        id,
        orgId,
        conversationId: childId,
        sandboxConversationId: ctx.conversationId,
        runId,
        callId: `call-${id}`,
        triggerAccountId: ownerId,
        description: `Task of ${runId}`,
        command: "true",
        sid: "4242",
        outputPath: taskOutputPath(id),
        startedAt,
        deadlineAt: new Date(startedAt.getTime() + 3_600_000),
        sandboxCreatedAt: new Date(),
      });
      return id;
    };
    const ofNew = await task(later.id);
    const ofStopped = await task(childRunId);
    await k.app.get(Waits).childFinished(childRunId);
    expect((await store.get(ofNew))?.status).toBe("running");
    expect((await store.get(ofStopped))?.status).not.toBe("running");
    release("after-stop");
    await settled(childId, 2);
  });
});
