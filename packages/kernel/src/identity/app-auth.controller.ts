import { Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { Throttled } from "../infra/throttler/throttler.guard.js";
import { ZBody } from "../infra/validation/zod-params.js";
import type { Account } from "./accounts.js";
import { AppAuthService } from "./app-auth.js";
import {
  type AppAuthorizeBody,
  AppAuthorizeBodyDto,
  type AppTokenBody,
  AppTokenBodyDto,
} from "./app-auth.schemas.js";
import { clientMeta } from "./auth.controller.js";
import { setSessionCookies } from "./cookies.js";
import { CurrentPrincipal, type Principal, Public, requireUser, SessionOnly } from "./principal.js";

/**
 * Native-app sign-in (`/api/v1/app-auth`, desktop client spec §6.5; RFC 8252 with PKCE):
 * - `POST /authorize` (web session only, CSRF header): the person's consent on the page
 *   `/apps/authorize` → `{ redirect }` with `code`, `state` and `iss`, or `error=access_denied`
 *   with `deny: true`; an unlisted redirect URI is `app_auth.redirect_uri_invalid`;
 * - `POST /token` (public, CSRF header, `app-auth-token-ip`): the app exchanges the code with
 *   its verifier → `{ account }` and the session cookies, or `app_auth.code_invalid`.
 */
@Controller("api/v1/app-auth")
export class AppAuthController {
  constructor(
    @Inject(AppAuthService) private readonly auth: AppAuthService,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
  ) {}

  @Post("authorize")
  @SessionOnly()
  @HttpCode(200)
  async authorize(
    @CurrentPrincipal() principal: Principal,
    @ZBody(AppAuthorizeBodyDto) body: AppAuthorizeBody,
  ): Promise<{ redirect: string }> {
    return this.auth.authorize(requireUser(principal), body);
  }

  @Post("token")
  @Public()
  @HttpCode(200)
  @Throttled("app-auth-token-ip")
  async token(
    @ZBody(AppTokenBodyDto) body: AppTokenBody,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ account: Account }> {
    const { account, session } = await this.auth.token(body, { ip: clientMeta(req).ip });
    setSessionCookies(reply, session, this.config.get());
    return { account };
  }
}
