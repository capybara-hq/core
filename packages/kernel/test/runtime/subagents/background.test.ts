import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeStoredDefinition } from "../../../src/agents/definition.js";
import { EventLog } from "../../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { KernelConfigService } from "../../../src/infra/config/kernel-config.service.js";
import { KERNEL_BUS } from "../../../src/infra/tokens.js";
import { ModelPurposesService } from "../../../src/models/purposes.js";
import { ProviderRegistry } from "../../../src/runtime/providers.js";
import { SubagentDeliveries } from "../../../src/runtime/subagents/deliveries.js";
import { type DispatchDeps, dispatchSubagent } from "../../../src/runtime/subagents/dispatch.js";
import { SubagentsService } from "../../../src/runtime/subagents/subagents.service.js";
import { agentStartedText } from "../../../src/tools/builtins/agent.js";
import {
  openBarrier,
  type ScriptRule,
  scriptRules,
} from "../../fixtures/plugins/model-script/index.js";
import { eventLogFor, legacyDbFor } from "../../helpers/conversations.js";
import { truncateTables } from "../../helpers/db.js";
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
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../../helpers/runs.js";
import { childRunsOf, finishChildByHand, runStatus } from "../../helpers/subagents.js";

/**
 * Agent map spec §4.1, §4.5, §5.4 (Task A4): `Agent` dispatches in the background. Its result is
 * immediate, the parent run goes on and may end while the child works, and the child's finish
 * reaches the parent as `subagent_finished` (display) plus one `finished` `subagent_delivery`.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");

const CHILD = "You are a sub-agent";

const RULES: ScriptRule[] = [
  // the child holds at the barrier until the test opens it
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "bg-hold" },
    reply: { text: "child reply", barrier: { name: "hold", count: 99, timeoutMs: 30_000 } },
  },
  {
    when: { lastUserIncludes: "SCENARIO background", assistantTurns: 0 },
    reply: {
      toolCalls: [{ name: "Agent", input: { description: "Held task", prompt: "bg-hold: do it" } }],
    },
  },
  {
    when: { lastToolResultIncludes: "running in the background" },
    reply: { text: "parent went on" },
  },
];

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  destroyDb = () => raw.destroy();
  root = await mkdtemp(join(tmpdir(), "cap-subagents-bg-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE],
        extensionConfig: { "model-script": { rules: RULES }, "sandbox-fake": { root } },
      },
    ),
  );
}, 180_000);

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.audit_events, capybara.subagent_dispatches, capybara.sandboxes, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  scriptRules([]);
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
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
        tools: ["Agent", "Write", "Read"].map((name) => ({ kind: "builtin", name })),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterEach(() => {
  // a held child of a failed test goes on, so the next test's truncation finds no running work
  openBarrier("hold");
  scriptRules([]);
});

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

/** Starts the scenario and waits for the parent's first run to end. */
async function background(): Promise<{ conv: string; events: ConversationEvent[] }> {
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, "SCENARIO background");
  await waitForTerminal(db, conv, 1, 30_000);
  return { conv, events: await eventsOf(db, conv) };
}

