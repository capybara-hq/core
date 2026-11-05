import { createHash } from "node:crypto";
import type { PluginManifest } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock } from "../orgs/org-lock.js";
import { can, roleAtLeast } from "../orgs/roles.js";
import { packagePath } from "../packages/tgz.js";
import { StorageService } from "../storage/storage.service.js";
import {
  type CatalogIcon,
  type CatalogVersionFiles,
  catalogHasIcon,
  findConnectorIn,
  type OrgCatalogDetail,
  type OrgCatalogItem,
  type OrgInstallInput,
  type OrgInstallResult,
  type OrgUpgradeResult,
  orgTemplateView,
  readCatalogIcon,
  readCatalogTemplates,
  type TemplateDeps,
  templatePluginProblem,
} from "./catalog-content.js";
import { itemView } from "./catalog-items.js";
import { PluginInstaller, type UninstallPreview } from "./plugin-install.js";
import { type PluginUpgradeInput, PluginUpgrader, type UpgradePreview } from "./plugin-upgrade.js";
import { type OrgPluginState, switchable, visibleTo, wantedOn } from "./scope.js";
import { upgradeInfo } from "./upgrade-targets.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const itemNotFound = () => new ApiError("catalog.item_not_found", "Catalog item not found");
const pluginDisabled = () =>
  new ApiError(
    "plugin.disabled",
    "This plugin is disabled by the enterprise admin and cannot be switched on",
  );

/** The result of a switch: the item, or (switching off without `confirm`) the uninstall preview. */
export type SwitchResult =
  | { kind: "done"; item: OrgCatalogItem }
  | { kind: "preview"; preview: UninstallPreview; confirm: string };

/** The confirm hash of an uninstall preview: sha256 over its sorted JSON (the scheme of `diffHash`). */
function previewHash(p: UninstallPreview): string {
  const by = <T extends { kind: string; ref: string }>(xs: T[]) =>
    [...xs].sort((a, b) => `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`));
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...p,
        components: by(p.components),
        kept: by(p.kept),
        agents: [...p.agents]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((a) => ({ ...a, uses: by(a.uses) })),
      }),
    )
    .digest("hex");
}

/**
 * Organizations see the enterprise catalog with the plugin scope rules applied (plugin and component
 * management spec §5): a plugin is `all` (on in every org), `optional` (an org admin switches it on),
 * or `named` (offered to the listed orgs). Members get the list read-only; org admins switch a
 * plugin on (an install by {@link PluginInstaller}, with its dependencies; the union of the
 * component actions of the plugins it brings in is re-checked inside the org row lock) or off (an
 * uninstall, after a preview they confirm with its hash). Disabled item -> `plugin.disabled`; a
 * dependency unresolved / disabled / in a cycle -> `catalog.dependency_*`; an extension or a
 * template's connector not on the deployment -> `catalog.not_deployed`. No in-process state.
 */
