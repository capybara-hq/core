import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { assertReturnSchemeAllowed } from "../../handoff/app-schemes.js";
import { HandoffTickets } from "../../handoff/handoff-tickets.js";
import { CurrentPrincipal, type Principal, Public, requireUser } from "../../identity/principal.js";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { createZodDto } from "../../infra/validation/create-zod-dto.js";
import { ZBody } from "../../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../../orgs/org.guard.js";
import {
  browserBinding,
  DEFAULT_RETURN_PATH,
  OAUTH_BINDING_COOKIE,
  OAUTH_CALLBACK_PATH,
  OAUTH_STATE_TTL_SECONDS,
  OAuthFlow,
} from "./flow.js";
import { OAuthConnectBodySchema, type OAuthConnectResponse } from "./oauth.schemas.js";

class OAuthConnectBody extends createZodDto(OAuthConnectBodySchema, "OAuthConnectBody") {}

/** 查询参数只取单值字符串（重复参数 / 数组按缺失处理）。 */
const one = (v: unknown): string | undefined =>
  typeof v === "string" && v.length <= 4096 ? v : undefined;

/**
 * Writes the OAuth browser binding cookie `cap_oauth` (HttpOnly, SameSite=Lax: the authorization
 * server's redirect back is a cross-site top-level GET, which Lax sends; Path only the callback).
 */
export function setOAuthBindingCookie(
  reply: FastifyReply,
  binding: string,
  config: { auth: { cookieSecure: boolean } },
): void {
  reply.setCookie(OAUTH_BINDING_COOKIE, binding, {
    path: OAUTH_CALLBACK_PATH,
    httpOnly: true,
    sameSite: "lax",
    secure: config.auth.cookieSecure,
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });
}

/**
 * Starts an OAuth connection (`POST /orgs/:orgId/connectors/:connectorId/connect`,
 * `connectors.use`, user principals only): returns the authorization URL and writes the browser
 * binding cookie ({@link setOAuthBindingCookie}). With `handoff` (a native shell, shell external
 * authorization spec §1): the same checks, then a handoff ticket and its web page instead, with
 * no cookie and no OAuth state; the flow starts when the person redeems it in the system browser.
 */
@Controller("api/v1/orgs/:orgId/connectors")
export class OAuthConnectController {
  constructor(
    @Inject(OAuthFlow) private readonly flow: OAuthFlow,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(HandoffTickets) private readonly tickets: HandoffTickets,
  ) {}

  @Post(":connectorId/connect")
  @HttpCode(200)
  @OrgAction("connectors.use")
  async connect(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("connectorId") connectorId: string,
    @ZBody(OAuthConnectBody) body: z.infer<typeof OAuthConnectBodySchema>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OAuthConnectResponse> {
    const p = requireUser(principal);
    if (body.handoff !== undefined) {
      const returnScheme = body.handoff.returnScheme;
      assertReturnSchemeAllowed(this.config.get(), returnScheme);
      await this.flow.check(org.orgId, connectorId, p.account.id);
      const ticket = await this.tickets.create({
        kind: "connector",
        accountId: p.account.id,
        orgId: org.orgId,
        connectorId,
        returnTo: body.returnTo ?? DEFAULT_RETURN_PATH,
        ...(returnScheme !== undefined && { returnScheme }),
      });
      reply.header("cache-control", "no-store");
      return { handoffUrl: this.tickets.url(ticket) };
    }
    const binding = browserBinding(req.cookies[OAUTH_BINDING_COOKIE]);
    const out = await this.flow.start(org.orgId, connectorId, p.account.id, body.returnTo, binding);
    setOAuthBindingCookie(reply, binding, this.config.get());
    return out;
  }
}

/**
 * 授权服务器的回跳（`GET /api/v1/oauth/callback`，公开路由：浏览器从授权服务器跳回来，会话 Cookie 可能已过期；
 * 身份由 state 与浏览器绑定 Cookie 确定）。总是 302 回网页，结果放在 `connected` / `oauth_error` 参数里。
 */
@Controller("api/v1/oauth")
export class OAuthCallbackController {
  constructor(@Inject(OAuthFlow) private readonly flow: OAuthFlow) {}

  @Get("callback")
  @Public()
  async callback(
    @Query() q: Record<string, unknown>,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const location = await this.flow.callback(
      { code: one(q.code), state: one(q.state), error: one(q.error), iss: one(q.iss) },
      req.cookies[OAUTH_BINDING_COOKIE],
    );
    await reply.header("cache-control", "no-store").redirect(location, 302);
  }
}
