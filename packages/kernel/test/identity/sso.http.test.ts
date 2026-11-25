import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExternalIdentity } from "@capybara-hq/plugin-sdk";
import {
  seedLoginSources,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { AccountsService } from "../../src/identity/accounts.js";
import { IdentityBinding } from "../../src/identity/binding.js";
import { ExternalIdentities } from "../../src/identity/external.js";
import { createLogger } from "../../src/log.js";
import { type FakeIdpCode, fakeIdpCode } from "../fixtures/plugins/fake-idp/index.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, type CookieJar, cookieJar, setCookies } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

const FAKE_IDP = fileURLToPath(new URL("../fixtures/plugins/fake-idp/index.ts", import.meta.url));
const PUBLIC = "https://cap.example";
const PW = "correct horse battery";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let accounts: AccountsService;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0, publicUrl: PUBLIC },
      auth: { cookieSecure: false },
      extensions: [FAKE_IDP],
      extensionConfig: { "fake-idp": { tenant: "t1", clientSecret: "s3cret" } },
      extensionPermissions: { autoApprove: true },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = accountsFor(db);
});
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  // after the truncate: it empties deployment_settings (its updated_by references accounts)
  await seedLoginSources(db, [
    { plugin: "fake-idp", signUp: "create" },
    { plugin: "not-installed", signUp: "create" },
  ]);
  await redis.flushdb();
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

