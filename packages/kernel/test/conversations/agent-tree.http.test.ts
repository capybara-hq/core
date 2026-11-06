import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { type ScriptRule, scriptRules } from "../fixtures/plugins/model-script/index.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
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
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";
import { openSse } from "../helpers/sse.js";

/**
 * Agent map Task A9 (spec §8, §9.2): `GET /conversations/:id/agent-tree` (owner only, roots only)
 * and `subagent_progress` on the topic of every ancestor. One kernel with model-script and
 * sandbox-fake; waking is off so each conversation has exactly the runs the script gives it.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");

const CHILD = "You are a sub-agent";
const SCRIPT = { provider: "model-script", model: "script-1" };
const agentCall = (description: string, prompt: string) => ({
  name: "Agent",
  input: { description, prompt },
});

// root → "Level 1" → "Level 2"; the grandchild runs one Bash command
const RULES: ScriptRule[] = [
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "L2-go", assistantTurns: 0 },
    reply: {
      toolCalls: [{ name: "Bash", input: { description: "Say hi", command: "echo hi" } }],
    },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "L2-go", assistantTurns: 1 },
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
    when: { systemIncludes: CHILD, lastUserIncludes: "L1-go", assistantTurns: 0 },
    reply: { toolCalls: [agentCall("Level 2", "L2-go")] },
  },
  {
    when: { lastUserIncludes: "SCENARIO tree", lastToolResultIncludes: "background" },
    reply: { text: "tree done" },
  },
  {
    when: { lastUserIncludes: "SCENARIO tree", assistantTurns: 0 },
    reply: { toolCalls: [agentCall("Level 1", "L1-go")] },
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
  root = await mkdtemp(join(tmpdir(), "cap-agent-tree-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE],
        extensionConfig: { "model-script": { rules: RULES }, "sandbox-fake": { root } },
        runtime: { wakeOnBackgroundTask: false },
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
  const accounts = accountsFor(db);
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
  scriptRules([]);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Lead",
        instructions: "Lead the work.",
        model: SCRIPT,
        tools: ["Agent", "Bash"].map((name) => ({ kind: "builtin", name })),
      },
      // the member can use the agent, so a 404 below is the owner-only rule, not visibility
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

const base = () => `/api/v1/orgs/${orgId}/conversations`;

interface AgentTreeNode {
  id: string;
  description: string;
  agentType: string | null;
  status: string;
  model: { provider: string; model: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number;
  tokens: number;
  toolCalls: number;
  children: AgentTreeNode[];
}

const childOf = async (parent: string): Promise<string> =>
  (
    await waitFor(
      () =>
        db
          .selectFrom("conversations")
          .select("id")
          .where("parent_conversation_id", "=", parent)
          .executeTakeFirst(),
      30_000,
      `a child of ${parent}`,
    )
  ).id;

/** Waits until every run of the conversation has ended. */
async function settled(conv: string): Promise<void> {
  await waitFor(
    async () => {
      const runs = await db
        .selectFrom("runs")
        .select("status")
        .where("conversation_id", "=", conv)
        .execute();
      return (
        (runs.length > 0 &&
          runs.every((r) => ["completed", "failed", "aborted"].includes(r.status))) ||
        null
      );
    },
    30_000,
    `the runs of ${conv} ended`,
  );
}

/** Runs the scenario to its end: root, child and grandchild settled. */
async function tree(): Promise<{ conv: string; l1: string; l2: string }> {
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, "SCENARIO tree");
  await waitForTerminal(db, conv, 1, 30_000);
  const l1 = await childOf(conv);
  const l2 = await childOf(l1);
  for (const c of [l2, l1, conv]) await settled(c);
  return { conv, l1, l2 };
}

/** The tokens of a conversation's own runs, straight from its log. */
async function tokensOf(conv: string): Promise<number> {
  let n = 0;
  for (const e of await eventsOf(db, conv)) {
    if (e.type !== "usage" || e.runId === null) continue;
    n +=
      e.payload.inputTokens +
      e.payload.outputTokens +
      e.payload.cacheReadTokens +
      e.payload.cacheWriteTokens;
  }
  return n;
}

