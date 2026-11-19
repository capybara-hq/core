import { createHash, randomBytes, randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { s256 } from "../../src/identity/app-auth.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { PW, type Req, runConfig, session, startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * Native-app sign-in (desktop client spec §6.5): the authorization code flow with PKCE. A person
 * signed in on the web consents (`authorize`), the app exchanges the one-time code with its
 * verifier (`token`) and gets an ordinary web session of its own.
 */

const PUBLIC_URL = "https://cap.example.com";
const REDIRECT = "capybara://auth/callback";
const NAME = "Ada's MacBook";
const APP_VERSION = "1.2.3";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api"], http: { port: 0, publicUrl: `${PUBLIC_URL}/` } },
    ),
  );
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** Every test starts with fresh rate limits (the token route counts per address). */
beforeEach(async () => {
  const keys = await redis.keys("throttler:*");
  if (keys.length > 0) await redis.del(...keys);
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

const codeKey = (code: string) =>
  `capk:app-auth-code:${createHash("sha256").update(code).digest("hex")}`;

/** A new account signed in on the web, as a browser would be. */
async function person(): Promise<{ id: string; login: string; browser: Req }> {
  const login = `p-${randomUUID().slice(0, 8)}`;
  const id = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
  return { id, login, browser: await session(k, login) };
}

/** What the app's main process keeps: the verifier and its S256 challenge, and a state. */
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: s256(verifier), state: randomBytes(32).toString("base64url") };
}

function authorizeBody(p: ReturnType<typeof pkce>, extra: Record<string, unknown> = {}) {
  return {
    client: "desktop",
    redirectUri: REDIRECT,
    codeChallenge: p.challenge,
    codeChallengeMethod: "S256",
    state: p.state,
    name: NAME,
    appVersion: APP_VERSION,
    ...extra,
  };
}

const authorize = (browser: Req, payload: Record<string, unknown>) =>
  browser({ method: "POST", url: "/api/v1/app-auth/authorize", payload });

/** Consents and returns the code from the redirect (and the redirect's parameters). */
async function consent(browser: Req, p = pkce()) {
  const res = await authorize(browser, authorizeBody(p));
  expect(res.statusCode, res.body).toBe(200);
  const redirect = (res.json() as { redirect: string }).redirect;
  const q = new URL(redirect).searchParams;
  return { redirect, code: q.get("code") ?? "", params: q, p };
}

/** The app's exchange: a fresh cookie jar (the app's own partition), the CSRF header it sends. */
async function exchange(body: Record<string, unknown>) {
  const jar = cookieJar();
  const app = asUser(k.http, jar);
  const res = await app({
    method: "POST",
    url: "/api/v1/app-auth/token",
    payload: body,
    headers: { "user-agent": "Electron" },
  });
  return { res, jar, app };
}

const auditOf = (accountId: string, action: string) =>
  db
    .selectFrom("audit_events")
    .select(["detail", "actor_account_id"])
    .where("actor_account_id", "=", accountId)
    .where("action", "=", action)
    .execute();

const sessionCount = async (accountId: string) =>
  (await db.selectFrom("sessions").select("id").where("account_id", "=", accountId).execute())
    .length;

