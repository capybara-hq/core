import { apiFetch } from "./api";
import type { LocalizedName } from "./catalog";
import { extensionLabel } from "./extension-label";
import type { JsonSchema } from "./json-schema";
import type { SetupGuideRef } from "./setup-guides";

/** 渠道连接的状态（`error`：长连接最近一次失败，见 `lastError`）。 */
export type ChannelStatus = "active" | "disabled" | "error";
/** 认不出发言人时：`bind` 发绑定提示；`anonymous` 以匿名访客对话（只能用全组织可见的 agent）。 */
export type UnboundPolicy = "bind" | "anonymous";
/** How the bot receives messages: a long connection (default) or platform webhooks. */
export type InboundMode = "long_connection" | "webhook";

/** 内核 `ChannelConnectionView`：`config` 只含非密钥字段，密钥只回显「是否已设置」。 */
export interface ChannelConnection {
  id: string;
  orgId: string;
  plugin: string;
  /** The plugin's display name; null when it has none (show the id). */
  pluginDisplayName?: LocalizedName | null;
  /**
   * The URL of its plugin's icon (the org's catalog icon route); null when the plugin has none or
   * the org may not see it: draw the initial.
   */
  pluginIcon?: string | null;
  name: string;
  agentId: string;
  unboundPolicy: UnboundPolicy;
  status: ChannelStatus;
  inboundMode: InboundMode;
  /** The plugin supports webhook inbound. */
  webhookSupported: boolean;
  /** Callback URL to register with the platform; null without plugin support or webhook base URL. */
  webhookUrl: string | null;
  lastError: string | null;
  botUserId: string | null;
  tenantId: string | null;
  config: Record<string, unknown>;
  secrets: { path: string; set: boolean }[];
  /** Its plugin's setup guide the org may see (the 接入指南 section); null without one. */
  setupGuide?: (SetupGuideRef & { version: string }) | null;
  /**
   * The plugin changed the guide's templates since the connection was set up: the versions (the
   * notice and 「我已更新应用」); null otherwise.
   */
  guideDrift?: { from: string; to: string } | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** The platform a connection reaches, for people: its plugin's display name, else the plugin id. */
export const channelPluginLabel = (
  c: Pick<ChannelConnection, "plugin" | "pluginDisplayName">,
  locale: "zh" | "en",
): string => extensionLabel({ name: c.plugin, displayName: c.pluginDisplayName ?? null }, locale);

export interface CreateChannelInput {
  plugin: string;
  name: string;
  agentId: string;
  config: Record<string, unknown>;
  unboundPolicy?: UnboundPolicy;
}

/** `config` 里的密钥字段：缺省 = 保留、`null` = 清除、字符串 = 新值。 */
export interface UpdateChannelInput {
  name?: string;
  agentId?: string;
  unboundPolicy?: UnboundPolicy;
  status?: "active" | "disabled";
  inboundMode?: InboundMode;
  config?: Record<string, unknown>;
}

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/channels`;
const one = (orgId: string, id: string) => `${base(orgId)}/${encodeURIComponent(id)}`;

export const listChannels = (orgId: string) =>
  apiFetch<{ channels: ChannelConnection[] }>(base(orgId));

export const getChannel = (orgId: string, id: string) =>
  apiFetch<{ channel: ChannelConnection }>(one(orgId, id));

/**
 * 插件的连接配置 JSON Schema（密钥字段带 `x-secret`），and where its setup guide is (`guide`, null
 * or absent without one).
 */
export const getChannelSchema = (orgId: string, plugin: string) =>
  apiFetch<{ plugin: string; schema: JsonSchema; guide?: SetupGuideRef | null }>(
    `${base(orgId)}/schema/${encodeURIComponent(plugin)}`,
  );

export const createChannel = (orgId: string, input: CreateChannelInput) =>
  apiFetch<{ channel: ChannelConnection }>(base(orgId), {
    method: "POST",
    body: JSON.stringify(input),
  });

export const updateChannel = (orgId: string, id: string, input: UpdateChannelInput) =>
  apiFetch<{ channel: ChannelConnection }>(one(orgId, id), {
    method: "PATCH",
    body: JSON.stringify(input),
  });

/** 「我已更新应用」: the template hash of the guide shown (409 `channel.guide_changed` when stale). */
export const ackChannelGuide = (orgId: string, id: string, hash: string) =>
  apiFetch<{ channel: ChannelConnection }>(`${one(orgId, id)}/guide-ack`, {
    method: "POST",
    body: JSON.stringify({ hash }),
  });

export const deleteChannel = (orgId: string, id: string) =>
  apiFetch<void>(one(orgId, id), { method: "DELETE" });
