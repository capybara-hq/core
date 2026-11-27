import { fileURLToPath } from "node:url";
import {
  fakeExtensionEntry,
  seedLoginSources,
  startFakeMcpServer,
  startFakeOAuthServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { fakeIdpCode } from "../fixtures/plugins/fake-idp/index.js";
import { truncateTables } from "../helpers/db.js";
import { setCookies } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import {
  enableConnectorExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * The redeem (shell external authorization spec §2): the web page `/handoff/<ticket>` redeems the
 * ticket in the person's signed-in browser; the flow starts there with this browser's binding
 * cookie and comes back to the handoff done page.
 */

const CONNECTOR = fakeExtensionEntry("fake-connector");
const FAKE_IDP = fileURLToPath(new URL("../fixtures/plugins/fake-idp/index.ts", import.meta.url));
const PUBLIC_URL = "https://capybara.example.com";
const CALLBACK = `${PUBLIC_URL}/api/v1/oauth/callback`;
const HANDOFF_URL_RE = /^https:\/\/capybara\.example\.com\/handoff\/(cap_ho_[A-Za-z0-9_-]{43})$/;
const REDEEM = "/api/v1/auth/handoffs/redeem";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let req: Req;
let ownerId: string;
let orgId: string;
const stops: (() => Promise<void>)[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [CONNECTOR, FAKE_IDP],
        extensionConfig: {
          "fake-connector": {},
          "fake-idp": { tenant: "t1", clientSecret: "s3cret" },
        },
        roles: ["api", "worker"],
        http: { port: 0, publicUrl: PUBLIC_URL },
        auth: {
          cookieSecure: false,
          appRedirectUris: ["capybara://auth/callback"],
        },
        tools: { timeoutMs: 5_000, oauthAllowInsecureLoopback: true },
      },
    ),
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  // after the truncate: it empties deployment_settings
  await seedLoginSources(db, [{ plugin: "fake-idp", signUp: "create" }]);
  await redis.flushdb();
  ownerId = (
    await accountsFor(db).createLocal({
      login: "owner",
      password: PW,
      displayName: "Olive",
      email: "olive@example.com",
    })
  ).id;
  req = await session(k, "owner");
  const org = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  orgId = (org.json() as { org: { id: string } }).org.id;
  await enableConnectorExtensions(k, orgId);
});

afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

/** A fake authorization server, an MCP server that requires its tokens and a DCR connector. */
async function installDcr(): Promise<string> {
  const as = await startFakeOAuthServer({});
  stops.push(() => as.stop());
  const mcp = await startFakeMcpServer({
    verifyBearer: (t) => as.verify(t),
    protectedResource: { authorizationServers: [as.issuer], advertise: "header" },
    tools: [],
  });
  stops.push(() => mcp.stop());
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/connectors`,
    payload: {
      name: "Docs",
      slug: "docs",
      connector: "fake",
      endpoint: { url: mcp.url },
      auth: { type: "oauth_code", ownership: "personal", discovery: "mcp", client: "dcr" },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { connector: { id: string } }).connector.id;
}

/** A connector handoff start as `as`; returns the ticket. */
async function connectHandoff(
  connectorId: string,
  handoff: { returnScheme?: string } = { returnScheme: "capybara" },
  as: Req = req,
): Promise<string> {
  const res = await as({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/connectors/${connectorId}/connect`,
    payload: { returnTo: "/en/settings/connectors", handoff },
  });
  expect(res.statusCode, res.body).toBe(200);
  const m = HANDOFF_URL_RE.exec((res.json() as { handoffUrl: string }).handoffUrl);
  expect(m).not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
}

/** A login-method link handoff start; returns the ticket. */
async function linkHandoff(handoff: { returnScheme?: string } = { returnScheme: "capybara" }) {
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/sso/fake-idp/start",
    payload: { intent: "link", returnTo: "/account/identities", handoff },
  });
  expect(res.statusCode, res.body).toBe(200);
  const m = HANDOFF_URL_RE.exec((res.json() as { handoffUrl: string }).handoffUrl);
  expect(m).not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
}

const redeem = (ticket: unknown, as: Req = req, csrf = true) =>
  as({ method: "POST", url: REDEEM, payload: { ticket }, csrf });

/** The browser at the authorization URL (the fake server approves): the callback's path + query. */
async function approve(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get("location") as string);
  expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
  return `${back.pathname}${back.search}`;
}

async function newMember(login: string, email?: string): Promise<{ id: string; req: Req }> {
  const acc = await accountsFor(db).createLocal({
    login,
    password: PW,
    displayName: login,
    ...(email !== undefined && { email }),
  });
  await db
    .insertInto("memberships")
    .values({ org_id: orgId, account_id: acc.id, role: "member" })
    .execute();
  return { id: acc.id, req: await session(k, login) };
}

