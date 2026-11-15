import type { KernelConfig } from "../../config/schema.js";
import { type LookupFn, NetDeniedError, type NetPolicy } from "../../net/public-address.js";
import { NetBodyTooLargeError, safeFetch } from "../../net/safe-fetch.js";
import type { OAuthClientRecord, TokenAuthMethod } from "./tokens.js";

/**
 * MCP OAuth discovery and dynamic registration (the MCP authorization spec):
 * RFC 9728 protected resource metadata (a 401's `WWW-Authenticate: Bearer resource_metadata=…`, or
 * `/.well-known/oauth-protected-resource[/<path>]`) -> RFC 8414 authorization server metadata
 * (the OpenID discovery document as a fallback) -> RFC 7591 dynamic client registration.
 *
 * Written here rather than taken from a library: the kernel needs only these few round trips, and
 * they must share one set of rules ("no redirects, a time limit, a body cap, https only, the
 * deployment's network rules") and one error mapping (a reason code and an English message, never
 * the remote's body). `oauth4webapi` forbids http by default and brings its own error model for
 * about as much code; the MCP SDK's client auth helpers revolve around an interactive
 * `OAuthClientProvider` and would pull the MCP SDK into a protocol-agnostic kernel.
 *
 * Every round trip goes through `packages/kernel/src/net` ({@link safeFetch}): the host must
 * resolve to public addresses (or be exempt by `marketplaces.allowPrivateHosts`), the connection is
 * pinned to the checked address, `net.httpsProxy` tunnels https, and redirects are never followed.
 */

export interface OAuthHttpOptions {
  /** The network rules ({@link oauthNetPolicy}). */
  net: NetPolicy;
  timeoutMs: number;
  /** Tests only: replaces the DNS lookup. */
  lookup?: LookupFn;
}

/**
 * The network rules of every OAuth round trip (discovery, registration, token endpoint, the setup
 * check's token probe): the deployment's egress proxy (`net.httpsProxy` / `net.noProxy`), its
 * private host exemptions (`marketplaces.allowPrivateHosts`, the one list of internal hosts the
 * kernel may reach) and loopback http only under `tools.oauthAllowInsecureLoopback` (tests).
 */
export function oauthNetPolicy(cfg: KernelConfig): NetPolicy {
  return {
    allowInsecureLoopback: cfg.tools.oauthAllowInsecureLoopback,
    allowPrivateHosts: cfg.marketplaces.allowPrivateHosts,
    trustedOrigins: [],
    ...(cfg.net.httpsProxy !== undefined && {
      proxy: { url: cfg.net.httpsProxy, noProxy: cfg.net.noProxy },
    }),
  };
}

/** The OAuth round trip options: the network rules, and the tool timeout capped at 30 seconds. */
export function oauthHttpOptions(cfg: KernelConfig): OAuthHttpOptions {
  return {
    net: oauthNetPolicy(cfg),
    timeoutMs: Math.min(cfg.tools.timeoutMs, 30_000),
  };
}

export type OAuthSetupReason =
  | "insecure_url"
  | "address_refused"
  | "discovery_failed"
  | "dcr_unsupported"
  | "dcr_failed"
  | "token_failed";

/**
 * Discovery / registration / the install-time token request failed: the reason code lets the
 * wizard branch (e.g. `dcr_unsupported` -> a manual client), the message is English.
 */
export class OAuthSetupError extends Error {
  constructor(
    readonly reason: OAuthSetupReason,
    message: string,
  ) {
    super(message);
    this.name = "OAuthSetupError";
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** The size cap of a metadata / token answer. */
const MAX_BODY_BYTES = 1024 * 1024;

/** https only (loopback http when allowed), and no user information in the URL. */
export function checkOAuthUrl(raw: string, http: OAuthHttpOptions): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OAuthSetupError("discovery_failed", "An OAuth URL is not a valid absolute URL");
  }
  const ok =
    u.protocol === "https:" ||
    (u.protocol === "http:" && http.net.allowInsecureLoopback && LOOPBACK.has(u.hostname));
  if (!ok) {
    throw new OAuthSetupError(
      "insecure_url",
      `OAuth URLs must use https (got ${u.protocol}//${u.host})`,
    );
  }
  if (u.username !== "" || u.password !== "") {
    throw new OAuthSetupError("insecure_url", "OAuth URLs must not contain user information");
  }
  return u;
}

