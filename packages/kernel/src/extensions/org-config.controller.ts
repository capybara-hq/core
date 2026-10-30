import { Controller, Get, Inject, Param, Put } from "@nestjs/common";
import { z } from "zod";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { OrgExtensionConfigs, type OrgExtensionView } from "./org-config.js";

const PutBody = z
  .object({
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    force: z.boolean().optional(),
  })
  .strict();

class OrgExtensionPutBody extends createZodDto(PutBody, "OrgExtensionPutBody") {}

/**
 * Org-level extension enablement and config (`/api/v1/orgs/:orgId/extensions`); responses echo only
 * non-secret config and whether each secret is set.
 */
@Controller("api/v1/orgs/:orgId/extensions")
export class OrgExtensionConfigsController {
  constructor(@Inject(OrgExtensionConfigs) private readonly configs: OrgExtensionConfigs) {}

  @Get()
  @OrgAction("org.extensions.manage")
  async list(@CurrentOrg() org: OrgContext): Promise<{ extensions: OrgExtensionView[] }> {
    return { extensions: await this.configs.list(org.orgId) };
  }

  @Put(":extension")
  @OrgAction("org.extensions.manage")
  async put(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("extension") extension: string,
    @ZBody(OrgExtensionPutBody) body: z.infer<typeof PutBody>,
  ): Promise<{ extension: OrgExtensionView }> {
    const p = requireUser(principal);
    return {
      extension: await this.configs.put(org.orgId, extension, body, p.account.id, patTokenId(p)),
    };
  }
}
