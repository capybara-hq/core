import {
  type FakeMcpServer,
  type FakeOAuthServer,
  type FakeOAuthServerOptions,
  fakeExtensionEntry,
  startFakeMcpServer,
  startFakeOAuthServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { AccountsService } from "../../../src/identity/accounts.js";
import { createKernel, type Kernel } from "../../../src/kernel.js";
import { createLogger } from "../../../src/log.js";
import { truncateTables } from "../../helpers/db.js";
import { MODEL_FAKE } from "../../helpers/model-plugins.js";
import {
  createConv,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  waitForTerminal,
} from "../../helpers/runs.js";

/**
 * Task 15：OAuth 端到端（单副本）。假授权服务器 + 要求其签发的 bearer 的假 MCP 服务：
 * 安装（MCP 发现 + DCR / 不支持 DCR / 手填 client / 客户端凭据）、连接（PKCE、state 单次有效、浏览器绑定、
 * 防开放重定向）、首次连接触发刷新（A16）、调用前过期刷新、401 刷新重试、refresh 失败 → 需要连接；
 * token 不出现在日志、事件与 HTTP 响应中。
 */

const CONNECTOR = fakeExtensionEntry("fake-connector");
const PUBLIC_URL = "https://capybara.example.com";
const CALLBACK = `${PUBLIC_URL}/api/v1/oauth/callback`;

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let req: Req;
let orgId: string;
const logLines: string[] = [];
const httpBodies: string[] = [];
const stops: (() => Promise<void>)[] = [];

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, CONNECTOR],
        extensionPermissions: { autoApprove: true },
        extensionConfig: { "fake-connector": { allowInsecureLoopback: true } },
        roles: ["api", "worker"],
        http: { port: 0, publicUrl: PUBLIC_URL },
        auth: { cookieSecure: false },
        tools: { timeoutMs: 5_000, oauthAllowInsecureLoopback: true },
      },
    ),
    { env: {}, logger: createLogger("info", { write: (l) => logLines.push(l) }) },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
}, 120_000);