describe("background Agent", () => {
  it("Agent returns the agentId at once and the parent run goes on", async () => {
    const { conv, events } = await background();
    expect(finalText(events)).toBe("parent went on");
    const [child] = await childRunsOf(db, conv);
    if (!child) throw new Error("no child dispatched");
    const result = ofType(events, "tool_result").find((r) => r.payload.toolKey === "Agent");
    expect(result?.payload).toMatchObject({
      content: agentStartedText(child.conversationId),
      isError: false,
    });
    // the result was written with the dispatch, before the child ran: the step never waited
    const dispatched = ofType(events, "subagent_dispatched")[0];
    expect(dispatched?.seq).toBeLessThan(result?.seq ?? 0);
    expect(ofType(events, "run_started")).toHaveLength(1);
    const parentRun = await db
      .selectFrom("runs")
      .select(["status", "waited_ms"])
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    expect(parentRun.status).toBe("completed");
    expect(Number(parentRun.waited_ms)).toBe(0);
    // `tool.called` is audited in the dispatch transaction
    const audits = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "=", "tool.called")
      .execute();
    expect(audits.map((a) => (a.detail as { toolKey: string }).toolKey)).toEqual(["Agent"]);
  }, 60_000);

  it("the parent run can finish while the child runs, and the child keeps running", async () => {
    const { conv } = await background();
    const [child] = await childRunsOf(db, conv);
    if (!child) throw new Error("no child dispatched");
    // the parent is done; its child still works (held at the barrier), nothing stopped it
    await waitFor(
      async () => ((await runStatus(db, child.runId)) === "running" ? true : null),
      20_000,
      "the child running",
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(await runStatus(db, child.runId)).toBe("running");
    openBarrier("hold");
    await waitForTerminal(db, child.conversationId, 1, 30_000);
    expect(await runStatus(db, child.runId)).toBe("completed");
  }, 60_000);

  it("a child finish appends subagent_finished and a finished delivery with the final reply when it never handed back", async () => {
    const { conv } = await background();
    const [child] = await childRunsOf(db, conv);
    if (!child) throw new Error("no child dispatched");
    openBarrier("hold");
    const delivery = await waitFor(
      async () => ofType(await eventsOf(db, conv), "subagent_delivery")[0] ?? null,
      30_000,
      "the finished delivery",
    );
    expect(delivery.payload).toEqual({
      subagentId: child.conversationId,
      childRunId: child.runId,
      description: "Held task",
      kind: "finished",
      status: "completed",
      text: "child reply",
      triggerAccountId: ownerId,
    });
    expect(delivery.runId).toBeNull();
    const events = await eventsOf(db, conv);
    const finished = ofType(events, "subagent_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload).toMatchObject({
      subagentId: child.conversationId,
      childRunId: child.runId,
      status: "completed",
    });
    // the display event comes first, in the same transaction
    expect(finished[0]?.seq).toBe(delivery.seq - 1);
  }, 60_000);
});

describe("finish deliveries", () => {
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

  const deps = (): DispatchDeps => ({
    db,
    eventLog: k.app.get(EventLog),
    purposes: k.app.get(ModelPurposesService),
    registry: k.app.get(ProviderRegistry),
    config: { get: () => k.app.get(KernelConfigService).get() },
    // the child run is finished by hand here, never executed
    enqueue: async () => {},
    log: { error: () => {}, warn: () => {} },
    commitDispatch: (a, plan, child) => k.app.get(SubagentsService).commitDispatch(a, plan, child),
  });

  it("idempotent finish: two finishers write one delivery", async () => {
    const { conv, ctx } = await parentRun();
    const out = await dispatchSubagent(deps(), {
      ctx,
      callId: "c1",
      input: { description: "Twice", prompt: "finish twice" },
    });
    if (out.kind !== "dispatched") throw new Error("not dispatched");
    await db
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", out.childRunId)
      .execute();
    await finishChildByHand(
      db,
      eventLogFor(db, k.app.get<ExtensionContext["bus"]>(KERNEL_BUS)),
      { conversationId: out.childConversationId, runId: out.childRunId },
      "by hand",
    );
    const deliveries = k.app.get(SubagentDeliveries);
    await Promise.all([
      deliveries.childFinished(out.childRunId),
      deliveries.childFinished(out.childRunId),
    ]);
    await deliveries.childFinished(out.childRunId);
    const events = await eventsOf(db, conv);
    const delivered = ofType(events, "subagent_delivery");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.payload).toMatchObject({ kind: "finished", text: "by hand" });
    expect(ofType(events, "subagent_finished")).toHaveLength(1);
  }, 60_000);

  it("a fork invocation's child is not delivered", async () => {
    const { conv, ctx } = await parentRun();
    const out = await dispatchSubagent(deps(), {
      ctx,
      callId: "c1",
      input: { description: "Fork", prompt: "a fork" },
    });
    if (out.kind !== "dispatched") throw new Error("not dispatched");
    await db
      .updateTable("subagent_dispatches")
      .set({ for_skill: true })
      .where("child_run_id", "=", out.childRunId)
      .execute();
    await finishChildByHand(
      db,
      eventLogFor(db, k.app.get<ExtensionContext["bus"]>(KERNEL_BUS)),
      { conversationId: out.childConversationId, runId: out.childRunId },
      "fork reply",
    );
    await k.app.get(SubagentDeliveries).childFinished(out.childRunId);
    expect(ofType(await eventsOf(db, conv), "subagent_delivery")).toEqual([]);
  }, 60_000);
});
