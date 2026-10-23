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
  type OrgSandboxLimits,
  type OrgSettings,
  type OrgSettingsDeployment,
  type OrgSettingsPatch,
  OrgSettingsPatchSchema,
  type OrgSettingsService,
} from "./settings.service.js";

/**
 * 组织设置（`/api/v1/orgs/:orgId/settings`）：成员可读，修改需 `org.update`（admin）。
 * 响应带 `deployment`（部署默认值，如沙箱出站），设置页据此展示「跟随部署」时的实际取值；
 * 以及只读的 `sandboxLimits`（组织实际生效的沙箱 cpu / 内存与来源，企业管理员在部署设置里覆盖，C19）。
 */
type SettingsResponse = {
  settings: OrgSettings;
  deployment: OrgSettingsDeployment;
  sandboxLimits: OrgSandboxLimits;
};

@Controller("api/v1/orgs/:orgId/settings")
export class OrgSettingsController {
  constructor(@Inject(ORG_SETTINGS) private readonly settings: OrgSettingsService) {}

  @Get()
  @OrgAction("org.read")
  async get(@CurrentOrg() org: OrgContext): Promise<SettingsResponse> {
    return {
      settings: await this.settings.get(org.orgId),
      deployment: this.settings.deployment(),
      sandboxLimits: await this.settings.sandboxLimits(org.orgId),
    };
  }

  @Patch()
  @OrgAction("org.update")
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Body(new ZodPipe(OrgSettingsPatchSchema)) body: OrgSettingsPatch,
  ): Promise<SettingsResponse> {
    const p = requireUser(principal);
    return {
      settings: await this.settings.update(org.orgId, body, p.account.id, patTokenId(p)),
      deployment: this.settings.deployment(),
      sandboxLimits: await this.settings.sandboxLimits(org.orgId),
    };
  }
}
