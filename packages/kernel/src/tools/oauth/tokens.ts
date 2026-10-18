import { randomUUID } from "node:crypto";
import type { Logger } from "@capybara-hq/plugin-sdk";
import { ToolError } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import { type OAuthHttpOptions, OAuthSetupError, oauthFetch } from "./discovery.js";

export type TokenAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

/**
 * 一个应用的 OAuth 客户端（组织级凭据，键 `credentials:app:<appId>:client`）：DCR 注册所得或管理员手填，
 * 连同发现得到的端点与资源标识。
 */
export interface OAuthClientRecord {
  clientId: string;
  clientSecret?: string;
  authMethod: TokenAuthMethod;
  /** 授权码流才有。 */
  authorizationEndpoint?: string;
  tokenEndpoint: string;
  /** RFC 8707 `resource` 参数（MCP 发现所得）。 */
  resource?: string;
  scopes?: string[];
  /** DCR 返回的注册信息（`registration_access_token` 为密钥）。 */
  registration?: { accessToken?: string; clientUri?: string; issuedAt?: number };
}

/** 令牌（个人凭据：授权码流；组织凭据：客户端凭据流的缓存）。`expires_at` 为毫秒时间戳，null = 未告知。 */
export interface OAuthTokenRecord {
  access_token: string;
  refresh_token?: string;
  expires_at: number | null;
  token_type: string;
  scope?: string;
}

export type OAuthOwner = { kind: "org" } | { kind: "user"; accountId: string };

/** 令牌端点明确拒绝（4xx + OAuth 错误码，如 `invalid_grant`）：凭据已失效，重试无用。 */
export class OAuthGrantError extends Error {
  constructor(readonly error: string) {
    super(`The authorization server rejected the token request (${error})`);
    this.name = "OAuthGrantError";
  }
}

/** 授权服务器暂时不可用（网络、超时、5xx、畸形响应）：模型可见的英文说明，计入「服务不可用」。 */
export class OAuthUnavailable extends ToolError {
  constructor(
    message = "Could not obtain an access token: the app's authorization server is unavailable. Try again later.",
  ) {
    super(message, { kind: "unavailable" });
    this.name = "OAuthUnavailable";
  }
}

/** 刷新失败且已把凭据删除：需要（重新）连接。Credentials 把它换成 CredentialMissing。 */
export class OAuthReconnectRequired extends Error {
  constructor(readonly owner: OAuthOwner) {
    super("The OAuth credential is invalid and must be connected again");
    this.name = "OAuthReconnectRequired";
  }
}

/** access token 过期前多久就刷新。 */
export const REFRESH_MARGIN_MS = 60_000;
/** 等锁时的轮询间隔（本进程自己的等待）。 */
const LOCK_POLL_MS = 50;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 只把形如 OAuth 错误码的串写进日志 / 错误（不回显对方任意文本）。 */
const safeCode = (v: unknown, fallback: string): string =>
  typeof v === "string" && /^[a-z0-9_.-]{1,64}$/i.test(v) ? v : fallback;

/**
 * 调令牌端点（RFC 6749 §3.2）：按客户端认证方式带 client_id / secret（Basic 按 §2.3.1 先表单编码）。
 * 4xx → OAuthGrantError（错误码）；网络错误、超时、5xx、3xx、畸形响应 → OAuthUnavailable。
 */
