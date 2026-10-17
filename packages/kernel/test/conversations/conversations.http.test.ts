import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { type Account, AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { MembersService } from "../../src/orgs/members.service.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
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
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  const db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = new AccountsService(db);
  members = new MembersService(db);
  tokens = new ApiTokenService(db);
}, 120_000);
afterAll(async () => {
  await k?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await sql`TRUNCATE capybara.accounts, capybara.orgs, capybara.audit_events CASCADE`.execute(raw);
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

const definition = {
  name: "Helper",
  instructions: "Be helpful.",
  model: { provider: "model-fake", model: "fake-1" },
};

async function createAgent(req: Req, orgId: string, visibility = "org"): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: { definition, visibility },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

type ConvJson = { id: string; agentId: string; accountId: string; lastSeq: number };
type EventJson = { seq: number; type: string; payload: Record<string, unknown> };

async function createConv(req: Req, orgId: string, agentId: string): Promise<ConvJson> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations`,
    payload: { agentId },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { conversation: ConvJson }).conversation;
}

async function post(req: Req, orgId: string, convId: string, payload: Record<string, unknown>) {
  return req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
    payload,
  });
}

describe("Conversation HTTP", () => {
  it("未登录 → 401", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    for (const [method, url] of [
      ["GET", `/api/v1/orgs/${orgId}/conversations`],
      ["POST", `/api/v1/orgs/${orgId}/conversations`],
    ] as const) {
      const res = await k.http.inject({ method, url, headers: { "x-capybara-csrf": "1" } });
      expect(res.statusCode).toBe(401);
    }
  });

  it("创建、读取、列表、发消息、读事件", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    const conv = await createConv(req, orgId, agentId);
    expect(conv).toMatchObject({ agentId, accountId: owner.id, lastSeq: 0 });

    const one = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/conversations/${conv.id}` });
    expect(one.statusCode).toBe(200);
    expect((one.json() as { conversation: ConvJson }).conversation.id).toBe(conv.id);

    const msg = await post(req, orgId, conv.id, { text: "hello" });
    expect(msg.statusCode).toBe(202);
    const ev = (msg.json() as { event: EventJson }).event;
    expect(ev).toMatchObject({
      seq: 1,
      type: "user_message",
      payload: { content: [{ type: "text", text: "hello" }], authorAccountId: owner.id },
    });

    const events = await req({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations/${conv.id}/events`,
    });
    expect(events.statusCode).toBe(200);
    expect((events.json() as { events: EventJson[] }).events.map((e) => e.seq)).toEqual([1]);

    const list = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/conversations` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ conversations: [{ id: conv.id, lastSeq: 1 }], next: null });
  });

  it("不可用的 agent → 404 agent.not_found", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const privateAgent = await createAgent(ownerReq, orgId, "private");
    const m = await memberSession(orgId, "mem", "member");
    const res = await m.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations`,
      payload: { agentId: privateAgent },
    });
    expect(res.statusCode).toBe(404);
    expect(errCode(res)).toBe("agent.not_found");
  });

  it("别人的会话 → 404 conversation.not_found（读、事件、发消息）", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const agentId = await createAgent(ownerReq, orgId);
    const conv = await createConv(ownerReq, orgId, agentId);
    const other = await memberSession(orgId, "other", "admin");
    for (const res of [
      await other.req({ method: "GET", url: `/api/v1/orgs/${orgId}/conversations/${conv.id}` }),
      await other.req({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/conversations/${conv.id}/events`,
      }),
      await post(other.req, orgId, conv.id, { text: "hi" }),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(errCode(res)).toBe("conversation.not_found");
    }
    const list = await other.req({ method: "GET", url: `/api/v1/orgs/${orgId}/conversations` });
    expect((list.json() as { conversations: unknown[] }).conversations).toEqual([]);
  });

  it("agent 改成 private 后，原有会话 GET → 404（实时复核）", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const agentId = await createAgent(ownerReq, orgId, "org");
    const m = await memberSession(orgId, "mem", "member");
    const conv = await createConv(m.req, orgId, agentId);
    const url = `/api/v1/orgs/${orgId}/conversations/${conv.id}`;
    expect((await m.req({ method: "GET", url })).statusCode).toBe(200);

    const patch = await ownerReq({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: { visibility: "private" },
    });
    expect(patch.statusCode).toBe(200);

    const gone = await m.req({ method: "GET", url });
    expect(gone.statusCode).toBe(404);
    expect(errCode(gone)).toBe("conversation.not_found");
    const msg = await post(m.req, orgId, conv.id, { text: "hi" });
    expect(msg.statusCode).toBe(404);
    const list = await m.req({ method: "GET", url: `/api/v1/orgs/${orgId}/conversations` });
    expect((list.json() as { conversations: unknown[] }).conversations).toEqual([]);
  });

  it("同一个 clientMessageId 提交两次 → 同一 seq", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    const conv = await createConv(req, orgId, agentId);
    const a = await post(req, orgId, conv.id, { text: "hello", clientMessageId: "c-1" });
    const b = await post(req, orgId, conv.id, { text: "hello", clientMessageId: "c-1" });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    const sa = (a.json() as { event: EventJson }).event;
    const sb = (b.json() as { event: EventJson }).event;
    expect(sb.seq).toBe(sa.seq);
    expect(sa.payload.clientMessageId).toBe("c-1");
    const c = await post(req, orgId, conv.id, { text: "again", clientMessageId: "c-2" });
    expect((c.json() as { event: EventJson }).event.seq).toBe(sa.seq + 1);
  });

  it("服务令牌 → 403 forbidden", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    const conv = await createConv(req, orgId, agentId);
    const { token } = await tokens.createService(orgId, {
      name: "bot",
      role: "admin",
      createdBy: owner.id,
    });
    const headers = { authorization: `Bearer ${token}` };
    const base = `/api/v1/orgs/${orgId}/conversations`;
    for (const [method, url, payload] of [
      ["POST", base, { agentId }],
      ["GET", base, undefined],
      ["GET", `${base}/${conv.id}`, undefined],
      ["GET", `${base}/${conv.id}/events`, undefined],
      ["POST", `${base}/${conv.id}/messages`, { text: "hi" }],
    ] as const) {
      const res = await k.http.inject({ method, url, headers, ...(payload && { payload }) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(errCode(res)).toBe("forbidden");
    }
  });

  it("events?after= 分页正确", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    const conv = await createConv(req, orgId, agentId);
    for (let i = 0; i < 5; i++) {
      expect((await post(req, orgId, conv.id, { text: `m${i}` })).statusCode).toBe(202);
    }
    const url = `/api/v1/orgs/${orgId}/conversations/${conv.id}/events`;
    const seqs = async (q: string) => {
      const res = await req({ method: "GET", url: `${url}${q}` });
      expect(res.statusCode).toBe(200);
      return (res.json() as { events: EventJson[] }).events.map((e) => e.seq);
    };
    expect(await seqs("")).toEqual([1, 2, 3, 4, 5]);
    expect(await seqs("?after=2")).toEqual([3, 4, 5]);
    expect(await seqs("?after=2&limit=2")).toEqual([3, 4]);
    expect(await seqs("?after=5")).toEqual([]);
    expect((await req({ method: "GET", url: `${url}?after=-1` })).statusCode).toBe(400);
  });

  it("GET /conversations 按 next 游标分页", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await createConv(req, orgId, agentId)).id);
    const url = `/api/v1/orgs/${orgId}/conversations`;
    const p1 = (await req({ method: "GET", url: `${url}?limit=2` })).json() as {
      conversations: ConvJson[];
      next: string | null;
    };
    expect(p1.conversations.map((c) => c.id)).toEqual([ids[2], ids[1]]);
    expect(p1.next).not.toBeNull();
    const p2 = (await req({ method: "GET", url: `${url}?limit=2&after=${p1.next}` })).json() as {
      conversations: ConvJson[];
      next: string | null;
    };
    expect(p2.conversations.map((c) => c.id)).toEqual([ids[0]]);
    expect(p2.next).toBeNull();
  });

  it("校验：text 为空 / 超长 → 400；缺 agentId → 400", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    const conv = await createConv(req, orgId, agentId);
    for (const payload of [{ text: "" }, { text: "x".repeat(100_001) }, {}]) {
      const res = await post(req, orgId, conv.id, payload);
      expect(res.statusCode).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
