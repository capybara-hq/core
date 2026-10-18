import type { PluginManifest } from "@capybara-hq/plugin-sdk";
import type { Transaction } from "kysely";
import type { core, z } from "zod";
import { changedPaths, configFields, getPath, secretValues } from "../config/fields.js";
import { createSecrets, type Keyring } from "../ctx/secrets.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { lockOrgAndAuthorize } from "../orgs/org-lock.js";
import type { PluginHost } from "./host.js";

type Trx = Transaction<KernelDatabase>;

/** 内核自己的 secrets 命名空间（plugin-sdk 把 `kernel` 列为保留插件名，插件不会与之相撞）。 */
const SECRETS_NAMESPACE = "kernel";

const secretKey = (plugin: string, path: string) => `plugin-config:${plugin}:${path}`;

/** 组织视角下一个已加载插件的状态；`config` 永远不含密钥字段，密钥只回显「是否已设置」。 */
export interface OrgPluginView {
  plugin: string;
  version: string;
  enabled: boolean;
  /** 插件是否声明了 `config.org`。 */
  configurable: boolean;
  /** 已存的非密钥配置；未配置或不可配置时为 null。 */
  config: Record<string, unknown> | null;
  secrets: { path: string; set: boolean }[];
}

/** `put` 的输入：`config` 中的密钥字段缺省 = 保留原值、`null` = 清除、其他值 = 新值。 */
export interface OrgPluginInput {
  enabled?: boolean | undefined;
  config?: Record<string, unknown> | undefined;
}

/** 校验失败的单条原因：只含路径与按 issue 类型生成的说明，不回显字段值。 */
export interface ConfigIssue {
  path: string;
  message: string;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** 按点路径设值，缺失的中间对象自动创建；中间节点不是对象时放弃（交给 schema 校验报错）。 */
function setDeep(obj: Obj, path: string, value: unknown): void {
  const segs = path.split(".");
  let node: Obj = obj;
  for (const seg of segs.slice(0, -1)) {
    const next = node[seg];
    if (next === undefined) node[seg] = {};
    else if (!isObj(next)) return;
    node = node[seg] as Obj;
  }
  node[segs[segs.length - 1] as string] = value;
}

/** 按点路径删除键（路径不存在时无操作）。 */
function deleteDeep(obj: Obj, path: string): void {
  const segs = path.split(".");
  let node: unknown = obj;
  for (const seg of segs.slice(0, -1)) {
    if (!isObj(node)) return;
    node = node[seg];
  }
  if (isObj(node)) delete node[segs[segs.length - 1] as string];
}

/** 由 issue 类型与结构字段生成说明；不用 zod 的 message（自定义消息可能拼入输入值）。 */
function issueMessage(i: core.$ZodIssue): string {
  switch (i.code) {
    case "invalid_type":
      return `expected ${i.expected}`;
    case "too_small":
      return `too small (minimum ${String(i.minimum)})`;
    case "too_big":
      return `too big (maximum ${String(i.maximum)})`;
    case "invalid_format":
      return `invalid ${i.format}`;
    case "not_multiple_of":
      return `not a multiple of ${String(i.divisor)}`;
    case "unrecognized_keys":
      return "unrecognized keys";
    case "invalid_union":
      return "no union member matched";
    case "invalid_key":
      return "invalid key";
    case "invalid_element":
      return "invalid element";
    default:
      return "invalid value";
  }
}

function toIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((i) => ({
    path: i.path.map(String).join("."),
    message: issueMessage(i),
  }));
}

/** 插件组织级 schema 中标记 secret 的叶子点路径（对象路径之外的 secret 已在插件加载时拒绝）。 */
function secretPaths(schema: z.ZodTypeAny): string[] {
  return configFields(schema)
    .filter((f) => f.meta?.secret)
    .map((f) => f.path);
}

/**
 * 组织级插件配置：启用状态与 `config.org` 配置按组织存储。
 * 非密钥部分存 `capybara.plugin_org_configs.config`；每个 secret 字段单独加密存
 * `capybara.secrets`（命名空间 `kernel`，键 `plugin-config:<plugin>:<path>`），与配置行在同一事务内写入。
 * 无进程内状态：每次调用都从 PG 读，多副本安全。
 */
export class OrgPluginConfigs {
  constructor(
    private readonly db: KernelDb,
    private readonly keyring: Keyring,
    private readonly host: PluginHost,
    private readonly hooks: {
      /**
       * 经手（写入或解密读出）的密钥值，含嵌套字段；只在事务提交后调用（回滚的写入不上报）。
       * 内核传 `log.addOrgSecrets` 使其在日志中打码。
       */
      onSecrets?: (values: string[]) => void;
      /** 仅供测试：在读完配置行之后、读密钥之前插入确定性的交错点。 */
      afterConfigRowRead?: () => Promise<void>;
    } = {},
  ) {}

