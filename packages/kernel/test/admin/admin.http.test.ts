import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { type Account, AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { SettingsService } from "../../src/identity/settings.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { OrgsService } from "../../src/orgs/orgs.service.js";
import { asUser, cookieJar, setCookies } from "../helpers/http.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let accounts: AccountsService;
let tokens: ApiTokenService;
let orgs: OrgsService;

const PW = "correct horse battery";
const SETUP_TOKEN = "setup-token-0123456789";

const config = (over: Record<string, unknown> = {}): KernelConfig =>
  KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 5 },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    http: { port: 0 },
    ...over,
  });

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(config({ auth: { setupToken: SETUP_TOKEN } }), {
    env: {},
    logger: createLogger("error", { write: () => {} }),
  });
  await k.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = new AccountsService(db);
  tokens = new ApiTokenService(db);
  orgs = new OrgsService(db, new SettingsService(db), tokens);
}, 120_000);
afterAll(async () => {
  await k?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await sql`TRUNCATE capybara.accounts, capybara.orgs, capybara.deployment_settings, capybara.audit_events CASCADE`.execute(
    raw,
  );
  await redis.flushdb();
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

const setupBody = (over: Record<string, unknown> = {}) => ({
  login: "root",
  password: PW,
  displayName: "Root",
  ...over,
});

describe("初始化向导（配置了 auth.setupToken）", () => {
  it("缺 / 错 token → 403 setup.token_invalid 且仍需初始化；正确 token → 201 带会话 Cookie，/me 为企业管理员", async () => {
    const anon = asUser(k.http, cookieJar());
    const status = await anon({ method: "GET", url: "/api/v1/setup" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ needsSetup: true });

    const missing = await anon({ method: "POST", url: "/api/v1/setup", payload: setupBody() });
    expect(missing.statusCode).toBe(403);
    expect(errCode(missing)).toBe("setup.token_invalid");
    for (const setupToken of ["wrong", `${SETUP_TOKEN}x`, ""]) {
      const wrong = await anon({
        method: "POST",
        url: "/api/v1/setup",
        payload: setupBody({ setupToken }),
      });
      expect(wrong.statusCode).toBe(403);
      expect(errCode(wrong)).toBe("setup.token_invalid");
    }
    expect((await anon({ method: "GET", url: "/api/v1/setup" })).json()).toEqual({
      needsSetup: true,
    });

    const jar = cookieJar();
    const req = asUser(k.http, jar);
    const ok = await req({
      method: "POST",
      url: "/api/v1/setup",
      payload: setupBody({ setupToken: SETUP_TOKEN, orgName: "Acme" }),
    });
    expect(ok.statusCode).toBe(201);
    const body = ok.json() as { account: Account; org?: { name: string } };
    expect(body.account.isEnterpriseAdmin).toBe(true);
    expect(body.org?.name).toBe("Acme");
    expect(setCookies(ok).map((c) => c.name)).toEqual(expect.arrayContaining(["cap_at", "cap_rt"]));
    const me = await req({ method: "GET", url: "/api/v1/me" });
    expect(me.statusCode).toBe(200);
    const meBody = me.json() as { account: Account; memberships: { role: string }[] };
    expect(meBody.account.isEnterpriseAdmin).toBe(true);
    expect(meBody.memberships.map((m) => m.role)).toEqual(["owner"]);

    expect((await anon({ method: "GET", url: "/api/v1/setup" })).json()).toEqual({
      needsSetup: false,
    });
    const again = await anon({
      method: "POST",
      url: "/api/v1/setup",
      payload: setupBody({ login: "root2", setupToken: SETUP_TOKEN }),
    });
    expect(again.statusCode).toBe(409);
    expect(errCode(again)).toBe("setup.already_completed");
  });

  it("配置了 setupToken 时，错误令牌 20 次 → 429 auth.rate_limited", async () => {
    const codes: string[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await asUser(
        k.http,
        cookieJar(),
      )({
        method: "POST",
        url: "/api/v1/setup",
        payload: setupBody({ setupToken: `wrong-${i}` }),
      });
      codes.push(errCode(res) ?? String(res.statusCode));
    }
    expect(codes.slice(0, 10).every((c) => c === "setup.token_invalid")).toBe(true);
    expect(codes.at(-1)).toBe("auth.rate_limited");
    // 超限后正确令牌同样被拒（窗口内）
    const ok = await asUser(
      k.http,
      cookieJar(),
    )({
      method: "POST",
      url: "/api/v1/setup",
      payload: setupBody({ setupToken: SETUP_TOKEN }),
    });
    expect(ok.statusCode).toBe(429);
  });

  it("POST /setup 缺 CSRF 头 → 403 auth.csrf", async () => {
    const res = await k.http.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: setupBody({ setupToken: SETUP_TOKEN }),
    });
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("auth.csrf");
  });

  it("连接池只有 2 个连接时并发 POST /setup（带 orgName）：一个 201、其余 409，不会耗尽连接池卡死", async () => {
    const k2 = await createKernel(config({ db: { url: pgc.url, poolMax: 2 } }), {
      env: {},
      logger: createLogger("error", { write: () => {} }),
    });
    await k2.start();
    try {
      const run = Promise.all(
        [0, 1, 2, 3].map((i) =>
          asUser(
            k2.http,
            cookieJar(),
          )({
            method: "POST",
            url: "/api/v1/setup",
            payload: setupBody({ login: `root${i}`, orgName: `Acme ${i}` }),
          }),
        ),
      );
      const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("concurrent setup timed out")), 8000),
      );
      const results = await Promise.race([run, timeout]);
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([201, 409, 409, 409]);
    } finally {
      await k2.stop();
    }
  }, 20_000);
});