afterAll(async () => {
  await k?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  req = await session(k, "owner");
  const org = await call({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  orgId = (org.json() as { org: { id: string } }).org.id;
});

afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function call(opts: Parameters<Req>[0], as: Req = req) {
  const res = await as(opts);
  httpBodies.push(res.body, JSON.stringify(res.headers));
  return res;
}

/** 假授权服务器 + 用它签发的 token 鉴权的假 MCP 服务。 */
async function servers(
  asOpts: FakeOAuthServerOptions = {},
  advertise: "header" | "well-known" = "header",
): Promise<{ as: FakeOAuthServer; mcp: FakeMcpServer }> {
  const as = await startFakeOAuthServer(asOpts);
  stops.push(() => as.stop());
  const mcp = await startFakeMcpServer({
    verifyBearer: (t) => as.verify(t),
    protectedResource: { authorizationServers: [as.issuer], advertise },
    tools: [
      {
        name: "whoami",
        description: "Echo the caller",
        annotations: { readOnlyHint: true },
        handler: ({ headers }) => ({
          content: [{ type: "text", text: `you are ${headers.authorization}` }],
        }),
      },
    ],
  });
  stops.push(() => mcp.stop());
  return { as, mcp };
}

type AppJson = {
  id: string;
  tools: { name: string }[];
  credential: { ownership: string | null; status: string };
};

async function installDcr(mcp: FakeMcpServer): Promise<AppJson> {
  const res = await call({
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
  return (res.json() as { connector: AppJson }).connector;
}

async function getConnector(connectorId: string, as: Req = req): Promise<AppJson> {
  const res = await call(
    { method: "GET", url: `/api/v1/orgs/${orgId}/connectors/${connectorId}` },
    as,
  );
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { connector: AppJson }).connector;
}

/** 发起连接，返回授权 URL。 */
async function connect(connectorId: string, as: Req = req, returnTo?: string): Promise<URL> {
  const res = await call(
    {
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors/${connectorId}/connect`,
      payload: returnTo === undefined ? {} : { returnTo },
    },
    as,
  );
  expect(res.statusCode, res.body).toBe(200);
  return new URL((res.json() as { authorizationUrl: string }).authorizationUrl);
}

/** 浏览器访问授权 URL（假授权服务器自动批准），返回回跳到内核回调的 path + query。 */
async function approve(url: URL): Promise<string> {
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get("location") as string);
  expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
  return `${back.pathname}${back.search}`;
}

/** 回调：返回 302 的 Location。 */
async function callback(path: string, as: Req = req): Promise<string> {
  const res = await call({ method: "GET", url: path, csrf: false }, as);
  expect(res.statusCode, res.body).toBe(302);
  return res.headers.location as string;
}

async function connectFully(connectorId: string, as: Req = req): Promise<string> {
  return callback(await approve(await connect(connectorId, as)), as);
}

async function agentFor(connectorId: string): Promise<string> {
  const res = await call({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "connector", connectorId, tools: "all" }],
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

async function runTool(convId: string, n: number, key: string) {
  await postMessage(req, orgId, convId, `tool:${key}:{}`);
  await waitForTerminal(db, convId, n, 20_000);
  return ofType(await eventsOf(db, convId), "tool_result").at(-1)?.payload;
}

const refreshes = (as: FakeOAuthServer) =>
  as.tokenRequests.filter((r) => r.grantType === "refresh_token");

describe("安装", () => {
  it("MCP 发现 + DCR：不做首次 listTools（A16），client 以组织级凭据存储；当前用户需要连接", async () => {
    const { as, mcp } = await servers();
    const app = await installDcr(mcp);
    expect(app.tools).toEqual([]);
    expect(app.credential).toEqual({ ownership: "personal", status: "missing" });
    expect(as.registrations).toHaveLength(1);
    expect(as.registrations[0]).toMatchObject({ redirect_uris: [CALLBACK] });
    const keys = await db
      .selectFrom("secrets")
      .select("key")
      .where("org_id", "=", orgId)
      .orderBy("key")
      .execute();
    expect(keys.map((r) => r.key)).toEqual([`credentials:app:${app.id}:client`]);
    // MCP 服务只收到未带凭据的发现探测，没有工具调用
    expect(mcp.requests.every((r) => r.headers.authorization === undefined)).toBe(true);
  });

  it("受保护资源元数据只在 well-known 位置也能安装", async () => {
    const { mcp } = await servers({}, "well-known");
    await installDcr(mcp);
  });

  it("不支持 DCR → 502 connector.connect_failed 带 dcr_unsupported，什么都不写；改填 client 后安装成功", async () => {
    const { mcp } = await servers({
      dcr: false,
      clients: [{ clientId: "manual-client", clientSecret: "manual-secret-0123456789" }],
    });
    const res = await call({
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
    expect(res.statusCode, res.body).toBe(502);
    const err = (res.json() as { error: { code: string; details: { reason: string }[] } }).error;
    expect(err.code).toBe("connector.connect_failed");
    expect(err.details.map((d) => d.reason)).toEqual(["dcr_unsupported"]);
    expect(await db.selectFrom("connectors").select("id").execute()).toEqual([]);
    expect(
      await db.selectFrom("secrets").select("key").where("org_id", "=", orgId).execute(),
    ).toEqual([]);

    const ok = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: "Docs",
        slug: "docs",
        connector: "fake",
        endpoint: { url: mcp.url },
        auth: { type: "oauth_code", ownership: "personal", discovery: "mcp", client: "manual" },
        credential: { clientId: "manual-client", clientSecret: "manual-secret-0123456789" },
      },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const connectorId = (ok.json() as { connector: AppJson }).connector.id;
    const back = await connectFully(connectorId);
    expect(back).toBe(`${PUBLIC_URL}/settings/connections?connected=${connectorId}`);
  });

  it("手填 client 但没给 credential → validation_failed；DCR 必须配合 MCP 发现", async () => {
    const { mcp } = await servers();
    const missing = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: "Docs",
        connector: "fake",
        endpoint: { url: mcp.url },
        auth: { type: "oauth_code", ownership: "personal", discovery: "mcp", client: "manual" },
      },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({
      error: { code: "validation_failed", details: [{ path: "credential" }] },
    });
    const dcrManual = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: "Docs",
        connector: "fake",
        endpoint: { url: mcp.url },
        auth: {
          type: "oauth_code",
          ownership: "personal",
          discovery: "manual",
          authorizationUrl: "https://as.example.com/authorize",
          tokenUrl: "https://as.example.com/token",
          client: "dcr",
        },
      },
    });
    expect(dcrManual.statusCode).toBe(400);
    expect(dcrManual.json()).toMatchObject({ error: { code: "validation_failed" } });
  });

  it("客户端凭据（组织级）：安装时取 token 并 listTools；调用用组织 token", async () => {
    const { as, mcp } = await servers({
      clients: [{ clientId: "svc", clientSecret: "svc-secret-0123456789abc" }],
    });
    const res = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: "Svc",
        slug: "svc",
        connector: "fake",
        endpoint: { url: mcp.url },
        auth: {
          type: "oauth_client",
          ownership: "org",
          tokenUrl: `${as.issuer}/token`,
          scopes: ["docs.read"],
        },
        credential: { clientId: "svc", clientSecret: "svc-secret-0123456789abc" },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const app = (res.json() as { connector: AppJson }).connector;
    expect(app.tools.map((t) => t.name)).toEqual(["whoami"]);
    expect(app.credential).toEqual({ ownership: "org", status: "connected" });
    expect(as.tokenRequests).toMatchObject([
      { grantType: "client_credentials", clientId: "svc", scope: "docs.read" },
    ]);

    const convId = await createConv(req, orgId, await agentFor(app.id));
    const r = await runTool(convId, 1, "svc__whoami");
    expect(r).toMatchObject({ content: "you are [REDACTED]", isError: false });
    // token 缓存于凭据存储：调用没有再取 token
    expect(as.tokenRequests).toHaveLength(1);

    const bad = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: "Svc2",
        connector: "fake",
        endpoint: { url: mcp.url },
        auth: { type: "oauth_client", ownership: "org", tokenUrl: `${as.issuer}/token` },
        credential: { clientId: "svc", clientSecret: "wrong-secret-0123456789" },
      },
    });
    expect(bad.statusCode, bad.body).toBe(502);
    expect(bad.json()).toMatchObject({ error: { code: "connector.connect_failed" } });
  }, 60_000);

  it("OAuth 连接器的个人 / 组织凭据只能经连接流程写入（PUT 凭据 → validation_failed）", async () => {
    const { mcp } = await servers();
    const app = await installDcr(mcp);
    const put = await call({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}/credentials/me`,
      payload: { token: "a-token-of-some-length" },
    });
    expect(put.statusCode).toBe(400);
    expect(put.json()).toMatchObject({ error: { code: "validation_failed" } });
  });
});

