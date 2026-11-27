import { Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  CurrentPrincipal,
  type Principal,
  requireUser,
  SessionOnly,
} from "../identity/principal.js";
import { setSsoBindingCookie } from "../identity/sso.controller.js";
import { SSO_BINDING_COOKIE, SsoFlow } from "../identity/sso.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { OAUTH_BINDING_COOKIE } from "../tools/oauth/flow.js";
import { setOAuthBindingCookie } from "../tools/oauth/oauth.controller.js";
import {
  type HandoffRedeemBody,
  HandoffRedeemBodySchema,
  type HandoffRedeemResponse,
} from "./handoff.schemas.js";
import { HandoffService } from "./handoff.service.js";

class RedeemBody extends createZodDto(HandoffRedeemBodySchema, "HandoffRedeemBody") {}

/**
 * Browser handoffs (shell external authorization spec §2): the web page `/handoff/<ticket>`,
 * opened by a native shell in the system browser, redeems its ticket here.
 */
@Controller("api/v1/auth/handoffs")
export class HandoffController {
  constructor(
    @Inject(HandoffService) private readonly handoffs: HandoffService,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(SsoFlow) private readonly sso: SsoFlow,
  ) {}

  /**
   * Redeems a ticket in this signed-in browser (web session only, so the CSRF header of the global
   * guard applies): starts the ticket's OAuth connect or login-method link here, writes this
   * browser's binding cookie (`cap_oauth` / `cap_sso`, the same as the normal starts) and answers
   * where the browser goes next. Errors: `handoff.invalid`, `handoff.account_mismatch`, and for a
   * connector the start's own (`org.not_found`, `forbidden`, `connector.*`).
   */
  @Post("redeem")
  @SessionOnly()
  @HttpCode(200)
  async redeem(
    @CurrentPrincipal() principal: Principal,
    @ZBody(RedeemBody) body: HandoffRedeemBody,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<HandoffRedeemResponse> {
    const p = requireUser(principal);
    reply.header("cache-control", "no-store");
    const out = await this.handoffs.redeem(body.ticket, p, {
      oauth: req.cookies[OAUTH_BINDING_COOKIE],
      sso: req.cookies[SSO_BINDING_COOKIE],
    });
    if (out.binding.flow === "oauth") {
      setOAuthBindingCookie(reply, out.binding.value, this.config.get());
    } else {
      setSsoBindingCookie(reply, out.binding.value, this.sso.cookieSecure());
    }
    return { location: out.location };
  }
}
