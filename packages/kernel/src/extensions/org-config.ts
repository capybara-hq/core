import {
  EXTENSION_POINTS,
  type ExtensionManifest,
  parseExtensionPoint,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import {
  assertItemInstallable,
  assertPluginSourcesInstallable,
  disabledPluginItems,
  pluginItemDisabled,
} from "../catalog/request-rules.js";
import type { PluginScope } from "../catalog/scope.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { OrgLock } from "../orgs/org-lock.js";
import { EffectiveConfigs } from "./effective-config.js";
import { alwaysOnExtensions, enabledExtensionsQuery, requiredExtensions } from "./enabled.js";
import { ExtensionHost } from "./host.js";
import { ExtensionInstalls } from "./installs.js";
import { fieldLevels } from "./org-levels.js";
import type { PermissionSet } from "./permission-set.js";
import {
  type DeploymentExtensionStatus,
  type PermissionGroup,
  permissionGroups,
} from "./permission-view.js";
import {
  type ExtensionPluginItem,
  itemLocked,
  itemsVisible,
  offeredToOrg,
  pluginItemsOf,
  scopeListedFor,
} from "./plugin-items.js";
import { ExtensionAvailability, type ExtensionUnavailableReason } from "./unavailable.js";

/**
 * An org's view of one extension: its state in the org, never a config value (an org's config is
 * its copy of the overridable deployment fields, read through the overrides route).
 */
export interface OrgExtensionView {
  plugin: string;
  version: string;
  enabled: boolean;
  /**
   * The org can configure it: its deployment schema has at least one org-overridable field (spec
   * §5.4). False when unavailable.
   */
  configurable: boolean;
  /** 插件要用的权限，按类别分组并标出敏感项（密钥、公开路由、工具、hook）。 */
  permissions: PermissionGroup[];
  /**
   * 插件此刻在部署上可用（已加载）。false：已安装但在部署上停用（或尚未加载），组织页显示「不可用」，
   * 组织的启用开关保留不变（不能修改），其余字段为空。
   */
  available: boolean;
  /**
   * The extension's status on the deployment, as the admin console derives it
   * (`deriveExtensionStatus`): `enabled` when it is loaded here; otherwise why not.
   */
  status: DeploymentExtensionStatus;
  /**
   * Only when unavailable: why it cannot be used (spec §14.5 item 4), e.g.
   * `needs_deployment_config`. State only, never a config value or field name.
   */
  reason?: ExtensionUnavailableReason;
  /**
   * A required bootstrap plugin: enabled in every org (`enabled` is always true) and cannot be
   * disabled here (`extension.required`); its overridable fields can still be copied. An
   * extension of a builtin plugin is enabled in every org as well (`enabled.ts`) without being
   * required: it is locked by its plugin (`switchable` false, `plugin.scope_locked`).
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
   * for the org is not valid. Always false when unavailable.
   */
  needsConfig: boolean;
}

/** The extension points an extension provides, from its permission list's `provides` group. */
export function providesOf(view: Pick<OrgExtensionView, "permissions">): string[] {
  return view.permissions.filter((g) => g.category === "provides").flatMap((g) => g.items);
}

/** The input of `put`: enablement only. */
export interface OrgExtensionInput {
  enabled?: boolean | undefined;
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
   * written (no audit) and `skipped` is set to true. "Enabled before" and
   * "enabled now" are decided under the lock, so a concurrent enable cannot race it. A caller that
   * records the extension in the same transaction (the catalog install, `put` joins its
   * transaction) reads `skipped` after `put` returns: no concurrent uninstall fits in between.
   */
  ifDisabled?: { skipped: boolean };
  /** Merged into the audit detail (a Platform operation's `via: "agent"`). */
  auditDetail?: Record<string, unknown>;
}

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

/**
 * Org-level extension enablement (`capybara.extension_org_configs.enabled`) and the org's view of
 * each extension. An org's config of an extension is its copy of the overridable deployment fields
 * (`OrgOverrides`, `EffectiveConfigs`); the retired `config` column and the `plugin-config:` org
 * secrets are neither read nor written (spec §5.4; dropped by a later contract migration).
 * No in-process state: every call reads PG, safe with multiple replicas.
 */
@Injectable()
export class OrgExtensionConfigs {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(ExtensionHost) private readonly host: ExtensionHost,
    /** The org row lock (orgs/org-lock.ts): joins the transaction. */
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    /** Install records (any desired state): the ones not loaded are listed unavailable (T14). */
    @Inject(ExtensionInstalls) private readonly installs: ExtensionInstalls,
    /** `extension.org-disabled` after a disable commits (channel connections drop at once). */
    @Inject(KernelEvents) private readonly events: KernelEvents,
    /** The effective deployment config of each org (spec A §6): read for `needsConfig`. */
    @Inject(EffectiveConfigs) private readonly effective: EffectiveConfigs,
    /** Why an installed extension is not loaded (`status` / `reason` of the unavailable ones). */
    @Inject(ExtensionAvailability) private readonly availability: ExtensionAvailability,
  ) {}

  /** The kernel-schema handle of the current transaction. */
  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** After a write committed: a disabled extension's channel connections drop at once. */
  private async afterPut(orgId: string, plugin: string, enabled: boolean): Promise<void> {
    if (!enabled) await this.events.emit("extension.org-disabled", { orgId, plugin });
  }

  /**
   * The state of every loaded extension the org sees, in load order (no row: `enabled` false),
   * then the installed extensions not loaded right now (disabled on the deployment and the like)
   * as `available: false`, sorted by name. The rows are read in a `requires_new` snapshot on a
   * second pool connection: never call it inside a transaction that holds a pool connection
   * (unlike {@link get}, it does not join one).
   */
  async list(orgId: string): Promise<OrgExtensionView[]> {
    const installed = (await this.installs.list()).map((r) => ({
      name: r.name,
      version: r.version,
    }));
    const views = await this.listSnapshot(orgId, installed);
    const why = await this.availability.unavailable(
      views.filter((v) => !v.available).map((v) => v.plugin),
    );
    for (const v of views) {
      const u = why.get(v.plugin);
      if (v.available || u === undefined || u.status === null) continue;
      v.status = u.status;
      v.reason = u.reason;
    }
    return this.withLayers(orgId, views);
  }

  /**
   * Fills `overrideState` and `needsConfig` (spec A §6: the effective config alone) for the views
   * of extensions with overridable fields (the others always run with the platform's config, which
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
      v.needsConfig = !(await this.effective.get(orgId, v.plugin)).ok;
    }
    return views;
  }

  /**
   * `REPEATABLE READ` read-only: the enablement rows and the plugin items come from one snapshot.
   * It is `requires_new`: it always takes a second pool connection, so never call `list` inside a
   * transaction that holds one (a locked transaction waiting on the pool can starve it; `get`
   * joins the caller's transaction instead).
   */
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
      .select(["plugin", "enabled"])
      .where("org_id", "=", orgId)
      .execute();
    // Required bootstrap plugins and builtin plugins' extensions are listed enabled (no org
    // config row needed, spec §7; enabled.ts)
    const required = await requiredExtensions(t);
    const on = await alwaysOnExtensions(t);
    const loaded = this.host.manifests();
    const items = await pluginItemsOf(t, [
      ...loaded.map((m) => m.name),
      ...installed.map((i) => i.name),
    ]);
    // An extension the org is not offered (a `named` plugin without it, or one off here whose
    // item the super admin disabled) is absent: the rule readiness shares
    const listed = await scopeListedFor(t, orgId);
    const seen = (name: string) =>
      offeredToOrg({
        required: required.has(name),
        enabled: on.has(name) || (rows.find((r) => r.plugin === name)?.enabled ?? false),
        items: items.get(name),
        listed,
      });
    const views = loaded
      .filter((m) => seen(m.name))
      .map((m) =>
        this.view(
          m,
          rows.find((r) => r.plugin === m.name),
          required.has(m.name),
          items.get(m.name),
          on.has(m.name),
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
          enabled: on.has(i.name) || (rows.find((r) => r.plugin === i.name)?.enabled ?? false),
          configurable: false,
          permissions: [],
          available: false,
          // filled in by `list` from the replicas' reports
          status: "converging",
          reason: "loading",
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
   * Writes enablement. The actor's role is re-read under the org row lock (needs
   * `org.extensions.manage`).
   * - Extension not loaded -> `extension.not_found`; `enabled: false` for a required bootstrap
   *   plugin -> `extension.required` (it stays enabled in every org).
   * - Enabling never checks a config: an extension whose effective config is not valid for the org
   *   is enabled and reported `needsConfig` (spec A §6: it gets no org-bound call until then).
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
    const t = this.db;
    await this.orgLock.lockFor(orgId, actorAccountId, "org.extensions.manage");
    const row = await t
      .selectFrom("extension_org_configs")
      .select(["enabled"])
      .where("plugin", "=", plugin)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    const required = (await requiredExtensions(t)).has(plugin);
    // Always on (required, or its plugin is builtin): enabled in every org (enabled.ts)
    const on = required || (await alwaysOnExtensions(t)).has(plugin);
    const item = (await pluginItemsOf(t, [plugin])).get(plugin);
    if (required && input.enabled === false) throw requiredError(plugin);
    if (on && input.enabled === false) throw scopeLockedError();
    if (opts.ifDisabled && (row?.enabled === true || on)) {
      opts.ifDisabled.skipped = true;
      return this.view(manifest, row, required, item, on);
    }
    // An always-on extension is enabled whatever the row said (it may predate `required` / builtin)
    const enabled = on || (input.enabled ?? row?.enabled ?? false);
    await this.assertSwitchRules(t, orgId, manifest, input, row, on, opts);
    await t
      .insertInto("extension_org_configs")
      .values({ plugin, org_id: orgId, enabled, updated_by: actorAccountId })
      .onConflict((oc) =>
        oc.columns(["plugin", "org_id"]).doUpdateSet({
          enabled,
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
        ...(opts.viaItem !== undefined && { catalogItemId: opts.viaItem }),
        ...opts.auditDetail,
      },
    });
    const view = this.view(manifest, { enabled }, required, item, on);
    // Only once the root transaction committed (an outer caller's too): a rolled-back write
    // disconnects nothing
    afterCommit(async () => {
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
    alwaysOn: boolean,
    opts: OrgExtensionPutOptions,
  ): Promise<void> {
    const plugin = manifest.name;
    if (input.enabled === true && row?.enabled !== true && !alwaysOn) {
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
   * Whether `plugin` is enabled in the org: an always-on extension (a required bootstrap plugin, or
   * its plugin is builtin: `enabled.ts`) is enabled without a row; no row otherwise -> undefined.
   * Inside a caller's transaction it reads in that transaction (it sees the caller's uncommitted
   * writes). The extension's config for the org is its effective config ({@link EffectiveConfigs}).
   */
  async get(orgId: string, plugin: string): Promise<{ enabled: boolean } | undefined> {
    this.manifest(plugin);
    const t = this.db;
    const row = await t
      .selectFrom("extension_org_configs")
      .select(["enabled"])
      .where("plugin", "=", plugin)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    const on = (await alwaysOnExtensions(t)).has(plugin);
    if (!row && !on) return undefined;
    return { enabled: on || row?.enabled === true };
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
    // An always-on extension (required, or its plugin is builtin) stays enabled in every org
    if ((await alwaysOnExtensions(t)).has(plugin)) return false;
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
      detail: { enabled: false, reason },
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
    row: { enabled: boolean } | undefined,
    required: boolean,
    items: readonly ExtensionPluginItem[] | undefined,
    /** Always on in every org (enabled.ts): required, or its plugin is builtin. */
    alwaysOn: boolean,
  ): OrgExtensionView {
    const configurable = [...fieldLevels(m.config?.deployment).values()].includes("override");
    return {
      plugin: m.name,
      version: m.version,
      enabled: alwaysOn || (row?.enabled ?? false),
      configurable,
      permissions: permissionGroups(this.permissionsOf(m.name)),
      available: true,
      status: "enabled",
      required,
      ...scopeFields(items, required),
      // filled in by `withLayers` (the copy rows and the effective config)
      overrideState: configurable ? "following" : "none",
      needsConfig: false,
    };
  }
}

/**
 * Whether the org may see `plugin` (a required bootstrap plugin always; else under its catalog
 * items' scope; the list also hides one off here whose item is disabled, {@link offeredToOrg}).
 * `db` may be a transaction.
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

const scopeLockedError = () =>
  new ApiError(
    "plugin.scope_locked",
    "This plugin is built in: it is on for every organization and cannot be switched off here",
  );

const requiredError = (plugin: string) =>
  new ApiError(
    "extension.required",
    `Extension ${plugin} is required by this deployment (a bootstrap plugin): it is enabled in every organization and cannot be disabled`,
  );
