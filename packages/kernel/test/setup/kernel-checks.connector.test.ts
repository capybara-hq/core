import { randomUUID } from "node:crypto";
import { type FakeOAuthServer, startFakeOAuthServer } from "@capybara-hq/testing";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginGuides } from "../../src/extensions/plugin-guides.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { REDIS } from "../../src/infra/tokens.js";
import { createLogger } from "../../src/log.js";
import { KERNEL_CHECK_TEXTS } from "../../src/setup/kernel-checks.js";
import { PROBE_TEXTS, redirectFix } from "../../src/setup/oauth-token-probe.js";
import { type KernelCheckArgs, SetupCheckRegistry } from "../../src/setup/setup-check-registry.js";
import { Credentials } from "../../src/tools/credentials.js";
import { basicClientAuth, type OAuthClientRecord } from "../../src/tools/oauth/tokens.js";
import {
  importPlugin,
  install,
  type OrgEnv,
  resetOrgCatalog,
  startOrgEnv,
} from "../catalog/org-env.js";
import { mcpTemplate, templateFiles } from "../catalog/packages.js";
import { accountsFor } from "../helpers/identity.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { PW, type Req, session } from "../helpers/runs.js";

// The kernel's connector checks (spec 2026-11-09-setup-guides-v2-design.md §10.6, plan task 11):
// `capybara:oauth-client`, `connector-tools`, `connector-connected` (per account) and
// `oauth-token-endpoint` (the probe with the stored client: the secret stays in the kernel, a 2xx
// token is never stored), plus the T10 trust review's follow-ups: the guide's template and a live
// platform component in the target query, derived secret forms, the cache re-read under the lock.

const PLUGIN = "oauth-checks";
const TEMPLATE = "slack-oauth";
const CLIENT_ID = "1234.5678";
const SECRET = "client-secret-9f2c41d07b";
const CALLBACK = "https://capybara.example.com/api/v1/oauth/callback";

const DOC = [
  "# Set up the {{templateName}} connector",
  "",
  "::: audience admin",
  "::check capybara:oauth-client The client is stored",
  "::check capybara:connector-tools The tools were read",
  "::check capybara:oauth-token-endpoint The token endpoint accepts the client",
  "::check capybara:test-secrets What the kernel redacts",
  ":::",
  "",
  "::: audience member",
  "::check capybara:connector-connected You are connected",
  ":::",
  "",
].join("\n");

let env: OrgEnv;
let oauth: FakeOAuthServer;
let redis: Redis;
let itemId: string;
let connectorId: string;
let mem2: Req;
const lines: string[] = [];
const secretArgs: KernelCheckArgs[] = [];

type State = { status: string; reason?: { en: string }; fix?: { en: string }; checkedAt?: string };

