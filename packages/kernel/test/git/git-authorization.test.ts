import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type FakeOAuthServer,
  startFakeOAuthServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import {
  type ConnectorAuth,
  CredentialMissing,
  type Credentials,
} from "../../src/tools/credentials.js";
import { credentialsFor } from "../helpers/tools.js";

/**
 * `Credentials.gitAuthorization` / `gitUnauthorized` (sandbox git credentials spec §5, §6.1): the
 * Basic value is built inside `Credentials` with the git host's username, an expiring OAuth token
 * is refreshed first, a 401 force-refreshes, another account's credential is never used, and the
 * values are registered for log redaction.
 */

let pgc: TestContainer;
let rdc: TestContainer;
// biome-ignore lint/suspicious/noExplicitAny: the test database has no table types
let pool: Kysely<any>;
let redis: Redis;
let creds: Credentials;
let log: ReturnType<typeof createLogger>;
const lines: string[] = [];
const stops: (() => Promise<void>)[] = [];
const ring = createKeyring(randomBytes(32), []);

const ORG = "org_git_auth";
const ALICE = "acct_alice";
const BOB = "acct_bob";
const OAUTH: ConnectorAuth = {
  type: "oauth_code",
  ownership: "personal",
  discovery: "manual",
  authorizationUrl: "unused",
  tokenUrl: "unused",
  client: "manual",
};
const BEARER: ConnectorAuth = { type: "bearer", ownership: "personal" };
const ORG_BEARER: ConnectorAuth = { type: "bearer", ownership: "org" };
const BASIC: ConnectorAuth = { type: "basic", ownership: "personal" };

const config = KernelConfigSchema.parse({
  db: { url: "postgres://unused" },
  redis: { url: "redis://unused" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
  tools: { timeoutMs: 5_000, oauthAllowInsecureLoopback: true },
});

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  pool = createDb(pgc.url, 5);
  redis = new Redis(rdc.url);
  log = createLogger("debug", { write: (l) => lines.push(l) });
  creds = credentialsFor(kernelDb(pool), ring, log, {
    config: () => config,
    locks: new LockService(redis, log),
    redis,
  });
});

afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

