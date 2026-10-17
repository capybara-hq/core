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
let other: Account;

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
  other = await accounts.createLocal({ login: "other", password: PW, displayName: "Other" });
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
  const body = res.json() as { org: { id: string; slug: string }; role: string };
  expect(body.role).toBe("owner");
  expect(body.org.slug).toBe(slug);
  return body.org.id;
}

describe("组织 HTTP", () => {
  it("POST /orgs → 201；GET /orgs 列出所属组织与角色；GET /me 带 memberships", async () => {
    const req = await session("owner");
    const id = await createOrg(req);
    const list = await req({ method: "GET", url: "/api/v1/orgs" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      orgs: [{ id, slug: "acme", name: "Acme", role: "owner" }],
    });
    const me = await req({ method: "GET", url: "/api/v1/me" });
    expect(me.json()).toMatchObject({
      memberships: [{ orgId: id, slug: "acme", name: "Acme", role: "owner" }],
    });
  });

  it("guest 能 GET /orgs/:id、不能 GET /members（403 forbidden）", async () => {
    const id = await createOrg(await session("owner"));
    const { req } = await memberAs(id, "guest", "gina");
    const get = await req({ method: "GET", url: `/api/v1/orgs/${id}` });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ org: { id }, role: "guest" });
    const mem = await req({ method: "GET", url: `/api/v1/orgs/${id}/members` });
    expect(mem.statusCode).toBe(403);
    expect(errCode(mem)).toBe("forbidden");
  });

  it("member 能看成员、不能改角色（403）；owner 能改", async () => {
    const ownerReq = await session("owner");
    const id = await createOrg(ownerReq);
    const { req, acc } = await memberAs(id, "member", "mia");
    const mem = await req({ method: "GET", url: `/api/v1/orgs/${id}/members` });
    expect(mem.statusCode).toBe(200);
    expect((mem.json() as { members: unknown[] }).members.length).toBe(2);
    const patch = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${id}/members/${acc.id}`,
      payload: { role: "admin" },
    });
    expect(patch.statusCode).toBe(403);
    expect(errCode(patch)).toBe("forbidden");
    const ok = await ownerReq({
      method: "PATCH",
      url: `/api/v1/orgs/${id}/members/${acc.id}`,
      payload: { role: "admin" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("非成员访问 → 404 org.not_found，与不存在的组织 ID 响应体相同", async () => {
    const id = await createOrg(await session("owner"));
    const req = await session("other");
    const a = await req({ method: "GET", url: `/api/v1/orgs/${id}` });
    const b = await req({ method: "GET", url: `/api/v1/orgs/${ZERO_UUID}` });
    expect(a.statusCode).toBe(404);
    expect(errCode(a)).toBe("org.not_found");
    expect(a.body).toBe(b.body);
    expect(b.statusCode).toBe(404);
  });

  it("软删除的组织 → 404；DELETE 需要 owner", async () => {
    const ownerReq = await session("owner");
    const id = await createOrg(ownerReq);
    const { req: adminReq } = await memberAs(id, "admin", "adam");
    const denied = await adminReq({ method: "DELETE", url: `/api/v1/orgs/${id}` });
    expect(denied.statusCode).toBe(403);
    const del = await ownerReq({ method: "DELETE", url: `/api/v1/orgs/${id}` });
    expect(del.statusCode).toBe(204);
    const get = await ownerReq({ method: "GET", url: `/api/v1/orgs/${id}` });
    expect(get.statusCode).toBe(404);
    expect(errCode(get)).toBe("org.not_found");
  });

  it("PUT /me/current-org：成员组织 → 204 并反映在 GET /me；非成员组织 → 404；null 清空", async () => {
    const ownerReq = await session("owner");
    const id = await createOrg(ownerReq);
    const set = await ownerReq({
      method: "PUT",
      url: "/api/v1/me/current-org",
      payload: { orgId: id },
    });
    expect(set.statusCode).toBe(204);
    expect((await ownerReq({ method: "GET", url: "/api/v1/me" })).json()).toMatchObject({
      currentOrgId: id,
    });
    const otherReq = await session("other");
    const bad = await otherReq({
      method: "PUT",
      url: "/api/v1/me/current-org",
      payload: { orgId: id },
    });
    expect(bad.statusCode).toBe(404);
    expect(errCode(bad)).toBe("org.not_found");
    const clear = await ownerReq({
      method: "PUT",
      url: "/api/v1/me/current-org",
      payload: { orgId: null },
    });
    expect(clear.statusCode).toBe(204);
    expect((await ownerReq({ method: "GET", url: "/api/v1/me" })).json()).toMatchObject({
      currentOrgId: null,
    });
  });

  it("被移出组织后其 current_org_id 为 null，且 GET /orgs/:id 立即 404（每请求实时判定）", async () => {
    const ownerReq = await session("owner");
    const id = await createOrg(ownerReq);
    const { req, acc } = await memberAs(id, "member", "mia");
    await req({ method: "PUT", url: "/api/v1/me/current-org", payload: { orgId: id } });
    expect((await req({ method: "GET", url: `/api/v1/orgs/${id}` })).statusCode).toBe(200);
    const rm = await ownerReq({ method: "DELETE", url: `/api/v1/orgs/${id}/members/${acc.id}` });
    expect(rm.statusCode).toBe(204);
    expect((await req({ method: "GET", url: "/api/v1/me" })).json()).toMatchObject({
      currentOrgId: null,
    });
    const get = await req({ method: "GET", url: `/api/v1/orgs/${id}` });
    expect(get.statusCode).toBe(404);
    expect(errCode(get)).toBe("org.not_found");
  });

  it("current-org 与并发移出成员 50 轮：会话的 current_org_id 不指向已移出的组织", async () => {
    const ownerReq = await session("owner");
    const id = await createOrg(ownerReq);
    const { req, acc } = await memberAs(id, "member", "racer");
    const sess = await db
      .selectFrom("sessions")
      .select("id")
      .where("account_id", "=", acc.id)
      .executeTakeFirstOrThrow();
    const poolB = createDb(pgc.url, 3);
    try {
      const membersB = new MembersService(kernelDb(poolB));
      for (let i = 0; i < 50; i++) {
        await db
          .deleteFrom("memberships")
          .where("org_id", "=", id)
          .where("account_id", "=", acc.id)
          .execute();
        await members.add(id, acc.id, "member", owner.id);
        await db
          .updateTable("sessions")
          .set({ current_org_id: null })
          .where("id", "=", sess.id)
          .execute();
        const [, set] = await Promise.all([
          membersB.remove(id, acc.id, owner.id),
          req({ method: "PUT", url: "/api/v1/me/current-org", payload: { orgId: id } }),
        ]);
        expect([204, 404]).toContain(set.statusCode);
        const row = await db
          .selectFrom("sessions")
          .select("current_org_id")
          .where("id", "=", sess.id)
          .executeTakeFirstOrThrow();
        expect(row.current_org_id).toBeNull();
      }
    } finally {
      await poolB.destroy();
    }
  });

  it("服务令牌（member）对另一组织调用 HUMAN_ONLY 路由 → 404 org.not_found", async () => {
    const ownerReq = await session("owner");
    const a = await createOrg(ownerReq);
    const b = await createOrg(ownerReq, "Beta", "beta");
    const { token } = await tokens.createService(a, {
      name: "ci",
      role: "member",
      createdBy: owner.id,
    });
    const res = await k.http.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${b}/members/x`,
      headers: { authorization: `Bearer ${token}` },
      payload: { role: "guest" },
    });
    expect(res.statusCode).toBe(404);
    expect(errCode(res)).toBe("org.not_found");
  });

  it("已软删除组织与不存在组织的 404 响应逐字节相同", async () => {
    const ownerReq = await session("owner");
    const id = await createOrg(ownerReq);
    expect((await ownerReq({ method: "DELETE", url: `/api/v1/orgs/${id}` })).statusCode).toBe(204);
    const gone = await ownerReq({ method: "GET", url: `/api/v1/orgs/${id}` });
    const none = await ownerReq({ method: "GET", url: `/api/v1/orgs/${ZERO_UUID}` });
    expect(gone.statusCode).toBe(404);
    expect(gone.body).toBe(none.body);
    expect(gone.headers["content-length"]).toBe(none.headers["content-length"]);
  });

  it("admin 自降为 member 成功，审计里有记录", async () => {
    const ownerReq = await session("owner");
    const id = await createOrg(ownerReq);
    const { req, acc } = await memberAs(id, "admin", "adam");
    const res = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${id}/members/${acc.id}`,
      payload: { role: "member" },
    });
    expect(res.statusCode).toBe(200);
    const row = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "target", "detail"])
      .where("action", "=", "org.member.role_changed")
      .where("target", "=", acc.id)
      .executeTakeFirstOrThrow();
    expect(row.actor_account_id).toBe(acc.id);
    expect(row.detail).toMatchObject({ from: "admin", to: "member" });
    const get = await req({ method: "GET", url: `/api/v1/orgs/${id}` });
    expect(get.json()).toMatchObject({ role: "member" });
  });

  it("leave 与 transfer", async () => {
    const ownerReq = await session("owner");
    const id = await createOrg(ownerReq);
    const { req, acc } = await memberAs(id, "member", "mia");
    const last = await ownerReq({ method: "POST", url: `/api/v1/orgs/${id}/leave` });
    expect(last.statusCode).toBe(409);
    expect(errCode(last)).toBe("org.last_owner");
    const tr = await ownerReq({
      method: "POST",
      url: `/api/v1/orgs/${id}/transfer`,
      payload: { toAccountId: acc.id },
    });
    expect(tr.statusCode).toBe(204);
    expect((await req({ method: "GET", url: `/api/v1/orgs/${id}` })).json()).toMatchObject({
      role: "owner",
    });
    const left = await ownerReq({ method: "POST", url: `/api/v1/orgs/${id}/leave` });
    expect(left.statusCode).toBe(204);
  });

  it("服务令牌：本组织 org.read 可用；HUMAN_ONLY → 403；他组织 → 404；POST /orgs → 403", async () => {
    const ownerReq = await session("owner");
    const id = await createOrg(ownerReq);
    const id2 = await createOrg(ownerReq, "Beta", "beta");
    const { token } = await tokens.createService(id, {
      name: "ci",
      role: "admin",
      createdBy: owner.id,
    });
    const headers = { authorization: `Bearer ${token}` };
    const get = await k.http.inject({ method: "GET", url: `/api/v1/orgs/${id}`, headers });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ role: "admin" });
    const mem = await k.http.inject({ method: "GET", url: `/api/v1/orgs/${id}/members`, headers });
    expect(mem.statusCode).toBe(200);
    const patch = await k.http.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${id}`,
      headers,
      payload: { name: "X" },
    });
    expect(patch.statusCode).toBe(403);
    expect(errCode(patch)).toBe("forbidden");
    const foreign = await k.http.inject({ method: "GET", url: `/api/v1/orgs/${id2}`, headers });
    expect(foreign.statusCode).toBe(404);
    expect(errCode(foreign)).toBe("org.not_found");
    const create = await k.http.inject({
      method: "POST",
      url: "/api/v1/orgs",
      headers,
      payload: { name: "Z" },
    });
    expect(create.statusCode).toBe(403);
    expect(errCode(create)).toBe("forbidden");
  });

  it("PATCH /orgs/:id 改名（admin）", async () => {
    const id = await createOrg(await session("owner"));
    const { req } = await memberAs(id, "admin", "adam");
    const res = await req({ method: "PATCH", url: `/api/v1/orgs/${id}`, payload: { name: "New" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ org: { id, name: "New", slug: "acme" } });
  });

  it("个人令牌发起的组织写操作在审计里记 actor_token_id；Web 会话发起的为 null", async () => {
    const req = await session("owner");
    const id = await createOrg(req);
    const { token, record } = await tokens.createPersonal(owner.id, { name: "cli" });
    const res = await k.http.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Via PAT" },
    });
    expect(res.statusCode).toBe(200);
    expect(
      (await req({ method: "PATCH", url: `/api/v1/orgs/${id}`, payload: { name: "Via web" } }))
        .statusCode,
    ).toBe(200);
    const ev = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "actor_token_id", "detail"])
      .where("org_id", "=", id)
      .where("action", "=", "org.updated")
      .orderBy("id")
      .execute();
    expect(ev.map((e) => [e.actor_account_id, e.actor_token_id])).toEqual([
      [owner.id, record.id],
      [owner.id, null],
    ]);
  });

  it("不相关的用户不能通过任何组织路由改动别人的组织", async () => {
    const id = await createOrg(await session("owner"));
    const req = await session("other");
    const res = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${id}/members/${owner.id}`,
      payload: { role: "guest" },
    });
    expect(res.statusCode).toBe(404);
    expect(other.id).toBeDefined();
  });
});
