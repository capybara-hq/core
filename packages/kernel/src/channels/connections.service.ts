import { randomUUID } from "node:crypto";
import {
  CHANNEL_EXTENSION_POINT,
  type Channel,
  type ChannelTarget,
  type ExtensionContext,
  type Logger,
  type OutboundMessage,
} from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import { sql } from "kysely";
import type { z } from "zod";
import { configFields, getPath, secretValues } from "../config/fields.js";
import type { KernelConfig } from "../config/schema.js";
import { queryEnabledPlugins } from "../ctx/create-ctx.js";
import { createSecrets, type Keyring } from "../ctx/secrets.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { configToJsonSchema, type JsonSchema } from "../extensions/config-json-schema.js";
import type { ExtensionHost } from "../extensions/host.js";
import type { InflightTracker } from "../extensions/inflight.js";
import { toIssues } from "../extensions/org-config.js";
import { audit } from "../identity/audit.js";
import { createRedactor } from "../log.js";
import { lockOrgAndAuthorize } from "../orgs/org-lock.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import { adaptToFeatures } from "./features.js";
import { webhookBase, webhookUrlOf } from "./webhook-url.js";

/** 内核 secrets 命名空间（插件名不能取 `kernel`）。 */
const SECRETS_NAMESPACE = "kernel";
/** 连接配置里全部密钥字段存成一行：`{ 点路径: 值 }` 的 JSON。 */
export const connectionSecretKey = (connectionId: string) => `channels:${connectionId}:config`;

/**
 * 连接被改动的内核 bus 主题，payload `{ connectionId, reconnect }`：`reconnect` 为 true（启停、删除、轮换凭据）时
 * 持有长连接的副本断开、交还租约；改名 / agent / 未绑定策略不需要重连（入站每条消息都实时读连接行）。
 */
export const CHANNEL_CHANGED_TOPIC = "channel.changed";

/** Redis：连接失败后的退避标记与连续失败次数（任一副本都据此决定何时重试）。 */
export const channelBackoffKey = (id: string) => `capk:channel-backoff:${id}`;
export const channelFailsKey = (id: string) => `capk:channel-fails:${id}`;

/** 调用插件 verify / send 的时限。 */
const PLUGIN_CALL_TIMEOUT_MS = 15_000;

export type UnboundPolicy = "bind" | "anonymous";
export type ChannelStatus = "active" | "disabled" | "error";
/** How inbound events arrive: a long connection held by a gateway replica (default), or webhooks. */
export type InboundMode = "long_connection" | "webhook";

