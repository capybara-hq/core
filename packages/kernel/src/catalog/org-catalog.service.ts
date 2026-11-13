import type { PluginManifest } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { templateGuideOf } from "../extensions/plugin-guides.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { ExtensionAvailability } from "../extensions/unavailable.js";
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
  orgTemplateView,
  type PluginUnavailableReason,
  readCatalogIcon,
  readCatalogTemplates,
  type TemplateDeps,
  templatePluginProblem,
} from "./catalog-content.js";
import { itemView, ownerOnlyFacts, versionUsable } from "./catalog-items.js";
import { connectorTemplatesOn, templateIdOfPath } from "./component-state.js";
import { itemPendingError, ownerOf, ownersOf } from "./ownership.js";
import {
  PluginInstaller,
  type UninstallPreview,
  type UninstallReport,
  uninstallPreviewHash,
  upsertOrgSwitch,
} from "./plugin-install.js";
import { type OrgPluginState, requestable, switchable, visibleTo, wantedOn } from "./scope.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const itemNotFound = () => new ApiError("catalog.item_not_found", "Catalog item not found");
const notOffered = () =>
  new ApiError(
    "catalog.approval_required",
    "This plugin is not offered to this organization; an org admin can request access",
  );
const pluginDisabled = () =>
  new ApiError(
    "plugin.disabled",
    "This plugin is disabled by the super admin and cannot be switched on",
  );

/** The result of a switch: the item, or (switching off without `confirm`) the uninstall preview. */
export type SwitchResult =
  | { kind: "done"; item: OrgCatalogItem }
  | { kind: "preview"; preview: UninstallPreview; confirm: string };

