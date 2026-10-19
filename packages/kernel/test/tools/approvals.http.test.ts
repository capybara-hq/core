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
import { MembersService } from "../../src/orgs/members.service.js";
import {
  type ApprovalRecord,
  type ApprovalRequestInput,
  ApprovalsService,
} from "../../src/tools/approvals.service.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { eventsOf } from "../helpers/runs.js";

/**
 * 审批 HTTP。两个内核实例（各自的连接池与 HTTP 应用，共用 PG / Redis）模拟两个副本，
 * 覆盖 Review Focus 1：同一审批在两个副本上被并发处理，恰好一个成功。
 */

let pgc: TestContainer;
let rd: TestContainer;
let ka: Kernel;
let kb: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let accounts: AccountsService;
let members: MembersService;
let tokens: ApiTokenService;

const PW = "correct horse battery";
const silent = () => createLogger("error", { write: () => {} });
const kernelConfig = () =>
  KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 5 },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    http: { port: 0 },
    roles: ["api"],
  });

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  ka = await createKernel(kernelConfig(), { env: {}, logger: silent() });
  await ka.start();
  kb = await createKernel(kernelConfig(), { env: {}, logger: silent() });
  await kb.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = new AccountsService(db);
  members = new MembersService(db);
  tokens = new ApiTokenService(db);
}, 120_000);
afterAll(async () => {
  await kb?.stop();
  await ka?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type Req = ReturnType<typeof asUser>;
const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

let owner: Account;
let orgId: string;
let initiator: { account: Account; req: Req; reqB: Req };
let admin: { account: Account; req: Req; reqB: Req };
let other: { account: Account; req: Req; reqB: Req };
let agentId: string;
let conversationId: string;
let runId: string;
let appId: string;

/** 在两个副本上各持有一个会话（同一 Cookie 罐：登录后的 Cookie 两边都认）。 */
async function login(loginName: string): Promise<{ req: Req; reqB: Req }> {
  const jar = cookieJar();
  const req = asUser(ka.http, jar);
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: loginName, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return { req, reqB: asUser(kb.http, jar) };
}

async function member(loginName: string, role: "admin" | "member" | "guest") {
  const account = await accounts.createLocal({
    login: loginName,
    password: PW,
    displayName: loginName,
  });
  await members.add(orgId, account.id, role, owner.id);
  return { account, ...(await login(loginName)) };
}

const svc = () => ka.tools.approvals;

function request(over: Partial<ApprovalRequestInput> = {}): Promise<ApprovalRecord> {
  return svc().request({
    orgId,
    conversationId,
    runId,
    step: 1,
    callId: `c-${randomUUID().slice(0, 8)}`,
    toolKey: "docs__create_doc",
    specHash: "hash-1",
    appId,
    input: { title: "Q3 plan" },
    requestedFor: initiator.account.id,
    approverRole: null,
    ...over,
  });
}

beforeEach(async () => {
  await sql`TRUNCATE capybara.accounts, capybara.orgs, capybara.audit_events CASCADE`.execute(raw);
  await redis.flushdb();
  owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
  const o = await login("owner");
  const res = await o.req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  expect(res.statusCode).toBe(201);
  orgId = (res.json() as { org: { id: string } }).org.id;
  initiator = await member("ini", "member");
  admin = await member("adm", "admin");
  other = await member("oth", "member");

  agentId = randomUUID();
  conversationId = randomUUID();
  runId = randomUUID();
  appId = randomUUID();
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agentId}, ${orgId}, ${initiator.account.id}, 'org', 1)`.execute(raw);
  await sql`INSERT INTO capybara.agent_versions (agent_id, version, definition, created_by)
    VALUES (${agentId}, 1, ${JSON.stringify({ name: "Writer" })}::jsonb, ${initiator.account.id})`.execute(
    raw,
  );
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${conversationId}, ${orgId}, ${agentId}, ${initiator.account.id})`.execute(raw);
  await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq)
    VALUES (${runId}, ${conversationId}, 'running', 1, ${initiator.account.id}, 0)`.execute(raw);
  await sql`INSERT INTO capybara.apps (id, org_id, slug, name, connector, created_by)
    VALUES (${appId}, ${orgId}, 'docs', 'Docs', 'test', ${owner.id})`.execute(raw);
});

const base = () => `/api/v1/orgs/${orgId}/approvals`;
const ids = (res: { json(): unknown }) =>
  (res.json() as { approvals: { id: string }[] }).approvals.map((a) => a.id).sort();

describe("列表与详情的可见性", () => {
  it("requested_for 审批只对被指定的人（发起人）可见", async () => {
    const a = await request();
    const mine = await initiator.req({ method: "GET", url: `${base()}?status=pending` });
    expect(mine.statusCode).toBe(200);
    expect(ids(mine)).toEqual([a.id]);
    for (const u of [admin, other]) {
      expect(ids(await u.req({ method: "GET", url: `${base()}?status=pending` }))).toEqual([]);
      const one = await u.req({ method: "GET", url: `${base()}/${a.id}` });
      expect(one.statusCode).toBe(404);
      expect(errCode(one)).toBe("approval.not_found");
    }
  });

  it("按角色升级的审批：对 admin / owner 可见，对发起人（即使已升为 admin）与角色不足者不可见（R2）", async () => {
    const a = await request({ requestedFor: null, approverRole: "admin" });
    expect(ids(await admin.req({ method: "GET", url: base() }))).toEqual([a.id]);
    const ownerSession = await login("owner");
    expect(ids(await ownerSession.req({ method: "GET", url: base() }))).toEqual([a.id]);
    expect(ids(await other.req({ method: "GET", url: base() }))).toEqual([]);
    await sql`UPDATE capybara.memberships SET role = 'admin'
      WHERE org_id = ${orgId} AND account_id = ${initiator.account.id}`.execute(raw);
    expect(ids(await initiator.req({ method: "GET", url: base() }))).toEqual([]);
    const own = await initiator.req({
      method: "POST",
      url: `${base()}/${a.id}/decision`,
      payload: { decision: "approve" },
    });
    expect(own.statusCode).toBe(404);
    expect(errCode(own)).toBe("approval.not_found");
  });

  it("详情：工具名、应用、参数、agent、会话链接、过期时间", async () => {
    const a = await request();
    const res = await initiator.req({ method: "GET", url: `${base()}/${a.id}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { approval: unknown }).approval).toMatchObject({
      id: a.id,
      status: "pending",
      toolKey: "docs__create_doc",
      toolName: "create_doc",
      app: { id: appId, name: "Docs", slug: "docs" },
      input: { title: "Q3 plan" },
      agent: { id: agentId, name: "Writer" },
      conversationId,
      conversationPath: `/chat/${conversationId}`,
      initiatorAccountId: initiator.account.id,
      requestedFor: initiator.account.id,
      approverRole: null,
      expiresAt: a.expiresAt,
    });
  });

  it("status 过滤：已处理的不出现在 pending 列表", async () => {
    const a = await request();
    const b = await request();
    await initiator.req({
      method: "POST",
      url: `${base()}/${b.id}/decision`,
      payload: { decision: "deny" },
    });
    expect(ids(await initiator.req({ method: "GET", url: `${base()}?status=pending` }))).toEqual([
      a.id,
    ]);
    expect(ids(await initiator.req({ method: "GET", url: base() }))).toEqual([a.id, b.id].sort());
    const bad = await initiator.req({ method: "GET", url: `${base()}?status=nope` });
    expect(bad.statusCode).toBe(400);
  });

  it("pending 列表不含已到期（expires_at <= now()）但超时任务尚未处理的审批", async () => {
    const a = await request();
    const b = await request();
    await sql`UPDATE capybara.approvals SET expires_at = now() - interval '1 second'
      WHERE id = ${b.id}`.execute(raw);
    expect(ids(await initiator.req({ method: "GET", url: `${base()}?status=pending` }))).toEqual([
      a.id,
    ]);
  });
});

