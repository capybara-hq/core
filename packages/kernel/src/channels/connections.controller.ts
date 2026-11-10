import type { LocalizedName } from "@capybara-hq/plugin-sdk";
import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from "@nestjs/common";
import type { z } from "zod";
import type { JsonSchema } from "../extensions/config-json-schema.js";
import { ExtensionDisplayNames } from "../extensions/display-name.js";
import {
  type ConnectionGuideState,
  PluginGuides,
  type SetupGuideRef,
} from "../extensions/plugin-guides.js";
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
  ChannelGuideAckSchema as GuideAckBody,
  ChannelPatchSchema as PatchBody,
} from "./channels.schemas.js";
import {
  ChannelConnections,
  type ChannelConnectionView,
  type ChannelInboundInfo,
} from "./connections.service.js";

class ChannelCreateBody extends createZodDto(CreateBody, "ChannelCreateBody") {}
class ChannelPatchBody extends createZodDto(PatchBody, "ChannelPatchBody") {}
class ChannelGuideAckBody extends createZodDto(GuideAckBody, "ChannelGuideAckBody") {}

/**
 * A connection as the org's pages show it: its plugin's display name (null when it has none) and
 * the URL of its plugin's icon on the org's catalog route (null without one, or when the org may
 * not see the plugin's catalog item; maintainer decision 2026-11-08), and its plugin's setup guide
 * with the drift since the connection was set up (`setupGuide`, `guideDrift`; spec
 * 2026-11-09-setup-guides-v2-design.md §11).
 */
export type ChannelConnectionPage = ChannelConnectionView &
  ConnectionGuideState & {
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
    @Inject(PluginGuides) private readonly guides: PluginGuides,
  ) {}

  /** The connections with their plugins' display names, icons and guides (batched reads). */
  private async withPlugins(
    org: OrgContext,
    views: ChannelConnectionView[],
  ): Promise<ChannelConnectionPage[]> {
    const plugins = views.map((v) => v.plugin);
    const [names, icons, guides] = await Promise.all([
      this.displayNames.many(plugins),
      this.icons.many(plugins, orgIconScope(org)),
      this.guides.connectionStates(views, org),
    ]);
    return views.map((v) => ({
      ...v,
      pluginDisplayName: names.get(v.plugin) ?? null,
      pluginIcon: icons.get(v.plugin) ?? null,
      setupGuide: guides.get(v.id)?.setupGuide ?? null,
      guideDrift: guides.get(v.id)?.guideDrift ?? null,
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

  /**
   * The connection form's JSON Schema, where the plugin's setup guide is (`guide`, null when the
   * plugin has none the org may see): 新建渠道 shows it once the plugin is picked; and whether its
   * connections can use webhook inbound (`inbound`, channel inbound mode fields spec §4).
   */
  @Get("schema/:plugin")
  @OrgAction("channels.manage")
  async schema(
    @CurrentOrg() org: OrgContext,
    @Param("plugin") plugin: string,
  ): Promise<{
    plugin: string;
    schema: JsonSchema;
    guide: Omit<SetupGuideRef, "version"> | null;
    inbound: ChannelInboundInfo;
  }> {
    const schema = this.channels.jsonSchema(plugin);
    const inbound = this.channels.inboundInfo(plugin);
    const g = (await this.guides.channelGuides([plugin], org)).get(plugin);
    return { plugin, schema, guide: g ? { itemId: g.itemId, guideId: g.guideId } : null, inbound };
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

  /**
   * 「我已更新应用」: the person updated the platform app to the plugin's current setup guide
   * (`{ hash }` of the guide shown) -> 200 `{ channel }`; 409 `channel.guide_changed` when the guide
   * moved on since, 404 `catalog.guide_not_found` without a guide.
   */
  @Post(":connectionId/guide-ack")
  @HttpCode(200)
  @OrgAction("channels.manage")
  async ackGuide(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("connectionId") id: string,
    @ZBody(ChannelGuideAckBody) body: z.infer<typeof GuideAckBody>,
  ): Promise<{ channel: ChannelConnectionPage }> {
    const p = requireUser(principal);
    const view = await this.channels.ackGuide(
      { orgId: org.orgId, role: org.role },
      id,
      body.hash,
      p.account.id,
      patTokenId(p),
    );
    return { channel: await this.withPlugin(org, view) };
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
