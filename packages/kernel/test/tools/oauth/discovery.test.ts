import {
  type FakeMcpServer,
  type FakeOAuthServer,
  startFakeMcpServer,
  startFakeOAuthServer,
} from "@capybara-hq/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverMcp,
  OAuthSetupError,
  registerClient,
} from "../../../src/tools/oauth/discovery.js";

/**
 * Task 15：MCP OAuth 发现（RFC 9728 → RFC 8414 / OpenID 回退）与 DCR（RFC 7591）。只用本地夹具，不起内核。
 */

const HTTP = { allowInsecureLoopback: true, timeoutMs: 5_000 };
const CALLBACK = "https://capybara.example.com/api/v1/oauth/callback";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup(
  advertise: "header" | "well-known",
  asOpts: Parameters<typeof startFakeOAuthServer>[0] = {},
): Promise<{ as: FakeOAuthServer; mcp: FakeMcpServer }> {
  const as = await startFakeOAuthServer(asOpts);
  stops.push(() => as.stop());
  const mcp = await startFakeMcpServer({
    tools: [],
    verifyBearer: (t) => as.verify(t),
    protectedResource: {
      authorizationServers: [as.issuer],
      scopesSupported: ["docs.read"],
      advertise,
    },
  });
  stops.push(() => mcp.stop());
  return { as, mcp };
}

describe("discoverMcp", () => {
  it("401 的 WWW-Authenticate 带 resource_metadata → 受保护资源元数据 → 授权服务器元数据", async () => {
    const { as, mcp } = await setup("header");
    const meta = await discoverMcp(mcp.url, HTTP);
    expect(meta).toMatchObject({
      resource: mcp.url,
      issuer: as.issuer,
      authorizationEndpoint: `${as.issuer}/authorize`,
      tokenEndpoint: `${as.issuer}/token`,
      registrationEndpoint: `${as.issuer}/register`,
      scopes: ["docs.read"],
    });
    // 探测请求不带任何凭据
    expect(mcp.requests.every((r) => r.headers.authorization === undefined)).toBe(true);
  });

  it("401 不带 resource_metadata → 回退 /.well-known/oauth-protected-resource/<path>", async () => {
    const { as, mcp } = await setup("well-known");
    const meta = await discoverMcp(mcp.url, HTTP);
    expect(meta.resource).toBe(mcp.url);
    expect(meta.tokenEndpoint).toBe(`${as.issuer}/token`);
  });

  it("授权服务器只有 OpenID 发现文档 → 回退 /.well-known/openid-configuration", async () => {
    const { as, mcp } = await setup("header", { metadata: "openid" });
    const meta = await discoverMcp(mcp.url, HTTP);
    expect(meta.authorizationEndpoint).toBe(`${as.issuer}/authorize`);
  });

  it("本机 http 未放行 → insecure_url；服务不要求 OAuth → discovery_failed", async () => {
    const { mcp } = await setup("header");
    await expect(discoverMcp(mcp.url, { ...HTTP, allowInsecureLoopback: false })).rejects.toThrow(
      expect.objectContaining({ reason: "insecure_url" }),
    );
    const open = await startFakeMcpServer({ tools: [] });
    stops.push(() => open.stop());
    const err = await discoverMcp(open.url, HTTP).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthSetupError);
    expect((err as OAuthSetupError).reason).toBe("discovery_failed");
  });
});

describe("discoverMcp 的严格校验", () => {
  it("授权服务器未声明 S256（不声明或只有 plain）→ discovery_failed", async () => {
    for (const pkceMethods of [null, ["plain"]]) {
      const { mcp } = await setup("header", { pkceMethods });
      const err = await discoverMcp(mcp.url, HTTP).catch((e: unknown) => e);
      expect(err).toMatchObject({
        reason: "discovery_failed",
        message: expect.stringContaining("S256"),
      });
    }
  });

  it("issuer 必须完全相同（多一个结尾斜杠也拒绝）", async () => {
    const as = await startFakeOAuthServer();
    stops.push(() => as.stop());
    const mcp = await startFakeMcpServer({
      tools: [],
      verifyBearer: (t) => as.verify(t),
      protectedResource: { authorizationServers: [`${as.issuer}/`], advertise: "header" },
    });
    stops.push(() => mcp.stop());
    const err = await discoverMcp(mcp.url, HTTP).catch((e: unknown) => e);
    expect(err).toMatchObject({
      reason: "discovery_failed",
      message: expect.stringContaining("issuer"),
    });
  });
});

describe("registerClient（DCR）", () => {
  it("注册成功：回调地址、授权码 + refresh 授权类型；返回 client 与端点", async () => {
    const { as, mcp } = await setup("header");
    const meta = await discoverMcp(mcp.url, HTTP);
    const client = await registerClient(meta, CALLBACK, HTTP);
    expect(client).toMatchObject({
      clientId: expect.stringMatching(/^client_/),
      clientSecret: expect.stringMatching(/^secret_/),
      authMethod: "client_secret_basic",
      authorizationEndpoint: `${as.issuer}/authorize`,
      tokenEndpoint: `${as.issuer}/token`,
      resource: mcp.url,
      issuer: as.issuer,
    });
    expect(as.registrations[0]).toMatchObject({
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  it("指定 client_secret_post → 按此注册", async () => {
    const { as, mcp } = await setup("header");
    const meta = await discoverMcp(mcp.url, HTTP);
    const client = await registerClient(meta, CALLBACK, HTTP, "client_secret_post");
    expect(client.authMethod).toBe("client_secret_post");
    expect(as.registrations[0]).toMatchObject({ token_endpoint_auth_method: "client_secret_post" });
  });

  it("授权服务器不支持 DCR → dcr_unsupported", async () => {
    const { mcp } = await setup("header", { dcr: false });
    const meta = await discoverMcp(mcp.url, HTTP);
    await expect(registerClient(meta, CALLBACK, HTTP)).rejects.toThrow(
      expect.objectContaining({ reason: "dcr_unsupported" }),
    );
  });
});