@Injectable()
export class OrgCatalogService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    /** The org row lock (orgs/org-lock.ts): joins the caller's transaction. */
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(ExtensionRegistry) private readonly registry: ExtensionRegistry,
    @Inject(PluginInstaller) private readonly pluginInstaller: PluginInstaller,
    @Inject(PluginUpgrader) private readonly pluginUpgrader: PluginUpgrader,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /** The kernel-schema handle of the current context (the transaction, else the pool). */
  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * The org's view of the items: items the org may not see (`named` without it on the list) are
   * absent; disabled ones are shown to admins as `unavailable` and absent for members.
   */
  async list(orgId: string, accountId: string, itemId?: string): Promise<OrgCatalogItem[]> {
    const m = await this.db
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    const isAdmin = m !== undefined && roleAtLeast(m.role, "admin");
    let q = this.db
      .selectFrom("catalog_items")
      .selectAll()
      .where("deleted_at", "is", null)
      .orderBy("name")
      .orderBy("id");
    if (itemId !== undefined) q = q.where("id", "=", itemId);
    if (!isAdmin) q = q.where("disabled", "=", false);
    const all = await q.execute();
    const [listed, switches] = await Promise.all([
      this.db
        .selectFrom("catalog_item_scope_orgs")
        .select("item_id")
        .where("org_id", "=", orgId)
        .execute(),
      this.db
        .selectFrom("catalog_item_org_switches")
        .select(["item_id", "enabled"])
        .where("org_id", "=", orgId)
        .execute(),
    ]);
    const inList = new Set(listed.map((r) => r.item_id));
    const items = all.filter((i) =>
      visibleTo({ scope: i.builtin ? "all" : i.scope }, inList.has(i.id)),
    );
    if (items.length === 0) return [];
    const sw = new Map(switches.map((r) => [r.item_id, r.enabled]));
    const ids = items.map((i) => i.id);
    const [versions, pluginInstalls, configs] = await Promise.all([
      this.db
        .selectFrom("catalog_item_versions")
        .select(["item_id", "version", "source", "manifest", "object_prefix", "files"])
        .where("item_id", "in", ids)
        .execute(),
      this.db
        .selectFrom("plugin_installs")
        .select(["id", "item_id", "version"])
        .where("org_id", "=", orgId)
        .where("status", "in", ["installing", "installed", "upgrading"])
        .execute(),
      this.db
        .selectFrom("extension_org_configs")
        .select("plugin")
        .where("org_id", "=", orgId)
        .where("config", "is not", null)
        .execute(),
    ]);
    const upgrades = await upgradeInfo(
      this.db,
      this.registry,
      pluginInstalls.flatMap((a) => {
        const item = items.find((i) => i.id === a.item_id);
        return item ? [{ itemId: a.item_id, name: item.name, version: a.version }] : [];
      }),
    );
    const undeployed = await this.undeployed(
      items.flatMap((i) => {
        const v = versions.find((x) => x.item_id === i.id && x.version === i.latest_version);
        return v ? [v] : [];
      }),
    );
    const configured = new Set(configs.map((c) => c.plugin));
    const loaded = new Map(this.registry.manifests().map((x) => [x.name, x]));
    const out: OrgCatalogItem[] = [];
    for (const i of items) {
      const vs = versions.filter((v) => v.item_id === i.id);
      const {
        installs: _installs,
        marketplaceId: _source,
        latestMarketplaceVersion: _latest,
        newerInMarketplace: _newer,
        ...view
      } = itemView(i, vs);
      const latest = vs.find((v) => v.version === i.latest_version);
      const a = pluginInstalls.find((x) => x.item_id === i.id);
      const scope = i.builtin ? "all" : i.scope;
      const wanted = wantedOn(i, inList.has(i.id), sw.get(i.id) ?? null);
      let state: OrgPluginState;
      if (i.disabled) state = "unavailable";
      else if (a || i.builtin) state = "on";
      else if (!wanted) state = "off";
      else {
        const m = latest?.manifest as PluginManifest | undefined;
        const ext = m?.extension ? loaded.get(m.name) : undefined;
        const needsInputs =
          (m?.connectorTemplates ?? []).length > 0 ||
          (m?.extension !== undefined &&
            ext?.config?.org !== undefined &&
            !ext.config.org.safeParse({}).success &&
            !configured.has(m.name));
        state = needsInputs ? "needs_config" : "on";
      }
      out.push({
        ...view,
        scope,
        builtin: i.builtin,
        state,
        switchable: switchable({ scope, builtin: i.builtin }),
        notDeployed: latest !== undefined && undeployed.has(i.id),
        installed: a
          ? {
              pluginInstallId: a.id,
              version: a.version,
              upgradeAvailable: upgrades.get(`${a.item_id}@${a.version}`)?.upgradeAvailable ?? null,
            }
          : null,
      });
    }
    return out;
  }

  /**
   * Item detail (for the install wizard): the same view as the list (members don't see disabled
   * items, not visible means `catalog.item_not_found`), plus the latest version's extension,
   * connector templates (endpoint preset, editable paths, auth preset), dependencies, skills and
   * agent templates.
   */
  async detail(orgId: string, accountId: string, itemId: string): Promise<OrgCatalogDetail> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    const [item] = await this.list(orgId, accountId, itemId);
    if (!item) throw itemNotFound();
    const v = await this.db
      .selectFrom("catalog_item_versions")
      .select(["manifest", "object_prefix", "files"])
      .where("item_id", "=", itemId)
      .where("version", "=", item.latestVersion)
      .executeTakeFirst();
    if (!v) throw itemNotFound();
    const m = v.manifest as PluginManifest;
    return {
      item,
      hasIcon: m.icon !== undefined,
      extension: m.extension ? m.name : null,
      templates: (await readCatalogTemplates(this.storage, v)).map((t) =>
        orgTemplateView(t.id, t.file),
      ),
      dependencies: (m.dependencies ?? []).map((d) => ({ name: d.name, range: d.version })),
      skills: (m.skills ?? []).map((s) => packagePath(s.path)),
      agents: (m.agents ?? []).map((a) => packagePath(a.path)),
    };
  }

  /**
   * The item's icon; members don't see disabled items (-> `catalog.item_not_found`, decided before
   * reading storage).
   */
  icon(itemId: string, isAdmin: boolean): Promise<CatalogIcon> {
    return readCatalogIcon(this.db, this.storage, itemId, isAdmin);
  }

  /** For the admin item detail: whether the latest version has an icon. */
  hasIcon(itemId: string): Promise<boolean> {
    return catalogHasIcon(this.db, itemId);
  }

  /**
   * The items (latest versions) this replica cannot install now: the plugin's extension is not
   * loaded, or a connector template's connector extension is not (or not at the template's
   * `pluginVersion`). Dependencies are judged at install. A template that cannot be read counts as
   * deployed here (the install reads it again).
   */
  private async undeployed(
    versions: ({ item_id: string } & CatalogVersionFiles)[],
  ): Promise<Set<string>> {
    const loaded = new Map(this.registry.manifests().map((m) => [m.name, m.version]));
    const deps: TemplateDeps = {
      findConnector: (plugin, kind) => findConnectorIn(this.registry, plugin, kind),
      pluginVersion: (n) => loaded.get(n),
    };
    const out = new Set<string>();
    await Promise.all(
      versions.map(async (v) => {
        const m = v.manifest as PluginManifest;
        if (m.extension && !loaded.has(m.name)) {
          out.add(v.item_id);
          return;
        }
        if ((m.connectorTemplates ?? []).length === 0) return;
        try {
          const templates = await readCatalogTemplates(this.storage, v);
          if (templates.some((t) => templatePluginProblem(deps, t.file.template) !== undefined)) {
            out.add(v.item_id);
          }
        } catch (e) {
          // Unreadable here: counted as deployed, the install reports it
          this.log.warn("catalog template read failed in the org list", {
            itemId: v.item_id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }),
    );
    return out;
  }

  /**
   * Installs a plugin in the org (the old install route, an alias of switching it on): the role
   * first, then item errors (a member cannot probe a disabled item through error codes), then the
   * installer. Records the org's switch as on.
   */
  async install(
    orgId: string,
    actor: string,
    itemId: string,
    body: OrgInstallInput,
    actorTokenId?: string,
  ): Promise<OrgInstallResult> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    await this.assertCanInstall(orgId, actor);
    const item = await this.visibleItem(orgId, itemId);
    const version = body.version ?? item.latest_version;
    const v = await this.db
      .selectFrom("catalog_item_versions")
      .select("version")
      .where("item_id", "=", itemId)
      .where("version", "=", version)
      .executeTakeFirst();
    if (!v)
      throw new ApiError("catalog.item_not_found", `Version ${version} of this item not found`);
    const opts = actorTokenId !== undefined ? { actorTokenId } : {};
    if (item.disabled) throw pluginDisabled();
    // Dependencies resolved, extensions deployed, template connectors available
    await this.pluginInstaller.preflight(orgId, actor, itemId, version);
    const { version: _version, ...input } = body;
    const view = await this.pluginInstaller.install(orgId, actor, itemId, version, input, opts);
    await this.recordSwitch(orgId, actor, itemId, true);
    return {
      status: 201,
      installed: { itemId, version, pluginInstallId: view.id },
      install: view,
    };
  }

  /** The item when the org may see it (scope), else `catalog.item_not_found`. */
  private async visibleItem(orgId: string, itemId: string) {
    const item = await this.db
      .selectFrom("catalog_items")
      .selectAll()
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!item) throw itemNotFound();
    const listed = await this.db
      .selectFrom("catalog_item_scope_orgs")
      .select("item_id")
      .where("item_id", "=", itemId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!visibleTo({ scope: item.builtin ? "all" : item.scope }, listed !== undefined)) {
      throw itemNotFound();
    }
    return item;
  }

  /** The org's live plugin install of the item, if any. */
  private liveInstall(orgId: string, itemId: string) {
    return this.db
      .selectFrom("plugin_installs")
      .select("id")
      .where("org_id", "=", orgId)
      .where("item_id", "=", itemId)
      .where("status", "in", ["installing", "installed", "upgrading"])
      .executeTakeFirst();
  }

  /**
   * The org admin's switch of a plugin (`PUT catalog/:itemId/switch`). On: installs it (or just
   * records the switch when it is installed already). Off: refused for `all` and builtin items
   * (`plugin.scope_locked`); without `confirm` returns the uninstall preview and its hash, with the
   * hash of the current preview uninstalls (a changed preview -> `plugin.switch_stale`). The switch
   * row is written after the install / uninstall.
   */
  async setSwitch(
    orgId: string,
    actor: string,
    itemId: string,
    body: { enabled: true; inputs?: OrgInstallInput } | { enabled: false; confirm?: string },
    actorTokenId?: string,
  ): Promise<SwitchResult> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    await this.assertCanInstall(orgId, actor);
    const item = await this.visibleItem(orgId, itemId);
    const opts = actorTokenId !== undefined ? { actorTokenId } : {};
    if (body.enabled) {
      if (item.disabled) throw pluginDisabled();
      if ((await this.liveInstall(orgId, itemId)) !== undefined) {
        await this.recordSwitch(orgId, actor, itemId, true);
      } else {
        await this.install(orgId, actor, itemId, body.inputs ?? {}, actorTokenId);
      }
      return { kind: "done", item: await this.itemOf(orgId, actor, itemId) };
    }
    if (!switchable({ scope: item.scope, builtin: item.builtin })) {
      throw new ApiError(
        "plugin.scope_locked",
        "This plugin is on for every organization and cannot be switched off here",
      );
    }
    const live = await this.liveInstall(orgId, itemId);
    if (live === undefined) {
      await this.recordSwitch(orgId, actor, itemId, false);
      return { kind: "done", item: await this.itemOf(orgId, actor, itemId) };
    }
    const preview = await this.pluginInstaller.previewUninstall(orgId, live.id);
    const confirm = previewHash(preview);
    if (body.confirm === undefined) return { kind: "preview", preview, confirm };
    if (body.confirm !== confirm) {
      throw new ApiError(
        "plugin.switch_stale",
        "The uninstall preview changed; review it and confirm again",
      );
    }
    await this.pluginInstaller.uninstall(orgId, actor, live.id, opts);
    await this.recordSwitch(orgId, actor, itemId, false);
    return { kind: "done", item: await this.itemOf(orgId, actor, itemId) };
  }

  private async itemOf(orgId: string, accountId: string, itemId: string): Promise<OrgCatalogItem> {
    const [item] = await this.list(orgId, accountId, itemId);
    if (!item) throw itemNotFound();
    return item;
  }

  /** Writes the org's switch row of the item. */
  @Transactional()
  private async recordSwitch(
    orgId: string,
    actor: string,
    itemId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.db
      .insertInto("catalog_item_org_switches")
      .values({ item_id: itemId, org_id: orgId, enabled, updated_by: actor })
      .onConflict((oc) =>
        oc.columns(["item_id", "org_id"]).doUpdateSet({
          enabled,
          updated_by: actor,
          updated_at: sql<Date>`now()` as unknown as Date,
        }),
      )
      .execute();
  }

  /** The upgrade preview of an org install (spec §10, see `PluginUpgrader`). */
  async upgradePreview(
    orgId: string,
    actor: string,
    installId: string,
    version: string,
  ): Promise<UpgradePreview> {
    await this.assertCanInstall(orgId, actor);
    return this.pluginUpgrader.preview(orgId, actor, installId, version);
  }

  /**
   * Upgrades an org install in place (spec §10, Decision 11): the preview's `diffHash` is checked
   * first (`plugin.upgrade_stale`); the item disabled -> `catalog.item_disabled`.
   */
  async upgrade(
    orgId: string,
    actor: string,
    installId: string,
    body: PluginUpgradeInput,
    actorTokenId?: string,
  ): Promise<OrgUpgradeResult> {
    await this.assertCanInstall(orgId, actor);
    const opts = actorTokenId !== undefined ? { actorTokenId } : {};
    const { diff } = await this.pluginUpgrader.check(orgId, actor, installId, body);
    return {
      status: 200,
      install: await this.pluginUpgrader.upgrade(orgId, actor, installId, body, opts, diff),
    };
  }

  /** The actor can install something in the org (forbidden otherwise), checked before item errors. */
  @Transactional()
  private async assertCanInstall(orgId: string, actor: string): Promise<void> {
    const { role } = await this.orgLock.lockAndAuthorize(orgId, actor, "catalog.read");
    const canAny = (["org.extensions.manage", "connectors.manage", "skills.manage"] as const).some(
      (a) => can(role, a),
    );
    if (!canAny) throw new ApiError("forbidden", "Insufficient organization role");
  }
}