export async function tokenRequest(
  client: OAuthClientRecord,
  params: Record<string, string | undefined>,
  http: OAuthHttpOptions,
): Promise<OAuthTokenRecord> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") form.set(k, v);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (client.authMethod === "client_secret_basic" && client.clientSecret !== undefined) {
    const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");
    headers.authorization = `Basic ${Buffer.from(
      `${enc(client.clientId)}:${enc(client.clientSecret)}`,
    ).toString("base64")}`;
  } else {
    form.set("client_id", client.clientId);
    if (client.authMethod === "client_secret_post" && client.clientSecret !== undefined) {
      form.set("client_secret", client.clientSecret);
    }
  }
  let res: Awaited<ReturnType<typeof oauthFetch>>;
  try {
    res = await oauthFetch(client.tokenEndpoint, { method: "POST", headers, body: form }, http);
  } catch (e) {
    if (e instanceof OAuthSetupError) throw e;
    throw new OAuthUnavailable();
  }
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    body = undefined;
  }
  if (res.status >= 400 && res.status < 500) {
    throw new OAuthGrantError(safeCode(isObj(body) ? body.error : undefined, `http_${res.status}`));
  }
  if (res.status !== 200 || !isObj(body)) throw new OAuthUnavailable();
  const { access_token, refresh_token, expires_in, token_type, scope } = body;
  if (typeof access_token !== "string" || access_token === "") throw new OAuthUnavailable();
  const type = typeof token_type === "string" ? token_type : "Bearer";
  if (type.toLowerCase() !== "bearer") throw new OAuthGrantError("unsupported_token_type");
  return {
    access_token,
    ...(typeof refresh_token === "string" && refresh_token !== "" && { refresh_token }),
    expires_at:
      typeof expires_in === "number" && Number.isFinite(expires_in) && expires_in > 0
        ? Date.now() + expires_in * 1000
        : null,
    token_type: "Bearer",
    ...(typeof scope === "string" && { scope }),
  };
}

/** 令牌与客户端的存取（由 Credentials 实现：信封加密存入 capybara.secrets）。 */
export interface OAuthStore {
  readClient(orgId: string, appId: string): Promise<OAuthClientRecord | null>;
  readTokens(orgId: string, appId: string, owner: OAuthOwner): Promise<OAuthTokenRecord | null>;
  writeTokens(
    orgId: string,
    appId: string,
    owner: OAuthOwner,
    rec: OAuthTokenRecord,
  ): Promise<void>;
  deleteTokens(orgId: string, appId: string, owner: OAuthOwner): Promise<void>;
}

/** 取 token 所需的认证方式字段（与 credentials.ts 的 OAuthAuth 对应）。 */
export type TokenAuth =
  | { type: "oauth_code" }
  | { type: "oauth_client"; scopes?: string[] | undefined };

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * access token 的获取与刷新。
 *
 * - 调用前：未过期（距过期 > 60 秒或未告知过期时间）直接用；否则刷新（授权码流用 refresh token，客户端凭据流重新取）。
 * - 收到 401：`forceRefresh(stale)`——只要库里的 token 仍是收到 401 的那个就刷新。
 * - 刷新一律在 Redis 锁 `capk:oauth-refresh:<orgId>:<appId>:<owner>` 内进行（SET NX PX，值为本次随机 id，
 *   只删除自己持有的锁）；拿不到锁的轮询等锁消失后重读凭据，库里已是别的 token 就直接用（不并发刷新——授权服务器
 *   轮换 refresh token 时，并发刷新的第二个必然失败）。
 * - 令牌端点明确拒绝 → 删除该凭据并抛 OAuthReconnectRequired（需要重新连接）；暂时不可用 → OAuthUnavailable，凭据保留。
 */
export class OAuthTokens {
  constructor(
    private readonly store: OAuthStore,
    private readonly redis: Redis,
    private readonly http: () => OAuthHttpOptions,
    private readonly log: Logger,
  ) {}

  async accessToken(
    orgId: string,
    appId: string,
    auth: TokenAuth,
    owner: OAuthOwner,
  ): Promise<string> {
    const rec = await this.store.readTokens(orgId, appId, owner);
    if (rec) {
      const fresh = rec.expires_at === null || rec.expires_at - Date.now() > REFRESH_MARGIN_MS;
      // 没有 refresh token 的授权码凭据无法提前刷新：照用，过期由服务端 401 → forceRefresh 处理
      if (fresh || (auth.type === "oauth_code" && rec.refresh_token === undefined)) {
        return rec.access_token;
      }
    } else if (auth.type === "oauth_code") {
      throw new OAuthReconnectRequired(owner);
    }
    return this.renew(orgId, appId, auth, owner, rec?.access_token ?? null);
  }

  /** 收到 401 后调用：`stale` 为收到 401 的那个 access token。 */
  async forceRefresh(
    orgId: string,
    appId: string,
    auth: TokenAuth,
    owner: OAuthOwner,
    stale: string | undefined,
  ): Promise<void> {
    const current = stale ?? (await this.store.readTokens(orgId, appId, owner))?.access_token;
    if (current === undefined && auth.type === "oauth_code")
      throw new OAuthReconnectRequired(owner);
    await this.renew(orgId, appId, auth, owner, current ?? null);
  }

