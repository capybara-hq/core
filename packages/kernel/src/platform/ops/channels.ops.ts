import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { ChannelPatchSchema, ChannelPathParams } from "../../channels/channels.schemas.js";
import {
  ChannelConnections,
  type ChannelConnectionView,
} from "../../channels/connections.service.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { named, orElse } from "./summary.js";

const PAGE = 50;

/**
 * A connection as the tool shows it: the settings an admin sees on the channels page. The
 * non-secret config and whether each secret is set, never a secret value (the service view holds
 * none), plus the webhook callback URL (an address, not a secret).
 */
const detail = (c: ChannelConnectionView) => ({
  id: c.id,
  name: c.name,
  plugin: c.plugin,
  agentId: c.agentId,
  status: c.status,
  unboundPolicy: c.unboundPolicy,
  inboundMode: c.inboundMode,
  webhookSupported: c.webhookSupported,
  webhookUrl: c.webhookUrl,
  lastError: c.lastError,
  config: c.config,
  secrets: c.secrets,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

/**
 * Channel connection operations of the `Platform` tool (spec §14): read a connection and change
 * its binding (which agent answers, what happens to unbound people, on / off, inbound mode),
 * or remove it. Creating a connection and changing its credentials or config stay on the web:
 * they carry app secrets a person types (spec §6.4).
 */
@Injectable()
export class ChannelsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(ChannelConnections) private readonly channels: ChannelConnections,
  ) {}

  private async nameOf(orgId: string, id: string): Promise<string> {
    return orElse(async () => named((await this.channels.get(orgId, id)).name), id);
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "channels.list",
        description:
          "List the org's channel connections (IM bots), one compact row each: id, name, state (active or disabled), the last error, and the plugin, the agent that answers and the policy for unbound people. Never returns credentials. Pages by 50: pass the returned next as params.cursor. One connection's settings come from channels.get.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "channels.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/channels"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) =>
          pageOf(
            (await this.channels.list(ctx.orgId)).map((c) => ({
              id: c.id,
              name: c.name,
              state: c.status,
              ...(c.lastError !== null && { reason: c.lastError }),
              plugin: c.plugin,
              agentId: c.agentId,
              unboundPolicy: c.unboundPolicy,
            })),
            startOf(input.cursor),
            PAGE,
          ),
      }),
      defineOperation({
        id: "channels.get",
        description:
          "Read one channel connection: the agent that answers, the policy for unbound people, state, inbound mode, the last error, its non-secret config and which secrets are set. Credential values are never returned.",
        input: ChannelPathParams.strict(),
        example: { connectionId: "00000000-0000-4000-8000-000000000000" },
        authz: { orgAction: "channels.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/channels/:connectionId"],
        confirm: "read",
        errors: [
          {
            code: "channel.not_found",
            next: "Look the connection up with channels.list and pass its id.",
          },
        ],
        run: async (input, ctx) => ({
          channel: detail(await this.channels.get(ctx.orgId, input.connectionId)),
        }),
      }),
      defineOperation({
        id: "channels.update",
        description:
          "Change a channel connection's binding (org admins): its name, the agent that answers (agentId), what happens to people not yet bound to an account (unboundPolicy: bind or anonymous), active or disabled, and the inbound mode. Give only what changes. Credentials and config are changed on the web.",
        input: ChannelPatchSchema.omit({ config: true })
          .extend(ChannelPathParams.shape)
          .strict()
          .refine(
            (i) =>
              i.name !== undefined ||
              i.agentId !== undefined ||
              i.unboundPolicy !== undefined ||
              i.status !== undefined ||
              i.inboundMode !== undefined,
            { message: "give name, agentId, unboundPolicy, status or inboundMode" },
          ),
        example: { connectionId: "00000000-0000-4000-8000-000000000000", status: "disabled" },
        authz: { orgAction: "channels.manage" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/channels/:connectionId"],
        // the route's config carries app secrets: a person changes it on the web
        omits: ["config"],
        extras: [],
        confirm: "org",
        errors: [
          {
            code: "channel.not_found",
            next: "Look the connection up with channels.list and pass its id.",
          },
          {
            code: "agent.not_found",
            next: "Pick the agent with agents.list and pass its id as agentId.",
          },
          {
            code: "channel.webhook_unavailable",
            next: "The plugin or the deployment cannot receive webhooks; keep inboundMode long_connection, or ask the super admin to set channels.webhookBaseUrl.",
          },
        ],
        precheck: (i, ctx) => {
          const { connectionId, ...patch } = i;
          return precheckBy(() => this.channels.checkUpdate(ctx.orgId, connectionId, patch));
        },
        summary: async (i, ctx) => {
          const name = await this.nameOf(ctx.orgId, i.connectionId);
          const parts = [
            i.name !== undefined && `name → "${named(i.name)}"`,
            i.agentId !== undefined && `agent → ${named(i.agentId)}`,
            i.unboundPolicy !== undefined && `unbound people: ${i.unboundPolicy}`,
            i.status !== undefined && `status → ${i.status}`,
            i.inboundMode !== undefined && `inbound mode → ${i.inboundMode}`,
          ].filter((p): p is string => typeof p === "string");
          return {
            zh: `修改渠道连接「${name}」：${parts.join("，")}`,
            en: `Update channel connection "${name}": ${parts.join(", ")}`,
          };
        },
        run: async (input, ctx) => {
          const { connectionId, ...patch } = input;
          const r = await this.channels.update(
            ctx.orgId,
            connectionId,
            patch,
            ctx.actorAccountId,
            undefined,
            viaAgent("channels.update", ctx),
          );
          const webhook = input.inboundMode === "webhook";
          return {
            channel: detail(r.channel),
            ...(webhook && {
              note:
                r.channel.webhookUrl !== null
                  ? `Register the callback URL ${r.channel.webhookUrl} in the IM platform's app settings (channels.get shows it again).`
                  : "The callback URL is not available yet: the super admin has to set channels.webhookBaseUrl; the channels page on the web then shows it.",
            }),
          };
        },
      }),
      defineOperation({
        id: "channels.delete",
        description:
          "Remove a channel connection (org admins): its credentials are deleted and the bot stops answering; people have to set it up again on the web to bring it back.",
        input: ChannelPathParams.strict(),
        example: { connectionId: "00000000-0000-4000-8000-000000000000" },
        authz: { orgAction: "channels.manage" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/channels/:connectionId"],
        confirm: "org",
        errors: [
          {
            code: "channel.not_found",
            next: "Look the connection up with channels.list and pass its id.",
          },
        ],
        precheck: (i, ctx) => precheckBy(() => this.channels.get(ctx.orgId, i.connectionId)),
        summary: async (i, ctx) => {
          const name = await this.nameOf(ctx.orgId, i.connectionId);
          return {
            zh: `删除渠道连接「${name}」（凭据一并删除，机器人停止应答）`,
            en: `Delete channel connection "${name}" (its credentials are deleted and the bot stops answering)`,
          };
        },
        run: async (input, ctx) => {
          await this.channels.remove(
            ctx.orgId,
            input.connectionId,
            ctx.actorAccountId,
            undefined,
            viaAgent("channels.delete", ctx),
          );
          return { deleted: input.connectionId };
        },
      }),
    ]);
  }
}
