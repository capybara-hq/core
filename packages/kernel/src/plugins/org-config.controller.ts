import { Body, Controller, Get, Inject, Param, Put } from "@nestjs/common";
import { z } from "zod";
import { ORG_PLUGIN_CONFIGS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type { OrgPluginConfigs, OrgPluginView } from "./org-config.js";

const PutBody = z
  .object({
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    force: z.boolean().optional(),
  })
  .strict();

/** 组织级插件启用与配置（`/api/v1/orgs/:orgId/plugins`）；响应只回显非密钥配置与密钥是否已设置。 */
@Controller("api/v1/orgs/:orgId/plugins")
export class OrgPluginConfigsController {
  constructor(@Inject(ORG_PLUGIN_CONFIGS) private readonly configs: OrgPluginConfigs) {}

  @Get()
  @OrgAction("org.plugins.manage")
  async list(@CurrentOrg() org: OrgContext): Promise<{ plugins: OrgPluginView[] }> {
    return { plugins: await this.configs.list(org.orgId) };
  }

  @Put(":plugin")
  @OrgAction("org.plugins.manage")
  async put(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("plugin") plugin: string,
    @Body(new ZodPipe(PutBody)) body: z.infer<typeof PutBody>,
  ): Promise<{ plugin: OrgPluginView }> {
    const p = requireUser(principal);
    return {
      plugin: await this.configs.put(org.orgId, plugin, body, p.account.id, patTokenId(p)),
    };
  }
}
