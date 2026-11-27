import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type FakeMcpServer,
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
import { withOrgScope } from "../../src/infra/database/org-scope.js";
import { Credentials } from "../../src/tools/credentials.js";
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
 * The handoff starts (shell external authorization spec §1): with `handoff`, the connector
 * connect and the login-method link start check what the normal start checks, store a single-use
 * ticket and answer a handoff URL, with no binding cookie and no OAuth / SSO state.
 */

const CONNECTOR = fakeExtensionEntry("fake-connector");
const FAKE_IDP = fileURLToPath(new URL("../fixtures/plugins/fake-idp/index.ts", import.meta.url));
const PUBLIC_URL = "https://capybara.example.com";
const HANDOFF_URL_RE = /^https:\/\/capybara\.example\.com\/handoff\/(cap_ho_[A-Za-z0-9_-]{43})$/;

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let req: Req;
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
          appRedirectUris: ["capybara://auth/callback", "https://app.example.com/cb"],
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
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
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
const ticketKey = (ticket: string) =>
  `capk:handoff:${createHash("sha256").update(ticket).digest("base64url")}`;

/** A fake authorization server and an MCP server that requires its tokens. */
async function mcpServer(): Promise<FakeMcpServer> {
  const as = await startFakeOAuthServer({});
  stops.push(() => as.stop());
  const mcp = await startFakeMcpServer({
    verifyBearer: (t) => as.verify(t),
    protectedResource: { authorizationServers: [as.issuer], advertise: "header" },
    tools: [],
  });
  stops.push(() => mcp.stop());
  return mcp;
}

