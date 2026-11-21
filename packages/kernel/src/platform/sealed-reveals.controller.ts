import { Controller, HttpCode, Inject, Post } from "@nestjs/common";
import type { z } from "zod";
import { RevealCallParams } from "../identity/initial-passwords.controller.js";
import {
  CurrentPrincipal,
  type Principal,
  requireUser,
  SessionOnly,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZParam } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { SealedReveals } from "./sealed-reveals.js";

class RevealCallParamsDto extends createZodDto(RevealCallParams, "InvitationLinkParams") {}

/**
 * The link of an invitation an org admin's agent created (platform web parity spec §7.2): shown
 * once, on the web, to the person the `orgs.invite` call was made for, keyed by the call (plan
 * ruling R6). A POST because reading consumes it.
 */
@Controller(
  "api/v1/orgs/:orgId/conversations/:conversationId/runs/:runId/calls/:callId/invitation-link",
)
export class SealedRevealsController {
  constructor(@Inject(SealedReveals) private readonly reveals: SealedReveals) {}

  @Post()
  @HttpCode(200)
  @OrgAction("org.invitations.manage")
  @SessionOnly()
  async reveal(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(RevealCallParamsDto) params: z.infer<typeof RevealCallParams>,
  ): Promise<{ url: string }> {
    const p = requireUser(principal);
    const { conversationId, runId, callId } = params;
    return this.reveals.reveal(org.orgId, { conversationId, runId, callId }, p.account.id);
  }
}