/**
 * Organizations see the platform catalog with the plugin scope rules applied (plugin and component
 * management spec §5): a plugin is `all` (on in every org unless an org admin switched it off,
 * layering spec §4), `optional` (an org admin switches it on), or `named` (offered to the listed
 * orgs). Members get the list read-only; org admins switch a plugin on (an install by
 * {@link PluginInstaller}, with its dependencies; the union of the component actions of the plugins
 * it brings in is re-checked inside the org row lock) or off (an uninstall, after a preview they
 * confirm with its hash). Disabled item -> `plugin.disabled`; a
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
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    /** Why a plugin's extension cannot run (the `unavailable` state's reason). */
    @Inject(ExtensionAvailability) private readonly availability: ExtensionAvailability,
  ) {}

  /** The kernel-schema handle of the current context (the transaction, else the pool). */
  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * The org's view of the items: a `named` item without the org on its list is `not_offered` when
   * shown to other orgs and absent otherwise; disabled ones are shown to admins as `unavailable`
   * and absent for members. Each item carries the org's pending request for it.
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
    // Hidden `named` items (not listed, not shown to other orgs) are absent; shown ones are
    // `not_offered`
    // An org upload waiting for the super admin is its owner's only (ruling P3-9)
    const items = all.filter(
      (i) =>
        (!i.awaiting_confirmation || i.owner_org_id === orgId) &&
        (visibleTo({ scope: i.builtin ? "all" : i.scope }, inList.has(i.id)) ||
          requestable(i, inList.has(i.id))),
    );
    if (items.length === 0) return [];
    const sw = new Map(switches.map((r) => [r.item_id, r.enabled]));
    const ids = items.map((i) => i.id);
    const [versions, pluginInstalls, configs, requests] = await Promise.all([
      this.db
        .selectFrom("catalog_item_versions")
        .select([
          "item_id",
          "version",
          "source",
          "source_format",
          "manifest",
          "object_prefix",
          "files",
          "applied_at",
          "rejected_at",
        ])
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
      this.db
        .selectFrom("catalog_requests")
        .select(["id", "item_id", "kind", "created_at"])
        .where("org_id", "=", orgId)
        .where("item_id", "in", ids)
        .where("kind", "in", ["access", "enable"])
        .where("status", "=", "pending")
        .orderBy("created_at")
        .execute(),
    ]);
    const pending = new Map(
      requests.map((r) => [
        r.item_id,
        { id: r.id, kind: r.kind as "access" | "enable", createdAt: r.created_at.toISOString() },
      ]),
    );
    const undeployed = await this.undeployed(
      items.flatMap((i) => {
        const v = versions.find((x) => x.item_id === i.id && x.version === i.latest_version);
        return v ? [v] : [];
      }),
    );
    const configured = new Set(configs.map((c) => c.plugin));
    const owners = await ownersOf(
      this.db,
      items.flatMap((i) => (i.owner_org_id === null ? [] : [i.owner_org_id])),
    );
    const loaded = new Map(this.registry.manifests().map((x) => [x.name, x]));
    // the extensions of the latest versions that are not loaded: why (the `unavailable` reason)
    const extensionOf = (i: (typeof items)[number]): string | undefined => {
      const v = versions.find((x) => x.item_id === i.id && x.version === i.latest_version);
      const m = v?.manifest as PluginManifest | undefined;
      return m?.extension ? m.name : undefined;
    };
    const unloaded = await this.availability.unavailable(
      items.flatMap((i) => {
        const n = extensionOf(i);
        return n === undefined ? [] : [n];
      }),
    );
    const out: OrgCatalogItem[] = [];
    for (const i of items) {
      // Another org sees only an org-owned plugin's applied version, never one its owner
      // uploaded that is pending or was rejected (ruling P3-34), nor such a version of a plugin
      // transferred to the platform since (ruling P3-52)
      const vs = versions.filter(
        (v) =>
          v.item_id === i.id &&
          (i.owner_org_id === orgId ||
            (versionUsable(v) && (i.owner_org_id === null || v.version === i.latest_version))),
      );
      const {
        installs: _installs,
        marketplaceId: _source,
        latestMarketplaceVersion: _latest,
        newerInMarketplace: _newer,
        scopeOrgs: _scopeOrgs,
        enabledOrgs: _enabledOrgs,
        offCount: _offCount,
        pending: _pending,
        shownToOthers: _shown,
        awaitingConfirmation,
        pendingVersion,
        ...view
      } = itemView(i, vs, 0, undefined, ownerOnlyFacts(ownerOf(i.owner_org_id, owners)));
      const latest = vs.find((v) => v.version === i.latest_version);
      const a = pluginInstalls.find((x) => x.item_id === i.id);
      const scope = i.builtin ? "all" : i.scope;
      const wanted = wantedOn(i, inList.has(i.id), sw.get(i.id) ?? null);
      let state: OrgPluginState;
      let reason: PluginUnavailableReason | undefined;
      const extName = extensionOf(i);
      const why = extName === undefined ? undefined : unloaded.get(extName);
      if (i.awaiting_confirmation) state = "awaiting_confirmation";
      else if (i.disabled) {
        state = "unavailable";
        reason = "plugin_disabled";
      } else if (requestable(i, inList.has(i.id))) state = "not_offered";
      // not installed here and its extension cannot run: switching it on would fail (spec §14.2
      // problem 1); an installed one keeps its state (an org admin can still switch it off)
      else if (!a && why !== undefined) {
        state = "unavailable";
        reason = why.reason;
      } else if (a) {
        // An on connector template without a connector here (ruling P2-10)
        const missing = await this.pluginInstaller.missingConnectors(orgId, i.id);
        state = (missing?.templates.length ?? 0) > 0 ? "needs_config" : "on";
      } else if (i.builtin) state = "on";
      else if (!wanted) state = "off";
      else {
        const m = latest?.manifest as PluginManifest | undefined;
        const ext = m?.extension ? loaded.get(m.name) : undefined;
        // only the connector templates on in the org need input (ruling P2-6)
        const templateIds = (m?.connectorTemplates ?? []).map((t) => templateIdOfPath(t.path));
        const needsInputs =
          (await connectorTemplatesOn(this.db, orgId, i.id, templateIds)).size > 0 ||
          (m?.extension !== undefined &&
            ext?.config?.org !== undefined &&
            !ext.config.org.safeParse({}).success &&
            !configured.has(m.name));
        // Wanted but not installed and needing nothing: the sync has not installed it (yet, or its
        // install failed); `off`, so an org admin can switch it on (the worker start retries it)
        state = needsInputs ? "needs_config" : "off";
      }
      out.push({
        ...view,
        // A pending upload is the owner's business only (other orgs never learn of it)
        ...(i.owner_org_id === orgId && { awaitingConfirmation, pendingVersion }),
        scope,
        builtin: i.builtin,
        state,
        ...(reason !== undefined && { reason }),
        switchable: state !== "not_offered" && state !== "awaiting_confirmation" && switchable(i),
        notDeployed: latest !== undefined && undeployed.has(i.id),
        installed: a
          ? {
              pluginInstallId: a.id,
              version: a.version,
              // no per-org upgrade: the platform update moves every org (ruling F2)
              upgradeAvailable: null,
            }
          : null,
        request: pending.get(i.id) ?? null,
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
    const templates = await readCatalogTemplates(this.storage, v);
    // Which templates are on in this org now: the install asks for the input of those, a
    // default-off one an admin switched on included
    const on = await connectorTemplatesOn(
      this.db,
      orgId,
      itemId,
      templates.map((t) => t.id),
    );
    // where each template's page finds its setup guide (spec 2026-11-09-setup-guides-v2 §9.3)
    const guideOf = (templateId: string) => {
      const g = templateGuideOf(m, templateId);
      return g ? { itemId, guideId: g.id } : null;
    };
    // Providers the install would switch on first (a refusal is the install's to report)
    const implied = await this.pluginInstaller
      .impliedProviders(orgId, m, templates, m.dependencies ?? [])
      .catch((e: unknown) => {
        if (e instanceof ApiError) return [];
        throw e;
      });
    return {
      item,
      hasIcon: m.icon !== undefined,
      extension: m.extension ? m.name : null,
      templates: templates.map((t) => orgTemplateView(t.id, t.file, guideOf(t.id), on.has(t.id))),
      dependencies: [
        ...(m.dependencies ?? []).map((d) => ({ name: d.name, range: d.version })),
        ...implied.map((d) => ({ name: d.name, range: d.range, implied: true as const })),
      ],
      skills: (m.skills ?? []).map((s) => packagePath(s.path)),
      agents: (m.agents ?? []).map((a) => packagePath(a.path)),
      missingTemplates:
        item.installed !== null && item.state === "needs_config"
          ? ((await this.pluginInstaller.missingConnectors(orgId, itemId))?.templates ?? []).map(
              (t) => orgTemplateView(t.id, t.file, guideOf(t.id), true),
            )
          : [],
    };
  }

  /**
   * The item's icon; members don't see disabled items, nobody outside its list sees a hidden
   * `named` item (-> `catalog.item_not_found`, decided before reading storage). Without `orgId`
   * (the super admin) every item.
   */
  async icon(itemId: string, isAdmin: boolean, orgId?: string): Promise<CatalogIcon> {
    if (orgId === undefined) return readCatalogIcon(this.db, itemId, isAdmin);
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    // A hidden `named` item stays absent here too
    const item = await this.db
      .selectFrom("catalog_items")
      .select(["scope", "builtin", "shown_to_others", "owner_org_id", "shareable"])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    // Not requestable from outside its list (hidden, or held back by the share gate): only listed orgs
    if (item && !item.builtin && item.scope === "named" && !requestable(item, false)) {
      const listed = await this.db
        .selectFrom("catalog_item_scope_orgs")
        .select("item_id")
        .where("item_id", "=", itemId)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      if (listed === undefined) throw itemNotFound();
    }
    return readCatalogIcon(this.db, itemId, isAdmin);
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
    auditDetail?: Record<string, unknown>,
  ): Promise<OrgInstallResult> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    await this.assertCanInstall(orgId, actor);
    const item = await this.visibleItem(orgId, itemId);
    // The platform's version (one per deployment, ruling P2-17)
    const version = item.platform_synced_version ?? item.latest_version;
    const v = await this.db
      .selectFrom("catalog_item_versions")
      .select("version")
      .where("item_id", "=", itemId)
      .where("version", "=", version)
      .executeTakeFirst();
    if (!v)
      throw new ApiError("catalog.item_not_found", `Version ${version} of this item not found`);
    const opts = {
      switchOn: true,
      ...(actorTokenId !== undefined && { actorTokenId }),
      ...(auditDetail !== undefined && { auditDetail }),
    };
    if (item.disabled) throw pluginDisabled();
    // Dependencies resolved, extensions deployed, template connectors available
    await this.pluginInstaller.preflight(orgId, actor, itemId, version);
    const view = await this.pluginInstaller.install(orgId, actor, itemId, version, body, opts);
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
    // An org upload waiting for the super admin: absent for other orgs, not switchable by its
    // owner (ruling P3-9)
    if (item.awaiting_confirmation) {
      if (item.owner_org_id !== orgId) throw itemNotFound();
      throw itemPendingError(item.name);
    }
    const listed = await this.db
      .selectFrom("catalog_item_scope_orgs")
      .select("item_id")
      .where("item_id", "=", itemId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!visibleTo({ scope: item.builtin ? "all" : item.scope }, listed !== undefined)) {
      // Shown to other orgs: the org sees it and may request access, but cannot switch it on
      if (requestable(item, false)) throw notOffered();
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
   * records the switch when it is installed already). Off: refused for builtin items
   * (`plugin.scope_locked`; an `all` one may go off, layering spec §4); without `confirm` returns
   * the uninstall preview and its hash, with the hash of the current preview uninstalls (a changed
   * preview -> `plugin.switch_stale`). The switch row is written after the install / uninstall.
   */
  async setSwitch(
    orgId: string,
    actor: string,
    itemId: string,
    body: { enabled: true; inputs?: OrgInstallInput } | { enabled: false; confirm?: string },
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<SwitchResult> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    await this.assertCanInstall(orgId, actor);
    const item = await this.visibleItem(orgId, itemId);
    const opts = {
      ...(actorTokenId !== undefined && { actorTokenId }),
      ...(auditDetail !== undefined && { auditDetail }),
    };
    if (body.enabled) {
      if (item.disabled) throw pluginDisabled();
      if ((await this.liveInstall(orgId, itemId)) !== undefined) {
        await this.recordSwitch(orgId, actor, itemId, true);
      } else {
        await this.install(orgId, actor, itemId, body.inputs ?? {}, actorTokenId, auditDetail);
      }
      return { kind: "done", item: await this.itemOf(orgId, actor, itemId) };
    }
    if (!switchable(item)) {
      throw new ApiError(
        "plugin.scope_locked",
        "This plugin is built in: it is on for every organization and cannot be switched off here",
      );
    }
    const live = await this.liveInstall(orgId, itemId);
    if (live === undefined) {
      await this.recordSwitch(orgId, actor, itemId, false);
      return { kind: "done", item: await this.itemOf(orgId, actor, itemId) };
    }
    // The platform default theme is locked on (themes spec §7): refused at the preview already;
    // the uninstall's transaction checks again before it writes
    await this.pluginInstaller.assertKeepsPlatformDefault(orgId, live.id);
    const preview = await this.pluginInstaller.previewUninstall(orgId, live.id);
    const confirm = uninstallPreviewHash(preview);
    if (body.confirm === undefined) return { kind: "preview", preview, confirm };
    // The hash is re-checked and the switch row written inside the uninstall's transaction
    await this.pluginInstaller.uninstall(orgId, actor, live.id, opts, { expectHash: body.confirm });
    return { kind: "done", item: await this.itemOf(orgId, actor, itemId) };
  }

  /**
   * `DELETE plugin-installs/:installId` of a catalog plugin follows the switch-off semantics: builtin
   * items are refused (`plugin.scope_locked`) unless the install is not live (failed, or
   * `installing`: the installer cleans up a stale one and refuses a fresh one). Removing a live
   * install writes the switch row false in the uninstall's transaction (an `all` item then stays
   * off in the org); removing a failed or stale one writes none.
   */
  async uninstall(
    orgId: string,
    actor: string,
    installId: string,
    actorTokenId?: string,
    /** Merged into the audit detail (a write made through the Platform tool). */
    auditDetail?: Record<string, unknown>,
  ): Promise<UninstallReport> {
    if (!UUID_RE.test(installId))
      throw new ApiError("plugin.install_not_found", "Plugin install not found");
    const row = await this.db
      .selectFrom("plugin_installs as a")
      .innerJoin("catalog_items as i", "i.id", "a.item_id")
      .select(["i.scope", "i.builtin", "a.status"])
      .where("a.id", "=", installId)
      .where("a.org_id", "=", orgId)
      .executeTakeFirst();
    // A failed or stuck install is cleaned up whatever the scope (it is not on anyway)
    const live = row?.status === "installed" || row?.status === "upgrading";
    if (row !== undefined && live && !switchable(row)) {
      throw new ApiError(
        "plugin.scope_locked",
        "This plugin is built in: it is on for every organization and cannot be uninstalled here",
      );
    }
    return this.pluginInstaller.uninstall(
      orgId,
      actor,
      installId,
      {
        ...(actorTokenId !== undefined && { actorTokenId }),
        ...(auditDetail !== undefined && { auditDetail }),
      },
      // only a live install was on: removing a failed or stale one writes no switch row, so an
      // item its scope wants stays wanted and the sync installs it again
      row !== undefined && live ? {} : undefined,
    );
  }

  private async itemOf(orgId: string, accountId: string, itemId: string): Promise<OrgCatalogItem> {
    const [item] = await this.list(orgId, accountId, itemId);
    if (!item) throw itemNotFound();
    return item;
  }

  /**
   * Writes the org's switch row of the item under the org row lock. The item row is locked FOR
   * SHARE first (exclusive with a scope change, an unshare, ruling P3-25, and an owner's delete or
   * transfer); switching on re-checks that the org may still see it; the install path re-checks the same in `assertItemInstallable`.
   */
  @Transactional()
  private async recordSwitch(
    orgId: string,
    actor: string,
    itemId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.orgLock.lock(orgId);
    // Both directions lock the item row FOR SHARE: an owner's delete or transfer (FOR UPDATE)
    // decides on who uses it, so a switch-off racing it must not change that answer meanwhile
    const item = await this.db
      .selectFrom("catalog_items")
      .select(["scope", "builtin"])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .forShare()
      .executeTakeFirst();
    if (enabled) {
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
    }
    await upsertOrgSwitch(this.db, orgId, itemId, enabled, actor);
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