describe("连接（授权码 + PKCE）", () => {
  it("授权 URL 带 PKCE S256、state、resource；state 存 Redis 10 分钟；回调后凭据可用并触发首次刷新", async () => {
    const { as, mcp } = await servers();
    const app = await installDcr(mcp);
    const url = await connect(app.id);
    const q = url.searchParams;
    expect(`${url.origin}${url.pathname}`).toBe(`${as.issuer}/authorize`);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("redirect_uri")).toBe(CALLBACK);
    expect(q.get("resource")).toBe(mcp.url);
    const state = q.get("state") as string;
    expect(state.length).toBeGreaterThanOrEqual(32);
    const ttl = await redis.ttl(`capk:oauth-state:${state}`);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
    // 状态里不含明文 PKCE challenge 之外的东西对外可见：授权 URL 不带 verifier
    expect(url.toString()).not.toContain("verifier");

    const back = await callback(await approve(url));
    expect(back).toBe(`${PUBLIC_URL}/settings/connections?connected=${app.id}`);
    expect(await redis.exists(`capk:oauth-state:${state}`)).toBe(0);
    const tokenReq = as.tokenRequests.find((r) => r.grantType === "authorization_code");
    expect(tokenReq).toMatchObject({ status: 200, resource: mcp.url });

    // A16：首次连接用该成员的 token 刷新工具清单
    const after = await getConnector(app.id);
    expect(after.credential.status).toBe("connected");
    expect(after.tools.map((t) => t.name)).toEqual(["whoami"]);

    const convId = await createConv(req, orgId, await agentFor(app.id));
    const r = await runTool(convId, 1, "docs__whoami");
    expect(r).toMatchObject({ content: "you are [REDACTED]", isError: false });
    expect(mcp.calls.at(-1)?.headers.authorization).toMatch(/^Bearer at_/);
  }, 60_000);

  it("回跳页面：只接受站内相对路径；带上 connected 参数", async () => {
    const { mcp } = await servers();
    const app = await installDcr(mcp);
    for (const bad of ["https://evil.example.com/x", "//evil.example.com", "/\\evil.com", "x"]) {
      const res = await call({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/connectors/${app.id}/connect`,
        payload: { returnTo: bad },
      });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json()).toMatchObject({
        error: { code: "validation_failed", details: [{ path: "returnTo" }] },
      });
    }
    const url = await connect(app.id, req, "/zh/chat/abc?tab=1");
    const back = await callback(await approve(url));
    expect(back).toBe(`${PUBLIC_URL}/zh/chat/abc?tab=1&connected=${app.id}`);
  });

  it("state 伪造 / 重放 / 过期 → 回跳带错误码，不换 token", async () => {
    const { as, mcp } = await servers();
    const app = await installDcr(mcp);
    const forged = await callback("/api/v1/oauth/callback?code=abc&state=forged-state-value");
    expect(forged).toBe(`${PUBLIC_URL}/settings/connections?oauth_error=state_invalid`);

    const path = await approve(await connect(app.id));
    expect(await callback(path)).toContain("connected=");
    // 同一 state 第二次使用（重放）
    expect(await callback(path)).toBe(
      `${PUBLIC_URL}/settings/connections?oauth_error=state_invalid`,
    );

    // 过期：Redis 键到期即不存在
    const url = await connect(app.id);
    await redis.del(`capk:oauth-state:${url.searchParams.get("state")}`);
    expect(await callback(await approve(url))).toBe(
      `${PUBLIC_URL}/settings/connections?oauth_error=state_invalid`,
    );
    expect(as.tokenRequests.filter((r) => r.grantType === "authorization_code")).toHaveLength(1);
  });

  it("回调必须来自发起连接的浏览器（防把别人的授权连到自己账号上）", async () => {
    const { as, mcp } = await servers();
    const app = await installDcr(mcp);
    await new AccountsService(db).createLocal({ login: "victim", password: PW, displayName: "V" });
    const victim = await session(k, "victim");
    const path = await approve(await connect(app.id));
    // 发起者把回跳链接发给另一个浏览器
    expect(await callback(path, victim)).toBe(
      `${PUBLIC_URL}/settings/connections?oauth_error=session_mismatch`,
    );
    expect(as.tokenRequests).toEqual([]);
  });

  it("授权服务器回跳错误：只给错误码，不回显对方的描述", async () => {
    const { as, mcp } = await servers();
    const app = await installDcr(mcp);
    as.denyNext("access_denied", "<script>alert(1)</script>");
    const back = await callback(await approve(await connect(app.id)));
    expect(back).toBe(`${PUBLIC_URL}/settings/connections?oauth_error=access_denied`);
    as.denyNext("temporarily_unavailable", "nope");
    const back2 = await callback(await approve(await connect(app.id)));
    expect(back2).toBe(`${PUBLIC_URL}/settings/connections?oauth_error=provider_error`);
    expect((await getConnector(app.id)).credential.status).toBe("missing");
  });

  it("connect 只用于授权码连接器；非成员 404", async () => {
    const open = await startFakeMcpServer({ tools: [] });
    stops.push(() => open.stop());
    const res = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: "Open",
        connector: "fake",
        endpoint: { url: open.url },
        auth: { type: "none" },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const connectorId = (res.json() as { connector: AppJson }).connector.id;
    const c = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors/${connectorId}/connect`,
      payload: {},
    });
    expect(c.statusCode).toBe(400);
    expect(c.json()).toMatchObject({
      error: { code: "validation_failed", details: [{ path: "auth" }] },
    });
    await new AccountsService(db).createLocal({
      login: "outsider",
      password: PW,
      displayName: "X",
    });
    const outsider = await session(k, "outsider");
    const c2 = await call(
      {
        method: "POST",
        url: `/api/v1/orgs/${orgId}/connectors/${connectorId}/connect`,
        payload: {},
      },
      outsider,
    );
    expect(c2.statusCode).toBe(404);
  });
});

