import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { type ScriptRule, scriptRules } from "../fixtures/plugins/model-script/index.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
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
  startKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";
import { openSse } from "../helpers/sse.js";
import { childRunsOf, parentWaiting } from "../helpers/subagents.js";

/**
 * Phase C Task 14 (spec §14.2, §14.3): `GET /conversations/:id/subagents`, child conversations
 * through the unchanged routes (view, events, sandbox status, outputs), `listMine` without
 * children, the parent's SSE receiving `subagent_progress`, and conversation usage that sums the
 * children. One kernel with model-script and sandbox-fake.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");

const CHILD = "You are a sub-agent";
const agentCall = (description: string, prompt: string) => ({
  name: "agent",
  input: { description, prompt },
});

const RULES: ScriptRule[] = [
  {
    // a command whose output (40000 chars) is archived
    when: { systemIncludes: CHILD, lastUserIncludes: "task-tool", assistantTurns: 0 },
    reply: {
      toolCalls: [
        {
          name: "sandbox_bash",
          input: { description: "Print a lot", command: "yes a | head -c 40000" },
        },
      ],
    },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "task-write", assistantTurns: 0 },
    reply: {
      toolCalls: [{ name: "sandbox_write", input: { path: "/workspace/w.txt", content: "w" } }],
    },
  },
  { when: { systemIncludes: CHILD }, reply: { text: "child ok" } },
  {
    when: { lastUserIncludes: "SCENARIO two", assistantTurns: 0 },
    reply: {
      toolCalls: [agentCall("Tool task", "task-tool"), agentCall("Write task", "task-write")],
    },
  },
  {
    when: { lastUserIncludes: "SCENARIO one", assistantTurns: 0 },
    reply: { toolCalls: [agentCall("Tool task", "task-tool")] },
  },
  { when: { lastToolResultIncludes: "[agentId:" }, reply: { text: "parent done" } },
];

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let k: Kernel;
let root: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  root = await mkdtemp(join(tmpdir(), "cap-subagents-http-"));
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
  await k?.stop();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

let owner: Req;
let ownerCookie: () => string;
let member: Req;
let orgId: string;
let agentId: string;

async function login(name: string): Promise<{ req: Req; cookie: () => string }> {
  const jar = cookieJar();
  const req = asUser(k.http, jar);
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: name, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return { req, cookie: () => jar.header() as string };
}

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.audit_events, capybara.subagent_dispatches, capybara.sandboxes, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  scriptRules([]);
  const accounts = new AccountsService(db);
  const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const memberId = (await accounts.createLocal({ login: "member", password: PW, displayName: "M" }))
    .id;
  const o = await login("owner");
  owner = o.req;
  ownerCookie = o.cookie;
  member = (await login("member")).req;
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, memberId, "member", ownerId);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Lead",
        instructions: "Lead the work.",
        model: { provider: "model-script", model: "script-1" },
        tools: ["agent", "sandbox_write", "sandbox_bash"].map((name) => ({
          kind: "builtin",
          name,
        })),
        toolPolicies: { sandbox_write: "ask" },
      },
      // the member can use the agent, so a 404 below is the owner-only rule, not visibility
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterEach(() => {
  scriptRules([]);
});

const base = () => `/api/v1/orgs/${orgId}/conversations`;

type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** The sum of a conversation's `usage` events, straight from the log. */
async function usageOf(...convs: string[]): Promise<Usage> {
  const u: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const c of convs) {
    for (const e of await eventsOf(db, c)) {
      if (e.type !== "usage") continue;
      u.inputTokens += e.payload.inputTokens;
      u.outputTokens += e.payload.outputTokens;
      u.cacheReadTokens += e.payload.cacheReadTokens;
      u.cacheWriteTokens += e.payload.cacheWriteTokens;
    }
  }
  return u;
}

type ToolResultEvent = ConversationEvent & {
  type: "tool_result";
  payload: EventPayload<"tool_result">;
};

interface SubagentRow {
  id: string;
  agentType: string;
  description: string;
  status: string;
  toolCalls: number;
  startedAt: string;
  finishedAt: string | null;
  usage: Usage;
  pendingApprovalIds: string[];
  pendingQuestionIds: string[];
}

async function listSubagents(
  req: Req,
  conv: string,
  query = "",
): Promise<{ status: number; body: { subagents: SubagentRow[]; next: string | null } }> {
  const r = await req({ method: "GET", url: `${base()}/${conv}/subagents${query}` });
  return { status: r.statusCode, body: r.json() };
}

