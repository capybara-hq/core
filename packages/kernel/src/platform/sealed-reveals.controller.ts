import { Controller, HttpCode, Inject, Post } from "@nestjs/common";
import { z } from "zod";
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

const ApprovalParams = z.object({ approvalId: z.string().min(1).max(100) });
class ApprovalParamsDto extends createZodDto(ApprovalParams, "InvitationLinkParams") {}

/**
 * The link of an invitation an org admin's agent created (platform web parity spec §7.2): shown
 * once, on the web, to the person who approved the `orgs.invite` call. A POST because reading
 * consumes it.
 */
@Controller("api/v1/orgs/:orgId/approvals/:approvalId/invitation-link")
export class SealedRevealsController {
  constructor(@Inject(SealedReveals) private readonly reveals: SealedReveals) {}

  @Post()
  @HttpCode(200)
  @OrgAction("org.invitations.manage")
  @SessionOnly()
  async reveal(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ApprovalParamsDto) params: z.infer<typeof ApprovalParams>,
  ): Promise<{ url: string }> {
    const p = requireUser(principal);
    return this.reveals.reveal(org.orgId, params.approvalId, p.account.id);
  }
}
