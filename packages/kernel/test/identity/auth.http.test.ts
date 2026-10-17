import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { type Account, AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { asUser, type CookieJar, cookieJar, setCookies } from "../helpers/http.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let accounts: AccountsService;
let alice: Account;
let admin: Account;

const PW = "correct horse battery";
const masterKey = Buffer.alloc(32, 7).toString("base64");

const cfg = (http: Record<string, unknown> = {}): KernelConfig =>
  KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 5 },
    redis: { url: rd.url },
    masterKey,
    http: { port: 0, ...http },
  });

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(cfg(), { env: {}, logger: createLogger("error", { write: () => {} }) });
  await k.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = new AccountsService(db);
}, 120_000);
afterAll(async () => {
  await k?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await sql`TRUNCATE capybara.accounts CASCADE`.execute(raw);
  await redis.flushdb();
  admin = await accounts.createLocal({
    login: "admin",
    password: PW,
    displayName: "Admin",
    enterpriseAdmin: true,
  });
  alice = await accounts.createLocal({ login: "alice", password: PW, displayName: "Alice" });
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

async function login(jar: CookieJar, loginName = "alice", password = PW) {
  return asUser(
    k.http,
    jar,
  )({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: loginName, password },
  });
}

describe("POST /api/v1/auth/login", () => {
  it("成功：200，设 cap_at 与 cap_rt；无 Domain；cap_rt 限 Path 与 SameSite=Strict；都 HttpOnly", async () => {
    const jar = cookieJar();
    const res = await login(jar);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { account: Account }).account.id).toBe(alice.id);
    const cs = setCookies(res);
    const at = cs.find((c) => c.name === "cap_at");
    const rt = cs.find((c) => c.name === "cap_rt");
    expect(at).toBeDefined();
    expect(rt).toBeDefined();
    for (const c of [at, rt]) {
      expect(c?.raw).not.toMatch(/domain=/i);
      expect(c?.attrs.httponly).toBe(true);
      expect(c?.attrs.secure).toBe(true);
    }
    expect(at?.attrs.path).toBe("/");
    expect(String(at?.attrs.samesite).toLowerCase()).toBe("lax");
    expect(at?.attrs["max-age"]).toBe("900");
    expect(rt?.attrs.path).toBe("/api/v1/auth");
    expect(String(rt?.attrs.samesite).toLowerCase()).toBe("strict");
    expect(rt?.attrs["max-age"]).toBe(String(30 * 86400));
  });

  it("缺 X-Capybara-Csrf → 403 auth.csrf", async () => {
    const res = await asUser(
      k.http,
      cookieJar(),
    )({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { login: "alice", password: PW },
      csrf: false,
    });
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("auth.csrf");
  });

  it("错密码与不存在的登录名 → 都是 401 auth.invalid_credentials，响应体逐字节相同", async () => {
    const a = await login(cookieJar(), "alice", "wrong password!!");
    const b = await login(cookieJar(), "nobody", "wrong password!!");
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(errCode(a)).toBe("auth.invalid_credentials");
    expect(a.body).toBe(b.body);
    expect(setCookies(a)).toEqual([]);
  });

  it("第 11 次失败登录 → 429 auth.rate_limited 带 Retry-After；此时正确密码也 429", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await login(cookieJar(), "alice", "wrong password!!")).statusCode).toBe(401);
    }
    const r = await login(cookieJar(), "alice", "wrong password!!");
    expect(r.statusCode).toBe(429);
    expect(errCode(r)).toBe("auth.rate_limited");
    const retry = Number(r.headers["retry-after"]);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(900);
    const ok = await login(cookieJar(), "alice", PW);
    expect(ok.statusCode).toBe(429);
    expect(errCode(ok)).toBe("auth.rate_limited");
  });

  it("并发 30 次错密码登录同一账号：至多 10 次到达密码校验，至少 20 次 429", async () => {
    const rs = await Promise.all(
      Array.from({ length: 30 }, () => login(cookieJar(), "alice", "wrong password!!")),
    );
    const codes = rs.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(10);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(20);
    expect(codes.every((c) => c === 401 || c === 429)).toBe(true);
  });

  it("成功登录不消耗 IP 额度：同一 IP 连续 60 次成功登录都 200", async () => {
    for (let i = 0; i < 60; i++) {
      expect((await login(cookieJar(), i % 2 ? "alice" : "admin")).statusCode).toBe(200);
    }
  });

  it("成功登录清掉该登录名的失败计数", async () => {
    for (let i = 0; i < 9; i++) await login(cookieJar(), "alice", "wrong password!!");
    expect((await login(cookieJar())).statusCode).toBe(200);
    for (let i = 0; i < 9; i++) await login(cookieJar(), "alice", "wrong password!!");
    expect((await login(cookieJar())).statusCode).toBe(200);
  });

  it("停用账号 + 正确密码 → auth.account_disabled", async () => {
    await accounts.update(alice.id, { status: "disabled" }, admin.id);
    const res = await login(cookieJar());
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("auth.account_disabled");
  });

  it("校验失败：body { login: 1 } → 400 validation_failed，details[0].path === 'login'", async () => {
    const res = await asUser(
      k.http,
      cookieJar(),
    )({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { login: 1 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; details: { path: string }[] } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details[0]?.path).toBe("login");
  });
});

