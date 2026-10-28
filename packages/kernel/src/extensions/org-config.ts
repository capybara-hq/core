import {
  EXTENSION_POINTS,
  type ExtensionManifest,
  parseExtensionPoint,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import {
  assertItemInstallable,
  assertPluginSourcesInstallable,
  disabledPluginItems,
  pluginItemDisabled,
} from "../catalog/requests.service.js";
import { changedPaths, configFields, getPath, secretValues } from "../config/fields.js";
import { createSecrets, type Keyring } from "../ctx/secrets.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { KERNEL_LOGGER, KEYRING } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock } from "../orgs/org-lock.js";
import { type ConfigIssue, toIssues } from "./config-issues.js";
import { configToJsonSchema, type JsonSchema } from "./config-json-schema.js";
import { enabledExtensionsQuery, requiredExtensions } from "./enabled.js";
import { ExtensionHost } from "./host.js";
import { ExtensionInstalls } from "./installs.js";
import type { PermissionSet } from "./permission-set.js";
import { type PermissionGroup, permissionGroups } from "./permission-view.js";

export { type ConfigIssue, toIssues };

/** 内核自己的 secrets 命名空间（plugin-sdk 把 `kernel` 列为保留插件名，插件不会与之相撞）。 */
const SECRETS_NAMESPACE = "kernel";

const secretKey = (plugin: string, path: string) => `plugin-config:${plugin}:${path}`;

/** 组织视角下一个已加载插件的状态；`config` 永远不含密钥字段，密钥只回显「是否已设置」。 */
export interface OrgExtensionView {
  plugin: string;
  version: string;
  enabled: boolean;
  /** 插件是否声明了 `config.org`。 */
  configurable: boolean;
  /** 已存的非密钥配置；未配置或不可配置时为 null。 */
  config: Record<string, unknown> | null;
  secrets: { path: string; set: boolean }[];
  /** 插件要用的权限，按类别分组并标出敏感项（密钥、公开路由、工具、hook）。 */
  permissions: PermissionGroup[];
  /** `config.org` 的 JSON Schema（密钥字段带 `x-secret`）；不可配置时为 null。 */
  orgConfigSchema: JsonSchema | null;
  /**
   * 插件此刻在部署上可用（已加载）。false：已安装但在部署上停用（或尚未加载），组织页显示「不可用」，
   * 组织的启用开关保留不变（不能修改），其余字段为空。
   */
  available: boolean;
  /**
   * A required bootstrap plugin: enabled in every org (`enabled` is always true) and cannot be
   * disabled here (`extension.required`); its org config, when it has one, can still be set.
   */
  required: boolean;
}

/** 清单不可变：每个组织级 schema 的 JSON Schema 转换结果按 schema 对象缓存（只读、无跨请求状态）。 */
const jsonSchemaCache = new WeakMap<object, JsonSchema>();
function orgJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  let js = jsonSchemaCache.get(schema);
  if (!js) {
    js = configToJsonSchema(schema);
    jsonSchemaCache.set(schema, js);
  }
  return structuredClone(js);
}

/** `put` 的输入：`config` 中的密钥字段缺省 = 保留原值、`null` = 清除、其他值 = 新值。 */
export interface OrgExtensionInput {
  enabled?: boolean | undefined;
  config?: Record<string, unknown> | undefined;
  /** Disable even when enabled dependents remain (default `extension.has_dependents`). */
  force?: boolean | undefined;
}

