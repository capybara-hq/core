import { randomUUID } from "node:crypto";
import type { Logger } from "@capybara-hq/plugin-sdk";
import { ToolError } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import type { LockService } from "../../infra/lock/lock.service.js";
import { type OAuthHttpOptions, OAuthSetupError, oauthFetch } from "./discovery.js";

export type TokenAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

/**
 * 一个连接器的 OAuth 客户端（组织级凭据，键 `credentials:app:<connectorId>:client`）：DCR 注册所得或管理员手填，
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
  /** 授权服务器标识（MCP 发现所得）：回调带 RFC 9207 `iss` 时与它核对。 */
  issuer?: string;
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

/**
 * The token endpoint refused with an RFC 6749-shaped error code (`invalid_grant`, ...): a 400 / 401
 * with `error`, or a 200 whose body carries `ok: false` (Slack) or an `error` and no token.
 */
export class OAuthGrantError extends Error {
  constructor(readonly error: string) {
    super(`The authorization server rejected the token request (${error})`);
    this.name = "OAuthGrantError";
  }
}

/**
 * These codes say the credential itself is dead (refresh token / client); only they invalidate the
 * tokens. Besides RFC 6749's, Slack's `invalid_refresh_token`, `token_revoked` and `token_expired`.
 */
export const INVALIDATING_ERRORS: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_refresh_token",
  "token_revoked",
  "token_expired",
]);

/**
 * Error codes of a 200 `ok: false` body that mean "try again later" (Slack's Web API codes), not a
 * refusal: they count as unavailable like a 429 / 5xx.
 */
const TRANSIENT_ERRORS: ReadonlySet<string> = new Set([
  "ratelimited",
  "service_unavailable",
  "internal_error",
  "fatal_error",
  "request_timeout",
]);

/**
 * `token_type` values (lower case) stored and sent as `Authorization: Bearer`: RFC 6750 `Bearer`
 * and Slack's `user` (`oauth.v2.user.access`). A template may allow more with `auth.tokenTypes`.
 */
export const BEARER_TOKEN_TYPES: ReadonlySet<string> = new Set(["bearer", "user"]);

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

/** RFC 6749 §5.2 形式的错误码（只有这种串才写进日志 / 错误，不回显对方任意文本）。 */
const OAUTH_ERROR_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** What the connector's auth settings add to a token request. */
export interface TokenRequestOptions {
  /** More `token_type` values to accept as bearer tokens (`auth.tokenTypes`, case-insensitive). */
  tokenTypes?: readonly string[] | undefined;
}

/**
 * Calls the token endpoint (RFC 6749 §3.2), sending client_id / secret per the client's auth method
 * (Basic form-encodes them first, §2.3.1).
 * - 400 / 401 with a parsable RFC 6749 `error` code -> OAuthGrantError.
 * - 200 with `ok: false` (Slack reports every error this way), or with an `error` code and no
 *   `access_token` -> OAuthGrantError with that code; a transient Slack code (`ratelimited`, ...)
 *   or no parsable code -> OAuthUnavailable.
 * - Everything else (network error, timeout, 429, 408, 403 and other 4xx, a 4xx without a code,
 *   5xx, 3xx, a malformed body) -> OAuthUnavailable: a gateway's rate limit or a WAF block is not a
 *   dead credential.
 * - A `token_type` other than Bearer / `user` / `opts.tokenTypes` -> OAuthGrantError
 *   `unsupported_token_type`; an accepted one is stored as `Bearer`.
 */
export async function tokenRequest(
  client: OAuthClientRecord,
  params: Record<string, string | undefined>,
  http: OAuthHttpOptions,
  opts: TokenRequestOptions = {},
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
  if (res.status === 400 || res.status === 401) {
    const code = isObj(body) ? body.error : undefined;
    if (typeof code === "string" && OAUTH_ERROR_RE.test(code)) throw new OAuthGrantError(code);
  }
  if (res.status !== 200 || !isObj(body)) throw new OAuthUnavailable();
  if (body.ok === false || (body.access_token === undefined && body.error !== undefined)) {
    const code = body.error;
    if (typeof code === "string" && OAUTH_ERROR_RE.test(code) && !TRANSIENT_ERRORS.has(code)) {
      throw new OAuthGrantError(code);
    }
    throw new OAuthUnavailable();
  }
  const { access_token, refresh_token, expires_in, token_type, scope } = body;
  if (typeof access_token !== "string" || access_token === "") throw new OAuthUnavailable();
  const type = (typeof token_type === "string" ? token_type : "Bearer").toLowerCase();
  const accepted =
    BEARER_TOKEN_TYPES.has(type) || opts.tokenTypes?.some((t) => t.toLowerCase() === type);
  if (!accepted) throw new OAuthGrantError("unsupported_token_type");
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
  readClient(orgId: string, connectorId: string): Promise<OAuthClientRecord | null>;
  readTokens(
    orgId: string,
    connectorId: string,
    owner: OAuthOwner,
  ): Promise<OAuthTokenRecord | null>;
  writeTokens(
    orgId: string,
    connectorId: string,
    owner: OAuthOwner,
    rec: OAuthTokenRecord,
  ): Promise<void>;
  deleteTokens(orgId: string, connectorId: string, owner: OAuthOwner): Promise<void>;
}

