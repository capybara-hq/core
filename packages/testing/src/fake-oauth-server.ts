import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** 预注册的客户端（client_credentials 与「手填 client」用）。 */
export interface FakeOAuthClient {
  clientId: string;
  /** 不给 = 公开客户端（只能走授权码 + PKCE）。 */
  clientSecret?: string;
  /** 允许的回调地址；不给 = 任意。 */
  redirectUris?: string[];
}

export interface FakeOAuthServerOptions {
  /** 暴露 DCR（RFC 7591）注册端点；默认 true，运行中可用 `setDcr` 切换。 */
  dcr?: boolean;
  /** 授权服务器元数据的位置：RFC 8414（默认）或只有 OpenID 发现文档。 */
  metadata?: "oauth" | "openid";
  /** access token 有效期（秒），默认 3600；0 = 令牌响应不带 expires_in。 */
  accessTokenTtl?: number;
  clients?: FakeOAuthClient[];
  /** 令牌端点每次响应前等待的毫秒数（放大并发刷新的竞态窗口）。 */
  tokenDelayMs?: number;
  scopesSupported?: string[];
}

/** 令牌端点收到的一次请求（不含任何密钥）。 */
export interface FakeTokenRequest {
  grantType: string;
  clientId: string | undefined;
  resource: string | undefined;
  scope: string | undefined;
  /** 本次响应的 HTTP 状态。 */
  status: number;
}

export interface FakeOAuthServer {
  /** issuer（`http://127.0.0.1:<port>`），也是各端点的基址。 */
  issuer: string;
  tokenRequests: FakeTokenRequest[];
  /** DCR 注册请求体。 */
  registrations: Record<string, unknown>[];
  /** 授权端点收到的查询参数。 */
  authorizeRequests: URLSearchParams[];
  /** 该 access token 当前有效（存在、未过期、未作废）。 */
  verify(accessToken: string): boolean;
  /** 已签发的全部 access / refresh token 与客户端密钥（断言「不出现在日志 / 事件」用）。 */
  issuedSecrets(): string[];
  /** 作废全部 access token（refresh token 仍有效）：资源服务随之返回 401。 */
  revokeAccessTokens(): void;
  /** 作废全部 refresh token：之后的刷新返回 `invalid_grant`。 */
  revokeRefreshTokens(): void;
  /** 下一次授权请求以该 OAuth 错误回跳。 */
  denyNext(error: string, description?: string): void;
  setDcr(enabled: boolean): void;
  stop(): Promise<void>;
}

