import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExternalIdentity } from "@capybara-hq/plugin-sdk";
import {
  type LoginSourceSeed,
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
import { ExternalIdentities } from "../../src/identity/external.js";
import { createLogger } from "../../src/log.js";
import { type FakeIdpCode, fakeIdpCode } from "../fixtures/plugins/fake-idp/index.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, type CookieJar, cookieJar, setCookies } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

// The link page and the link intent (spec 2026-11-26-login-extensions §4, §5) on the fake-idp
// identity source; one app for the file.

const FAKE_IDP = fileURLToPath(new URL("../fixtures/plugins/fake-idp/index.ts", import.meta.url));
const PUBLIC = "https://cap.example";
const PW = "correct horse battery";
const SOURCE = "fake-idp:t1";

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

const seed = (over: Partial<LoginSourceSeed> = {}) =>
  seedLoginSources(db, [{ plugin: "fake-idp", ...over }]);

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  // after the truncate (it empties deployment_settings); the default: signUp link
  await seed();
  await redis.flushdb();
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

const ticketKey = (ticket: string) =>
  `capk:sso-link:${createHash("sha256").update(ticket).digest("base64url")}`;

/**
 * Starts SSO in `jar`: a sign-in through `GET …/start`, a link intent through the CSRF-protected
 * `POST …/start` (which returns the location instead of a 302).
 */
async function start(jar: CookieJar, opts: { returnTo?: string; intent?: string } = {}) {
  let res: Awaited<ReturnType<ReturnType<typeof asUser>>>;
  let location: string;
  if (opts.intent === "link") {
    res = await asUser(
      k.http,
      jar,
    )({
      method: "POST",
      url: "/api/v1/auth/sso/fake-idp/start",
      payload: { intent: "link", ...(opts.returnTo !== undefined && { returnTo: opts.returnTo }) },
    });
    expect(res.statusCode, res.body).toBe(200);
    location = (res.json() as { location: string }).location;
  } else {
    const p = new URLSearchParams();
    if (opts.returnTo !== undefined) p.set("returnTo", opts.returnTo);
    if (opts.intent !== undefined) p.set("intent", opts.intent);
    res = await asUser(
      k.http,
      jar,
    )({ method: "GET", url: `/api/v1/auth/sso/fake-idp/start?${p.toString()}` });
    expect(res.statusCode).toBe(302);
    location = String(res.headers.location);
  }
  const loc = new URL(location);
  return {
    res,
    location,
    state: loc.searchParams.get("state") ?? "",
    nonce: loc.searchParams.get("nonce") ?? "",
    challenge: loc.searchParams.get("code_challenge") ?? "",
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

/** One whole sign-in (or link intent) in `jar`; returns the callback's redirect target. */
async function sso(
  code: Omit<FakeIdpCode, "nonce">,
  opts: { jar?: CookieJar; returnTo?: string; intent?: string } = {},
) {
  const jar = opts.jar ?? cookieJar();
  const s = await start(jar, opts);
  const res = await callback(jar, {
    state: s.state,
    code: fakeIdpCode({ ...code, nonce: s.nonce, challenge: s.challenge }),
  });
  return { jar, res, location: String(res.headers.location) };
}

const LINK_PAGE = `${PUBLIC}/login/link?ticket=`;
const ticketOf = (location: string) => {
  expect(location.startsWith(LINK_PAGE)).toBe(true);
  return decodeURIComponent(location.slice(LINK_PAGE.length));
};

/** A sign-in that ends on the link page: its jar (holding `cap_sso`) and ticket. */
async function toLinkPage(code: Omit<FakeIdpCode, "nonce">) {
  const r = await sso(code);
  return { ...r, ticket: ticketOf(r.location) };
}

const view = (jar: CookieJar, ticket: string) =>
  asUser(
    k.http,
    jar,
  )({ method: "GET", url: `/api/v1/auth/sso/link?ticket=${encodeURIComponent(ticket)}` });

const submit = (jar: CookieJar, ticket: string, login: string, password = PW) =>
  asUser(
    k.http,
    jar,
  )({ method: "POST", url: "/api/v1/auth/sso/link", payload: { ticket, login, password } });

const me = async (jar: CookieJar) => {
  const res = await asUser(k.http, jar)({ method: "GET", url: "/api/v1/me" });
  return res.statusCode === 200 ? (res.json() as { account: { id: string } }).account.id : null;
};

let pwHash: Promise<string> | undefined;
async function local(login: string, email?: string) {
  pwHash ??= accounts.hashNewPassword(PW);
  const a = await accounts.createLocal(
    { login, password: PW, displayName: login, ...(email !== undefined && { email }) },
    await pwHash,
  );
  if (email !== undefined) {
    await sql`UPDATE capybara.accounts SET email_verified = true WHERE id = ${a.id}`.execute(raw);
  }
  return a;
}

async function signedIn(login: string) {
  const account = await local(login);
  const jar = cookieJar();
  const res = await asUser(
    k.http,
    jar,
  )({ method: "POST", url: "/api/v1/auth/login", payload: { login, password: PW } });
  expect(res.statusCode).toBe(200);
  return { account, jar };
}

const row = async (externalId: string) =>
  db
    .selectFrom("identities")
    .select(["account_id", "linked_via"])
    .where("source", "=", SOURCE)
    .where("external_id", "=", externalId)
    .executeTakeFirst();

const audits = (action: string) =>
  db.selectFrom("audit_events").select(["target", "detail"]).where("action", "=", action).execute();

const imIdentity = (externalId: string): ExternalIdentity => ({
  source: SOURCE,
  externalId,
  tenantId: "t1",
  emailVerified: false,
  displayName: externalId,
});

const countAccounts = async () => (await db.selectFrom("accounts").select("id").execute()).length;
const countSessions = async () => (await db.selectFrom("sessions").select("id").execute()).length;

describe("the link page", () => {
  it("unlinked sign-in lands on the link page", async () => {
    const r = await toLinkPage({ sub: "u1", name: "Zhao Hua" });
    // no account, no session, the binding cookie kept and renewed for the ticket's lifetime
    expect(await countAccounts()).toBe(0);
    expect(r.jar.get("cap_at")).toBeUndefined();
    const binding = setCookies(r.res).find((c) => c.name === "cap_sso");
    expect(binding?.value).not.toBe("");
    expect(binding?.attrs["max-age"]).toBe("600");
    expect(r.ticket).toMatch(/^cap_link_[A-Za-z0-9_-]{43}$/);
    const keys = await redis.keys("capk:sso-link:*");
    expect(keys).toEqual([ticketKey(r.ticket)]);
    expect(keys[0]).not.toContain(r.ticket);
    const ttl = await redis.ttl(ticketKey(r.ticket));
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);

    const res = await view(r.jar, r.ticket);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      plugin: "fake-idp",
      label: { zh: "测试身份源", en: "Fake IdP" },
      tenantId: "t1",
      displayName: "Zhao Hua",
      linkedToAnother: false,
    });
  });

  it("link page links and signs in", async () => {
    const alice = await local("alice");
    const r = await sso({ sub: "u2" }, { returnTo: "/chat?x=1" });
    const ticket = ticketOf(r.location);
    const res = await submit(r.jar, ticket, "alice");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      account: expect.objectContaining({ id: alice.id }),
      returnTo: "/chat?x=1",
    });
    r.jar.store(res);
    expect(await me(r.jar)).toBe(alice.id);
    expect(r.jar.get("cap_sso")).toBeUndefined();
    expect(await row("u2")).toEqual({ account_id: alice.id, linked_via: "sso" });
    expect(await audits("identity.linked")).toEqual([
      {
        target: alice.id,
        detail: expect.objectContaining({ source: SOURCE, externalId: "u2", via: "link_page" }),
      },
    ]);
    // single use
    expect(await redis.exists(ticketKey(ticket))).toBe(0);
    const again = await view(r.jar, ticket);
    expect(again.statusCode).toBe(410);
    expect(errCode(again)).toBe("sso.link_expired");
    // the linked identity now signs in directly
    const later = await sso({ sub: "u2" });
    expect(later.location).toBe(`${PUBLIC}/`);
    expect(await me(later.jar)).toBe(alice.id);
  });

  it("link page upgrades a bind row of the same account", async () => {
    const bob = await local("bob");
    await k.app.get(ExternalIdentities).link(bob.id, imIdentity("im-1"));
    const r = await toLinkPage({ sub: "im-1" });
    const v = await view(r.jar, r.ticket);
    expect((v.json() as { linkedToAnother: boolean }).linkedToAnother).toBe(true);
    const res = await submit(r.jar, r.ticket, "bob");
    expect(res.statusCode, res.body).toBe(200);
    expect(await row("im-1")).toEqual({ account_id: bob.id, linked_via: "sso" });
    expect(await audits("identity.verified")).toEqual([
      {
        target: bob.id,
        detail: expect.objectContaining({ externalId: "im-1", from: "bind", via: "link_page" }),
      },
    ]);
  });

  it("link page refuses a bind row of another account with identity.taken", async () => {
    const bob = await local("bob");
    await local("carol");
    await k.app.get(ExternalIdentities).link(bob.id, imIdentity("im-2"));
    const r = await toLinkPage({ sub: "im-2" });
    const res = await submit(r.jar, r.ticket, "carol");
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("identity.taken");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(await row("im-2")).toEqual({ account_id: bob.id, linked_via: "bind" });
    // the ticket is kept: the owner's password still upgrades it
    const ok = await submit(r.jar, r.ticket, "bob");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await row("im-2")).toEqual({ account_id: bob.id, linked_via: "sso" });
  });

  it("wrong password five times burns the ticket", async () => {
    await local("alice");
    const r = await toLinkPage({ sub: "u3" });
    for (let i = 0; i < 4; i++) {
      const res = await submit(r.jar, r.ticket, "alice", "wrong password!!");
      expect(res.statusCode).toBe(401);
      expect(errCode(res)).toBe("auth.invalid_credentials");
    }
    expect((await view(r.jar, r.ticket)).statusCode).toBe(200);
    expect(await redis.hget(ticketKey(r.ticket), "attempts")).toBe("4");
    const fifth = await submit(r.jar, r.ticket, "alice", "wrong password!!");
    expect(errCode(fifth)).toBe("auth.invalid_credentials");
    const right = await submit(r.jar, r.ticket, "alice");
    expect(right.statusCode).toBe(410);
    expect(errCode(right)).toBe("sso.link_expired");
    expect(await row("u3")).toBeUndefined();
  });

  it("wrong passwords count on the login throttlers of POST /auth/login", async () => {
    await local("alice");
    const r = await toLinkPage({ sub: "u-thr" });
    const keys = await redis.keys("throttler:{cred:login}:*");
    expect(keys).toEqual([]);
    await submit(r.jar, r.ticket, "alice", "wrong password!!");
    expect((await redis.keys("throttler:{cred:login}:*")).length).toBeGreaterThan(0);
  });

  it("only real failures burn the ticket, not a reservation that is given back", async () => {
    const alice = await local("alice");
    const r = await toLinkPage({ sub: "u-real" });
    for (let i = 0; i < 3; i++) {
      expect(errCode(await submit(r.jar, r.ticket, "alice", "wrong password!!"))).toBe(
        "auth.invalid_credentials",
      );
    }
    // another check in flight (one that will be refunded, e.g. a disabled account) holds a slot
    await redis.hincrby(ticketKey(r.ticket), "attempts", 1);
    expect(errCode(await submit(r.jar, r.ticket, "alice", "wrong password!!"))).toBe(
      "auth.invalid_credentials",
    );
    expect(await redis.hget(ticketKey(r.ticket), "failures")).toBe("4");
    await redis.hincrby(ticketKey(r.ticket), "attempts", -1);
    const ok = await submit(r.jar, r.ticket, "alice");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await row("u-real")).toEqual({ account_id: alice.id, linked_via: "sso" });
  });

  it("concurrent wrong passwords check at most five", async () => {
    await local("alice");
    const r = await toLinkPage({ sub: "u-par" });
    const res = await Promise.all(
      Array.from({ length: 7 }, () => submit(r.jar, r.ticket, "alice", "wrong password!!")),
    );
    const codes = res.map((x) => errCode(x)).sort();
    expect(codes.filter((c) => c === "auth.invalid_credentials")).toHaveLength(5);
    expect(codes.filter((c) => c === "sso.link_expired")).toHaveLength(2);
    expect(await redis.exists(ticketKey(r.ticket))).toBe(0);
  });

  it("link ticket is single use under concurrency", async () => {
    const alice = await local("alice");
    const r = await toLinkPage({ sub: "u4" });
    const [a, b] = await Promise.all([
      submit(r.jar, r.ticket, "alice"),
      submit(r.jar, r.ticket, "alice"),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 410]);
    expect(errCode(a.statusCode === 410 ? a : b)).toBe("sso.link_expired");
    expect(await row("u4")).toEqual({ account_id: alice.id, linked_via: "sso" });
    expect(await audits("identity.linked")).toHaveLength(1);
    expect(
      await db.selectFrom("sessions").select("id").where("account_id", "=", alice.id).execute(),
    ).toHaveLength(1);
  });

  it("disabled account → auth.account_disabled, attempts kept", async () => {
    const dan = await local("dan");
    await sql`UPDATE capybara.accounts SET status = 'disabled' WHERE id = ${dan.id}`.execute(raw);
    const r = await toLinkPage({ sub: "u5" });
    for (let i = 0; i < 6; i++) {
      const res = await submit(r.jar, r.ticket, "dan");
      expect(res.statusCode).toBe(403);
      expect(errCode(res)).toBe("auth.account_disabled");
    }
    expect(await redis.hget(ticketKey(r.ticket), "attempts")).toBe("0");
    expect((await view(r.jar, r.ticket)).statusCode).toBe(200);
    expect(await row("u5")).toBeUndefined();
    expect(await countSessions()).toBe(0);
  });

  it("must-change-password account signs in and is sent to change-password", async () => {
    const eve = await local("eve");
    await sql`UPDATE capybara.accounts SET must_change_password = true WHERE id = ${eve.id}`.execute(
      raw,
    );
    const r = await toLinkPage({ sub: "u6" });
    const res = await submit(r.jar, r.ticket, "eve");
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { account: { mustChangePassword: boolean } }).account).toEqual(
      expect.objectContaining({ id: eve.id, mustChangePassword: true }),
    );
    r.jar.store(res);
    // the same session as a password sign-in: only the change-password routes until it changes
    expect(await me(r.jar)).toBe(eve.id);
    const other = await asUser(k.http, r.jar)({ method: "GET", url: "/api/v1/me/identities" });
    expect(other.statusCode).toBe(403);
    expect(errCode(other)).toBe("auth.password_change_required");
    expect(await row("u6")).toEqual({ account_id: eve.id, linked_via: "sso" });
  });

  it("binding cookie mismatch → sso.session_mismatch, the ticket untouched", async () => {
    await local("alice");
    const r = await toLinkPage({ sub: "u7" });
    for (const jar of [cookieJar({ cap_sso: "B".repeat(43) }), cookieJar()]) {
      const v = await view(jar, r.ticket);
      expect(v.statusCode).toBe(403);
      expect(errCode(v)).toBe("sso.session_mismatch");
      const p = await submit(jar, r.ticket, "alice");
      expect(p.statusCode).toBe(403);
      expect(errCode(p)).toBe("sso.session_mismatch");
    }
    expect(await redis.hget(ticketKey(r.ticket), "attempts")).toBe("0");
    expect((await submit(r.jar, r.ticket, "alice")).statusCode).toBe(200);
  });

  it("POST without the CSRF header is refused, the ticket untouched", async () => {
    await local("alice");
    const r = await toLinkPage({ sub: "u-csrf" });
    const res = await asUser(
      k.http,
      r.jar,
    )({
      method: "POST",
      url: "/api/v1/auth/sso/link",
      payload: { ticket: r.ticket, login: "alice", password: PW },
      csrf: false,
    });
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("auth.csrf");
    expect((await view(r.jar, r.ticket)).statusCode).toBe(200);
  });

  it("unknown or malformed tickets → sso.link_expired", async () => {
    const r = await toLinkPage({ sub: "u-unknown" });
    for (const t of [`cap_link_${"A".repeat(43)}`, "cap_link_x", ""]) {
      const v = await view(r.jar, t);
      expect(v.statusCode).toBe(410);
      expect(errCode(v)).toBe("sso.link_expired");
    }
  });
});