/** 取 token 所需的认证方式字段（与 credentials.ts 的 OAuthAuth 对应）。 */
export type TokenAuth = (
  | { type: "oauth_code" }
  | { type: "oauth_client"; scopes?: string[] | undefined }
) & { tokenTypes?: string[] | undefined };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * access token 的获取与刷新。
 *
 * - 调用前：未过期（距过期 > 60 秒或未告知过期时间）直接用；否则刷新（授权码流用 refresh token，客户端凭据流重新取）。
 * - 收到 401：`forceRefresh(stale)`——只要库里的 token 仍是收到 401 的那个就刷新。
 * - 刷新一律在 Redis 锁 `capk:oauth-refresh:<orgId>:<connectorId>:<owner>` 内进行（`LockService.lease`，值为
 *   本次随机 id，`releaseIf` 只删除自己持有的锁）；拿不到锁的轮询等锁消失后重读凭据，库里已是别的 token 就直接用（不并发刷新——授权服务器
 *   轮换 refresh token 时，并发刷新的第二个必然失败）。
 * - 令牌端点明确拒绝 → 删除该凭据并抛 OAuthReconnectRequired（需要重新连接）；暂时不可用 → OAuthUnavailable，凭据保留。
 */
export class OAuthTokens {
  constructor(
    private readonly store: OAuthStore,
    /** The lease primitives of `LockService` (the key is used as is: no `lock:` prefix). */
    private readonly locks: Pick<LockService, "lease" | "releaseIf" | "renew">,
    /** Polls whether another holder still has the lock. */
    private readonly redis: Pick<Redis, "exists">,
    private readonly http: () => OAuthHttpOptions,
    private readonly log: Logger,
  ) {}

  async accessToken(
    orgId: string,
    connectorId: string,
    auth: TokenAuth,
    owner: OAuthOwner,
  ): Promise<string> {
    const rec = await this.store.readTokens(orgId, connectorId, owner);
    if (rec) {
      const fresh = rec.expires_at === null || rec.expires_at - Date.now() > REFRESH_MARGIN_MS;
      // 没有 refresh token 的授权码凭据无法提前刷新：照用，过期由服务端 401 → forceRefresh 处理
      if (fresh || (auth.type === "oauth_code" && rec.refresh_token === undefined)) {
        return rec.access_token;
      }
    } else if (auth.type === "oauth_code") {
      throw new OAuthReconnectRequired(owner);
    }
    return this.renew(orgId, connectorId, auth, owner, rec?.access_token ?? null);
  }

  /** 收到 401 后调用：`stale` 为收到 401 的那个 access token。 */
  async forceRefresh(
    orgId: string,
    connectorId: string,
    auth: TokenAuth,
    owner: OAuthOwner,
    stale: string | undefined,
  ): Promise<void> {
    const current = stale ?? (await this.store.readTokens(orgId, connectorId, owner))?.access_token;
    if (current === undefined && auth.type === "oauth_code")
      throw new OAuthReconnectRequired(owner);
    await this.renew(orgId, connectorId, auth, owner, current ?? null);
  }

  private lockKey(orgId: string, connectorId: string, owner: OAuthOwner): string {
    return `capk:oauth-refresh:${orgId}:${connectorId}:${owner.kind === "org" ? "org" : owner.accountId}`;
  }

