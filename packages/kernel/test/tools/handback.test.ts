import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeStoredDefinition } from "../../src/agents/definition.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { SubagentDeliveries } from "../../src/runtime/subagents/deliveries.js";
import { SubagentMessages } from "../../src/runtime/subagents/messages.js";
import { renderSubagentDelivery } from "../../src/runtime/subagents/render.js";
import { SubagentsService } from "../../src/runtime/subagents/subagents.service.js";
import { HANDBACK_FORK_TEXT, HANDBACK_RESULT_TEXT } from "../../src/tools/builtins/handback.js";
import type { ToolStepContext } from "../../src/tools/pipeline.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ScriptRule } from "../fixtures/plugins/model-script/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
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
  waitForTerminal,
} from "../helpers/runs.js";
import { webCaller } from "../helpers/step-context.js";
import { finishedDeliveries, subagentFinishes } from "../helpers/subagents.js";

/**
 * Agent map spec §4.3, §4.5 (Task A6): `SubagentHandback` delivers a report to the parent and the
 * child keeps its turn; only sub-agents are offered it; a run that handed back and completed
 * delivers no finish (only `subagent_finished`, acceptance 2026-11-07). The parent run is made by hand (a `running` run no worker holds).
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");

const CHILD = "You are a sub-agent";

const RULES: ScriptRule[] = [
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "hb-task", assistantTurns: 0 },
    reply: { toolCalls: [{ name: "SubagentHandback", input: { message: "REPORT: all good" } }] },
  },
  // after the handback the child goes on: one more tool step, then its final reply
  {
    when: { systemIncludes: CHILD, lastToolResultIncludes: HANDBACK_RESULT_TEXT },
    reply: { toolCalls: [{ name: "Read", input: { file_path: "/workspace/none.txt" } }] },
  },
  { when: { systemIncludes: CHILD, lastUserIncludes: "hb-task" }, reply: { text: "wrapped up" } },
];

const capture = captureProviderRequests();

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
let ownerId: string;
let orgId: string;
let leadId: string;
let soloId: string;
let root: string;

async function createAgent(name: string, tools: string[]): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name,
        instructions: `${name} works.`,
        model: { provider: "model-script", model: "script-1" },
        disabledTools: onlyBuiltins(tools.map((t) => ({ kind: "builtin", name: t }))),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

beforeAll(async () => {
  capture.install();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-handback-"));
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
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  leadId = await createAgent("Lead", ["Agent", "Read"]);
  soloId = await createAgent("Solo", ["Read"]);
}, 180_000);

afterAll(async () => {
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

/** A `running` parent run of a new Lead conversation that no worker holds, and its context. */
async function parentRun(): Promise<{ conv: string; ctx: ToolStepContext }> {
  const conv = await createConv(owner, orgId, leadId);
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
    .where("agent_id", "=", leadId)
    .where("version", "=", 1)
    .executeTakeFirstOrThrow();
  return {
    conv,
    ctx: {
      orgId,
      conversationId: conv,
      runId,
      step: 1,
      agentId: leadId,
      agentVersion: 1,
      agent: normalizeStoredDefinition(v.definition),
      accountId: ownerId,
      ...webCaller(ownerId),
      signal: new AbortController().signal,
    },
  };
}

/** Dispatches the reporting child and waits for its finish (`subagent_finished`). */
async function reported() {
  const { conv, ctx } = await parentRun();
  const out = await k.app.get(SubagentsService).dispatch({
    ctx,
    callId: "c1",
    input: { description: "Reporter", prompt: "hb-task: report back" },
  });
  if (out.kind !== "dispatched") throw new Error(out.content);
  await subagentFinishes(db, conv, 1);
  return { conv, childId: out.childConversationId, childRunId: out.childRunId };
}

const toolNames = (r: ModelRequest | undefined) => (r?.tools ?? []).map((t) => t.name);