export interface OAuthResponse {
  status: number;
  headers: Headers;
  text: string;
}

/**
 * One OAuth round trip through {@link safeFetch}: the URL is checked, a time limit applies and a
 * body over 1 MiB aborts. An address the network rules refuse (private / reserved, or not https)
 * is an {@link OAuthSetupError} `address_refused` / `insecure_url` with an actionable English
 * message. A redirect is never followed: it throws a plain error, as a network error or a timeout
 * does, so callers handle it as "this location did not answer".
 */
export async function oauthFetch(
  url: string,
  init: RequestInit,
  http: OAuthHttpOptions,
): Promise<OAuthResponse> {
  checkOAuthUrl(url, http);
  let res: Response;
  try {
    res = await safeFetch(url, { ...init, signal: AbortSignal.timeout(http.timeoutMs) }, http.net, {
      maxBytes: MAX_BODY_BYTES,
      ...(http.lookup !== undefined && { lookup: http.lookup }),
    });
  } catch (e) {
    if (e instanceof NetDeniedError && e.code === "net.private_address") {
      throw new OAuthSetupError("address_refused", `OAuth: ${e.message}`);
    }
    if (e instanceof NetDeniedError && e.code === "net.insecure_url") {
      throw new OAuthSetupError("insecure_url", `OAuth: ${e.message}`);
    }
    throw e;
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if (e instanceof NetBodyTooLargeError) throw new Error("OAuth response is too large");
    throw e;
  }
  return { status: res.status, headers: res.headers, text };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

/** `WWW-Authenticate: Bearer k="v", …` 中某个参数（带引号或不带）。 */
function challengeParam(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  const m = new RegExp(`(?:^|[\\s,])${name}\\s*=\\s*(?:"([^"]*)"|([^\\s,]+))`, "i").exec(header);
  return m ? (m[1] ?? m[2]) : undefined;
}

/** 发现结果：授权服务器端点 + 资源标识（RFC 8707 `resource` 参数）。 */
export interface McpAuthMetadata {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** 401 的 `scope` 参数，或受保护资源元数据的 `scopes_supported`。 */
  scopes?: string[];
  /** 授权服务器的 `token_endpoint_auth_methods_supported`。 */
  authMethods?: string[];
}

const failed = (message: string) => new OAuthSetupError("discovery_failed", message);

/** 依次 GET 候选地址，返回第一个 200 且为 JSON 对象的正文；网络错误按「这个位置没有」处理。 */
async function firstJson(
  urls: string[],
  http: OAuthHttpOptions,
): Promise<Record<string, unknown> | undefined> {
  for (const url of urls) {
    let res: OAuthResponse;
    try {
      res = await oauthFetch(url, { headers: { accept: "application/json" } }, http);
    } catch (e) {
      if (e instanceof OAuthSetupError) throw e;
      continue;
    }
    if (res.status !== 200) continue;
    const body = parseJson(res.text);
    if (isObj(body)) return body;
  }
  return undefined;
}

/** 资源标识与端点：同源，且端点路径以资源路径为前缀（MCP 规范的资源匹配）。 */
function resourceMatches(resource: string, endpoint: URL): boolean {
  let r: URL;
  try {
    r = new URL(resource);
  } catch {
    return false;
  }
  if (r.origin !== endpoint.origin) return false;
  const rp = r.pathname.endsWith("/") ? r.pathname : `${r.pathname}/`;
  const ep = endpoint.pathname.endsWith("/") ? endpoint.pathname : `${endpoint.pathname}/`;
  return ep.startsWith(rp);
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

/**
 * 对 MCP 端点做 OAuth 发现：先以不带凭据的 `initialize` 探测拿 401 的 `WWW-Authenticate`，再取受保护资源元数据，
 * 再取授权服务器元数据（RFC 8414 §3.1 的路径插入式，OpenID 发现作回退）。校验资源标识与端点匹配、
 * 元数据 `issuer` 与授权服务器标识一致、声明了 PKCE 方法时必须含 S256。
 */
export async function discoverMcp(
  endpointUrl: string,
  http: OAuthHttpOptions,
): Promise<McpAuthMetadata> {
  const endpoint = checkOAuthUrl(endpointUrl, http);
  let challenge: string | null = null;
  try {
    const probe = await oauthFetch(
      endpoint.toString(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "capybara", version: "0.1.0" },
          },
        }),
      },
      http,
    );
    if (probe.status === 401) challenge = probe.headers.get("www-authenticate");
  } catch (e) {
    if (e instanceof OAuthSetupError) throw e;
    // a redirect is not followed and carries no challenge: fall back to the well-known locations
    if (!(e instanceof NetDeniedError && e.code === "net.redirect")) {
      throw failed("Could not reach the connector's server for OAuth discovery");
    }
  }

  const metadataUrl = challengeParam(challenge, "resource_metadata");
  const prmCandidates: string[] = [];
  if (metadataUrl !== undefined) {
    prmCandidates.push(checkOAuthUrl(metadataUrl, http).toString());
  } else {
    const path = trimSlash(endpoint.pathname);
    if (path !== "")
      prmCandidates.push(`${endpoint.origin}/.well-known/oauth-protected-resource${path}`);
    prmCandidates.push(`${endpoint.origin}/.well-known/oauth-protected-resource`);
  }
  const prm = await firstJson(prmCandidates, http);
  if (!prm) {
    throw failed(
      "The connector's server did not publish OAuth protected resource metadata (RFC 9728)",
    );
  }
  const resource = prm.resource;
  const servers = strings(prm.authorization_servers);
  if (typeof resource !== "string" || !servers || servers.length === 0) {
    throw failed("The protected resource metadata lacks resource or authorization_servers");
  }
  if (!resourceMatches(resource, endpoint)) {
    throw failed(
      "The protected resource metadata names a different resource than the connector's URL",
    );
  }

  const issuer = servers[0] as string;
  const as = checkOAuthUrl(issuer, http);
  const asPath = trimSlash(as.pathname);
  const asCandidates =
    asPath === ""
      ? [
          `${as.origin}/.well-known/oauth-authorization-server`,
          `${as.origin}/.well-known/openid-configuration`,
        ]
      : [
          `${as.origin}/.well-known/oauth-authorization-server${asPath}`,
          `${as.origin}/.well-known/openid-configuration${asPath}`,
          `${as.origin}${asPath}/.well-known/openid-configuration`,
        ];
  const meta = await firstJson(asCandidates, http);
  if (!meta) throw failed("The authorization server did not publish its metadata (RFC 8414)");
  // RFC 8414 §3.3：元数据的 issuer 必须与授权服务器标识完全相同
  if (meta.issuer !== issuer) {
    throw failed("The authorization server metadata issuer does not match the server");
  }
  const authz = meta.authorization_endpoint;
  const token = meta.token_endpoint;
  if (typeof authz !== "string" || typeof token !== "string") {
    throw failed("The authorization server metadata lacks authorization or token endpoints");
  }
  checkOAuthUrl(authz, http);
  checkOAuthUrl(token, http);
  const pkce = strings(meta.code_challenge_methods_supported);
  // MCP 授权规范：授权服务器必须声明支持 S256，未声明即拒绝
  if (!pkce?.includes("S256")) {
    throw failed(
      "The authorization server does not advertise PKCE S256 support (code_challenge_methods_supported)",
    );
  }
  const reg = meta.registration_endpoint;
  if (reg !== undefined && typeof reg !== "string") {
    throw failed("The authorization server metadata has an invalid registration_endpoint");
  }
  const scopeParam = challengeParam(challenge, "scope");
  const scopes =
    scopeParam !== undefined
      ? scopeParam.split(/\s+/).filter(Boolean)
      : strings(prm.scopes_supported);
  const authMethods = strings(meta.token_endpoint_auth_methods_supported);
  return {
    resource,
    issuer,
    authorizationEndpoint: authz,
    tokenEndpoint: token,
    ...(reg !== undefined && { registrationEndpoint: reg }),
    ...(scopes !== undefined && scopes.length > 0 && { scopes }),
    ...(authMethods !== undefined && { authMethods }),
  };
}

