import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { CredentialThrottler } from "../infra/throttler/credential-throttler.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { type Account, AccountsService } from "./accounts.js";
import { clientMeta, LOGIN_THROTTLERS } from "./auth.controller.js";
import { IdentityBinding, type PendingBinding } from "./binding.js";
import { setSessionCookies } from "./cookies.js";
import { ExternalIdentities, type LinkedIdentity } from "./external.js";
import { CurrentPrincipal, type Principal, Public, requireUser, SessionOnly } from "./principal.js";
import { SessionService } from "./sessions.js";
import {
  SSO_BINDING_COOKIE,
  SSO_COOKIE_PATH,
  SSO_STATE_TTL_SECONDS,
  SsoFlow,
  ssoBrowserBinding,
} from "./sso.js";
import {
  linkExpired,
  SSO_LINK_PAGE_PATH,
  SSO_LINK_TTL_SECONDS,
  SsoLinkTickets,
} from "./sso-link.js";

const LinkBodySchema = z.object({
  ticket: z.string().max(100),
  login: z.string().max(256),
  password: z.string(),
});
class LinkBody extends createZodDto(LinkBodySchema, "SsoLinkBody") {}

/** What the link page shows (`GET /api/v1/auth/sso/link`). */
export interface SsoLinkView {
  plugin: string;
  label: { zh: string; en: string };
  tenantId: string;
  displayName: string;
  avatarUrl?: string;
  /** The external account is already linked to a Capybara account for IM (never which one). */
  linkedToAnother: boolean;
}

/** Appends `error=<code>` to a site path (a link intent's failure back on its page). */
function withError(path: string, code: string): string {
  const hash = path.indexOf("#");
  const base = hash < 0 ? path : path.slice(0, hash);
  const frag = hash < 0 ? "" : path.slice(hash);
  return `${base}${base.includes("?") ? "&" : "?"}error=${encodeURIComponent(code)}${frag}`;
}

const MAX_QUERY_KEYS = 50;
const MAX_QUERY_VALUE = 4096;

/** 查询参数只取单值字符串（重复参数 / 数组 / 超长值丢弃）。 */
function stringQuery(q: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q).slice(0, MAX_QUERY_KEYS)) {
    if (typeof v === "string" && v.length <= MAX_QUERY_VALUE) out[k] = v;
  }
  return out;
}

/**
 * 第三方登录（`/api/v1/auth/sources`、`/api/v1/auth/sso/:plugin/*`，均为公开路由）。浏览器整页跳转，
 * 发起与回调都以 302 结束；失败回登录页并带原因码（`/login?error=<code>`），不回显身份源文本。
 */
@Controller("api/v1/auth")
export class SsoController {
  constructor(
    @Inject(SsoFlow) private readonly flow: SsoFlow,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(SsoLinkTickets) private readonly linkTickets: SsoLinkTickets,
    @Inject(ExternalIdentities) private readonly external: ExternalIdentities,
    @Inject(CredentialThrottler) private readonly throttler: CredentialThrottler,
  ) {}

  @Get("sources")
  @Public()
  async sources(): Promise<{ sources: { plugin: string; label: { zh: string; en: string } }[] }> {
    return { sources: await this.flow.sources() };
  }

  /**
   * Starts a sign-in: 302 to the source's authorize URL, writing the browser binding cookie
   * `cap_sso` (HttpOnly, SameSite=Lax: the source's redirect back is a cross-site top-level GET,
   * which Lax sends; Path only `/api/v1/auth/sso`). `intent=link` (the linked accounts page)
   * needs a web session and links to its account; anything else is a sign-in.
   */
  @Get("sso/:plugin/start")
  @Public()
  async start(
    @Param("plugin") plugin: string,
    @Query("returnTo") returnTo: unknown,
    @Query("intent") intent: unknown,
    @CurrentPrincipal() principal: Principal | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const binding = ssoBrowserBinding(req.cookies[SSO_BINDING_COOKIE]);
    // the session's account at the start goes into the state: a link intent's callback must carry
    // the same session
    const location = await this.flow.start(
      plugin,
      typeof returnTo === "string" ? returnTo : undefined,
      binding,
      sessionAccount(principal),
      intent === "link" ? "link" : "signin",
    );
    this.setBindingCookie(reply, binding, SSO_STATE_TTL_SECONDS);
    await reply.header("cache-control", "no-store").redirect(location, 302);
  }

