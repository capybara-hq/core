import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AgentDefinition, normalizeStoredDefinition } from "../../../src/agents/definition.js";
import { EventLog } from "../../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { KernelConfigService } from "../../../src/infra/config/kernel-config.service.js";
import { ModelPurposesService } from "../../../src/models/purposes.js";
import { ProviderRegistry } from "../../../src/runtime/providers.js";
import { type DispatchDeps, dispatchSubagent } from "../../../src/runtime/subagents/dispatch.js";
import { AGENT_REFUSALS } from "../../../src/tools/builtins/agent.js";
import { type ScriptRule, scriptRules } from "../../fixtures/plugins/model-script/index.js";
import { legacyDbFor } from "../../helpers/conversations.js";
import { truncateTables } from "../../helpers/db.js";
import { onlyBuiltins } from "../../helpers/disabled-tools.js";
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
  waitForTerminal,
} from "../../helpers/runs.js";
import { webCaller } from "../../helpers/step-context.js";
import { commitDispatchOwing, finishedDeliveries } from "../../helpers/subagents.js";

/**
 * Agent map Task A3 (spec §4.1, §6): nested sub-agents up to `subagents.maxDepth` on one kernel
 * (`model-script` scripts every level, `sandbox-fake` is the root's shared sandbox): the child's
 * roster, its depth, the depth limit and the org agent gates below depth 1.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");

const CHILD = "You are a sub-agent";
const RESEARCHER = "You are the researcher";
const SCRIPT = { provider: "model-script", model: "script-1" };

const agentCall = (input: Record<string, unknown>) => ({ name: "Agent", input });

const RULES: ScriptRule[] = [
  // a general-purpose grandchild of the researcher
  { when: { systemIncludes: CHILD, lastUserIncludes: "gc-go" }, reply: { text: "gc reply" } },
  // the researcher (an org agent child at depth 1)
  {
    when: { systemIncludes: RESEARCHER, lastToolResultIncludes: "in the background" },
    reply: { text: "research done" },
  },
  {
    when: { systemIncludes: RESEARCHER, lastUserIncludes: "research it", assistantTurns: 0 },
    reply: {
      toolCalls: [
        agentCall({ description: "Hidden", prompt: "h", subagent_type: "hidden" }),
        agentCall({ description: "Closed", prompt: "d", subagent_type: "closed" }),
        agentCall({ description: "Grandchild", prompt: "gc-go" }),
      ],
    },
  },
  // the chain root → L1 → L2 → L3: each level goes on after its immediate `Agent` result
  {
    when: {
      systemIncludes: CHILD,
      lastUserIncludes: "L2-go",
      lastToolResultIncludes: "background",
    },
    reply: { text: "L2 reply" },
  },
  {
    when: {
      systemIncludes: CHILD,
      lastUserIncludes: "L1-go",
      lastToolResultIncludes: "background",
    },
    reply: { text: "L1 reply" },
  },
  {
    when: { lastUserIncludes: "SCENARIO chain", lastToolResultIncludes: "background" },
    reply: { text: "chain done" },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "L3-go", assistantTurns: 0 },
    reply: {
      toolCalls: [{ name: "Write", input: { file_path: "/workspace/deep.txt", content: "deep" } }],
    },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "L3-go", assistantTurns: 1 },
    reply: { text: "L3 reply" },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "L2-go", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Level 3", prompt: "L3-go" })] },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "L1-go", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Level 2", prompt: "L2-go" })] },
  },
  {
    when: { lastUserIncludes: "SCENARIO chain", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Level 1", prompt: "L1-go" })] },
  },
  // the gates scenario's root
  {
    when: { lastUserIncludes: "SCENARIO gates", lastToolResultIncludes: "background" },
    reply: { text: "gates done" },
  },
  {
    when: { lastUserIncludes: "SCENARIO gates", assistantTurns: 0 },
    reply: {
      toolCalls: [
        agentCall({ description: "Research", prompt: "research it", subagent_type: "researcher" }),
      ],
    },
  },
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
  root = await mkdtemp(join(tmpdir(), "cap-nested-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE],
        extensionConfig: { "model-script": { rules: RULES }, "sandbox-fake": { root } },
        // these tests are about dispatch, not waking (subagents/wake.test.ts): a parent woken by
        // its children's deliveries would race their last-reply and one-run assertions
        runtime: { wakeOnBackgroundTask: false },
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
let member: Req;
let ownerId: string;
let memberId: string;
let orgId: string;
let leadId: string;

async function createAgent(
  req: Req,
  definition: Record<string, unknown>,
  visibility: Record<string, unknown> = { visibility: "org" },
): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: { definition, ...visibility },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.audit_events, capybara.subagent_dispatches, capybara.sandboxes, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  capture.reset();
  scriptRules([]);
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  memberId = (await accounts.createLocal({ login: "member", password: PW, displayName: "M" })).id;
  owner = await session(k, "owner");
  member = await session(k, "member");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, memberId, "member", ownerId);
  leadId = await createAgent(owner, {
    name: "Lead",
    instructions: "Lead the work.",
    model: SCRIPT,
    disabledTools: onlyBuiltins(["Agent", "Write"].map((name) => ({ kind: "builtin", name }))),
  });
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

const childOf = async (parent: string) =>
  db
    .selectFrom("conversations")
    .select(["id", "subagent_depth", "agent_id"])
    .where("parent_conversation_id", "=", parent)
    .orderBy("created_at")
    .execute();

const lastUserText = (r: ModelRequest): string => {
  const m = r.messages.findLast(
    (x) => x.role === "user" && x.content.some((b) => b.type === "text"),
  );
  const content = m?.content ?? [];
  if (typeof content === "string") return content;
  return content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
};

const toolsOf = (text: string): string[] => {
  const req = capture.sent.find((r) => lastUserText(r).includes(text));
  if (!req) throw new Error(`no request for ${text}`);
  return (req.tools ?? []).map((t) => t.name).sort();
};

async function converse(req: Req, agentId: string, text: string) {
  const conv = await createConv(req, orgId, agentId);
  await postMessage(req, orgId, conv, text);
  await waitForTerminal(db, conv, 1, 60_000);
  return { conv, events: await eventsOf(db, conv) };
}

describe("nested sub-agents", () => {
  it("root → child → grandchild → great-grandchild dispatch with the default maxDepth", async () => {
    const { conv, events } = await converse(owner, leadId, "SCENARIO chain");
    expect(finalText(events)).toBe("chain done");
    // every level's finish is delivered to the level above it
    expect((await finishedDeliveries(db, conv)).map((d) => d.text)).toEqual(["L1 reply"]);
    const [l1] = await childOf(conv);
    expect((await finishedDeliveries(db, l1?.id as string)).map((d) => d.text)).toEqual([
      "L2 reply",
    ]);
    const [l2] = await childOf(l1?.id as string);
    expect((await finishedDeliveries(db, l2?.id as string)).map((d) => d.text)).toEqual([
      "L3 reply",
    ]);
    const [l3] = await childOf(l2?.id as string);
    expect([l1, l2, l3].map((c) => c?.subagent_depth)).toEqual([1, 2, 3]);
    expect(await childOf(l3?.id as string)).toEqual([]);
    // depths 1 and 2 have Agent; depth 3 (the default maxDepth) does not; every child has the
    // message tools (agent map spec §4.2, §4.3)
    expect(toolsOf("L1-go")).toEqual(["Agent", "SendMessage", "SubagentHandback", "Write"]);
    expect(toolsOf("L2-go")).toEqual(["Agent", "SendMessage", "SubagentHandback", "Write"]);
    expect(toolsOf("L3-go")).toEqual(["SendMessage", "SubagentHandback", "Write"]);
    // the frozen definitions: Agent kept below the limit, removed at it (by key)
    const frozenDeny = async (id: string) => {
      const started = ofType(await eventsOf(db, id), "subagent_started")[0];
      return started?.payload.definition.subagentTools?.deny ?? [];
    };
    expect(await frozenDeny(l2?.id as string)).not.toContain("Agent");
    expect(await frozenDeny(l3?.id as string)).toContain("Agent");
    // the whole tree counts against the root run's budget window (spec §6)
    const rootRun = await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    const rows = await db
      .selectFrom("subagent_dispatches")
      .select(["budget_run_id", "parent_conversation_id"])
      .execute();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.budget_run_id))).toEqual(new Set([rootRun.id]));
    // the great-grandchild wrote into the root conversation's sandbox
    // one instance, in the root conversation's device
    const sandboxes = await db.selectFrom("device_instances").select("device_id").execute();
    const { device_id: rootEnv } = await db
      .selectFrom("conversations")
      .select("device_id")
      .where("id", "=", conv)
      .executeTakeFirstOrThrow();
    expect(sandboxes.map((s) => s.device_id)).toEqual([rootEnv]);
  }, 90_000);

  it("org allowlist, dispatchable and visibility gates are checked at depth 2", async () => {
    const hidden = await createAgent(
      owner,
      { name: "Hidden", instructions: "x", model: SCRIPT, subagents: { dispatchable: true } },
      { visibility: "members", memberIds: [ownerId] },
    );
    const closed = await createAgent(owner, {
      name: "Closed",
      instructions: "x",
      model: SCRIPT,
      subagents: { dispatchable: true },
    });
    const researcherBlock = {
      agents: [
        { agentId: hidden, as: "hidden", description: "Hidden work." },
        { agentId: closed, as: "closed", description: "Closed work." },
      ],
    };
    const researcher = await createAgent(owner, {
      name: "Researcher",
      instructions: `${RESEARCHER}.`,
      model: SCRIPT,
      disabledTools: onlyBuiltins([{ kind: "builtin", name: "Agent" }]),
      subagents: { ...researcherBlock, dispatchable: true },
    });
    // closed stops being dispatchable after the researcher allowlisted it
    const patch = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${closed}`,
      payload: {
        definition: {
          name: "Closed",
          instructions: "x",
          model: SCRIPT,
          subagents: { dispatchable: false },
        },
      },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    const lead = await createAgent(owner, {
      name: "Gatekeeper",
      instructions: "Lead the work.",
      model: SCRIPT,
      disabledTools: onlyBuiltins([{ kind: "builtin", name: "Agent" }]),
      subagents: {
        agents: [{ agentId: researcher, as: "researcher", description: "Research." }],
      },
    });

    const { conv, events } = await converse(member, lead, "SCENARIO gates");
    expect(finalText(events)).toBe("gates done");
    expect((await finishedDeliveries(db, conv)).map((d) => d.text)).toEqual(["research done"]);
    const [r] = await childOf(conv);
    expect((await finishedDeliveries(db, r?.id as string)).map((d) => d.text)).toEqual([
      "gc reply",
    ]);
    expect(r).toMatchObject({ subagent_depth: 1, agent_id: researcher });
    const rEvents = await eventsOf(db, r?.id as string);
    // the researcher child froze its own roster
    expect(ofType(rEvents, "subagent_started")[0]?.payload.definition.subagents).toEqual({
      ...researcherBlock,
      dispatchable: true,
    });
    const results = ofType(rEvents, "tool_result").filter((e) => e.payload.toolKey === "Agent");
    const byCall = (prompt: string) => {
      const call = ofType(rEvents, "assistant_message")
        .flatMap((m) => m.payload.content)
        .find((b) => b.type === "tool_call" && (b.input as { prompt?: string }).prompt === prompt);
      return results.find((x) => x.payload.callId === (call as { id: string } | undefined)?.id);
    };
    expect(byCall("h")?.payload).toMatchObject({
      isError: true,
      content: AGENT_REFUSALS.agentNotAvailable("hidden"),
    });
    expect(byCall("d")?.payload).toMatchObject({
      isError: true,
      content: AGENT_REFUSALS.agentNotAvailable("closed"),
    });
    expect(byCall("gc-go")?.payload.isError).toBe(false);
    const refusals = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "detail"])
      .where("action", "=", "subagent.refused")
      .execute();
    expect(refusals.map((x) => (x.detail as { gate: string }).gate).sort()).toEqual([
      "dispatchable",
      "visibility",
    ]);
    for (const x of refusals) {
      expect(x.actor_account_id).toBe(memberId);
      expect(x.detail).toMatchObject({ parentConversationId: r?.id });
    }
    // the general-purpose grandchild is a copy of the researcher with its roster, at depth 2
    const [gc] = await childOf(r?.id as string);
    expect(gc).toMatchObject({ subagent_depth: 2, agent_id: researcher });
    const gcStarted = ofType(await eventsOf(db, gc?.id as string), "subagent_started")[0];
    expect(gcStarted?.payload.definition.subagents).toEqual({
      ...researcherBlock,
      dispatchable: true,
    });
  }, 90_000);
});

describe("the depth limit and gates on a forged call", () => {
  const deps = (): DispatchDeps => ({
    db,
    eventLog: k.app.get(EventLog),
    purposes: k.app.get(ModelPurposesService),
    registry: k.app.get(ProviderRegistry),
    config: { get: () => k.app.get(KernelConfigService).get() },
    // the children are finished by hand (or not at all) here: no run job is owed, none runs
    owe: async () => true,
    log: { error: () => {}, warn: () => {} },
    commitDispatch: commitDispatchOwing(k.app, k.app.get(EventLog), async () => true),
  });

  /** A `running` run of a new conversation of `agentId`, as the run at `depth` would see it. */
  async function runAt(agentId: string, depth: number, agent?: AgentDefinition) {
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
    return {
      conv,
      ctx: {
        orgId,
        conversationId: conv,
        runId,
        step: 1,
        agentId,
        agentVersion: 1,
        agent: agent ?? normalizeStoredDefinition(v.definition),
        accountId: ownerId,
        ...webCaller(ownerId),
        signal: new AbortController().signal,
        ...(depth > 0 && {
          parent: {
            conversationId: randomUUID(),
            runId: randomUUID(),
            callId: "p1",
            depth: depth - 1,
            rootConversationId: randomUUID(),
          },
        }),
      },
    };
  }

  it("a depth-3 agent has no Agent tool and a forged call is refused with depthLimit", async () => {
    expect(AGENT_REFUSALS.depthLimit(3)).toBe(
      "Sub-agents can be nested at most 3 levels deep, and you are at the deepest level; do this task yourself.",
    );
    const { conv, ctx } = await runAt(leadId, 3);
    const out = await dispatchSubagent(deps(), {
      ctx,
      callId: "c1",
      input: { description: "Too deep", prompt: "x" },
    });
    expect(out).toEqual({ kind: "refused", content: AGENT_REFUSALS.depthLimit(3) });
    expect(await childOf(conv)).toEqual([]);
    // depth 2 may still dispatch: its child is created at depth 3
    const ok = await runAt(leadId, 2);
    const two = await dispatchSubagent(deps(), {
      ctx: ok.ctx,
      callId: "c1",
      input: { description: "Deep", prompt: "x" },
    });
    expect(two.kind).toBe("dispatched");
    const [deep] = await childOf(ok.conv);
    expect(deep?.subagent_depth).toBe(3);
    const started = ofType(await eventsOf(db, deep?.id as string), "subagent_started")[0];
    expect(started?.payload.definition.subagentTools?.deny).toContain("Agent");
  }, 60_000);

  it("the allowlist of the dispatching agent's current version is checked below depth 1", async () => {
    const target = await createAgent(owner, {
      name: "Target",
      instructions: "x",
      model: SCRIPT,
      subagents: { dispatchable: true },
    });
    // a depth-1 child whose frozen roster lists the target, of an agent whose current version no
    // longer does (the lead never allowlisted it)
    const frozen = normalizeStoredDefinition({
      name: "Lead",
      instructions: "Lead the work.",
      model: SCRIPT,
      disabledTools: onlyBuiltins([{ kind: "builtin", name: "Agent" }]),
      subagents: { agents: [{ agentId: target, as: "target", description: "Target." }] },
    });
    const { conv, ctx } = await runAt(leadId, 1, frozen);
    const out = await dispatchSubagent(deps(), {
      ctx,
      callId: "c1",
      input: { description: "Target", prompt: "x", subagent_type: "target" },
    });
    expect(out).toEqual({ kind: "refused", content: AGENT_REFUSALS.agentNotAvailable("target") });
    expect(await childOf(conv)).toEqual([]);
    const refusals = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "subagent.refused")
      .execute();
    expect(refusals.map((x) => (x.detail as { gate: string }).gate)).toEqual(["allowlist"]);
  }, 60_000);
});