describe("刷新", () => {
  it("access token 将在 60 秒内过期 → 调用前刷新（refresh 轮换）", async () => {
    const { as, mcp } = await servers({ accessTokenTtl: 30 });
    const app = await installDcr(mcp);
    await connectFully(app.id);
    const before = refreshes(as).length;
    const convId = await createConv(req, orgId, await agentFor(app.id));
    const r = await runTool(convId, 1, "docs__whoami");
    expect(r?.isError).toBe(false);
    expect(refreshes(as).length).toBeGreaterThan(before);
    expect(refreshes(as).every((x) => x.status === 200)).toBe(true);
  }, 60_000);

  it("收到 401 → 刷新一次后重试成功", async () => {
    const { as, mcp } = await servers();
    const app = await installDcr(mcp);
    await connectFully(app.id);
    as.revokeAccessTokens();
    const convId = await createConv(req, orgId, await agentFor(app.id));
    const r = await runTool(convId, 1, "docs__whoami");
    expect(r).toMatchObject({ content: "you are [REDACTED]", isError: false });
    expect(refreshes(as)).toMatchObject([{ status: 200 }]);
  }, 60_000);

  it("refresh 失败 → 凭据失效、connection_required 与工具错误；之后重新连接即可", async () => {
    const { as, mcp } = await servers();
    const app = await installDcr(mcp);
    await connectFully(app.id);
    as.revokeAccessTokens();
    as.revokeRefreshTokens();
    const convId = await createConv(req, orgId, await agentFor(app.id));
    const r = await runTool(convId, 1, "docs__whoami");
    expect(r).toMatchObject({
      isError: true,
      content:
        "The user has not connected Docs. A connect card was shown; ask the user to connect, then retry.",
    });
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "connection_required").map((e) => e.payload)).toMatchObject([
      { appId: app.id, appName: "Docs" },
    ]);
    expect((await getConnector(app.id)).credential.status).toBe("missing");

    await connectFully(app.id);
    const r2 = await runTool(convId, 2, "docs__whoami");
    expect(r2?.isError).toBe(false);
  }, 60_000);

  it("token、refresh token 与 client secret 不出现在日志、事件、审计与 HTTP 响应中", async () => {
    const { as, mcp } = await servers({ accessTokenTtl: 30 });
    const app = await installDcr(mcp);
    await connectFully(app.id);
    const convId = await createConv(req, orgId, await agentFor(app.id));
    await runTool(convId, 1, "docs__whoami");
    as.revokeAccessTokens();
    await runTool(convId, 2, "docs__whoami");
    await call({ method: "GET", url: `/api/v1/orgs/${orgId}/conversations/${convId}/events` });
    const evs = await eventsOf(db, convId);
    const audits = await db.selectFrom("audit_events").selectAll().execute();
    const secrets = as.issuedSecrets();
    expect(secrets.length).toBeGreaterThan(3);
    const haystacks: [string, string][] = [
      ["events", JSON.stringify(evs)],
      ["audit_events", JSON.stringify(audits)],
      ["logs", logLines.join("\n")],
      ["http", httpBodies.join("\n")],
    ];
    for (const [where, text] of haystacks) {
      for (const s of secrets) expect(text.includes(s), `secret leaked into ${where}`).toBe(false);
    }
  }, 60_000);
});