const b64url = (b: Buffer) => b.toString("base64url");
const rand = (prefix: string) => `${prefix}${b64url(randomBytes(18))}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

interface CodeGrant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string | undefined;
  resource: string | undefined;
}

interface Client {
  clientId: string;
  clientSecret: string | undefined;
  redirectUris: string[] | undefined;
}

/**
 * 本地假 OAuth 授权服务器（127.0.0.1 随机端口）：元数据（RFC 8414 或 OpenID 发现）、授权端点（不出页面、自动
 * 批准，强制 PKCE S256）、令牌端点（授权码 + PKCE 校验、refresh 轮换、client_credentials）、可开关的 DCR 端点。
 */
export async function startFakeOAuthServer(
  opts: FakeOAuthServerOptions = {},
): Promise<FakeOAuthServer> {
  let dcr = opts.dcr ?? true;
  const ttl = opts.accessTokenTtl ?? 3600;
  const clients = new Map<string, Client>(
    (opts.clients ?? []).map((c) => [
      c.clientId,
      { clientId: c.clientId, clientSecret: c.clientSecret, redirectUris: c.redirectUris },
    ]),
  );
  const codes = new Map<string, CodeGrant>();
  const access = new Map<string, { expiresAt: number | null }>();
  const refresh = new Map<string, { clientId: string; scope: string | undefined }>();
  const secrets = new Set<string>();
  const tokenRequests: FakeTokenRequest[] = [];
  const registrations: Record<string, unknown>[] = [];
  const authorizeRequests: URLSearchParams[] = [];
  let deny: { error: string; description: string | undefined } | undefined;
  let issuer = "";

  const metadata = () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    ...(dcr && { registration_endpoint: `${issuer}/register` }),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    ...(opts.scopesSupported !== undefined && { scopes_supported: opts.scopesSupported }),
  });

  const issue = (clientId: string, scope: string | undefined, withRefresh: boolean) => {
    const accessToken = rand("at_");
    access.set(accessToken, { expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : null });
    secrets.add(accessToken);
    const body: Record<string, unknown> = { access_token: accessToken, token_type: "Bearer" };
    if (ttl > 0) body.expires_in = ttl;
    if (scope !== undefined) body.scope = scope;
    if (withRefresh) {
      const refreshToken = rand("rt_");
      refresh.set(refreshToken, { clientId, scope });
      secrets.add(refreshToken);
      body.refresh_token = refreshToken;
    }
    return body;
  };

  /** 客户端认证：Basic 头或表单里的 client_id / client_secret；公开客户端只带 client_id。 */
  const authenticate = (req: IncomingMessage, form: URLSearchParams): Client | undefined => {
    let id = form.get("client_id") ?? undefined;
    let secret = form.get("client_secret") ?? undefined;
    const h = req.headers.authorization;
    if (h?.startsWith("Basic ")) {
      const decoded = Buffer.from(h.slice(6), "base64").toString("utf8");
      const i = decoded.indexOf(":");
      id = decodeURIComponent(decoded.slice(0, i));
      secret = decodeURIComponent(decoded.slice(i + 1));
    }
    const c = id === undefined ? undefined : clients.get(id);
    if (!c) return undefined;
    if (c.clientSecret !== undefined && c.clientSecret !== secret) return undefined;
    return c;
  };

  const token = async (req: IncomingMessage, res: ServerResponse) => {
    const form = new URLSearchParams(await readBody(req));
    if (opts.tokenDelayMs) await sleep(opts.tokenDelayMs);
    const grantType = form.get("grant_type") ?? "";
    const entry: FakeTokenRequest = {
      grantType,
      clientId: undefined,
      resource: form.get("resource") ?? undefined,
      scope: form.get("scope") ?? undefined,
      status: 200,
    };
    tokenRequests.push(entry);
    const fail = (status: number, error: string) => {
      entry.status = status;
      json(res, status, { error, error_description: `fake: ${error}` });
    };
    const client = authenticate(req, form);
    if (!client) return fail(401, "invalid_client");
    entry.clientId = client.clientId;

    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      const grant = codes.get(code);
      codes.delete(code);
      if (!grant || grant.clientId !== client.clientId) return fail(400, "invalid_grant");
      if (form.get("redirect_uri") !== grant.redirectUri) return fail(400, "invalid_grant");
      const verifier = form.get("code_verifier") ?? "";
      if (b64url(createHash("sha256").update(verifier).digest()) !== grant.challenge) {
        return fail(400, "invalid_grant");
      }
      if (grant.resource !== undefined && form.get("resource") !== grant.resource) {
        return fail(400, "invalid_target");
      }
      return json(res, 200, issue(client.clientId, grant.scope, true));
    }
    if (grantType === "refresh_token") {
      const rt = form.get("refresh_token") ?? "";
      const r = refresh.get(rt);
      if (!r || r.clientId !== client.clientId) return fail(400, "invalid_grant");
      // 轮换：旧 refresh token 立即作废
      refresh.delete(rt);
      return json(res, 200, issue(client.clientId, r.scope, true));
    }
    if (grantType === "client_credentials") {
      if (client.clientSecret === undefined) return fail(401, "invalid_client");
      return json(res, 200, issue(client.clientId, form.get("scope") ?? undefined, false));
    }
    return fail(400, "unsupported_grant_type");
  };

  const authorize = (url: URL, res: ServerResponse) => {
    const q = url.searchParams;
    authorizeRequests.push(new URLSearchParams(q));
    const client = clients.get(q.get("client_id") ?? "");
    const redirectUri = q.get("redirect_uri") ?? "";
    if (!client || (client.redirectUris && !client.redirectUris.includes(redirectUri))) {
      res.writeHead(400, { "content-type": "text/plain" });
      return res.end("invalid client or redirect_uri");
    }
    const back = new URL(redirectUri);
    const state = q.get("state");
    if (state !== null) back.searchParams.set("state", state);
    const challenge = q.get("code_challenge");
    if (deny) {
      back.searchParams.set("error", deny.error);
      if (deny.description !== undefined)
        back.searchParams.set("error_description", deny.description);
      deny = undefined;
    } else if (q.get("response_type") !== "code") {
      back.searchParams.set("error", "unsupported_response_type");
    } else if (!challenge || q.get("code_challenge_method") !== "S256") {
      back.searchParams.set("error", "invalid_request");
      back.searchParams.set("error_description", "PKCE S256 is required");
    } else {
      const code = rand("code_");
      codes.set(code, {
        clientId: client.clientId,
        redirectUri,
        challenge,
        scope: q.get("scope") ?? undefined,
        resource: q.get("resource") ?? undefined,
      });
      back.searchParams.set("code", code);
    }
    res.writeHead(302, { location: back.toString() });
    res.end();
  };

  const register = async (req: IncomingMessage, res: ServerResponse) => {
    const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
    registrations.push(body);
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0) {
      return json(res, 400, { error: "invalid_redirect_uri" });
    }
    const method =
      typeof body.token_endpoint_auth_method === "string"
        ? body.token_endpoint_auth_method
        : "client_secret_basic";
    const clientId = rand("client_");
    const clientSecret = method === "none" ? undefined : rand("secret_");
    if (clientSecret) secrets.add(clientSecret);
    clients.set(clientId, { clientId, clientSecret, redirectUris: uris as string[] });
    json(res, 201, {
      ...body,
      client_id: clientId,
      ...(clientSecret !== undefined && {
        client_secret: clientSecret,
        client_secret_expires_at: 0,
      }),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: method,
    });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", issuer);
    const path = url.pathname;
    if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      if ((opts.metadata ?? "oauth") !== "oauth") return json(res, 404, { error: "not_found" });
      return json(res, 200, metadata());
    }
    if (req.method === "GET" && path === "/.well-known/openid-configuration") {
      if (opts.metadata !== "openid") return json(res, 404, { error: "not_found" });
      return json(res, 200, { ...metadata(), subject_types_supported: ["public"] });
    }
    if (req.method === "GET" && path === "/authorize") return authorize(url, res);
    if (req.method === "POST" && path === "/token") return token(req, res);
    if (req.method === "POST" && path === "/register") {
      if (!dcr) return json(res, 404, { error: "not_found" });
      return register(req, res);
    }
    json(res, 404, { error: "not_found" });
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) json(res, 500, { error: "server_error", detail: String(e) });
      else res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  issuer = `http://127.0.0.1:${port}`;
  return {
    issuer,
    tokenRequests,
    registrations,
    authorizeRequests,
    verify: (t) => {
      const a = access.get(t);
      return a !== undefined && (a.expiresAt === null || a.expiresAt > Date.now());
    },
    issuedSecrets: () => [...secrets],
    revokeAccessTokens: () => access.clear(),
    revokeRefreshTokens: () => refresh.clear(),
    denyNext: (error, description) => {
      deny = { error, description };
    },
    setDcr: (enabled) => {
      dcr = enabled;
    },
    stop: () =>
      new Promise<void>((resolve, reject) => {
        http.closeAllConnections();
        http.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
