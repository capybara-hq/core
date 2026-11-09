// The kernel's own setup checks, `capybara:*` (spec 2026-11-09-setup-guides-v2-design.md §10.6):
// answered from the kernel's state with no plugin code, usable by any guide of their place. They go
// through the same `SetupChecksService` pipeline as plugin checks (authorization, the rendered
// guide, cache, single flight, the org's concurrency cap, the time limit, validate / redact /
// validate), and are cached per account like every kernel check.
import {
  type SetupCheckResult,
  type SetupCheckText,
  validateSetupCheckResult,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { webhookSeenKey } from "../channels/webhook.js";
import { webhookBase } from "../channels/webhook-url.js";
import type { KernelConfig } from "../config/schema.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { REDIS } from "../infra/tokens.js";
import type { ConnectorAuth } from "../tools/credentials.js";
import { Credentials } from "../tools/credentials.js";
import { callbackUrl } from "../tools/oauth/flow-paths.js";
import { probeNetPolicy, probeTokenEndpoint } from "./oauth-token-probe.js";
import { checkRedactor } from "./redact-check.js";
import type { KernelCheckArgs } from "./setup-check-registry.js";
import { SetupCheckRegistry } from "./setup-check-registry.js";

const text = (en: string, zh: string): SetupCheckText => ({ en, zh });

/** The fixed texts of the kernel checks (only `last_error` and a time are ever interpolated). */
export const KERNEL_CHECK_TEXTS = {
  publicUrlSet: text(
    "The public URL (http.publicUrl) is set.",
    "公开地址（http.publicUrl）已设置。",
  ),
  publicUrlMissing: text(
    "The public URL (http.publicUrl) is not set.",
    "公开地址（http.publicUrl）没有设置。",
  ),
  publicUrlFix: text(
    "Ask your super admin to set http.publicUrl.",
    "请超级管理员设置 http.publicUrl。",
  ),
  webhookPublic: text(
    "Webhook callbacks have a public https address (channels.webhookBaseUrl).",
    "Webhook 回调有公开的 https 地址（channels.webhookBaseUrl）。",
  ),
  webhookBaseMissing: text(
    "No public https address is set for webhook callbacks (channels.webhookBaseUrl).",
    "没有为 Webhook 回调设置公开的 https 地址（channels.webhookBaseUrl）。",
  ),
  webhookBaseFix: text(
    "Ask your super admin to set channels.webhookBaseUrl to an https address that reaches the gateway.",
    "请超级管理员把 channels.webhookBaseUrl 设置为能到达网关的 https 地址。",
  ),
  webhookNone: text(
    "No verified webhook request has arrived in the last 7 days.",
    "最近 7 天没有收到通过校验的 Webhook 请求。",
  ),
  connectionGone: text("The connection was not found.", "找不到这个连接。"),
  connectionDisabled: text("The connection is disabled.", "这个连接已停用。"),
  connectionEnableFix: text("Enable the connection.", "启用这个连接。"),
  connectionFailed: text("The connection reported an error.", "这个连接报告了错误。"),
  connectionFix: text(
    "Check the credentials on this page and save them again.",
    "检查本页的凭据并重新保存。",
  ),
  connectionPending: text(
    "The connection has not reported its bot identity yet; retry in a moment.",
    "这个连接还没有报告机器人身份，请稍后重试。",
  ),
  connectionActive: text("The connection is active.", "这个连接正常运行。"),
  connectorGone: text("The connector was not found.", "找不到这个连接器。"),
  notOAuthCode: text(
    "This connector does not use an OAuth client.",
    "这个连接器不使用 OAuth 客户端。",
  ),
  dcr: text("Registered automatically; nothing to check.", "客户端是自动注册的，无需检查。"),
  clientStored: text(
    "The OAuth client id and secret are stored.",
    "OAuth 客户端 ID 和密钥已保存。",
  ),
  clientMissing: text(
    "The OAuth client id or secret is not stored.",
    "OAuth 客户端 ID 或密钥没有保存。",
  ),
  clientFix: text(
    "Enter the Client ID and Client Secret on the connector's page.",
    "在连接器页面填写 Client ID 和 Client Secret。",
  ),
  noClient: text("No OAuth client is stored yet.", "还没有保存 OAuth 客户端。"),
  toolsRead: text("The connector's tool list has been read.", "已读取这个连接器的工具清单。"),
  toolsPending: text(
    "The tool list is read when the first member connects.",
    "第一位成员连接后会读取工具清单。",
  ),
  connected: text("You are connected.", "你已连接。"),
  notConnected: text("You have not connected your account yet.", "你还没有连接自己的账号。"),
  connectFix: text("Select Connect and sign in.", "选择「连接」并登录。"),
  publicUrlFirst: text(
    "The callback URL needs http.publicUrl; ask your super admin to set it.",
    "回调地址需要 http.publicUrl，请超级管理员设置。",
  ),
} as const;

/** `capybara:public-url`: `http.publicUrl` is set. */
export function publicUrlCheck(config: Pick<KernelConfig, "http">): SetupCheckResult {
  return config.http.publicUrl
    ? { status: "ok", reason: KERNEL_CHECK_TEXTS.publicUrlSet }
    : {
        status: "failing",
        reason: KERNEL_CHECK_TEXTS.publicUrlMissing,
        fix: KERNEL_CHECK_TEXTS.publicUrlFix,
      };
}

/**
 * `capybara:webhook-public`: webhook callback URLs have a usable https base. The kernel builds
 * them from `channels.webhookBaseUrl` only (`webhook-url.ts`), never from `http.publicUrl`, so
 * that is what is checked; a loopback http base (tests only) is not public.
 */
export function webhookPublicCheck(config: Parameters<typeof webhookBase>[0]): SetupCheckResult {
  const base = webhookBase(config);
  return base?.startsWith("https://")
    ? { status: "ok", reason: KERNEL_CHECK_TEXTS.webhookPublic }
    : {
        status: "failing",
        reason: KERNEL_CHECK_TEXTS.webhookBaseMissing,
        fix: KERNEL_CHECK_TEXTS.webhookBaseFix,
      };
}

/** `capybara:webhook-received`: the marker the gateway sets on an accepted webhook, or none. */
export function webhookReceivedResult(seenAt: string | null): SetupCheckResult {
  const at = seenAt === null ? Number.NaN : Date.parse(seenAt);
  if (Number.isNaN(at)) return { status: "unknown", reason: KERNEL_CHECK_TEXTS.webhookNone };
  const iso = new Date(at).toISOString();
  return {
    status: "ok",
    reason: text(
      `A verified webhook request arrived at ${iso}.`,
      `${iso} 收到过通过校验的 Webhook 请求。`,
    ),
  };
}

/** The most of `last_error` a reason carries (after redaction). */
const LAST_ERROR_CHARS = 200;

/**
 * `last_error` fit for a reason: redacted by the connection's secrets over the whole text first
 * (a cut never leaves part of a secret behind), then cut to {@link LAST_ERROR_CHARS} code points.
 */
function lastErrorText(lastError: string, secrets: readonly string[]): string {
  const redacted = checkRedactor(secrets)(lastError);
  const points = [...redacted];
  return points.length > LAST_ERROR_CHARS
    ? `${points.slice(0, LAST_ERROR_CHARS).join("")}…`
    : redacted;
}

/**
 * `capybara:connection-active`: active with a bot identity and no recorded error is ok. A recorded
 * `last_error` (status `error`, or a failure an active connection keeps retrying) is failing with
 * that text, redacted by the connection's secrets and kept only when the result with it passes
 * the result validation (control, bidi and lone surrogate rules, length); otherwise the reason
 * leaves it out. The kernel pipeline validates and redacts the result again.
 */
export function connectionActiveResult(
  row: { status: string; botUserId: string | null; lastError: string | null } | undefined,
  secrets: readonly string[],
): SetupCheckResult {
  if (!row) return { status: "unknown", reason: KERNEL_CHECK_TEXTS.connectionGone };
  if (row.status === "disabled") {
    return {
      status: "failing",
      reason: KERNEL_CHECK_TEXTS.connectionDisabled,
      fix: KERNEL_CHECK_TEXTS.connectionEnableFix,
    };
  }
  if (row.status === "error" || (row.lastError !== null && row.lastError !== "")) {
    const generic: SetupCheckResult = {
      status: "failing",
      reason: KERNEL_CHECK_TEXTS.connectionFailed,
      fix: KERNEL_CHECK_TEXTS.connectionFix,
    };
    if (row.lastError === null || row.lastError === "") return generic;
    const detail = lastErrorText(row.lastError, secrets);
    const withError = validateSetupCheckResult({
      ...generic,
      reason: text(`The connection reported an error: ${detail}`, `这个连接报告了错误：${detail}`),
    });
    return "problem" in withError ? generic : withError;
  }
  if (row.botUserId === null || row.botUserId === "") {
    return { status: "unknown", reason: KERNEL_CHECK_TEXTS.connectionPending };
  }
  return { status: "ok", reason: KERNEL_CHECK_TEXTS.connectionActive };
}

/**
 * Registers the kernel checks on module init (static code, the same on every replica). Each reads
 * only the target the service resolved (ids of the caller's org, after authorization) and never
 * writes; `capybara:oauth-token-endpoint` is the only one that leaves the kernel (§10.6).
 */
@Injectable()
export class KernelChecks implements OnModuleInit {
  constructor(
    @Inject(SetupCheckRegistry) private readonly registry: SetupCheckRegistry,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(REDIS) private readonly redis: Pick<Redis, "get">,
    @Inject(Credentials)
    private readonly credentials: Pick<Credentials, "oauthClient" | "status">,
  ) {}

  onModuleInit(): void {
    const r = this.registry;
    r.registerKernel("capybara:public-url", "any", async () => publicUrlCheck(this.config.get()));
    r.registerKernel("capybara:webhook-public", "channel-connection", async () =>
      webhookPublicCheck(this.config.get()),
    );
    r.registerKernel("capybara:webhook-received", "channel-connection", (a) =>
      this.webhookReceived(a),
    );
    r.registerKernel("capybara:connection-active", "channel-connection", (a) =>
      this.connectionActive(a),
    );
    r.registerKernel("capybara:oauth-client", "connector-template", (a) => this.oauthClient(a));
    r.registerKernel("capybara:connector-tools", "connector-template", (a) =>
      this.connectorTools(a),
    );
    r.registerKernel("capybara:connector-connected", "connector-template", (a) =>
      this.connectorConnected(a),
    );
    r.registerKernel("capybara:oauth-token-endpoint", "connector-template", (a) =>
      this.tokenEndpoint(a),
    );
  }

  private async webhookReceived(a: KernelCheckArgs): Promise<SetupCheckResult> {
    if (a.target.kind !== "channel-connection") return notApplicable();
    return webhookReceivedResult(await this.redis.get(webhookSeenKey(a.target.connectionId)));
  }

  private async connectionActive(a: KernelCheckArgs): Promise<SetupCheckResult> {
    if (a.target.kind !== "channel-connection") return notApplicable();
    const row = await this.db
      .selectFrom("channel_connections")
      .select(["status", "bot_user_id", "last_error"])
      .where("id", "=", a.target.connectionId)
      .where("org_id", "=", a.orgId)
      .where("plugin", "=", a.target.plugin)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return connectionActiveResult(
      row && { status: row.status, botUserId: row.bot_user_id, lastError: row.last_error },
      a.secrets,
    );
  }

  /** The connector's auth settings (a live connector of the caller's org), or undefined. */
  private async connectorAuth(a: KernelCheckArgs): Promise<ConnectorAuth | undefined> {
    if (a.target.kind !== "connector") return undefined;
    const row = await this.db
      .selectFrom("connectors")
      .select("auth")
      .where("id", "=", a.target.connectorId)
      .where("org_id", "=", a.orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return row ? (row.auth as unknown as ConnectorAuth) : undefined;
  }

  private async oauthClient(a: KernelCheckArgs): Promise<SetupCheckResult> {
    const auth = await this.connectorAuth(a);
    if (!auth || a.target.kind !== "connector") return connectorGone();
    if (auth.type !== "oauth_code")
      return { status: "unknown", reason: KERNEL_CHECK_TEXTS.notOAuthCode };
    if (auth.client === "dcr") return { status: "unknown", reason: KERNEL_CHECK_TEXTS.dcr };
    const client = await this.credentials.oauthClient(a.orgId, a.target.connectorId);
    return client && client.clientId !== "" && client.clientSecret
      ? { status: "ok", reason: KERNEL_CHECK_TEXTS.clientStored }
      : {
          status: "failing",
          reason: KERNEL_CHECK_TEXTS.clientMissing,
          fix: KERNEL_CHECK_TEXTS.clientFix,
        };
  }

  private async connectorTools(a: KernelCheckArgs): Promise<SetupCheckResult> {
    if (a.target.kind !== "connector" || !(await this.connectorAuth(a))) return connectorGone();
    const tool = await this.db
      .selectFrom("connector_tools")
      .select("name")
      .where("connector_id", "=", a.target.connectorId)
      .limit(1)
      .executeTakeFirst();
    return tool
      ? { status: "ok", reason: KERNEL_CHECK_TEXTS.toolsRead }
      : { status: "unknown", reason: KERNEL_CHECK_TEXTS.toolsPending };
  }

  /** The caller's own credential (cached per account, as every kernel check). */
  private async connectorConnected(a: KernelCheckArgs): Promise<SetupCheckResult> {
    const auth = await this.connectorAuth(a);
    if (!auth || a.target.kind !== "connector") return connectorGone();
    const s = await this.credentials.status(a.orgId, a.target.connectorId, auth, a.accountId);
    return s === "connected"
      ? { status: "ok", reason: KERNEL_CHECK_TEXTS.connected }
      : {
          status: "failing",
          reason: KERNEL_CHECK_TEXTS.notConnected,
          fix: KERNEL_CHECK_TEXTS.connectFix,
        };
  }

  /**
   * The token endpoint probe for a manual OAuth client (`oauth-token-probe.ts`): the stored
   * client record is the connect flow's (its `tokenEndpoint` came from discovery or the
   * template's `tokenUrl` at install, its auth method from `tokenAuthMethod`), the redirect URI
   * is the connect flow's callback URL. Runs per admin (kernel checks are cached per account);
   * each run is one token request, inside the per-account rate limit and the org's cap.
   */
  private async tokenEndpoint(a: KernelCheckArgs): Promise<SetupCheckResult> {
    const auth = await this.connectorAuth(a);
    if (!auth || a.target.kind !== "connector") return connectorGone();
    if (auth.type !== "oauth_code")
      return { status: "unknown", reason: KERNEL_CHECK_TEXTS.notOAuthCode };
    if (auth.client === "dcr") return { status: "unknown", reason: KERNEL_CHECK_TEXTS.dcr };
    const config = this.config.get();
    const publicUrl = config.http.publicUrl;
    if (!publicUrl) return { status: "unknown", reason: KERNEL_CHECK_TEXTS.publicUrlFirst };
    const client = await this.credentials.oauthClient(a.orgId, a.target.connectorId);
    if (!client) return { status: "unknown", reason: KERNEL_CHECK_TEXTS.noClient };
    return probeTokenEndpoint({
      client,
      redirectUri: callbackUrl(publicUrl),
      net: probeNetPolicy(config),
      signal: a.signal,
    });
  }
}

const notApplicable = (): SetupCheckResult => ({
  status: "unknown",
  reason: text("This check does not apply on this page.", "这项检查不适用于本页面。"),
});

const connectorGone = (): SetupCheckResult => ({
  status: "unknown",
  reason: KERNEL_CHECK_TEXTS.connectorGone,
});
