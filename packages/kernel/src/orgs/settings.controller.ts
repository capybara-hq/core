import { Controller, Get, Inject, Patch } from "@nestjs/common";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "./org.guard.js";
import {
  type OrgEffectiveNetwork,
  type OrgSandboxLimits,
  type OrgSettingsDeployment,
  type OrgSettingsPatch,
  OrgSettingsPatchSchema,
  OrgSettingsService,
  type OrgSettingsView,
} from "./settings.service.js";

class OrgSettingsPatchBody extends createZodDto(OrgSettingsPatchSchema, "OrgSettingsPatch") {}

/**
 * 组织设置（`/api/v1/orgs/:orgId/settings`）：成员可读，修改需 `org.update`（admin）。
 * 响应带 `deployment`（部署默认值，如沙箱出站），设置页据此展示「跟随部署」时的实际取值；
 * 以及只读的 `sandboxLimits`（组织实际生效的沙箱 cpu / 内存与来源，超级管理员在部署设置里覆盖，C19）。
 */
type SettingsResponse = {
  /** `scheduledTasks.forbiddenToolsUnreadable: true` when the stored list cannot be read. */
  settings: OrgSettingsView;
  deployment: OrgSettingsDeployment;
  /** The org's effective sandbox-mode network (org egress ceiling spec §D4). */
  effectiveNetwork: OrgEffectiveNetwork;
  sandboxLimits: OrgSandboxLimits;
};

@Controller("api/v1/orgs/:orgId/settings")
export class OrgSettingsController {
  constructor(@Inject(OrgSettingsService) private readonly settings: OrgSettingsService) {}

  @Get()
  @OrgAction("org.read")
  async get(@CurrentOrg() org: OrgContext): Promise<SettingsResponse> {
    const settings = await this.settings.get(org.orgId);
    return {
      settings,
      deployment: await this.settings.deployment(),
      effectiveNetwork: this.settings.effectiveNetwork(settings),
      sandboxLimits: await this.settings.sandboxLimits(org.orgId),
    };
  }

  @Patch()
  @OrgAction("org.update")
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(OrgSettingsPatchBody) body: OrgSettingsPatch,
  ): Promise<SettingsResponse> {
    const p = requireUser(principal);
    // an API token may narrow auto mode and the cloud network, never widen them (auto mode spec §4.3)
    const settings = await this.settings.update(
      org.orgId,
      body,
      p.account.id,
      patTokenId(p),
      undefined,
      { onlyNarrows: patTokenId(p) !== undefined },
    );
    return {
      settings,
      deployment: await this.settings.deployment(),
      effectiveNetwork: this.settings.effectiveNetwork(settings),
      sandboxLimits: await this.settings.sandboxLimits(org.orgId),
    };
  }
}
