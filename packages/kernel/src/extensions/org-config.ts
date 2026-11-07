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
} from "../catalog/request-rules.js";
import { type PluginScope, visibleTo } from "../catalog/scope.js";
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
import { configMessages, type JsonSchema, safeConfigFormSchema } from "./config-json-schema.js";
import { EffectiveConfigs } from "./effective-config.js";
import { enabledExtensionsQuery, requiredExtensions } from "./enabled.js";
import { ExtensionHost } from "./host.js";
import { ExtensionInstalls } from "./installs.js";
import { fieldLevels } from "./org-levels.js";
import type { PermissionSet } from "./permission-set.js";
import { type PermissionGroup, permissionGroups } from "./permission-view.js";
import { type ExtensionPluginItem, itemLocked, pluginItemsOf } from "./plugin-items.js";

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
  /** The catalog plugin the extension ships in and its scope (builtin counts as `all`); null without one. */
  catalogItem: { itemId: string; scope: PluginScope } | null;
  /** The org admin can switch it (the plugin's switch): never for an `all` / builtin plugin. */
  switchable: boolean;
  /**
   * The two-level deployment config (spec A §5.3, §5.4): `following` the platform, a `copy` of the
   * overridable fields, or `none` (the extension has no overridable field, or is unavailable).
   */
  overrideState: "following" | "copy" | "none";
  /**
   * The org must configure the extension before it works here (spec A §6): its effective config
   * is not valid, or a required org-only field is missing. Always false when unavailable.
   */
  needsConfig: boolean;
}