  private lockKey(orgId: string, appId: string, owner: OAuthOwner): string {
    return `capk:oauth-refresh:${orgId}:${appId}:${owner.kind === "org" ? "org" : owner.accountId}`;
  }

  /**
   * 换掉 `stale`（null = 库里还没有 token）：锁内先重读，已被别人换掉就直接用；否则向令牌端点要新的。
   * 锁的 TTL = 往返限时 + 5 秒，持有者崩溃后锁自然过期；等锁最多一个 TTL。
   */
  private async renew(
    orgId: string,
    appId: string,
    auth: TokenAuth,
    owner: OAuthOwner,
    stale: string | null,
  ): Promise<string> {
    const key = this.lockKey(orgId, appId, owner);
    const ttlMs = this.http().timeoutMs + 5_000;
    const deadline = Date.now() + ttlMs * 2;
    const replaced = (rec: OAuthTokenRecord | null) =>
      rec !== null && rec.access_token !== stale ? rec.access_token : undefined;
    for (;;) {
      const id = randomUUID();
      if ((await this.redis.set(key, id, "PX", ttlMs, "NX")) === "OK") {
        try {
          const rec = await this.store.readTokens(orgId, appId, owner);
          const done = replaced(rec);
          if (done !== undefined) return done;
          if (rec === null && auth.type === "oauth_code") throw new OAuthReconnectRequired(owner);
          return await this.obtain(orgId, appId, auth, owner, rec);
        } finally {
          await this.redis.eval(RELEASE, 1, key, id).catch((err: unknown) => {
            this.log.warn("oauth refresh lock release failed", { appId, err });
          });
        }
      }
      // 别的副本 / 请求正在刷新：等锁消失后重读
      while ((await this.redis.exists(key)) === 1 && Date.now() < deadline)
        await sleep(LOCK_POLL_MS);
      const rec = await this.store.readTokens(orgId, appId, owner);
      const done = replaced(rec);
      if (done !== undefined) return done;
      if (rec === null && auth.type === "oauth_code") throw new OAuthReconnectRequired(owner);
      if (Date.now() >= deadline) throw new OAuthUnavailable();
    }
  }

  /** 锁内：向令牌端点要新 token 并写回。 */
  private async obtain(
    orgId: string,
    appId: string,
    auth: TokenAuth,
    owner: OAuthOwner,
    rec: OAuthTokenRecord | null,
  ): Promise<string> {
    const client = await this.store.readClient(orgId, appId);
    if (!client) throw new OAuthReconnectRequired({ kind: "org" });
    const invalidate = async (reason: string): Promise<never> => {
      await this.store.deleteTokens(orgId, appId, owner);
      this.log.warn("oauth credential invalidated", { appId, owner: owner.kind, reason });
      throw new OAuthReconnectRequired(owner);
    };
    let next: OAuthTokenRecord;
    try {
      if (auth.type === "oauth_code") {
        if (rec?.refresh_token === undefined) return await invalidate("no_refresh_token");
        next = await tokenRequest(
          client,
          {
            grant_type: "refresh_token",
            refresh_token: rec.refresh_token,
            resource: client.resource,
          },
          this.http(),
        );
        // 授权服务器不轮换时沿用旧 refresh token
        if (next.refresh_token === undefined) next = { ...next, refresh_token: rec.refresh_token };
      } else {
        const scopes = auth.scopes ?? client.scopes;
        next = await tokenRequest(
          client,
          { grant_type: "client_credentials", scope: scopes?.join(" "), resource: client.resource },
          this.http(),
        );
      }
    } catch (e) {
      if (e instanceof OAuthGrantError) return invalidate(e.error);
      if (e instanceof OAuthUnavailable) throw e;
      // URL 校验失败等（配置问题）：按不可用处理，不删凭据
      this.log.warn("oauth token request failed", { appId, err: e });
      throw new OAuthUnavailable();
    }
    await this.store.writeTokens(orgId, appId, owner, next);
    return next.access_token;
  }
}
