import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type IdentitySource, isIdentitySourceRefused, type Logger } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ApiError } from "../errors.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { type HandoffRecord, handoffDonePath } from "../handoff/handoff-paths.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import { isSafeReturnPath } from "../tools/oauth/flow-paths.js";
import { ExternalIdentities } from "./external.js";
import { LoginSourcesService } from "./login-sources.js";
import type { SsoIntent } from "./sso-decisions.js";
import { SsoLinkTickets } from "./sso-link.js";
import { SSO_PATH_PREFIX, ssoCallbackPath } from "./sso-paths.js";

export {
  decideSsoCallback,
  type SsoDecision,
  type SsoDecisionInput,
  type SsoIntent,
} from "./sso-decisions.js";

/** state 的有效期（秒）。 */
export const SSO_STATE_TTL_SECONDS = 600;
/** 浏览器绑定 Cookie：回调必须来自发起登录的同一个浏览器（防登录 CSRF / 把回跳链接转给别人）。 */
export const SSO_BINDING_COOKIE = "cap_sso";
/** 绑定 Cookie 的 Path：覆盖所有插件的回调。 */
export const SSO_COOKIE_PATH = SSO_PATH_PREFIX;
/** 登录失败回到的网页（next-intl 会补语言前缀）。 */
export const LOGIN_PATH = "/login";
/** 插件 `callback` 的最长等待。 */
export const SSO_CALLBACK_TIMEOUT_MS = 15_000;

/**
 * The reason codes of a failed sign-in (in the redirect `/login?error=<code>`; the page shows its
 * own i18n text per code and never the identity source's text). `auth.account_disabled`,
 * `sso.session_mismatch` and `sso.link_expired` share their names with API error codes (the link
 * page's routes answer them as errors).
 */
export type SsoLoginError =
  | "sso.unavailable"
  | "sso.state_invalid"
  | "sso.session_mismatch"
  | "sso.access_denied"
  | "sso.provider_error"
  | "sso.account_not_allowed"
  | "sso.link_expired"
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
   * The account of the web session the start carried (absent when signed out). A `link` intent
   * requires it, and the callback must carry the same session: the intent to link is fixed at the
   * start, never by whatever session the callback happens to carry.
   */
  sessionAccountId?: string;
  /** Why the sign-in started. */
  intent: SsoIntent;
}

/** 一个有效的浏览器绑定值（复用请求里已有的，否则新生成）。 */
export function ssoBrowserBinding(existing: string | undefined): string {
  return existing !== undefined && BINDING_RE.test(existing) ? existing : b64url();
}

/** Appends `error=<code>` to a site path (a link intent's failure back on its page). */
export function withError(path: string, code: string): string {
  const hash = path.indexOf("#");
  const base = hash < 0 ? path : path.slice(0, hash);
  const frag = hash < 0 ? "" : path.slice(hash);
  return `${base}${base.includes("?") ? "&" : "?"}error=${encodeURIComponent(code)}${frag}`;
}

/** The return page: a site-relative path (a single leading `/`, not `//`), else `/` (no open redirect). */
export function safeReturnTo(p: string | undefined): string {
  return p !== undefined && isSafeReturnPath(p) ? p : "/";
}

/**
 * The callback's outcome: `signin` creates a session for the account; `linked` (a link intent)
 * keeps the session it has and goes back to the page; `link_page` sends the person to the link
 * page with a ticket. A failure carries its reason code; `returnTo` is set for a link intent's
 * failure after the session check (back to the page that started it, with the code, rather than
 * the sign-in page a signed-in person would bounce off). `identity.taken` is a link intent's only.
 */
export type SsoCallbackResult =
  | { ok: true; kind: "signin"; accountId: string; returnTo: string }
  | { ok: true; kind: "linked"; accountId: string; returnTo: string }
  | { ok: true; kind: "link_page"; ticket: string }
  | { ok: false; error: SsoLoginError | "identity.taken"; returnTo?: string };

