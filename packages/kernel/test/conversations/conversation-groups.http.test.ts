import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { type Account, AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";

// The sidebar's list API (UI refresh spec §5.9): GET /conversations/groups and the agentId filter
// on GET /conversations.

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let accounts: AccountsService;
let members: MembersService;
let tokens: ApiTokenService;
let owner: Account;

const PW = "correct horse battery";

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      http: { port: 0 },
      roles: ["api"],
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = new AccountsService(db);
  members = testMembers(db);
  tokens = new ApiTokenService(db);
}, 120_000);
afterAll(async () => {
  await k?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await redis.flushdb();
  owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

type Req = ReturnType<typeof asUser>;

async function session(login: string): Promise<Req> {
  const req = asUser(k.http, cookieJar());
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

async function createOrg(req: Req): Promise<string> {
  const res = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { org: { id: string } }).org.id;
}

async function memberSession(orgId: string, login: string, role: "admin" | "member" | "guest") {
  const a = await accounts.createLocal({ login, password: PW, displayName: login });
  await members.add(orgId, a.id, role, owner.id);
  return { account: a, req: await session(login) };
}

async function createAgent(req: Req, orgId: string, name: string): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name,
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

async function createConv(req: Req, orgId: string, agentId: string): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations`,
    payload: { agentId },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { conversation: { id: string } }).conversation.id;
}

/** Sets updated_at to a fixed minute so the activity order is known. */
async function touch(conversationId: string, minute: number): Promise<void> {
  await db
    .updateTable("conversations")
    .set({ updated_at: new Date(Date.UTC(2026, 9, 26, 12, minute)) })
    .where("id", "=", conversationId)
    .execute();
}

type Group = {
  agent: { id: string; name: string };
  latestAt: string;
  conversations: { id: string; title: string | null; agentId: string }[];
  more: boolean;
};
type GroupsJson = { groups: Group[]; next: string | null };

async function groups(req: Req, orgId: string, query = ""): Promise<GroupsJson> {
  const res = await req({
    method: "GET",
    url: `/api/v1/orgs/${orgId}/conversations/groups${query}`,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as GroupsJson;
}

/**
 * Three agents: A with 7 conversations (minutes 10..16), B with 1 (minute 20), C with 2
 * (minutes 5, 6). Latest activity: B (20) > A (16) > C (6).
 */
async function threeAgents(req: Req, orgId: string) {
  const a = await createAgent(req, orgId, "Agent A");
  const b = await createAgent(req, orgId, "Agent B");
  const c = await createAgent(req, orgId, "Agent C");
  const aConvs: string[] = [];
  for (let i = 0; i < 7; i++) {
    const id = await createConv(req, orgId, a);
    await touch(id, 10 + i);
    aConvs.push(id);
  }
  const bConv = await createConv(req, orgId, b);
  await touch(bConv, 20);
  const cConvs = [await createConv(req, orgId, c), await createConv(req, orgId, c)];
  await touch(cConvs[0] as string, 5);
  await touch(cConvs[1] as string, 6);
  return { a, b, c, aConvs, bConv, cConvs };
}

describe("GET /conversations/groups", () => {
  it("zero conversations -> { groups: [], next: null } (not captured by GET /conversations/:id)", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    expect(await groups(req, orgId)).toEqual({ groups: [], next: null });
  });

  it("groups by agent, ordered by latest activity; perGroup newest first with `more`", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { a, b, c, aConvs, bConv, cConvs } = await threeAgents(req, orgId);
    const res = await groups(req, orgId);
    expect(res.next).toBeNull();
    expect(res.groups.map((g) => g.agent)).toEqual([
      { id: b, name: "Agent B" },
      { id: a, name: "Agent A" },
      { id: c, name: "Agent C" },
    ]);
    const [gb, ga, gc] = res.groups as [Group, Group, Group];
    expect(gb.conversations.map((x) => x.id)).toEqual([bConv]);
    expect(gb.more).toBe(false);
    expect(gb.latestAt).toBe("2026-10-26T12:20:00.000Z");
    expect(ga.conversations.map((x) => x.id)).toEqual(aConvs.slice(2).reverse());
    expect(ga.more).toBe(true);
    expect(ga.latestAt).toBe("2026-10-26T12:16:00.000Z");
    expect(gc.conversations.map((x) => x.id)).toEqual([cConvs[1], cConvs[0]]);
    expect(gc.more).toBe(false);
    for (const g of res.groups) {
      for (const conv of g.conversations) {
        expect(conv.title).toBeNull();
        expect(conv.agentId).toBe(g.agent.id);
      }
    }

    const two = await groups(req, orgId, "?perGroup=2");
    expect(two.groups.map((g) => [g.conversations.length, g.more])).toEqual([
      [1, false],
      [2, true],
      [2, false],
    ]);
  });

  it("limit pages groups with next = the last group's agent id", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { a, b, c } = await threeAgents(req, orgId);
    const p1 = await groups(req, orgId, "?limit=2");
    expect(p1.groups.map((g) => g.agent.id)).toEqual([b, a]);
    expect(p1.next).toBe(a);
    const p2 = await groups(req, orgId, `?limit=2&after=${p1.next}`);
    expect(p2.groups.map((g) => g.agent.id)).toEqual([c]);
    expect(p2.next).toBeNull();
    // A cursor agent that is no longer listed (no conversations of mine) -> empty page.
    expect(await groups(req, orgId, `?after=${randomUUID()}`)).toEqual({ groups: [], next: null });
  });

  it("never lists other users' conversations or eval conversations", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const agent = await createAgent(ownerReq, orgId, "Shared");
    const m = await memberSession(orgId, "mem", "member");
    const mine = await createConv(m.req, orgId, agent);
    await createConv(ownerReq, orgId, agent);
    await db
      .insertInto("conversations")
      .values({
        id: randomUUID(),
        org_id: orgId,
        agent_id: agent,
        account_id: m.account.id,
        kind: "eval",
      })
      .execute();
    const res = await groups(m.req, orgId);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]?.conversations.map((x) => x.id)).toEqual([mine]);
    expect(res.groups[0]?.more).toBe(false);
  });

  it("an agent made private to someone else, or soft-deleted, drops its group", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const priv = await createAgent(ownerReq, orgId, "Soon private");
    const gone = await createAgent(ownerReq, orgId, "Soon deleted");
    const kept = await createAgent(ownerReq, orgId, "Kept");
    const m = await memberSession(orgId, "mem", "member");
    for (const agent of [priv, gone, kept]) await createConv(m.req, orgId, agent);
    expect((await groups(m.req, orgId)).groups).toHaveLength(3);

    const patch = await ownerReq({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${priv}`,
      payload: { visibility: "private" },
    });
    expect(patch.statusCode).toBe(200);
    const del = await ownerReq({ method: "DELETE", url: `/api/v1/orgs/${orgId}/agents/${gone}` });
    expect(del.statusCode).toBe(204);

    const res = await groups(m.req, orgId);
    expect(res.groups.map((g) => g.agent.id)).toEqual([kept]);
  });

  it("perGroup / limit out of range -> 400; service token -> 403 forbidden", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    for (const q of ["?perGroup=21", "?perGroup=0", "?limit=51", "?limit=0"]) {
      const res = await req({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/conversations/groups${q}`,
      });
      expect(res.statusCode, q).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
    const { token } = await tokens.createService(orgId, {
      name: "bot",
      role: "admin",
      createdBy: owner.id,
    });
    const res = await k.http.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations/groups`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("forbidden");
  });

  it("the partial index exists (migration)", async () => {
    const { rows } = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'capybara' AND indexname = 'conversations_account_agent_idx'
    `.execute(raw);
    expect(rows[0]?.indexdef).toContain("(org_id, account_id, agent_id, updated_at DESC, id DESC)");
    expect(rows[0]?.indexdef).toContain("WHERE (kind = 'chat'");
  });
});

describe("GET /conversations?agentId=", () => {
  it("lists only that agent's conversations and pages with next", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { a, aConvs } = await threeAgents(req, orgId);
    const url = `/api/v1/orgs/${orgId}/conversations?agentId=${a}`;
    type Page = { conversations: { id: string; agentId: string }[]; next: string | null };
    const p1 = (await req({ method: "GET", url: `${url}&limit=5` })).json() as Page;
    expect(p1.conversations.map((x) => x.id)).toEqual(aConvs.slice(2).reverse());
    expect(p1.next).toBe(aConvs[2]);
    const p2 = (
      await req({ method: "GET", url: `${url}&limit=5&after=${p1.next}` })
    ).json() as Page;
    expect(p2.conversations.map((x) => x.id)).toEqual([aConvs[1], aConvs[0]]);
    expect(p2.next).toBeNull();
    for (const x of [...p1.conversations, ...p2.conversations]) expect(x.agentId).toBe(a);
  });
});
