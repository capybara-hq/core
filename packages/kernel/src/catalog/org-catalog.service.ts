import type { PluginManifest } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock } from "../orgs/org-lock.js";
import { can, type OrgAction, roleAtLeast } from "../orgs/roles.js";
import { packagePath } from "../packages/tgz.js";
import { StorageService } from "../storage/storage.service.js";
import {
  type CatalogIcon,
  type CatalogVersionFiles,
  catalogHasIcon,
  findConnectorIn,
  lockOrgForActions,
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
import { PluginInstaller } from "./plugin-install.js";
import { type PluginUpgradeInput, PluginUpgrader, type UpgradePreview } from "./plugin-upgrade.js";
import { CatalogRequestsService } from "./requests.service.js";
import { upgradeInfo } from "./upgrade-targets.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const itemNotFound = () => new ApiError("catalog.item_not_found", "Catalog item not found");
const itemDisabled = () =>
  new ApiError(
    "catalog.item_disabled",
    "This catalog item is disabled by the enterprise admin and cannot be newly installed",
  );

/**
 * Organizations browse and install from the enterprise catalog (C22): members browse (without
 * disabled items) and request, org admins install. Every item is a plugin, installed with its
 * dependencies by {@link PluginInstaller}; installing requires the union of the component actions
 * of the plugins it brings in ({@link requiredActions}), re-checked inside the org row lock; item
 * disabled -> `catalog.item_disabled`; a dependency unresolved / disabled / in a cycle ->
 * `catalog.dependency_*`; an extension or a template's connector not on the deployment ->
 * `catalog.not_deployed`; needs_approval without a grant -> a stage deployment request (HTTP 202;
 * dependencies are not approved separately, spec §10). No in-process state.
 */
@Injectable()
export class OrgCatalogService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    /** The org row lock (orgs/org-lock.ts; R12): joins the caller's transaction. */
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(ExtensionRegistry) private readonly registry: ExtensionRegistry,
    @Inject(CatalogRequestsService) private readonly requests: CatalogRequestsService,
    @Inject(PluginInstaller) private readonly pluginInstaller: PluginInstaller,
    @Inject(PluginUpgrader) private readonly pluginUpgrader: PluginUpgrader,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /** The kernel-schema handle of the current context (the transaction, else the pool). */
  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** The org's view of the items; members (not admins) don't see disabled items. */
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
    if (!isAdmin) q = q.where("policy", "<>", "disabled");
    const items = await q.execute();
    if (items.length === 0) return [];
    const ids = items.map((i) => i.id);
    const [versions, grants, requests, pluginInstalls] = await Promise.all([
      this.db
        .selectFrom("catalog_item_versions")
        .select(["item_id", "version", "source", "manifest", "object_prefix", "files"])
        .where("item_id", "in", ids)
        .execute(),
      this.db
        .selectFrom("catalog_org_grants")
        .select("item_id")
        .where("org_id", "=", orgId)
        .execute(),
      this.requests.latestByItem(orgId),
      this.db
        .selectFrom("plugin_installs")
        .select(["id", "item_id", "version"])
        .where("org_id", "=", orgId)
        .where("status", "in", ["installing", "installed", "upgrading"])
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
    const granted = new Set(grants.map((g) => g.item_id));
    const undeployed = await this.undeployed(
      items.flatMap((i) => {
        const v = versions.find((x) => x.item_id === i.id && x.version === i.latest_version);
        return v ? [v] : [];
      }),
    );
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
      let installable: OrgCatalogItem["installable"];
      if (i.policy === "disabled") installable = "disabled";
      else if (latest && undeployed.has(i.id)) {
        installable = "not_deployed";
      } else if (i.policy === "needs_approval") {
        installable = granted.has(i.id) ? "granted" : "needs_approval";
      } else installable = "yes";
      const a = pluginInstalls.find((x) => x.item_id === i.id);
      out.push({
        ...view,
        installable,
        installed: a
          ? {
              pluginInstallId: a.id,
              version: a.version,
              upgradeAvailable: upgrades.get(`${a.item_id}@${a.version}`)?.upgradeAvailable ?? null,
            }
          : null,
        request: requests.get(i.id) ?? null,
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

  /** Installs a plugin in the org (see the class comment). */
  async install(
    orgId: string,
    actor: string,
    itemId: string,
    body: OrgInstallInput,
    actorTokenId?: string,
  ): Promise<OrgInstallResult> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    // The role first (forbidden when it can install nothing), then item errors: a member cannot
    // probe the existence or versions of a disabled item through error codes
    await this.assertCanInstall(orgId, actor);
    const item = await this.db
      .selectFrom("catalog_items")
      .selectAll()
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!item) throw itemNotFound();
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
    if (item.policy === "disabled") throw itemDisabled();
    // Dependencies resolved, extensions deployed, template connectors available: before a request
    // is created. The actions are the union over the plugins the install brings in
    const { actions } = await this.pluginInstaller.preflight(orgId, actor, itemId, version);

    // 1. Role and policy under the lock; needs_approval without a grant -> a request (202). Approval
    //    follows this plugin's policy only, not its dependencies' (spec §10)
    const pending = await this.requestIfNeeded(orgId, actor, item, version, actions, opts);
    if (pending !== undefined) {
      return { status: 202, request: await this.requests.view(pending) };
    }

    // 2. Install (each step re-checks the item policy in its own transaction)
    const { version: _version, ...input } = body;
    const view = await this.pluginInstaller.install(orgId, actor, itemId, version, input, opts);
    return {
      status: 201,
      installed: { itemId, version, pluginInstallId: view.id },
      install: view,
    };
  }

  /**
   * Role and policy under the org row lock; needs_approval without a grant -> a stage deployment
   * request (its id). Approval follows this plugin's policy only, not its dependencies' (spec §10).
   */
  @Transactional()
  private async requestIfNeeded(
    orgId: string,
    actor: string,
    item: { id: string; name: string },
    version: string,
    actions: OrgAction[],
    opts: { actorTokenId?: string },
  ): Promise<string | undefined> {
    const itemId = item.id;
    const t = this.db;
    await lockOrgForActions(this.orgLock, orgId, actor, actions);
    const locked = await t
      .selectFrom("catalog_items")
      .select(["policy", "deleted_at"])
      .where("id", "=", itemId)
      .forShare()
      .executeTakeFirst();
    if (!locked || locked.deleted_at !== null) throw itemNotFound();
    if (locked.policy === "disabled") throw itemDisabled();
    if (locked.policy === "needs_approval") {
      const grant = await t
        .selectFrom("catalog_org_grants")
        .select("item_id")
        .where("item_id", "=", itemId)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      if (!grant) {
        return this.requests.requestDeployment(orgId, actor, item, version, opts);
      }
    }
    return undefined;
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
   * first (`plugin.upgrade_stale`); the item disabled -> `catalog.item_disabled`; needs_approval
   * without a grant -> a stage deployment request for the target version (202; after approval the
   * org admin runs the upgrade again); otherwise the upgrade runs (200, the install view).
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
    const { itemId, actions, diff } = await this.pluginUpgrader.check(
      orgId,
      actor,
      installId,
      body,
    );
    const pending = await this.upgradeRequestIfNeeded(orgId, actor, itemId, body, actions, opts);
    if (pending !== undefined) {
      return { status: 202, request: await this.requests.view(pending) };
    }
    return {
      status: 200,
      install: await this.pluginUpgrader.upgrade(orgId, actor, installId, body, opts, diff),
    };
  }

  /** Like {@link requestIfNeeded}, for an upgrade's target version. */
  @Transactional()
  private async upgradeRequestIfNeeded(
    orgId: string,
    actor: string,
    itemId: string,
    body: PluginUpgradeInput,
    actions: OrgAction[],
    opts: { actorTokenId?: string },
  ): Promise<string | undefined> {
    const t = this.db;
    await lockOrgForActions(this.orgLock, orgId, actor, actions);
    const locked = await t
      .selectFrom("catalog_items")
      .select(["id", "name", "policy", "deleted_at"])
      .where("id", "=", itemId)
      .forShare()
      .executeTakeFirst();
    if (!locked || locked.deleted_at !== null) throw itemNotFound();
    if (locked.policy === "disabled") throw itemDisabled();
    if (locked.policy !== "needs_approval") return undefined;
    const grant = await t
      .selectFrom("catalog_org_grants")
      .select("item_id")
      .where("item_id", "=", itemId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (grant) return undefined;
    return this.requests.requestDeployment(orgId, actor, locked, body.version, opts);
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
