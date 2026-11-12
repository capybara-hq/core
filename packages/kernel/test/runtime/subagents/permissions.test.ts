import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ModelRequestHookPayload,
  ToolPostHookPayload,
  ToolPreHookPayload,
  UsageReportPayload,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { StepLog } from "../../../src/runtime/step-log.js";
import {
  openBarrier,
  type ScriptRule,
  scriptRules,
} from "../../fixtures/plugins/model-script/index.js";
import { truncateTables } from "../../helpers/db.js";
import { onlyBuiltins } from "../../helpers/disabled-tools.js";
import { accountsFor } from "../../helpers/identity.js";
import { testMembers } from "../../helpers/members.js";
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
  type TestKernel,
  waitFor,
  waitForEvent,
  waitForTerminal,
} from "../../helpers/runs.js";
import { finishedDeliveries } from "../../helpers/subagents.js";

/**
 * Phase C Task 11: sub-agent policies (the parent's current version, then the frozen overlay),
 * approvals to the person who started the parent run (surfaced as `subagent_waiting` in the parent
 * log and in the inbox), "this conversation" grants stored on the parent, and hook scope / usage
 * reports with `parent`.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");
const HOOKS_PROBE = fixture("hooks-probe");

const CHILD = "You are a sub-agent";
const ECHO = "plugin__hooks-probe__probe_echo";

const agentCall = (input: Record<string, unknown>) => ({ name: "Agent", input });

const RULES: ScriptRule[] = [
  // children
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "asker-policy", assistantTurns: 0 },
    reply: {
      toolCalls: [
        { name: "Read", input: { file_path: "/workspace/x.txt" } },
        { name: ECHO, input: { text: "one" } },
      ],
    },
  },
  {
    when: { systemIncludes: CHILD, lastToolResultIncludes: "echo: one" },
    reply: { text: "asker done" },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "asker-s", assistantTurns: 0 },
    reply: { toolCalls: [{ name: ECHO, input: { text: "same" } }] },
  },
  {
    // the first child's last step lets the parent dispatch the second one (after the grant)
    when: {
      systemIncludes: CHILD,
      lastUserIncludes: "asker-s1",
      lastToolResultIncludes: "echo: same",
    },
    reply: { text: "sibling done", barrier: { name: "s1", count: 2, timeoutMs: 15_000 } },
  },
  {
    when: { systemIncludes: CHILD, lastToolResultIncludes: "echo: same" },
    reply: { text: "sibling done" },
  },
  // the tree scenarios (agent map spec §7): an asker at depth 3, and two asker siblings at depth 2
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "asker-deep", assistantTurns: 0 },
    reply: { toolCalls: [{ name: ECHO, input: { text: "deep" } }] },
  },
  {
    when: { systemIncludes: CHILD, lastToolResultIncludes: "echo: deep" },
    reply: { text: "deep asker done" },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "asker-twin", assistantTurns: 0 },
    reply: { toolCalls: [{ name: ECHO, input: { text: "twin" } }] },
  },
  {
    when: { systemIncludes: CHILD, lastToolResultIncludes: "echo: twin" },
    reply: { text: "twin done" },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "D2-go", assistantTurns: 0 },
    reply: {
      toolCalls: [
        agentCall({ description: "Deep", prompt: "asker-deep: go", subagent_type: "asker" }),
      ],
    },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "D2-go", assistantTurns: 1 },
    reply: { text: "D2 reply" },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "D1-go", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Level 2", prompt: "D2-go" })] },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "D1-go", assistantTurns: 1 },
    reply: { text: "D1 reply" },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "G1-go", assistantTurns: 0 },
    reply: {
      toolCalls: [
        agentCall({ description: "Twin 1", prompt: "asker-twin1: go", subagent_type: "asker" }),
      ],
    },
  },
  {
    // the second twin is dispatched only once the test opens the barrier (after the grant)
    when: { systemIncludes: CHILD, lastUserIncludes: "G1-go", assistantTurns: 1 },
    reply: {
      toolCalls: [
        agentCall({ description: "Twin 2", prompt: "asker-twin2: go", subagent_type: "asker" }),
      ],
      barrier: { name: "twin2", count: 99, timeoutMs: 30_000 },
    },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "G1-go", assistantTurns: 2 },
    reply: { text: "G1 reply" },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "gp-hooks", assistantTurns: 0 },
    reply: { toolCalls: [{ name: ECHO, input: { text: "hk" } }] },
  },
  {
    when: { systemIncludes: CHILD, lastToolResultIncludes: "echo: hk" },
    reply: { text: "hooks child done" },
  },
  // parents
  {
    when: { lastUserIncludes: "SCENARIO policy", assistantTurns: 0 },
    reply: {
      toolCalls: [
        agentCall({ description: "Ask first", prompt: "asker-policy: go", subagent_type: "asker" }),
      ],
    },
  },
  {
    when: { lastUserIncludes: "SCENARIO policy", lastToolResultIncludes: "in the background" },
    reply: { text: "policy done" },
  },
  {
    when: { lastUserIncludes: "SCENARIO session", assistantTurns: 0 },
    reply: {
      toolCalls: [
        agentCall({ description: "First", prompt: "asker-s1: go", subagent_type: "asker" }),
      ],
    },
  },
  {
    when: { lastUserIncludes: "SCENARIO session", assistantTurns: 1 },
    reply: {
      toolCalls: [
        agentCall({ description: "Second", prompt: "asker-s2: go", subagent_type: "asker" }),
      ],
      barrier: { name: "s1", count: 2, timeoutMs: 15_000 },
    },
  },
  { when: { lastUserIncludes: "SCENARIO session", assistantTurns: 2 }, reply: { text: "s done" } },
  {
    when: { lastUserIncludes: "SCENARIO deep", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Level 1", prompt: "D1-go" })] },
  },
  { when: { lastUserIncludes: "SCENARIO deep", assistantTurns: 1 }, reply: { text: "deep done" } },
  {
    when: { lastUserIncludes: "SCENARIO twins", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Mid", prompt: "G1-go" })] },
  },
  {
    when: { lastUserIncludes: "SCENARIO twins", assistantTurns: 1 },
    reply: { text: "twins done" },
  },
  {
    when: { lastUserIncludes: "SCENARIO hooks", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Hooked", prompt: "gp-hooks: echo" })] },
  },
  {
    when: { lastUserIncludes: "SCENARIO hooks", lastToolResultIncludes: "in the background" },
    reply: { text: "hooks done" },
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
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  root = await mkdtemp(join(tmpdir(), "cap-subagent-perms-"));
  k = await startKernel();
}, 180_000);

async function startKernel(): Promise<TestKernel> {
  const { startKernel: start } = await import("../../helpers/runs.js");
  return start(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE, HOOKS_PROBE],
        extensionConfig: { "model-script": { rules: RULES }, "sandbox-fake": { root } },
        // these tests are about dispatch, not waking (subagents/wake.test.ts): a parent woken by
        // its children's deliveries would race their last-reply and one-run assertions
        runtime: { wakeOnBackgroundTask: false },
      },
    ),
  );
}

afterAll(async () => {
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
let agentId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.audit_events, capybara.subagent_dispatches, capybara.sandboxes, capybara.approvals, capybara.conversation_tool_grants, capybara.tool_grants, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  scriptRules([]);
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  memberId = (await accounts.createLocal({ login: "member", password: PW, displayName: "M" })).id;
  owner = await session(k, "owner");
  member = await session(k, "member");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, memberId, "member", ownerId);
  const en = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/hooks-probe`,
    payload: { enabled: true },
  });
  expect(en.statusCode, en.body).toBe(200);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Lead",
        instructions: "Lead the work.",
        model: { provider: "model-script", model: "script-1" },
        disabledTools: onlyBuiltins([
          { kind: "builtin", name: "Agent" },
          { kind: "builtin", name: "Read" },
          { kind: "plugin", plugin: "hooks-probe", name: "probe_echo" },
        ]),
        // the parent denies Read and allows probe_echo
        toolPolicies: { Read: "deny" },
        subagents: {
          inline: [
            {
              name: "asker",
              description: "Asks before echoing.",
              instructions: "You are asker.",
              // stricter on top of the parent's allow; cannot loosen the parent's deny
              toolPolicies: { [ECHO]: "ask", Read: "ask" },
            },
          ],
        },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
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

async function childrenOf(parent: string): Promise<string[]> {
  const rows = await db
    .selectFrom("conversations")
    .select("id")
    .where("parent_conversation_id", "=", parent)
    .orderBy("created_at")
    .execute();
  return rows.map((r) => r.id);
}

async function pendingApproval(conv: string) {
  return waitFor(
    async () =>
      db
        .selectFrom("approvals")
        .selectAll()
        .where("conversation_id", "=", conv)
        .where("status", "=", "pending")
        .executeTakeFirst(),
    20_000,
    "pending approval",
  );
}

async function firstChild(parent: string): Promise<string> {
  return waitFor(async () => (await childrenOf(parent))[0], 20_000, "child conversation");
}

async function decide(req: Req, approvalId: string, scope = "once"): Promise<void> {
  const r = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/approvals/${approvalId}/decision`,
    payload: { decision: "approve", scope },
  });
  expect(r.statusCode, r.body).toBe(200);
}

describe("policies and approvals of a sub-agent", () => {
  it("a template's ask on top of the parent's allow asks; a template cannot loosen a parent deny", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO policy");
    const child = await firstChild(conv);
    const approval = await pendingApproval(child);
    expect(approval.tool_key).toBe(ECHO);
    const cev = await eventsOf(db, child);
    const read = ofType(cev, "tool_result").find((r) => r.payload.toolKey === "Read");
    expect(read?.payload).toMatchObject({
      content: "Tool Read is denied by policy.",
      isError: true,
    });
    await decide(owner, approval.id);
    await waitForTerminal(db, conv, 1, 30_000);
    expect(finalText(await eventsOf(db, conv))).toBe("policy done");
    expect((await finishedDeliveries(db, conv)).map((d) => d.text)).toEqual(["asker done"]);
  }, 60_000);

  it("a child's approval goes to the starter, appears as subagent_waiting in the parent log and in GET /inbox with parentConversationId", async () => {
    // the member starts the parent run of the owner's agent
    const conv = await createConv(member, orgId, agentId);
    await postMessage(member, orgId, conv, "SCENARIO policy");
    const child = await firstChild(conv);
    const approval = await pendingApproval(child);
    expect(approval.requested_for).toBe(memberId);
    const childRun = await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", child)
      .executeTakeFirstOrThrow();

    const waiting = (await waitForEvent(
      db,
      conv,
      (e) => e.type === "subagent_waiting",
      10_000,
      "subagent_waiting",
    )) as Ev<"subagent_waiting">;
    expect(waiting.payload).toEqual({
      subagentId: child,
      childRunId: childRun.id,
      path: [child],
      kind: "approval",
      approvalId: approval.id,
      toolKey: ECHO,
      expiresAt: new Date(approval.expires_at).toISOString(),
      requestedFor: approval.requested_for,
      approverRole: approval.approver_role,
    });

    type Inbox = {
      items: {
        type: string;
        approval?: { id: string; parentConversationId?: string; conversationPath: string };
      }[];
    };
    const inbox = await member({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
    expect(inbox.statusCode, inbox.body).toBe(200);
    const item = (inbox.json() as Inbox).items.find((i) => i.approval?.id === approval.id);
    expect(item?.approval).toMatchObject({
      parentConversationId: conv,
      conversationPath: `/chat/${conv}?subagent=${child}`,
    });
    // never to the agent's owner
    const ownerInbox = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
    expect((ownerInbox.json() as Inbox).items.some((i) => i.approval?.id === approval.id)).toBe(
      false,
    );
    const forbidden = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${approval.id}/decision`,
      payload: { decision: "approve" },
    });
    expect(forbidden.statusCode).toBe(404);

    await decide(member, approval.id);
    await waitForTerminal(db, conv, 1, 30_000);
    expect(finalText(await eventsOf(db, conv))).toBe("policy done");
    // the child runs as the member who started the parent run (§7)
    expect(await finishedDeliveries(db, conv)).toMatchObject([
      { text: "asker done", triggerAccountId: memberId },
    ]);
  }, 60_000);

  it("approve for this conversation on one child covers a sibling's identical call", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO session");
    const first = await firstChild(conv);
    const approval = await pendingApproval(first);
    await decide(owner, approval.id, "session");
    await waitForTerminal(db, conv, 1, 30_000);
    expect(finalText(await eventsOf(db, conv))).toBe("s done");
    await finishedDeliveries(db, conv, 2);

    const kids = await childrenOf(conv);
    expect(kids).toHaveLength(2);
    const grants = await db
      .selectFrom("conversation_tool_grants")
      .select(["conversation_id", "tool_key"])
      .execute();
    expect(grants).toEqual([{ conversation_id: conv, tool_key: ECHO }]);
    // the sibling ran the same call without a new approval
    const approvals = await db.selectFrom("approvals").select("conversation_id").execute();
    expect(approvals).toEqual([{ conversation_id: first }]);
    const second = await eventsOf(db, kids[1] as string);
    const echo = ofType(second, "tool_result").find((r) => r.payload.toolKey === ECHO);
    expect(echo?.payload).toMatchObject({ content: "echo: same", isError: false });
  }, 60_000);
});

describe("approvals across the tree (agent map spec §7)", () => {
  /** The chain root → d1 → d2 → d3 of SCENARIO deep, once each level is dispatched. */
  async function deepChain(conv: string): Promise<[string, string, string]> {
    const d1 = await firstChild(conv);
    const d2 = await firstChild(d1);
    const d3 = await firstChild(d2);
    return [d1, d2, d3];
  }

  const runOf = (conv: string) =>
    db
      .selectFrom("runs")
      .select(["id", "status", "trigger_account_id"])
      .where("conversation_id", "=", conv)
      .orderBy("created_at")
      .executeTakeFirstOrThrow();

  it("great-grandchild approval surfaces in the root", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO deep");
    const [d1, d2, d3] = await deepChain(conv);
    const approval = await pendingApproval(d3);
    expect(approval.tool_key).toBe(ECHO);
    const d3Run = await runOf(d3);

    // shown in the root, with the path from the root's child down to the waiting agent
    const waiting = (await waitForEvent(
      db,
      conv,
      (e) => e.type === "subagent_waiting",
      10_000,
      "subagent_waiting in the root",
    )) as Ev<"subagent_waiting">;
    expect(waiting.payload).toEqual({
      subagentId: d3,
      childRunId: d3Run.id,
      path: [d1, d2, d3],
      kind: "approval",
      approvalId: approval.id,
      toolKey: ECHO,
      expiresAt: new Date(approval.expires_at).toISOString(),
      requestedFor: ownerId,
      approverRole: null,
    });
    // under the root run that dispatched the branch
    const rootRun = await runOf(conv);
    expect(waiting.runId).toBe(rootRun.id);
    // not model-visible, and not in the intermediate levels' logs
    for (const mid of [d1, d2]) {
      expect(ofType(await eventsOf(db, mid), "subagent_waiting")).toEqual([]);
    }

    // the inbox links to the root conversation with the waiting agent open
    type Inbox = { items: { approval?: { id: string; conversationPath: string } }[] };
    const inbox = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
    expect(inbox.statusCode, inbox.body).toBe(200);
    const item = (inbox.json() as Inbox).items.find((i) => i.approval?.id === approval.id);
    expect(item?.approval?.conversationPath).toBe(`/chat/${conv}?subagent=${d3}`);

    // approving the root's card resumes the depth-3 run
    await decide(owner, waiting.payload.approvalId as string);
    await waitFor(
      async () => ((await runOf(d3)).status === "completed" ? true : null),
      30_000,
      "depth-3 run completed",
    );
    const echo = ofType(await eventsOf(db, d3), "tool_result").find(
      (r) => r.payload.toolKey === ECHO,
    );
    expect(echo?.payload).toMatchObject({ content: "echo: deep", isError: false });
    expect((await finishedDeliveries(db, d2)).map((d) => d.text)).toEqual(["deep asker done"]);
  }, 90_000);

  it('"approve for this conversation" on a grandchild applies to its siblings\' later calls', async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO twins");
    const mid = await firstChild(conv);
    const twin1 = await firstChild(mid);
    const approval = await pendingApproval(twin1);
    await decide(owner, approval.id, "session");
    // the grant is the root conversation's, so every agent of the tree uses it
    await waitFor(
      async () => ((await runOf(twin1)).status === "completed" ? true : null),
      30_000,
      "first twin completed",
    );
    const grants = await db
      .selectFrom("conversation_tool_grants")
      .select(["conversation_id", "tool_key"])
      .execute();
    expect(grants).toEqual([{ conversation_id: conv, tool_key: ECHO }]);

    // only now the mid agent dispatches the second twin
    openBarrier("twin2");
    await finishedDeliveries(db, mid, 2);
    const twins = await childrenOf(mid);
    expect(twins).toHaveLength(2);
    const approvals = await db.selectFrom("approvals").select("conversation_id").execute();
    expect(approvals).toEqual([{ conversation_id: twin1 }]);
    const second = await eventsOf(db, twins[1] as string);
    const echo = ofType(second, "tool_result").find((r) => r.payload.toolKey === ECHO);
    expect(echo?.payload).toMatchObject({ content: "echo: twin", isError: false });
  }, 90_000);

  it("the approver is the trigger account inherited down the chain", async () => {
    // the member starts the root run of the owner's agent
    const conv = await createConv(member, orgId, agentId);
    await postMessage(member, orgId, conv, "SCENARIO deep");
    const [d1, d2, d3] = await deepChain(conv);
    const approval = await pendingApproval(d3);
    expect(approval.requested_for).toBe(memberId);
    for (const c of [d1, d2, d3]) expect((await runOf(c)).trigger_account_id).toBe(memberId);
    const waiting = (await waitForEvent(
      db,
      conv,
      (e) => e.type === "subagent_waiting",
      10_000,
      "subagent_waiting in the root",
    )) as Ev<"subagent_waiting">;
    expect(waiting.payload).toMatchObject({
      approvalId: approval.id,
      path: [d1, d2, d3],
      requestedFor: memberId,
    });
    // never the agent's owner
    const forbidden = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${approval.id}/decision`,
      payload: { decision: "approve" },
    });
    expect(forbidden.statusCode).toBe(404);
    await decide(member, approval.id);
    await waitFor(
      async () => ((await runOf(d3)).status === "completed" ? true : null),
      30_000,
      "depth-3 run completed",
    );
  }, 90_000);
});

describe("hooks and usage reports of a sub-agent", () => {
  type Probe = { counts: Record<string, number>; last: Record<string, unknown> };
  const lastOf = async (conversationId: string): Promise<Probe["last"]> => {
    const res = await owner({
      method: "GET",
      url: `/plugins/hooks-probe/counts?orgId=${orgId}&conversationId=${conversationId}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as Probe).last;
  };

  it("tool.preExecute and model.request fire for a child with parent set; the agent call fires tool.postExecute and is audited", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO hooks");
    await waitForTerminal(db, conv, 1, 30_000);
    await finishedDeliveries(db, conv);
    const events = await eventsOf(db, conv);
    expect(finalText(events)).toBe("hooks done");
    const [child] = await childrenOf(conv);
    const run = await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    const call = ofType(events, "subagent_dispatched")[0]?.payload.callId as string;
    const parent = { conversationId: conv, runId: run.id, callId: call };

    const childLast = await waitFor(
      async () => {
        const l = await lastOf(child as string);
        return l["tool.preExecute"] && l["model.request"] ? l : null;
      },
      10_000,
      "child hooks",
    );
    expect(childLast["tool.preExecute"] as ToolPreHookPayload).toMatchObject({
      conversationId: child,
      toolKey: ECHO,
      agentId,
      parent,
    });
    expect(childLast["model.request"] as ModelRequestHookPayload).toMatchObject({
      conversationId: child,
      parent,
    });

    // the parent's own payloads carry no parent; its agent call fires tool.postExecute
    const parentLast = await waitFor(
      async () => {
        const l = await lastOf(conv);
        return l["tool.postExecute"] ? l : null;
      },
      10_000,
      "parent postExecute",
    );
    expect(parentLast["model.request"]).not.toHaveProperty("parent");
    const post = parentLast["tool.postExecute"] as ToolPostHookPayload;
    expect(post).toMatchObject({ conversationId: conv, toolKey: "Agent", callId: call });
    expect(post).not.toHaveProperty("parent");
    // the immediate result of a background dispatch (agent map spec §4.1)
    expect(post.content).toContain("(running in the background)");
    expect(post.durationMs).toBeGreaterThanOrEqual(0);

    const audits = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "=", "tool.called")
      .execute();
    const agentAudit = audits.find(
      (a) => (a.detail as { toolKey?: string; callId?: string }).callId === call,
    );
    expect(agentAudit?.detail).toMatchObject({ toolKey: "Agent", conversationId: conv });
  }, 60_000);

  it("a child's usage.report has conversationKind chat and parent", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO hooks");
    await waitForTerminal(db, conv, 1, 30_000);
    await finishedDeliveries(db, conv);
    const [child] = await childrenOf(conv);
    const run = await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    const call = ofType(await eventsOf(db, conv), "subagent_dispatched")[0]?.payload
      .callId as string;
    const usage = ofType(await eventsOf(db, child as string), "usage");
    expect(usage.length).toBeGreaterThan(0);
    const ids = usage.map((e) => `${e.conversationId}/${e.seq}`);
    type Delivery = { calls: number; last: UsageReportPayload | null };
    const got = await waitFor(
      async () => {
        const res = await owner({
          method: "GET",
          url: `/plugins/hooks-probe/usage?eventIds=${ids.join(",")}`,
        });
        const out = res.json() as Record<string, Delivery>;
        return ids.every((id) => out[id]?.last) ? out : null;
      },
      20_000,
      "usage reports",
    );
    for (const id of ids) {
      expect(got[id]?.last).toMatchObject({
        conversationId: child,
        conversationKind: "chat",
        parent: { conversationId: conv, runId: run.id, callId: call },
      });
    }
    // the parent's own usage carries no parent
    const parentUsage = ofType(await eventsOf(db, conv), "usage")[0] as Ev<"usage">;
    const pid = `${conv}/${parentUsage.seq}`;
    const p = await waitFor(
      async () => {
        const res = await owner({
          method: "GET",
          url: `/plugins/hooks-probe/usage?eventIds=${pid}`,
        });
        return (res.json() as Record<string, Delivery>)[pid]?.last ?? null;
      },
      20_000,
      "parent usage report",
    );
    expect(p).not.toHaveProperty("parent");
  }, 60_000);

  it("a child's wake run's usage.report has parent: the child's latest dispatch", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO hooks");
    await waitForTerminal(db, conv, 1, 30_000);
    await finishedDeliveries(db, conv);
    const [child] = await childrenOf(conv);
    if (!child) throw new Error("no child dispatched");
    const run = await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    const call = ofType(await eventsOf(db, conv), "subagent_dispatched")[0]?.payload
      .callId as string;
    // a wake run of the child (nobody dispatched it: no dispatch row of its own) with a usage event
    const wakeRun = randomUUID();
    await db
      .insertInto("runs")
      .values({
        id: wakeRun,
        conversation_id: child,
        status: "completed",
        agent_version: 1,
        trigger_account_id: ownerId,
        trigger_seq: 1,
        budget_run_id: run.id,
      })
      .execute();
    // written through the step writes, which owe its usage.report delivery with it
    const {
      written: [usage],
    } = await k.app.get(StepLog).appendReported(child, [
      {
        type: "usage",
        runId: wakeRun,
        payload: {
          step: 1,
          provider: "model-script",
          model: "script-1",
          inputTokens: 3,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    ]);
    if (!usage) throw new Error("usage not appended");
    const id = `${child}/${usage.seq}`;
    type Delivery = { calls: number; last: UsageReportPayload | null };
    const got = await waitFor(
      async () => {
        const res = await owner({
          method: "GET",
          url: `/plugins/hooks-probe/usage?eventIds=${id}`,
        });
        return (res.json() as Record<string, Delivery>)[id]?.last ?? null;
      },
      20_000,
      "the wake run's usage report",
    );
    expect(got).toMatchObject({
      conversationId: child,
      runId: wakeRun,
      parent: { conversationId: conv, runId: run.id, callId: call },
    });
  }, 60_000);
});
