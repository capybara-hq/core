import { createHash, randomBytes } from "node:crypto";
import type { Logger } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import type { KernelConfig } from "../../config/schema.js";
import type { KernelSchemaDb } from "../../db/kernel-schema.js";
import { ApiError } from "../../errors.js";
import { audit } from "../../identity/audit.js";
import { lockOrgAndAuthorize } from "../../orgs/org-lock.js";
import type { ConnectorAuth, Credentials } from "../credentials.js";
import { oauthHttpOptions } from "./discovery.js";
import { tokenRequest } from "./tokens.js";

/** 授权回调的路径（`http.publicUrl` + 它 = 注册给授权服务器的 redirect_uri）。 */
export const OAUTH_CALLBACK_PATH = "/api/v1/oauth/callback";
/** state 的有效期（秒）。 */
export const OAUTH_STATE_TTL_SECONDS = 600;
/** 浏览器绑定 Cookie：回调必须来自发起连接的同一个浏览器。 */
export const OAUTH_BINDING_COOKIE = "cap_oauth";
/** 回调失败、或连接时没给回跳页面时回到的网页（next-intl 会补语言前缀）。 */
export const DEFAULT_RETURN_PATH = "/settings/connections";

const stateKey = (state: string) => `capk:oauth-state:${state}`;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const BINDING_RE = /^[A-Za-z0-9_-]{43}$/;

const b64url = (n = 32) => randomBytes(n).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");

/** OAuth 连接器需要 `http.publicUrl`（回调地址）；未配置 → 这条校验错误。 */
export const publicUrlRequired = () =>
  new ApiError("validation_failed", "Request validation failed", [
    {
      path: "auth",
      message:
        "OAuth connectors require http.publicUrl to be configured (it is used to build the OAuth callback URL)",
    },
  ]);

