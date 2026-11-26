import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  ChannelCreateSchema,
  ChannelGuideAckSchema,
  ChannelPatchSchema,
  ChannelPathParams,
  ChannelSchemaParams,
} from "../../channels/channels.schemas.js";
import {
  ChannelConnections,
  type ChannelConnectionView,
} from "../../channels/connections.service.js";
import { ApiError } from "../../errors.js";
import { PluginGuides } from "../../extensions/plugin-guides.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { defineOperation, type OperationContext } from "../operation.js";
import { personFieldParams, secretFieldsOf } from "../person-fields.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { nestedConfig, withPersonInputs } from "./person-inputs.js";
import { roleOf } from "./role.js";
import { named, orElse } from "./summary.js";

const PAGE = 50;

/** A process display setting as the confirmation summary names it; null is the default. */
const PROCESS_DISPLAY_LABELS = {
  zh: { detailed: "详细", brief: "简洁", off: "关闭", default: "默认" },
  en: { detailed: "Detailed", brief: "Brief", off: "Off", default: "Default" },
} as const;
const processLabel = (v: "detailed" | "brief" | "off" | null, lang: "zh" | "en") =>
  PROCESS_DISPLAY_LABELS[lang][v ?? "default"];

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
  processDisplay: c.processDisplay,
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
 * or remove it. Creating a connection takes the channel's secrets as person fields (the person types
 * them in a secure input request; platform web parity spec §4, §7.2); changing the credentials or
 * the config of a connection stays on the web.
 */