afterAll(async () => {
  redis?.disconnect();
  await pool?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const passwordOf = (header: string) => {
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  return decoded.slice(decoded.indexOf(":") + 1);
};

const pub = { clientId: "pub-client" };

/** An authorization code + PKCE round trip: a real token pair from the fake server. */
async function issueTokens(as: FakeOAuthServer) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${as.issuer}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: pub.clientId,
    redirect_uri: "https://cb.example.com/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s",
  }).toString();
  const res = await fetch(url, { redirect: "manual" });
  const code = new URL(res.headers.get("location") as string).searchParams.get("code") as string;
  const tok = await fetch(`${as.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: pub.clientId,
      redirect_uri: "https://cb.example.com/cb",
    }),
  });
  return (await tok.json()) as { access_token: string; refresh_token: string; expires_in: number };
}

async function seedOAuth(as: FakeOAuthServer, connectorId: string, expiresAt: number) {
  const t = await issueTokens(as);
  await creds.setOAuthClient(ORG, connectorId, {
    clientId: pub.clientId,
    authMethod: "none",
    authorizationEndpoint: `${as.issuer}/authorize`,
    tokenEndpoint: `${as.issuer}/token`,
  });
  await creds.setOAuthTokens(
    ORG,
    connectorId,
    { kind: "user", accountId: ALICE },
    {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: expiresAt,
      token_type: "Bearer",
    },
  );
  return t;
}

const refreshes = (as: FakeOAuthServer) =>
  as.tokenRequests.filter((r) => r.grantType === "refresh_token");

describe("gitAuthorization", () => {
  it("builds Basic with the host's username and the actor's own static token", async () => {
    await creds.setStatic(
      ORG,
      "c_bearer",
      BEARER,
      { kind: "user", accountId: ALICE },
      {
        token: "ghp_alice_secret_token_1",
      },
    );
    const header = await creds.gitAuthorization(ORG, "c_bearer", BEARER, ALICE, "x-access-token");
    expect(header).toBe(basic("x-access-token", "ghp_alice_secret_token_1"));
    // another account's credential is never used: Bob has none on this connector
    await expect(
      creds.gitAuthorization(ORG, "c_bearer", BEARER, BOB, "x-access-token"),
    ).rejects.toBeInstanceOf(CredentialMissing);
  });

  it("uses the org credential for an org connector, whoever the actor is", async () => {
    await creds.setStatic(
      ORG,
      "c_org",
      ORG_BEARER,
      { kind: "org" },
      {
        token: "ghp_bot_secret_token_42",
      },
    );
    for (const actor of [ALICE, BOB]) {
      expect(await creds.gitAuthorization(ORG, "c_org", ORG_BEARER, actor, "oauth2")).toBe(
        basic("oauth2", "ghp_bot_secret_token_42"),
      );
    }
  });

  it("presents a basic connector's stored pair as it is", async () => {
    await creds.setStatic(
      ORG,
      "c_basic",
      BASIC,
      { kind: "user", accountId: ALICE },
      {
        username: "alice-gl",
        password: "glpat-alice-secret-99",
      },
    );
    expect(await creds.gitAuthorization(ORG, "c_basic", BASIC, ALICE, "x-access-token")).toBe(
      basic("alice-gl", "glpat-alice-secret-99"),
    );
  });

  it("refuses auth types that cannot authenticate git", async () => {
    await expect(
      creds.gitAuthorization(ORG, "c_none", { type: "none" }, ALICE, "x-access-token"),
    ).rejects.toThrow(/cannot authenticate git/);
    await expect(
      creds.gitAuthorization(
        ORG,
        "c_headers",
        { type: "headers", ownership: "personal", names: ["X-Token"] },
        ALICE,
        "x-access-token",
      ),
    ).rejects.toThrow(/cannot authenticate git/);
  });

  it("refreshes an expiring OAuth token first and registers the values for redaction", async () => {
    const as = await startFakeOAuthServer({ clients: [pub] });
    stops.push(() => as.stop());
    const t = await seedOAuth(as, "c_oauth_exp", Date.now() + 10_000);
    const header = await creds.gitAuthorization(ORG, "c_oauth_exp", OAUTH, ALICE, "x-access-token");
    expect(refreshes(as)).toHaveLength(1);
    const token = passwordOf(header);
    expect(token).not.toBe(t.access_token);
    expect(as.verify(token)).toBe(true);
    expect(header).toBe(basic("x-access-token", token));
    // a log field carrying the header, its base64 or the token is redacted (org secrets are
    // redacted in fields; `msg` is the kernel's own text)
    const before = lines.length;
    log.info("leak", { header, token, b64: header.slice("Basic ".length) });
    const logged = lines.slice(before).join("\n");
    expect(logged).toContain("leak");
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(header.slice("Basic ".length));
    // Bob never gets Alice's token
    await expect(
      creds.gitAuthorization(ORG, "c_oauth_exp", OAUTH, BOB, "x-access-token"),
    ).rejects.toBeInstanceOf(CredentialMissing);
  });

  it("gitUnauthorized force-refreshes once; a stale value after that refreshes nothing", async () => {
    const as = await startFakeOAuthServer({ clients: [pub] });
    stops.push(() => as.stop());
    await seedOAuth(as, "c_oauth_401", Date.now() + 3_600_000);
    const stale = await creds.gitAuthorization(ORG, "c_oauth_401", OAUTH, ALICE, "x-access-token");
    expect(refreshes(as)).toHaveLength(0);
    as.revokeAccessTokens();
    await creds.gitUnauthorized(ORG, "c_oauth_401", OAUTH, ALICE, stale);
    expect(refreshes(as)).toHaveLength(1);
    const fresh = await creds.gitAuthorization(ORG, "c_oauth_401", OAUTH, ALICE, "x-access-token");
    expect(fresh).not.toBe(stale);
    expect(as.verify(passwordOf(fresh))).toBe(true);
    // a late 401 of the old value: the stored token already changed, no second refresh
    await creds.gitUnauthorized(ORG, "c_oauth_401", OAUTH, ALICE, stale);
    expect(refreshes(as)).toHaveLength(1);
    // static credentials: nothing to do
    await creds.gitUnauthorized(ORG, "c_bearer", BEARER, ALICE, stale);
  });

  it("a refused refresh drops the credential and throws CredentialMissing", async () => {
    const as = await startFakeOAuthServer({ clients: [pub] });
    stops.push(() => as.stop());
    await seedOAuth(as, "c_oauth_gone", Date.now() + 3_600_000);
    const stale = await creds.gitAuthorization(ORG, "c_oauth_gone", OAUTH, ALICE, "x-access-token");
    as.revokeRefreshTokens();
    const err = await creds
      .gitUnauthorized(ORG, "c_oauth_gone", OAUTH, ALICE, stale)
      .catch((e) => e);
    expect(err).toBeInstanceOf(CredentialMissing);
    expect(await creds.status(ORG, "c_oauth_gone", OAUTH, ALICE)).toBe("missing");
  });
});