describe("GET /api/v1/me 与 CSRF", () => {
  it("带 Cookie 200；不带 401 auth.required", async () => {
    const jar = cookieJar();
    await login(jar);
    const me = await asUser(k.http, jar)({ method: "GET", url: "/api/v1/me", csrf: false });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      account: { id: alice.id, displayName: "Alice" },
      via: "session",
      currentOrgId: null,
    });
    const anon = await k.http.inject({ method: "GET", url: "/api/v1/me" });
    expect(anon.statusCode).toBe(401);
    expect(errCode(anon)).toBe("auth.required");
  });

  it("PUT /me/password 带 Cookie 不带 CSRF → 403 auth.csrf；Bearer PAT 不带 CSRF → 403 auth.session_required", async () => {
    const jar = cookieJar();
    await login(jar);
    const body = { currentPassword: PW, newPassword: "another long password" };
    const noCsrf = await asUser(
      k.http,
      jar,
    )({
      method: "PUT",
      url: "/api/v1/me/password",
      payload: body,
      csrf: false,
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(errCode(noCsrf)).toBe("auth.csrf");

    const { token } = await new ApiTokenService(db).createPersonal(alice.id, { name: "ci" });
    const pat = await k.http.inject({
      method: "PUT",
      url: "/api/v1/me/password",
      payload: body,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pat.statusCode).toBe(403);
    expect(errCode(pat)).toBe("auth.session_required");
    // 密码没被改
    expect(await accounts.authenticateLocal("alice", PW)).not.toBeNull();
  });

  it("Bearer PAT：GET /me 200（via: pat）；未知令牌 401；停用账号后 401/403 auth.account_disabled", async () => {
    const { token } = await new ApiTokenService(db).createPersonal(alice.id, { name: "ci" });
    const me = await k.http.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ account: { id: alice.id }, via: "pat", currentOrgId: null });
    const bad = await k.http.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: "Bearer cap_pat_nope" },
    });
    expect(bad.statusCode).toBe(401);
    expect(errCode(bad)).toBe("auth.required");
    await accounts.update(alice.id, { status: "disabled" }, admin.id);
    const off = await k.http.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(errCode(off)).toBe("auth.account_disabled");
  });

  it("service 令牌访问要求 user 的路由 → 403 forbidden", async () => {
    const orgId = crypto.randomUUID();
    await db
      .insertInto("orgs")
      .values({ id: orgId, slug: "acme", name: "Acme", created_by: admin.id })
      .execute();
    const { token } = await new ApiTokenService(db).createService(orgId, {
      name: "bot",
      role: "admin",
      createdBy: admin.id,
    });
    const res = await k.http.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("forbidden");
  });
});

