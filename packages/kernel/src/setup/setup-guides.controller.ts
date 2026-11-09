import { Controller, Get, Inject } from "@nestjs/common";
import type { z } from "zod";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { SetupGuidesQuery } from "./setup-guides.schemas.js";
import { type SetupGuideListEntry, SetupGuidesService } from "./setup-guides.service.js";

class SetupGuidesQueryDto extends createZodDto(SetupGuidesQuery, "SetupGuidesQuery") {}

/**
 * The org's setup guides as the caller sees them (spec 2026-11-09-setup-guides-v2-design.md §12):
 * per guide its targets, their drift, a summary of the cached check states and the web page of
 * each. `catalog.read` here; which guides and targets a role sees is the service's (the guide
 * route's place and audience actions).
 */
@Controller("api/v1/orgs/:orgId/setup-guides")
export class SetupGuidesController {
  constructor(@Inject(SetupGuidesService) private readonly guides: SetupGuidesService) {}

  @Get()
  @OrgAction("catalog.read")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZQuery(SetupGuidesQueryDto) q: z.infer<typeof SetupGuidesQuery>,
  ): Promise<{ guides: SetupGuideListEntry[] }> {
    const p = requireUser(principal);
    return {
      guides: await this.guides.list(
        { orgId: org.orgId, role: org.role, accountId: p.account.id },
        q,
      ),
    };
  }
}