@Injectable()
export class ChannelsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(ChannelConnections) private readonly channels: ChannelConnections,
    @Inject(PluginGuides) private readonly guides: PluginGuides,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  /** The actor's org role (the guide reads and the ack take it), `forbidden` when not a member. */
  private async org(ctx: OperationContext) {
    const role = await roleOf(this.kdb.db, ctx.orgId, ctx.actorAccountId);
    if (role === null) throw new ApiError("forbidden", "Insufficient organization role");
    return { orgId: ctx.orgId, role };
  }

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
        id: "channels.schema",
        description:
          "Read the connection form of a channel plugin (org admins): schema is the JSON Schema of the connection config (secret fields carry x-secret; no values), guide names the plugin's setup guide for the org (null when it has none), inbound says whether webhook inbound is supported and available. Read it before channels.create to know the fields.",
        input: ChannelSchemaParams.strict(),
        example: { plugin: "lark" },
        authz: { orgAction: "channels.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/channels/schema/:plugin"],
        confirm: "read",
        errors: [
          {
            code: "extension.not_found",
            next: "The extension does not provide a channel; pick one that is installed (extensions.list).",
          },
        ],
        run: async (input, ctx) => {
          const schema = this.channels.jsonSchema(input.plugin);
          const inbound = this.channels.inboundInfo(input.plugin);
          const g = (await this.guides.channelGuides([input.plugin], await this.org(ctx))).get(
            input.plugin,
          );
          return {
            plugin: input.plugin,
            schema,
            guide: g ? { itemId: g.itemId, guideId: g.guideId } : null,
            inbound,
          };
        },
      }),
      defineOperation({
        id: "channels.create",
        description:
          "Create a channel connection (IM bot) in the org (org admins): plugin, name, the agent that answers (agentId) and values, the non-secret connection config (read the fields with channels.schema). Secret fields (app secrets, tokens) are never in values: list them in askPerson and the person types them in a secure input request (on the web); required secrets are asked even when not listed. The plugin verifies the credentials before anything is saved. Turn on webhook inbound with inboundMode webhook (only where supported). processDisplay sets how runs show their process in the chat (detailed, brief or off; omit for the default: detailed in direct chats, brief in groups). A setup guide, if any, is in channels.schema.",
        input: z
          .object({
            plugin: ChannelCreateSchema.shape.plugin,
            name: ChannelCreateSchema.shape.name,
            agentId: ChannelCreateSchema.shape.agentId,
            values: ChannelCreateSchema.shape.config,
            unboundPolicy: ChannelCreateSchema.shape.unboundPolicy,
            inboundMode: ChannelCreateSchema.shape.inboundMode,
            processDisplay: ChannelCreateSchema.shape.processDisplay,
            askPerson: personFieldParams.askPerson,
          })
          .strict(),
        example: {
          plugin: "lark",
          name: "Lark bot",
          agentId: "00000000-0000-4000-8000-000000000000",
          values: { appId: "cli_a1b2c3" },
          askPerson: ["appSecret"],
        },
        authz: { orgAction: "channels.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/channels"],
        renames: { values: "config" },
        extras: ["askPerson"],
        confirm: "org",
        errors: [
          {
            code: "extension.not_found",
            next: "The extension does not provide a channel; pick one that is installed (extensions.list).",
          },
          {
            code: "extension.not_enabled",
            next: "Switch the extension on in the org first (plugins.set-enabled).",
          },
          {
            code: "extension.config_invalid",
            next: "Read the form with channels.schema and correct values (the error's details name the fields); fields required in webhook mode come from inboundMode, secret ones are asked with askPerson.",
          },
          {
            code: "channel.verify_failed",
            next: "The plugin could not verify the credentials; the person re-enters them on a new call (check the non-secret values and the app on the IM platform).",
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
        precheck: (i, ctx) =>
          precheckBy(() =>
            this.channels.checkCreate(ctx.orgId, {
              plugin: i.plugin,
              agentId: i.agentId,
              inboundMode: i.inboundMode,
            }),
          ),
        personFields: async (i) => {
          const found = secretFieldsOf(this.channels.jsonSchema(i.plugin), new Set());
          // a secret the chosen inbound mode requires is asked even when not listed
          const modal = new Set(
            this.channels.modeRequiredFields(i.plugin, i.inboundMode ?? "long_connection"),
          );
          found.fields = found.fields.map((f) =>
            modal.has(f.path) ? { ...f, required: true } : f,
          );
          return {
            target: {
              zh: `渠道连接「${named(i.name)}」（${named(i.plugin)}）`,
              en: `Channel connection "${named(i.name)}" (${named(i.plugin)})`,
            },
            ...found,
          };
        },
        summary: (i, ctx) => {
          const ask = ctx.personAsk ?? i.askPerson;
          const keys = Object.keys(i.values).map(named);
          const zh = [
            `用插件 ${named(i.plugin)} 创建渠道连接「${named(i.name)}」，由智能体 ${named(i.agentId)} 应答`,
            keys.length > 0 && `设置 ${keys.join("、")}`,
            ask.length > 0 && `由本人填写 ${ask.map(named).join("、")}`,
            i.inboundMode === "webhook" && "入站方式：webhook",
            typeof i.processDisplay === "string" &&
              `过程显示：${processLabel(i.processDisplay, "zh")}`,
          ].filter((p): p is string => typeof p === "string");
          const en = [
            `Create channel connection "${named(i.name)}" with plugin ${named(i.plugin)}, answered by agent ${named(i.agentId)}`,
            keys.length > 0 && `sets ${keys.join(", ")}`,
            ask.length > 0 && `the person enters ${ask.map(named).join(", ")}`,
            i.inboundMode === "webhook" && "inbound mode: webhook",
            typeof i.processDisplay === "string" &&
              `process display: ${processLabel(i.processDisplay, "en")}`,
          ].filter((p): p is string => typeof p === "string");
          return { zh: zh.join("；"), en: en.join("; ") };
        },
        run: async (input, ctx) => {
          const r = await withPersonInputs("channels.create", ctx, (entered, detail) =>
            this.channels.create(
              ctx.orgId,
              {
                plugin: input.plugin,
                name: input.name,
                agentId: input.agentId,
                config: nestedConfig(input.values, entered, []),
                unboundPolicy: input.unboundPolicy,
                inboundMode: input.inboundMode,
                processDisplay: input.processDisplay,
              },
              ctx.actorAccountId,
              undefined,
              detail,
            ),
          );
          const webhook = input.inboundMode === "webhook";
          return {
            channel: detail(r),
            ...(webhook && {
              note:
                r.webhookUrl !== null
                  ? `Register the callback URL ${r.webhookUrl} in the IM platform's app settings (channels.get shows it again).`
                  : "The callback URL is not available yet: the super admin has to set channels.webhookBaseUrl; the channels page on the web then shows it.",
            }),
          };
        },
      }),
      defineOperation({
        id: "channels.guide-ack",
        description:
          "Record that the person updated the app on the IM platform to the plugin's current setup guide (org admins). The card states what the person confirms. hash is the guide's hash from setup.read for this connection (audience admin, the connection's inbound mode); a stale hash is refused before the card.",
        input: ChannelPathParams.extend(ChannelGuideAckSchema.shape).strict(),
        example: {
          connectionId: "00000000-0000-4000-8000-000000000000",
          hash: "0".repeat(64),
        },
        authz: { orgAction: "channels.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/channels/:connectionId/guide-ack"],
        confirm: "personal",
        // A human attestation: a remembered grant would let the agent confirm unseen guides.
        rememberable: false,
        errors: [
          {
            code: "channel.not_found",
            next: "Look the connection up with channels.list and pass its id.",
          },
          {
            code: "channel.guide_changed",
            next: "The plugin's setup guide changed since the hash was taken: read it again with setup.read (connectionId, audience admin, the connection's inbound mode), walk the person through it, then call again with the hash it returns.",
          },
          {
            code: "catalog.guide_not_found",
            next: "The plugin has no setup guide the org can see; there is nothing to acknowledge.",
          },
        ],
        precheck: async (i, ctx) => {
          let current: ChannelConnectionView | undefined;
          const r = await precheckBy(async () => {
            current = await this.channels.get(ctx.orgId, i.connectionId);
          });
          if (!r.ok || current === undefined) return r;
          // the service's own comparison, read before the card: a stale hash is never confirmed
          const ack = await this.guides.currentAck(current.plugin, "channel-connection", {
            mode: current.inboundMode,
            org: await this.org(ctx),
          });
          if (ack === null) {
            return {
              ok: false,
              code: "catalog.guide_not_found",
              message: "The plugin has no channel setup guide",
            };
          }
          return ack.hash === i.hash
            ? { ok: true }
            : {
                ok: false,
                code: "channel.guide_changed",
                message: "The plugin's setup guide changed since it was shown",
              };
        },
        summary: async (i, ctx) => {
          const name = await this.nameOf(ctx.orgId, i.connectionId);
          return {
            zh: `确认已按最新的设置指南更新第三方平台上渠道连接「${name}」对应的应用`,
            en: `Confirm that the app of channel connection "${name}" was updated on the IM platform to the current setup guide`,
          };
        },
        run: async (input, ctx) => ({
          channel: detail(
            await this.channels.ackGuide(
              await this.org(ctx),
              input.connectionId,
              input.hash,
              ctx.actorAccountId,
              undefined,
              viaAgent("channels.guide-ack", ctx),
            ),
          ),
        }),
      }),
      defineOperation({
        id: "channels.update",
        description:
          "Change a channel connection's binding (org admins): its name, the agent that answers (agentId), what happens to people not yet bound to an account (unboundPolicy: bind or anonymous), active or disabled, the inbound mode, and how runs show their process in the chat (processDisplay: detailed, brief or off; null for the default, detailed in direct chats and brief in groups). Give only what changes. Credentials and config are changed on the web.",
        input: ChannelPatchSchema.omit({ config: true })
          .extend(ChannelPathParams.shape)
          .strict()
          .refine(
            (i) =>
              i.name !== undefined ||
              i.agentId !== undefined ||
              i.unboundPolicy !== undefined ||
              i.status !== undefined ||
              i.inboundMode !== undefined ||
              i.processDisplay !== undefined,
            {
              message: "give name, agentId, unboundPolicy, status, inboundMode or processDisplay",
            },
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
          const pd = i.processDisplay;
          const zh = pd === undefined ? parts : [...parts, `过程显示 → ${processLabel(pd, "zh")}`];
          const en =
            pd === undefined ? parts : [...parts, `process display → ${processLabel(pd, "en")}`];
          return {
            zh: `修改渠道连接「${name}」：${zh.join("，")}`,
            en: `Update channel connection "${name}": ${en.join(", ")}`,
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
