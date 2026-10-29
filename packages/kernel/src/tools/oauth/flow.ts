import { createHash, randomBytes } from "node:crypto";
import type { Logger } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ApiError } from "../../errors.js";
import { audit } from "../../identity/audit.js";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { TransactionHost } from "../../infra/database/transaction-host.js";
import { Transactional } from "../../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER, REDIS } from "../../infra/tokens.js";
import { OrgLock } from "../../orgs/org-lock.js";
import { ConnectorsService } from "../connectors.service.js";
import { type ConnectorAuth, Credentials } from "../credentials.js";
import { oauthHttpOptions } from "./discovery.js";
import {
  callbackUrl,
  DEFAULT_RETURN_PATH,
  OAUTH_STATE_TTL_SECONDS,
  publicUrlRequired,
} from "./flow-paths.js";
import { tokenRequest } from "./tokens.js";

export {
  callbackUrl,
  DEFAULT_RETURN_PATH,
  isSafeReturnPath,
  OAUTH_BINDING_COOKIE,
  OAUTH_CALLBACK_PATH,
  OAUTH_STATE_TTL_SECONDS,
  publicUrlRequired,
} from "./flow-paths.js";

const stateKey = (state: string) => `capk:oauth-state:${state}`;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const BINDING_RE = /^[A-Za-z0-9_-]{43}$/;

const b64url = (n = 32) => randomBytes(n).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");

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

/**
 * 授权码 + PKCE（S256）连接流程。state 是 32 字节随机串，存 Redis `capk:oauth-state:<state>` 10 分钟、单次有效
 * （GETDEL），内含组织、连接器、发起人、PKCE verifier、redirect_uri、回跳页面与浏览器绑定值的哈希。
 */
@Injectable()
export class OAuthFlow {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    /** The org row lock (orgs/org-lock.ts; R12): joins the caller's transaction. */
    @Inject(OrgLock) private readonly orgLock: Pick<OrgLock, "lockAndAuthorize">,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "getdel">,
    @Inject(Credentials) private readonly credentials: Credentials,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Logger,
    /** A member's first connection without a tool snapshot refreshes the tools (A16). */
    @Inject(ConnectorsService) private readonly connectors: Pick<ConnectorsService, "refresh">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /** 某成员首次成功连接、而连接器还没有工具快照时（A16：用该成员的 token 刷新工具清单）。 */
  private async onFirstConnect(orgId: string, connectorId: string, accountId: string) {
    await this.connectors.refresh(orgId, connectorId, accountId, undefined, {
      trigger: "first_connect",
    });
  }

  private async app(orgId: string, connectorId: string) {
    return this.db
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
    const publicUrl = this.config.get().http.publicUrl;
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
    const client = await this.credentials.oauthClient(orgId, connectorId);
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
    await this.redis.set(stateKey(state), JSON.stringify(rec), "EX", OAUTH_STATE_TTL_SECONDS);
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
    const base = (this.config.get().http.publicUrl ?? "").replace(/\/+$/, "");
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
    const raw = await this.redis.getdel(stateKey(state));
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
    const client = app ? await this.credentials.oauthClient(orgId, connectorId) : null;
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
        oauthHttpOptions(this.config.get()),
      );
    } catch (e) {
      this.log.warn("oauth code exchange failed", { orgId, connectorId, err: e });
      return this.fail("token_exchange_failed", back);
    }

    let first: boolean;
    try {
      first = await this.storeTokens(orgId, connectorId, accountId, tokens);
    } catch (e) {
      if (e instanceof ApiError) return this.fail("connector_unavailable", back);
      throw e;
    }
    if (first) {
      // 首次连接（A16）：刷新失败不影响连接本身，凭据已存好；管理员之后可手动刷新
      // 最多等 FIRST_CONNECT_REFRESH_WAIT_MS 再回跳（本请求自己的计时器，结束即清除）；超时的刷新在后台继续
      const refresh = this.onFirstConnect(orgId, connectorId, accountId).catch((err: unknown) => {
        this.log.warn("oauth first-connect tool refresh failed", {
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

  /**
   * In the org row lock: re-checks that the member may still use connectors and the connector
   * exists, stores the member's tokens with the audit row; true when the connector has no tool
   * snapshot yet (the first connection).
   */
  @Transactional()
  private async storeTokens(
    orgId: string,
    connectorId: string,
    accountId: string,
    tokens: Awaited<ReturnType<typeof tokenRequest>>,
  ): Promise<boolean> {
    const t = this.db.db;
    await this.orgLock.lockAndAuthorize(orgId, accountId, "connectors.use");
    const still = await t
      .selectFrom("connectors")
      .select("id")
      .where("id", "=", connectorId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!still) throw new ApiError("connector.not_found", "Connector not found");
    await this.credentials.setOAuthTokens(orgId, connectorId, { kind: "user", accountId }, tokens);
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
  }
}
