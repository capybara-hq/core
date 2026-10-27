import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import type { EvalResultView, EvalRunView } from "../../src/evals/runs.service.js";
import { takeSnapshot, toEvents } from "../../src/evals/snapshot.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { checkOrgAgent, currentAgentDefinition } from "../../src/runtime/subagents/org-agents.js";
import { AGENT_REFUSALS } from "../../src/tools/builtins/agent.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { type ScriptRule, scriptRules } from "../fixtures/plugins/model-script/index.js";
import { truncateTables } from "../helpers/db.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Phase C Task 12 (spec §5.5, §9, §21 "Org agents"): another org agent as a sub-agent behind the
 * three gates (the parent's allowlist, `dispatchable`, visibility to the starter) and not deleted,
 * checked at every dispatch and follow-up; its frozen version; the starter's credentials,
 * approvals and grants; `subagent.dispatched` / `subagent.refused` audit rows.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const MEM_CONNECTOR = fixture("mem-connector");

const ANALYST = "You are the analyst";
const SCRIPT = { provider: "model-script", model: "script-1" };

const agentCall = (input: Record<string, unknown>) => ({ name: "agent", input });

const RULES: ScriptRule[] = [
  // the analyst (child)
  {
    when: { systemIncludes: ANALYST, lastUserIncludes: "cred:", assistantTurns: 0 },
    reply: { toolCalls: [{ name: "mine__search", input: {} }] },
  },
  {
    when: { systemIncludes: ANALYST, lastToolResultIncludes: "called search" },
    reply: { text: "analyst searched" },
  },
  {
    when: { systemIncludes: ANALYST, lastUserIncludes: "policy:", assistantTurns: 0 },
    reply: {
      toolCalls: [
        { name: "mine__create", input: {} },
        { name: "mine__remove", input: {} },
      ],
    },
  },
  {
    when: { systemIncludes: ANALYST, lastToolResultIncludes: "called create" },
    reply: { text: "analyst created" },
  },
  {
    when: { systemIncludes: ANALYST, lastUserIncludes: "follow up" },
    reply: { text: "analyst followed up" },
  },
  { when: { systemIncludes: ANALYST }, reply: { text: "analyst hello" } },
  // the lead (parent)
  {
    when: { lastUserIncludes: "SCENARIO cred", assistantTurns: 0 },
    reply: {
      toolCalls: [
        agentCall({
          description: "Search",
          prompt: "cred: search",
          subagent_type: "analyst",
          model: "fast",
        }),
      ],
    },
  },
  { when: { lastToolResultIncludes: "analyst searched" }, reply: { text: "cred done" } },
  {
    when: { lastUserIncludes: "SCENARIO policy", assistantTurns: 0 },
    reply: {
      toolCalls: [
        agentCall({ description: "Create", prompt: "policy: go", subagent_type: "analyst" }),
      ],
    },
  },
  { when: { lastToolResultIncludes: "analyst created" }, reply: { text: "policy done" } },
  {
    when: { lastUserIncludes: "SCENARIO hello", assistantTurns: 0 },
    reply: {
      toolCalls: [agentCall({ description: "Hello", prompt: "hello", subagent_type: "analyst" })],
    },
  },
  {
    when: { lastUserIncludes: "SCENARIO follow", assistantTurns: 2 },
    reply: {
      toolCalls: [
        agentCall({ description: "Again", prompt: "follow up", resume: "{{lastAgentId}}" }),
      ],
    },
  },
  { when: { lastToolResultIncludes: "is not available to" }, reply: { text: "refused done" } },
  { when: { lastToolResultIncludes: "analyst followed up" }, reply: { text: "follow done" } },
  { when: { lastToolResultIncludes: "analyst hello" }, reply: { text: "hello done" } },
];

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let k: Kernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  const { startKernel } = await import("../helpers/runs.js");
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, MEM_CONNECTOR],
        extensionConfig: { "model-script": { rules: RULES } },
      },
    ),
  );
}, 180_000);

