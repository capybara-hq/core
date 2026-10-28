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
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { AccountsService } from "./accounts.js";
import { clientMeta } from "./auth.controller.js";
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
  ) {}

  @Get("sources")
  @Public()
  sources(): { sources: { plugin: string; label: { zh: string; en: string } }[] } {
    return { sources: this.flow.sources() };
  }

  /**
   * 发起登录：302 到身份源的授权地址，并写浏览器绑定 Cookie `cap_sso`（HttpOnly、SameSite=Lax——身份源回跳是
   * 跨站顶级 GET 导航，Lax 会带上；Path 只到 `/api/v1/auth/sso`）。已登录的用户同样可以发起（见 callback）。
   */
  @Get("sso/:plugin/start")
  @Public()
  async start(
    @Param("plugin") plugin: string,
    @Query("returnTo") returnTo: unknown,
    @CurrentPrincipal() principal: Principal | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const binding = ssoBrowserBinding(req.cookies[SSO_BINDING_COOKIE]);
    // 发起时的会话账号记进 state：回调时同一账号才升级经 IM 绑定的身份（见 callback）
    const location = await this.flow.start(
      plugin,
      typeof returnTo === "string" ? returnTo : undefined,
      binding,
      sessionAccount(principal),
    );
    reply.setCookie(SSO_BINDING_COOKIE, binding, {
      path: SSO_COOKIE_PATH,
      httpOnly: true,
      sameSite: "lax",
      secure: this.flow.cookieSecure(),
      maxAge: SSO_STATE_TTL_SECONDS,
    });
    await reply.header("cache-control", "no-store").redirect(location, 302);
  }

  /**
   * 身份源回跳：核对 state 与绑定 Cookie → 插件换取外部身份 → 解析到账号 → 建会话、写会话 Cookie → 302 回网页
   * （`http.publicUrl` + returnTo）。账号已停用 → 登录页 `auth.account_disabled`，不建会话。
   * 请求已带着 Web 会话时（已登录的用户发起，「登录状态下绑定」），把会话的账号交给 `SsoFlow.callback`：
   * 与发起时记下的会话账号相同，经 IM 绑定建立的同一账号的身份才由此升级为可登录（Ruling A18）。
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
    const r = await this.flow.callback(
      plugin,
      stringQuery(q),
      req.cookies[SSO_BINDING_COOKIE],
      sessionAccount(principal),
    );
    let location: string;
    if (!r.ok) {
      location = this.flow.loginError(r.error);
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
}

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
