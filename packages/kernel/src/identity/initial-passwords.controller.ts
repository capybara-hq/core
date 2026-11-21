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

/** The tool call a once-shown value was made by. */
export const RevealCallParams = z.object({
  conversationId: z.string().min(1).max(100),
  runId: z.string().min(1).max(100),
  callId: z.string().min(1).max(200),
});
class RevealCallParamsDto extends createZodDto(RevealCallParams, "InitialPasswordParams") {}

/**
 * The generated initial password of an account the super admin's agent created (Platform tool
 * spec §14.5 item 2): shown once, on the web, to the person the `accounts.create` call was made
 * for, keyed by the call (plan ruling R6). A POST because reading consumes it.
 */
@Controller(
  "api/v1/orgs/:orgId/conversations/:conversationId/runs/:runId/calls/:callId/initial-password",
)
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
    @ZParam(RevealCallParamsDto) params: z.infer<typeof RevealCallParams>,
  ): Promise<{ accountId: string; login: string | null; password: string }> {
    const p = requireUser(principal);
    const { conversationId, runId, callId } = params;
    return this.passwords.reveal(org.orgId, { conversationId, runId, callId }, p.account.id);
  }
}