describe("企业管理员端点", () => {
  let admin: Account;
  let user: Account;

  beforeEach(async () => {
    admin = await accounts.createLocal({
      login: "admin",
      password: PW,
      displayName: "Admin",
      enterpriseAdmin: true,
    });
    user = await accounts.createLocal({ login: "user", password: PW, displayName: "User" });
  });

  const ADMIN_ROUTES = [
    { method: "GET", url: "/api/v1/admin/accounts" },
    { method: "POST", url: "/api/v1/admin/accounts" },
    { method: "PATCH", url: "/api/v1/admin/accounts/00000000-0000-0000-0000-000000000000" },
    { method: "GET", url: "/api/v1/admin/orgs" },
    { method: "GET", url: "/api/v1/admin/settings" },
    { method: "PUT", url: "/api/v1/admin/settings" },
  ] as const;

  it("普通用户访问 /admin/* → 403 forbidden", async () => {
    const req = await session("user");
    for (const r of ADMIN_ROUTES) {
      const res = await req({ ...r, payload: {} });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      expect(errCode(res)).toBe("forbidden");
    }
  });

  it("service 令牌访问 /admin/* → 403；企业管理员的 PAT 可以访问", async () => {
    const org = await orgs.create({ name: "Svc Org" }, admin);
    const { token } = await tokens.createService(org.id, {
      name: "svc",
      role: "admin",
      createdBy: admin.id,
    });
    for (const r of ADMIN_ROUTES) {
      const res = await k.http.inject({
        ...r,
        payload: {},
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      expect(errCode(res)).toBe("forbidden");
    }
    const pat = await tokens.createPersonal(admin.id, { name: "automation" });
    const res = await k.http.inject({
      method: "GET",
      url: "/api/v1/admin/accounts",
      headers: { authorization: `Bearer ${pat.token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /admin/accounts 分页；POST /admin/accounts 建账号（登录名重复 → 409）", async () => {
    const req = await session("admin");
    const created = await req({
      method: "POST",
      url: "/api/v1/admin/accounts",
      payload: {
        login: "carol",
        password: PW,
        displayName: "Carol",
        email: "carol@example.com",
        enterpriseAdmin: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const carol = (created.json() as { account: Account }).account;
    expect(carol.isEnterpriseAdmin).toBe(true);
    expect(carol.email).toBe("carol@example.com");
    const dup = await req({
      method: "POST",
      url: "/api/v1/admin/accounts",
      payload: { login: "Carol", password: PW, displayName: "C2" },
    });
    expect(dup.statusCode).toBe(409);
    expect(errCode(dup)).toBe("account.login_taken");

    const all = [admin.id, user.id, carol.id].sort();
    const p1 = await req({ method: "GET", url: "/api/v1/admin/accounts?limit=2" });
    expect(p1.statusCode).toBe(200);
    const ids1 = (p1.json() as { accounts: Account[] }).accounts.map((a) => a.id);
    expect(ids1).toEqual(all.slice(0, 2));
    const p2 = await req({
      method: "GET",
      url: `/api/v1/admin/accounts?limit=2&after=${ids1[1]}`,
    });
    expect((p2.json() as { accounts: Account[] }).accounts.map((a) => a.id)).toEqual(all.slice(2));
    const bad = await req({ method: "GET", url: "/api/v1/admin/accounts?limit=0" });
    expect(bad.statusCode).toBe(400);
  });

  it("GET /admin/accounts 返回 next 游标：limit=1 时 next 非空，用它取到下一个账号；最后一页 next 为 null", async () => {
    const req = await session("admin");
    const all = [admin.id, user.id].sort();
    const p1 = await req({ method: "GET", url: "/api/v1/admin/accounts?limit=1" });
    const b1 = p1.json() as { accounts: Account[]; next: string | null };
    expect(b1.accounts.map((a) => a.id)).toEqual([all[0]]);
    expect(b1.next).not.toBeNull();
    const p2 = await req({
      method: "GET",
      url: `/api/v1/admin/accounts?limit=1&after=${b1.next}`,
    });
    const b2 = p2.json() as { accounts: Account[]; next: string | null };
    expect(b2.accounts.map((a) => a.id)).toEqual([all[1]]);
    expect(b2.next).toBeNull();
  });

  it("停用账号：鉴权实时读状态，未吊销的 cap_at 与 PAT 均立即 403 auth.account_disabled", async () => {
    const userReq = await session("user");
    const pat = await tokens.createPersonal(user.id, { name: "cli" });
    // 绕过管理端点直接改状态（不吊销凭据），只验证守卫每请求实时读账号状态
    await accounts.update(user.id, { status: "disabled" }, admin.id);
    const viaCookie = await userReq({ method: "GET", url: "/api/v1/me" });
    expect(viaCookie.statusCode).toBe(403);
    expect(errCode(viaCookie)).toBe("auth.account_disabled");
    const viaPat = await k.http.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${pat.token}` },
    });
    expect(viaPat.statusCode).toBe(403);
    expect(errCode(viaPat)).toBe("auth.account_disabled");
  });

  it("PATCH 停用账号后该账号的 cap_at 与 PAT 立即失效并被吊销，重新启用后也不复活", async () => {
    const adminReq = await session("admin");
    const userReq = await session("user");
    const pat = await tokens.createPersonal(user.id, { name: "cli" });
    const patGet = () =>
      k.http.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${pat.token}` },
      });
    expect((await userReq({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(200);
    expect((await patGet()).statusCode).toBe(200);

    const off = await adminReq({
      method: "PATCH",
      url: `/api/v1/admin/accounts/${user.id}`,
      payload: { status: "disabled" },
    });
    expect(off.statusCode).toBe(200);
    expect((off.json() as { account: Account }).account.status).toBe("disabled");

    // 会话与 PAT 已吊销：吊销检查先于账号状态检查，所以是 401 而不是 403
    const viaCookie = await userReq({ method: "GET", url: "/api/v1/me" });
    expect(viaCookie.statusCode).toBe(401);
    expect(errCode(viaCookie)).toBe("auth.session_revoked");
    const viaPat = await patGet();
    expect(viaPat.statusCode).toBe(401);
    expect(errCode(viaPat)).toBe("auth.required");

    const on = await adminReq({
      method: "PATCH",
      url: `/api/v1/admin/accounts/${user.id}`,
      payload: { status: "active" },
    });
    expect(on.statusCode).toBe(200);
    expect((await userReq({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(401);
    expect((await patGet()).statusCode).toBe(401);
  });

  it("把唯一企业管理员降级 → 409 account.last_enterprise_admin", async () => {
    const req = await session("admin");
    const res = await req({
      method: "PATCH",
      url: `/api/v1/admin/accounts/${admin.id}`,
      payload: { isEnterpriseAdmin: false },
    });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("account.last_enterprise_admin");
    const missing = await req({
      method: "PATCH",
      url: "/api/v1/admin/accounts/00000000-0000-0000-0000-000000000000",
      payload: { displayName: "X" },
    });
    expect(missing.statusCode).toBe(404);
    expect(errCode(missing)).toBe("account.not_found");
  });

  it("PUT /admin/settings { orgCreation: enterprise_admin } 后普通用户 POST /orgs → 403 org.creation_disabled", async () => {
    const adminReq = await session("admin");
    const userReq = await session("user");
    expect((await adminReq({ method: "GET", url: "/api/v1/admin/settings" })).json()).toEqual({
      orgCreation: "anyone",
      runConcurrencyOverrides: {},
    });
    const put = await adminReq({
      method: "PUT",
      url: "/api/v1/admin/settings",
      payload: { orgCreation: "enterprise_admin" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({
      orgCreation: "enterprise_admin",
      runConcurrencyOverrides: {},
    });
    const bad = await adminReq({
      method: "PUT",
      url: "/api/v1/admin/settings",
      payload: { orgCreation: "nobody" },
    });
    expect(bad.statusCode).toBe(400);
    const denied = await userReq({ method: "POST", url: "/api/v1/orgs", payload: { name: "X" } });
    expect(denied.statusCode).toBe(403);
    expect(errCode(denied)).toBe("org.creation_disabled");
    const allowed = await adminReq({
      method: "POST",
      url: "/api/v1/orgs",
      payload: { name: "Y" },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it("GET /admin/orgs：全部组织与成员数", async () => {
    const o1 = await orgs.create({ name: "One" }, user);
    const req = await session("admin");
    const res = await req({ method: "GET", url: "/api/v1/admin/orgs" });
    expect(res.statusCode).toBe(200);
    const list = (res.json() as { orgs: { id: string; memberCount: number }[] }).orgs;
    expect(list.map((o) => [o.id, o.memberCount])).toEqual([[o1.id, 1]]);
  });
});

describe("启动提示", () => {
  it("未初始化时启动日志含 warn（deployment is not set up）；初始化后再启动不出现；未配置 setupToken 时无需 token", async () => {
    const start = async () => {
      const lines: { level: string; msg: string }[] = [];
      const kk = await createKernel(config(), {
        env: {},
        logger: createLogger("info", { write: (l) => lines.push(JSON.parse(l)) }),
      });
      await kk.start();
      return { kk, lines };
    };
    const notice = (lines: { level: string; msg: string }[]) =>
      lines.filter((l) => l.level === "warn" && l.msg.includes("deployment is not set up"));

    const first = await start();
    try {
      expect(notice(first.lines)).toHaveLength(1);
      const res = await asUser(
        first.kk.http,
        cookieJar(),
      )({
        method: "POST",
        url: "/api/v1/setup",
        payload: setupBody(),
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await first.kk.stop();
    }

    const second = await start();
    try {
      expect(notice(second.lines)).toEqual([]);
    } finally {
      await second.kk.stop();
    }
  });
});