  private setBindingCookie(reply: FastifyReply, binding: string, maxAge: number): void {
    reply.setCookie(SSO_BINDING_COOKIE, binding, {
      path: SSO_COOKIE_PATH,
      httpOnly: true,
      sameSite: "lax",
      secure: this.flow.cookieSecure(),
      maxAge,
    });
  }

  /**
   * The identity source's redirect back: state and binding cookie checked → the plugin verifies
   * the external identity → spec §4's decision ({@link SsoFlow.callback}). A sign-in creates a
   * session, writes the session cookies and 302s to the page (`http.publicUrl` + returnTo); a
   * disabled account → the sign-in page with `auth.account_disabled`, no session. A link intent
   * keeps its session and goes back to its page (its failures too, with `?error=<code>`). The link
   * page branch keeps the binding cookie (renewed for the ticket's lifetime: the link page's routes
   * need it) and 302s to `/login/link?ticket=…`; every other outcome clears it.
   */
  @Get("sso/:plugin/callback")
  @Public()
  async callback(
    @Param("plugin") plugin: string,
    @Query() q: Record<string, unknown>,
    @CurrentPrincipal() principal: Principal | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const binding = req.cookies[SSO_BINDING_COOKIE];
    const r = await this.flow.callback(plugin, stringQuery(q), binding, sessionAccount(principal));
    let location: string;
    if (!r.ok) {
      location =
        r.returnTo === undefined
          ? this.flow.loginError(r.error === "identity.taken" ? "sso.provider_error" : r.error)
          : this.flow.webUrl(withError(r.returnTo, r.error));
    } else if (r.kind === "link_page") {
      // the binding value is the one the state was checked against
      this.setBindingCookie(reply, binding as string, SSO_LINK_TTL_SECONDS);
      const target = this.flow.webUrl(
        `${SSO_LINK_PAGE_PATH}?ticket=${encodeURIComponent(r.ticket)}`,
      );
      await reply.header("cache-control", "no-store").redirect(target, 302);
      return;
    } else if (r.kind === "linked") {
      location = this.flow.webUrl(r.returnTo);
    } else {
      const account = await this.accounts.get(r.accountId);
      if (account?.status !== "active") {
        location = this.flow.loginError("auth.account_disabled");
      } else {
        const session = await this.sessions.create(account.id, clientMeta(req));
        setSessionCookies(reply, session, this.config.get());
        location = this.flow.webUrl(r.returnTo);
      }
    }
    reply.clearCookie(SSO_BINDING_COOKIE, { path: SSO_COOKIE_PATH });
    await reply.header("cache-control", "no-store").redirect(location, 302);
  }