/** `put` 的内部选项（不来自 HTTP）。 */
export interface OrgExtensionPutOptions {
  /**
   * Enable through this enterprise catalog item (the extension's own item, or an app item: plugins
   * in an app follow the app item's policy, C22). When omitted, judged by every source item in
   * `extension_catalog_sources` (the strictest wins); an extension not installed through the catalog
   * is not bound by catalog policy.
   */
  viaItem?: string;
  /**
   * With `viaItem`: the item whose policy approves the enabling (a dependency's extension: the
   * plugin the org is installing; default `viaItem`).
   */
  approvedBy?: string;
  /**
   * 应用安装用：在组织行锁内读到该插件已启用时什么都不写（不改配置、不审计），并把 `skipped` 置为 true——
   * 「之前就启用」与「本次启用」在锁内判定，不会与并发的启用竞争。
   */
  ifDisabled?: { skipped: boolean };
  /**
   * 在同一个事务（组织行锁内）里最后执行，`skipped` 同 {@link ifDisabled}：应用安装在这里记组件，启用与记录之间
   * 插不进并发的卸载。Runs in that transaction's async context (it reads the transaction there).
   */
  inTransaction?: (skipped: boolean) => Promise<void>;
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

/** 插件组织级 schema 中标记 secret 的叶子点路径（对象路径之外的 secret 已在插件加载时拒绝）。 */
function secretPaths(schema: z.ZodTypeAny): string[] {
  return configFields(schema)
    .filter((f) => f.meta?.secret)
    .map((f) => f.path);
}

/**
 * Org-level extension config: enablement and the `config.org` config stored per org.
 * The non-secret part is stored in `capybara.extension_org_configs.config`; each secret field is
 * encrypted separately in `capybara.secrets` (namespace `kernel`, key `plugin-config:<plugin>:<path>`),
 * written in the same transaction as the config row.
 * No in-process state: every call reads PG, safe with multiple replicas.
 */
@Injectable()
export class OrgExtensionConfigs {
  /** Test seam only: a deterministic interleaving point after the config rows are read, before the secrets. */
  afterConfigRowRead: (() => Promise<void>) | undefined;

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(ExtensionHost) private readonly host: ExtensionHost,
    /** The org row lock (R12): joins the transaction. */
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    /** Install records (any desired state): the ones not loaded are listed unavailable (T14). */
    @Inject(ExtensionInstalls) private readonly installs: ExtensionInstalls,
    /** `extension.org-disabled` after a disable commits (channel connections drop at once). */
    @Inject(KernelEvents) private readonly events: KernelEvents,
    /** Secret values handled (written or decrypted) are masked in the logs after the commit. */
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  /** The kernel-schema handle of the current transaction. */
  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** 把一份组织配置里的密钥值登记到日志打码（无密钥时无操作）；调用方须在事务提交后调用。 */
  private reportSecrets(found: { schema: z.ZodTypeAny; config: unknown } | undefined): void {
    if (!found) return;
    const values = secretValues(found.schema, found.config);
    if (values.length > 0) this.log.addOrgSecrets(values);
  }

  /** After a write committed: a disabled extension's channel connections drop at once. */
  private async afterPut(orgId: string, plugin: string, enabled: boolean): Promise<void> {
    if (!enabled) await this.events.emit("extension.org-disabled", { orgId, plugin });
  }

  /**
   * 列出所有已加载插件在该组织下的状态（按加载顺序）；无记录时 enabled=false、config=null。
   * 之后是已安装但此刻没加载的插件（部署上停用等），`available: false`，按名字排序。
   */
  async list(orgId: string): Promise<OrgExtensionView[]> {
    const installed = (await this.installs.list()).map((r) => ({
      name: r.name,
      version: r.version,
    }));
    return this.listSnapshot(orgId, installed);
  }