/** The wall time of a conversation's runs, summed, from the runs table. */
async function durationOf(conv: string): Promise<number> {
  const runs = await db
    .selectFrom("runs")
    .select(["started_at", "finished_at"])
    .where("conversation_id", "=", conv)
    .execute();
  return runs.reduce(
    (n, r) =>
      n +
      (r.started_at && r.finished_at
        ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()
        : 0),
    0,
  );
}

async function getTree(req: Req, conv: string) {
  const r = await req({ method: "GET", url: `${base()}/${conv}/agent-tree` });
  return r;
}

describe("GET /conversations/:id/agent-tree", () => {
  it("returns a 3-level tree with status, model, duration, tokens and tool calls", async () => {
    const { conv, l1, l2 } = await tree();
    const r = await getTree(owner, conv);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers["cache-control"]).toBe("private, no-store");
    const body = r.json() as { root: AgentTreeNode };
    const node = (id: string, description: unknown, agentType: string | null) => ({
      id,
      description,
      agentType,
      status: "idle",
      model: SCRIPT,
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      durationMs: expect.any(Number),
      tokens: expect.any(Number),
      toolCalls: 1,
      children: expect.any(Array),
    });
    expect(body.root).toEqual(node(conv, expect.any(String), null));
    expect(body.root.children).toEqual([node(l1, "Level 1", "general-purpose")]);
    const c1 = body.root.children[0] as AgentTreeNode;
    expect(c1.children).toEqual([node(l2, "Level 2", "general-purpose")]);
    const c2 = c1.children[0] as AgentTreeNode;
    expect(c2.children).toEqual([]);
    // tokens: the node's own runs only, never its descendants'
    for (const [n, id] of [
      [body.root, conv],
      [c1, l1],
      [c2, l2],
    ] as const) {
      expect(n.tokens).toBe(await tokensOf(id));
      expect(n.tokens).toBeGreaterThan(0);
      expect(Math.abs(n.durationMs - (await durationOf(id)))).toBeLessThanOrEqual(2);
      expect(Date.parse(n.finishedAt as string)).toBeGreaterThanOrEqual(
        Date.parse(n.startedAt as string),
      );
    }
  }, 90_000);

  it("a child id is 404", async () => {
    const { l1, l2 } = await tree();
    for (const id of [l1, l2]) {
      const r = await getTree(owner, id);
      expect(r.statusCode).toBe(404);
      expect(r.json()).toMatchObject({ error: { code: "conversation.not_found" } });
    }
  }, 90_000);

  it("another account's conversation is 404", async () => {
    const { conv, l1 } = await tree();
    const r = await getTree(member, conv);
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: { code: "conversation.not_found" } });
    expect(r.body).not.toContain(l1);
    const unknown = await getTree(owner, "00000000-0000-4000-8000-000000000000");
    expect(unknown.statusCode).toBe(404);
  }, 90_000);
});

describe("subagent_progress", () => {
  it("a grandchild's progress reaches the root's SSE stream", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const s = await openSse(
      `http://127.0.0.1:${k.port}/api/v1/orgs/${orgId}/conversations/${conv}/stream`,
      { cookie: ownerCookie() },
    );
    try {
      expect(s.status).toBe(200);
      await postMessage(owner, orgId, conv, "SCENARIO tree");
      await waitForTerminal(db, conv, 1, 30_000);
      const l1 = await childOf(conv);
      const l2 = await childOf(l1);
      const progressOf = (id: string) =>
        s.messages
          .filter((m) => m.event === "subagent_progress")
          .map((m) => JSON.parse(m.data as string) as { subagentId: string; toolCalls: number })
          .filter((p) => p.subagentId === id);
      await s.until(() => progressOf(l2).length > 0, 30_000, "the grandchild's progress");
      expect(progressOf(l2)[0]).toEqual({
        subagentId: l2,
        step: 1,
        toolCalls: 1,
        lastToolKey: "Bash",
      });
      await s.until(() => progressOf(l1).length > 0, 30_000, "the child's progress");
    } finally {
      s.close();
    }
  }, 90_000);
});