  /** 把一份组织配置里的密钥值交给 onSecrets（无回调或无密钥时无操作）；调用方须在事务提交后调用。 */
  private reportSecrets(found: { schema: z.ZodTypeAny; config: unknown } | undefined): void {
    if (!found || !this.hooks.onSecrets) return;
    const values = secretValues(found.schema, found.config);
    if (values.length > 0) this.hooks.onSecrets(values);
  }

  /** `REPEATABLE READ` 只读事务：配置行与密钥来自同一个快照，不会读到跨两次提交的混合状态。 */
  private snapshot<T>(fn: (t: Trx) => Promise<T>): Promise<T> {
    return this.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .setAccessMode("read only")
      .execute(fn);
  }

  /** 列出所有已加载插件在该组织下的状态（按加载顺序）；无记录时 enabled=false、config=null。 */
  async list(orgId: string): Promise<OrgPluginView[]> {
    return this.snapshot(async (t) => {
      const rows = await t
        .selectFrom("plugin_org_configs")
        .select(["plugin", "enabled", "config"])
        .where("org_id", "=", orgId)
        .execute();
      await this.hooks.afterConfigRowRead?.();
      const setKeys = await this.setSecretKeys(t, orgId);
      return this.host.manifests().map((m) =>
        this.view(
          m,
          rows.find((r) => r.plugin === m.name),
          setKeys,
        ),
      );
    });
  }

