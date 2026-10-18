import { Body, Controller, Get, Inject, Patch } from "@nestjs/common";
import { ORG_SETTINGS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "./org.guard.js";
import {
  type OrgSettings,
  type OrgSettingsPatch,
  OrgSettingsPatchSchema,
  type OrgSettingsService,
} from "./settings.service.js";

/** 组织设置（`/api/v1/orgs/:orgId/settings`）：成员可读，修改需 `org.update`（admin）。 */
@Controller("api/v1/orgs/:orgId/settings")
export class OrgSettingsController {
  constructor(@Inject(ORG_SETTINGS) private readonly settings: OrgSettingsService) {}

  @Get()
  @OrgAction("org.read")
  async get(@CurrentOrg() org: OrgContext): Promise<{ settings: OrgSettings }> {
    return { settings: await this.settings.get(org.orgId) };
  }

  @Patch()
  @OrgAction("org.update")
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Body(new ZodPipe(OrgSettingsPatchSchema)) body: OrgSettingsPatch,
  ): Promise<{ settings: OrgSettings }> {
    const p = requireUser(principal);
    return {
      settings: await this.settings.update(org.orgId, body, p.account.id, patTokenId(p)),
    };
  }
}
