import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import type { JsonSchema } from "../extensions/config-json-schema.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { ChannelConnections, type ChannelConnectionView } from "./connections.service.js";

const Config = z.record(z.string().max(200), z.unknown());
const Policy = z.enum(["bind", "anonymous"]);

const CreateBody = z
  .object({
    plugin: z.string().min(1).max(214),
    name: z.string().trim().min(1).max(100),
    agentId: z.string().min(1).max(100),
    config: Config,
    unboundPolicy: Policy.optional(),
  })
  .strict();

const PatchBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    agentId: z.string().min(1).max(100).optional(),
    unboundPolicy: Policy.optional(),
    status: z.enum(["active", "disabled"]).optional(),
    // webhook needs plugin support and channels.webhookBaseUrl (409 channel.webhook_unavailable)
    inboundMode: z.enum(["long_connection", "webhook"]).optional(),
    config: Config.optional(),
  })
  .strict();

class ChannelCreateBody extends createZodDto(CreateBody, "ChannelCreateBody") {}
class ChannelPatchBody extends createZodDto(PatchBody, "ChannelPatchBody") {}

/**
 * 组织的渠道连接（`/api/v1/orgs/:orgId/channels`），全部需要 `channels.manage`（admin，仅限人）。
 * 响应只回显非密钥配置与密钥是否已设置。
 */
@Controller("api/v1/orgs/:orgId/channels")
export class ChannelConnectionsController {
  constructor(@Inject(ChannelConnections) private readonly channels: ChannelConnections) {}

  @Get()
  @OrgAction("channels.manage")
  async list(@CurrentOrg() org: OrgContext): Promise<{ channels: ChannelConnectionView[] }> {
    return { channels: await this.channels.list(org.orgId) };
  }

  @Get("schema/:plugin")
  @OrgAction("channels.manage")
  schema(@Param("plugin") plugin: string): { plugin: string; schema: JsonSchema } {
    return { plugin, schema: this.channels.jsonSchema(plugin) };
  }

  @Post()
  @OrgAction("channels.manage")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(ChannelCreateBody) body: z.infer<typeof CreateBody>,
  ): Promise<{ channel: ChannelConnectionView }> {
    const p = requireUser(principal);
    return {
      channel: await this.channels.create(org.orgId, body, p.account.id, patTokenId(p)),
    };
  }

  @Get(":connectionId")
  @OrgAction("channels.manage")
  async get(
    @CurrentOrg() org: OrgContext,
    @Param("connectionId") id: string,
  ): Promise<{ channel: ChannelConnectionView }> {
    return { channel: await this.channels.get(org.orgId, id) };
  }

  @Patch(":connectionId")
  @OrgAction("channels.manage")
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("connectionId") id: string,
    @ZBody(ChannelPatchBody) body: z.infer<typeof PatchBody>,
  ): Promise<{ channel: ChannelConnectionView; verifySkipped: boolean }> {
    const p = requireUser(principal);
    // verifySkipped：插件在该组织停用时轮换凭据不调用插件校验（重新启用后按新凭据连接）
    return this.channels.update(org.orgId, id, body, p.account.id, patTokenId(p));
  }

  @Delete(":connectionId")
  @HttpCode(204)
  @OrgAction("channels.manage")
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("connectionId") id: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.channels.remove(org.orgId, id, p.account.id, patTokenId(p));
  }
}