  /** `REPEATABLE READ` read-only: the config rows and the secrets come from one snapshot. */
  @Transactional({
    propagation: "requires_new",
    isolationLevel: "repeatable read",
    accessMode: "read only",
  })
  private async listSnapshot(
    orgId: string,
    installed: { name: string; version: string }[],
  ): Promise<OrgExtensionView[]> {
    const t = this.db;
    const rows = await t
      .selectFrom("extension_org_configs")
      .select(["plugin", "enabled", "config"])
      .where("org_id", "=", orgId)
      .execute();
    await this.afterConfigRowRead?.();
    const setKeys = await this.setSecretKeys(t, orgId);
    // Required bootstrap plugins are listed enabled (no org config row needed, spec §7)
    const required = await requiredExtensions(t);
    const loaded = this.host.manifests();
    const views = loaded.map((m) =>
      this.view(
        m,
        rows.find((r) => r.plugin === m.name),
        setKeys,
        required.has(m.name),
      ),
    );
    const names = new Set(loaded.map((m) => m.name));
    const unavailable = installed
      .filter((i) => !names.has(i.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (i): OrgExtensionView => ({
          plugin: i.name,
          version: i.version,
          enabled:
            required.has(i.name) || (rows.find((r) => r.plugin === i.name)?.enabled ?? false),
          configurable: false,
          config: null,
          secrets: [],
          permissions: [],
          orgConfigSchema: null,
          available: false,
          required: required.has(i.name),
        }),
      );
    return [...views, ...unavailable];
  }

  /**
   * Writes enablement and / or config. The actor's role is re-read under the org row lock (needs
   * `org.extensions.manage`).
   * - Extension not loaded -> `extension.not_found`; `config` given but the extension has no
   *   `config.org` -> `extension.no_org_config`; `enabled: false` for a required bootstrap plugin
   *   -> `extension.required` (it stays enabled in every org; its config can still be written).
   * - Non-secret fields are replaced as a whole by the given value; secret fields keep the old value
   *   when omitted, `null` clears, any other value is the new value.
   * - The merged full config (or, without `config`, the existing config when the result is enabled)
   *   does not satisfy the schema -> `extension.config_invalid`.
   */
  async put(
    orgId: string,
    plugin: string,
    input: OrgExtensionInput,
    actorAccountId: string,
    actorTokenId?: string,
    opts: OrgExtensionPutOptions = {},
  ): Promise<OrgExtensionView> {
    const manifest = this.manifest(plugin);
    const schema = manifest.config?.org;
    if (input.config !== undefined && !schema) {
      throw new ApiError(
        "extension.no_org_config",
        `Extension ${plugin} has no organization config`,
      );
    }
    return this.write(orgId, plugin, manifest, input, actorAccountId, actorTokenId, opts);
  }

  @Transactional()
  private async write(
    orgId: string,
    plugin: string,
    manifest: ExtensionManifest,
    input: OrgExtensionInput,
    actorAccountId: string,
    actorTokenId: string | undefined,
    opts: OrgExtensionPutOptions,
  ): Promise<OrgExtensionView> {
    const schema = manifest.config?.org;
    let seen: { schema: z.ZodTypeAny; config: unknown } | undefined;
    const t = this.db;
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "org.extensions.manage");
    const row = await t
      .selectFrom("extension_org_configs")
      .select(["enabled", "config"])
      .where("plugin", "=", plugin)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    const required = (await requiredExtensions(t)).has(plugin);
    if (required && input.enabled === false) throw requiredError(plugin);
    if (opts.ifDisabled && (row?.enabled === true || required)) {
      opts.ifDisabled.skipped = true;
      await opts.inTransaction?.(true);
      return this.view(manifest, row, await this.setSecretKeys(t, orgId), required);
    }
    // A required plugin is enabled whatever the row said (it may predate `required`)
    const enabled = required || (input.enabled ?? row?.enabled ?? false);
    // 新启用来自企业目录的插件：按条目策略与授予复核（C22；已启用的不受影响）
    if (input.enabled === true && row?.enabled !== true && !required) {
      // 插件自己的条目 disabled 是总开关，任何途径都不能新启用（裁决 M-5）
      const killed = await disabledPluginItems(t, [plugin]);
      if (killed.length > 0) throw pluginItemDisabled(killed);
      // 经某个条目安装：只看该条目（应用里的插件按应用条目，C22）；直接启用：全部来源里最严格的生效
      if (opts.viaItem !== undefined) {
        await assertItemInstallable(t, orgId, opts.viaItem, opts.approvedBy ?? opts.viaItem);
      } else await assertPluginSourcesInstallable(t, orgId, plugin);
    }
    if (input.enabled === true) await this.assertDependenciesEnabled(t, orgId, manifest);
    else if (input.enabled === false && !input.force) {
      await this.assertNoEnabledDependents(t, orgId, manifest);
    }
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
            "extension.config_invalid",
            `Invalid organization config for extension ${plugin}`,
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
      .insertInto("extension_org_configs")
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
      detail: {
        enabled,
        changedPaths: changed,
        ...(opts.viaItem !== undefined && { catalogItemId: opts.viaItem }),
      },
    });
    await opts.inTransaction?.(false);
    // 在同一事务里读回，返回值就是刚提交的状态
    const saved = await t
      .selectFrom("extension_org_configs")
      .select(["plugin", "enabled", "config"])
      .where("plugin", "=", plugin)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    const view = this.view(manifest, saved, await this.setSecretKeys(t, orgId), required);
    // Only once the root transaction committed (an outer caller's too): a rolled-back write
    // registers no secrets and disconnects nothing
    afterCommit(async () => {
      this.reportSecrets(seen);
      await this.afterPut(orgId, plugin, view.enabled);
    });
    return view;
  }

  /**
   * 读取并解密某插件在该组织下的完整配置（供运行时按组织构造插件实例）。
   * A required bootstrap plugin is enabled without a row (its stored config, or `{}`, is validated).
   * 无记录 → undefined；插件无 `config.org` 或已停用（`enabled=false`，不校验、不读密钥）时 `config` 为 null。
   * 配置行与密钥在同一个 `REPEATABLE READ` 只读事务里读取。
   * 已存配置不再满足 schema（如插件升级后）→ 抛 Error，信息含插件名、组织 ID 与出错路径（不含值）。
   */
  async get(
    orgId: string,
    plugin: string,
  ): Promise<{ enabled: boolean; config: unknown } | undefined> {
    const manifest = this.manifest(plugin);
    const result = await this.getSnapshot(orgId, plugin, manifest);
    // 只读快照已结束；config 非 null 意味着插件有 org schema 且已解密
    const schema = manifest.config?.org;
    if (schema && result?.config != null) this.reportSecrets({ schema, config: result.config });
    return result;
  }

  /** `REPEATABLE READ` read-only: the config row and the secrets come from one snapshot. */
  @Transactional({
    propagation: "requires_new",
    isolationLevel: "repeatable read",
    accessMode: "read only",
  })
  private async getSnapshot(
    orgId: string,
    plugin: string,
    manifest: ExtensionManifest,
  ): Promise<{ enabled: boolean; config: unknown } | undefined> {
    const t = this.db;
    const row = await t
      .selectFrom("extension_org_configs")
      .select(["enabled", "config"])
      .where("plugin", "=", plugin)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    await this.afterConfigRowRead?.();
    const required = (await requiredExtensions(t)).has(plugin);
    if (!row && !required) return undefined;
    const enabled = required || row?.enabled === true;
    const schema = manifest.config?.org;
    // 已停用的插件不会被实例化：不校验（可能是升级前存下的旧配置），也不解密密钥
    if (!schema || !enabled) return { enabled, config: null };
    return this.decode(t, orgId, plugin, schema, row?.config ?? {});
  }

  private async decode(
    t: KernelSchemaDb,
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

  /**
   * 该组织里已启用、且所 requires 的按组织启用的能力只剩这个插件提供的插件（停用它会让它们失去依赖）。
   * 在调用方事务里读（应用卸载 / 回滚前判断是否保留；`mandatory`: the caller holds the org row lock).
   */
  @Transactional({ propagation: "mandatory" })
  async enabledDependents(orgId: string, plugin: string): Promise<string[]> {
    const t = this.db;
    const manifest = this.host.manifests().find((m) => m.name === plugin);
    if (!manifest) return [];
    const provided = manifest.provides.filter((r) => this.isOrgScoped(r));
    if (provided.length === 0) return [];
    const enabled = await this.enabledSet(t, orgId);
    if (!enabled.has(plugin)) return [];
    const out = new Set<string>();
    for (const ref of provided) {
      if (this.enabledProviders(enabled, ref, plugin).length > 0) continue;
      for (const m of this.host.manifests()) {
        if (m.name === plugin || !enabled.has(m.name)) continue;
        if ((m.requires ?? []).includes(ref as never)) out.add(m.name);
      }
    }
    return [...out].sort();
  }

  /**
   * 在调用方事务里停用（应用安装的回滚与卸载用；调用方已锁组织行并复核角色）：不检查依赖方，配置保留，
   * 审计 `org.plugin_config.updated`（带 reason）。提交后调用方须再调 {@link afterDisable}。
   */
  @Transactional({ propagation: "mandatory" })
  async disableIn(
    orgId: string,
    plugin: string,
    actorAccountId: string,
    reason: string,
  ): Promise<boolean> {
    const t = this.db;
    // A required bootstrap plugin stays enabled in every org
    if ((await requiredExtensions(t)).has(plugin)) return false;
    const r = await t
      .updateTable("extension_org_configs")
      .set({ enabled: false, updated_by: actorAccountId, updated_at: new Date() })
      .where("plugin", "=", plugin)
      .where("org_id", "=", orgId)
      .where("enabled", "=", true)
      .returning("plugin")
      .executeTakeFirst();
    if (!r) return false;
    await audit(t, {
      actorAccountId,
      orgId,
      action: "org.plugin_config.updated",
      target: plugin,
      detail: { enabled: false, changedPaths: [], reason },
    });
    return true;
  }

  /** {@link disableIn} 的事务提交之后：通知停用（断开该插件的渠道连接等）。 */
  async afterDisable(orgId: string, plugin: string): Promise<void> {
    await this.afterPut(orgId, plugin, false);
  }

  /** 该组织已启用的插件名（只含当前已加载的插件；待批准的不算；必需的引导插件始终算启用）。 */
  private async enabledSet(t: KernelSchemaDb, orgId: string): Promise<Set<string>> {
    const rows = await enabledExtensionsQuery(t, orgId).execute();
    const loaded = new Set(this.host.manifests().map((m) => m.name));
    return new Set(rows.map((r) => r.plugin).filter((n) => loaded.has(n)));
  }

  /** 引用是否为按组织启用的能力。 */
  private isOrgScoped(ref: string): boolean {
    return EXTENSION_POINTS[parseExtensionPoint(ref).name]?.orgScoped === true;
  }

  /** 该组织内（已启用、已加载、非 `except`）提供完整引用（含主版本）的插件。 */
  private enabledProviders(enabled: ReadonlySet<string>, ref: string, except: string): string[] {
    return this.host
      .manifests()
      .filter((m) => m.name !== except && enabled.has(m.name) && m.provides.includes(ref as never))
      .map((m) => m.name);
  }

  /** 启用前：A `requires` 的每个 orgScoped 能力（按主版本），该组织须至少有一个已启用的提供方。 */
  private async assertDependenciesEnabled(
    t: KernelSchemaDb,
    orgId: string,
    manifest: ExtensionManifest,
  ): Promise<void> {
    const needed = (manifest.requires ?? []).filter((r) => this.isOrgScoped(r));
    if (needed.length === 0) return;
    const enabled = await this.enabledSet(t, orgId);
    const missing = needed.filter(
      (r) => this.enabledProviders(enabled, r, manifest.name).length === 0,
    );
    if (missing.length > 0) {
      throw new ApiError(
        "extension.dependency_missing",
        `Extension ${manifest.name} requires extension points with no enabled provider in this organization: ${missing.join(", ")}`,
        missing.map((extensionPoint) => ({ extensionPoint })),
      );
    }
  }

  /** 停用前：若停用后某个已启用的插件所 requires 的 orgScoped 能力（按主版本）再无已启用的提供方，拒绝。 */
  private async assertNoEnabledDependents(
    t: KernelSchemaDb,
    orgId: string,
    manifest: ExtensionManifest,
  ): Promise<void> {
    const provided = manifest.provides.filter((r) => this.isOrgScoped(r));
    if (provided.length === 0) return;
    const enabled = await this.enabledSet(t, orgId);
    if (!enabled.has(manifest.name)) return;
    const dependents = new Map<string, { plugin: string; extensionPoint: string }>();
    for (const ref of provided) {
      if (this.enabledProviders(enabled, ref, manifest.name).length > 0) continue;
      for (const m of this.host.manifests()) {
        if (m.name === manifest.name || !enabled.has(m.name)) continue;
        if ((m.requires ?? []).includes(ref as never)) {
          dependents.set(`${m.name}\0${ref}`, { plugin: m.name, extensionPoint: ref });
        }
      }
    }
    if (dependents.size > 0) {
      const list = [...dependents.values()];
      throw new ApiError(
        "extension.has_dependents",
        `Extension ${manifest.name} is required by enabled extensions in this organization: ${[...new Set(list.map((d) => d.plugin))].join(", ")} (pass force to disable anyway)`,
        list,
      );
    }
  }

  private manifest(plugin: string): ExtensionManifest {
    const m = this.host.manifests().find((x) => x.name === plugin);
    if (!m) throw new ApiError("extension.not_found", `Extension ${plugin} is not installed`);
    return m;
  }

  private permissionsOf(plugin: string): PermissionSet {
    const set = this.host.permissionSet(plugin);
    if (!set) throw new ApiError("extension.not_found", `Extension ${plugin} is not installed`);
    return set;
  }

  private view(
    m: ExtensionManifest,
    row: { enabled: boolean; config: Obj | null } | undefined,
    setKeys: ReadonlySet<string>,
    required: boolean,
  ): OrgExtensionView {
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
      enabled: required || (row?.enabled ?? false),
      configurable: schema !== undefined,
      config,
      secrets: paths.map((p) => ({ path: p, set: setKeys.has(secretKey(m.name, p)) })),
      permissions: permissionGroups(this.permissionsOf(m.name)),
      orgConfigSchema: schema ? orgJsonSchema(schema) : null,
      available: true,
      required,
    };
  }

  /** 该组织在 `kernel` 命名空间下已设置的插件配置密钥键（不解密）。 */
  private async setSecretKeys(db: KernelSchemaDb, orgId: string): Promise<Set<string>> {
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

const requiredError = (plugin: string) =>
  new ApiError(
    "extension.required",
    `Extension ${plugin} is required by this deployment (a bootstrap plugin): it is enabled in every organization and cannot be disabled`,
  );