  /**
   * 写入启用状态与 / 或配置。发起人角色在组织行锁内实时重读（需 `org.plugins.manage`）。
   * - 插件未加载 → `plugin.not_found`；传了 `config` 但插件无 `config.org` → `plugin.no_org_config`。
   * - 非密钥字段整体替换为传入值；密钥字段缺省保留原值、`null` 清除、其他值为新值。
   * - 合并后的完整配置（或未传 `config` 但结果为启用时的现存配置）不满足 schema → `plugin.config_invalid`。
   */
  async put(
    orgId: string,
    plugin: string,
    input: OrgPluginInput,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<OrgPluginView> {
    const manifest = this.manifest(plugin);
    const schema = manifest.config?.org;
    if (input.config !== undefined && !schema) {
      throw new ApiError("plugin.no_org_config", `Plugin ${plugin} has no organization config`);
    }
    let seen: { schema: z.ZodTypeAny; config: unknown } | undefined;
    const view = await this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "org.plugins.manage");
      const row = await t
        .selectFrom("plugin_org_configs")
        .select(["enabled", "config"])
        .where("plugin", "=", plugin)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      const enabled = input.enabled ?? row?.enabled ?? false;
      let plain: Obj | null = row?.config ?? null;
      let changed: string[] = [];
      if (schema) {
        const secrets = createSecrets(t, this.keyring, SECRETS_NAMESPACE);
        const paths = secretPaths(schema);
        const before = structuredClone(plain ?? {});
        for (const p of paths) {
          const v = await secrets.get(orgId, secretKey(plugin, p));
          if (v !== null) setDeep(before, p, JSON.parse(v));
        }
        let next: Obj;
        if (input.config !== undefined) {
          next = structuredClone(input.config);
          for (const p of paths) {
            const v = getPath(input.config, p);
            if (v === null) deleteDeep(next, p);
            else if (v === undefined) {
              const old = getPath(before, p);
              if (old !== undefined) setDeep(next, p, old);
            }
          }
        } else {
          next = before;
        }
        if (input.config !== undefined || enabled) {
          const r = schema.safeParse(next);
          if (!r.success) {
            throw new ApiError(
              "plugin.config_invalid",
              `Invalid organization config for plugin ${plugin}`,
              toIssues(r.error),
            );
          }
          next = r.data as Obj;
        }
        seen = { schema, config: next };
        if (input.config !== undefined) {
          changed = changedPaths(schema, before, next);
          plain = structuredClone(next);
          for (const p of paths) {
            const v = getPath(next, p);
            deleteDeep(plain, p);
            if (v === undefined) await secrets.delete(orgId, secretKey(plugin, p));
            else await secrets.set(orgId, secretKey(plugin, p), JSON.stringify(v));
          }
        }
      }
      // 当前 schema 中已不存在的密钥路径：同一事务内清掉遗留的密文行
      const live = new Set((schema ? secretPaths(schema) : []).map((p) => secretKey(plugin, p)));
      const prefix = secretKey(plugin, "");
      const cleanup = createSecrets(t, this.keyring, SECRETS_NAMESPACE);
      for (const key of await this.setSecretKeys(t, orgId)) {
        if (key.startsWith(prefix) && !live.has(key)) await cleanup.delete(orgId, key);
      }
      await t
        .insertInto("plugin_org_configs")
        .values({
          plugin,
          org_id: orgId,
          enabled,
          config: plain === null ? null : JSON.stringify(plain),
          updated_by: actorAccountId,
        })
        .onConflict((oc) =>
          oc.columns(["plugin", "org_id"]).doUpdateSet({
            enabled,
            config: plain === null ? null : JSON.stringify(plain),
            updated_by: actorAccountId,
            updated_at: new Date(),
          }),
        )
        .execute();
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "org.plugin_config.updated",
        target: plugin,
        detail: { enabled, changedPaths: changed },
      });
      // 在同一事务里读回，返回值就是刚提交的状态
      const saved = await t
        .selectFrom("plugin_org_configs")
        .select(["plugin", "enabled", "config"])
        .where("plugin", "=", plugin)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      return this.view(manifest, saved, await this.setSecretKeys(t, orgId));
    });
    // 事务已提交：回滚的写入不会走到这里
    this.reportSecrets(seen);
    return view;
  }

  /**
   * 读取并解密某插件在该组织下的完整配置（供运行时按组织构造插件实例）。
   * 无记录 → undefined；插件无 `config.org` 或已停用（`enabled=false`，不校验、不读密钥）时 `config` 为 null。
   * 配置行与密钥在同一个 `REPEATABLE READ` 只读事务里读取。
   * 已存配置不再满足 schema（如插件升级后）→ 抛 Error，信息含插件名、组织 ID 与出错路径（不含值）。
   */
  async get(
    orgId: string,
    plugin: string,
  ): Promise<{ enabled: boolean; config: unknown } | undefined> {
    const manifest = this.manifest(plugin);
    const result = await this.snapshot(async (t) => {
      const row = await t
        .selectFrom("plugin_org_configs")
        .select(["enabled", "config"])
        .where("plugin", "=", plugin)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      await this.hooks.afterConfigRowRead?.();
      if (!row) return undefined;
      const schema = manifest.config?.org;
      // 已停用的插件不会被实例化：不校验（可能是升级前存下的旧配置），也不解密密钥
      if (!schema || !row.enabled) return { enabled: row.enabled, config: null };
      return this.decode(t, orgId, plugin, schema, row.config ?? {});
    });
    // 只读快照已结束；config 非 null 意味着插件有 org schema 且已解密
    const schema = manifest.config?.org;
    if (schema && result?.config != null) this.reportSecrets({ schema, config: result.config });
    return result;
  }

  private async decode(
    t: Trx,
    orgId: string,
    plugin: string,
    schema: z.ZodTypeAny,
    stored: Obj,
  ): Promise<{ enabled: boolean; config: unknown }> {
    const full = structuredClone(stored);
    const secrets = createSecrets(t, this.keyring, SECRETS_NAMESPACE);
    for (const p of secretPaths(schema)) {
      const v = await secrets.get(orgId, secretKey(plugin, p));
      if (v !== null) setDeep(full, p, JSON.parse(v));
    }
    const r = schema.safeParse(full);
    if (!r.success) {
      const detail = toIssues(r.error)
        .map((i) => `${i.path || "<root>"}: ${i.message}`)
        .join("; ");
      throw new Error(
        `plugin ${plugin}: stored organization config for org ${orgId} is invalid: ${detail}`,
      );
    }
    return { enabled: true, config: r.data };
  }

  private manifest(plugin: string): PluginManifest {
    const m = this.host.manifests().find((x) => x.name === plugin);
    if (!m) throw new ApiError("plugin.not_found", `Plugin ${plugin} is not installed`);
    return m;
  }

  private view(
    m: PluginManifest,
    row: { enabled: boolean; config: Obj | null } | undefined,
    setKeys: ReadonlySet<string>,
  ): OrgPluginView {
    const schema = m.config?.org;
    const paths = schema ? secretPaths(schema) : [];
    let config: Obj | null = null;
    if (schema && row?.config) {
      config = structuredClone(row.config);
      for (const p of paths) deleteDeep(config, p);
    }
    return {
      plugin: m.name,
      version: m.version,
      enabled: row?.enabled ?? false,
      configurable: schema !== undefined,
      config,
      secrets: paths.map((p) => ({ path: p, set: setKeys.has(secretKey(m.name, p)) })),
    };
  }

  /** 该组织在 `kernel` 命名空间下已设置的插件配置密钥键（不解密）。 */
  private async setSecretKeys(db: KernelDb | Trx, orgId: string): Promise<Set<string>> {
    const rows = await db
      .selectFrom("secrets")
      .select("key")
      .where("namespace", "=", SECRETS_NAMESPACE)
      .where("org_id", "=", orgId)
      .where("key", "like", "plugin-config:%")
      .execute();
    return new Set(rows.map((r) => r.key));
  }
}