describe("refresh / logout / 改密码 / 停用", () => {
  it("refresh：带 cap_rt → 200 并换新 Cookie；旧 cap_rt 立即重放 → 401 auth.refresh_race", async () => {
    const jar = cookieJar();
    await login(jar);
    const old = jar.clone();
    const oldRt = jar.get("cap_rt");
    const res = await asUser(k.http, jar)({ method: "POST", url: "/api/v1/auth/refresh" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { account: Account }).account.id).toBe(alice.id);
    expect(jar.get("cap_rt")).toBeDefined();
    expect(jar.get("cap_rt")).not.toBe(oldRt);
    expect(
      setCookies(res)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["cap_at", "cap_rt"]);
    const replay = await asUser(k.http, old)({ method: "POST", url: "/api/v1/auth/refresh" });
    expect(replay.statusCode).toBe(401);
    expect(errCode(replay)).toBe("auth.refresh_race");
    // 新 Cookie 仍可用
    expect((await asUser(k.http, jar)({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(200);
  });

  it("refresh：没有 cap_rt 或无效 → 401 auth.refresh_invalid 并清 Cookie", async () => {
    const none = await asUser(k.http, cookieJar())({ method: "POST", url: "/api/v1/auth/refresh" });
    expect(none.statusCode).toBe(401);
    expect(errCode(none)).toBe("auth.refresh_invalid");
    const jar = cookieJar({ cap_rt: "cap_rt_bogus", cap_at: "x" });
    const bad = await asUser(k.http, jar)({ method: "POST", url: "/api/v1/auth/refresh" });
    expect(errCode(bad)).toBe("auth.refresh_invalid");
    expect(jar.header()).toBeUndefined();
  });

  it("logout 后用旧 cap_at GET /me → 401 auth.session_revoked；logout 总是清 Cookie、204", async () => {
    const jar = cookieJar();
    await login(jar);
    const old = jar.clone();
    const res = await asUser(k.http, jar)({ method: "POST", url: "/api/v1/auth/logout" });
    expect(res.statusCode).toBe(204);
    expect(jar.header()).toBeUndefined();
    const me = await asUser(k.http, old)({ method: "GET", url: "/api/v1/me" });
    expect(me.statusCode).toBe(401);
    expect(errCode(me)).toBe("auth.session_revoked");
    // 旧 refresh token 也已失效
    const rf = await asUser(k.http, old)({ method: "POST", url: "/api/v1/auth/refresh" });
    expect(rf.statusCode).toBe(401);
    // 再次登出（已吊销的 Cookie）、不带 Cookie 登出都 204
    expect(
      (await asUser(k.http, old)({ method: "POST", url: "/api/v1/auth/logout" })).statusCode,
    ).toBe(204);
    expect(
      (await asUser(k.http, cookieJar())({ method: "POST", url: "/api/v1/auth/logout" }))
        .statusCode,
    ).toBe(204);
  });

  it("logout 只带 cap_rt 也吊销会话", async () => {
    const jar = cookieJar();
    await login(jar);
    const atOnly = cookieJar({ cap_at: jar.get("cap_at") as string });
    const rtOnly = cookieJar({ cap_rt: jar.get("cap_rt") as string });
    expect(
      (await asUser(k.http, rtOnly)({ method: "POST", url: "/api/v1/auth/logout" })).statusCode,
    ).toBe(204);
    const me = await asUser(k.http, atOnly)({ method: "GET", url: "/api/v1/me" });
    expect(errCode(me)).toBe("auth.session_revoked");
  });

  it("改密码：旧密码错 → 401 auth.invalid_credentials；成功后其他会话 401 auth.session_revoked，当前会话仍可用", async () => {
    const cur = cookieJar();
    const other = cookieJar();
    await login(cur);
    await login(other);
    const wrong = await asUser(
      k.http,
      cur,
    )({
      method: "PUT",
      url: "/api/v1/me/password",
      payload: { currentPassword: "wrong password!!", newPassword: "another long password" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(errCode(wrong)).toBe("auth.invalid_credentials");
    const ok = await asUser(
      k.http,
      cur,
    )({
      method: "PUT",
      url: "/api/v1/me/password",
      payload: { currentPassword: PW, newPassword: "another long password" },
    });
    expect(ok.statusCode).toBe(204);
    const o = await asUser(k.http, other)({ method: "GET", url: "/api/v1/me" });
    expect(o.statusCode).toBe(401);
    expect(errCode(o)).toBe("auth.session_revoked");
    expect((await asUser(k.http, cur)({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(200);
    expect((await login(cookieJar(), "alice", "another long password")).statusCode).toBe(200);
  });

  it("改密码：新密码太短 → 400 validation_failed（path newPassword）", async () => {
    const jar = cookieJar();
    await login(jar);
    const res = await asUser(
      k.http,
      jar,
    )({
      method: "PUT",
      url: "/api/v1/me/password",
      payload: { currentPassword: PW, newPassword: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { details: { path: string }[] } }).error.details[0]?.path).toBe(
      "newPassword",
    );
  });

  it("账号被停用后，未过期的 cap_at 立即被拒 auth.account_disabled（每请求实时读账号状态）", async () => {
    const jar = cookieJar();
    await login(jar);
    expect((await asUser(k.http, jar)({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(200);
    await accounts.update(alice.id, { status: "disabled" }, admin.id);
    const res = await asUser(k.http, jar)({ method: "GET", url: "/api/v1/me" });
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("auth.account_disabled");
  });
});

describe("http.trustProxy：客户端 IP", () => {
  const quiet = { env: {}, logger: createLogger("error", { write: () => {} }) };
  const viaProxy = (password: string) => ({
    method: "POST" as const,
    url: "/api/v1/auth/login",
    payload: { login: "alice", password },
    remoteAddress: "127.0.0.1",
    headers: { "x-capybara-csrf": "1", "x-forwarded-for": "1.1.1.1, 2.2.2.2" },
  });

  /** 用给定 trustProxy 起一个内核，从 127.0.0.1 带 X-Forwarded-For 登录，返回会话记录的 ip。 */
  async function sessionIp(trustProxy: unknown): Promise<string | null> {
    const kk = await createKernel(cfg({ trustProxy }), quiet);
    try {
      await kk.start();
      expect((await kk.http.inject(viaProxy(PW))).statusCode).toBe(200);
      const row = await db
        .selectFrom("sessions")
        .select("ip")
        .where("account_id", "=", alice.id)
        .executeTakeFirstOrThrow();
      await db.deleteFrom("sessions").execute();
      return row.ip;
    } finally {
      await kk.stop();
    }
  }

  it("跳数 1 → 取最近一跳代理报告的 2.2.2.2；受信代理 CIDR 同理；false → socket 地址", async () => {
    expect(await sessionIp(1)).toBe("2.2.2.2");
    expect(await sessionIp(["127.0.0.0/8"])).toBe("2.2.2.2");
    expect(await sessionIp(false)).toBe("127.0.0.1");
  });

  it("失败登录的 IP 限流键同样按解析出的客户端 IP", async () => {
    const kk = await createKernel(cfg({ trustProxy: 1 }), quiet);
    try {
      await kk.start();
      await kk.http.inject(viaProxy("wrong password!!"));
      expect(await redis.exists("capk:login-fail:ip:2.2.2.2")).toBe(1);
      expect(await redis.exists("capk:login-fail:ip:127.0.0.1")).toBe(0);
      expect(await redis.exists("capk:login-fail:ip:1.1.1.1")).toBe(0);
    } finally {
      await kk.stop();
    }
  });
});
