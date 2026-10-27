import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
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
      // 只测 HTTP 与事件日志：不执行运行（worker 角色会用默认 loop 回复消息、追加事件）
      roles: ["api"],
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  const db = kernelDb(raw);
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
      ["GET", `${base}/${conv.id}/outputs/00000000-0000-4000-8000-000000000000`, undefined],
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

  it("abort：没有活跃运行 → 409 run.not_active；有排队中的运行 → 202 { runId } 并设置中止标记", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    const conv = await createConv(req, orgId, agentId);
    const url = `/api/v1/orgs/${orgId}/conversations/${conv.id}/abort`;
    const none = await req({ method: "POST", url });
    expect(none.statusCode).toBe(409);
    expect(errCode(none)).toBe("run.not_active");

    // 本内核没有注入 loop，不执行运行：消息投递出的运行停在 queued
    expect((await post(req, orgId, conv.id, { text: "hello" })).statusCode).toBe(202);
    const res = await req({ method: "POST", url });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json() as { runId: string };
    const run = await kernelDb(raw)
      .selectFrom("runs")
      .select(["id", "status"])
      .where("conversation_id", "=", conv.id)
      .executeTakeFirstOrThrow();
    expect(run).toEqual({ id: runId, status: "queued" });
    expect(await redis.ttl(`capk:run-abort:${runId}`)).toBeGreaterThan(3500);
  });

  it("abort 别人的会话 → 404 conversation.not_found", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const agentId = await createAgent(ownerReq, orgId);
    const conv = await createConv(ownerReq, orgId, agentId);
    const other = await memberSession(orgId, "other", "admin");
    const res = await other.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv.id}/abort`,
    });
    expect(res.statusCode).toBe(404);
    expect(errCode(res)).toBe("conversation.not_found");
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

describe("工具输出存档（GET .../conversations/:id/outputs/:outputId）", () => {
  const outputsUrl = (orgId: string, convId: string, outputId: string, q = "") =>
    `/api/v1/orgs/${orgId}/conversations/${convId}/outputs/${outputId}${q}`;
  type OutputJson = {
    output: { id: string; text: string; offset: number; totalChars: number; next: number | null };
  };

  it("自己的会话：200 全文；按字符分页（offset / limit，next 为下一页起点）", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    const conv = await createConv(req, orgId, agentId);
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const saved = await k.tools.outputs.save({
      orgId,
      conversationId: conv.id,
      callId: "call_1",
      content,
    });
    const all = await req({ method: "GET", url: outputsUrl(orgId, conv.id, saved.id) });
    expect(all.statusCode).toBe(200);
    expect((all.json() as OutputJson).output).toEqual({
      id: saved.id,
      text: content,
      offset: 0,
      totalChars: content.length,
      next: null,
    });
    const page = await req({
      method: "GET",
      url: outputsUrl(orgId, conv.id, saved.id, "?offset=5&limit=10"),
    });
    expect(page.statusCode).toBe(200);
    expect((page.json() as OutputJson).output).toMatchObject({
      text: content.slice(5, 15),
      offset: 5,
      next: 15,
    });
    const bad = await req({
      method: "GET",
      url: outputsUrl(orgId, conv.id, saved.id, "?limit=0"),
    });
    expect(bad.statusCode).toBe(400);
    // 每页上限 OUTPUT_PAGE_MAX_CHARS（200000）：恰好上限 200，超过 400
    const max = await req({
      method: "GET",
      url: outputsUrl(orgId, conv.id, saved.id, "?limit=200000"),
    });
    expect(max.statusCode).toBe(200);
    const over = await req({
      method: "GET",
      url: outputsUrl(orgId, conv.id, saved.id, "?limit=200001"),
    });
    expect(over.statusCode).toBe(400);
    expect(errCode(over)).toBe("validation_failed");
  });

  it("过期的存档 → 404 conversation.output_not_found", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    const conv = await createConv(req, orgId, agentId);
    const saved = await k.tools.outputs.save({
      orgId,
      conversationId: conv.id,
      callId: "call_1",
      content: "old output",
    });
    await kernelDb(raw)
      .updateTable("tool_outputs")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", saved.id)
      .execute();
    const res = await req({ method: "GET", url: outputsUrl(orgId, conv.id, saved.id) });
    expect(res.statusCode).toBe(404);
    expect(errCode(res)).toBe("conversation.output_not_found");
    expect(res.body).not.toContain("old output");
  });

  it("别人的会话 → 404 conversation.not_found；别的会话的存档 → 404 conversation.output_not_found", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const agentId = await createAgent(ownerReq, orgId);
    const conv = await createConv(ownerReq, orgId, agentId);
    const otherConv = await createConv(ownerReq, orgId, agentId);
    const saved = await k.tools.outputs.save({
      orgId,
      conversationId: conv.id,
      callId: "call_1",
      content: "secret output",
    });
    const other = await memberSession(orgId, "other", "admin");
    const theirs = await other.req({ method: "GET", url: outputsUrl(orgId, conv.id, saved.id) });
    expect(theirs.statusCode).toBe(404);
    expect(errCode(theirs)).toBe("conversation.not_found");
    expect(theirs.body).not.toContain("secret output");

    const elsewhere = await ownerReq({
      method: "GET",
      url: outputsUrl(orgId, otherConv.id, saved.id),
    });
    expect(elsewhere.statusCode).toBe(404);
    expect(errCode(elsewhere)).toBe("conversation.output_not_found");

    // id 不是 UUID：一律 404，不打到数据库
    for (const url of [
      outputsUrl(orgId, conv.id, "not-a-uuid"),
      outputsUrl(orgId, "not-a-uuid", saved.id),
    ]) {
      const res = await ownerReq({ method: "GET", url });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe("Create on first send and rename (UI refresh B, Task 7)", () => {
  type Created = { conversation: ConvJson & { title: string | null }; event?: EventJson };
  const create = (req: Req, orgId: string, payload: Record<string, unknown>) =>
    req({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations`, payload });
  const rename = (req: Req, orgId: string, id: string, payload: Record<string, unknown>) =>
    req({ method: "PATCH", url: `/api/v1/orgs/${orgId}/conversations/${id}`, payload });

  it("creates the conversation with its first message once per clientMessageId", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    const payload = { agentId, message: { text: "hello", clientMessageId: "c-1" } };
    const first = await create(req, orgId, payload);
    expect(first.statusCode).toBe(201);
    const a = first.json() as Created;
    expect(a.event).toMatchObject({
      seq: 1,
      type: "user_message",
      payload: { content: [{ type: "text", text: "hello" }], clientMessageId: "c-1" },
    });
    expect(a.conversation).toMatchObject({ agentId, lastSeq: 1, titleSource: null });
    const runs = await kernelDb(raw)
      .selectFrom("runs")
      .select("status")
      .where("conversation_id", "=", a.conversation.id)
      .execute();
    expect(runs).toEqual([{ status: "queued" }]);

    const again = await create(req, orgId, payload);
    expect(again.statusCode).toBe(200);
    const b = again.json() as Created;
    expect(b.conversation.id).toBe(a.conversation.id);
    expect(b.event?.seq).toBe(a.event?.seq);
    const events = await kernelDb(raw)
      .selectFrom("conversation_events")
      .select("seq")
      .where("conversation_id", "=", a.conversation.id)
      .execute();
    expect(events).toHaveLength(1);
    const convs = await kernelDb(raw)
      .selectFrom("conversations")
      .select("id")
      .where("org_id", "=", orgId)
      .execute();
    expect(convs).toHaveLength(1);
  });

  it("concurrent retries of the same first send create one conversation", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    const payload = { agentId, message: { text: "hi", clientMessageId: "c-race" } };
    const res = await Promise.all([1, 2, 3].map(() => create(req, orgId, payload)));
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
    const ids = new Set(res.map((r) => (r.json() as Created).conversation.id));
    expect(ids.size).toBe(1);
  });

  it("an agent the caller cannot use → 404 agent.not_found and nothing written", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const privateAgent = await createAgent(ownerReq, orgId, "private");
    const m = await memberSession(orgId, "mem", "member");
    const res = await create(m.req, orgId, {
      agentId: privateAgent,
      message: { text: "hello", clientMessageId: "c-2" },
    });
    expect(res.statusCode).toBe(404);
    expect(errCode(res)).toBe("agent.not_found");
    const convs = await kernelDb(raw)
      .selectFrom("conversations")
      .select("id")
      .where("org_id", "=", orgId)
      .execute();
    expect(convs).toEqual([]);
  });

  it("the same clientMessageId for another agent → 409 conflict, nothing new written", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentA = await createAgent(req, orgId);
    const agentB = await createAgent(req, orgId);
    const first = await create(req, orgId, {
      agentId: agentA,
      message: { text: "hello", clientMessageId: "c-shared" },
    });
    expect(first.statusCode).toBe(201);
    const res = await create(req, orgId, {
      agentId: agentB,
      message: { text: "hello", clientMessageId: "c-shared" },
    });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("conflict");
    expect(res.body).not.toContain((first.json() as Created).conversation.id);
    const convs = await kernelDb(raw)
      .selectFrom("conversations")
      .select("agent_id")
      .where("org_id", "=", orgId)
      .execute();
    expect(convs).toEqual([{ agent_id: agentA }]);
  });

  it("message validation: text required, clientMessageId required", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    for (const message of [{ text: "", clientMessageId: "x" }, { text: "hi" }]) {
      const res = await create(req, orgId, { agentId, message });
      expect(res.statusCode).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
  });

  it("PATCH renames (manual), only the owner, 1-120 characters", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    const conv = await createConv(req, orgId, agentId);
    const ok = await rename(req, orgId, conv.id, { title: "  Quarterly report  " });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as Created).conversation).toMatchObject({
      title: "Quarterly report",
      titleSource: "manual",
    });
    const got = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/conversations/${conv.id}` });
    expect((got.json() as Created).conversation).toMatchObject({ titleSource: "manual" });

    // counted in code points: 120 emoji (240 UTF-16 units) fit, 121 do not
    const emoji = await rename(req, orgId, conv.id, { title: "😀".repeat(120) });
    expect(emoji.statusCode, emoji.body).toBe(200);
    for (const title of [
      "x".repeat(121),
      "😀".repeat(121),
      "   ",
      "a\u0000b",
      "a\u202Eb",
      "a\u200Bb",
      "a\u200Eb",
      "a\u061Cb",
      "a\u{E0041}b",
    ]) {
      const bad = await rename(req, orgId, conv.id, { title });
      expect(bad.statusCode).toBe(400);
      expect(errCode(bad)).toBe("validation_failed");
    }
    // ZWNJ (Persian and other scripts) and ZWJ (emoji sequences) are allowed (review M3)
    for (const title of ["می\u200Cخواهم", "👨\u200D👩\u200D👧"]) {
      const good = await rename(req, orgId, conv.id, { title });
      expect(good.statusCode, good.body).toBe(200);
      expect((good.json() as Created).conversation.title).toBe(title);
    }
    const other = await memberSession(orgId, "other", "admin");
    const res = await rename(other.req, orgId, conv.id, { title: "mine" });
    expect(res.statusCode).toBe(404);
    expect(errCode(res)).toBe("conversation.not_found");
  });
});

describe("Retry after a failed run (UI refresh B, decision 6)", () => {
  it("records retryOf on the user_message (display only)", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    const conv = await createConv(req, orgId, agentId);
    const first = await post(req, orgId, conv.id, { text: "hello", clientMessageId: "r-1" });
    expect(first.statusCode).toBe(202);
    const seq = (first.json() as { event: EventJson }).event.seq;
    const retry = await post(req, orgId, conv.id, {
      text: "hello",
      clientMessageId: "r-2",
      retryOf: seq,
    });
    expect(retry.statusCode).toBe(202);
    const e = (retry.json() as { event: EventJson }).event;
    expect(e.payload).toMatchObject({ content: [{ type: "text", text: "hello" }], retryOf: seq });
    // Not a positive integer → 400
    const bad = await post(req, orgId, conv.id, { text: "x", retryOf: 0 });
    expect(bad.statusCode).toBe(400);
  });
});