/** Runs "SCENARIO one" to its end and returns the parent and its only child. */
async function oneChild(): Promise<{ conv: string; child: string }> {
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, "SCENARIO one");
  await waitForTerminal(db, conv, 1, 30_000);
  const [c, ...more] = await childRunsOf(db, conv);
  expect(more).toEqual([]);
  return { conv, child: c?.conversationId as string };
}

describe("GET /conversations/:id/subagents", () => {
  it("the list shows each sub-agent with status and counts; another user gets 404", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO two");
    const { children } = await parentWaiting(db, conv, 2);
    // which child is which: by the dispatched description in the parent log
    const dispatched = (await eventsOf(db, conv)).filter((e) => e.type === "subagent_dispatched");
    const idOf = (description: string) =>
      dispatched.find(
        (e) => e.type === "subagent_dispatched" && e.payload.description === description,
      )?.payload as { subagentId: string; childRunId: string };
    const tool = idOf("Tool task");
    const write = idOf("Write task");
    expect(children.map((c) => c.conversationId).sort()).toEqual(
      [tool.subagentId, write.subagentId].sort(),
    );
    const approval = await waitFor(
      async () =>
        db
          .selectFrom("approvals")
          .select("id")
          .where("conversation_id", "=", write.subagentId)
          .where("status", "=", "pending")
          .executeTakeFirst(),
      20_000,
      "the write child's approval",
    );
    await waitFor(
      async () =>
        (
          await db
            .selectFrom("runs")
            .select("status")
            .where("id", "=", tool.childRunId)
            .executeTakeFirst()
        )?.status === "completed" || null,
      20_000,
      "the tool child completed",
    );

    const r = await listSubagents(owner, conv);
    expect(r.status).toBe(200);
    expect(r.body.next).toBeNull();
    expect(r.body.subagents).toHaveLength(2);
    const byId = new Map(r.body.subagents.map((s) => [s.id, s]));
    expect(byId.get(tool.subagentId)).toEqual({
      id: tool.subagentId,
      agentType: "general-purpose",
      description: "Tool task",
      status: "completed",
      toolCalls: 1,
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      usage: await usageOf(tool.subagentId),
      pendingApprovalIds: [],
      pendingQuestionIds: [],
    });
    expect(byId.get(tool.subagentId)?.usage.inputTokens).toBeGreaterThan(0);
    expect(byId.get(write.subagentId)).toEqual({
      id: write.subagentId,
      agentType: "general-purpose",
      description: "Write task",
      status: "waiting",
      toolCalls: 0,
      startedAt: expect.any(String),
      finishedAt: null,
      usage: await usageOf(write.subagentId),
      pendingApprovalIds: [approval.id],
      pendingQuestionIds: [],
    });

    // pages of one, newest first, with the cursor
    const p1 = await listSubagents(owner, conv, "?limit=1");
    expect(p1.body.subagents).toHaveLength(1);
    expect(p1.body.next).toBe(p1.body.subagents[0]?.id);
    const p2 = await listSubagents(owner, conv, `?limit=1&after=${p1.body.next}`);
    expect(p2.body.subagents).toHaveLength(1);
    expect(p2.body.next).toBeNull();
    expect([p1.body.subagents[0]?.id, p2.body.subagents[0]?.id]).toEqual(
      r.body.subagents.map((s) => s.id),
    );
    expect((await listSubagents(owner, conv, "?limit=101")).status).toBe(400);

    // owner only: the member, who can use the agent, gets 404 (and so does a child's id as parent)
    const other = await listSubagents(member, conv);
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).toContain("conversation.not_found");
    expect(JSON.stringify(other.body)).not.toContain(tool.subagentId);

    const stop = await owner({ method: "POST", url: `${base()}/${conv}/abort` });
    expect(stop.statusCode, stop.body).toBe(202);
    await waitForTerminal(db, conv, 1, 30_000);
  }, 90_000);
});