afterAll(async () => {
  await k?.stop();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const ids: Record<"owner" | "ana" | "member" | "outsider", string> = {
  owner: "",
  ana: "",
  member: "",
  outsider: "",
};
let owner: Req;
let ana: Req;
let member: Req;
let outsider: Req;
let orgId: string;
let connectorId: string;
let analystId: string;
let leadId: string;

const ANALYST_DEF = (over: Record<string, unknown> = {}) => ({
  name: "Data Analyst",
  instructions: `${ANALYST}, v1.`,
  model: SCRIPT,
  tools: [{ kind: "connector", connectorId, tools: "all" }],
  // its own ask on create
  toolPolicies: { mine__create: "ask" },
  subagents: { dispatchable: true },
  ...over,
});

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.audit_events, capybara.subagent_dispatches, capybara.approvals, capybara.conversation_tool_grants, capybara.tool_grants, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.connector_tools, capybara.connectors, capybara.secrets, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  scriptRules([]);
  const st = memState();
  st.callAuths.length = 0;
  st.servers.mine = {
    tools: ["search", "create", "remove"].map((name) => ({
      name,
      description: `The ${name} tool.`,
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    })),
  };
  const accounts = new AccountsService(db);
  for (const login of ["owner", "ana", "member", "outsider"] as const) {
    ids[login] = (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  }
  owner = await session(k, "owner");
  ana = await session(k, "ana");
  member = await session(k, "member");
  outsider = await session(k, "outsider");
  orgId = await createOrg(owner);
  for (const login of ["ana", "member", "outsider"] as const) {
    await testMembers(db).add(orgId, ids[login], "member", ids.owner);
  }
  const en = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/mem-connector`,
    payload: { enabled: true },
  });
  expect(en.statusCode, en.body).toBe(200);
  // a personal-credential connector: everyone connects their own token
  const c = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/connectors`,
    payload: {
      name: "Mine",
      slug: "mine",
      connector: "mem",
      endpoint: { server: "mine" },
      auth: { type: "bearer", ownership: "personal" },
      credential: { token: "owner-token-123" },
    },
  });
  expect(c.statusCode, c.body).toBe(201);
  connectorId = (c.json() as { connector: { id: string } }).connector.id;
  for (const [req, token] of [
    [ana, "ana-token-12345"],
    [member, "member-token-123"],
  ] as const) {
    const put = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/connectors/${connectorId}/credentials/me`,
      payload: { token },
    });
    expect(put.statusCode, put.body).toBe(204);
  }
  // ana's analyst: shared with the owner and the member only, dispatchable
  const an = await ana({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: ANALYST_DEF(),
      visibility: "members",
      memberIds: [ids.owner, ids.member],
    },
  });
  expect(an.statusCode, an.body).toBe(201);
  analystId = (an.json() as { agent: { id: string } }).agent.id;
  // the owner's lead, shared with the whole org; it lacks search / create, denies remove
  const lead = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Lead",
        instructions: "Lead the work.",
        model: SCRIPT,
        tools: [
          { kind: "builtin", name: "agent" },
          { kind: "connector", connectorId, tools: ["remove"] },
        ],
        toolPolicies: { mine__remove: "deny" },
        subagents: {
          agents: [{ agentId: analystId, as: "analyst", description: "Answers data questions." }],
        },
      },
      visibility: "org",
    },
  });
  expect(lead.statusCode, lead.body).toBe(201);
  leadId = (lead.json() as { agent: { id: string } }).agent.id;
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

const agentResults = (events: ConversationEvent[]) =>
  ofType(events, "tool_result").filter((r) => r.payload.toolKey === "agent");

async function childrenOf(parent: string) {
  return db
    .selectFrom("conversations")
    .select(["id", "agent_id", "account_id"])
    .where("parent_conversation_id", "=", parent)
    .orderBy("created_at")
    .execute();
}

async function childRuns(child: string) {
  return db
    .selectFrom("runs")
    .select(["id", "agent_version", "trigger_account_id"])
    .where("conversation_id", "=", child)
    .orderBy("created_at")
    .execute();
}

async function audits(action: string) {
  return db
    .selectFrom("audit_events")
    .select(["actor_account_id", "target", "detail"])
    .where("action", "=", action)
    .orderBy("id")
    .execute();
}

async function converse(req: Req, text: string, conv?: string, n = 1) {
  const id = conv ?? (await createConv(req, orgId, leadId));
  await postMessage(req, orgId, id, text);
  await waitForTerminal(db, id, n, 30_000);
  return { conv: id, events: await eventsOf(db, id) };
}

async function patchAnalyst(body: Record<string, unknown>) {
  const r = await ana({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/agents/${analystId}`,
    payload: body,
  });
  expect(r.statusCode, r.body).toBe(200);
}

