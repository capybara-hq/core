import type { LocalizedName } from "@capybara-hq/plugin-sdk";
import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from "@nestjs/common";
import type { z } from "zod";
import type { JsonSchema } from "../extensions/config-json-schema.js";
import { ExtensionDisplayNames } from "../extensions/display-name.js";
import { orgIconScope, PluginIcons } from "../extensions/plugin-icons.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  ChannelCreateSchema as CreateBody,
  ChannelPatchSchema as PatchBody,
} from "./channels.schemas.js";
import { ChannelConnections, type ChannelConnectionView } from "./connections.service.js";

class ChannelCreateBody extends createZodDto(CreateBody, "ChannelCreateBody") {}
class ChannelPatchBody extends createZodDto(PatchBody, "ChannelPatchBody") {}

/**
 * A connection as the org's pages show it: its plugin's display name (null when it has none) and
 * the URL of its plugin's icon on the org's catalog route (null without one, or when the org may
 * not see the plugin's catalog item; maintainer decision 2026-11-08).
 */
export type ChannelConnectionPage = ChannelConnectionView & {
  pluginDisplayName: LocalizedName | null;
  pluginIcon: string | null;
};

/**
 * 组织的渠道连接（`/api/v1/orgs/:orgId/channels`），全部需要 `channels.manage`（admin，仅限人）。
 * 响应只回显非密钥配置与密钥是否已设置。
 */
@Controller("api/v1/orgs/:orgId/channels")
export class ChannelConnectionsController {
  constructor(
    @Inject(ChannelConnections) private readonly channels: ChannelConnections,
    @Inject(ExtensionDisplayNames) private readonly displayNames: ExtensionDisplayNames,
    @Inject(PluginIcons) private readonly icons: PluginIcons,
  ) {}

  /** The connections with their plugins' display names and icons (two batched reads). */
  private async withPlugins(
    org: OrgContext,
    views: ChannelConnectionView[],
  ): Promise<ChannelConnectionPage[]> {
    const plugins = views.map((v) => v.plugin);
    const [names, icons] = await Promise.all([
      this.displayNames.many(plugins),
      this.icons.many(plugins, orgIconScope(org)),
    ]);
    return views.map((v) => ({
      ...v,
      pluginDisplayName: names.get(v.plugin) ?? null,
      pluginIcon: icons.get(v.plugin) ?? null,
    }));
  }

  private async withPlugin(
    org: OrgContext,
    view: ChannelConnectionView,
  ): Promise<ChannelConnectionPage> {
    const [page] = await this.withPlugins(org, [view]);
    return page as ChannelConnectionPage;
  }

  @Get()
  @OrgAction("channels.manage")
  async list(@CurrentOrg() org: OrgContext): Promise<{ channels: ChannelConnectionPage[] }> {
    return { channels: await this.withPlugins(org, await this.channels.list(org.orgId)) };
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
  ): Promise<{ channel: ChannelConnectionPage }> {
    const p = requireUser(principal);
    return {
      channel: await this.withPlugin(
        org,
        await this.channels.create(org.orgId, body, p.account.id, patTokenId(p)),
      ),
    };
  }

  @Get(":connectionId")
  @OrgAction("channels.manage")
  async get(
    @CurrentOrg() org: OrgContext,
    @Param("connectionId") id: string,
  ): Promise<{ channel: ChannelConnectionPage }> {
    return { channel: await this.withPlugin(org, await this.channels.get(org.orgId, id)) };
  }

  @Patch(":connectionId")
  @OrgAction("channels.manage")
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("connectionId") id: string,
    @ZBody(ChannelPatchBody) body: z.infer<typeof PatchBody>,
  ): Promise<{ channel: ChannelConnectionPage; verifySkipped: boolean }> {
    const p = requireUser(principal);
    // verifySkipped: with the plugin off in the org, rotated credentials are not verified by the
    // plugin (it connects with them once it is on again)
    const r = await this.channels.update(org.orgId, id, body, p.account.id, patTokenId(p));
    return { ...r, channel: await this.withPlugin(org, r.channel) };
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