/** 按授权服务器声明的方法选客户端认证方式（未声明时 RFC 8414 默认 client_secret_basic）。 */
export function pickAuthMethod(
  supported: string[] | undefined,
  hasSecret: boolean,
): TokenAuthMethod {
  if (!hasSecret) return "none";
  if (!supported || supported.includes("client_secret_basic")) return "client_secret_basic";
  if (supported.includes("client_secret_post")) return "client_secret_post";
  return supported.includes("none") ? "none" : "client_secret_basic";
}

/**
 * 动态客户端注册（RFC 7591），每个连接器注册一次。授权服务器没有注册端点 → `dcr_unsupported`（向导据此改为手填
 * client）。注册失败只报 HTTP 状态，不带对方正文。
 */
export async function registerClient(
  meta: McpAuthMetadata,
  redirectUri: string,
  http: OAuthHttpOptions,
  /** 管理员指定的客户端认证方式（`tokenAuthMethod`）；不给则按授权服务器声明选择。 */
  preferred?: TokenAuthMethod,
): Promise<OAuthClientRecord> {
  if (!meta.registrationEndpoint) {
    throw new OAuthSetupError(
      "dcr_unsupported",
      "The authorization server does not support dynamic client registration; provide a client ID (and secret) registered with it",
    );
  }
  // 优先机密客户端（client_secret_basic / post）；授权服务器两者都不支持时注册为公开客户端（只靠 PKCE）
  const wanted = preferred ?? pickAuthMethod(meta.authMethods, true);
  let res: OAuthResponse;
  try {
    res = await oauthFetch(
      meta.registrationEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_name: "Capybara",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: wanted,
          ...(meta.scopes && { scope: meta.scopes.join(" ") }),
        }),
      },
      http,
    );
  } catch (e) {
    if (e instanceof OAuthSetupError) throw e;
    throw new OAuthSetupError("dcr_failed", "Could not reach the client registration endpoint");
  }
  const body = parseJson(res.text);
  if (
    (res.status !== 201 && res.status !== 200) ||
    !isObj(body) ||
    typeof body.client_id !== "string"
  ) {
    throw new OAuthSetupError(
      "dcr_failed",
      `Dynamic client registration failed (HTTP ${res.status})`,
    );
  }
  const secret =
    typeof body.client_secret === "string" && body.client_secret !== ""
      ? body.client_secret
      : undefined;
  const method = body.token_endpoint_auth_method;
  const authMethod: TokenAuthMethod =
    method === "client_secret_basic" || method === "client_secret_post" || method === "none"
      ? method
      : pickAuthMethod(meta.authMethods, secret !== undefined);
  const regToken = body.registration_access_token;
  const regUri = body.registration_client_uri;
  return {
    clientId: body.client_id,
    ...(secret !== undefined && { clientSecret: secret }),
    authMethod,
    authorizationEndpoint: meta.authorizationEndpoint,
    tokenEndpoint: meta.tokenEndpoint,
    resource: meta.resource,
    issuer: meta.issuer,
    ...(meta.scopes && { scopes: meta.scopes }),
    registration: {
      ...(typeof regToken === "string" && { accessToken: regToken }),
      ...(typeof regUri === "string" && { clientUri: regUri }),
      ...(typeof body.client_id_issued_at === "number" && { issuedAt: body.client_id_issued_at }),
    },
  };
}