const NOT_AVAILABLE = AGENT_REFUSALS.agentNotAvailable("analyst");

describe("dispatching an org agent", () => {
  it("runs the analyst as itself (frozen version, own model) with the starter's personal credential; audited subagent.dispatched", async () => {
    const { conv, events } = await converse(member, "SCENARIO cred");
    expect(finalText(events)).toBe("cred done");
    const [child, ...more] = await childrenOf(conv);
    expect(more).toEqual([]);
    // the child conversation is the analyst's, owned by the parent conversation's owner
    expect(child).toMatchObject({ agent_id: analystId, account_id: ids.member });
    const runs = await childRuns(child?.id as string);
    expect(runs).toEqual([
      expect.objectContaining({ agent_version: 1, trigger_account_id: ids.member }),
    ]);
    const cev = await eventsOf(db, child?.id as string);
    const started = ofType(cev, "subagent_started")[0];
    expect(started?.payload.template).toEqual({ source: "agent", id: analystId, version: 1 });
    expect(started?.payload.definition.instructions).toBe(`${ANALYST}, v1.`);
    expect(ofType(cev, "run_started")[0]?.payload.agentVersion).toBe(1);

    // the starter's token, never the analyst owner's (nor the lead owner's)
    expect(memState().callAuths).toEqual([
      { server: "mine", name: "search", authorization: "Bearer member-token-123" },
    ]);
    // a model on the call is ignored: the agent's own model, said in the status line
    const [result] = agentResults(events);
    expect(result?.payload.content).toContain("· model: the agent's own ·");
    expect(ofType(events, "subagent_dispatched")[0]?.payload.model).toEqual(SCRIPT);

    const [audit] = await audits("subagent.dispatched");
    expect(audit).toMatchObject({ actor_account_id: ids.member, target: child?.id });
    expect(audit?.detail).toMatchObject({
      parentConversationId: conv,
      agentType: "analyst",
      source: "agent",
      agentId: analystId,
      agentVersion: 1,
      resumed: false,
    });
    expect(await audits("subagent.refused")).toEqual([]);
  }, 60_000);

  it("a child is opened through its parent conversation and the analyst's visibility; the list keeps the row", async () => {
    const { conv } = await converse(member, "SCENARIO hello");
    const [child] = await childrenOf(conv);
    const childId = child?.id as string;
    const base = `/api/v1/orgs/${orgId}/conversations`;
    const routes = ["", "/events", "/usage"];
    const status = async (path: string) =>
      (await member({ method: "GET", url: `${base}/${childId}${path}` })).statusCode;
    const list = async () => {
      const r = await member({ method: "GET", url: `${base}/${conv}/subagents` });
      expect(r.statusCode, r.body).toBe(200);
      return (r.json() as { subagents: { id: string }[] }).subagents.map((s) => s.id);
    };
    for (const p of routes) expect(await status(p), p).toBe(200);
    expect(await list()).toEqual([childId]);

    // ana takes the member off the analyst's members list: the child no longer opens, while the
    // parent's list still shows its row (its id is in the parent's log anyway)
    await patchAnalyst({ memberIds: [ids.owner] });
    for (const p of routes) expect(await status(p), p).toBe(404);
    expect(await list()).toEqual([childId]);
    await patchAnalyst({ memberIds: [ids.owner, ids.member] });
    for (const p of routes) expect(await status(p), p).toBe(200);

    // the lead (the parent conversation's agent) hidden from the member: the parent is gone for
    // them, and so is the child, although the analyst is still visible to them (review m6)
    const hide = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${leadId}`,
      payload: { visibility: "members", memberIds: [ids.owner] },
    });
    expect(hide.statusCode, hide.body).toBe(200);
    for (const p of routes) expect(await status(p), p).toBe(404);
    const gone = await member({ method: "GET", url: `${base}/${conv}/subagents` });
    expect(gone.statusCode).toBe(404);
  }, 60_000);

  it("the child's trajectory follows the parent conversation's agent: the analyst's owner 404, the lead's owner and an admin 200", async () => {
    // the lead belongs to a plain member here, so its owner and the admin are different people
    await db
      .updateTable("agents")
      .set({ owner_account_id: ids.member })
      .where("id", "=", leadId)
      .execute();
    await db
      .updateTable("memberships")
      .set({ role: "admin" })
      .where("org_id", "=", orgId)
      .where("account_id", "=", ids.outsider)
      .execute();
    const { conv } = await converse(member, "SCENARIO cred");
    const [child] = await childrenOf(conv);
    const trajectory = (req: Req) =>
      req({ method: "GET", url: `/api/v1/orgs/${orgId}/trajectories/${child?.id}` });
    expect((await trajectory(ana)).statusCode).toBe(404);
    const lead = await trajectory(member);
    expect(lead.statusCode, lead.body).toBe(200);
    expect((await trajectory(outsider)).statusCode).toBe(200);
    // the lead's owner loses sight of the analyst: its child trajectory is 404, like the child
    // conversation (final review m3); the parent's stays readable, and an admin still sees both
    await patchAnalyst({ visibility: "members", memberIds: [ids.owner] });
    expect((await trajectory(member)).statusCode).toBe(404);
    expect((await trajectory(outsider)).statusCode).toBe(200);
    const parent = await member({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/trajectories/${conv}`,
    });
    expect(parent.statusCode, parent.body).toBe(200);
  }, 60_000);

  it("its own ask and the parent's deny give the stricter result; the approval goes to the starter and an always grant is stored for the analyst", async () => {
    const conv = await createConv(member, orgId, leadId);
    await postMessage(member, orgId, conv, "SCENARIO policy");
    const child = await waitFor(
      async () => (await childrenOf(conv))[0]?.id,
      20_000,
      "child conversation",
    );
    const approval = await waitFor(
      async () =>
        db
          .selectFrom("approvals")
          .selectAll()
          .where("conversation_id", "=", child)
          .where("status", "=", "pending")
          .executeTakeFirst(),
      20_000,
      "pending approval",
    );
    expect(approval).toMatchObject({ tool_key: "mine__create", requested_for: ids.member });
    // neither owner can decide it
    for (const req of [ana, owner]) {
      const r = await req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/approvals/${approval.id}/decision`,
        payload: { decision: "approve" },
      });
      expect(r.statusCode).toBe(404);
    }
    const ok = await member({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${approval.id}/decision`,
      payload: { decision: "approve", scope: "always" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(db, conv, 1, 30_000);
    expect(finalText(await eventsOf(db, conv))).toBe("policy done");

    const cev = await eventsOf(db, child);
    const remove = ofType(cev, "tool_result").find((r) => r.payload.toolKey === "mine__remove");
    expect(remove?.payload).toMatchObject({
      content: "Tool mine__remove is denied by policy.",
      isError: true,
    });
    const grants = await db
      .selectFrom("tool_grants")
      .select(["account_id", "agent_id", "tool_key"])
      .execute();
    expect(grants).toEqual([
      { account_id: ids.member, agent_id: analystId, tool_key: "mine__create" },
    ]);
  }, 60_000);
});