describe("决定", () => {
  it("非发起人不能处理 requested_for 审批", async () => {
    const a = await request();
    for (const u of [admin, other]) {
      const res = await u.req({
        method: "POST",
        url: `${base()}/${a.id}/decision`,
        payload: { decision: "approve" },
      });
      expect(res.statusCode).toBe(404);
      expect(errCode(res)).toBe("approval.not_found");
    }
    const row = await db
      .selectFrom("approvals")
      .select("status")
      .where("id", "=", a.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("pending");
  });

  it("批准（本会话）→ approval_decided 事件 + 会话授权；再拒绝 → 409 approval.already_decided", async () => {
    const a = await request();
    const res = await initiator.req({
      method: "POST",
      url: `${base()}/${a.id}/decision`,
      payload: { decision: "approve", scope: "session", note: "ok" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { approval: unknown }).approval).toMatchObject({
      status: "approved",
      scope: "session",
      decidedBy: initiator.account.id,
    });
    const grants = await db.selectFrom("conversation_tool_grants").selectAll().execute();
    expect(grants).toEqual([
      {
        conversation_id: conversationId,
        tool_key: "docs__create_doc",
        spec_hash: "hash-1",
        app_id: appId,
      },
    ]);
    const evs = (await eventsOf(db, conversationId)).filter((e) => e.type === "approval_decided");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      runId,
      payload: {
        approvalId: a.id,
        callId: a.callId,
        decision: "approved",
        scope: "session",
        byAccountId: initiator.account.id,
      },
    });
    const audit = await db
      .selectFrom("audit_events")
      .select(["action", "actor_account_id", "detail"])
      .where("action", "=", "approval.decided")
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toMatchObject({ toolKey: "docs__create_doc", decision: "approved" });

    const again = await initiator.req({
      method: "POST",
      url: `${base()}/${a.id}/decision`,
      payload: { decision: "deny" },
    });
    expect(again.statusCode).toBe(409);
    expect(errCode(again)).toBe("approval.already_decided");
  });

  it("以后都允许 → tool_grants；可在 /me/tool-grants 列出与撤销", async () => {
    const a = await request();
    const res = await initiator.req({
      method: "POST",
      url: `${base()}/${a.id}/decision`,
      payload: { decision: "approve", scope: "always" },
    });
    expect(res.statusCode).toBe(200);
    const list = await initiator.req({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/me/tool-grants`,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { grants: unknown[] }).grants).toEqual([
      expect.objectContaining({
        agentId,
        agentName: "Writer",
        toolKey: "docs__create_doc",
        specHash: "hash-1",
      }),
    ]);
    // 别人看不到、删不掉
    const others = await other.req({ method: "GET", url: `/api/v1/orgs/${orgId}/me/tool-grants` });
    expect((others.json() as { grants: unknown[] }).grants).toEqual([]);
    await other.req({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/me/tool-grants/${agentId}/docs__create_doc`,
    });
    expect(await db.selectFrom("tool_grants").selectAll().execute()).toMatchObject([
      { tool_key: "docs__create_doc", spec_hash: "hash-1", app_id: appId },
    ]);

    const del = await initiator.reqB({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/me/tool-grants/${agentId}/docs__create_doc`,
    });
    expect(del.statusCode).toBe(204);
    expect(await db.selectFrom("tool_grants").selectAll().execute()).toEqual([]);
  });

  it("拒绝：不写授权，scope 为空", async () => {
    const a = await request();
    const res = await initiator.req({
      method: "POST",
      url: `${base()}/${a.id}/decision`,
      payload: { decision: "deny", scope: "always" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { approval: unknown }).approval).toMatchObject({
      status: "denied",
      scope: null,
    });
    expect(await db.selectFrom("tool_grants").selectAll().execute()).toEqual([]);
    const ev = (await eventsOf(db, conversationId)).find((e) => e.type === "approval_decided");
    expect(ev?.payload).toEqual({
      approvalId: a.id,
      callId: a.callId,
      decision: "denied",
      byAccountId: initiator.account.id,
    });
  });

  it("按角色升级的审批：admin 可批准（仅这一次）；session / always → 400", async () => {
    const a = await request({ requestedFor: null, approverRole: "admin" });
    const wide = await admin.req({
      method: "POST",
      url: `${base()}/${a.id}/decision`,
      payload: { decision: "approve", scope: "always" },
    });
    expect(wide.statusCode).toBe(400);
    expect(errCode(wide)).toBe("validation_failed");
    const member = await other.req({
      method: "POST",
      url: `${base()}/${a.id}/decision`,
      payload: { decision: "approve" },
    });
    expect(member.statusCode).toBe(404);
    const ok = await admin.req({
      method: "POST",
      url: `${base()}/${a.id}/decision`,
      payload: { decision: "approve" },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { approval: unknown }).approval).toMatchObject({
      status: "approved",
      scope: "once",
      decidedBy: admin.account.id,
    });
  });

  it("已过期 → 409 approval.already_decided，不写事件", async () => {
    const a = await request();
    await sql`UPDATE capybara.approvals SET expires_at = now() - interval '1 minute' WHERE id = ${a.id}`.execute(
      raw,
    );
    const res = await initiator.req({
      method: "POST",
      url: `${base()}/${a.id}/decision`,
      payload: { decision: "approve" },
    });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("approval.already_decided");
    expect(
      (await eventsOf(db, conversationId)).filter((e) => e.type === "approval_decided"),
    ).toEqual([]);
  });

  it("鉴权与校验：未登录 401；服务令牌 403；非成员 404；请求体非法 400；不存在 404", async () => {
    const a = await request();
    expect((await ka.http.inject({ method: "GET", url: base() })).statusCode).toBe(401);
    const { token } = await tokens.createService(orgId, {
      name: "bot",
      role: "admin",
      createdBy: owner.id,
    });
    const sv = await ka.http.inject({
      method: "POST",
      url: `${base()}/${a.id}/decision`,
      headers: { authorization: `Bearer ${token}` },
      payload: { decision: "approve" },
    });
    expect(sv.statusCode).toBe(403);
    await accounts.createLocal({ login: "stranger", password: PW, displayName: "S" });
    const stranger = await login("stranger");
    const nm = await stranger.req({ method: "GET", url: base() });
    expect(nm.statusCode).toBe(404);
    expect(errCode(nm)).toBe("org.not_found");
    const bad = await initiator.req({
      method: "POST",
      url: `${base()}/${a.id}/decision`,
      payload: { decision: "maybe" },
    });
    expect(bad.statusCode).toBe(400);
    expect(errCode(bad)).toBe("validation_failed");
    const missing = await initiator.req({
      method: "POST",
      url: `${base()}/nope/decision`,
      payload: { decision: "approve" },
    });
    expect(missing.statusCode).toBe(404);
    expect(errCode(missing)).toBe("approval.not_found");
  });
});

describe("Review Focus 1：两个副本并发处理同一审批", () => {
  it("一个批准、一个拒绝同时提交到不同副本：恰好一个成功、另一个 409；approval_decided 只有一条", async () => {
    for (let i = 0; i < 5; i++) {
      const a = await request();
      const [r1, r2] = await Promise.all([
        initiator.req({
          method: "POST",
          url: `${base()}/${a.id}/decision`,
          payload: { decision: "approve" },
        }),
        initiator.reqB({
          method: "POST",
          url: `${base()}/${a.id}/decision`,
          payload: { decision: "deny" },
        }),
      ]);
      const codes = [r1.statusCode, r2.statusCode].sort();
      expect(codes).toEqual([200, 409]);
      const loser = r1.statusCode === 409 ? r1 : r2;
      expect(errCode(loser)).toBe("approval.already_decided");
      const evs = (await eventsOf(db, conversationId)).filter(
        (e) =>
          e.type === "approval_decided" &&
          (e.payload as { approvalId: string }).approvalId === a.id,
      );
      expect(evs).toHaveLength(1);
      const winner = r1.statusCode === 200 ? "approved" : "denied";
      expect(evs[0]?.payload).toMatchObject({ decision: winner });
    }
  });

  it("onDecided 在提交后恰好调用一次（两个服务实例并发决定）", async () => {
    const calls: ApprovalRecord[] = [];
    const mk = (k: Kernel) =>
      new ApprovalsService({
        db,
        eventLog: k.runs.eventLog,
        config: () => k.config,
        log: createLogger("error", { write: () => {} }),
        onDecided: async (r) => {
          calls.push(r);
        },
      });
    const [s1, s2] = [mk(ka), mk(kb)];
    const a = await request();
    const results = await Promise.allSettled([
      s1.decide(orgId, a.id, initiator.account.id, { decision: "approve" }),
      s2.decide(orgId, a.id, initiator.account.id, { decision: "approve", scope: "session" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "approval.already_decided" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: a.id, status: "approved" });
  });
});
