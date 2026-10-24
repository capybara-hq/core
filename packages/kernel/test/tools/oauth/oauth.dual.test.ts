import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type Harness,
  replicaOf,
  startFakeMcpServer,
  startFakeOAuthServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { AccountsService } from "../../../src/identity/accounts.js";
import { MODEL_FAKE } from "../../helpers/model-plugins.js";
import { PW } from "../../helpers/runs.js";

/**
 * Task 15（双副本，独立进程）：在副本 0 发起连接、回调落在副本 1（state 在 Redis，不依赖进程内存）；
 * 授权服务器作废全部 access token 后，两个副本同时刷新连接器工具清单 → 各自收到 401 → 只刷新一次 token
 * （refresh token 轮换，第二次刷新会失败从而暴露并发刷新）。
 */

const CONNECTOR_MCP = fileURLToPath(
  new URL("../../../../../plugins/connector-mcp/src/index.ts", import.meta.url),
);
const PUBLIC_URL = "https://capybara.example.com";

let pgc: TestContainer;
let rdc: TestContainer;
let h: Harness | undefined;

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
}, 120_000);

afterAll(async () => {
  await h?.stop();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

type Json = Record<string, unknown>;

it("跨副本完成连接；两个副本并发 401 只刷新一次", async () => {
  const as = await startFakeOAuthServer({ tokenDelayMs: 400 });
  const mcp = await startFakeMcpServer({
    verifyBearer: (t) => as.verify(t),
    protectedResource: { authorizationServers: [as.issuer], advertise: "header" },
    tools: [{ name: "whoami", annotations: { readOnlyHint: true } }],
  });
  try {
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE, CONNECTOR_MCP],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      extensionConfig: { "connector-mcp": { allowInsecureLoopback: true } },
      config: {
        auth: { cookieSecure: false },
        http: { publicUrl: PUBLIC_URL },
        tools: { oauthAllowInsecureLoopback: true },
      },
    });
    const harness = h;
    const raw = createDb(harness.dbUrl, 2);
    await new AccountsService(kernelDb(raw)).createLocal({
      login: "owner",
      password: PW,
      displayName: "O",
    });
    await raw.destroy();

    const cookies = new Map<string, string>();
    const keep = (res: Response) => {
      for (const c of res.headers.getSetCookie()) {
        const [pair = ""] = c.split(";");
        const i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
    };
    const at = async (i: 0 | 1, method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${harness.replicas[i].port}${path}`, {
        method,
        redirect: "manual",
        headers: {
          "x-capybara-csrf": "1",
          cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      expect(replicaOf(res)).toBe(i);
      keep(res);
      const text = await res.text();
      return {
        status: res.status,
        location: res.headers.get("location"),
        json: (text === "" ? {} : JSON.parse(text)) as Json,
      };
    };

    expect(
      (await at(0, "POST", "/api/v1/auth/login", { login: "owner", password: PW })).status,
    ).toBe(200);
    const org = await at(1, "POST", "/api/v1/orgs", { name: "Acme" });
    const orgId = (org.json.org as { id: string }).id;
    const base = `/api/v1/orgs/${orgId}`;
    const app = await at(0, "POST", `${base}/connectors`, {
      name: "Docs",
      slug: "docs",
      connector: "mcp",
      endpoint: { url: mcp.url },
      auth: { type: "oauth_code", ownership: "personal", discovery: "mcp", client: "dcr" },
    });
    expect(app.status, JSON.stringify(app.json)).toBe(201);
    const connectorId = (app.json.connector as { id: string }).id;

    // 副本 0 发起，回调落在副本 1
    const c = await at(0, "POST", `${base}/connectors/${connectorId}/connect`, {});
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    const authorize = await fetch(c.json.authorizationUrl as string, { redirect: "manual" });
    const back = new URL(authorize.headers.get("location") as string);
    const cb = await at(1, "GET", `${back.pathname}${back.search}`);
    expect(cb.status).toBe(302);
    expect(cb.location).toBe(`${PUBLIC_URL}/settings/connections?connected=${connectorId}`);
    const detail = await at(1, "GET", `${base}/connectors/${connectorId}`);
    expect(
      (detail.json.connector as { tools: { name: string }[] }).tools.map((t) => t.name),
    ).toEqual(["whoami"]);

    // 两个副本同时刷新工具清单：都用已作废的 access token → 401 → 只刷新一次
    as.revokeAccessTokens();
    const before = as.tokenRequests.filter((r) => r.grantType === "refresh_token").length;
    const [r0, r1] = await Promise.all([
      at(0, "POST", `${base}/connectors/${connectorId}/refresh`),
      at(1, "POST", `${base}/connectors/${connectorId}/refresh`),
    ]);
    expect(r0.status, JSON.stringify(r0.json)).toBe(200);
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    const grants = as.tokenRequests.filter((r) => r.grantType === "refresh_token");
    expect(grants.length - before).toBe(1);
    expect(grants.every((g) => g.status === 200)).toBe(true);
  } finally {
    await mcp.stop();
    await as.stop();
  }
}, 120_000);