describe("the gates", () => {
  const refusedWithout = async (req: Req, accountId: string, gate: string) => {
    const { conv, events } = await converse(req, "SCENARIO hello");
    expect(finalText(events)).toBe("refused done");
    expect(agentResults(events)[0]?.payload).toMatchObject({
      content: NOT_AVAILABLE,
      isError: true,
    });
    expect(await childrenOf(conv)).toEqual([]);
    expect(ofType(events, "subagent_dispatched")).toEqual([]);
    expect(await audits("subagent.dispatched")).toEqual([]);
    const refused = await audits("subagent.refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ actor_account_id: accountId, target: analystId });
    expect(refused[0]?.detail).toMatchObject({
      gate,
      parentConversationId: conv,
      agentType: "analyst",
      resumed: false,
    });
  };

  it("a member of the shared parent who is not in the analyst's members list is refused (visibility)", async () => {
    await refusedWithout(outsider, ids.outsider, "visibility");
  }, 60_000);

  it("dispatchable turned off after allowlisting is refused (dispatchable)", async () => {
    await patchAnalyst({ definition: ANALYST_DEF({ subagents: { dispatchable: false } }) });
    await refusedWithout(member, ids.member, "dispatchable");
  }, 60_000);

  it("a deleted analyst is refused (deleted)", async () => {
    const del = await ana({ method: "DELETE", url: `/api/v1/orgs/${orgId}/agents/${analystId}` });
    expect(del.statusCode, del.body).toBe(204);
    await refusedWithout(member, ids.member, "deleted");
  }, 60_000);

  it("a deleted parent agent's allowlist authorizes nothing (allowlist)", async () => {
    expect(await currentAgentDefinition(db, leadId)).not.toBeNull();
    const del = await owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}/agents/${leadId}` });
    expect(del.statusCode, del.body).toBe(204);
    // a run of the deleted lead that is still going reads no allowlist, so the gate refuses
    expect(await currentAgentDefinition(db, leadId)).toBeNull();
    const check = await checkOrgAgent(db, {
      orgId,
      parentDefinition: (await currentAgentDefinition(db, leadId)) ?? {},
      agentId: analystId,
      triggerAccountId: ids.member,
    });
    expect(check).toEqual({ ok: false, gate: "allowlist" });
  });

  it("saving an allowlist with an agent the editor cannot see is 400 agent.subagents_invalid", async () => {
    const hidden = await ana({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: { definition: ANALYST_DEF({ name: "Hidden" }), visibility: "private" },
    });
    expect(hidden.statusCode, hidden.body).toBe(201);
    const hiddenId = (hidden.json() as { agent: { id: string } }).agent.id;
    const r = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Other",
          instructions: "x",
          model: SCRIPT,
          tools: [{ kind: "builtin", name: "agent" }],
          subagents: { agents: [{ agentId: hiddenId, as: "hidden", description: "Hidden." }] },
        },
        visibility: "private",
      },
    });
    expect(r.statusCode, r.body).toBe(400);
    expect((r.json() as { error: { code: string } }).error.code).toBe("agent.subagents_invalid");
  });
});

describe("follow-ups", () => {
  it("a follow-up keeps the frozen version after the analyst's new version; a new dispatch takes the newest", async () => {
    const first = await converse(member, "SCENARIO hello");
    expect(finalText(first.events)).toBe("hello done");
    await patchAnalyst({ definition: ANALYST_DEF({ instructions: `${ANALYST}, v2.` }) });

    const { conv, events } = await converse(member, "SCENARIO follow", first.conv, 2);
    expect(finalText(events)).toBe("follow done");
    const [child, ...more] = await childrenOf(conv);
    expect(more).toEqual([]);
    const runs = await childRuns(child?.id as string);
    expect(runs.map((r) => r.agent_version)).toEqual([1, 1]);
    const started = ofType(await eventsOf(db, child?.id as string), "subagent_started");
    expect(started).toHaveLength(1);
    expect(started[0]?.payload.template.version).toBe(1);
    const dispatched = await audits("subagent.dispatched");
    expect(dispatched.map((a) => (a.detail as { agentVersion: number }).agentVersion)).toEqual([
      1, 1,
    ]);
    expect(dispatched[1]?.detail).toMatchObject({ resumed: true });

    // a new sub-agent runs the newest version
    const fresh = await converse(member, "SCENARIO hello");
    const [freshChild] = await childrenOf(fresh.conv);
    expect((await childRuns(freshChild?.id as string)).map((r) => r.agent_version)).toEqual([2]);
    const freshStarted = ofType(await eventsOf(db, freshChild?.id as string), "subagent_started");
    expect(freshStarted[0]?.payload.definition.instructions).toBe(`${ANALYST}, v2.`);
  }, 90_000);

  it("a follow-up narrows the frozen tools to the analyst's current version (final review I1)", async () => {
    const first = await converse(member, "SCENARIO hello");
    expect(finalText(first.events)).toBe("hello done");
    await patchAnalyst({
      definition: ANALYST_DEF({
        tools: [{ kind: "connector", connectorId, tools: ["search"] }],
        toolPolicies: {},
      }),
    });
    const { conv, events } = await converse(member, "SCENARIO follow", first.conv, 2);
    expect(finalText(events)).toBe("follow done");
    const [child] = await childrenOf(conv);
    const tasks = ofType(await eventsOf(db, child?.id as string), "user_message");
    // the instructions stay v1 (frozen); the tools are what v2 still has
    expect(tasks.at(-1)?.payload.dispatch?.narrowed?.tools).toEqual([
      { kind: "connector", connectorId, tools: ["search"] },
    ]);
  }, 90_000);

  it("a member who loses visibility between dispatch and follow-up is refused; nothing starts", async () => {
    const first = await converse(member, "SCENARIO hello");
    expect(finalText(first.events)).toBe("hello done");
    // ana takes the member off the analyst's members list
    await patchAnalyst({ memberIds: [ids.owner] });

    const { conv, events } = await converse(member, "SCENARIO follow", first.conv, 2);
    expect(finalText(events)).toBe("refused done");
    expect(agentResults(events)[1]?.payload).toMatchObject({
      content: NOT_AVAILABLE,
      isError: true,
    });
    const [child] = await childrenOf(conv);
    expect(await childRuns(child?.id as string)).toHaveLength(1);
    expect(await audits("subagent.dispatched")).toHaveLength(1);
    const refused = await audits("subagent.refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.detail).toMatchObject({ gate: "visibility", resumed: true });
  }, 90_000);

  it("a follow-up after the parent's owner removed the analyst from the allowlist is refused (allowlist, the parent's current version)", async () => {
    const first = await converse(member, "SCENARIO hello");
    expect(finalText(first.events)).toBe("hello done");
    const lead = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${leadId}`,
      payload: {
        definition: {
          name: "Lead",
          instructions: "Lead the work.",
          model: SCRIPT,
          tools: [
            { kind: "builtin", name: "agent" },
            { kind: "connector", connectorId, tools: ["remove"] },
          ],
          toolPolicies: { mine__remove: "deny" },
          subagents: { agents: [] },
        },
      },
    });
    expect(lead.statusCode, lead.body).toBe(200);

    // the conversation's next run uses the new version, whose roster no longer has the analyst,
    // so the follow-up (resume needs no type) is refused by the allowlist gate
    const { events } = await converse(member, "SCENARIO follow", first.conv, 2);
    expect(finalText(events)).toBe("refused done");
    const refused = await audits("subagent.refused");
    expect(refused[0]?.detail).toMatchObject({ gate: "allowlist", resumed: true });
  }, 90_000);

  it("the allowlist is read from the parent agent's current version, not the run's: removing the analyst mid-run refuses that run's next follow-up", async () => {
    // after the analyst's result the same run sends a follow-up
    scriptRules([
      {
        when: { lastToolResultIncludes: "analyst created" },
        reply: {
          toolCalls: [
            agentCall({ description: "Again", prompt: "follow up", resume: "{{lastAgentId}}" }),
          ],
        },
      },
    ]);
    const conv = await createConv(member, orgId, leadId);
    await postMessage(member, orgId, conv, "SCENARIO policy");
    const approval = await waitFor(
      async () =>
        db.selectFrom("approvals").select("id").where("status", "=", "pending").executeTakeFirst(),
      20_000,
      "pending approval",
    );
    // while the child waits, the lead's owner takes the analyst off the allowlist
    const lead = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${leadId}`,
      payload: {
        definition: {
          name: "Lead",
          instructions: "Lead the work.",
          model: SCRIPT,
          tools: [{ kind: "builtin", name: "agent" }],
          subagents: { agents: [] },
        },
      },
    });
    expect(lead.statusCode, lead.body).toBe(200);
    const ok = await member({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${approval.id}/decision`,
      payload: { decision: "approve" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(db, conv, 1, 30_000);
    const events = await eventsOf(db, conv);
    expect(finalText(events)).toBe("refused done");
    expect(agentResults(events)[1]?.payload.content).toBe(NOT_AVAILABLE);
    const refused = await audits("subagent.refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.detail).toMatchObject({ gate: "allowlist", resumed: true });
    // the run itself still runs its own version
    const run = await db
      .selectFrom("runs")
      .select("agent_version")
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    expect(run.agent_version).toBe(1);
  }, 90_000);
});