beforeAll(async () => {
  oauth = await startFakeOAuthServer({ clients: [{ clientId: CLIENT_ID, clientSecret: SECRET }] });
  env = await startOrgEnv({
    tools: { timeoutMs: 5_000, oauthAllowInsecureLoopback: true },
    logger: createLogger("info", { write: (l) => lines.push(l) }),
  });
  await resetOrgCatalog(env);
  // the kernel's own client (closed with the kernel)
  redis = env.k.app.get<Redis>(REDIS);
  env.k.app
    .get(SetupCheckRegistry)
    .registerKernel("capybara:test-secrets", "connector-template", async (a) => {
      secretArgs.push(a);
      return { status: "ok", reason: { en: "noted" } };
    });
  itemId = await importPlugin(
    env,
    await pluginTgz({
      manifest: {
        name: PLUGIN,
        setupGuides: [{ id: "oauth", place: "connector-template", template: TEMPLATE }],
      },
      files: {
        ...templateFiles(
          TEMPLATE,
          mcpTemplate({
            auth: {
              type: "oauth_code",
              ownership: "personal",
              discovery: "manual",
              authorizationUrl: `${oauth.issuer}/authorize`,
              tokenUrl: `${oauth.issuer}/token`,
              client: "manual",
              tokenAuthMethod: "client_secret_basic",
            },
          }),
        ),
        "guides/oauth.md": DOC,
      },
    }),
  );
  const r = await install(env.boss, env, itemId, {
    connectors: {
      [TEMPLATE]: {
        name: "Team Slack",
        endpoint: { url: env.mcp.url },
        client: { clientId: CLIENT_ID, clientSecret: SECRET },
      },
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  connectorId = (
    await env.db
      .selectFrom("connectors")
      .select("id")
      .where("org_id", "=", env.orgId)
      .where("catalog_item_id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow()
  ).id;
  const m2 = await accountsFor(env.db).createLocal({
    login: "mem2",
    password: PW,
    displayName: "M2",
  });
  await env.db
    .insertInto("memberships")
    .values({ org_id: env.orgId, account_id: m2.id, role: "member" })
    .execute();
  mem2 = await session(env.k, "mem2");
});

afterAll(async () => {
  await env?.stop();
  await oauth?.stop();
});

beforeEach(async () => {
  const keys = [...(await redis.keys("capk:setup-check*")), ...(await redis.keys("throttler:*"))];
  if (keys.length > 0) await redis.del(...keys);
  lines.length = 0;
  vi.restoreAllMocks();
});

const url = (path: string) => `/api/v1/orgs/${env.orgId}/catalog/${itemId}/guides/oauth${path}`;

async function runRaw(req: Req, check: string, audience: "admin" | "member" = "admin") {
  return req({
    method: "POST",
    url: url(`/checks/${check}/run`),
    payload: { connectorId, audience },
  });
}

async function run(
  req: Req,
  check: string,
  audience: "admin" | "member" = "admin",
): Promise<State> {
  const r = await runRaw(req, check, audience);
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { result: State }).result;
}

const credentials = () => env.k.app.get(Credentials);
const storedClient = async () =>
  (await credentials().oauthClient(env.orgId, connectorId)) as OAuthClientRecord;
const secretRows = async () =>
  (
    await env.db
      .selectFrom("secrets")
      .select(["key", "updated_at"])
      .where("org_id", "=", env.orgId)
      .execute()
  ).map((r) => `${r.key}@${new Date(r.updated_at).toISOString()}`);

/** Every Redis value of the check cache, joined. */
async function cacheText(): Promise<string> {
  const keys = await redis.keys("capk:setup-check:*");
  return keys.length === 0 ? "" : (await redis.mget(...keys)).join("\n");
}

describe("kernel connector checks", () => {
  it("oauth-client: ok when id and secret are stored; failing without the secret", async () => {
    expect(await run(env.boss, "capybara:oauth-client")).toMatchObject({
      status: "ok",
      reason: KERNEL_CHECK_TEXTS.clientStored,
    });
    const client = await storedClient();
    const { clientSecret: _s, ...noSecret } = client;
    await credentials().setOAuthClient(env.orgId, connectorId, { ...noSecret, authMethod: "none" });
    try {
      expect(await run(env.boss, "capybara:oauth-client")).toMatchObject({
        status: "failing",
        fix: KERNEL_CHECK_TEXTS.clientFix,
      });
    } finally {
      await credentials().setOAuthClient(env.orgId, connectorId, client);
    }
  });

  it("connector-tools: unknown before the first snapshot, ok after", async () => {
    expect(await run(env.boss, "capybara:connector-tools")).toMatchObject({
      status: "unknown",
      reason: KERNEL_CHECK_TEXTS.toolsPending,
    });
    await env.db
      .insertInto("connector_tools")
      .values({
        connector_id: connectorId,
        name: "search",
        spec: JSON.stringify({ name: "search", inputSchema: { type: "object" } }),
        spec_hash: "h1",
        status: "enabled",
        default_policy: "allow",
        reviewed_at: null,
        pending_spec_hash: null,
        pending_source: null,
      } as never)
      .execute();
    try {
      await redis.del(...(await redis.keys("capk:setup-check*")));
      expect((await run(env.boss, "capybara:connector-tools")).status).toBe("ok");
    } finally {
      await env.db.deleteFrom("connector_tools").where("connector_id", "=", connectorId).execute();
    }
  });

  it("connector-connected is per account: A connected is ok, B not yet is failing", async () => {
    expect(await run(env.mem, "capybara:connector-connected", "member")).toMatchObject({
      status: "failing",
      fix: KERNEL_CHECK_TEXTS.connectFix,
    });
    await credentials().setOAuthTokens(
      env.orgId,
      connectorId,
      { kind: "user", accountId: env.memId },
      { access_token: "member-access-token-41a7c", token_type: "Bearer", expires_at: null },
    );
    // A's own credential row is in A's fingerprint: the next view reruns at once
    expect((await run(env.mem, "capybara:connector-connected", "member")).status).toBe("ok");
    expect((await run(mem2, "capybara:connector-connected", "member")).status).toBe("failing");
  });

  it("the kernel's secrets for a connector: the client secret, member tokens and their sent forms", async () => {
    secretArgs.length = 0;
    await run(env.boss, "capybara:test-secrets");
    const s = secretArgs[0]?.secrets ?? [];
    expect(s).toContain(SECRET);
    expect(s).toContain("member-access-token-41a7c");
    // the client_secret_basic header the token request sends, its token and decoded form
    const header = basicClientAuth(CLIENT_ID, SECRET);
    expect(s).toContain(header);
    expect(s).toContain(header.slice("Basic ".length));
    expect(s).toContain(`${CLIENT_ID}:${SECRET}`);
    // never the client id alone (not a secret)
    expect(s).not.toContain(CLIENT_ID);
  });

  it("oauth-token-endpoint: invalid_grant → ok; the secret in no result, cache or log", async () => {
    const before = oauth.tokenRequests.length;
    expect(await run(env.boss, "capybara:oauth-token-endpoint")).toMatchObject({
      status: "ok",
      reason: PROBE_TEXTS.accepted,
    });
    expect(oauth.tokenRequests.slice(before)).toEqual([
      expect.objectContaining({
        grantType: "authorization_code",
        clientId: CLIENT_ID,
        clientAuth: "basic",
        error: "invalid_grant",
      }),
    ]);
    expect(await cacheText()).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("oauth-token-endpoint: a wrong stored secret → failing with the copy-again fix", async () => {
    const client = await storedClient();
    await credentials().setOAuthClient(env.orgId, connectorId, {
      ...client,
      clientSecret: "stale-secret-77b1e0c4a9",
    });
    try {
      const r = await run(env.boss, "capybara:oauth-token-endpoint");
      expect(r).toMatchObject({
        status: "failing",
        reason: PROBE_TEXTS.clientRefused,
        fix: PROBE_TEXTS.clientFix,
      });
      expect(JSON.stringify(r)).not.toContain("stale-secret");
    } finally {
      await credentials().setOAuthClient(env.orgId, connectorId, client);
    }
  });

  it("oauth-token-endpoint: redirect refused → the callback URL; a 2xx token → unknown, nothing written", async () => {
    oauth.failTokenRequests(1, 400, { error: "redirect_uri_mismatch" });
    expect(await run(env.boss, "capybara:oauth-token-endpoint")).toMatchObject({
      status: "failing",
      fix: redirectFix(CALLBACK),
    });
    await redis.del(...(await redis.keys("capk:setup-check*")));
    const rows = await secretRows();
    const token = "at_never_stored_0a1b2c3d4e";
    oauth.failTokenRequests(1, 200, {
      access_token: token,
      refresh_token: "rt_never_stored_5f6a7b8c",
      token_type: "Bearer",
    });
    const r = await run(env.boss, "capybara:oauth-token-endpoint");
    expect(r).toMatchObject({ status: "unknown", reason: PROBE_TEXTS.unknown });
    // no credential row written or touched, the token nowhere
    expect(await secretRows()).toEqual(rows);
    expect(await cacheText()).not.toContain(token);
    expect(lines.join("\n")).not.toContain(token);
  });

  it("oauth-token-endpoint: a dcr client answers unknown without a request", async () => {
    const row = await env.db
      .selectFrom("connectors")
      .select("auth")
      .where("id", "=", connectorId)
      .executeTakeFirstOrThrow();
    const auth = row.auth as unknown as Record<string, unknown>;
    await env.db
      .updateTable("connectors")
      .set({ auth: JSON.stringify({ ...auth, client: "dcr" }) as never })
      .where("id", "=", connectorId)
      .execute();
    try {
      const before = oauth.tokenRequests.length;
      expect(await run(env.boss, "capybara:oauth-token-endpoint")).toMatchObject({
        status: "unknown",
        reason: KERNEL_CHECK_TEXTS.dcr,
      });
      expect(oauth.tokenRequests).toHaveLength(before);
    } finally {
      await env.db
        .updateTable("connectors")
        .set({ auth: JSON.stringify(auth) as never })
        .where("id", "=", connectorId)
        .execute();
    }
  });
});

describe("T10 trust review follow-ups", () => {
  it("the target query needs a live platform template (t.deleted_at IS NULL)", async () => {
    secretArgs.length = 0;
    const t = await env.db
      .selectFrom("connectors")
      .select("platform_template_id")
      .where("id", "=", connectorId)
      .executeTakeFirstOrThrow();
    const templateRow = t.platform_template_id as string;
    await env.db
      .updateTable("platform_connector_templates")
      .set({ deleted_at: new Date() })
      .where("id", "=", templateRow)
      .execute();
    try {
      const r = await runRaw(env.boss, "capybara:test-secrets");
      expect(r.statusCode, r.body).toBe(404);
      expect(secretArgs).toHaveLength(0);
    } finally {
      await env.db
        .updateTable("platform_connector_templates")
        .set({ deleted_at: null })
        .where("id", "=", templateRow)
        .execute();
    }
  });

  it("the target query needs the guide's own template (t.template_id)", async () => {
    secretArgs.length = 0;
    const guides = env.k.app.get(PluginGuides);
    const real = guides.render.bind(guides);
    vi.spyOn(guides, "render").mockImplementation(async (...a) => ({
      ...(await real(...a)),
      template: "another-template",
    }));
    const r = await runRaw(env.boss, "capybara:test-secrets");
    expect(r.statusCode, r.body).toBe(404);
    expect(secretArgs).toHaveLength(0);
  });

  it("re-reads the cache after taking the lock: a run that settled meanwhile is answered", async () => {
    secretArgs.length = 0;
    await run(env.boss, "capybara:test-secrets");
    expect(secretArgs).toHaveLength(1);
    const key = (await redis.keys("capk:setup-check:*test-secrets*")).find(
      (k) => !k.endsWith(":cooldown"),
    ) as string;
    const value = (await redis.get(key)) as string;
    // the first read misses; another run writes its result before this one gets the lock
    await redis.del(key);
    const locks = env.k.app.get(LockService);
    const lease = locks.lease.bind(locks);
    vi.spyOn(locks, "lease").mockImplementation(async (k, holder, ttl) => {
      if (k.includes("test-secrets")) await redis.set(key, value, "PX", 60_000);
      return lease(k, holder, ttl);
    });
    const r = await run(env.boss, "capybara:test-secrets");
    expect(r.status).toBe("ok");
    expect(secretArgs).toHaveLength(1);
  });

  it("checkMaterial lists Basic, user:pass and percent-encoded forms of static credentials", async () => {
    const id = randomUUID();
    const user = "svc user";
    const pass = "p@ss/word+0123";
    await credentials().setStatic(
      env.orgId,
      id,
      { type: "basic", ownership: "org" },
      { kind: "org" },
      { username: user, password: pass },
    );
    await credentials().setStatic(
      env.orgId,
      id,
      { type: "bearer", ownership: "personal" },
      { kind: "user", accountId: env.memId },
      { token: "tok/en+value=9876" },
    );
    try {
      const { secrets } = await credentials().checkMaterial(env.orgId, id);
      const b64 = Buffer.from(`${user}:${pass}`).toString("base64");
      for (const v of [
        pass,
        `${user}:${pass}`,
        b64,
        `Basic ${b64}`,
        encodeURIComponent(pass),
        encodeURIComponent(`${user}:${pass}`),
        "tok/en+value=9876",
        encodeURIComponent("tok/en+value=9876"),
      ]) {
        expect(secrets, v).toContain(v);
      }
    } finally {
      await credentials().clearConnector(env.orgId, id);
    }
  });
});
