import { Controller, HttpCode, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZParam } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { InitialPasswords } from "./initial-passwords.js";
import {
  CurrentPrincipal,
  type Principal,
  requireUser,
  SessionOnly,
  SuperAdmin,
} from "./principal.js";

const ApprovalParams = z.object({ approvalId: z.string().min(1).max(100) });
class ApprovalParamsDto extends createZodDto(ApprovalParams, "InitialPasswordParams") {}

/**
 * The generated initial password of an account the super admin's agent created (Platform tool
 * spec §14.5 item 2): shown once, on the web, to the person who approved the `accounts.create`
 * call. A POST because reading consumes it.
 */
@Controller("api/v1/orgs/:orgId/approvals/:approvalId/initial-password")
export class InitialPasswordsController {
  constructor(@Inject(InitialPasswords) private readonly passwords: InitialPasswords) {}

  @Post()
  @HttpCode(200)
  @OrgAction("org.read")
  @SuperAdmin()
  @SessionOnly()
  async reveal(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ApprovalParamsDto) params: z.infer<typeof ApprovalParams>,
  ): Promise<{ accountId: string; login: string | null; password: string }> {
    const p = requireUser(principal);
    return this.passwords.reveal(org.orgId, params.approvalId, p.account.id);
  }
}