describe("child conversations through the conversation routes", () => {
  it("GET a child conversation and its events works for the owner; sandbox status is the parent's; outputs read", async () => {
    const { conv, child } = await oneChild();

    const view = await owner({ method: "GET", url: `${base()}/${child}` });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().conversation).toMatchObject({
      id: child,
      parentConversationId: conv,
      subagentType: "general-purpose",
    });
    const parentView = await owner({ method: "GET", url: `${base()}/${conv}` });
    expect(parentView.json().conversation).toMatchObject({
      id: conv,
      parentConversationId: null,
      subagentType: null,
    });

    const evs = await owner({ method: "GET", url: `${base()}/${child}/events` });
    expect(evs.statusCode).toBe(200);
    const types = (evs.json().events as ConversationEvent[]).map((e) => e.type);
    expect(types[0]).toBe("subagent_started");
    expect(types).toContain("run_finished");

    // the child works in its parent's sandbox: same status, not 404
    const ps = await owner({ method: "GET", url: `${base()}/${conv}/sandbox` });
    expect(ps.statusCode, ps.body).toBe(200);
    const cs = await owner({ method: "GET", url: `${base()}/${child}/sandbox` });
    expect(cs.statusCode, cs.body).toBe(200);
    expect(cs.json()).toEqual(ps.json());

    // the child's archived output
    const archived = (await eventsOf(db, child)).find(
      (e): e is ToolResultEvent => e.type === "tool_result" && e.payload.outputId !== undefined,
    );
    expect(archived).toBeDefined();
    const out = await owner({
      method: "GET",
      url: `${base()}/${child}/outputs/${archived?.payload.outputId}`,
    });
    expect(out.statusCode, out.body).toBe(200);
    expect(out.json().output.text).toContain("a\na\na\n");

    // nobody else: the member gets 404 on every child route
    const someArtifact = "00000000-0000-4000-8000-000000000000";
    for (const [method, path, payload] of [
      ["GET", ""],
      ["GET", "/events"],
      ["GET", "/sandbox"],
      ["GET", `/outputs/${archived?.payload.outputId}`],
      ["GET", "/subagents"],
      ["GET", "/stream"],
      ["GET", "/usage"],
      ["GET", `/artifacts/${someArtifact}/download`],
      ["GET", `/artifacts/${someArtifact}/preview`],
      ["POST", "/abort", {}],
      ["POST", "/messages", { text: "hi" }],
    ] as const) {
      const r = await member({
        method,
        url: `${base()}/${child}${path}`,
        ...(payload !== undefined && { payload }),
      });
      expect(r.statusCode, `${method} ${path}`).toBe(404);
      expect(r.body, `${method} ${path}`).not.toContain(conv);
    }
  }, 60_000);

  it("listMine never lists children", async () => {
    const { conv, child } = await oneChild();
    const list = await owner({ method: "GET", url: base() });
    expect(list.statusCode).toBe(200);
    expect((list.json().conversations as { id: string }[]).map((c) => c.id)).toEqual([conv]);
    const groups = await owner({ method: "GET", url: `${base()}/groups` });
    expect(groups.statusCode).toBe(200);
    const ids = (groups.json().groups as { conversations: { id: string }[] }[]).flatMap((g) =>
      g.conversations.map((c) => c.id),
    );
    expect(ids).toEqual([conv]);
    expect(ids).not.toContain(child);
  }, 60_000);
});

describe("progress and usage", () => {
  it("the parent's SSE receives subagent_progress during a child run", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const s = await openSse(
      `http://127.0.0.1:${k.port}/api/v1/orgs/${orgId}/conversations/${conv}/stream`,
      { cookie: ownerCookie() },
    );
    try {
      expect(s.status).toBe(200);
      await postMessage(owner, orgId, conv, "SCENARIO one");
      await s.until(
        (msgs) => msgs.some((m) => m.event === "subagent_progress"),
        30_000,
        "subagent_progress",
      );
      await waitForTerminal(db, conv, 1, 30_000);
      const [c] = await childRunsOf(db, conv);
      const progress = s.messages
        .filter((m) => m.event === "subagent_progress")
        .map((m) => JSON.parse(m.data as string));
      expect(progress[0]).toEqual({
        subagentId: c?.conversationId,
        step: 1,
        toolCalls: 1,
        lastToolKey: "sandbox_bash",
      });
    } finally {
      s.close();
    }
    // not in the log (ephemeral, spec §14.2)
    const [c] = await childRunsOf(db, conv);
    for (const id of [conv, c?.conversationId as string]) {
      expect((await eventsOf(db, id)).map((e) => e.type)).not.toContain("subagent_progress");
    }
  }, 60_000);

  it("conversation usage sums the children", async () => {
    const { conv, child } = await oneChild();
    const r = await owner({ method: "GET", url: `${base()}/${conv}/usage` });
    expect(r.statusCode, r.body).toBe(200);
    const own = await usageOf(conv);
    const both = await usageOf(conv, child);
    expect(both.inputTokens).toBeGreaterThan(own.inputTokens);
    expect(r.json()).toEqual({ usage: both });
    // a child's usage is its own
    const cr = await owner({ method: "GET", url: `${base()}/${child}/usage` });
    expect(cr.json()).toEqual({ usage: await usageOf(child) });
    // owner only
    expect((await member({ method: "GET", url: `${base()}/${conv}/usage` })).statusCode).toBe(404);
  }, 60_000);
});