  /**
   * The link page's view of a pending link (spec §5): needs the ticket and the matching binding
   * cookie (`sso.link_expired` / `sso.session_mismatch`); a source switched off since →
   * `sso.link_expired` (the ticket is dropped). Says whether the external account is already
   * linked to some account (an IM `bind` row), never to which.
   */
  @Get("sso/link")
  @Public()
  async linkView(
    @Query("ticket") ticket: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SsoLinkView> {
    const t = typeof ticket === "string" ? ticket : "";
    const link = await this.linkTickets.peek(t, req.cookies[SSO_BINDING_COOKIE]);
    const src = await this.flow.provider(link.plugin);
    if (!src) {
      await this.linkTickets.discard(t);
      throw linkExpired();
    }
    const row = await this.external.peekRow(link.identity);
    return {
      plugin: link.plugin,
      label: { zh: src.label.zh, en: src.label.en },
      tenantId: link.identity.tenantId,
      displayName: link.identity.displayName,
      ...(link.identity.avatarUrl !== undefined && { avatarUrl: link.identity.avatarUrl }),
      linkedToAnother: row !== undefined,
    };
  }

  /**
   * Completes a pending link with the person's username and password (spec §5). Public; the
   * global guard requires the CSRF header on this unsafe public route, and the binding cookie must
   * match. The password goes through the same service and the same credential throttlers as
   * `POST /auth/login` (R25); a wrong one also costs the ticket an attempt (the fifth burns it). A
   * disabled account → `auth.account_disabled` (its password was right: no attempt is counted, the
   * reservation is given back). An identity already linked to another account →
   * `identity.taken`, the ticket kept. On success the ticket is taken atomically (a concurrent
   * submission gets `sso.link_expired`), the identity is linked as `sso` (or the account's `bind`
   * row upgraded) and a session is created exactly as a password sign-in; an account that must
   * change its password is sent there by the web as after a password sign-in.
   */
  @Post("sso/link")
  @Public()
  @HttpCode(200)
  async link(
    @ZBody(LinkBody) body: z.infer<typeof LinkBodySchema>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ account: Account; returnTo: string }> {
    const binding = req.cookies[SSO_BINDING_COOKIE];
    const pending = await this.linkTickets.peek(body.ticket, binding);
    if (!(await this.flow.provider(pending.plugin))) {
      await this.linkTickets.discard(body.ticket);
      throw linkExpired();
    }
    // reserve before checking the password, atomically (as POST /auth/login)
    await this.throttler.reserve(LOGIN_THROTTLERS, req, reply);
    let account: Account | null;
    try {
      account = await this.accounts.authenticateLocal(body.login, body.password);
    } catch (e) {
      if (e instanceof ApiError && e.code === "auth.account_disabled") {
        await this.throttler.succeeded(LOGIN_THROTTLERS, req);
      }
      throw e;
    }
    if (!account) {
      await this.linkTickets.failedAttempt(body.ticket);
      throw new ApiError("auth.invalid_credentials", "Invalid login or password");
    }
    await this.throttler.succeeded(LOGIN_THROTTLERS, req);
    // refused before the ticket is taken, so the person may try the other account's password
    const row = await this.external.peekRow(pending.identity);
    if (row !== undefined && row.accountId !== account.id) throw identityTaken();
    const link = await this.linkTickets.redeem(body.ticket, binding);
    await this.external.linkVerified(account.id, link.identity, "link_page");
    const session = await this.sessions.create(account.id, clientMeta(req));
    setSessionCookies(reply, session, this.config.get());
    reply.clearCookie(SSO_BINDING_COOKIE, { path: SSO_COOKIE_PATH });
    return { account, returnTo: link.returnTo };
  }
}

const identityTaken = () =>
  new ApiError("identity.taken", "This external identity is already linked to another account");

/**
 * IM 身份绑定确认（`/api/v1/bind/:token`，需 Web 会话）：GET 查看待绑定的身份，POST 绑到当前账号。
 * 令牌单次有效；身份已绑定他人 → 409 `identity.taken`。
 */
/** 请求带着的 Web 会话的账号（PAT / 未登录时 undefined）。 */
function sessionAccount(principal: Principal | undefined): string | undefined {
  return principal?.kind === "user" && principal.via === "session"
    ? principal.account.id
    : undefined;
}

@Controller("api/v1/bind")
export class BindController {
  constructor(@Inject(IdentityBinding) private readonly binding: IdentityBinding) {}

  @Get(":token")
  @SessionOnly()
  async peek(
    @CurrentPrincipal() principal: Principal,
    @Param("token") token: string,
  ): Promise<{ binding: PendingBinding }> {
    requireUser(principal);
    return { binding: await this.binding.peek(token) };
  }

  @Post(":token")
  @SessionOnly()
  @HttpCode(200)
  async bind(
    @CurrentPrincipal() principal: Principal,
    @Param("token") token: string,
  ): Promise<{ binding: PendingBinding }> {
    const p = requireUser(principal);
    return { binding: await this.binding.bind(token, p.account.id) };
  }
}

/** 本人绑定的外部身份（`/api/v1/me/identities`）：列出、解除。 */
@Controller("api/v1/me/identities")
export class MeIdentitiesController {
  constructor(@Inject(ExternalIdentities) private readonly external: ExternalIdentities) {}

  @Get()
  async list(@CurrentPrincipal() principal: Principal): Promise<{ identities: LinkedIdentity[] }> {
    const p = requireUser(principal);
    return { identities: await this.external.listForAccount(p.account.id) };
  }

  @Delete(":source/:externalId")
  @SessionOnly()
  @HttpCode(204)
  async unlink(
    @CurrentPrincipal() principal: Principal,
    @Param("source") source: string,
    @Param("externalId") externalId: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.external.unlink(p.account.id, source, externalId);
  }
}