describe("轮换客户端与其他校验", () => {
  it("A18：客户端凭据连接器 PUT 组织凭据 → 先验证再替换客户端与组织 token；错误密钥 502 且不改动", async () => {
    const { as, mcp } = await servers({
      clients: [
        { clientId: "svc", clientSecret: "svc-secret-0123456789abc" },
        { clientId: "svc2", clientSecret: "svc2-secret-0123456789abc" },
      ],
    });
    const res = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: "Svc",
        slug: "svc",
        connector: "fake",
        endpoint: { url: mcp.url },
        auth: {
          type: "oauth_client",
          ownership: "org",
          tokenUrl: `${as.issuer}/token`,
          tokenAuthMethod: "client_secret_post",
        },
        credential: { clientId: "svc", clientSecret: "svc-secret-0123456789abc" },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const connectorId = (res.json() as { connector: AppJson }).connector.id;
    expect(as.tokenRequests.at(-1)).toMatchObject({ clientId: "svc", clientAuth: "post" });

    const bad = await call({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/connectors/${connectorId}/credentials/org`,
      payload: { clientId: "svc2", clientSecret: "wrong-secret-0123456789" },
    });
    expect(bad.statusCode, bad.body).toBe(502);
    expect(bad.json()).toMatchObject({ error: { code: "connector.connect_failed" } });

    const ok = await call({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/connectors/${connectorId}/credentials/org`,
      payload: { clientId: "svc2", clientSecret: "svc2-secret-0123456789abc" },
    });
    expect(ok.statusCode, ok.body).toBe(204);
    expect(as.tokenRequests.at(-1)).toMatchObject({
      clientId: "svc2",
      clientAuth: "post",
      status: 200,
    });
    const audits = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "=", "connector.credential.set")
      .execute();
    expect(audits.map((a) => a.detail)).toEqual([{ type: "oauth_client", ownership: "org" }]);

    // 调用用新客户端换来的 token（缓存已替换，不再取 token）
    const before = as.tokenRequests.length;
    const convId = await createConv(req, orgId, await agentFor(connectorId));
    const r = await runTool(convId, 1, "svc__whoami");
    expect(r?.isError).toBe(false);
    expect(as.tokenRequests.length).toBe(before);

    const missingSecret = await call({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/connectors/${connectorId}/credentials/org`,
      payload: { clientId: "svc2" },
    });
    expect(missingSecret.statusCode).toBe(400);
  }, 60_000);

  it("A18：手填 client 的授权码连接器只替换客户端（成员 token 保留）；DCR 连接器不可替换", async () => {
    const { as, mcp } = await servers({
      clients: [
        { clientId: "m1", clientSecret: "m1-secret-0123456789abc" },
        { clientId: "m2", clientSecret: "m2-secret-0123456789abc" },
      ],
    });
    const res = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: "Docs",
        slug: "docs",
        connector: "fake",
        endpoint: { url: mcp.url },
        auth: { type: "oauth_code", ownership: "personal", discovery: "mcp", client: "manual" },
        credential: { clientId: "m1", clientSecret: "m1-secret-0123456789abc" },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const connectorId = (res.json() as { connector: AppJson }).connector.id;
    await connectFully(connectorId);
    const put = await call({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/connectors/${connectorId}/credentials/org`,
      payload: { clientId: "m2", clientSecret: "m2-secret-0123456789abc" },
    });
    expect(put.statusCode, put.body).toBe(204);
    expect((await getConnector(connectorId)).credential.status).toBe("connected");
    const url = await connect(connectorId);
    expect(url.searchParams.get("client_id")).toBe("m2");

    // DCR 注册的客户端不能被替换
    const other = await servers();
    const dcr = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: "Auto",
        slug: "auto",
        connector: "fake",
        endpoint: { url: other.mcp.url },
        auth: { type: "oauth_code", ownership: "personal", discovery: "mcp", client: "dcr" },
      },
    });
    expect(dcr.statusCode, dcr.body).toBe(201);
    const r = await call({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/connectors/${(dcr.json() as { connector: AppJson }).connector.id}/credentials/org`,
      payload: { clientId: "x", clientSecret: "y" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({
      error: { code: "validation_failed", details: [{ path: "auth.client" }] },
    });
    expect(as.tokenRequests.filter((t) => t.clientId === "m2")).toEqual([]);
  }, 60_000);

  it("RFC 9207：回跳的 iss 与发起时的授权服务器不同 → issuer_mismatch，不换 token", async () => {
    const { as, mcp } = await servers();
    const app = await installDcr(mcp);
    as.forgeIssNext("https://evil.example.com");
    const back = await callback(await approve(await connect(app.id)));
    expect(back).toBe(`${PUBLIC_URL}/settings/connections?oauth_error=issuer_mismatch`);
    expect(as.tokenRequests.filter((r) => r.grantType === "authorization_code")).toEqual([]);
  });

  it("已停用的连接器不能发起连接", async () => {
    const { mcp } = await servers();
    const app = await installDcr(mcp);
    const off = await call({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}`,
      payload: { status: "disabled" },
    });
    expect(off.statusCode, off.body).toBe(200);
    const c = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}/connect`,
      payload: {},
    });
    expect(c.statusCode).toBe(400);
    expect(c.json()).toMatchObject({
      error: { code: "validation_failed", details: [{ path: "status" }] },
    });
  });
});

describe("http.publicUrl 未配置", () => {
  it("OAuth 连接器创建返回 validation_failed（path auth）", async () => {
    const k2 = await createKernel(
      runConfig(
        { pg: pgc.url, redis: rd.url },
        {
          extensions: [MODEL_FAKE, CONNECTOR],
          extensionPermissions: { autoApprove: true },
          extensionConfig: { "fake-connector": { allowInsecureLoopback: true } },
          roles: ["api"],
          tools: { oauthAllowInsecureLoopback: true },
        },
      ),
      { env: {}, logger: createLogger("error", { write: () => {} }) },
    );
    await k2.start();
    try {
      const r2 = await session(k2, "owner");
      for (const auth of [
        { type: "oauth_code", ownership: "personal", discovery: "mcp", client: "dcr" },
        {
          type: "oauth_client",
          ownership: "org",
          tokenUrl: "https://as.example.com/token",
        },
      ]) {
        const res = await r2({
          method: "POST",
          url: `/api/v1/orgs/${orgId}/connectors`,
          payload: {
            name: "Docs",
            connector: "fake",
            endpoint: { url: "https://mcp.example.com/mcp" },
            auth,
            ...(auth.type === "oauth_client" && {
              credential: { clientId: "a", clientSecret: "b" },
            }),
          },
        });
        expect(res.statusCode, res.body).toBe(400);
        const err = (
          res.json() as { error: { code: string; details: { path: string; message: string }[] } }
        ).error;
        expect(err.code).toBe("validation_failed");
        expect(err.details[0]?.path).toBe("auth");
        expect(err.details[0]?.message).toContain("http.publicUrl");
      }
    } finally {
      await k2.stop();
    }
  }, 60_000);
});