  /**
   * 换掉 `stale`（null = 库里还没有 token）：锁内先重读，已被别人换掉就直接用；否则向令牌端点要新的。
   * 锁的 TTL = 往返限时 + 5 秒，持有者崩溃后锁自然过期；等锁最多一个 TTL。
   */
  private async renew(
    orgId: string,
    connectorId: string,
    auth: TokenAuth,
    owner: OAuthOwner,
    stale: string | null,
  ): Promise<string> {
    const key = this.lockKey(orgId, connectorId, owner);
    const ttlMs = this.http().timeoutMs + 5_000;
    const deadline = Date.now() + ttlMs * 2;
    const replaced = (rec: OAuthTokenRecord | null) =>
      rec !== null && rec.access_token !== stale ? rec.access_token : undefined;
    for (;;) {
      const id = randomUUID();
      if (await this.locks.lease(key, id, ttlMs)) {
        try {
          const rec = await this.store.readTokens(orgId, connectorId, owner);
          const done = replaced(rec);
          if (done !== undefined) return done;
          if (rec === null && auth.type === "oauth_code") throw new OAuthReconnectRequired(owner);
          return await this.obtain(orgId, connectorId, auth, owner, rec, key, id, ttlMs);
        } finally {
          await this.locks.releaseIf(key, id).catch((err: unknown) => {
            this.log.warn("oauth refresh lock release failed", { connectorId, err });
          });
        }
      }
      // 别的副本 / 请求正在刷新：等锁消失后重读
      while ((await this.redis.exists(key)) === 1 && Date.now() < deadline)
        await sleep(LOCK_POLL_MS);
      const rec = await this.store.readTokens(orgId, connectorId, owner);
      const done = replaced(rec);
      if (done !== undefined) return done;
      if (rec === null && auth.type === "oauth_code") throw new OAuthReconnectRequired(owner);
      if (Date.now() >= deadline) throw new OAuthUnavailable();
    }
  }

  /**
   * 锁内：向令牌端点要新 token 并写回。作废前做围栏检查：锁仍归自己、库里的 token 仍是这次用掉的那组——
   * 锁过期后另一个刷新者若已写入新 token，就直接用它而不是删掉它。
   */
  private async obtain(
    orgId: string,
    connectorId: string,
    auth: TokenAuth,
    owner: OAuthOwner,
    rec: OAuthTokenRecord | null,
    lockKey: string,
    lockId: string,
    lockTtlMs: number,
  ): Promise<string> {
    const client = await this.store.readClient(orgId, connectorId);
    if (!client) throw new OAuthReconnectRequired({ kind: "org" });
    const invalidate = async (reason: string): Promise<string> => {
      const current = await this.store.readTokens(orgId, connectorId, owner);
      const unchanged =
        current !== null &&
        rec !== null &&
        current.access_token === rec.access_token &&
        current.refresh_token === rec.refresh_token;
      if (current !== null && !unchanged) return current.access_token;
      // still ours (renewing a held lease is harmless right before the delete)
      if (current !== null && !(await this.locks.renew(lockKey, lockId, lockTtlMs))) {
        // 锁已不归自己（过期）：不删，交给持锁者；这次按暂时不可用处理
        throw new OAuthUnavailable();
      }
      if (current !== null) await this.store.deleteTokens(orgId, connectorId, owner);
      this.log.warn("oauth credential invalidated", { connectorId, owner: owner.kind, reason });
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
          { tokenTypes: auth.tokenTypes },
        );
        // 授权服务器不轮换时沿用旧 refresh token
        if (next.refresh_token === undefined) next = { ...next, refresh_token: rec.refresh_token };
      } else {
        const scopes = auth.scopes ?? client.scopes;
        next = await tokenRequest(
          client,
          { grant_type: "client_credentials", scope: scopes?.join(" "), resource: client.resource },
          this.http(),
          { tokenTypes: auth.tokenTypes },
        );
      }
    } catch (e) {
      if (e instanceof OAuthGrantError) {
        if (INVALIDATING_ERRORS.has(e.error)) return invalidate(e.error);
        // invalid_scope / invalid_request 等：配置问题，凭据保留
        this.log.warn("oauth token request rejected", { connectorId, error: e.error });
        throw new OAuthUnavailable(
          `Could not obtain an access token: the authorization server rejected the request (${e.error}). Ask an administrator to check the app.`,
        );
      }
      if (e instanceof OAuthUnavailable) throw e;
      // URL 校验失败等（配置问题）：按不可用处理，不删凭据
      this.log.warn("oauth token request failed", { connectorId, err: e });
      throw new OAuthUnavailable();
    }
    await this.store.writeTokens(orgId, connectorId, owner, next);
    return next.access_token;
  }
}