/**
 * Third-party sign-in (`identity-source@1`): the start makes a state (32 random bytes, Redis
 * `capk:sso-state:<state>` for 10 minutes, single use, holding the plugin, nonce, PKCE verifier,
 * redirect_uri, return page, intent, the start's session account and the hash of the browser
 * binding value); the authorize URL carries the PKCE challenge (S256). The callback takes and
 * deletes the state, checks the binding cookie, has the plugin (with the verifier) verify the
 * external identity, then decides on its identity row (spec 2026-11-26-login-extensions §4): sign
 * in, link, upgrade a `bind` row, self sign-up, or the link page ({@link SsoLinkTickets}). The
 * controller creates the session. All state is in Redis, none in process.
 *
 * A signed-in person links an external account with `intent: link` (the linked accounts page):
 * the same session at start and callback, linked to that account, never a new account or a
 * switched session; it also upgrades the person's IM `bind` row (Ruling A18).
 */
@Injectable()
export class SsoFlow {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(ExtensionRegistry)
    private readonly registry: Pick<ExtensionRegistry, "deploymentConfig">,
    @Inject(LoginSourcesService)
    private readonly loginSources: Pick<LoginSourcesService, "enabled">,
    @Inject(ExternalIdentities) private readonly external: ExternalIdentities,
    @Inject(SsoLinkTickets) private readonly linkTickets: Pick<SsoLinkTickets, "create">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "warn">,
  ) {}

  /**
   * The login methods on offer: the enabled login sources whose extension is loaded and provides
   * `identity-source@1`, in login page order (read from PG at each call).
   */
  async sources(): Promise<{ plugin: string; label: { zh: string; en: string } }[]> {
    return (await this.loginSources.enabled()).map(({ plugin, source }) => ({
      plugin,
      label: { zh: source.label.zh, en: source.label.en },
    }));
  }

  /** The enabled login source of `plugin` when it is on offer (see {@link sources}). */
  private async entry(plugin: string) {
    return (await this.loginSources.enabled()).find((e) => e.plugin === plugin);
  }

  /** The identity source of `plugin` when its login source is on offer (see {@link sources}). */
  async provider(plugin: string): Promise<IdentitySource | undefined> {
    return (await this.entry(plugin))?.source;
  }

  /**
   * Whether a link intent of `plugin` can start now: its login source is on offer and
   * `http.publicUrl` is set (otherwise {@link start} answers `sso.unavailable`).
   */
  async linkAvailable(plugin: string): Promise<boolean> {
    if (!this.config.get().http.publicUrl) return false;
    return (await this.provider(plugin)) !== undefined;
  }

  private redirectUri(plugin: string): string {
    const base = (this.config.get().http.publicUrl ?? "").replace(/\/+$/, "");
    return `${base}${ssoCallbackPath(plugin)}`;
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

  /** The sign-in page with a reason code. */
  loginError(code: SsoLoginError): string {
    return this.webUrl(`${LOGIN_PATH}?error=${encodeURIComponent(code)}`);
  }

  /**
   * Starts a sign-in and returns the target to navigate to: the source's authorize URL. A sign-in's
   * failure (source not on offer, no `http.publicUrl`, a plugin error: `sso.unavailable`) goes to
   * the sign-in page; a link intent's back to its page with `?error=<code>`. A link intent needs
   * the web session's account and must come from a CSRF-protected request (the controller's
   * `POST …/start`; a cross-site top-level GET carries the Lax session cookie, so a GET start never
   * links). `binding` is this browser's binding value (the controller writes the cookie). With
   * `handoff` (a browser handoff redeemed in this browser), the return page is the handoff done
   * page the kernel builds from the ticket's record, and `returnTo` is ignored.
   */
  async start(
    plugin: string,
    returnTo: string | undefined,
    binding: string,
    sessionAccountId?: string,
    intent: SsoIntent = "signin",
    handoff?: HandoffRecord,
  ): Promise<string> {
    const back = handoff !== undefined ? handoffDonePath(handoff) : safeReturnTo(returnTo);
    const fail = (code: SsoLoginError) =>
      intent === "link" ? this.webUrl(withError(back, code)) : this.loginError(code);
    if (intent === "link" && sessionAccountId === undefined) {
      return this.loginError("sso.session_mismatch");
    }
    const src = await this.provider(plugin);
    if (!src || !this.config.get().http.publicUrl) return fail("sso.unavailable");
    const state = b64url();
    const nonce = b64url();
    const codeVerifier = b64url();
    const redirectUri = this.redirectUri(plugin);
    let url: string;
    try {
      url = src.authorizeUrl({
        config: this.registry.deploymentConfig(plugin),
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
      return fail("sso.unavailable");
    }
    const rec: StateRecord = {
      plugin,
      nonce,
      redirectUri,
      returnTo: back,
      binding: sha256(binding),
      codeVerifier,
      ...(sessionAccountId !== undefined && { sessionAccountId }),
      intent,
    };
    await this.redis.set(stateKey(state), JSON.stringify(rec), "EX", SSO_STATE_TTL_SECONDS);
    return url;
  }

  /**
   * Handles the identity source's redirect back. The state is read and deleted in one step (it can
   * never be used again, whatever the outcome); a state that belongs to another plugin →
   * `sso.state_invalid`; a browser binding cookie that does not match → `sso.session_mismatch`; a
   * `link` intent whose callback does not carry the session its start carried →
   * `sso.session_mismatch` (before the identity source runs: nothing is created or switched).
   * The login source must still be on offer (`sso.unavailable` once a super admin switched it off
   * mid-flow). Errors from the identity source map only to reason codes: a deliberate refusal
   * (`IdentitySourceRefused`) → `sso.account_not_allowed`, any other error → `sso.provider_error`.
   * The source key the plugin returns must be the one the kernel derives
   * (`${plugin}:${identity.tenantId}`, Ruling A19), otherwise `sso.provider_error`. Then the
   * decision of spec §4 ({@link decideSsoCallback}) is taken and applied under the identity lock
   * (`ExternalIdentities.decideSignIn`); the link page's ticket is stored in Redis. Account status
   * is not checked here (the caller refuses a disabled account).
   * `sessionAccountId`: the account of the web session the callback request carries (omitted when
   * signed out).
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
    const intent = rec.intent;
    if (
      intent === "link" &&
      (rec.sessionAccountId === undefined || rec.sessionAccountId !== sessionAccountId)
    ) {
      return { ok: false, error: "sso.session_mismatch" };
    }
    // a link intent's failures go back to the page that started it
    const fail = (error: SsoLoginError | "identity.taken"): SsoCallbackResult => ({
      ok: false,
      error,
      ...(intent === "link" && { returnTo: rec.returnTo }),
    });
    if (query.error !== undefined) {
      return fail(query.error === "access_denied" ? "sso.access_denied" : "sso.provider_error");
    }
    const entry = await this.entry(plugin);
    if (!entry) return fail("sso.unavailable");
    let identity: Awaited<ReturnType<IdentitySource["callback"]>>;
    try {
      identity = await entry.source.callback({
        config: this.registry.deploymentConfig(plugin),
        redirectUri: rec.redirectUri,
        query,
        nonce: rec.nonce,
        signal: AbortSignal.timeout(SSO_CALLBACK_TIMEOUT_MS),
        codeVerifier: rec.codeVerifier,
      });
    } catch (err) {
      // A deliberate refusal gets its own code; its message goes to the log only, never the URL
      if (isIdentitySourceRefused(err)) {
        this.log.warn("identity source refused the account", {
          plugin,
          reason: (err as Error).message,
        });
        return fail("sso.account_not_allowed");
      }
      this.log.warn("identity source callback failed", { plugin, err });
      return fail("sso.provider_error");
    }
    // the kernel derives the source key (Ruling A19): a plugin claims identities only for itself,
    // for the tenant it reports
    if (
      typeof identity?.tenantId !== "string" ||
      identity.source !== `${plugin}:${identity.tenantId}`
    ) {
      this.log.warn("identity source returned a source key that does not match its tenant", {
        plugin,
      });
      return fail("sso.provider_error");
    }
    let decided: Awaited<ReturnType<ExternalIdentities["decideSignIn"]>>;
    try {
      decided = await this.external.decideSignIn(identity, {
        intent,
        ...(intent === "link" && sessionAccountId !== undefined && { sessionAccountId }),
        signUp: entry.settings.signUp,
      });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.code === "identity.taken") return fail("identity.taken");
      this.log.warn("external identity rejected", { plugin, err });
      return fail("sso.provider_error");
    }
    const d = decided.decision;
    switch (d.kind) {
      case "error":
        return fail(d.code);
      case "link_page": {
        const ticket = await this.linkTickets.create({
          plugin,
          identity: decided.identity,
          returnTo: rec.returnTo,
          binding: rec.binding,
        });
        return { ok: true, kind: "link_page", ticket };
      }
      default:
        return {
          ok: true,
          kind: intent === "link" ? "linked" : "signin",
          accountId: d.accountId,
          returnTo: rec.returnTo,
        };
    }
  }
}
