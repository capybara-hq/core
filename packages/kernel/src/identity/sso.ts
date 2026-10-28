import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  IDENTITY_SOURCE_EXTENSION_POINT,
  type IdentitySource,
  type Logger,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ApiError } from "../errors.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import { LegacyPorts } from "../lifecycle/legacy-ports.js";
import { isSafeReturnPath } from "../tools/oauth/flow.js";
import { ExternalIdentities, IdentityNotVerified } from "./external.js";

/** state 的有效期（秒）。 */
export const SSO_STATE_TTL_SECONDS = 600;
/** 浏览器绑定 Cookie：回调必须来自发起登录的同一个浏览器（防登录 CSRF / 把回跳链接转给别人）。 */
export const SSO_BINDING_COOKIE = "cap_sso";
/** 绑定 Cookie 的 Path：覆盖所有插件的回调。 */
export const SSO_COOKIE_PATH = "/api/v1/auth/sso";
/** 登录失败回到的网页（next-intl 会补语言前缀）。 */
export const LOGIN_PATH = "/login";
/** 插件 `callback` 的最长等待。 */
export const SSO_CALLBACK_TIMEOUT_MS = 15_000;

/**
 * 登录失败的原因码（放进回跳 URL `/login?error=<code>`，界面按码走 i18n；不回显身份源的任何文本）。
 * `auth.account_disabled` 与 API 错误码同名。
 */
export type SsoLoginError =
  | "sso.unavailable"
  | "sso.state_invalid"
  | "sso.session_mismatch"
  | "sso.access_denied"
  | "sso.provider_error"
  | "sso.identity_not_verified"
  | "auth.account_disabled";

const stateKey = (state: string) => `capk:sso-state:${state}`;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const BINDING_RE = /^[A-Za-z0-9_-]{43}$/;
const b64url = (n = 32) => randomBytes(n).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");
/** 常量时间比较两个 base64url 哈希（长度不同直接不等）。 */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

interface StateRecord {
  plugin: string;
  nonce: string;
  redirectUri: string;
  returnTo: string;
  /** 浏览器绑定值的 SHA-256。 */
  binding: string;
  /** PKCE verifier（43 字符 base64url）；授权地址上的 challenge 为其 SHA-256。 */
  codeVerifier: string;
  /**
   * 发起时已登录的 Web 会话账号（未登录时没有）：回调时会话账号与它相同，才把经 IM 绑定建立的身份升级为 sso
   * ——升级的意图在发起时就确定，不能由回调时碰巧带着的会话决定。
   */
  sessionAccountId?: string;
}

/** 一个有效的浏览器绑定值（复用请求里已有的，否则新生成）。 */
export function ssoBrowserBinding(existing: string | undefined): string {
  return existing !== undefined && BINDING_RE.test(existing) ? existing : b64url();
}

/** 回跳页面：站内相对路径（以单个 `/` 开头，非 `//`），否则 `/`（防开放重定向）。 */
export function safeReturnTo(p: string | undefined): string {
  return p !== undefined && isSafeReturnPath(p) ? p : "/";
}

/** 回调结果：成功给账号与回跳页面，失败给原因码。 */
export type SsoCallbackResult =
  | { ok: true; accountId: string; returnTo: string }
  | { ok: false; error: SsoLoginError };

/**
 * 第三方登录（`identity-source@1`）：发起时生成 state（32 字节随机串，Redis `capk:sso-state:<state>` 10 分钟、
 * 单次有效，内含插件名、nonce、PKCE verifier、redirect_uri、回跳页面与浏览器绑定值的哈希），授权地址带 PKCE
 * challenge（S256）；回调时先取后删 state、核对绑定 Cookie，再交给插件（连同 verifier）换取外部身份并解析到账号。
 * 会话由 controller 在成功后创建。状态全部在 Redis，没有进程内状态。
 *
 * 已登录的用户也可以发起（「登录状态下绑定」）：回调请求带着同一账号的 Web 会话时，经 IM 绑定链接建立的身份
 * 由此证明本人控制该外部身份，升级为可登录（Ruling A18，见 `ExternalIdentities.resolve`）。
 */
