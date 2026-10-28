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
import { AccountsService } from "../../../src/identity/accounts.js";
import type { Kernel } from "../../../src/kernel.js";
import { type ScriptRule, scriptRules } from "../../fixtures/plugins/model-script/index.js";
import { truncateTables } from "../../helpers/db.js";
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
  waitFor,
  waitForEvent,
  waitForTerminal,
} from "../../helpers/runs.js";

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
const ECHO = "hooks-probe__probe_echo";

const agentCall = (input: Record<string, unknown>) => ({ name: "agent", input });

const RULES: ScriptRule[] = [
  // children
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "asker-policy", assistantTurns: 0 },
    reply: {
      toolCalls: [
        { name: "sandbox_read", input: { path: "/workspace/x.txt" } },
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
    when: { systemIncludes: CHILD, lastToolResultIncludes: "echo: same" },
    reply: { text: "sibling done" },
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
  { when: { lastToolResultIncludes: "asker done" }, reply: { text: "policy done" } },
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
    },
  },
  { when: { lastUserIncludes: "SCENARIO session", assistantTurns: 2 }, reply: { text: "s done" } },
  {
    when: { lastUserIncludes: "SCENARIO hooks", assistantTurns: 0 },
    reply: { toolCalls: [agentCall({ description: "Hooked", prompt: "gp-hooks: echo" })] },
  },
  { when: { lastToolResultIncludes: "hooks child done" }, reply: { text: "hooks done" } },
];

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: Kernel;
let root: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  root = await mkdtemp(join(tmpdir(), "cap-subagent-perms-"));
  k = await startKernel();
}, 180_000);

async function startKernel(): Promise<Kernel> {
  const { startKernel: start } = await import("../../helpers/runs.js");
  return start(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE, HOOKS_PROBE],
        extensionConfig: { "model-script": { rules: RULES }, "sandbox-fake": { root } },
      },
    ),
  );
}

afterAll(async () => {
  await k?.stop();
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
  const accounts = new AccountsService(db);
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
        tools: [
          { kind: "builtin", name: "agent" },
          { kind: "builtin", name: "sandbox_read" },
          { kind: "plugin", plugin: "hooks-probe", name: "probe_echo" },
        ],
        // the parent denies sandbox_read and allows probe_echo
        toolPolicies: { sandbox_read: "deny" },
        subagents: {
          inline: [
            {
              name: "asker",
              description: "Asks before echoing.",
              instructions: "You are asker.",
              // stricter on top of the parent's allow; cannot loosen the parent's deny
              toolPolicies: { [ECHO]: "ask", sandbox_read: "ask" },
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
    const read = ofType(cev, "tool_result").find((r) => r.payload.toolKey === "sandbox_read");
    expect(read?.payload).toMatchObject({
      content: "Tool sandbox_read is denied by policy.",
      isError: true,
    });
    await decide(owner, approval.id);
    await waitForTerminal(db, conv, 1, 30_000);
    expect(finalText(await eventsOf(db, conv))).toBe("policy done");
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
      kind: "approval",
      approvalId: approval.id,
      toolKey: ECHO,
      expiresAt: new Date(approval.expires_at).toISOString(),
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
  }, 60_000);

  it("approve for this conversation on one child covers a sibling's identical call", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO session");
    const first = await firstChild(conv);
    const approval = await pendingApproval(first);
    await decide(owner, approval.id, "session");
    await waitForTerminal(db, conv, 1, 30_000);
    expect(finalText(await eventsOf(db, conv))).toBe("s done");

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
    expect(post).toMatchObject({ conversationId: conv, toolKey: "agent", callId: call });
    expect(post).not.toHaveProperty("parent");
    expect(post.content).toContain("hooks child done");
    expect(post.durationMs).toBeGreaterThanOrEqual(0);

    const audits = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "=", "tool.called")
      .execute();
    const agentAudit = audits.find(
      (a) => (a.detail as { toolKey?: string; callId?: string }).callId === call,
    );
    expect(agentAudit?.detail).toMatchObject({ toolKey: "agent", conversationId: conv });
  }, 60_000);

  it("a child's usage.report has conversationKind chat and parent", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO hooks");
    await waitForTerminal(db, conv, 1, 30_000);
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
});
