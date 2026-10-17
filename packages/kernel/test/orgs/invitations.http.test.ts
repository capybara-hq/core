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
import { asUser, cookieJar, setCookies } from "../helpers/http.js";

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

async function memberAs(orgId: string, role: OrgRole, login: string) {
  const acc = await accounts.createLocal({ login, password: PW, displayName: login });
  await members.add(orgId, acc.id, role, owner.id);
  return { acc, req: await session(login) };
}

async function setup(): Promise<{ ownerReq: Req; orgId: string }> {
  const ownerReq = await session("owner");
  const res = await ownerReq({
    method: "POST",
    url: "/api/v1/orgs",
    payload: { name: "Acme", slug: "acme" },
  });
  expect(res.statusCode).toBe(201);
  return { ownerReq, orgId: (res.json() as { org: { id: string } }).org.id };
}

async function invite(req: Req, orgId: string, role = "member"): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/invitations`,
    payload: { role },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { token: string }).token;
}

/** 未登录的请求（带 CSRF 头）。 */
const anon = (opts: Parameters<Req>[0]) => asUser(k.http, cookieJar())(opts);

describe("邀请 HTTP", () => {
  it("owner 创建 → 201 { invitation, token }；GET 列出（不含令牌）；DELETE → 204", async () => {
    const { ownerReq, orgId } = await setup();
    const res = await ownerReq({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/invitations`,
      payload: { role: "admin", expiresInHours: 24 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { invitation: { id: string; role: string }; token: string };
    expect(body.invitation.role).toBe("admin");
    expect(body.token).toMatch(/^cap_inv_/);
    const list = await ownerReq({ method: "GET", url: `/api/v1/orgs/${orgId}/invitations` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      invitations: [{ id: body.invitation.id, status: "pending", role: "admin" }],
    });
    expect(list.body).not.toContain(body.token);
    expect(list.body).not.toContain("token_hash");
    const del = await ownerReq({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/invitations/${body.invitation.id}`,
    });
    expect(del.statusCode).toBe(204);
    const after = await ownerReq({ method: "GET", url: `/api/v1/orgs/${orgId}/invitations` });
    expect(after.json()).toMatchObject({ invitations: [{ status: "revoked" }] });
  });

  it("member 没有 org.invitations.manage → 403；admin 邀 owner → 400 validation_failed；admin 邀 admin → 201", async () => {
    const { orgId } = await setup();
    const { req: memberReq } = await memberAs(orgId, "member", "mia");
    const denied = await memberReq({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/invitations`,
      payload: { role: "guest" },
    });
    expect(denied.statusCode).toBe(403);
    expect(errCode(denied)).toBe("forbidden");
    const { req: adminReq } = await memberAs(orgId, "admin", "ada");
    const owner = await adminReq({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/invitations`,
      payload: { role: "owner" },
    });
    expect(owner.statusCode).toBe(400);
    expect(errCode(owner)).toBe("validation_failed");
    await invite(adminReq, orgId, "admin");
  });

  it("GET /invitations/:token 公开预览，不含令牌 hash 或创建者 ID；随机令牌 → 404 invitation.invalid", async () => {
    const { ownerReq, orgId } = await setup();
    const token = await invite(ownerReq, orgId, "guest");
    const res = await k.http.inject({ method: "GET", url: `/api/v1/invitations/${token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ org: { id: orgId, name: "Acme" }, role: "guest" });
    expect(typeof body.expiresAt).toBe("string");
    expect(res.body).not.toContain(owner.id);
    expect(res.body).not.toMatch(/hash|createdBy|created_by/i);
    const bad = await k.http.inject({ method: "GET", url: "/api/v1/invitations/cap_inv_nope" });
    expect(bad.statusCode).toBe(404);
    expect(errCode(bad)).toBe("invitation.invalid");
  });

  it("已登录用户接受（空 body）→ 200 并成为成员；再接受 → 409 invitation.used", async () => {
    const { ownerReq, orgId } = await setup();
    const token = await invite(ownerReq, orgId, "member");
    await accounts.createLocal({ login: "bob", password: PW, displayName: "Bob" });
    const bob = await session("bob");
    const res = await bob({ method: "POST", url: `/api/v1/invitations/${token}/accept` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orgId, role: "member", account: { displayName: "Bob" } });
    const me = await bob({ method: "GET", url: "/api/v1/me" });
    expect(me.json()).toMatchObject({ memberships: [{ orgId, role: "member" }] });
    const again = await bob({ method: "POST", url: `/api/v1/invitations/${token}/accept` });
    expect(again.statusCode).toBe(409);
    expect(errCode(again)).toBe("invitation.used");
  });

  it("未登录且无 body → 400 validation_failed；未带 CSRF 头 → 403 auth.csrf", async () => {
    const { ownerReq, orgId } = await setup();
    const token = await invite(ownerReq, orgId);
    const res = await anon({ method: "POST", url: `/api/v1/invitations/${token}/accept` });
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe("validation_failed");
    const noCsrf = await k.http.inject({
      method: "POST",
      url: `/api/v1/invitations/${token}/accept`,
      payload: { login: "newbie", password: PW, displayName: "N" },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(errCode(noCsrf)).toBe("auth.csrf");
  });

  it("signup 接受 → 200 带 cap_at / cap_rt Cookie；随后 GET /me 的 memberships 含该组织", async () => {
    const { ownerReq, orgId } = await setup();
    const token = await invite(ownerReq, orgId, "guest");
    const req = asUser(k.http, cookieJar());
    const res = await req({
      method: "POST",
      url: `/api/v1/invitations/${token}/accept`,
      payload: { login: "newbie", password: "a brand new pass", displayName: "Newbie" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orgId, role: "guest", account: { displayName: "Newbie" } });
    const names = setCookies(res).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["cap_at", "cap_rt"]));
    const me = await req({ method: "GET", url: "/api/v1/me" });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ memberships: [{ orgId, role: "guest" }] });
    const login = await anon({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { login: "newbie", password: "a brand new pass" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("服务令牌接受 → 403 forbidden；服务令牌管理邀请 → 403", async () => {
    const { ownerReq, orgId } = await setup();
    const token = await invite(ownerReq, orgId);
    const { token: svc } = await tokens.createService(orgId, {
      name: "ci",
      role: "admin",
      createdBy: owner.id,
    });
    const headers = { authorization: `Bearer ${svc}`, "x-capybara-csrf": "1" };
    const res = await k.http.inject({
      method: "POST",
      url: `/api/v1/invitations/${token}/accept`,
      headers,
    });
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("forbidden");
    const create = await k.http.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/invitations`,
      headers,
      payload: { role: "guest" },
    });
    expect(create.statusCode).toBe(403);
  });

  it("过期 → 410 invitation.expired", async () => {
    const { ownerReq, orgId } = await setup();
    const token = await invite(ownerReq, orgId);
    await db
      .updateTable("invitations")
      .set({ expires_at: sql<Date>`now() - interval '1 second'` })
      .execute();
    const res = await k.http.inject({ method: "GET", url: `/api/v1/invitations/${token}` });
    expect(res.statusCode).toBe(410);
    expect(errCode(res)).toBe("invitation.expired");
  });
});