export function callbackUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}${OAUTH_CALLBACK_PATH}`;
}

/**
 * 回跳页面只接受站内相对路径（防开放重定向）：以单个 `/` 开头，不含 `\` 与控制字符，解析后仍在同一个源。
 */
export function isSafeReturnPath(p: string): boolean {
  if (p.length > 500 || !p.startsWith("/") || p.startsWith("//")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拒绝控制字符
  if (/[\\\u0000-\u001f\u007f]/.test(p)) return false;
  const base = "https://return.invalid";
  try {
    return new URL(p, base).origin === base;
  } catch {
    return false;
  }
}

/** 一个有效的浏览器绑定值（复用请求里已有的，否则新生成）。 */
export function browserBinding(existing: string | undefined): string {
  return existing !== undefined && BINDING_RE.test(existing) ? existing : b64url();
}

interface StateRecord {
  orgId: string;
  connectorId: string;
  accountId: string;
  verifier: string;
  redirectUri: string;
  returnTo: string;
  /** 浏览器绑定值的 SHA-256。 */
  binding: string;
  /** 授权服务器标识（MCP 发现所得），回调带 RFC 9207 `iss` 时核对。 */
  issuer?: string;
}

/** 回调失败的原因码（放进回跳 URL 的 `oauth_error`；不回显授权服务器的任何文本）。 */
export type OAuthCallbackError =
  | "state_invalid"
  | "session_mismatch"
  | "access_denied"
  | "provider_error"
  | "token_exchange_failed"
  | "issuer_mismatch"
  | "connector_unavailable";

/** 首次连接后刷新工具清单最多等这么久再 302（超时则在后台继续，结果照常写入）。 */
export const FIRST_CONNECT_REFRESH_WAIT_MS = 15_000;

export interface OAuthFlowDeps {
  db: KernelSchemaDb;
  redis: Redis;
  credentials: Credentials;
  config: () => KernelConfig;
  log: Logger;
  /** 某成员首次成功连接、而连接器还没有工具快照时调用（A16：用该成员的 token 刷新工具清单）。 */
  onFirstConnect: (orgId: string, connectorId: string, accountId: string) => Promise<void>;
}

/**
 * 授权码 + PKCE（S256）连接流程。state 是 32 字节随机串，存 Redis `capk:oauth-state:<state>` 10 分钟、单次有效
 * （GETDEL），内含组织、连接器、发起人、PKCE verifier、redirect_uri、回跳页面与浏览器绑定值的哈希。
 */
export class OAuthFlow {
  constructor(private readonly deps: OAuthFlowDeps) {}

  private async app(orgId: string, connectorId: string) {
    return this.deps.db
      .selectFrom("connectors")
      .select(["id", "auth", "status"])
      .where("id", "=", connectorId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
  }

  /** 生成授权 URL。`binding` 为本浏览器的绑定值（由 controller 写入 Cookie）。 */
  async start(
    orgId: string,
    connectorId: string,
    accountId: string,
    returnTo: string | undefined,
    binding: string,
  ): Promise<{ authorizationUrl: string }> {
    const publicUrl = this.deps.config().http.publicUrl;
    if (!publicUrl) throw publicUrlRequired();
    const app = await this.app(orgId, connectorId);
    if (!app) throw new ApiError("connector.not_found", "Connector not found");
    if ((app.auth as unknown as ConnectorAuth).type !== "oauth_code") {
      throw new ApiError("validation_failed", "Request validation failed", [
        {
          path: "auth",
          message: "Only OAuth authorization-code connectors are connected this way",
        },
      ]);
    }
    if (app.status !== "active") {
      throw new ApiError("validation_failed", "Request validation failed", [
        { path: "status", message: "The connector is disabled; ask an administrator to enable it" },
      ]);
    }
    const client = await this.deps.credentials.oauthClient(orgId, connectorId);
    if (!client?.authorizationEndpoint) {
      throw new ApiError(
        "connector.connect_failed",
        "The connector has no registered OAuth client; ask an administrator to reinstall it",
      );
    }
    const state = b64url();
    const verifier = b64url();
    const redirectUri = callbackUrl(publicUrl);
    const rec: StateRecord = {
      orgId,
      connectorId,
      accountId,
      verifier,
      redirectUri,
      returnTo: returnTo ?? DEFAULT_RETURN_PATH,
      binding: sha256(binding),
      ...(client.issuer !== undefined && { issuer: client.issuer }),
    };
    await this.deps.redis.set(stateKey(state), JSON.stringify(rec), "EX", OAUTH_STATE_TTL_SECONDS);
    const url = new URL(client.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", sha256(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    if (client.scopes && client.scopes.length > 0)
      url.searchParams.set("scope", client.scopes.join(" "));
    if (client.resource) url.searchParams.set("resource", client.resource);
    return { authorizationUrl: url.toString() };
  }

  /** 回跳地址：`http.publicUrl` + 站内路径 + 结果参数（未配置 publicUrl 时为相对地址）。 */
  private redirect(path: string, param: [string, string]): string {
    const base = (this.deps.config().http.publicUrl ?? "").replace(/\/+$/, "");
    const u = new URL(path, "https://return.invalid");
    u.searchParams.set(param[0], param[1]);
    return `${base}${u.pathname}${u.search}${u.hash}`;
  }

  private fail(code: OAuthCallbackError, path = DEFAULT_RETURN_PATH): string {
    return this.redirect(path, ["oauth_error", code]);
  }

  /**
   * 处理授权服务器的回跳，返回 302 的目标。state 先取后删（无论后续成败都不能再用）；浏览器绑定不符 →
   * `session_mismatch`（把回跳链接转给别人不能把对方的授权连到发起人账号上）；授权服务器报错只映射为原因码。
   * 成功则在组织行锁内复核发起人仍是成员（`connectors.use`），写个人凭据与审计；连接器还没有工具快照时用这个 token 刷新。
   */
  async callback(
    query: {
      code?: string | undefined;
      state?: string | undefined;
      error?: string | undefined;
      iss?: string | undefined;
    },
    binding: string | undefined,
  ): Promise<string> {
    const state = query.state;
    if (state === undefined || !STATE_RE.test(state)) return this.fail("state_invalid");
    const raw = await this.deps.redis.getdel(stateKey(state));
    if (raw === null) return this.fail("state_invalid");
    const rec = JSON.parse(raw) as StateRecord;
    const back = rec.returnTo;
    if (binding === undefined || sha256(binding) !== rec.binding) {
      return this.fail("session_mismatch", back);
    }
    // RFC 9207：回跳带 iss 时必须是发起时的授权服务器（防混淆攻击）
    if (query.iss !== undefined && rec.issuer !== undefined && query.iss !== rec.issuer) {
      return this.fail("issuer_mismatch", back);
    }
    if (query.error !== undefined) {
      return this.fail(query.error === "access_denied" ? "access_denied" : "provider_error", back);
    }
    if (!query.code) return this.fail("provider_error", back);

    const { orgId, connectorId, accountId } = rec;
    const app = await this.app(orgId, connectorId);
    const client = app ? await this.deps.credentials.oauthClient(orgId, connectorId) : null;
    if (!app || !client || (app.auth as unknown as ConnectorAuth).type !== "oauth_code") {
      return this.fail("connector_unavailable", back);
    }
    let tokens: Awaited<ReturnType<typeof tokenRequest>>;
    try {
      tokens = await tokenRequest(
        client,
        {
          grant_type: "authorization_code",
          code: query.code,
          redirect_uri: rec.redirectUri,
          code_verifier: rec.verifier,
          resource: client.resource,
        },
        oauthHttpOptions(this.deps.config()),
      );
    } catch (e) {
      this.deps.log.warn("oauth code exchange failed", { orgId, connectorId, err: e });
      return this.fail("token_exchange_failed", back);
    }

    let first: boolean;
    try {
      first = await this.deps.db.transaction().execute(async (t) => {
        await lockOrgAndAuthorize(t, orgId, accountId, "connectors.use");
        const still = await t
          .selectFrom("connectors")
          .select("id")
          .where("id", "=", connectorId)
          .where("deleted_at", "is", null)
          .forUpdate()
          .executeTakeFirst();
        if (!still) throw new ApiError("connector.not_found", "Connector not found");
        await this.deps.credentials.setOAuthTokens(
          orgId,
          connectorId,
          { kind: "user", accountId },
          tokens,
          t,
        );
        await audit(t, {
          actorAccountId: accountId,
          orgId,
          action: "connector.credential.set",
          target: connectorId,
          detail: { type: "oauth_code", ownership: "personal" },
        });
        const tool = await t
          .selectFrom("connector_tools")
          .select("name")
          .where("connector_id", "=", connectorId)
          .limit(1)
          .executeTakeFirst();
        return tool === undefined;
      });
    } catch (e) {
      if (e instanceof ApiError) return this.fail("connector_unavailable", back);
      throw e;
    }
    if (first) {
      // 首次连接（A16）：刷新失败不影响连接本身，凭据已存好；管理员之后可手动刷新
      // 最多等 FIRST_CONNECT_REFRESH_WAIT_MS 再回跳（本请求自己的计时器，结束即清除）；超时的刷新在后台继续
      const refresh = this.deps
        .onFirstConnect(orgId, connectorId, accountId)
        .catch((err: unknown) => {
          this.deps.log.warn("oauth first-connect tool refresh failed", {
            orgId,
            connectorId,
            err,
          });
        });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        refresh,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, FIRST_CONNECT_REFRESH_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    return this.redirect(back, ["connected", connectorId]);
  }
}
