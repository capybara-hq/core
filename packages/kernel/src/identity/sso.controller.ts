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
import { assertReturnSchemeAllowed, HandoffRequestSchema } from "../handoff/app-schemes.js";
import { HandoffTickets } from "../handoff/handoff-tickets.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { CredentialThrottler } from "../infra/throttler/credential-throttler.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { type Account, AccountsService } from "./accounts.js";
import { clientMeta, LOGIN_THROTTLERS } from "./auth.controller.js";
import { IdentityBinding, type PendingBinding } from "./binding.js";
import { setSessionCookies } from "./cookies.js";
import { ExternalIdentities } from "./external.js";
import {
  type LinkableMethod,
  type LinkedAccountRow,
  LinkedAccountsService,
} from "./linked-accounts.js";
import { CurrentPrincipal, type Principal, Public, requireUser, SessionOnly } from "./principal.js";
import { SessionService } from "./sessions.js";
import {
  SSO_BINDING_COOKIE,
  SSO_COOKIE_PATH,
  SSO_STATE_TTL_SECONDS,
  SsoFlow,
  safeReturnTo,
  ssoBrowserBinding,
  withError,
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

/**
 * `POST /auth/sso/:plugin/start`: a link intent and the page to come back to. `handoff` (a native
 * shell): finish the link in the system browser through a handoff ticket instead.
 */
const StartLinkBodySchema = z.object({
  intent: z.literal("link"),
  returnTo: z.string().max(2000).optional(),
  handoff: HandoffRequestSchema.optional(),
});
class StartLinkBody extends createZodDto(StartLinkBodySchema, "SsoStartLinkBody") {}

/**
 * The link start's answer: where the browser goes next (the source's authorize URL, or the page
 * with `?error=<code>`), or with `handoff` the web page that starts the link in the system browser.
 */
export type SsoStartLinkResponse = { location: string } | { handoffUrl: string };

/**
 * Writes the SSO browser binding cookie `cap_sso` (HttpOnly, SameSite=Lax: the source's redirect
 * back is a cross-site top-level GET, which Lax sends; Path only `/api/v1/auth/sso`). `secure` is
 * {@link SsoFlow.cookieSecure}.
 */
export function setSsoBindingCookie(
  reply: FastifyReply,
  binding: string,
  secure: boolean,
  maxAge: number = SSO_STATE_TTL_SECONDS,
): void {
  reply.setCookie(SSO_BINDING_COOKIE, binding, {
    path: SSO_COOKIE_PATH,
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge,
  });
}

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
    @Inject(HandoffTickets) private readonly tickets: HandoffTickets,
  ) {}

  @Get("sources")
  @Public()
  async sources(): Promise<{ sources: { plugin: string; label: { zh: string; en: string } }[] }> {
    return { sources: await this.flow.sources() };
  }

  /**
   * Starts a sign-in: 302 to the source's authorize URL, writing the browser binding cookie
   * `cap_sso` (HttpOnly, SameSite=Lax: the source's redirect back is a cross-site top-level GET,
   * which Lax sends; Path only `/api/v1/auth/sso`). Always a sign-in: `intent=link` is refused
   * with `sso.session_mismatch` and no state, because a cross-site page can trigger this GET with
   * the person's Lax session cookie and would link whatever external account that browser is
   * signed in to (a link intent starts from `POST …/start`).
   */
  @Get("sso/:plugin/start")
  @Public()
  async start(
    @Param("plugin") plugin: string,
    @Query("returnTo") returnTo: unknown,
    @Query("intent") intent: unknown,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (intent === "link") {
      await reply
        .header("cache-control", "no-store")
        .redirect(this.flow.loginError("sso.session_mismatch"), 302);
      return;
    }
    const binding = ssoBrowserBinding(req.cookies[SSO_BINDING_COOKIE]);
    const location = await this.flow.start(
      plugin,
      typeof returnTo === "string" ? returnTo : undefined,
      binding,
    );
    setSsoBindingCookie(reply, binding, this.flow.cookieSecure());
    await reply.header("cache-control", "no-store").redirect(location, 302);
  }

  /**
   * Starts a link intent (the linked accounts page, spec §4): web session only, and as an unsafe
   * method it needs the CSRF header (global guard), so no other site can start it. The state
   * records the session's account; the callback must carry the same session. Writes the binding
   * cookie as the GET start does and returns where the browser goes next: the source's authorize
   * URL, or, on failure, the page with `?error=<code>`. With `handoff` (a native shell, shell
   * external authorization spec §1): no cookie and no state; a source on offer gets a handoff
   * ticket and its web page, where the link starts when the person redeems it in the system
   * browser; a source not on offer answers the same `?error=sso.unavailable` location.
   */
  @Post("sso/:plugin/start")
  @SessionOnly()
  @HttpCode(200)
  async startLink(
    @Param("plugin") plugin: string,
    @ZBody(StartLinkBody) body: z.infer<typeof StartLinkBodySchema>,
    @CurrentPrincipal() principal: Principal,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SsoStartLinkResponse> {
    const p = requireUser(principal);
    reply.header("cache-control", "no-store");
    if (body.handoff !== undefined) {
      const returnScheme = body.handoff.returnScheme;
      assertReturnSchemeAllowed(this.config.get(), returnScheme);
      const returnTo = safeReturnTo(body.returnTo);
      if (!(await this.flow.linkAvailable(plugin))) {
        return { location: this.flow.webUrl(withError(returnTo, "sso.unavailable")) };
      }
      const ticket = await this.tickets.create({
        kind: "identity-link",
        accountId: p.account.id,
        plugin,
        returnTo,
        ...(returnScheme !== undefined && { returnScheme }),
      });
      return { handoffUrl: this.tickets.url(ticket) };
    }
    const binding = ssoBrowserBinding(req.cookies[SSO_BINDING_COOKIE]);
    const location = await this.flow.start(
      plugin,
      body.returnTo,
      binding,
      p.account.id,
      body.intent,
    );
    setSsoBindingCookie(reply, binding, this.flow.cookieSecure());
    return { location };
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
      setSsoBindingCookie(reply, binding as string, this.flow.cookieSecure(), SSO_LINK_TTL_SECONDS);
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
   * match (it relies on no sibling origin being able to set cookies for the kernel's host, see
   * `SsoLinkTickets`). The password goes through the same service and the same credential
   * throttlers as `POST /auth/login` (R25); each check first reserves one of the ticket's attempts
   * atomically, and a wrong password keeps it (the fifth burns the ticket). A disabled account →
   * `auth.account_disabled` (its password was right: the ticket's attempt and the throttler
   * reservation are given back). The login source is checked again after the ticket is taken. An
   * identity already linked to another account → `identity.taken`, the ticket kept. On success the ticket is taken atomically (a concurrent
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
    // one of the ticket's attempts first (atomic: concurrent wrong passwords never exceed the
    // limit), then one on the login throttlers, before checking the password (as POST /auth/login)
    await this.linkTickets.reserveAttempt(body.ticket);
    let account: Account | null;
    try {
      await this.throttler.reserve(LOGIN_THROTTLERS, req, reply);
      try {
        account = await this.accounts.authenticateLocal(body.login, body.password);
      } catch (e) {
        // a disabled account's password is right: no failed attempt, the reservation given back
        if (e instanceof ApiError && e.code === "auth.account_disabled") {
          await this.throttler.succeeded(LOGIN_THROTTLERS, req);
        }
        throw e;
      }
    } catch (e) {
      // rate limited or disabled: the ticket's attempt is given back
      await this.linkTickets.refundAttempt(body.ticket);
      throw e;
    }
    if (!account) {
      await this.linkTickets.failedAttempt(body.ticket);
      throw new ApiError("auth.invalid_credentials", "Invalid login or password");
    }
    await this.throttler.succeeded(LOGIN_THROTTLERS, req);
    // refused before the ticket is taken, so the person may try the other account's password
    const row = await this.external.peekRow(pending.identity);
    if (row !== undefined && row.accountId !== account.id) {
      await this.linkTickets.refundAttempt(body.ticket);
      throw identityTaken();
    }
    const link = await this.linkTickets.redeem(body.ticket, binding);
    // the source may have been switched off while the password was checked: no row then
    if (!(await this.flow.provider(link.plugin))) throw linkExpired();
    await this.external.linkVerified(account.id, link.identity, "link_page");
    const session = await this.sessions.create(account.id, clientMeta(req));
    setSessionCookies(reply, session, this.config.get());
    reply.clearCookie(SSO_BINDING_COOKIE, { path: SSO_COOKIE_PATH });
    return { account, returnTo: link.returnTo };
  }
}

const identityTaken = () =>
  new ApiError("identity.taken", "This external identity is already linked to another account");

/** The account of the request's web session (undefined for a PAT or when signed out). */
function sessionAccount(principal: Principal | undefined): string | undefined {
  return principal?.kind === "user" && principal.via === "session"
    ? principal.account.id
    : undefined;
}

/**
 * IM binding confirmation (`/api/v1/bind/:token`, web session only): GET shows the identity to
 * bind, POST binds it to the signed-in account. The token is single use; an identity linked to
 * another account → 409 `identity.taken`.
 */
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
  constructor(
    @Inject(ExternalIdentities) private readonly external: ExternalIdentities,
    @Inject(LinkedAccountsService) private readonly linked: LinkedAccountsService,
  ) {}

  /**
   * The person's identities with their IM and sign-in capabilities, and the enabled login methods
   * they can still link (the linked accounts page).
   */
  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ identities: LinkedAccountRow[]; linkable: LinkableMethod[] }> {
    const p = requireUser(principal);
    return this.linked.list(p.account.id);
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
