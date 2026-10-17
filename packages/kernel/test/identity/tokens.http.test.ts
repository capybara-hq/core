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
import type { OrgRole } from "../../src/orgs/roles.js";
import { asUser, cookieJar } from "../helpers/http.js";

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
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      http: { port: 0 },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
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
  await sql`TRUNCATE capybara.accounts, capybara.orgs CASCADE`.execute(raw);
  await redis.flushdb();
  owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
  await accounts.createLocal({ login: "other", password: PW, displayName: "Other" });
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

type Req = ReturnType<typeof asUser>;

/** 登录并返回该用户的请求函数。 */
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

/** 新建一个账号，以给定角色加入组织，并登录。 */
async function memberAs(orgId: string, role: OrgRole, login: string) {
  const acc = await accounts.createLocal({ login, password: PW, displayName: login });
  await members.add(orgId, acc.id, role, owner.id);
  return { acc, req: await session(login) };
}

async function createOrg(req: Req, name = "Acme", slug = "acme"): Promise<string> {
  const res = await req({ method: "POST", url: "/api/v1/orgs", payload: { name, slug } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { org: { id: string } }).org.id;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const future = () => new Date(Date.now() + 3600_000).toISOString();

async function makePat(req: Req) {
  const res = await req({ method: "POST", url: "/api/v1/me/tokens", payload: { name: "cli" } });
  expect(res.statusCode).toBe(201);
  return res.json() as { token: string; record: { id: string } };
}

async function makeSvc(req: Req, orgId: string, role = "member") {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/service-tokens`,
    payload: { name: "ci", role },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { token: string; record: { id: string } };
}

describe("个人访问令牌", () => {
  it("会话创建 PAT：Bearer GET /me → via pat；列表不含明文", async () => {
    const req = await session("owner");
    const { token, record } = await makePat(req);
    expect(token.startsWith("cap_pat_")).toBe(true);
    const me = await k.http.inject({ method: "GET", url: "/api/v1/me", headers: bearer(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ via: "pat" });
    const list = await req({ method: "GET", url: "/api/v1/me/tokens" });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain("cap_pat_");
    expect(list.body).not.toContain("token_hash");
    expect((list.json() as { id: string }[])[0]?.id).toBe(record.id);
  });

  it("PAT 不能管理令牌（403 auth.session_required）", async () => {
    const { token } = await makePat(await session("owner"));
    for (const [method, url] of [
      ["POST", "/api/v1/me/tokens"],
      ["GET", "/api/v1/me/tokens"],
      ["DELETE", `/api/v1/me/tokens/${ZERO_UUID}`],
    ] as const) {
      const res = await k.http.inject({
        method,
        url,
        headers: bearer(token),
        ...(method === "POST" && { payload: { name: "x" } }),
      });
      expect(res.statusCode).toBe(403);
      expect(errCode(res)).toBe("auth.session_required");
    }
  });

  it("吊销后 PAT 401 auth.required；他人令牌 / 不存在 → 404", async () => {
    const req = await session("owner");
    const { token, record } = await makePat(req);
    const otherReq = await session("other");
    const miss = await otherReq({ method: "DELETE", url: `/api/v1/me/tokens/${record.id}` });
    expect(miss.statusCode).toBe(404);
    expect(errCode(miss)).toBe("token.not_found");
    const del = await req({ method: "DELETE", url: `/api/v1/me/tokens/${record.id}` });
    expect(del.statusCode).toBe(204);
    const me = await k.http.inject({ method: "GET", url: "/api/v1/me", headers: bearer(token) });
    expect(me.statusCode).toBe(401);
    expect(errCode(me)).toBe("auth.required");
  });

  it("expiresAt 为过去 / 非法 → 400 validation_failed；未来可用", async () => {
    const req = await session("owner");
    for (const expiresAt of [new Date(Date.now() - 1000).toISOString(), "nope"]) {
      const res = await req({
        method: "POST",
        url: "/api/v1/me/tokens",
        payload: { name: "x", expiresAt },
      });
      expect(res.statusCode).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
    const ok = await req({
      method: "POST",
      url: "/api/v1/me/tokens",
      payload: { name: "x", expiresAt: future() },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe("组织服务令牌", () => {
  it("member 服务令牌：读组织与成员 200；改成员 403；其他组织 404；/me、POST /orgs 403", async () => {
    const req = await session("owner");
    const id = await createOrg(req);
    const otherOrg = await createOrg(req, "Beta", "beta");
    const { token } = await makeSvc(req, id, "member");
    expect(token.startsWith("cap_svc_")).toBe(true);
    const h = bearer(token);
    const get = await k.http.inject({ method: "GET", url: `/api/v1/orgs/${id}`, headers: h });
    expect(get.statusCode).toBe(200);
    const mem = await k.http.inject({
      method: "GET",
      url: `/api/v1/orgs/${id}/members`,
      headers: h,
    });
    expect(mem.statusCode).toBe(200);
    const patch = await k.http.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${id}/members/${owner.id}`,
      headers: h,
      payload: { role: "member" },
    });
    expect(patch.statusCode).toBe(403);
    expect(errCode(patch)).toBe("forbidden");
    const foreign = await k.http.inject({
      method: "GET",
      url: `/api/v1/orgs/${otherOrg}`,
      headers: h,
    });
    expect(foreign.statusCode).toBe(404);
    expect(errCode(foreign)).toBe("org.not_found");
    const me = await k.http.inject({ method: "GET", url: "/api/v1/me", headers: h });
    expect(me.statusCode).toBe(403);
    expect(errCode(me)).toBe("forbidden");
    const create = await k.http.inject({
      method: "POST",
      url: "/api/v1/orgs",
      headers: h,
      payload: { name: "X" },
    });
    expect(create.statusCode).toBe(403);
    const mgmt = await k.http.inject({
      method: "GET",
      url: `/api/v1/orgs/${id}/service-tokens`,
      headers: h,
    });
    expect(mgmt.statusCode).toBe(403);
    expect(errCode(mgmt)).toBe("forbidden");
  });

  it("吊销后 401；组织软删除后 401；列表不含明文", async () => {
    const req = await session("owner");
    const id = await createOrg(req);
    const a = await makeSvc(req, id);
    const b = await makeSvc(req, id);
    const list = await req({ method: "GET", url: `/api/v1/orgs/${id}/service-tokens` });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain("cap_svc_");
    expect((list.json() as unknown[]).length).toBe(2);
    const del = await req({
      method: "DELETE",
      url: `/api/v1/orgs/${id}/service-tokens/${a.record.id}`,
    });
    expect(del.statusCode).toBe(204);
    const again = await req({
      method: "DELETE",
      url: `/api/v1/orgs/${id}/service-tokens/${a.record.id}`,
    });
    expect(again.statusCode).toBe(404);
    const url = `/api/v1/orgs/${id}`;
    expect((await k.http.inject({ method: "GET", url, headers: bearer(a.token) })).statusCode).toBe(
      401,
    );
    expect((await k.http.inject({ method: "GET", url, headers: bearer(b.token) })).statusCode).toBe(
      200,
    );
    expect((await req({ method: "DELETE", url })).statusCode).toBe(204);
    expect((await k.http.inject({ method: "GET", url, headers: bearer(b.token) })).statusCode).toBe(
      401,
    );
  });

  it("admin 可建 admin/member/guest；member 创建 → 403；非成员 → 404", async () => {
    const id = await createOrg(await session("owner"));
    const { req: adminReq } = await memberAs(id, "admin", "ada");
    for (const role of ["admin", "member", "guest"]) await makeSvc(adminReq, id, role);
    const { req: memReq } = await memberAs(id, "member", "mia");
    const res = await memReq({
      method: "POST",
      url: `/api/v1/orgs/${id}/service-tokens`,
      payload: { name: "x", role: "guest" },
    });
    expect(res.statusCode).toBe(403);
    const otherReq = await session("other");
    const no = await otherReq({
      method: "POST",
      url: `/api/v1/orgs/${id}/service-tokens`,
      payload: { name: "x", role: "guest" },
    });
    expect(no.statusCode).toBe(404);
    const bad = await adminReq({
      method: "POST",
      url: `/api/v1/orgs/${id}/service-tokens`,
      payload: { name: "x", role: "owner" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("创建时实时重读角色：OrgGuard 之后被降级的发起人 → 403，不创建令牌", async () => {
    const id = await createOrg(await session("owner"));
    const { acc } = await memberAs(id, "admin", "ada");
    await members.changeRole(id, acc.id, "member", owner.id);
    await expect(
      tokens.createServiceAs(id, acc.id, { name: "x", role: "guest" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await tokens.list({ orgId: id })).toHaveLength(0);
  });

  it("审计 created / revoked，detail 不含令牌", async () => {
    const req = await session("owner");
    const id = await createOrg(req);
    const { token, record } = await makeSvc(req, id, "guest");
    await req({ method: "DELETE", url: `/api/v1/orgs/${id}/service-tokens/${record.id}` });
    const rows = await sql<{ action: string; target: string; detail: unknown }>`
      SELECT action, target, detail FROM capybara.audit_events
      WHERE org_id = ${id} AND action LIKE 'org.service_token.%' ORDER BY id`.execute(raw);
    expect(rows.rows.map((r) => r.action)).toEqual([
      "org.service_token.created",
      "org.service_token.revoked",
    ]);
    expect(rows.rows.every((r) => r.target === record.id)).toBe(true);
    expect(JSON.stringify(rows.rows)).not.toContain(token);
  });
});
