import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { z } from "zod";
import { CHANNEL_CONNECTIONS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type { JsonSchema } from "../plugins/config-json-schema.js";
import type { ChannelConnections, ChannelConnectionView } from "./connections.service.js";

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
    config: Config.optional(),
  })
  .strict();

/**
 * 组织的渠道连接（`/api/v1/orgs/:orgId/channels`），全部需要 `channels.manage`（admin，仅限人）。
 * 响应只回显非密钥配置与密钥是否已设置。
 */
@Controller("api/v1/orgs/:orgId/channels")
export class ChannelConnectionsController {
  constructor(@Inject(CHANNEL_CONNECTIONS) private readonly channels: ChannelConnections) {}

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
    @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>,
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
    @Body(new ZodPipe(PatchBody)) body: z.infer<typeof PatchBody>,
  ): Promise<{ channel: ChannelConnectionView }> {
    const p = requireUser(principal);
    return {
      channel: await this.channels.update(org.orgId, id, body, p.account.id, patTokenId(p)),
    };
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