describe("replay (spec §15.3)", () => {
  it("an org agent child's case is listed under the analyst; its new version as candidate reports subagent_changed, the request stays v1", async () => {
    const { conv } = await converse(member, "SCENARIO hello");
    const [child] = await childrenOf(conv);
    const [run] = await childRuns(child?.id as string);
    await patchAnalyst({ definition: ANALYST_DEF({ instructions: `${ANALYST}, v2.` }) });

    const snap = await takeSnapshot(db, orgId, child?.id as string, run?.id as string, 4_194_304);
    expect(snap).toMatchObject({ agentId: analystId, agentVersion: 1 });
    const call = toEvents(snap)
      .filter((e) => e.type === "model_call")
      .at(-1) as ConversationEvent;
    const info = (await k.runs.registry.resolve(SCRIPT)).info;
    const base = reconstructRequest(snap, call.seq, { model: info });
    expect(base.drift).toEqual([]);
    const v2 = await db
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", analystId)
      .where("version", "=", 2)
      .executeTakeFirstOrThrow();
    const cand = reconstructRequest(snap, call.seq, {
      model: info,
      definition: v2.definition as never,
      agentVersion: 2,
    });
    expect(cand.drift).toEqual(["subagent_changed"]);
    expect(cand.request).toEqual(base.request);
    expect(cand.request.system[0]?.text).toContain(`${ANALYST}, v1.`);

    // an eval set of the analyst takes the child's run; a step replay with version 2 drifts
    const set = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/eval-sets`,
      payload: { agentId: analystId, name: "Analyst" },
    });
    expect(set.statusCode, set.body).toBe(201);
    const setId = (set.json() as { set: { id: string } }).set.id;
    const added = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/eval-sets/${setId}/cases`,
      payload: { conversationId: child?.id, runId: run?.id },
    });
    expect(added.statusCode, added.body).toBe(201);
    const started = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/eval-sets/${setId}/runs`,
      payload: { mode: "step", candidate: { agentVersion: 2 }, judge: false },
    });
    expect(started.statusCode, started.body).toBe(201);
    const evalRunId = (started.json() as { run: EvalRunView }).run.id;
    await waitFor(
      async () => {
        const r = await owner({
          method: "GET",
          url: `/api/v1/orgs/${orgId}/eval-runs/${evalRunId}`,
        });
        return ["queued", "running"].includes((r.json() as { run: EvalRunView }).run.status)
          ? null
          : true;
      },
      30_000,
      "eval run finished",
      100,
    );
    const res = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/eval-runs/${evalRunId}/results?limit=10`,
    });
    const results = (res.json() as { results: EvalResultView[] }).results;
    expect(results.map((r) => [r.status, r.drift])).toEqual([["done", ["subagent_changed"]]]);
  }, 90_000);
});
