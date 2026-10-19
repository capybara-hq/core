import { fileURLToPath } from "node:url";
import type { ExternalIdentity } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { type FakeIdpCode, fakeIdpCode } from "../fixtures/plugins/fake-idp/index.js";
import { asUser, type CookieJar, cookieJar, setCookies } from "../helpers/http.js";

const FAKE_IDP = fileURLToPath(new URL("../fixtures/plugins/fake-idp/index.ts", import.meta.url));
const PUBLIC = "https://cap.example";
const PW = "correct horse battery";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let accounts: AccountsService;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      http: { port: 0, publicUrl: PUBLIC },
      auth: { cookieSecure: false, loginSources: ["fake-idp", "not-installed"] },
      plugins: [FAKE_IDP],
      pluginConfig: { "fake-idp": { tenant: "t1", clientSecret: "s3cret" } },
      pluginPermissions: { autoApprove: true },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
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
  await sql`TRUNCATE capybara.accounts, capybara.orgs, capybara.audit_events CASCADE`.execute(raw);
  await redis.flushdb();
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

/** 发起 SSO：返回授权地址里的 state / nonce / redirect_uri。 */
async function start(jar: CookieJar, returnTo?: string) {
  const q = returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`;
  const res = await asUser(
    k.http,
    jar,
  )({ method: "GET", url: `/api/v1/auth/sso/fake-idp/start${q}` });
  expect(res.statusCode).toBe(302);
  const loc = new URL(String(res.headers.location));
  return {
    res,
    loc,
    state: loc.searchParams.get("state") ?? "",
    nonce: loc.searchParams.get("nonce") ?? "",
  };
}

async function callback(jar: CookieJar, query: Record<string, string>) {
  const res = await asUser(
    k.http,
    jar,
  )({
    method: "GET",
    url: `/api/v1/auth/sso/fake-idp/callback?${new URLSearchParams(query).toString()}`,
  });
  expect(res.statusCode).toBe(302);
  return res;
}

/** 完整走一次登录；返回回跳地址与 Cookie 罐。 */
async function sso(code: Omit<FakeIdpCode, "nonce">, returnTo?: string) {
  const jar = cookieJar();
  const s = await start(jar, returnTo);
  const res = await callback(jar, {
    state: s.state,
    code: fakeIdpCode({ ...code, nonce: s.nonce }),
  });
  return { jar, res, location: String(res.headers.location), state: s.state, nonce: s.nonce };
}

const me = async (jar: CookieJar) => {
  const res = await asUser(k.http, jar)({ method: "GET", url: "/api/v1/me" });
  return res.statusCode === 200 ? (res.json() as { account: { id: string } }).account.id : null;
};

describe("登录方式列表", () => {
  it("只列出 auth.loginSources 中且提供 identity-source@1 的插件", async () => {
    const res = await k.http.inject({ method: "GET", url: "/api/v1/auth/sources" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sources: [{ plugin: "fake-idp", label: { zh: "测试身份源", en: "Fake IdP" } }],
    });
  });
});

describe("SSO 发起", () => {
  it("302 到插件的授权地址（带部署配置、state、nonce、回调地址），写浏览器绑定 Cookie", async () => {
    const s = await start(cookieJar(), "/chat");
    expect(s.loc.origin + s.loc.pathname).toBe("https://idp.example/authorize");
    expect(s.loc.searchParams.get("tenant")).toBe("t1");
    expect(s.loc.searchParams.get("redirect_uri")).toBe(
      `${PUBLIC}/api/v1/auth/sso/fake-idp/callback`,
    );
    expect(s.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.nonce.length).toBeGreaterThanOrEqual(32);
    const binding = setCookies(s.res).find((c) => c.name === "cap_sso");
    expect(binding?.attrs.httponly).toBe(true);
    expect(binding?.attrs.path).toBe("/api/v1/auth/sso");
    const ttl = await redis.ttl(`capk:sso-state:${s.state}`);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it("未启用的插件 → 回登录页并带错误码", async () => {
    for (const plugin of ["not-installed", "nope"]) {
      const res = await k.http.inject({ method: "GET", url: `/api/v1/auth/sso/${plugin}/start` });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`${PUBLIC}/login?error=sso.unavailable`);
    }
  });
});

describe("SSO 回调", () => {
  it("成功：建会话、回跳 returnTo；同一外部身份第二次登录得到同一账号", async () => {
    const a = await sso({ sub: "u1", name: "Alice", email: "alice@example.com" }, "/chat?x=1");
    expect(a.location).toBe(`${PUBLIC}/chat?x=1`);
    const id1 = await me(a.jar);
    expect(id1).not.toBeNull();
    const b = await sso({ sub: "u1", name: "Alice" });
    expect(b.location).toBe(`${PUBLIC}/`);
    expect(await me(b.jar)).toBe(id1);
    const rows = await db
      .selectFrom("identities")
      .selectAll()
      .where("source", "=", "fake-idp:t1")
      .execute();
    expect(rows.map((r) => [r.external_id, r.account_id])).toEqual([["u1", id1]]);
  });

  it("returnTo 不是站内相对路径 → 回跳 /", async () => {
    for (const bad of ["//evil.example/x", "https://evil.example/", "javascript:alert(1)"]) {
      const r = await sso({ sub: "u2" }, bad);
      expect(r.location).toBe(`${PUBLIC}/`);
    }
  });

  it("伪造的 state → sso.state_invalid，不建会话", async () => {
    const jar = cookieJar();
    const s = await start(jar);
    for (const state of ["A".repeat(43), "short", ""]) {
      const res = await callback(jar, { state, code: fakeIdpCode({ sub: "u3", nonce: s.nonce }) });
      expect(res.headers.location).toBe(`${PUBLIC}/login?error=sso.state_invalid`);
      expect(jar.get("cap_at")).toBeUndefined();
    }
  });

  it("过期的 state → sso.state_invalid", async () => {
    const jar = cookieJar();
    const s = await start(jar);
    await redis.pexpire(`capk:sso-state:${s.state}`, 1);
    await new Promise((r) => setTimeout(r, 20));
    const res = await callback(jar, {
      state: s.state,
      code: fakeIdpCode({ sub: "u4", nonce: s.nonce }),
    });
    expect(res.headers.location).toBe(`${PUBLIC}/login?error=sso.state_invalid`);
    expect(jar.get("cap_at")).toBeUndefined();
  });

  it("绑定 Cookie 不符 → sso.session_mismatch，且 state 已作废", async () => {
    const jar = cookieJar();
    const s = await start(jar);
    const other = cookieJar({ cap_sso: "B".repeat(43) });
    const code = fakeIdpCode({ sub: "u5", nonce: s.nonce });
    const res = await callback(other, { state: s.state, code });
    expect(res.headers.location).toBe(`${PUBLIC}/login?error=sso.session_mismatch`);
    expect(other.get("cap_at")).toBeUndefined();
    const noCookie = await callback(cookieJar(), { state: s.state, code });
    expect(noCookie.headers.location).toBe(`${PUBLIC}/login?error=sso.state_invalid`);
    const again = await callback(jar, { state: s.state, code });
    expect(again.headers.location).toBe(`${PUBLIC}/login?error=sso.state_invalid`);
    expect(
      await db.selectFrom("identities").selectAll().where("external_id", "=", "u5").execute(),
    ).toEqual([]);
  });

  it("state 单次有效：成功登录后重放 → sso.state_invalid", async () => {
    const a = await sso({ sub: "u6" });
    const res = await callback(a.jar, {
      state: a.state,
      code: fakeIdpCode({ sub: "u6", nonce: a.nonce }),
    });
    expect(res.headers.location).toBe(`${PUBLIC}/login?error=sso.state_invalid`);
  });

  it("身份源报错 / 用户拒绝 / 插件返回别的插件的身份源 → 对应错误码", async () => {
    const jar = cookieJar();
    let s = await start(jar);
    let res = await callback(jar, { state: s.state, code: "boom" });
    expect(res.headers.location).toBe(`${PUBLIC}/login?error=sso.provider_error`);
    s = await start(jar);
    res = await callback(jar, { state: s.state, error: "access_denied" });
    expect(res.headers.location).toBe(`${PUBLIC}/login?error=sso.access_denied`);
    s = await start(jar);
    res = await callback(jar, {
      state: s.state,
      code: fakeIdpCode({ sub: "u7", nonce: s.nonce, source: "other-idp:t1" }),
    });
    expect(res.headers.location).toBe(`${PUBLIC}/login?error=sso.provider_error`);
    expect(jar.get("cap_at")).toBeUndefined();
    expect(
      await db.selectFrom("identities").selectAll().where("external_id", "=", "u7").execute(),
    ).toEqual([]);
  });

  it("账号已停用 → 回登录页带 auth.account_disabled，不建会话", async () => {
    const a = await sso({ sub: "u8" });
    const id = await me(a.jar);
    await sql`UPDATE capybara.accounts SET status = 'disabled' WHERE id = ${id}`.execute(raw);
    const b = await sso({ sub: "u8" });
    expect(b.location).toBe(`${PUBLIC}/login?error=auth.account_disabled`);
    expect(b.jar.get("cap_at")).toBeUndefined();
    const n = await db
      .selectFrom("sessions")
      .select("id")
      .where("account_id", "=", id as string)
      .execute();
    expect(n).toHaveLength(1);
  });
});

describe("IM 身份绑定", () => {
  const imIdentity = (over: Partial<ExternalIdentity> = {}): ExternalIdentity => ({
    source: "fake-idp:t1",
    externalId: "im-1",
    tenantId: "t1",
    emailVerified: false,
    displayName: "IM User",
    ...over,
  });

  async function localSession(login: string) {
    const account = await accounts.createLocal({ login, password: PW, displayName: login });
    const jar = cookieJar();
    const req = asUser(k.http, jar);
    const res = await req({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { login, password: PW },
    });
    expect(res.statusCode).toBe(200);
    return { account, req };
  }

  const tokenOf = (url: string) => {
    expect(url.startsWith(`${PUBLIC}/bind/`)).toBe(true);
    return url.slice(`${PUBLIC}/bind/`.length);
  };

  it("令牌 15 分钟、单次有效；需登录；绑定到当前账号", async () => {
    const url = await k.identity.binding.createBindToken({
      connectionId: "conn-1",
      identity: imIdentity(),
    });
    const token = tokenOf(url);
    const keys = await redis.keys("capk:bind:*");
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(token);
    const ttl = await redis.ttl(keys[0] as string);
    expect(ttl).toBeGreaterThan(890);
    expect(ttl).toBeLessThanOrEqual(900);

    const anon = await k.http.inject({ method: "GET", url: `/api/v1/bind/${token}` });
    expect(anon.statusCode).toBe(401);

    const alice = await localSession("alice");
    const view = await alice.req({ method: "GET", url: `/api/v1/bind/${token}` });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toEqual({
      binding: {
        connectionId: "conn-1",
        source: "fake-idp:t1",
        externalId: "im-1",
        displayName: "IM User",
      },
    });
    const ok = await alice.req({ method: "POST", url: `/api/v1/bind/${token}` });
    expect(ok.statusCode).toBe(200);
    expect(await k.identity.external.findAccount("fake-idp:t1", "im-1")).toBe(alice.account.id);

    const again = await alice.req({ method: "POST", url: `/api/v1/bind/${token}` });
    expect(again.statusCode).toBe(404);
    expect(errCode(again)).toBe("bind.invalid");
    const peek = await alice.req({ method: "GET", url: `/api/v1/bind/${token}` });
    expect(peek.statusCode).toBe(404);
    expect(errCode(peek)).toBe("bind.invalid");

    const list = await alice.req({ method: "GET", url: "/api/v1/me/identities" });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { identities: unknown[] }).identities).toEqual([
      expect.objectContaining({ source: "fake-idp:t1", externalId: "im-1" }),
    ]);
    const del = await alice.req({
      method: "DELETE",
      url: `/api/v1/me/identities/${encodeURIComponent("fake-idp:t1")}/im-1`,
    });
    expect(del.statusCode).toBe(204);
    expect(await k.identity.external.findAccount("fake-idp:t1", "im-1")).toBeUndefined();
  });

  it("身份已绑定他人 → 409 identity.taken", async () => {
    const alice = await localSession("alice");
    const bob = await localSession("bob");
    const t1 = tokenOf(
      await k.identity.binding.createBindToken({ connectionId: "c", identity: imIdentity() }),
    );
    expect((await alice.req({ method: "POST", url: `/api/v1/bind/${t1}` })).statusCode).toBe(200);
    const t2 = tokenOf(
      await k.identity.binding.createBindToken({ connectionId: "c", identity: imIdentity() }),
    );
    const res = await bob.req({ method: "POST", url: `/api/v1/bind/${t2}` });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("identity.taken");
    expect(await k.identity.external.findAccount("fake-idp:t1", "im-1")).toBe(alice.account.id);
  });

  it("无效 / 伪造的令牌 → 404 bind.invalid", async () => {
    const alice = await localSession("alice");
    for (const t of ["cap_bind_nope", "x"]) {
      const res = await alice.req({ method: "POST", url: `/api/v1/bind/${t}` });
      expect(res.statusCode).toBe(404);
      expect(errCode(res)).toBe("bind.invalid");
    }
  });
});

describe("修复轮 1", () => {
  it("绑定 Cookie：SameSite=Lax、publicUrl 为 https 时 Secure、Max-Age=600", async () => {
    const s = await start(cookieJar());
    const c = setCookies(s.res).find((x) => x.name === "cap_sso");
    expect(c?.attrs.samesite).toBe("Lax");
    expect(c?.attrs.secure).toBe(true);
    expect(c?.attrs["max-age"]).toBe("600");
  });

  it("returnTo 的各种绕过写法都落在 publicUrl 下", async () => {
    for (const bad of ["/\\evil.example", "\\\\evil", "/%2F%2Fevil.example", "%2F%2Fevil"]) {
      const r = await sso({ sub: "u-rt" }, bad);
      const u = new URL(r.location);
      expect(u.origin).toBe(PUBLIC);
      expect(r.location.startsWith(`${PUBLIC}/`)).toBe(true);
      expect(r.location.startsWith(`${PUBLIC}//`)).toBe(false);
    }
  });

  it("POST /bind/:token 不带 CSRF 头 → 拒绝，令牌不被消耗", async () => {
    await accounts.createLocal({ login: "carol", password: PW, displayName: "carol" });
    const jar = cookieJar();
    const req = asUser(k.http, jar);
    expect(
      (
        await req({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { login: "carol", password: PW },
        })
      ).statusCode,
    ).toBe(200);
    const url = await k.identity.binding.createBindToken({
      connectionId: "c",
      identity: {
        source: "fake-idp:t1",
        externalId: "im-csrf",
        tenantId: "t1",
        emailVerified: false,
        displayName: "X",
      },
    });
    const token = url.slice(`${PUBLIC}/bind/`.length);
    const res = await req({ method: "POST", url: `/api/v1/bind/${token}`, csrf: false });
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("auth.csrf");
    expect((await req({ method: "GET", url: `/api/v1/bind/${token}` })).statusCode).toBe(200);
  });

  it("没有本地密码的账号不能解除最后一个登录方式 → 409 identity.last_login_method", async () => {
    const a = await sso({ sub: "u-last" });
    const req = asUser(k.http, a.jar);
    const res = await req({
      method: "DELETE",
      url: `/api/v1/me/identities/${encodeURIComponent("fake-idp:t1")}/u-last`,
    });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("identity.last_login_method");
    expect(await k.identity.external.findAccount("fake-idp:t1", "u-last")).not.toBeUndefined();
  });
});