describe("connector redeem", () => {
  it("redeem sets the binding cookie and the callback lands on the done page", async () => {
    const connectorId = await installDcr();
    const ticket = await connectHandoff(connectorId);
    const res = await redeem(ticket);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { location } = res.json() as { location: string };
    expect(new URL(location).pathname).toBe("/authorize");
    const cookie = setCookies(res).find((c) => c.name === "cap_oauth");
    expect(cookie?.attrs.path).toBe("/api/v1/oauth/callback");
    expect(cookie?.attrs.httponly).toBe(true);
    expect(cookie?.attrs.samesite).toBe("Lax");

    const callback = await req({ method: "GET", url: await approve(location), csrf: false });
    expect(callback.statusCode, callback.body).toBe(302);
    const done = new URLSearchParams({
      kind: "connector",
      org: orgId,
      connector: connectorId,
      returnTo: "/en/settings/connectors",
      scheme: "capybara",
      connected: connectorId,
    });
    expect(callback.headers.location).toBe(`${PUBLIC_URL}/handoff/done?${done.toString()}`);
    const after = await req({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/connectors/${connectorId}`,
    });
    expect(
      (after.json() as { connector: { credential: { status: string } } }).connector.credential
        .status,
    ).toBe("connected");
  });

  it("no scheme: the done path carries no scheme", async () => {
    const connectorId = await installDcr();
    const ticket = await connectHandoff(connectorId, {});
    const res = await redeem(ticket);
    expect(res.statusCode, res.body).toBe(200);
    const callback = await req({
      method: "GET",
      url: await approve((res.json() as { location: string }).location),
      csrf: false,
    });
    const back = new URL(callback.headers.location as string);
    expect(back.pathname).toBe("/handoff/done");
    expect(back.searchParams.has("scheme")).toBe(false);
    expect(back.searchParams.get("connected")).toBe(connectorId);
  });

  it("redeem twice → handoff.invalid", async () => {
    const connectorId = await installDcr();
    const ticket = await connectHandoff(connectorId);
    expect((await redeem(ticket)).statusCode).toBe(200);
    const again = await redeem(ticket);
    expect(again.statusCode).toBe(410);
    expect(errCode(again)).toBe("handoff.invalid");
  });

  it("account mismatch burns the ticket", async () => {
    const connectorId = await installDcr();
    const ticket = await connectHandoff(connectorId);
    const bob = await newMember("bob");
    const res = await redeem(ticket, bob.req);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({
      error: {
        code: "handoff.account_mismatch",
        details: [{ displayName: "Olive", email: "olive@example.com" }],
      },
    });
    // no flow started for the session's account, no binding cookie
    expect(setCookies(res).map((c) => c.name)).not.toContain("cap_oauth");
    expect(await redis.keys("capk:oauth-state:*")).toEqual([]);
    // the ticket is spent for its own account too
    const own = await redeem(ticket);
    expect(own.statusCode).toBe(410);
    expect(errCode(own)).toBe("handoff.invalid");
  });

  it("a member who lost connectors.use is refused", async () => {
    const connectorId = await installDcr();
    const bob = await newMember("bob");
    const ticket = await connectHandoff(connectorId, { returnScheme: "capybara" }, bob.req);
    await db.deleteFrom("memberships").where("account_id", "=", bob.id).execute();
    const res = await redeem(ticket, bob.req);
    expect(res.statusCode, res.body).toBe(403);
    expect(errCode(res)).toBe("forbidden");
    expect(await redis.keys("capk:oauth-state:*")).toEqual([]);
    expect(setCookies(res).map((c) => c.name)).not.toContain("cap_oauth");
  });

  it("a deleted org → org.not_found", async () => {
    const connectorId = await installDcr();
    const ticket = await connectHandoff(connectorId);
    await db.updateTable("orgs").set({ deleted_at: new Date() }).where("id", "=", orgId).execute();
    const res = await redeem(ticket);
    expect(res.statusCode, res.body).toBe(404);
    expect(errCode(res)).toBe("org.not_found");
    expect(await redis.keys("capk:oauth-state:*")).toEqual([]);
  });
});

describe("identity link redeem", () => {
  /** The redeem's authorize URL, then the source's redirect back in the same session. */
  async function linkRoundTrip(query: (u: URL) => Record<string, string>) {
    const ticket = await linkHandoff();
    const res = await redeem(ticket);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const authorize = new URL((res.json() as { location: string }).location);
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://idp.example/authorize");
    const cookie = setCookies(res).find((c) => c.name === "cap_sso");
    expect(cookie?.attrs.path).toBe("/api/v1/auth/sso");
    expect(cookie?.attrs.httponly).toBe(true);
    const cb = await req({
      method: "GET",
      url: `/api/v1/auth/sso/fake-idp/callback?${new URLSearchParams(query(authorize)).toString()}`,
      csrf: false,
    });
    expect(cb.statusCode, cb.body).toBe(302);
    return String(cb.headers.location);
  }

  const done = new URLSearchParams({
    kind: "identity-link",
    plugin: "fake-idp",
    returnTo: "/account/identities",
    scheme: "capybara",
  });

  it("identity link redeem links the account and lands on the done page", async () => {
    const location = await linkRoundTrip((u) => ({
      state: u.searchParams.get("state") ?? "",
      code: fakeIdpCode({
        sub: "u-handoff",
        nonce: u.searchParams.get("nonce") ?? "",
        challenge: u.searchParams.get("code_challenge") ?? "",
      }),
    }));
    expect(location).toBe(`${PUBLIC_URL}/handoff/done?${done.toString()}`);
    const rows = await db
      .selectFrom("identities")
      .select(["account_id"])
      .where("source", "=", "fake-idp:t1")
      .where("external_id", "=", "u-handoff")
      .execute();
    expect(rows).toEqual([{ account_id: ownerId }]);
  });

  it("a source error lands on the done page with the error", async () => {
    const location = await linkRoundTrip((u) => ({
      state: u.searchParams.get("state") ?? "",
      error: "access_denied",
    }));
    expect(location).toBe(`${PUBLIC_URL}/handoff/done?${done.toString()}&error=sso.access_denied`);
  });

  it("a source switched off before the redeem answers the done page with the error", async () => {
    const ticket = await linkHandoff();
    await seedLoginSources(db, [{ plugin: "fake-idp", enabled: false }]);
    const res = await redeem(ticket);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      location: `${PUBLIC_URL}/handoff/done?${done.toString()}&error=sso.unavailable`,
    });
    expect(await redis.keys("capk:sso-state:*")).toEqual([]);
  });

  it("account mismatch on a link ticket names the owner and starts nothing", async () => {
    const ticket = await linkHandoff();
    const bob = await newMember("bob");
    const res = await redeem(ticket, bob.req);
    expect(res.statusCode, res.body).toBe(403);
    expect(errCode(res)).toBe("handoff.account_mismatch");
    expect(await redis.keys("capk:sso-state:*")).toEqual([]);
    expect(errCode(await redeem(ticket))).toBe("handoff.invalid");
  });
});

describe("redeem refusals", () => {
  it("redeem without CSRF header → 403", async () => {
    const connectorId = await installDcr();
    const ticket = await connectHandoff(connectorId);
    const res = await redeem(ticket, req, false);
    expect(res.statusCode).toBe(403);
    // refused before the ticket was taken
    expect((await redeem(ticket)).statusCode).toBe(200);
  });

  it("with a PAT → auth.session_required", async () => {
    const pat = await req({ method: "POST", url: "/api/v1/me/tokens", payload: { name: "x" } });
    expect(pat.statusCode).toBe(201);
    const token = (pat.json() as { token: string }).token;
    const ticket = await linkHandoff();
    const res = await k.http.inject({
      method: "POST",
      url: REDEEM,
      payload: { ticket },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("auth.session_required");
  });

  it("signed out → 401", async () => {
    const res = await k.http.inject({
      method: "POST",
      url: REDEEM,
      payload: { ticket: "cap_ho_x" },
      headers: { "x-capybara-csrf": "1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("unknown or malformed ticket → handoff.invalid", async () => {
    for (const ticket of [`cap_ho_${"A".repeat(43)}`, "cap_ho_short", "not-a-ticket", ""]) {
      const res = await redeem(ticket);
      expect(res.statusCode, ticket).toBe(410);
      expect(errCode(res)).toBe("handoff.invalid");
    }
    const tooLong = await redeem("x".repeat(101));
    expect(tooLong.statusCode).toBe(400);
    expect(errCode(tooLong)).toBe("validation_failed");
    const extra = await req({ method: "POST", url: REDEEM, payload: { ticket: "x", more: 1 } });
    expect(errCode(extra)).toBe("validation_failed");
  });

  it("a stored value that is not a handoff record → handoff.invalid", async () => {
    const ticket = await linkHandoff();
    const [key] = await redis.keys("capk:handoff:*");
    await redis.set(key as string, JSON.stringify({ kind: "connector", accountId: ownerId }));
    const res = await redeem(ticket);
    expect(res.statusCode).toBe(410);
    expect(errCode(res)).toBe("handoff.invalid");
    const other = await linkHandoff();
    const [key2] = await redis.keys("capk:handoff:*");
    await redis.set(key2 as string, "not json");
    expect(errCode(await redeem(other))).toBe("handoff.invalid");
  });
});