describe("the link intent", () => {
  it("link intent without the same session → sso.session_mismatch, no account created", async () => {
    // a link intent cannot start signed out
    const anon = await asUser(
      k.http,
      cookieJar(),
    )({ method: "POST", url: "/api/v1/auth/sso/fake-idp/start", payload: { intent: "link" } });
    expect(anon.statusCode).toBe(401);
    expect(await redis.keys("capk:sso-state:*")).toEqual([]);

    // started as alice, called back signed out (session expired) or as bob (another tab)
    await seed({ signUp: "create" });
    const alice = await signedIn("alice");
    const bob = await signedIn("bob");
    for (const swap of ["signed-out", "bob"] as const) {
      const jar = alice.jar.clone();
      const s = await start(jar, { intent: "link", returnTo: "/account/identities" });
      jar.delete("cap_at");
      jar.delete("cap_rt");
      if (swap === "bob") {
        for (const name of ["cap_at", "cap_rt"]) {
          const v = bob.jar.get(name);
          if (v !== undefined) jar.set(name, v);
        }
      }
      const before = { accounts: await countAccounts(), sessions: await countSessions() };
      const res = await callback(jar, {
        state: s.state,
        code: fakeIdpCode({ sub: `u-mis-${swap}`, nonce: s.nonce, challenge: s.challenge }),
      });
      expect(res.headers.location).toBe(`${PUBLIC}/login?error=sso.session_mismatch`);
      expect(await row(`u-mis-${swap}`)).toBeUndefined();
      expect(await countAccounts()).toBe(before.accounts);
      expect(await countSessions()).toBe(before.sessions);
      expect(await me(jar)).toBe(swap === "bob" ? bob.account.id : null);
    }
  });

  it("a cross-site GET start with intent=link creates no state and links nothing", async () => {
    const alice = await signedIn("alice");
    // a top-level cross-site navigation carries the Lax session cookie
    const res = await asUser(
      k.http,
      alice.jar,
    )({
      method: "GET",
      url: "/api/v1/auth/sso/fake-idp/start?intent=link&returnTo=%2Faccount%2Fidentities",
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${PUBLIC}/login?error=sso.session_mismatch`);
    expect(await redis.keys("capk:sso-state:*")).toEqual([]);
    expect(setCookies(res).find((c) => c.name === "cap_sso")).toBeUndefined();
    expect(
      await db.selectFrom("identities").select("source").where("source", "=", SOURCE).execute(),
    ).toEqual([]);
  });

  it("POST start without the CSRF header → 403, no state", async () => {
    const alice = await signedIn("alice");
    const res = await asUser(
      k.http,
      alice.jar,
    )({
      method: "POST",
      url: "/api/v1/auth/sso/fake-idp/start",
      payload: { intent: "link" },
      csrf: false,
    });
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("auth.csrf");
    expect(await redis.keys("capk:sso-state:*")).toEqual([]);
  });

  it("POST start writes the binding cookie and a state recording the link intent", async () => {
    const alice = await signedIn("alice");
    const s = await start(alice.jar, { intent: "link", returnTo: "/account/identities" });
    expect(s.location.startsWith("https://idp.example/authorize?")).toBe(true);
    const c = setCookies(s.res).find((x) => x.name === "cap_sso");
    expect(c?.attrs.httponly).toBe(true);
    expect(c?.attrs.path).toBe("/api/v1/auth/sso");
    const rec = JSON.parse((await redis.get(`capk:sso-state:${s.state}`)) ?? "{}") as {
      intent?: string;
      sessionAccountId?: string;
    };
    expect(rec).toEqual(
      expect.objectContaining({ intent: "link", sessionAccountId: alice.account.id }),
    );
  });

  it("link intent links to the signed-in account, session unchanged", async () => {
    const alice = await signedIn("alice");
    const sessions = await countSessions();
    const atBefore = alice.jar.get("cap_at");
    const r = await sso(
      { sub: "u-link" },
      { jar: alice.jar, intent: "link", returnTo: "/account/identities" },
    );
    expect(r.location).toBe(`${PUBLIC}/account/identities`);
    expect(alice.jar.get("cap_at")).toBe(atBefore);
    expect(await countSessions()).toBe(sessions);
    expect(await me(alice.jar)).toBe(alice.account.id);
    expect(await row("u-link")).toEqual({ account_id: alice.account.id, linked_via: "sso" });
    expect(await audits("identity.linked")).toEqual([
      { target: alice.account.id, detail: expect.objectContaining({ via: "oauth" }) },
    ]);
    // once more: already linked, back to the page
    const again = await sso(
      { sub: "u-link" },
      { jar: alice.jar, intent: "link", returnTo: "/account/identities" },
    );
    expect(again.location).toBe(`${PUBLIC}/account/identities`);
  });

  it("link intent for an identity of another account → back to the page with identity.taken", async () => {
    const bob = await local("bob");
    await k.app.get(ExternalIdentities).link(bob.id, imIdentity("im-b"));
    const alice = await signedIn("alice");
    const r = await sso(
      { sub: "im-b" },
      { jar: alice.jar, intent: "link", returnTo: "/account/identities" },
    );
    expect(r.location).toBe(`${PUBLIC}/account/identities?error=identity.taken`);
    expect(await row("im-b")).toEqual({ account_id: bob.id, linked_via: "bind" });
    expect(await me(alice.jar)).toBe(alice.account.id);
  });
});

describe("sign-up and trust follow the setting", () => {
  it("signUp create keeps creating accounts", async () => {
    await seed({ signUp: "create" });
    const r = await sso({ sub: "u-new", name: "New" });
    expect(r.location).toBe(`${PUBLIC}/`);
    const id = await me(r.jar);
    expect(id).not.toBeNull();
    expect(await row("u-new")).toEqual({ account_id: id, linked_via: "sso" });
    expect(await audits("account.created")).toHaveLength(1);
  });

  it("trusted email merge reads the setting", async () => {
    const alice = await local("alice", "alice@corp.example");
    const code = { sub: "u-mail", email: "alice@corp.example", emailVerified: true };
    // not trusted: the link page, nothing merged
    const untrusted = await sso(code);
    ticketOf(untrusted.location);
    expect(await row("u-mail")).toBeUndefined();
    // trusted: merged into alice and signed in
    await seed({ trustedTenants: ["t1"] });
    const trusted = await sso(code);
    expect(trusted.location).toBe(`${PUBLIC}/`);
    expect(await me(trusted.jar)).toBe(alice.id);
    expect(await row("u-mail")).toEqual({ account_id: alice.id, linked_via: "sso" });
  });

  it("a disabled merge target gets no row: auth.account_disabled", async () => {
    const alice = await local("alice", "alice@corp.example");
    await sql`UPDATE capybara.accounts SET status = 'disabled' WHERE id = ${alice.id}`.execute(raw);
    await seed({ trustedTenants: ["t1"] });
    const r = await sso({ sub: "u-mail-off", email: "alice@corp.example", emailVerified: true });
    expect(r.location).toBe(`${PUBLIC}/login?error=auth.account_disabled`);
    expect(await row("u-mail-off")).toBeUndefined();
    expect(await audits("identity.linked")).toEqual([]);
  });

  it("a link intent links to the session account even when the email would merge elsewhere", async () => {
    await local("alice", "alice@corp.example");
    await seed({ trustedTenants: ["t1"] });
    const bob = await signedIn("bob");
    const r = await sso(
      { sub: "u-mail-2", email: "alice@corp.example", emailVerified: true },
      { jar: bob.jar, intent: "link", returnTo: "/account/identities" },
    );
    expect(r.location).toBe(`${PUBLIC}/account/identities`);
    expect(await row("u-mail-2")).toEqual({ account_id: bob.account.id, linked_via: "sso" });
  });

  it("source switched off between start and callback → sso.unavailable, no row", async () => {
    await seed({ signUp: "create" });
    const jar = cookieJar();
    const s = await start(jar);
    await seed({ enabled: false, signUp: "create" });
    const res = await callback(jar, {
      state: s.state,
      code: fakeIdpCode({ sub: "u-off", nonce: s.nonce, challenge: s.challenge }),
    });
    expect(res.headers.location).toBe(`${PUBLIC}/login?error=sso.unavailable`);
    expect(await row("u-off")).toBeUndefined();
    expect(await countAccounts()).toBe(0);

    // a pending link whose source goes off: sso.link_expired, no row, the ticket dropped
    await seed();
    await local("alice");
    const r = await toLinkPage({ sub: "u-off-2" });
    await seed({ enabled: false });
    const post = await submit(r.jar, r.ticket, "alice");
    expect(post.statusCode).toBe(410);
    expect(errCode(post)).toBe("sso.link_expired");
    expect(await row("u-off-2")).toBeUndefined();
    expect(await redis.exists(ticketKey(r.ticket))).toBe(0);
  });
});
