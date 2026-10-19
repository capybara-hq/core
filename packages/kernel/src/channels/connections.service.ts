import { randomUUID } from "node:crypto";
import {
  CHANNEL_CAPABILITY,
  type Channel,
  type ChannelTarget,
  type Logger,
  type OutboundMessage,
  type PluginContext,
} from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import { sql } from "kysely";
import type { z } from "zod";
import { configFields, getPath, secretValues } from "../config/fields.js";
import { queryEnabledPlugins } from "../ctx/create-ctx.js";
import { createSecrets, type Keyring } from "../ctx/secrets.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { lockOrgAndAuthorize } from "../orgs/org-lock.js";
import { configToJsonSchema, type JsonSchema } from "../plugins/config-json-schema.js";
import type { PluginHost } from "../plugins/host.js";
import { toIssues } from "../plugins/org-config.js";

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

/** 对外的连接视图：`config` 只含非密钥字段，密钥只回显「是否已设置」。 */
export interface ChannelConnectionView {
  id: string;
  orgId: string;
  plugin: string;
  name: string;
  agentId: string;
  unboundPolicy: UnboundPolicy;
  status: ChannelStatus;
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
  tenantId: string | null;
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
  host: Pick<PluginHost, "list">;
  bus: PluginContext["bus"];
  redis: Redis;
  log: Pick<Logger, "warn">;
  /** 经手（写入或解密读出）的密钥值；内核传 `log.addOrgSecrets` 使其在日志中打码。 */
  onSecrets?: (values: string[]) => void;
}

/**
 * 组织的渠道连接（spec：渠道连接属于组织，bot 凭据 + 绑定的 agent）。框架无关。
 * 非密钥配置存 `channel_connections.config`；密钥字段整体加密存 `capybara.secrets`
 * （命名空间 `kernel`，键 `channels:<id>:config`）。写操作在组织行锁内实时复核 `channels.manage`，写审计；
 * 改动提交后经内核 bus 广播 `channel.changed`，持有该连接的副本据此断开（下一轮扫描按新配置重连）。
 */
export class ChannelConnections {
  constructor(private readonly deps: ChannelConnectionsDeps) {}

  /** 插件提供的 `channel@1`；未加载或不提供 → `plugin.not_found`。 */
  channel(plugin: string): Channel {
    const e = this.deps.host
      .list("channel")
      .find((x) => x.plugin === plugin && x.capability === CHANNEL_CAPABILITY);
    if (!e) throw new ApiError("plugin.not_found", `Plugin ${plugin} does not provide a channel`);
    return e.impl as Channel;
  }

  /** 插件在该组织未启用 → `plugin.not_enabled`。 */
  private async assertEnabled(orgId: string, plugin: string): Promise<void> {
    if (!(await queryEnabledPlugins(this.deps.db, orgId)).has(plugin)) {
      throw new ApiError(
        "plugin.not_enabled",
        `Plugin ${plugin} is not enabled for this organization`,
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
        "plugin.config_invalid",
        `Invalid channel connection config for plugin ${plugin}`,
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
    try {
      paths = secretPaths(this.channel(r.plugin).connectionSchema);
    } catch {
      // 插件已卸载：只回显已存的密钥路径
      paths = [...setPaths];
    }
    return {
      id: r.id,
      orgId: r.org_id,
      plugin: r.plugin,
      name: r.name,
      agentId: r.agent_id,
      unboundPolicy: r.unbound_policy,
      status: r.status,
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

  /** 修改名称、agent、未绑定策略、启停，或轮换凭据（新配置同样先 `verify`，失败什么都不改）。 */
  async update(
    orgId: string,
    id: string,
    patch: UpdateChannelInput,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<ChannelConnectionView> {
    const current = await this.live(orgId).where("id", "=", id).executeTakeFirst();
    if (!current) throw notFound();
    let rotated: { schema: z.ZodTypeAny; full: Obj; plain: Obj; secrets: Obj } | undefined;
    let verified: { botUserId: string; tenantId: string } | undefined;
    if (patch.config !== undefined) {
      const channel = this.channel(current.plugin);
      await this.assertEnabled(orgId, current.plugin);
      const schema = channel.connectionSchema;
      const before = await this.readSecrets(orgId, id);
      const next = structuredClone(patch.config);
      for (const p of secretPaths(schema)) {
        const v = getPath(patch.config, p);
        if (v === null) deleteDeep(next, p);
        else if (v === undefined && before[p] !== undefined) setDeep(next, p, before[p]);
      }
      const full = this.parse(current.plugin, schema, next);
      verified = await this.verify(channel, full);
      rotated = { schema, full, ...split(schema, full) };
    }
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
          ...(rotated && {
            config: JSON.stringify(rotated.plain),
            bot_user_id: verified?.botUserId ?? null,
            tenant_id: verified?.tenantId ?? null,
          }),
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
    // 改了配置或重新启用：清掉退避，下一轮扫描立即按新配置连接
    if (rotated || patch.status === "active") {
      await this.deps.redis
        .del(channelBackoffKey(id), channelFailsKey(id))
        .catch((err: unknown) => this.deps.log.warn("cannot clear channel backoff", { err }));
    }
    await this.changed(id, rotated !== undefined || patch.status !== undefined);
    return this.viewOf(row);
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

  /** 运行时读连接行（未删除）；不存在返回 undefined。 */
  async row(id: string): Promise<ChannelConnectionRow | undefined> {
    const r = await this.deps.db
      .selectFrom("channel_connections")
      .select(["id", "org_id", "plugin", "agent_id", "unbound_policy", "status", "tenant_id"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return (
      r && {
        id: r.id,
        orgId: r.org_id,
        plugin: r.plugin,
        agentId: r.agent_id,
        unboundPolicy: r.unbound_policy,
        status: r.status,
        tenantId: r.tenant_id,
      }
    );
  }

  /**
   * 连接运行所需的插件实现与完整配置（含解密的密钥，已按 `connectionSchema` 校验）。
   * 连接不存在 / 已删除 → `channel.not_found`；插件未加载 → `plugin.not_found`；组织未启用 → `plugin.not_enabled`；
   * 已存配置不再满足 schema（插件升级后）→ `plugin.config_invalid`。不得回显到响应或日志。
   */
  async runtime(
    id: string,
  ): Promise<{ row: ChannelConnectionRow; channel: Channel; config: unknown }> {
    const row = await this.row(id);
    if (!row) throw notFound();
    const channel = this.channel(row.plugin);
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
    return { row, channel, config };
  }

  /**
   * 经连接的插件直接发一条消息（Task 10 的最小出站接缝：入站处理回绑定卡片、固定话术）。
   * Task 11 的出站投递在此之上加按事件序号续投、草稿编辑与卡片更新。
   */
  async send(
    connectionId: string,
    target: ChannelTarget,
    message: OutboundMessage,
  ): Promise<{ messageId: string }> {
    const { channel, config } = await this.runtime(connectionId);
    return channel.send({
      config,
      target,
      message,
      signal: AbortSignal.timeout(PLUGIN_CALL_TIMEOUT_MS),
    });
  }
}