describe("authorize", () => {
  it("authorize returns a redirect with code, state and iss", async () => {
    const { id, browser } = await person();
    const { redirect, code, params, p } = await consent(browser);
    expect(redirect.startsWith(`${REDIRECT}?`)).toBe(true);
    expect(code).toMatch(/^cap_ac_[A-Za-z0-9_-]{43}$/);
    expect(params.get("state")).toBe(p.state);
    expect(params.get("iss")).toBe(PUBLIC_URL);
    expect(params.get("error")).toBeNull();
    const rows = await auditOf(id, "auth.app_authorized");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toEqual({ client: "desktop", name: NAME });
    // the code itself is never stored, only its hash
    const stored = await redis.get(codeKey(code));
    expect(stored).not.toBeNull();
    expect(stored).not.toContain(code);
  });

  it("authorize refuses an unlisted redirect uri", async () => {
    const { browser } = await person();
    const before = await redis.keys("capk:app-auth-code:*");
    for (const redirectUri of ["capybara://evil", "capybara://auth/callback/", "https://evil"]) {
      const res = await authorize(browser, authorizeBody(pkce(), { redirectUri }));
      expect(res.statusCode, redirectUri).toBe(400);
      expect(errCode(res)).toBe("app_auth.redirect_uri_invalid");
    }
    const denied = await authorize(
      browser,
      authorizeBody(pkce(), { redirectUri: "capybara://evil", deny: true }),
    );
    expect(errCode(denied)).toBe("app_auth.redirect_uri_invalid");
    expect(await redis.keys("capk:app-auth-code:*")).toEqual(before);
  });

  it("authorize refuses a personal token", async () => {
    const { browser } = await person();
    const pat = await browser({ method: "POST", url: "/api/v1/me/tokens", payload: { name: "x" } });
    expect(pat.statusCode).toBe(201);
    const token = (pat.json() as { token: string }).token;
    const res = await k.http.inject({
      method: "POST",
      url: "/api/v1/app-auth/authorize",
      payload: authorizeBody(pkce()),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("auth.session_required");
  });

  it("authorize needs the CSRF header and a signed-in person", async () => {
    const { browser } = await person();
    const noCsrf = await browser({
      method: "POST",
      url: "/api/v1/app-auth/authorize",
      payload: authorizeBody(pkce()),
      csrf: false,
    });
    expect(errCode(noCsrf)).toBe("auth.csrf");
    const anonymous = await k.http.inject({
      method: "POST",
      url: "/api/v1/app-auth/authorize",
      payload: authorizeBody(pkce()),
      headers: { "x-capybara-csrf": "1" },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("authorize refuses plain and missing challenge methods", async () => {
    const { browser } = await person();
    const p = pkce();
    const plain = await authorize(
      browser,
      authorizeBody(p, { codeChallengeMethod: "plain", codeChallenge: p.verifier }),
    );
    expect(plain.statusCode).toBe(400);
    expect(errCode(plain)).toBe("validation_failed");
    const { codeChallengeMethod: _m, ...missing } = authorizeBody(p);
    const none = await authorize(browser, missing);
    expect(none.statusCode).toBe(400);
    expect(errCode(none)).toBe("validation_failed");
  });

  it("authorize checks the challenge, name and version", async () => {
    const { browser } = await person();
    for (const extra of [
      { codeChallenge: "short" },
      { codeChallenge: `${"a".repeat(42)}=` },
      { name: "" },
      { name: "x".repeat(65) },
      { name: "evil\nname" },
      { appVersion: "" },
      { appVersion: "1".repeat(33) },
      { client: "mobile" },
    ]) {
      const res = await authorize(browser, authorizeBody(pkce(), extra));
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
  });

  it("deny returns error=access_denied without a code", async () => {
    const { id, browser } = await person();
    const before = await redis.keys("capk:app-auth-code:*");
    const p = pkce();
    const res = await authorize(browser, authorizeBody(p, { deny: true }));
    expect(res.statusCode, res.body).toBe(200);
    const url = new URL((res.json() as { redirect: string }).redirect);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(REDIRECT);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe(p.state);
    expect(url.searchParams.get("iss")).toBe(PUBLIC_URL);
    expect(url.searchParams.get("code")).toBeNull();
    expect(await redis.keys("capk:app-auth-code:*")).toEqual(before);
    expect(await auditOf(id, "auth.app_authorized")).toHaveLength(0);
  });
});

describe("token", () => {
  it("token exchanges once and sets session cookies", async () => {
    const { id, login, browser } = await person();
    const { code, p } = await consent(browser);
    const { res, jar, app } = await exchange({
      code,
      codeVerifier: p.verifier,
      redirectUri: REDIRECT,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ account: { id, displayName: login, status: "active" } });
    expect(jar.get("cap_at")).toBeTruthy();
    expect(jar.get("cap_rt")).toBeTruthy();
    const me = await app({ method: "GET", url: "/api/v1/me" });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ via: "session", account: { id } });

    const rows = await db
      .selectFrom("sessions")
      .select(["id", "user_agent"])
      .where("account_id", "=", id)
      .where("user_agent", "=", `Capybara Desktop/${APP_VERSION} (${NAME})`)
      .execute();
    expect(rows).toHaveLength(1);
    const audit = await auditOf(id, "auth.app_signed_in");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toEqual({ client: "desktop", name: NAME, sessionId: rows[0]?.id });
    expect(await redis.exists(codeKey(code))).toBe(0);
  });

  it("a second exchange of the same code fails", async () => {
    const { id, browser } = await person();
    const { code, p } = await consent(browser);
    const body = { code, codeVerifier: p.verifier, redirectUri: REDIRECT };
    expect((await exchange(body)).res.statusCode).toBe(200);
    const sessions = await sessionCount(id);
    const again = (await exchange(body)).res;
    expect(again.statusCode).toBe(400);
    expect(errCode(again)).toBe("app_auth.code_invalid");
    expect(await sessionCount(id)).toBe(sessions);
  });

  it("a wrong verifier fails and burns the code", async () => {
    const { id, browser } = await person();
    const { code, p } = await consent(browser);
    const sessions = await sessionCount(id);
    const wrong = (await exchange({ code, codeVerifier: pkce().verifier, redirectUri: REDIRECT }))
      .res;
    expect(wrong.statusCode).toBe(400);
    expect(errCode(wrong)).toBe("app_auth.code_invalid");
    const right = (await exchange({ code, codeVerifier: p.verifier, redirectUri: REDIRECT })).res;
    expect(errCode(right)).toBe("app_auth.code_invalid");
    expect(await sessionCount(id)).toBe(sessions);
  });

  it("a malformed verifier fails like a wrong one", async () => {
    const { browser } = await person();
    const { code, p } = await consent(browser);
    for (const codeVerifier of ["short", `${p.verifier}!`, ""]) {
      const { browser: b2 } = await person();
      const c2 = await consent(b2);
      const res = (await exchange({ code: c2.code, codeVerifier, redirectUri: REDIRECT })).res;
      expect(res.statusCode, codeVerifier).toBe(400);
      expect(errCode(res)).toBe("app_auth.code_invalid");
    }
    // the plain method is refused: the challenge itself as the verifier does not match
    const plain = (await exchange({ code, codeVerifier: p.challenge, redirectUri: REDIRECT })).res;
    expect(errCode(plain)).toBe("app_auth.code_invalid");
  });

  it("a mismatched redirect uri fails", async () => {
    const { browser } = await person();
    const { code, p } = await consent(browser);
    const res = (await exchange({ code, codeVerifier: p.verifier, redirectUri: "capybara://evil" }))
      .res;
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe("app_auth.code_invalid");
    // burnt as well
    const after = (await exchange({ code, codeVerifier: p.verifier, redirectUri: REDIRECT })).res;
    expect(errCode(after)).toBe("app_auth.code_invalid");
  });

  it("an expired code fails", async () => {
    const { browser } = await person();
    const { code, p } = await consent(browser);
    // the key's TTL ran out: Redis has dropped it
    expect(await redis.del(codeKey(code))).toBe(1);
    const res = (await exchange({ code, codeVerifier: p.verifier, redirectUri: REDIRECT })).res;
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe("app_auth.code_invalid");
  });

  it("an unknown or malformed code fails", async () => {
    for (const code of [`cap_ac_${randomBytes(32).toString("base64url")}`, "nope", ""]) {
      const res = (await exchange({ code, codeVerifier: pkce().verifier, redirectUri: REDIRECT }))
        .res;
      expect(res.statusCode, code).toBe(400);
      expect(errCode(res)).toBe("app_auth.code_invalid");
    }
  });

  it("a disabled account gets no session", async () => {
    const { id, browser } = await person();
    const { code, p } = await consent(browser);
    await db.updateTable("accounts").set({ status: "disabled" }).where("id", "=", id).execute();
    const sessions = await sessionCount(id);
    const { res, jar } = await exchange({ code, codeVerifier: p.verifier, redirectUri: REDIRECT });
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe("app_auth.code_invalid");
    expect(jar.get("cap_at")).toBeUndefined();
    expect(await sessionCount(id)).toBe(sessions);
    expect(await auditOf(id, "auth.app_signed_in")).toHaveLength(0);
  });

  it("a code whose browser session signed out since fails", async () => {
    const { id, browser } = await person();
    const { code, p } = await consent(browser);
    const out = await browser({ method: "POST", url: "/api/v1/auth/logout" });
    expect(out.statusCode).toBe(204);
    const sessions = await sessionCount(id);
    const res = (await exchange({ code, codeVerifier: p.verifier, redirectUri: REDIRECT })).res;
    expect(errCode(res)).toBe("app_auth.code_invalid");
    expect(await sessionCount(id)).toBe(sessions);
  });

  it("the redis key has a ttl of at most 60 s", async () => {
    const { browser } = await person();
    const { code } = await consent(browser);
    const ttl = await redis.ttl(codeKey(code));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("sign-out ends only the app session", async () => {
    const { browser } = await person();
    const { code, p } = await consent(browser);
    const { res, app } = await exchange({ code, codeVerifier: p.verifier, redirectUri: REDIRECT });
    expect(res.statusCode).toBe(200);
    const out = await app({ method: "POST", url: "/api/v1/auth/logout" });
    expect(out.statusCode).toBe(204);
    expect((await app({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(401);
    expect((await browser({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(200);
  });

  it("the token endpoint needs the CSRF header", async () => {
    const res = await k.http.inject({
      method: "POST",
      url: "/api/v1/app-auth/token",
      payload: { code: "x", codeVerifier: "y", redirectUri: REDIRECT },
    });
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("auth.csrf");
  });

  it("the token endpoint is rate limited per ip", async () => {
    const body = { code: "cap_ac_x", codeVerifier: pkce().verifier, redirectUri: REDIRECT };
    for (let i = 0; i < 60; i++) {
      expect(errCode((await exchange(body)).res)).toBe("app_auth.code_invalid");
    }
    const over = (await exchange(body)).res;
    expect(over.statusCode).toBe(429);
    expect(errCode(over)).toBe("auth.rate_limited");
    // a right code is refused too while the address is over the limit
    const { browser } = await person();
    const { code, p } = await consent(browser);
    const limited = (await exchange({ code, codeVerifier: p.verifier, redirectUri: REDIRECT })).res;
    expect(limited.statusCode).toBe(429);
  });
});