async function installDcr(): Promise<string> {
  const mcp = await mcpServer();
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

const connect = (connectorId: string, payload: Record<string, unknown>, as: Req = req) =>
  as({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/connectors/${connectorId}/connect`,
    payload,
  });

const startLink = (plugin: string, payload: Record<string, unknown>) =>
  req({
    method: "POST",
    url: `/api/v1/auth/sso/${plugin}/start`,
    payload: { intent: "link", ...payload },
  });

async function handoffKeys(): Promise<string[]> {
  return redis.keys("capk:handoff:*");
}

describe("connector handoff start", () => {
  it("connector handoff start returns a handoff URL and no cookie", async () => {
    const connectorId = await installDcr();
    const res = await connect(connectorId, {
      returnTo: "/en/settings/connectors",
      handoff: { returnScheme: "capybara" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { handoffUrl: string; authorizationUrl?: string };
    expect(body.authorizationUrl).toBeUndefined();
    const m = HANDOFF_URL_RE.exec(body.handoffUrl);
    expect(m, body.handoffUrl).not.toBeNull();
    const ticket = (m as RegExpExecArray)[1] as string;
    expect(setCookies(res).map((c) => c.name)).not.toContain("cap_oauth");
    // Redis holds the ticket's hash only, for ten minutes; no OAuth state was started
    const ttl = await redis.ttl(ticketKey(ticket));
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
    expect(await redis.keys(`*${ticket}*`)).toEqual([]);
    expect(await redis.keys("capk:oauth-state:*")).toEqual([]);
    const rec = JSON.parse((await redis.get(ticketKey(ticket))) as string);
    expect(rec).toMatchObject({
      kind: "connector",
      orgId,
      connectorId,
      returnTo: "/en/settings/connectors",
      returnScheme: "capybara",
    });
  });

  it("a handoff without a scheme keeps the default return page", async () => {
    const connectorId = await installDcr();
    const res = await connect(connectorId, { handoff: {} });
    expect(res.statusCode, res.body).toBe(200);
    const ticket = (HANDOFF_URL_RE.exec((res.json() as { handoffUrl: string }).handoffUrl) ??
      [])[1] as string;
    const rec = JSON.parse((await redis.get(ticketKey(ticket))) as string);
    expect(rec.returnTo).toBe("/account/connections");
    expect(rec.returnScheme).toBeUndefined();
  });

  it("scheme not allowed → 400 handoff.scheme_not_allowed", async () => {
    const connectorId = await installDcr();
    for (const returnScheme of ["evil", "CAPYBARA", "https"]) {
      const res = await connect(connectorId, { handoff: { returnScheme } });
      expect(res.statusCode, res.body).toBe(400);
      expect(errCode(res)).toBe("handoff.scheme_not_allowed");
    }
    expect(await handoffKeys()).toEqual([]);
  });

  it("refuses unknown handoff fields", async () => {
    const connectorId = await installDcr();
    const res = await connect(connectorId, { handoff: { returnScheme: "capybara", x: 1 } });
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe("validation_failed");
  });

  it("handoff start refuses an unconfigured connector", async () => {
    const connectorId = await installDcr();
    // a stored client without an authorization endpoint: members cannot connect it yet
    const creds = k.app.get(Credentials);
    // the first normal connect registers the DCR client
    const first = await connect(connectorId, {});
    expect(first.statusCode, first.body).toBe(200);
    await withOrgScope(orgId, async () => {
      const client = await creds.oauthClient(orgId, connectorId);
      expect(client).not.toBeNull();
      const { authorizationEndpoint: _drop, ...rest } = client as NonNullable<typeof client>;
      await creds.setOAuthClient(orgId, connectorId, rest);
    });
    await redis.flushdb();
    const res = await connect(connectorId, { handoff: { returnScheme: "capybara" } });
    expect(res.statusCode, res.body).toBe(502);
    expect(errCode(res)).toBe("connector.connect_failed");
    expect(await handoffKeys()).toEqual([]);
  });

  it("a non-oauth_code connector → validation_failed, no ticket", async () => {
    const mcp = await startFakeMcpServer({ tools: [] });
    stops.push(() => mcp.stop());
    const created = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: "Open",
        slug: "open",
        connector: "fake",
        endpoint: { url: mcp.url },
        auth: { type: "none" },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { connector: { id: string } }).connector.id;
    const res = await connect(id, { handoff: { returnScheme: "capybara" } });
    expect(res.statusCode, res.body).toBe(400);
    expect(errCode(res)).toBe("validation_failed");
    expect(await handoffKeys()).toEqual([]);
  });

  it("an unknown connector → connector.not_found, no ticket", async () => {
    const res = await connect("nope", { handoff: { returnScheme: "capybara" } });
    expect(res.statusCode, res.body).toBe(404);
    expect(errCode(res)).toBe("connector.not_found");
    expect(await handoffKeys()).toEqual([]);
  });
});

describe("login-method link handoff start", () => {
  it("link handoff start returns a handoff URL", async () => {
    const res = await startLink("fake-idp", {
      returnTo: "/account/identities",
      handoff: { returnScheme: "capybara" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { handoffUrl: string; location?: string };
    expect(body.location).toBeUndefined();
    const ticket = (HANDOFF_URL_RE.exec(body.handoffUrl) ?? [])[1] as string;
    expect(ticket).toBeDefined();
    expect(setCookies(res).map((c) => c.name)).not.toContain("cap_sso");
    expect(await redis.keys("capk:sso-state:*")).toEqual([]);
    const rec = JSON.parse((await redis.get(ticketKey(ticket))) as string);
    expect(rec).toMatchObject({
      kind: "identity-link",
      plugin: "fake-idp",
      returnTo: "/account/identities",
      returnScheme: "capybara",
    });
    const ttl = await redis.ttl(ticketKey(ticket));
    expect(ttl).toBeGreaterThan(590);
  });

  it("an unsafe returnTo becomes the site root", async () => {
    const res = await startLink("fake-idp", { returnTo: "//evil.example", handoff: {} });
    expect(res.statusCode, res.body).toBe(200);
    const ticket = (HANDOFF_URL_RE.exec((res.json() as { handoffUrl: string }).handoffUrl) ??
      [])[1] as string;
    expect(JSON.parse((await redis.get(ticketKey(ticket))) as string).returnTo).toBe("/");
  });

  it("link handoff with the source off answers a location", async () => {
    await seedLoginSources(db, [{ plugin: "fake-idp", enabled: false }]);
    const res = await startLink("fake-idp", {
      returnTo: "/account/identities",
      handoff: { returnScheme: "capybara" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      location: `${PUBLIC_URL}/account/identities?error=sso.unavailable`,
    });
    expect(await handoffKeys()).toEqual([]);
    const unknown = await startLink("not-installed", { handoff: {} });
    expect((unknown.json() as { location: string }).location).toMatch(/\?error=sso\.unavailable$/);
    expect(await handoffKeys()).toEqual([]);
  });

  it("scheme not allowed → 400 handoff.scheme_not_allowed", async () => {
    const res = await startLink("fake-idp", { handoff: { returnScheme: "evil" } });
    expect(res.statusCode, res.body).toBe(400);
    expect(errCode(res)).toBe("handoff.scheme_not_allowed");
    expect(await handoffKeys()).toEqual([]);
  });

  it("a PAT cannot start a link handoff", async () => {
    const pat = await req({ method: "POST", url: "/api/v1/me/tokens", payload: { name: "x" } });
    expect(pat.statusCode).toBe(201);
    const token = (pat.json() as { token: string }).token;
    const res = await k.http.inject({
      method: "POST",
      url: "/api/v1/auth/sso/fake-idp/start",
      payload: { intent: "link", handoff: { returnScheme: "capybara" } },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("auth.session_required");
    expect(await handoffKeys()).toEqual([]);
  });
});