describe("SubagentHandback", { timeout: 90_000 }, () => {
  it("handback appends a report delivery and the child keeps its turn", async () => {
    const { conv, childId, childRunId } = await reported();
    const child = await eventsOf(db, childId);
    const results = ofType(child, "tool_result");
    expect(results.map((r) => [r.payload.toolKey, r.payload.content, r.payload.isError])).toEqual([
      ["SubagentHandback", HANDBACK_RESULT_TEXT, false],
      ["Read", expect.any(String), expect.any(Boolean)],
    ]);
    // the child went on after the handback: two more model calls, one run
    expect(ofType(child, "assistant_message")).toHaveLength(3);
    expect(ofType(child, "run_started")).toHaveLength(1);
    const deliveries = ofType(await eventsOf(db, conv), "subagent_delivery");
    expect(deliveries.map((d) => d.payload)).toEqual([
      {
        subagentId: childId,
        childRunId,
        description: "Reporter",
        kind: "report",
        text: "REPORT: all good",
        triggerAccountId: ownerId,
      },
    ]);
    // a handback is audited like any tool call
    const audits = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "tool.called")
      .execute();
    expect(audits.map((a) => (a.detail as { toolKey: string }).toolKey)).toContain(
      "SubagentHandback",
    );
  });

  it("not offered to the root", async () => {
    capture.reset();
    // a root with Agent gets SendMessage (to reach its sub-agents), never SubagentHandback
    const lead = await createConv(owner, orgId, leadId);
    await postMessage(owner, orgId, lead, "LEAD-ROOT hello");
    await waitForTerminal(db, lead, 1, 30_000);
    const solo = await createConv(owner, orgId, soloId);
    await postMessage(owner, orgId, solo, "SOLO-ROOT hello");
    await waitForTerminal(db, solo, 1, 30_000);
    const req = (marker: string) => capture.sent.find((r) => JSON.stringify(r).includes(marker));
    expect(toolNames(req("LEAD-ROOT"))).toContain("SendMessage");
    expect(toolNames(req("LEAD-ROOT"))).not.toContain("SubagentHandback");
    // a root without Agent has nobody to send to
    expect(toolNames(req("SOLO-ROOT"))).not.toContain("SendMessage");
    expect(toolNames(req("SOLO-ROOT"))).not.toContain("SubagentHandback");
    // a child gets both
    await reported();
    const childReq = capture.sent.find(
      (r) => r.system.some((s) => s.text.includes(CHILD)) && JSON.stringify(r).includes("hb-task"),
    );
    expect(toolNames(childReq)).toEqual(
      expect.arrayContaining(["SendMessage", "SubagentHandback"]),
    );
  });

  it("a fork invocation's child is refused a handback: its final reply is the report", async () => {
    const { conv, ctx } = await parentRun();
    const out = await k.app.get(SubagentsService).dispatch({
      ctx,
      callId: "c1",
      input: { description: "Forked", prompt: "plain task" },
    });
    if (out.kind !== "dispatched") throw new Error(out.content);
    await finishedDeliveries(db, conv, 1);
    // mark its dispatch a fork invocation's (phase D `for_skill`)
    await db
      .updateTable("subagent_dispatches")
      .set({ for_skill: true })
      .where("child_run_id", "=", out.childRunId)
      .execute();
    const before = ofType(await eventsOf(db, conv), "subagent_delivery").length;
    const childCtx: ToolStepContext = {
      ...ctx,
      conversationId: out.childConversationId,
      runId: out.childRunId,
      parent: {
        conversationId: conv,
        runId: ctx.runId,
        callId: "c1",
        depth: 0,
        rootConversationId: conv,
        forSkill: true,
      },
    };
    const messages = k.app.get(SubagentMessages);
    expect(await messages.toParent(childCtx, "report", "REPORT", "h1")).toEqual({
      content: HANDBACK_FORK_TEXT,
      isError: true,
    });
    expect((await messages.toChild(childCtx, "h2", "parent", "a note")).content).toBe(
      HANDBACK_FORK_TEXT,
    );
    expect(ofType(await eventsOf(db, conv), "subagent_delivery")).toHaveLength(before);
    // and it is offered neither tool to reach its parent
    const tools = await k.app.get(ToolRegistry).forAgent(orgId, {
      source: "web",
      disabledTools: onlyBuiltins([{ kind: "builtin", name: "Read" }]),
      child: true,
      forkChild: true,
    });
    expect(tools.tools.map((t) => t.key)).toEqual(["Read"]);
  });

  it("a run that handed back and completed delivers no finish: only subagent_finished", async () => {
    const { conv, childId, childRunId } = await reported();
    const events = await eventsOf(db, conv);
    expect(
      ofType(events, "subagent_finished").map((e) => [e.payload.childRunId, e.payload.status]),
    ).toEqual([[childRunId, "completed"]]);
    expect(ofType(events, "subagent_delivery").map((d) => d.payload.kind)).toEqual(["report"]);
    // a second finisher (a stop, the sweep) writes nothing more
    expect(await k.app.get(SubagentDeliveries).childFinished(childRunId)).toBe(false);
    expect((await eventsOf(db, conv)).length).toBe(events.length);
    const report = ofType(await eventsOf(db, conv), "subagent_delivery").find(
      (d) => d.payload.kind === "report",
    );
    expect(renderSubagentDelivery(report?.payload as EventPayload<"subagent_delivery">)).toBe(
      `Sub-agent ${childId} ("Reporter") handed back a report:\nREPORT: all good`,
    );
  });
});