/** Starts SSO; returns the state / nonce / challenge of the authorize URL. */
async function start(jar: CookieJar, returnTo?: string, intent?: "link") {
  const req = asUser(k.http, jar);
  let res: Awaited<ReturnType<typeof req>>;
  let loc: URL;
  if (intent === "link") {
    // a link intent starts from the CSRF-protected POST, which returns the location
    res = await req({
      method: "POST",
      url: "/api/v1/auth/sso/fake-idp/start",
      payload: { intent, ...(returnTo !== undefined && { returnTo }) },
    });
    expect(res.statusCode, res.body).toBe(200);
    loc = new URL((res.json() as { location: string }).location);
  } else {
    const q = returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`;
    res = await req({ method: "GET", url: `/api/v1/auth/sso/fake-idp/start${q}` });
    expect(res.statusCode).toBe(302);
    loc = new URL(String(res.headers.location));
  }
  return {
    res,
    loc,
    state: loc.searchParams.get("state") ?? "",
    nonce: loc.searchParams.get("nonce") ?? "",
    challenge: loc.searchParams.get("code_challenge") ?? "",
  };
}

let connSeq = 0;
/**
 * 一个真实的渠道连接（绑定确认时会复核连接仍在、插件仍在该组织启用）：组织、agent、连接与插件的组织级启用行。
 * 插件名用 fake-idp（只要求在组织启用，不要求提供 channel@1）。
 */
async function newConnection(id = `conn-${++connSeq}`): Promise<string> {
  const ownerId = (
    await accounts.createLocal({ login: `cowner-${id}`, password: PW, displayName: "CO" })
  ).id;
  const orgId = `org-${id}`;
  const agentId = `agent-${id}`;
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${orgId}, ${orgId}, ${orgId}, ${ownerId})`.execute(raw);
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agentId}, ${orgId}, ${ownerId}, 'org', 1)`.execute(raw);
  await sql`INSERT INTO capybara.channel_connections (id, org_id, plugin, name, agent_id, created_by)
    VALUES (${id}, ${orgId}, 'fake-idp', ${id}, ${agentId}, ${ownerId})`.execute(raw);
  await sql`INSERT INTO capybara.extension_org_configs (plugin, org_id, enabled)
    VALUES ('fake-idp', ${orgId}, true)`.execute(raw);
  return id;
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

/**
 * Runs one whole sign-in; returns the redirect target and the cookie jar. The code carries the
 * start's PKCE challenge: the fake source checks the codeVerifier the kernel hands it. `jar`, when
 * given, is the jar to run in (a signed-in session, say); `intent: "link"` starts a link intent.
 */
async function sso(
  code: Omit<FakeIdpCode, "nonce">,
  returnTo?: string,
  jar = cookieJar(),
  intent?: "link",
) {
  const s = await start(jar, returnTo, intent);
  const res = await callback(jar, {
    state: s.state,
    code: fakeIdpCode({ ...code, nonce: s.nonce, challenge: s.challenge }),
  });
  return { jar, res, location: String(res.headers.location), state: s.state, nonce: s.nonce };
}

const me = async (jar: CookieJar) => {
  const res = await asUser(k.http, jar)({ method: "GET", url: "/api/v1/me" });
  return res.statusCode === 200 ? (res.json() as { account: { id: string } }).account.id : null;
};

describe("登录方式列表", () => {
  it("lists only enabled login sources whose extension provides identity-source@1", async () => {
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

  it("a source that refuses the account → sso.account_not_allowed, no identity row", async () => {
    const reason = "hosted domain evil.example is not allowed";
    const r = await sso({ sub: "u-refused", email: "x@evil.example", refuse: reason });
    // a fixed code only: the plugin's text never reaches the URL
    expect(r.location).toBe(`${PUBLIC}/login?error=sso.account_not_allowed`);
    expect(r.location).not.toContain("evil.example is not allowed");
    expect(decodeURIComponent(r.location)).not.toContain(reason);
    expect(r.res.body).not.toContain(reason);
    expect(r.jar.get("cap_at")).toBeUndefined();
    expect(
      await db
        .selectFrom("identities")
        .selectAll()
        .where("external_id", "=", "u-refused")
        .execute(),
    ).toEqual([]);
    expect(await db.selectFrom("accounts").select("id").execute()).toEqual([]);
    expect(await db.selectFrom("sessions").select("id").execute()).toEqual([]);
    // the state was consumed before the source ran: a replay is a stale state, not a refusal
    const replay = await callback(r.jar, {
      state: r.state,
      code: fakeIdpCode({ sub: "u-refused", nonce: r.nonce }),
    });
    expect(replay.headers.location).toBe(`${PUBLIC}/login?error=sso.state_invalid`);
  });

  it("a refusal from a different browser is still a session mismatch (binding checked first)", async () => {
    const jar = cookieJar();
    const s = await start(jar);
    const other = cookieJar({ cap_sso: "C".repeat(43) });
    const res = await callback(other, {
      state: s.state,
      code: fakeIdpCode({
        sub: "u-refused-2",
        nonce: s.nonce,
        challenge: s.challenge,
        refuse: "no",
      }),
    });
    expect(res.headers.location).toBe(`${PUBLIC}/login?error=sso.session_mismatch`);
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
    const url = await k.app.get(IdentityBinding).createBindToken({
      connectionId: await newConnection("conn-1"),
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
    expect(await k.app.get(ExternalIdentities).findAccount("fake-idp:t1", "im-1")).toBe(
      alice.account.id,
    );

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
    expect(await k.app.get(ExternalIdentities).findAccount("fake-idp:t1", "im-1")).toBeUndefined();
  });

  it("身份已绑定他人 → 409 identity.taken", async () => {
    const alice = await localSession("alice");
    const bob = await localSession("bob");
    const t1 = tokenOf(
      await k.app.get(IdentityBinding).createBindToken({
        connectionId: await newConnection(),
        identity: imIdentity(),
      }),
    );
    expect((await alice.req({ method: "POST", url: `/api/v1/bind/${t1}` })).statusCode).toBe(200);
    const t2 = tokenOf(
      await k.app.get(IdentityBinding).createBindToken({
        connectionId: await newConnection(),
        identity: imIdentity(),
      }),
    );
    const res = await bob.req({ method: "POST", url: `/api/v1/bind/${t2}` });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("identity.taken");
    expect(await k.app.get(ExternalIdentities).findAccount("fake-idp:t1", "im-1")).toBe(
      alice.account.id,
    );
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
    const url = await k.app.get(IdentityBinding).createBindToken({
      connectionId: await newConnection(),
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
    expect(
      await k.app.get(ExternalIdentities).findAccount("fake-idp:t1", "u-last"),
    ).not.toBeUndefined();
  });
});

describe("修复波 W1", () => {
  /** 本地账号登录后的 Cookie 罐。 */
  async function loggedIn(login: string) {
    const account = await accounts.createLocal({ login, password: PW, displayName: login });
    const jar = cookieJar();
    const res = await asUser(
      k.http,
      jar,
    )({ method: "POST", url: "/api/v1/auth/login", payload: { login, password: PW } });
    expect(res.statusCode).toBe(200);
    return { account, jar, req: asUser(k.http, jar) };
  }

  const bindTo = async (req: ReturnType<typeof asUser>, externalId: string) => {
    const url = await k.app.get(IdentityBinding).createBindToken({
      connectionId: await newConnection(),
      identity: {
        source: "fake-idp:t1",
        externalId,
        tenantId: "t1",
        emailVerified: false,
        displayName: externalId,
      },
    });
    const token = url.slice(`${PUBLIC}/bind/`.length);
    const res = await req({ method: "POST", url: `/api/v1/bind/${token}` });
    expect(res.statusCode, res.body).toBe(200);
  };

  const linkedVia = async (externalId: string) =>
    (
      await db
        .selectFrom("identities")
        .select("linked_via")
        .where("source", "=", "fake-idp:t1")
        .where("external_id", "=", externalId)
        .executeTakeFirst()
    )?.linked_via;

  it("Ruling A18: a bind row never signs in directly; a sign-in with it goes to the link page", async () => {
    const bob = await loggedIn("bob");
    await bindTo(bob.req, "im-x");
    expect(await linkedVia("im-x")).toBe("bind");
    // an attacker who had bob confirm a binding link signs in with the same IM identity
    const attacker = await sso({ sub: "im-x" });
    expect(attacker.location.startsWith(`${PUBLIC}/login/link?ticket=cap_link_`)).toBe(true);
    expect(attacker.jar.get("cap_at")).toBeUndefined();
    // signed in as another account (a sign-in, not a link intent): the link page too, row unchanged
    const carol = await loggedIn("carol");
    const other = await sso({ sub: "im-x" }, "/chat", carol.jar);
    expect(other.location.startsWith(`${PUBLIC}/login/link?ticket=`)).toBe(true);
    expect(await linkedVia("im-x")).toBe("bind");
    expect(await me(carol.jar)).toBe(carol.account.id);
  });

  it("a link intent of the signed-in owner upgrades the bind row to sso; later sign-ins go in", async () => {
    const bob = await loggedIn("bob");
    await bindTo(bob.req, "im-y");
    const sessionsBefore = await db.selectFrom("sessions").select("id").execute();
    const proved = await sso({ sub: "im-y" }, "/account/identities", bob.jar, "link");
    expect(proved.location).toBe(`${PUBLIC}/account/identities`);
    expect(await me(proved.jar)).toBe(bob.account.id);
    expect(await linkedVia("im-y")).toBe("sso");
    // a link intent creates no session
    expect(await db.selectFrom("sessions").select("id").execute()).toHaveLength(
      sessionsBefore.length,
    );
    const later = await sso({ sub: "im-y" });
    expect(later.location).toBe(`${PUBLIC}/`);
    expect(await me(later.jar)).toBe(bob.account.id);
  });

  it("W2: a sign-in started signed out and called back with the owner's session does not upgrade", async () => {
    const bob = await loggedIn("bob");
    await bindTo(bob.req, "im-z");
    // the same browser: start signed out, sign bob in, then finish the callback
    const jar = cookieJar();
    const s = await start(jar, "/account/identities");
    const login = await asUser(
      k.http,
      jar,
    )({ method: "POST", url: "/api/v1/auth/login", payload: { login: "bob", password: PW } });
    expect(login.statusCode).toBe(200);
    const res = await callback(jar, {
      state: s.state,
      code: fakeIdpCode({ sub: "im-z", nonce: s.nonce, challenge: s.challenge }),
    });
    expect(String(res.headers.location).startsWith(`${PUBLIC}/login/link?ticket=`)).toBe(true);
    expect(await linkedVia("im-z")).toBe("bind");
  });

  it("W2：GET /me/identities 带 linkedVia（网页据此对 bind 身份显示「验证」）", async () => {
    const bob = await loggedIn("bob");
    await bindTo(bob.req, "im-v");
    const list = await bob.req({ method: "GET", url: "/api/v1/me/identities" });
    expect(list.statusCode).toBe(200);
    const ids = (list.json() as { identities: { externalId: string; linkedVia: string | null }[] })
      .identities;
    expect(ids.find((i) => i.externalId === "im-v")?.linkedVia).toBe("bind");
  });

  it("Ruling A19：身份源键与租户不一致 → sso.provider_error，不写身份", async () => {
    const r = await sso({ sub: "u-mismatch", source: "fake-idp:t2" });
    expect(r.location).toBe(`${PUBLIC}/login?error=sso.provider_error`);
    expect(r.jar.get("cap_at")).toBeUndefined();
    expect(
      await db
        .selectFrom("identities")
        .select("source")
        .where("external_id", "=", "u-mismatch")
        .execute(),
    ).toEqual([]);
  });

  it("PKCE：发起时生成 codeVerifier 存进 state，授权地址带 S256 challenge，回调把 verifier 交给插件", async () => {
    const jar = cookieJar();
    const s = await start(jar);
    expect(s.loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(s.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rec = JSON.parse((await redis.get(`capk:sso-state:${s.state}`)) ?? "{}") as {
      codeVerifier?: string;
    };
    expect(rec.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(
      createHash("sha256")
        .update(rec.codeVerifier ?? "")
        .digest("base64url"),
    ).toBe(s.challenge);
    // 授权码绑定的是另一个 challenge（被截获的授权码在别处兑换）→ 插件核对失败
    const res = await callback(jar, {
      state: s.state,
      code: fakeIdpCode({ sub: "u-pkce", nonce: s.nonce, challenge: "x".repeat(43) }),
    });
    expect(res.headers.location).toBe(`${PUBLIC}/login?error=sso.provider_error`);
    // 带对 challenge：成功
    const ok = await sso({ sub: "u-pkce" });
    expect(ok.location).toBe(`${PUBLIC}/`);
  });

  it("绑定确认时复核连接：连接已删除 / 不存在 / 插件在该组织停用 → bind.invalid，不绑定", async () => {
    const bob = await loggedIn("bob");
    const mk = async (externalId: string) => {
      const connectionId = await newConnection();
      const url = await k.app.get(IdentityBinding).createBindToken({
        connectionId,
        identity: {
          source: "fake-idp:t1",
          externalId,
          tenantId: "t1",
          emailVerified: false,
          displayName: externalId,
        },
      });
      return { connectionId, token: url.slice(`${PUBLIC}/bind/`.length) };
    };
    const deleted = await mk("im-del");
    await sql`UPDATE capybara.channel_connections SET deleted_at = now()
      WHERE id = ${deleted.connectionId}`.execute(raw);
    const gone = await mk("im-gone");
    await sql`DELETE FROM capybara.channel_connections WHERE id = ${gone.connectionId}`.execute(
      raw,
    );
    const disabled = await mk("im-off");
    await sql`UPDATE capybara.extension_org_configs SET enabled = false
      WHERE org_id = ${`org-${disabled.connectionId}`}`.execute(raw);
    for (const t of [deleted, gone, disabled]) {
      const res = await bob.req({ method: "POST", url: `/api/v1/bind/${t.token}` });
      expect(res.statusCode).toBe(404);
      expect(errCode(res)).toBe("bind.invalid");
    }
    for (const ext of ["im-del", "im-gone", "im-off"]) {
      expect(await k.app.get(ExternalIdentities).findAccount("fake-idp:t1", ext)).toBeUndefined();
    }
  });
});