/** The extension points an extension provides, from its permission list's `provides` group. */
export function providesOf(view: Pick<OrgExtensionView, "permissions">): string[] {
  return view.permissions.filter((g) => g.category === "provides").flatMap((g) => g.items);
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
   * Enable through this platform catalog item (the extension's own item, or an app item: plugins
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
   * For a plugin install: when the extension is already enabled under the org row lock, nothing is
   * written (no config change, no audit) and `skipped` is set to true. "Enabled before" and
   * "enabled now" are decided under the lock, so a concurrent enable cannot race it. A caller that
   * records the extension in the same transaction (the catalog install, `put` joins its
   * transaction) reads `skipped` after `put` returns: no concurrent uninstall fits in between.
   */
  ifDisabled?: { skipped: boolean };
  /**
   * Check the role and the config (the given `config`, or with `enabled: true` the stored one,
   * merged with the stored secrets, against the schema) and write nothing: lets a caller that must
   * do another write first fail without a side effect. The rules for newly enabling (catalog policy,
   * dependencies) are left to that write: the plugin install that enables it checks them.
   */
  validateOnly?: boolean;
}

type Obj = Record<string, unknown>;

/**
 * The scope part of an org view: the extension's primary plugin and whether the org can switch it.
 * With several source items, a builtin one locks the extension on (scope `all`); an `all` one does
 * not (layering spec §4).
 */
function scopeFields(
  items: readonly ExtensionPluginItem[] | undefined,
  required: boolean,
): Pick<OrgExtensionView, "catalogItem" | "switchable"> {
  const primary = items?.[0];
  if (!primary) return { catalogItem: null, switchable: !required };
  const locked = required || items.some(itemLocked);
  return {
    catalogItem: { itemId: primary.id, scope: locked ? "all" : primary.scope },
    switchable: !locked,
  };
}

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
    /** The org row lock (orgs/org-lock.ts): joins the transaction. */
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    /** Install records (any desired state): the ones not loaded are listed unavailable (T14). */
    @Inject(ExtensionInstalls) private readonly installs: ExtensionInstalls,
    /** `extension.org-disabled` after a disable commits (channel connections drop at once). */
    @Inject(KernelEvents) private readonly events: KernelEvents,
    /** Secret values handled (written or decrypted) are masked in the logs after the commit. */
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    /** The effective deployment config of each org (spec A §6): read for `needsConfig`. */
    @Inject(EffectiveConfigs) private readonly effective: EffectiveConfigs,
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
   * The state of every loaded extension the org sees, in load order (no row: `enabled` false,
   * `config` null), then the installed extensions not loaded right now (disabled on the deployment
   * and the like) as `available: false`, sorted by name.
   */
  async list(orgId: string): Promise<OrgExtensionView[]> {
    const installed = (await this.installs.list()).map((r) => ({
      name: r.name,
      version: r.version,
    }));
    return this.withLayers(orgId, await this.listSnapshot(orgId, installed));
  }

  /**
   * Fills `overrideState` and the platform half of `needsConfig` (spec A §6) for the views of
   * extensions with overridable fields (the others always run with the platform's config, which
   * loaded valid). Reads the org's copy rows once and the effective config of each such extension.
   */
  private async withLayers(orgId: string, views: OrgExtensionView[]): Promise<OrgExtensionView[]> {
    const layered = views.filter((v) => v.overrideState !== "none");
    if (layered.length === 0) return views;
    const copies = new Set(
      (
        await this.db
          .selectFrom("extension_org_overrides")
          .select("plugin")
          .where("org_id", "=", orgId)
          .where(
            "plugin",
            "in",
            layered.map((v) => v.plugin),
          )
          .execute()
      ).map((r) => r.plugin),
    );
    for (const v of layered) {
      v.overrideState = copies.has(v.plugin) ? "copy" : "following";
      if (!(await this.effective.get(orgId, v.plugin)).ok) v.needsConfig = true;
    }
    return views;
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
    const items = await pluginItemsOf(t, [
      ...loaded.map((m) => m.name),
      ...installed.map((i) => i.name),
    ]);
    // An extension whose plugin the org is not offered (a `named` plugin without it) is absent
    const listed = new Set(
      (
        await t
          .selectFrom("catalog_item_scope_orgs")
          .select("item_id")
          .where("org_id", "=", orgId)
          .execute()
      ).map((r) => r.item_id),
    );
    const seen = (name: string) => required.has(name) || itemsVisible(items.get(name), listed);
    const views = loaded
      .filter((m) => seen(m.name))
      .map((m) =>
        this.view(
          m,
          rows.find((r) => r.plugin === m.name),
          setKeys,
          required.has(m.name),
          items.get(m.name),
        ),
      );
    const names = new Set(loaded.map((m) => m.name));
    const unavailable = installed
      .filter((i) => !names.has(i.name) && seen(i.name))
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
          ...scopeFields(items.get(i.name), required.has(i.name)),
          overrideState: "none",
          needsConfig: false,
        }),
      );
    return [...views, ...unavailable];
  }

  /**
   * How an `enabled` write of this extension is handled: `direct` through {@link put} (a required
   * bootstrap plugin keeps `extension.required`; an extension without a live item is config-declared;
   * several live items keep the direct write, the strictest source rules applying), `locked` (a live
   * item is builtin and the write switches off: `plugin.scope_locked`), or `item` (the single plugin
   * whose org switch it is).
   */
  async switchPlan(
    plugin: string,
    enabled: boolean,
  ): Promise<{ kind: "direct" } | { kind: "locked" } | { kind: "item"; itemId: string }> {
    const t = this.db;
    if ((await requiredExtensions(t)).has(plugin)) return { kind: "direct" };
    const items = (await pluginItemsOf(t, [plugin])).get(plugin);
    if (!items) return { kind: "direct" };
    if (!enabled && items.some(itemLocked)) return { kind: "locked" };
    const [only] = items;
    return items.length === 1 && only ? { kind: "item", itemId: only.id } : { kind: "direct" };
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
    /** null: the kernel itself (the plugin scope sync installing a plugin), no role check. */
    actorAccountId: string | null,
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
    const view = await this.write(
      orgId,
      plugin,
      manifest,
      input,
      actorAccountId,
      actorTokenId,
      opts,
    );
    return (await this.withLayers(orgId, [view]))[0] as OrgExtensionView;
  }

  @Transactional()
  private async write(
    orgId: string,
    plugin: string,
    manifest: ExtensionManifest,
    input: OrgExtensionInput,
    actorAccountId: string | null,
    actorTokenId: string | undefined,
    opts: OrgExtensionPutOptions,
  ): Promise<OrgExtensionView> {
    const schema = manifest.config?.org;
    let seen: { schema: z.ZodTypeAny; config: unknown } | undefined;
    const t = this.db;
    await this.orgLock.lockFor(orgId, actorAccountId, "org.extensions.manage");
    const row = await t
      .selectFrom("extension_org_configs")
      .select(["enabled", "config"])
      .where("plugin", "=", plugin)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    const required = (await requiredExtensions(t)).has(plugin);
    const item = (await pluginItemsOf(t, [plugin])).get(plugin);
    if (required && input.enabled === false) throw requiredError(plugin);
    if (opts.ifDisabled && (row?.enabled === true || required)) {
      opts.ifDisabled.skipped = true;
      return this.view(manifest, row, await this.setSecretKeys(t, orgId), required, item);
    }
    // A required plugin is enabled whatever the row said (it may predate `required`)
    const enabled = required || (input.enabled ?? row?.enabled ?? false);
    // validateOnly: the rules for (newly) enabling and disabling belong to the write that follows
    if (!opts.validateOnly) {
      await this.assertSwitchRules(t, orgId, manifest, input, row, required, opts);
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
            toIssues(r.error, configMessages(this.formSchema(plugin, manifest.version, schema))),
          );
        }
        next = r.data as Obj;
      }
      seen = { schema, config: next };
      if (!opts.validateOnly && input.config !== undefined) {
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
    // Also without an org config schema: nothing is written
    if (opts.validateOnly) {
      return this.view(manifest, row, await this.setSecretKeys(t, orgId), required, item);
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
    // 在同一事务里读回，返回值就是刚提交的状态
    const saved = await t
      .selectFrom("extension_org_configs")
      .select(["plugin", "enabled", "config"])
      .where("plugin", "=", plugin)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    const view = this.view(manifest, saved, await this.setSecretKeys(t, orgId), required, item);
    // Only once the root transaction committed (an outer caller's too): a rolled-back write
    // registers no secrets and disconnects nothing
    afterCommit(async () => {
      this.reportSecrets(seen);
      await this.afterPut(orgId, plugin, view.enabled);
    });
    return view;
  }

  /**
   * The rules of a write that switches: newly enabling an extension from the platform catalog
   * re-checks the item policy and grants (C22; one already enabled is unaffected), enabling needs
   * the dependencies enabled, disabling (without `force`) no enabled dependents.
   */
  private async assertSwitchRules(
    t: KernelSchemaDb,
    orgId: string,
    manifest: ExtensionManifest,
    input: OrgExtensionInput,
    row: { enabled: boolean } | undefined,
    required: boolean,
    opts: OrgExtensionPutOptions,
  ): Promise<void> {
    const plugin = manifest.name;
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
    actorAccountId: string | null,
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
    items: readonly ExtensionPluginItem[] | undefined,
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
      orgConfigSchema: schema ? this.formSchema(m.name, m.version, schema) : null,
      available: true,
      required,
      ...scopeFields(items, required),
      overrideState: [...fieldLevels(m.config?.deployment).values()].includes("override")
        ? "following"
        : "none",
      needsConfig:
        schema !== undefined &&
        orgConfigIncomplete(schema, config, (p) => setKeys.has(secretKey(m.name, p))),
    };
  }

  /**
   * The org schema's form JSON Schema, a copy (`x-ui` stripped when its hints are invalid; the host
   * warns at load). Never throws: a hint conversion that throws serves the plain schema, or null
   * (one warning per schema on this replica), so one hand-made package cannot fail the org's list.
   */
  private formSchema(plugin: string, version: string, schema: z.ZodTypeAny): JsonSchema | null {
    const r = safeConfigFormSchema(schema, "org", (err, fallback) =>
      this.log.warn(
        "the org config form schema could not be built with its UI hints; hints dropped",
        { plugin, version, schema: fallback, err },
      ),
    );
    return r ? structuredClone(r.schema) : null;
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

/**
 * Whether an org may see an extension with these live catalog items (`listed`: the items whose
 * `named` list has the org): one visible item is enough; without an item (config-declared, or its
 * items deleted) it is visible. A builtin item counts as `all`.
 */
function itemsVisible(
  items: readonly ExtensionPluginItem[] | undefined,
  listed: ReadonlySet<string>,
): boolean {
  if (!items) return true;
  return items.some((i) => visibleTo({ scope: i.builtin ? "all" : i.scope }, listed.has(i.id)));
}

/**
 * Whether the org sees `plugin` in its extension list (a required bootstrap plugin always; else
 * under its catalog items' scope, as {@link OrgExtensionConfigs.list} filters). `db` may be a
 * transaction.
 */
export async function extensionVisibleTo(
  db: KernelSchemaDb,
  orgId: string,
  plugin: string,
): Promise<boolean> {
  if ((await requiredExtensions(db)).has(plugin)) return true;
  const items = (await pluginItemsOf(db, [plugin])).get(plugin);
  if (!items) return true;
  const listed = new Set(
    (
      await db
        .selectFrom("catalog_item_scope_orgs")
        .select("item_id")
        .where("org_id", "=", orgId)
        .where(
          "item_id",
          "in",
          items.map((i) => i.id),
        )
        .execute()
    ).map((r) => r.item_id),
  );
  return itemsVisible(items, listed);
}

/**
 * The stored org-only config does not satisfy the org schema (a required field missing): what the
 * org form reports before any edit. A set secret is not decrypted here; issues on it or below it
 * are ignored (it was validated when written).
 */
function orgConfigIncomplete(
  schema: z.ZodTypeAny,
  plain: Obj | null,
  secretSet: (path: string) => boolean,
): boolean {
  const r = schema.safeParse(plain ?? {});
  if (r.success) return false;
  const secrets = secretPaths(schema).filter(secretSet);
  return toIssues(r.error).some(
    (i) => !secrets.some((p) => i.path === p || i.path.startsWith(`${p}.`)),
  );
}

const requiredError = (plugin: string) =>
  new ApiError(
    "extension.required",
    `Extension ${plugin} is required by this deployment (a bootstrap plugin): it is enabled in every organization and cannot be disabled`,
  );