@Injectable()
export class SsoFlow {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(ExtensionRegistry) private readonly registry: Pick<ExtensionRegistry, "list">,
    // the extension host's deployment config (Task 3.3 converts the host)
    @Inject(LegacyPorts) private readonly ports: LegacyPorts,
    @Inject(ExternalIdentities) private readonly external: ExternalIdentities,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "warn">,
  ) {}

  /** 已启用的登录方式：`auth.loginSources` 中（按其顺序）且已加载、提供 `identity-source@1` 的插件。 */
  sources(): { plugin: string; label: { zh: string; en: string } }[] {
    return this.config.get().auth.loginSources.flatMap((plugin) => {
      const src = this.provider(plugin);
      return src ? [{ plugin, label: { zh: src.label.zh, en: src.label.en } }] : [];
    });
  }

  private provider(plugin: string): IdentitySource | undefined {
    if (!this.config.get().auth.loginSources.includes(plugin)) return undefined;
    const entry = this.registry
      .list("identity-source")
      .find((e) => e.plugin === plugin && e.capability === IDENTITY_SOURCE_EXTENSION_POINT);
    return entry?.impl as IdentitySource | undefined;
  }

  private redirectUri(plugin: string): string {
    const base = (this.config.get().http.publicUrl ?? "").replace(/\/+$/, "");
    return `${base}/api/v1/auth/sso/${encodeURIComponent(plugin)}/callback`;
  }

  /** 绑定 Cookie 是否加 Secure：`auth.cookieSecure`，或 `http.publicUrl` 是 https（浏览器经 https 访问）。 */
  cookieSecure(): boolean {
    const cfg = this.config.get();
    return cfg.auth.cookieSecure || (cfg.http.publicUrl ?? "").startsWith("https:");
  }

  /** 网页地址：`http.publicUrl` + 站内路径（未配置 publicUrl 时为相对地址）。 */
  webUrl(path: string): string {
    const base = (this.config.get().http.publicUrl ?? "").replace(/\/+$/, "");
    return `${base}${path}`;
  }

  /** 登录页并带原因码。 */
  loginError(code: SsoLoginError): string {
    return this.webUrl(`${LOGIN_PATH}?error=${encodeURIComponent(code)}`);
  }

  /**
   * 发起登录，返回 302 目标：插件的授权地址；插件未启用、未配置 `http.publicUrl` 或插件出错 → 登录页 `sso.unavailable`。
   * `binding` 为本浏览器的绑定值（由 controller 写入 Cookie）；`sessionAccountId` 为发起请求带着的 Web 会话账号。
   */
  async start(
    plugin: string,
    returnTo: string | undefined,
    binding: string,
    sessionAccountId?: string,
  ): Promise<string> {
    const src = this.provider(plugin);
    if (!src || !this.config.get().http.publicUrl) return this.loginError("sso.unavailable");
    const state = b64url();
    const nonce = b64url();
    const codeVerifier = b64url();
    const redirectUri = this.redirectUri(plugin);
    let url: string;
    try {
      url = src.authorizeUrl({
        config: this.ports.host.deploymentConfig(plugin),
        redirectUri,
        state,
        nonce,
        codeChallenge: sha256(codeVerifier),
        codeChallengeMethod: "S256",
      });
      const proto = new URL(url).protocol;
      if (proto !== "https:" && proto !== "http:") throw new Error("authorize URL must be http(s)");
    } catch (err) {
      this.log.warn("identity source authorizeUrl failed", { plugin, err });
      return this.loginError("sso.unavailable");
    }
    const rec: StateRecord = {
      plugin,
      nonce,
      redirectUri,
      returnTo: safeReturnTo(returnTo),
      binding: sha256(binding),
      codeVerifier,
      ...(sessionAccountId !== undefined && { sessionAccountId }),
    };
    await this.redis.set(stateKey(state), JSON.stringify(rec), "EX", SSO_STATE_TTL_SECONDS);
    return url;
  }

  /**
   * 处理身份源的回跳。state 先取后删（无论成败都不能再用）；state 属于别的插件 → `sso.state_invalid`；
   * 绑定 Cookie 不符 → `sso.session_mismatch`；身份源报错只映射为原因码；插件交回的身份源键必须由内核推导得出
   * （`${插件名}:${identity.tenantId}`，Ruling A19），否则按 `sso.provider_error` 拒绝。
   * 身份行经 IM 绑定建立、且发起与回调时不是同一个已登录的本人账号 → `sso.identity_not_verified`
   * （Ruling A18）。成功则解析到账号（不判断账号状态，由调用方处理）。
   * `sessionAccountId`：回调请求已带着的 Web 会话的账号（未登录时省略）。
   */
  async callback(
    plugin: string,
    query: Record<string, string>,
    binding: string | undefined,
    sessionAccountId?: string,
  ): Promise<SsoCallbackResult> {
    const state = query.state;
    if (state === undefined || !STATE_RE.test(state))
      return { ok: false, error: "sso.state_invalid" };
    const raw = await this.redis.getdel(stateKey(state));
    if (raw === null) return { ok: false, error: "sso.state_invalid" };
    const rec = JSON.parse(raw) as StateRecord;
    if (rec.plugin !== plugin) return { ok: false, error: "sso.state_invalid" };
    if (binding === undefined || !sameHash(sha256(binding), rec.binding)) {
      return { ok: false, error: "sso.session_mismatch" };
    }
    if (query.error !== undefined) {
      return {
        ok: false,
        error: query.error === "access_denied" ? "sso.access_denied" : "sso.provider_error",
      };
    }
    const src = this.provider(plugin);
    if (!src) return { ok: false, error: "sso.unavailable" };
    let identity: Awaited<ReturnType<IdentitySource["callback"]>>;
    try {
      identity = await src.callback({
        config: this.ports.host.deploymentConfig(plugin),
        redirectUri: rec.redirectUri,
        query,
        nonce: rec.nonce,
        signal: AbortSignal.timeout(SSO_CALLBACK_TIMEOUT_MS),
        codeVerifier: rec.codeVerifier,
      });
    } catch (err) {
      this.log.warn("identity source callback failed", { plugin, err });
      return { ok: false, error: "sso.provider_error" };
    }
    // 身份源键由内核推导（Ruling A19）：插件只能为自己、为它报出的租户声明身份
    if (
      typeof identity?.tenantId !== "string" ||
      identity.source !== `${plugin}:${identity.tenantId}`
    ) {
      this.log.warn("identity source returned a source key that does not match its tenant", {
        plugin,
      });
      return { ok: false, error: "sso.provider_error" };
    }
    // 升级 bind 身份：发起与回调时是同一个已登录账号才算本人在登录状态下证明了对该身份的控制
    const provedBy =
      rec.sessionAccountId !== undefined && rec.sessionAccountId === sessionAccountId
        ? sessionAccountId
        : undefined;
    let accountId: string;
    try {
      // 只有登录路径允许按已验证邮箱合并（Ruling A9）
      accountId = (
        await this.external.resolve(identity, {
          allowMerge: true,
          linkedVia: "sso",
          login: provedBy === undefined ? {} : { sessionAccountId: provedBy },
        })
      ).accountId;
    } catch (err) {
      if (err instanceof IdentityNotVerified) {
        this.log.warn("sign-in with an unverified linked identity refused", { plugin });
        return { ok: false, error: "sso.identity_not_verified" };
      }
      if (!(err instanceof ApiError)) throw err;
      this.log.warn("external identity rejected", { plugin, err });
      return { ok: false, error: "sso.provider_error" };
    }
    return { ok: true, accountId, returnTo: rec.returnTo };
  }
}