/** 对外的连接视图：`config` 只含非密钥字段，密钥只回显「是否已设置」。 */
export interface ChannelConnectionView {
  id: string;
  orgId: string;
  plugin: string;
  name: string;
  agentId: string;
  unboundPolicy: UnboundPolicy;
  status: ChannelStatus;
  inboundMode: InboundMode;
  /** The plugin implements `Channel.webhook`, so the connection can switch to webhook mode. */
  webhookSupported: boolean;
  /**
   * The callback URL to register with the platform (`<channels.webhookBaseUrl>/channels/webhook/<id>`);
   * null when the plugin has no webhook support or `channels.webhookBaseUrl` is not configured.
   */
  webhookUrl: string | null;
  lastError: string | null;
  botUserId: string | null;
  tenantId: string | null;
  config: Record<string, unknown>;
  secrets: { path: string; set: boolean }[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** 运行时用到的连接行。 */
export interface ChannelConnectionRow {
  id: string;
  orgId: string;
  plugin: string;
  agentId: string;
  unboundPolicy: UnboundPolicy;
  status: ChannelStatus;
  inboundMode: InboundMode;
  tenantId: string | null;
  /** 插件此刻在该组织启用。 */
  pluginEnabled: boolean;
}

export interface CreateChannelInput {
  plugin: string;
  name: string;
  agentId: string;
  config: Record<string, unknown>;
  unboundPolicy?: UnboundPolicy | undefined;
}

/** `config` 里的密钥字段：缺省 = 保留原值、`null` = 清除、其他值 = 新值（同组织插件配置）。 */
export interface UpdateChannelInput {
  name?: string | undefined;
  agentId?: string | undefined;
  unboundPolicy?: UnboundPolicy | undefined;
  status?: "active" | "disabled" | undefined;
  inboundMode?: InboundMode | undefined;
  config?: Record<string, unknown> | undefined;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function setDeep(obj: Obj, path: string, value: unknown): void {
  const segs = path.split(".");
  let node: Obj = obj;
  for (const seg of segs.slice(0, -1)) {
    if (node[seg] === undefined) node[seg] = {};
    else if (!isObj(node[seg])) return;
    node = node[seg] as Obj;
  }
  node[segs[segs.length - 1] as string] = value;
}

function deleteDeep(obj: Obj, path: string): void {
  const segs = path.split(".");
  let node: unknown = obj;
  for (const seg of segs.slice(0, -1)) {
    if (!isObj(node)) return;
    node = node[seg];
  }
  if (isObj(node)) delete node[segs[segs.length - 1] as string];
}

const secretPaths = (schema: z.ZodTypeAny): string[] =>
  configFields(schema)
    .filter((f) => f.meta?.secret)
    .map((f) => f.path);

/** 已校验的完整配置拆成「非密钥部分」与「密钥 `{ 路径: 值 }`」。 */
function split(schema: z.ZodTypeAny, full: Obj): { plain: Obj; secrets: Obj } {
  const plain = structuredClone(full);
  const secrets: Obj = {};
  for (const p of secretPaths(schema)) {
    const v = getPath(full, p);
    if (v !== undefined) secrets[p] = v;
    deleteDeep(plain, p);
  }
  return { plain, secrets };
}

const notFound = () => new ApiError("channel.not_found", "Channel connection not found");

const COLUMNS = [
  "id",
  "org_id",
  "plugin",
  "name",
  "agent_id",
  "config",
  "unbound_policy",
  "status",
  "inbound_mode",
  "last_error",
  "bot_user_id",
  "tenant_id",
  "created_by",
  "created_at",
  "updated_at",
] as const;

export interface ChannelConnectionsDeps {
  db: KernelDb;
  keyring: Keyring;
  host: Pick<ExtensionHost, "list">;
  bus: ExtensionContext["bus"];
  redis: Redis;
  log: Pick<Logger, "warn">;
  /** 连接重新可投递（轮换凭据 / 重新启用）后调用；内核传出站的 `resumeConnection`（补投落下的会话）。 */
  onResume?: (connectionId: string) => Promise<void>;
  /** 经手（写入或解密读出）的密钥值；内核传 `log.addOrgSecrets` 使其在日志中打码。 */
  onSecrets?: (values: string[]) => void;
  /** Current config (`channels.webhookBaseUrl`); without it webhook mode is unavailable. */
  config?: () => Pick<KernelConfig, "channels" | "tools">;
}

/**
 * 组织的渠道连接（spec：渠道连接属于组织，bot 凭据 + 绑定的 agent）。框架无关。
 * 非密钥配置存 `channel_connections.config`；密钥字段整体加密存 `capybara.secrets`
 * （命名空间 `kernel`，键 `channels:<id>:config`）。写操作在组织行锁内实时复核 `channels.manage`，写审计；
 * 改动提交后经内核 bus 广播 `channel.changed`，持有该连接的副本据此断开（下一轮扫描按新配置重连）。
 */
export class ChannelConnections {
  constructor(private readonly deps: ChannelConnectionsDeps) {}

  /** The extension's `channel@1`; not loaded or not provided -> `extension.not_found`. */
  channel(plugin: string): Channel {
    return this.channelEntry(plugin).impl as Channel;
  }

  private channelEntry(plugin: string): ReturnType<ExtensionHost["list"]>[number] {
    const e = this.deps.host
      .list("channel")
      .find((x) => x.plugin === plugin && x.capability === CHANNEL_EXTENSION_POINT);
    if (!e)
      throw new ApiError("extension.not_found", `Extension ${plugin} does not provide a channel`);
    return e;
  }

  /** The extension is not enabled in this organization -> `extension.not_enabled`. */
  private async assertEnabled(orgId: string, plugin: string): Promise<void> {
    if (!(await queryEnabledPlugins(this.deps.db, orgId)).has(plugin)) {
      throw new ApiError(
        "extension.not_enabled",
        `Extension ${plugin} is not enabled for this organization`,
      );
    }
  }

  /** `connectionSchema` 的 JSON Schema（同组织插件配置的转换：密钥字段带 `x-secret`、不输出取值）。 */
  jsonSchema(plugin: string): JsonSchema {
    return configToJsonSchema(this.channel(plugin).connectionSchema);
  }

  private parse(plugin: string, schema: z.ZodTypeAny, config: unknown): Obj {
    const r = schema.safeParse(config);
    if (!r.success) {
      throw new ApiError(
        "extension.config_invalid",
        `Invalid channel connection config for extension ${plugin}`,
        toIssues(r.error),
      );
    }
    return r.data as Obj;
  }

  private async verify(
    channel: Channel,
    config: unknown,
  ): Promise<{ botUserId: string; tenantId: string }> {
    try {
      const r = await channel.verify({
        config,
        signal: AbortSignal.timeout(PLUGIN_CALL_TIMEOUT_MS),
      });
      return { botUserId: r.botUserId, tenantId: r.tenantId };
    } catch {
      // 插件异常信息可能带上凭据，不回显
      throw new ApiError(
        "channel.verify_failed",
        "The channel rejected the connection credentials",
      );
    }
  }

  private reportSecrets(schema: z.ZodTypeAny, config: unknown): void {
    const values = secretValues(schema, config);
    if (values.length > 0) this.deps.onSecrets?.(values);
  }

  private async assertAgent(
    t: Pick<KernelDb, "selectFrom">,
    orgId: string,
    agentId: string,
  ): Promise<void> {
    const a = await t
      .selectFrom("agents")
      .select("id")
      .where("id", "=", agentId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!a) throw new ApiError("agent.not_found", "Agent not found");
  }

  private async readSecrets(orgId: string, id: string): Promise<Obj> {
    const raw = await createSecrets(this.deps.db, this.deps.keyring, SECRETS_NAMESPACE).get(
      orgId,
      connectionSecretKey(id),
    );
    return raw === null ? {} : (JSON.parse(raw) as Obj);
  }

  private view(
    r: {
      id: string;
      org_id: string;
      plugin: string;
      name: string;
      agent_id: string;
      config: Obj;
      unbound_policy: UnboundPolicy;
      status: ChannelStatus;
      inbound_mode: InboundMode;
      last_error: string | null;
      bot_user_id: string | null;
      tenant_id: string | null;
      created_by: string;
      created_at: Date;
      updated_at: Date;
    },
    setPaths: Set<string>,
  ): ChannelConnectionView {
    let paths: string[] = [];
    let webhookSupported = false;
    try {
      const channel = this.channel(r.plugin);
      paths = secretPaths(channel.connectionSchema);
      webhookSupported = channel.webhook !== undefined;
    } catch {
      // 插件已卸载：只回显已存的密钥路径
      paths = [...setPaths];
    }
    const base = this.webhookBase();
    return {
      id: r.id,
      orgId: r.org_id,
      plugin: r.plugin,
      name: r.name,
      agentId: r.agent_id,
      unboundPolicy: r.unbound_policy,
      status: r.status,
      inboundMode: r.inbound_mode,
      webhookSupported,
      webhookUrl: webhookSupported && base !== undefined ? webhookUrlOf(base, r.id) : null,
      lastError: r.last_error,
      botUserId: r.bot_user_id,
      tenantId: r.tenant_id,
      config: r.config ?? {},
      secrets: paths.map((path) => ({ path, set: setPaths.has(path) })),
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private webhookBase(): string | undefined {
    const config = this.deps.config?.();
    return config === undefined ? undefined : webhookBase(config);
  }

  /**
   * Switching to webhook mode needs a plugin that implements `Channel.webhook` and a configured
   * `channels.webhookBaseUrl` (otherwise there is no URL to give the platform): 409 otherwise.
   */
  private assertWebhookAvailable(plugin: string): void {
    if (this.channel(plugin).webhook === undefined) {
      throw new ApiError(
        "channel.webhook_unavailable",
        `Extension ${plugin} does not support webhook inbound`,
      );
    }
    if (this.webhookBase() === undefined) {
      throw new ApiError(
        "channel.webhook_unavailable",
        "Webhook inbound needs channels.webhookBaseUrl to be configured",
      );
    }
  }

  private async viewOf(row: Parameters<ChannelConnections["view"]>[0]) {
    return this.view(row, new Set(Object.keys(await this.readSecrets(row.org_id, row.id))));
  }

  private live(orgId: string) {
    return this.deps.db
      .selectFrom("channel_connections")
      .select(COLUMNS)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null);
  }

  async list(orgId: string): Promise<ChannelConnectionView[]> {
    const rows = await this.live(orgId).orderBy("created_at").orderBy("id").execute();
    return Promise.all(rows.map((r) => this.viewOf(r)));
  }

  async get(orgId: string, id: string): Promise<ChannelConnectionView> {
    const row = await this.live(orgId).where("id", "=", id).executeTakeFirst();
    if (!row) throw notFound();
    return this.viewOf(row);
  }

  /** 新建：插件须提供 channel@1 且在该组织启用；配置按 `connectionSchema` 校验；先 `verify`，失败不落库。 */
  async create(
    orgId: string,
    input: CreateChannelInput,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<ChannelConnectionView> {
    const channel = this.channel(input.plugin);
    await this.assertEnabled(orgId, input.plugin);
    const schema = channel.connectionSchema;
    const full = this.parse(input.plugin, schema, input.config);
    await this.assertAgent(this.deps.db, orgId, input.agentId);
    const verified = await this.verify(channel, full);
    const id = randomUUID();
    const { plain, secrets } = split(schema, full);
    const row = await this.deps.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "channels.manage");
      await this.assertAgent(t, orgId, input.agentId);
      if (Object.keys(secrets).length > 0) {
        await createSecrets(t, this.deps.keyring, SECRETS_NAMESPACE).set(
          orgId,
          connectionSecretKey(id),
          JSON.stringify(secrets),
        );
      }
      const inserted = await t
        .insertInto("channel_connections")
        .values({
          id,
          org_id: orgId,
          plugin: input.plugin,
          name: input.name,
          agent_id: input.agentId,
          config: JSON.stringify(plain),
          unbound_policy: input.unboundPolicy ?? "bind",
          bot_user_id: verified.botUserId,
          tenant_id: verified.tenantId,
          created_by: actorAccountId,
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "channel.created",
        target: id,
        detail: { plugin: input.plugin, agentId: input.agentId },
      });
      return inserted;
    });
    this.reportSecrets(schema, full);
    await this.changed(id, false);
    return this.view(row, new Set(Object.keys(secrets)));
  }

  /**
   * 修改名称、agent、未绑定策略、启停，或轮换凭据（新配置同样先 `verify`，失败什么都不改）。
   * 插件在该组织停用时仍可轮换凭据，此时不 verify，返回 `verifySkipped: true`。
   */
  async update(
    orgId: string,
    id: string,
    patch: UpdateChannelInput,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<{ channel: ChannelConnectionView; verifySkipped: boolean }> {
    const current = await this.live(orgId).where("id", "=", id).executeTakeFirst();
    if (!current) throw notFound();
    let rotated: { schema: z.ZodTypeAny; full: Obj; plain: Obj; secrets: Obj } | undefined;
    let verified: { botUserId: string; tenantId: string } | undefined;
    let verifySkipped = false;
    if (patch.config !== undefined) {
      const channel = this.channel(current.plugin);
      // 插件在该组织停用时也允许轮换（泄露的密钥要能立刻换掉），但不调用插件 verify：重新启用后长连接按新凭据连接
      const enabled = (await queryEnabledPlugins(this.deps.db, orgId)).has(current.plugin);
      const schema = channel.connectionSchema;
      const before = await this.readSecrets(orgId, id);
      const next = structuredClone(patch.config);
      for (const p of secretPaths(schema)) {
        const v = getPath(patch.config, p);
        if (v === null) deleteDeep(next, p);
        else if (v === undefined && before[p] !== undefined) setDeep(next, p, before[p]);
      }
      const full = this.parse(current.plugin, schema, next);
      if (enabled) verified = await this.verify(channel, full);
      else verifySkipped = true;
      rotated = { schema, full, ...split(schema, full) };
    }
    const modeChanged =
      patch.inboundMode !== undefined && patch.inboundMode !== current.inbound_mode;
    if (modeChanged && patch.inboundMode === "webhook") this.assertWebhookAvailable(current.plugin);
    if (patch.agentId !== undefined) await this.assertAgent(this.deps.db, orgId, patch.agentId);
    const row = await this.deps.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "channels.manage");
      if (patch.agentId !== undefined) await this.assertAgent(t, orgId, patch.agentId);
      if (rotated) {
        const secrets = createSecrets(t, this.deps.keyring, SECRETS_NAMESPACE);
        if (Object.keys(rotated.secrets).length > 0) {
          await secrets.set(orgId, connectionSecretKey(id), JSON.stringify(rotated.secrets));
        } else {
          await secrets.delete(orgId, connectionSecretKey(id));
        }
      }
      const updated = await t
        .updateTable("channel_connections")
        .set({
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.agentId !== undefined && { agent_id: patch.agentId }),
          ...(patch.unboundPolicy !== undefined && { unbound_policy: patch.unboundPolicy }),
          ...(patch.status !== undefined && { status: patch.status }),
          ...(patch.inboundMode !== undefined && { inbound_mode: patch.inboundMode }),
          ...(rotated && { config: JSON.stringify(rotated.plain) }),
          // 跳过了 verify：机器人 id 与租户保留原值（重新启用后插件按新凭据连接，入站以连接行的租户判断外部人员）
          ...(verified && { bot_user_id: verified.botUserId, tenant_id: verified.tenantId }),
          ...((rotated || patch.status === "active") && { last_error: null }),
          updated_at: sql<Date>`now()`,
        })
        .where("id", "=", id)
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .returning(COLUMNS)
        .executeTakeFirst();
      if (!updated) throw notFound();
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "channel.updated",
        target: id,
        detail: {
          changed: [
            ...Object.keys(patch).filter(
              (k) => k !== "config" && patch[k as keyof UpdateChannelInput] !== undefined,
            ),
            ...(rotated ? ["config"] : []),
          ],
        },
      });
      return updated;
    });
    if (rotated) this.reportSecrets(rotated.schema, rotated.full);
    // New config, re-enabled or back to long connection: clear the backoff so the next scan connects
    if (
      rotated ||
      patch.status === "active" ||
      (modeChanged && patch.inboundMode === "long_connection")
    ) {
      await this.deps.redis
        .del(channelBackoffKey(id), channelFailsKey(id))
        .catch((err: unknown) => this.deps.log.warn("cannot clear channel backoff", { err }));
    }
    // A mode switch also reconnects: the holder drops the long connection when going to webhook (F9)
    await this.changed(id, rotated !== undefined || patch.status !== undefined || modeChanged);
    if ((rotated || patch.status === "active") && row.status === "active") {
      await this.deps
        .onResume?.(id)
        .catch((err: unknown) => this.deps.log.warn("cannot resume channel deliveries", { err }));
    }
    return { channel: await this.viewOf(row), verifySkipped };
  }

  /** 删除（软删除，同一事务删掉密钥）；持有长连接的副本收到广播后断开。 */
  async remove(
    orgId: string,
    id: string,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<void> {
    await this.deps.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "channels.manage");
      const r = await t
        .updateTable("channel_connections")
        .set({ deleted_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
        .where("id", "=", id)
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (r.numUpdatedRows === 0n) throw notFound();
      await createSecrets(t, this.deps.keyring, SECRETS_NAMESPACE).delete(
        orgId,
        connectionSecretKey(id),
      );
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "channel.deleted",
        target: id,
      });
    });
    await this.changed(id, true);
  }

  /** 提交后广播；失败只记日志（持有方每轮续租时也会复核连接状态）。 */
  private async changed(connectionId: string, reconnect: boolean): Promise<void> {
    try {
      await this.deps.bus.publish(CHANNEL_CHANGED_TOPIC, { connectionId, reconnect });
    } catch (err) {
      this.deps.log.warn("channel.changed publish failed", { connectionId, err });
    }
  }

  /**
   * 运行时读连接行：连接未删除且所属组织未删除（组织软删除后它的机器人什么都不做）；不存在返回 undefined。
   * `pluginEnabled` 为插件此刻是否在该组织启用（入站与卡片操作每次都实时复核）。
   */
  async row(id: string): Promise<ChannelConnectionRow | undefined> {
    const r = await this.deps.db
      .selectFrom("channel_connections as c")
      .innerJoin("orgs", "orgs.id", "c.org_id")
      .leftJoin("extension_org_configs as p", (j) =>
        j.onRef("p.plugin", "=", "c.plugin").onRef("p.org_id", "=", "c.org_id"),
      )
      .select([
        "c.id",
        "c.org_id",
        "c.plugin",
        "c.agent_id",
        "c.unbound_policy",
        "c.status",
        "c.inbound_mode",
        "c.tenant_id",
        "p.enabled",
      ])
      .where("c.id", "=", id)
      .where("c.deleted_at", "is", null)
      .where("orgs.deleted_at", "is", null)
      .executeTakeFirst();
    return (
      r && {
        id: r.id,
        orgId: r.org_id,
        plugin: r.plugin,
        agentId: r.agent_id,
        unboundPolicy: r.unbound_policy,
        status: r.status,
        inboundMode: r.inbound_mode,
        tenantId: r.tenant_id,
        pluginEnabled: r.enabled === true,
      }
    );
  }

  /**
   * 组织被删除 / 停用了某插件之后：给该组织（该插件）的每个连接广播 `channel.changed { reconnect: true }`，
   * 持有长连接的副本立即断开（扫描复核只是兜底）。只广播，失败只记日志。
   */
  async notifyOrgChanged(orgId: string, plugin?: string): Promise<void> {
    let q = this.deps.db
      .selectFrom("channel_connections")
      .select("id")
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null);
    if (plugin !== undefined) q = q.where("plugin", "=", plugin);
    let rows: { id: string }[];
    try {
      rows = await q.execute();
    } catch (err) {
      this.deps.log.warn("cannot list channel connections to notify", { orgId, err });
      return;
    }
    for (const r of rows) await this.changed(r.id, true);
  }

  /**
   * The extension implementation and full config a connection needs to run (decrypted secrets
   * included, validated against `connectionSchema`). Connection missing / deleted ->
   * `channel.not_found`; extension not loaded -> `extension.not_found`; not enabled in the org ->
   * `extension.not_enabled`; the stored config no longer satisfies the schema (after an extension
   * upgrade) -> `extension.config_invalid`. Never echoed into responses or logs.
   */
  async runtime(id: string): Promise<{
    row: ChannelConnectionRow;
    channel: Channel;
    config: unknown;
    /** The plugin instance's in-flight count (webhook calls enter it, so an upgrade drains them). */
    inflight?: InflightTracker;
  }> {
    const row = await this.row(id);
    if (!row) throw notFound();
    const entry = this.channelEntry(row.plugin);
    const channel = entry.impl as Channel;
    await this.assertEnabled(row.orgId, row.plugin);
    const stored = await this.deps.db
      .selectFrom("channel_connections")
      .select("config")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const full = structuredClone(stored.config ?? {});
    for (const [p, v] of Object.entries(await this.readSecrets(row.orgId, id))) setDeep(full, p, v);
    const config = this.parse(row.plugin, channel.connectionSchema, full);
    this.reportSecrets(channel.connectionSchema, config);
    return { row, channel, config, inflight: entry.inflight };
  }

  /**
   * 出站会话：解密一次连接配置，之后经插件发 / 改消息（每次调用 15s 超时）。目标与消息先按渠道的
   * `features` 调整（不支持卡片的退回为文本、不支持话题的去掉 threadId，Ruling A33，见 features.ts）。出站投递任务在一次任务内复用它；
   * `redact` 按该连接的密钥打码（插件异常信息写进 `last_error` 前使用）。
   */
  async outbound(connectionId: string): Promise<ChannelOutboundSession> {
    const { row, channel, config } = await this.runtime(connectionId);
    // 组织语言随每次发送 / 更新交给插件（Ruling A22）；本次会话内不变
    const { locale } = await readOrgSettings(this.deps.db, row.orgId);
    return {
      row,
      features: channel.features,
      redact: createRedactor(secretValues(channel.connectionSchema, config), 4),
      send: (target, message, idempotencyKey) =>
        channel.send({
          config,
          ...adaptToFeatures(channel.features, target, message, locale),
          signal: AbortSignal.timeout(PLUGIN_CALL_TIMEOUT_MS),
          locale,
          ...(idempotencyKey !== undefined && { idempotencyKey }),
        }),
      update: (target, messageId, message, idempotencyKey) =>
        channel.update({
          config,
          ...adaptToFeatures(channel.features, target, message, locale),
          messageId,
          signal: AbortSignal.timeout(PLUGIN_CALL_TIMEOUT_MS),
          locale,
          ...(idempotencyKey !== undefined && { idempotencyKey }),
        }),
    };
  }

  /** 经连接的插件直接发一条消息（入站处理回绑定卡片、固定话术，卡片操作回说明）；`idempotencyKey` 原样交给插件。 */
  async send(
    connectionId: string,
    target: ChannelTarget,
    message: OutboundMessage,
    idempotencyKey?: string,
  ): Promise<{ messageId: string }> {
    return (await this.outbound(connectionId)).send(target, message, idempotencyKey);
  }
}

/** {@link ChannelConnections.outbound} 的返回值。 */
export interface ChannelOutboundSession {
  row: ChannelConnectionRow;
  features: Channel["features"];
  redact: (s: string) => string;
  /** `idempotencyKey` 原样交给插件（见 `ChannelSendArgs.idempotencyKey`）。 */
  send(
    target: ChannelTarget,
    message: OutboundMessage,
    idempotencyKey?: string,
  ): Promise<{ messageId: string }>;
  /** 只在 `features.edit` 为 true 时调用。 */
  update(
    target: ChannelTarget,
    messageId: string,
    message: OutboundMessage,
    idempotencyKey?: string,
  ): Promise<void>;
}
