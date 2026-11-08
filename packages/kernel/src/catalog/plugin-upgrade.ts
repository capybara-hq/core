// The platform plugin update (plugin and component management spec §7, plugin scope phase 2,
// Task 7): a platform plugin has one version for the deployment, so an update is previewed and
// confirmed once by the super admin, per component. The per-org upgrade routes are retired (ruling
// F2).
import { createHash } from "node:crypto";
import type { ConnectorTemplateFile, PluginManifest } from "@capybara-hq/plugin-sdk";
import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb, SkillManifest } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionAdminOps } from "../extensions/admin-ops.js";
import { ExtensionBlobs } from "../extensions/blobs.js";
import { permissionSetOfPackage, readExtensionPackage } from "../extensions/package.js";
import type { PermissionSet } from "../extensions/permission-set.js";
import { blockingKeys, diffPermissions } from "../extensions/permission-set.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { audit } from "../identity/audit.js";
import { SuperAdminLock } from "../identity/super-admin.js";
import { addOrgNotice, itemDisplayName, notifySharedUpdate } from "../inbox/org-notices.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock } from "../orgs/org-lock.js";
import { packagePath } from "../packages/tgz.js";
import { StorageService } from "../storage/storage.service.js";
import { canonicalJson } from "../tools/canonical-json.js";
import type { PreparedTemplateUpdate, TemplateUpdateInput } from "../tools/connectors.service.js";
import { ConnectorsService } from "../tools/connectors.service.js";
import type { ConnectorAuth } from "../tools/credentials.js";
import {
  type CatalogVersionFiles,
  dirDigest,
  getPath,
  readCatalogAgentTemplates,
  readCatalogTemplates,
  setPath,
  skillFilesDigest,
  templatePluginProblem,
} from "./catalog-content.js";
import { markVersionApplied, versionUsable } from "./catalog-items.js";
import {
  agentsUsing,
  type ComponentKind,
  clashingOrgSkills,
  clashingPlatformSkills,
  componentOn,
  connectorTemplatesOn,
  listedIn,
  loadScopeState,
  pluginFactsOf,
  switchOf,
} from "./component-state.js";
import { CatalogItemLock } from "./locks.js";
import { itemPendingError, itemRemovedError } from "./ownership.js";
import { PlanStale, PlatformComponents, type PreparedSync } from "./platform-components.js";
import { catalogSkillNames, PluginInstaller } from "./plugin-install.js";
import { PluginScopeSync } from "./scope-sync.js";
import { compareVersions, satisfiesRange } from "./versions.js";

/** How a component differs between the platform's current and the target version (spec §7.1). */
export type UpdateChange = "added" | "removed" | "upgrade" | "downgrade" | "same";

/** One component of an update preview. */
export interface PlatformUpdateComponent {
  kind: ComponentKind;
  /** The platform component (null: added by the target). */
  id: string | null;
  /** Skill or agent template name; a connector template's id. */
  name: string;
  change: UpdateChange;
  /** The catalog version of the component's current version (null: added, or no catalog version). */
  from: string | null;
  /** The target version (null: removed). */
  to: string | null;
  /** The current version was updated on its own (spec §7.2): the confirm moves it to the plugin's. */
  updatedOnOwn: boolean;
  /** The component has its own scope (spec §5 rule 2); the update keeps it. */
  ownScope: boolean;
  /**
   * The orgs where the component is on whose linked copy is pinned to its own version (ruling B2):
   * the confirm clears those pins, except for a removed component (the copy keeps its version).
   */
  pinnedOrgs: string[];
  /**
   * A removed skill or agent template agents use: it stays (spec §7.3), listed with the orgs and
   * agents using it. Absent otherwise.
   */
  kept?: { orgId: string; agents: { id: string; name: string }[] }[];
}

/** The org connectors an update touches (ruling E2, spec §6). */
export interface PlatformUpdateConnectorOrg {
  orgId: string;
  /**
   * Connectors made from a changed template: they get the template's endpoint preset (the org's
   * values at the editable paths), auth preset and default policies; `credentialsReset` when the
   * auth method or the credentials it needs changed (cleared: the org re-enters them).
   */
  connectors: { id: string; name: string; templateId: string; credentialsReset: boolean }[];
  /**
   * Added templates on in the org where the plugin is on: their connectors need the org's input
   * (endpoint, credentials), so the update creates none.
   */
  needsConfig: string[];
}

/** `POST /api/v1/admin/catalog/items/:id/update/preview`. */
export interface PlatformUpdatePreview {
  itemId: string;
  name: string;
  /** The platform's current version (null: never synced). */
  from: string | null;
  to: string;
  components: PlatformUpdateComponent[];
  /**
   * The deployment's extension moves (`from` null: installed by the update); null: unchanged.
   * `orgs`: the orgs using it (where the plugin is on; spec §7.4, one version for all of them);
   * `needsApproval`: the new version asks for permissions the approved snapshot does not cover,
   * so it waits as `pending_approval` until the super admin approves them.
   */
  extension: {
    from: string | null;
    /** null: the target drops the extension (an owner update only, ruling P3-12'). */
    to: string | null;
    orgs: string[];
    needsApproval: boolean;
  } | null;
  connectorOrgs: PlatformUpdateConnectorOrg[];
  /**
   * An owner's update preview only ({@link PlatformPluginUpdater.previewForOwner}): the name of
   * every org the preview mentions, by id. An org admin cannot read other orgs, and these names
   * are already disclosed to the owner (rulings P3-14, P3-19). Not covered by `diffHash`.
   */
  orgNames?: Record<string, string>;
  /** Confirm with it; recomputed under the item lock at the confirm. */
  diffHash: string;
}

/** `PUT /api/v1/admin/catalog/items/:id/update`. */
export interface PlatformUpdateResult {
  itemId: string;
  version: string;
  components: PlatformUpdateComponent[];
  extension: PlatformUpdatePreview["extension"];
  connectorOrgs: PlatformUpdateConnectorOrg[];
}

interface VersionRow extends CatalogVersionFiles {
  version: string;
  manifest: PluginManifest;
  extension_sha256: string | null;
}

/**
 * An update's target read from somewhere other than `catalog_item_versions`: an org upload's
 * staging (pre-flight F3), so the org's review can show the update before the version is imported.
 * Its files are at `object_prefix`, where the confirm's version row will point too.
 */
export type UpdateTarget = VersionRow;

/** The owner org an update acts for (ruling P3-12): its admin instead of the super admin. */
interface OwnerMode {
  orgId: string;
}

/** The deployment's extension step of an update. */
interface ExtensionStep {
  from: string | null;
  /** null: the target drops the extension; the update disables and uninstalls it (P3-12'). */
  to: string | null;
  /** The package to install; null for a removal. */
  sha256: string | null;
  /** The install record's package before the update (null: none, the update installs it). */
  previous: string | null;
  needsApproval: boolean;
  orgs: string[];
}

/** The target version's contents read from object storage (outside any transaction). */
interface TargetContents {
  skillNames: string[];
  agents: Awaited<ReturnType<typeof readCatalogAgentTemplates>>;
  templates: Awaited<ReturnType<typeof readCatalogTemplates>>;
}

/** What the confirm's transaction reuses from the diff computed before it. */
interface Pre {
  contents: TargetContents;
  /** The extension step the update ran before the transaction (null: none). */
  extension: ExtensionStep | null;
}

/** A connector the update changes, with what its update needs. */
interface ConnectorChange {
  orgId: string;
  id: string;
  name: string;
  connector: string;
  endpoint: unknown;
  templateId: string;
  file: ConnectorTemplateFile;
  credentialsReset: boolean;
}

/** Everything a confirm does, computed before anything is written. */
interface UpdateDiff {
  itemId: string;
  name: string;
  from: string | null;
  to: VersionRow;
  components: PlatformUpdateComponent[];
  extension: ExtensionStep | null;
  connectors: ConnectorChange[];
  connectorOrgs: PlatformUpdateConnectorOrg[];
  /** Skills whose content stays and whose pinned suggestion the target sets (by platform id). */
  suggest: Map<string, boolean>;
  contents: TargetContents;
  dependencies: string[];
  diffHash: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const itemNotFound = () => new ApiError("catalog.item_not_found", "Catalog item not found");
const stale = () =>
  new ApiError(
    "plugin.upgrade_stale",
    "The update preview is out of date (the catalog version, the platform components, a pin or a connector changed); preview the update again",
  );
/** The pending version a super admin confirms was replaced by another upload (P3-11). */
const pendingStale = (name: string) =>
  new ApiError(
    "extension.approval_stale",
    `The pending upload of ${name} changed since it was reviewed; review it again`,
  );
const targetInvalid = (message: string, details?: unknown[]) =>
  new ApiError("plugin.upgrade_target_invalid", message, details);
/** A version an org uploaded that was never applied or confirmed, or was rejected (P3-37, P3-52). */
const notApplied = (name: string, version: string) =>
  targetInvalid(
    `Version ${version} of plugin ${name} was uploaded by an organization and never applied or confirmed (or was rejected); the generic update cannot apply it`,
    [{ reason: "org_version_not_applied", version }],
  );
const KIND_ORDER: Record<ComponentKind, number> = {
  skill: 0,
  agent_template: 1,
  connector_template: 2,
};
/** How long one update holds its item (renewed while it runs). */
const UPDATE_LOCK_TTL_MS = 60_000;

/**
 * What a credential of `auth` looks like: two auths with the same key take the same stored
 * credential (static: the type family, ownership and header names; OAuth: any change re-enters).
 */
function credentialKey(auth: ConnectorAuth): string {
  switch (auth.type) {
    case "none":
      return "none";
    case "bearer":
    case "api_key":
      return `token:${auth.ownership}`;
    case "basic":
      return `basic:${auth.ownership}`;
    case "headers":
      return `headers:${auth.ownership}:${[...auth.names].sort().join(",")}`;
    default:
      return canonicalJson(auth);
  }
}

/** The digest of all files of a catalog version. */
const filesDigest = (row: CatalogVersionFiles): string =>
  skillFilesDigest(row.files.map((f) => ({ path: f.path, sha256: f.sha256 })));

/**
 * The platform plugin update (spec §7; ruling F2 retires the per-org upgrades):
 * - **preview** diffs the platform's current components of the plugin (the version recorded in
 *   `catalog_items.platform_synced_version`, components updated on their own included) against a
 *   catalog version: each skill (by name, by its files' digest), agent template (by name, canonical
 *   definition) and connector template (by id, canonical file) is `added`, `removed`, `same`, or
 *   `upgrade` / `downgrade` (the target's direction from the component's catalog version). It marks
 *   components updated on their own, components with their own scope and the orgs whose linked
 *   copy is pinned; lists removed components agents still use (they stay, spec §7.3), the org
 *   connectors made from changed templates (all orgs, ruling E2; `credentialsReset` when the
 *   credential shape changed) and the added templates that will need an org's input, the
 *   deployment's extension move, and a `diffHash`. Refused: same version, a disabled or deleted
 *   item, a target without the extension the deployment runs for it or moving a config-declared
 *   one, a template moving to another connector, a plugin another platform plugin depends on
 *   outside its range, and an added skill whose name is taken where the plugin is on (rule 10).
 * - **update** runs under a Redis lock per item (another update -> `plugin.install_in_progress`):
 *   the extension first (`ExtensionAdminOps.install`, enabled when the update installs it; added
 *   permissions wait for the admin's approval as for any extension upgrade), then one transaction
 *   under the item name's lock that recomputes the diff (`plugin.upgrade_stale` on a difference)
 *   and writes the platform versions (`PlatformComponents.syncFromVersion`, which records
 *   `platform_synced_version`), the pinned suggestions of unchanged skills, the removals (a
 *   component no agent uses is soft-deleted, so unpinned linked copies go with it; pinned copies
 *   keep their own version; a removed connector template leaves its connectors as the orgs' own),
 *   clears the pins of linked copies, fans changed templates out to every connector made from them
 *   (`applyTemplateIn`, under each org's row lock, credentials cleared only for a changed
 *   credential shape), moves every org install to the version and audits
 *   `plugin.platform_updated`; the scope sync of the item and its dependencies is enqueued after
 *   the commit (orgs get new dependencies by rule 9). A failure rolls the transaction back and
 *   puts the extension back where it was (audit `plugin.platform_update_failed`, 502
 *   `plugin.upgrade_failed`); files copied to `deployment/platform/` stay unreferenced.
 * Storage is never read or written inside the transaction: the target's contents (and the
 * extension package, for `needsApproval`) are read and the platform files copied
 * (`PlatformComponents.prepareSync`) after the Redis lock is taken and before the transaction,
 * which reuses them and writes rows only (`applySyncIn`). The confirm-time diff treats the
 * extension this update moved as expected (the install record must point at that package).
 * Recovery: a process that dies between the extension step and the transaction leaves the
 * deployment on the target's extension with the platform components unchanged; a new preview
 * then shows the extension unchanged (`extension: null`) and the components still to move, and
 * confirming it completes the update (or an update back to the old version moves it back).
 * No in-process state.
 */
@Injectable()
export class PlatformPluginUpdater {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(SuperAdminLock) private readonly adminLock: SuperAdminLock,
    @Inject(CatalogItemLock) private readonly itemLock: CatalogItemLock,
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(ExtensionRegistry) private readonly registry: ExtensionRegistry,
    @Inject(ExtensionAdminOps) private readonly ops: ExtensionAdminOps,
    /** Reads the target's extension package (its permissions, for `needsApproval`). */
    @Inject(ExtensionBlobs) private readonly blobs: ExtensionBlobs,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(PlatformComponents) private readonly platform: PlatformComponents,
    /** Template dependencies (the deployed connector kinds). */
    @Inject(PluginInstaller) private readonly installer: PluginInstaller,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(PluginScopeSync) private readonly sync: PluginScopeSync,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** The update preview (see the class comment); writes nothing. */
  async preview(itemId: string, version: string): Promise<PlatformUpdatePreview> {
    return previewOf(await this.diff(itemId, version));
  }

  /**
   * The update preview of a new version of an org's own plugin (ruling P3-12): the item must be
   * owned by `orgId` (else 404, as for any item the org cannot see), the target carries no
   * extension (an extension-bearing version waits for the super admin, plan Task 6), and a target
   * dropping the deployment's extension is allowed (P3-12'). `staged` is the target read from the
   * org's staging (pre-flight F3); without it the imported version `version` is read. The route
   * authorizes the org admin; writes nothing.
   */
  async previewForOwner(
    orgId: string,
    itemId: string,
    version: string,
    staged?: UpdateTarget,
  ): Promise<PlatformUpdatePreview> {
    // An internal invariant, not reachable from input: the only caller (OrgPluginUploads) passes
    // the staged target together with its own version (PluginImport.stagedTarget)
    if (staged !== undefined && staged.version !== version) {
      throw new Error(
        `internal: previewForOwner got the staged target of version ${staged.version} for version ${version}`,
      );
    }
    const preview = previewOf(
      await this.diff(itemId, version, {
        owner: { orgId },
        ...(staged !== undefined && { target: staged }),
      }),
    );
    return { ...preview, orgNames: await this.orgNamesOf(preview) };
  }

  /**
   * Locks, in sorted order and before the item (ruling P3-50), every live org the update may
   * write in: the orgs with connectors made from the plugin's connector templates and the item's
   * owner org. `acting`: the owner org an owner update acts for, locked with its admin re-checked
   * (`catalog.upload`; deleted -> 404 `org.not_found`). Returns the live orgs locked; another
   * deleted one is skipped.
   */
  private async lockUpdateOrgs(
    itemId: string,
    acting?: { orgId: string; actor: string },
  ): Promise<Set<string>> {
    const item = await this.db
      .selectFrom("catalog_items")
      .select("owner_org_id")
      .where("id", "=", itemId)
      .executeTakeFirst();
    const made = await this.db
      .selectFrom("connectors as c")
      .innerJoin("platform_connector_templates as t", "t.id", "c.platform_template_id")
      .select("c.org_id")
      .distinct()
      .where("t.catalog_item_id", "=", itemId)
      .where("c.deleted_at", "is", null)
      .execute();
    const ids = new Set(made.map((r) => r.org_id));
    if (item?.owner_org_id) ids.add(item.owner_org_id);
    if (acting !== undefined) ids.add(acting.orgId);
    const live = new Set<string>();
    for (const orgId of [...ids].sort()) {
      if (orgId === acting?.orgId) {
        await this.orgLock.lockAndAuthorize(orgId, acting.actor, "catalog.upload");
        live.add(orgId);
      } else if (await this.orgLock.tryLock(orgId)) {
        live.add(orgId);
      }
    }
    return live;
  }

  /** The names of the orgs a preview mentions, by id (an owner's preview, see `orgNames`). */
  private async orgNamesOf(p: PlatformUpdatePreview): Promise<Record<string, string>> {
    const ids = new Set<string>([
      ...(p.extension?.orgs ?? []),
      ...p.connectorOrgs.map((c) => c.orgId),
      ...p.components.flatMap((c) => [...c.pinnedOrgs, ...(c.kept ?? []).map((k) => k.orgId)]),
    ]);
    if (ids.size === 0) return {};
    const rows = await this.db
      .selectFrom("orgs")
      .select(["id", "name"])
      .where("id", "in", [...ids])
      .where("deleted_at", "is", null)
      .execute();
    return Object.fromEntries(rows.map((r) => [r.id, r.name]));
  }

  /**
   * Applies a new version of an org's own plugin for its owner (ruling P3-12, see
   * {@link previewForOwner}): the actor must be an admin of the owner org (`catalog.upload`,
   * re-checked under the org row lock in the transaction), then the platform update as
   * {@link update} does, also removing the extension when the target drops it. In the update's
   * transaction the orgs using the shared plugin are told (`shared_item_updated`, one notice per
   * plugin) and a pending version is cleared (pre-flight F7: the new version replaces it).
   */
  async updateAsOwner(
    orgId: string,
    actor: string,
    itemId: string,
    version: string,
    diffHash: string,
    opts: { actorTokenId?: string } = {},
  ): Promise<PlatformUpdateResult> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    await this.authorizeOwner(orgId, actor);
    return this.locked(itemId, () =>
      this.updateLocked(actor, itemId, { version, diffHash }, opts, { orgId }),
    );
  }

  /** The actor is an admin of the owner org (a read of the membership under the org row lock). */
  @Transactional()
  private async authorizeOwner(orgId: string, actor: string): Promise<void> {
    await this.orgLock.lockAndAuthorize(orgId, actor, "catalog.upload");
  }

  /** Runs `f` holding the item's update lock (another update -> `plugin.install_in_progress`). */
  private async locked<T>(itemId: string, f: () => Promise<T>): Promise<T> {
    const handle = await this.locks.acquire(`plugin-update-${itemId}`, {
      ttlMs: UPDATE_LOCK_TTL_MS,
    });
    if (!handle) {
      throw new ApiError(
        "plugin.install_in_progress",
        "This plugin is being updated; try again when that update finishes",
      );
    }
    try {
      return await f();
    } finally {
      await handle.release();
    }
  }

  /**
   * The super admin's confirmation of an org upload's pending new version (rulings P3-10, P3-21,
   * pre-flight F8): the update to `version` as {@link update} does it (the super admin's, the
   * extension installed or upgraded on the deployment), with the version allowed although it is
   * pending. Its transaction re-reads the item under the row lock: removed meanwhile -> 409
   * `catalog.item_removed`, the pending version replaced -> 409 `extension.approval_stale` (both
   * undo the extension step); then the pending state is cleared and the owner told
   * (`upload_confirmed`). The caller checked the digest of the version's package.
   */
  async updateToPending(
    actor: string,
    itemId: string,
    version: string,
    opts: { actorTokenId?: string } = {},
  ): Promise<PlatformUpdateResult> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    return this.locked(itemId, () => this.updateToPendingLocked(actor, itemId, version, opts));
  }

  /**
   * {@link updateToPending} for a caller already holding the item's update lock
   * ({@link withItemLock}): the super admin's confirmation runs all its steps under it (ruling
   * P3-35).
   */
  async updateToPendingLocked(
    actor: string,
    itemId: string,
    version: string,
    opts: { actorTokenId?: string } = {},
  ): Promise<PlatformUpdateResult> {
    const d = await this.diff(itemId, version, { confirmPending: version });
    return this.updateLocked(
      actor,
      itemId,
      { version, diffHash: d.diffHash },
      opts,
      undefined,
      version,
    );
  }

  /**
   * Runs `f` holding the item's update lock (the one every platform update of the item takes;
   * another holder -> 409 `plugin.install_in_progress`): the super admin's confirmation of an org
   * upload runs every step under it (ruling P3-35).
   */
  withItemLock<T>(itemId: string, f: () => Promise<T>): Promise<T> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    return this.locked(itemId, f);
  }

  /**
   * Runs an update confirmed with the preview's `diffHash` (see the class comment). A version an
   * org upload waits with, or an item whose first version waits, -> 409 `catalog.item_pending`
   * (confirmed in 待确认 instead, pre-flight F8).
   */
  async update(
    actor: string,
    itemId: string,
    input: { version: string; diffHash: string },
    opts: { actorTokenId?: string; auditDetail?: Record<string, unknown> } = {},
  ): Promise<PlatformUpdateResult> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    return this.locked(itemId, () => this.updateLocked(actor, itemId, input, opts));
  }

  private async updateLocked(
    actor: string,
    itemId: string,
    input: { version: string; diffHash: string },
    opts: { actorTokenId?: string; auditDetail?: Record<string, unknown> },
    owner?: OwnerMode,
    confirmPending?: string,
  ): Promise<PlatformUpdateResult> {
    // Storage is read and written here, before any transaction (see the class comment)
    const checked = await this.diff(itemId, input.version, {
      ...(owner && { owner }),
      ...(confirmPending !== undefined && { confirmPending }),
    });
    if (checked.diffHash !== input.diffHash) throw stale();
    const prepared = await this.platform.prepareSync(itemId, input.version);
    const ext = checked.extension;
    // The extension admin re-checks the actor: a super admin, or for an owner update the owner
    // org's admin (and audits it with `ownerOrgId`)
    const opsOwner = owner && { orgId: owner.orgId };
    let step: "extension" | "components" = "extension";
    let extensionMoved = false;
    let enabledHere = false;
    /** A removal: the extension was enabled before it (put back enabled on failure). */
    let removedEnabled = false;
    try {
      if (ext?.sha256 === null) {
        // The target drops the extension (P3-12'): disabled (drained), then uninstalled
        const row = await this.db
          .selectFrom("extension_installs")
          .select("desired_state")
          .where("name", "=", checked.name)
          .executeTakeFirst();
        removedEnabled = row?.desired_state === "enabled";
        await this.ops.disable(checked.name, actor, opts.actorTokenId, opsOwner);
        extensionMoved = true;
        await this.ops.uninstall(checked.name, actor, opts.actorTokenId, opsOwner);
      } else if (ext) {
        await this.ops.install(checked.name, ext.sha256, actor, opts.actorTokenId, {
          catalogItemId: itemId,
          ...(opsOwner && { owner: opsOwner }),
        });
        extensionMoved = true;
        if (ext.previous === null) {
          // An occupied single-provider point leaves it installed disabled
          const r = await this.ops.enableUnlessOccupied(
            checked.name,
            actor,
            opts.actorTokenId,
            opsOwner,
          );
          enabledHere = r.enabled;
        }
      }
      step = "components";
      const diff = await this.commit(
        actor,
        itemId,
        input,
        opts,
        { contents: checked.contents, extension: ext },
        prepared,
        owner,
        confirmPending,
      );
      return {
        itemId,
        version: diff.to.version,
        components: diff.components,
        extension: extensionView(diff.extension),
        connectorOrgs: diff.connectorOrgs,
      };
    } catch (e) {
      let rolledBack = true;
      if (extensionMoved && ext) {
        // An owner update was authorized at its start: the put-back is not checked again
        const back = opsOwner && { ...opsOwner, rollback: true as const };
        try {
          if (ext.sha256 === null) {
            // Removed by this update: the previous package reinstalled (as it was)
            await this.ops.install(checked.name, ext.previous as string, actor, opts.actorTokenId, {
              catalogItemId: itemId,
              ...(back && { owner: back }),
            });
            if (removedEnabled) await this.ops.enable(checked.name, actor, opts.actorTokenId, back);
          } else if (ext.previous !== null) {
            await this.ops.install(checked.name, ext.previous, actor, opts.actorTokenId, {
              ...(back && { owner: back }),
            });
          } else {
            // Installed by this update: an uninstall needs it disabled first
            if (enabledHere) await this.ops.disable(checked.name, actor, opts.actorTokenId, back);
            await this.ops.uninstall(checked.name, actor, opts.actorTokenId, back);
          }
        } catch (u) {
          rolledBack = false;
          this.log.error("putting a plugin's extension back after a failed update failed", {
            itemId,
            plugin: checked.name,
            err: u,
          });
        }
      }
      const code = e instanceof ApiError ? e.code : "internal";
      await this.auditFailure(actor, checked, { step, code, rolledBack }, opts);
      // A refusal found under the lock (stale, disabled meanwhile, a conflict, a downgrade the
      // extension's migrations refuse): returned as it is
      if (e instanceof ApiError && e.status < 500 && rolledBack) throw e;
      throw new ApiError(
        "plugin.upgrade_failed",
        rolledBack
          ? `Updating the plugin failed at step ${step} (${code}); the platform is back at version ${checked.from ?? "(none)"}`
          : `Updating the plugin failed at step ${step} (${code}) and putting its extension back failed; check the extension in the admin console`,
        [
          {
            step,
            code,
            ...(e instanceof ApiError && { message: e.message }),
            ...(e instanceof ApiError && e.details !== undefined && { causeDetails: e.details }),
            rolledBack,
          },
        ],
      );
    }
  }

  /** `plugin.platform_update_failed`, in a transaction of its own. */
  @Transactional({ propagation: "requires_new" })
  private async auditFailure(
    actor: string,
    diff: UpdateDiff,
    f: { step: string; code: string; rolledBack: boolean },
    opts: { actorTokenId?: string },
  ): Promise<void> {
    await audit(this.db, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      action: "plugin.platform_update_failed",
      target: diff.itemId,
      detail: { name: diff.name, from: diff.from, to: diff.to.version, ...f },
    });
  }

  /**
   * The update's transaction (see the class comment): the super admin re-checked, the diff
   * recomputed under the item name's lock, then every write. Returns the diff it applied.
   */
  @Transactional({ propagation: "requires_new" })
  private async commit(
    actor: string,
    itemId: string,
    input: { version: string; diffHash: string },
    opts: { actorTokenId?: string; auditDetail?: Record<string, unknown> },
    pre: Pre,
    prepared: PreparedSync,
    owner?: OwnerMode,
    confirmPending?: string,
  ): Promise<UpdateDiff> {
    if (owner === undefined) await this.adminLock.lockAndAuthorize(actor);
    // The global lock order (ruling P3-50): the orgs (sorted; the acting owner org's admin
    // re-checked at its place), then the item, then its components; an org deletion locks its org
    // row, then the items it owns
    const liveOrgs = await this.lockUpdateOrgs(itemId, owner && { orgId: owner.orgId, actor });
    const named = await this.db
      .selectFrom("catalog_items")
      .select("name")
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (!named) throw itemNotFound();
    await this.itemLock.lock(named.name);
    let pendingOwner: string | null = null;
    if (confirmPending !== undefined) {
      // The super admin's confirmation (P3-21): still pending with the version they reviewed
      const row = await this.db
        .selectFrom("catalog_items")
        .select(["deleted_at", "pending_version", "owner_org_id"])
        .where("id", "=", itemId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (row.deleted_at !== null) throw itemRemovedError(named.name);
      if (row.pending_version !== confirmPending) throw pendingStale(named.name);
      pendingOwner = row.owner_org_id;
    }
    const diff = await this.diff(itemId, input.version, {
      pre,
      ...(owner && { owner }),
      ...(confirmPending !== undefined && { confirmPending }),
    });
    if (diff.diffHash !== input.diffHash) throw stale();
    const t = this.db;

    // The platform versions (files copied before the transaction; rows only here)
    try {
      await this.platform.applySyncIn(prepared);
    } catch (e) {
      if (e instanceof PlanStale) throw stale();
      throw e;
    }
    for (const [id, pinned] of diff.suggest) {
      await t
        .updateTable("platform_skill_versions as v")
        .set({ suggest_pinned: pinned })
        .from("platform_skills as s")
        .whereRef("s.id", "=", "v.skill_id")
        .whereRef("s.current_version", "=", "v.version")
        .where("s.id", "=", id)
        .execute();
    }

    // Removals (spec §7.3): kept while agents use it; otherwise soft-deleted
    const now = sql<Date>`now()`;
    for (const c of diff.components) {
      if (c.change !== "removed" || c.id === null || c.kept !== undefined) continue;
      const table =
        c.kind === "skill"
          ? "platform_skills"
          : c.kind === "agent_template"
            ? "platform_agent_templates"
            : "platform_connector_templates";
      await t
        .updateTable(table as "platform_skills")
        .set({ deleted_at: now, updated_at: now })
        .where("id", "=", c.id)
        .execute();
    }

    // Pins of linked copies: moved to the plugin's version (spec §7.1)
    for (const c of diff.components) {
      if (c.change === "removed" || c.id === null || c.pinnedOrgs.length === 0) continue;
      if (c.kind === "skill") {
        await t
          .updateTable("skills")
          .set({ pinned_version: null, updated_at: now })
          .where("platform_skill_id", "=", c.id)
          .where("org_id", "in", c.pinnedOrgs)
          .where("pinned_version", "is not", null)
          .execute();
      } else if (c.kind === "agent_template") {
        await t
          .updateTable("agent_templates")
          .set({ pinned_version: null, updated_at: now })
          .where("platform_template_id", "=", c.id)
          .where("org_id", "in", c.pinnedOrgs)
          .where("pinned_version", "is not", null)
          .execute();
      }
    }

    // Connectors made from changed templates, in every org (ruling E2)
    const orgs = [...new Set(diff.connectors.map((c) => c.orgId))].sort();
    for (const orgId of orgs) {
      if (!liveOrgs.has(orgId)) {
        // Locked before the item (P3-50): an org not locked then is deleted (its connectors go
        // with it), or its connector was made since, which changes what the update does
        const live = await t
          .selectFrom("orgs")
          .select("id")
          .where("id", "=", orgId)
          .where("deleted_at", "is", null)
          .executeTakeFirst();
        if (live === undefined) continue;
        throw stale();
      }
      for (const c of diff.connectors.filter((x) => x.orgId === orgId)) {
        const prepared = await this.prepare(actor, itemId, diff.to.version, c);
        await this.connectors.applyTemplateIn(orgId, c.id, actor, prepared, opts.actorTokenId);
      }
    }

    // One version for the deployment: every live org install of the plugin moves with it (one
    // still installing too, and a legacy `upgrading` row; an install marked installed later
    // records the platform version current at its commit, PluginInstaller.markInstalled)
    await t
      .updateTable("plugin_installs")
      .set({ version: diff.to.version, error: null })
      .where("item_id", "=", itemId)
      .where("status", "in", ["installing", "installed", "upgrading"])
      .execute();
    if (owner !== undefined || confirmPending !== undefined) {
      // An org's version becomes its latest once applied or confirmed (ruling P3-34)
      await t
        .updateTable("catalog_items")
        .set({ latest_version: diff.to.version })
        .where("id", "=", itemId)
        .execute();
      await markVersionApplied(t, itemId, diff.to.version);
      // An owner's new version replaces a version waiting for the super admin (pre-flight F7):
      // their confirmation of it is then refused (409 extension.not_pending); the super admin's
      // confirmation applied it
      await t
        .updateTable("catalog_items")
        .set({ pending_version: null, pending_by: null, pending_at: null })
        .where("id", "=", itemId)
        .where("pending_version", "is not", null)
        .execute();
    }
    if (confirmPending !== undefined && pendingOwner !== null) {
      await addOrgNotice(t, pendingOwner, "upload_confirmed", {
        itemId,
        name: diff.name,
        displayName: await itemDisplayName(t, itemId),
        version: diff.to.version,
      });
    }
    // The orgs using a shared org-owned plugin are told, one notice per plugin (a platform-owned
    // plugin tells nobody); a plugin never synced before has no version to come from
    if (diff.from !== null) {
      await notifySharedUpdate(
        t,
        { kind: "plugin", id: itemId },
        { name: diff.name, from: diff.from, to: diff.to.version },
      );
    }
    await audit(t, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      action: "plugin.platform_updated",
      target: itemId,
      detail: {
        name: diff.name,
        from: diff.from,
        to: diff.to.version,
        ...(owner !== undefined && { ownerOrgId: owner.orgId }),
        components: diff.components.map((c) => ({
          kind: c.kind,
          name: c.name,
          change: c.change,
          ...(c.kept !== undefined && { kept: true }),
          ...(c.pinnedOrgs.length > 0 && c.change !== "removed" && { unpinned: c.pinnedOrgs }),
        })),
        ...(diff.extension && { extension: extensionView(diff.extension) }),
        connectors: diff.connectors.map((c) => ({
          orgId: c.orgId,
          id: c.id,
          credentialsReset: c.credentialsReset,
        })),
        ...opts.auditDetail,
      },
    });
    const enqueue = [itemId, ...diff.dependencies];
    afterCommit(async () => {
      for (const id of enqueue) {
        try {
          await this.sync.enqueueItem(id);
        } catch (err) {
          this.log.warn("enqueueing the scope sync after a platform update failed", {
            itemId: id,
            err,
          });
        }
      }
    });
    return diff;
  }

  /**
   * The template update of one connector: the new endpoint preset with the org's values at the
   * editable paths, the auth preset and default policies; credentials cleared (no new ones: they
   * are the org's) when the credential shape changed.
   */
  private async prepare(
    actor: string,
    itemId: string,
    version: string,
    c: ConnectorChange,
  ): Promise<PreparedTemplateUpdate> {
    const template = c.file.template;
    const endpoint = structuredClone(template.endpoint) as Record<string, unknown>;
    for (const e of template.editableEndpoint ?? []) {
      const v = getPath(c.endpoint, e);
      if (v !== undefined) setPath(endpoint, e, v);
    }
    const input: TemplateUpdateInput = {
      endpoint,
      auth: template.auth as unknown as ConnectorAuth,
      template: {
        itemId,
        version,
        templateId: c.templateId,
        ...(template.defaultToolPolicies !== undefined && {
          defaultToolPolicies: template.defaultToolPolicies,
        }),
      },
      resetCredentials: false,
    };
    // Checked without credentials (nothing outbound); a changed shape then clears the old ones
    const prepared = await this.connectors.prepareTemplateUpdate(actor, c.connector, input);
    return c.credentialsReset
      ? { ...prepared, input: { ...prepared.input, resetCredentials: true } }
      : prepared;
  }

  /**
   * Computes an update (see the class comment). `target`: the target read from an org's staging
   * instead of `catalog_item_versions` (pre-flight F3). `owner`: an owner update (P3-12): the item
   * must be the org's, an extension-bearing target is refused, and a target dropping the
   * extension removes it.
   */
  private async diff(
    itemId: string,
    version: string,
    o: { pre?: Pre; target?: UpdateTarget; owner?: OwnerMode; confirmPending?: string } = {},
  ): Promise<UpdateDiff> {
    const db = this.db;
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    const item = await db
      .selectFrom("catalog_items")
      .select([
        "id",
        "name",
        "disabled",
        "builtin",
        "deleted_at",
        "platform_synced_version",
        "owner_org_id",
        "awaiting_confirmation",
        "pending_version",
        "latest_version",
      ])
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (!item || item.deleted_at !== null) throw itemNotFound();
    // A version waiting for the super admin applies only through their confirmation (P3-9, F8)
    if (o.confirmPending !== version) {
      if (item.awaiting_confirmation) throw itemPendingError(item.name);
      if (item.pending_version !== null && item.pending_version === version) {
        throw itemPendingError(item.name, version);
      }
      // The super admin's generic update of an org's plugin reaches only its applied version
      // (`latest_version`, ruling P3-34/P3-37): one the org uploaded that was never applied or
      // confirmed (a rejected or failed one) is not theirs to apply
      if (o.owner === undefined && item.owner_org_id !== null && version !== item.latest_version) {
        throw notApplied(item.name, version);
      }
    }
    if (o.owner !== undefined && item.owner_org_id !== o.owner.orgId) throw itemNotFound();
    if (item.disabled) {
      throw new ApiError(
        "catalog.item_disabled",
        "This plugin is disabled on the deployment; enable it before updating",
      );
    }
    const name = item.name;
    const versions = (await db
      .selectFrom("catalog_item_versions")
      .select([
        "version",
        "manifest",
        "object_prefix",
        "files",
        "extension_sha256",
        "applied_at",
        "rejected_at",
      ])
      .where("item_id", "=", itemId)
      .execute()) as (VersionRow & { applied_at: Date | null; rejected_at: Date | null })[];
    const to = o.target ?? versions.find((v) => v.version === version);
    if (!to)
      throw new ApiError("catalog.item_not_found", `Version ${version} of this item not found`);
    // Whoever owns the item now (a transfer keeps the version rows), the generic update never
    // reaches a version that was rejected or never applied (ruling P3-52)
    const row = versions.find((v) => v.version === version);
    if (o.owner === undefined && o.confirmPending !== version && row && !versionUsable(row)) {
      throw notApplied(item.name, version);
    }
    if (o.owner !== undefined && to.manifest.extension) {
      // An org's version with an extension waits for the super admin's confirmation (plan Task 6)
      throw new ApiError(
        "plugin.extension_upload_pending",
        `Version ${to.version} of plugin ${item.name} has an extension; it applies once a super admin confirms it`,
      );
    }
    const from = item.platform_synced_version;
    const fromRow = versions.find((v) => v.version === from);
    if (from === to.version) {
      // Confirming a preview whose update already ran (a concurrent confirm won): stale
      if (o.pre) throw stale();
      throw targetInvalid(`The platform already runs version ${from} of plugin ${name}`, [
        { reason: "same_version", version: from },
      ]);
    }

    const target = await this.extensionTarget(name, fromRow, to, o.owner !== undefined);
    let extension: ExtensionStep | null;
    if (o.pre) {
      // The confirm's transaction: the extension this update moved is expected in place (a
      // removed one gone)
      if (o.pre.extension) {
        const row = await db
          .selectFrom("extension_installs")
          .select("sha256")
          .where("name", "=", name)
          .executeTakeFirst();
        if ((row?.sha256 ?? null) !== o.pre.extension.sha256) throw stale();
        extension = o.pre.extension;
      } else {
        if (target !== null) throw stale();
        extension = null;
      }
    } else {
      extension = target && {
        ...target,
        needsApproval: target.sha256 !== null && (await this.needsApproval(name, target.sha256)),
        orgs: [],
      };
    }
    const contents = o.pre?.contents ?? (await this.readContents(to));
    const dependencies = await this.checkDependents(name, to);

    // The platform's components of the plugin and the target's
    const live = await this.liveComponents(itemId);
    const components: PlatformUpdateComponent[] = [];
    const suggest = new Map<string, boolean>();
    const direction = (fromVersion: string | null): UpdateChange =>
      fromVersion === null || compareVersions(to.version, fromVersion) >= 0
        ? "upgrade"
        : "downgrade";
    const added = (kind: ComponentKind, n: string): PlatformUpdateComponent => ({
      kind,
      id: null,
      name: n,
      change: "added",
      from: null,
      to: to.version,
      updatedOnOwn: false,
      ownScope: false,
      pinnedOrgs: [],
    });

    // Skills (by name, by their files' digest)
    const toSkills = contents.skillNames.map((n, i) => {
      const entry = (to.manifest.skills ?? [])[i];
      return {
        name: n,
        digest: dirDigest(to, packagePath(entry?.path as string)),
        pinned: entry?.pinned === true,
      };
    });
    for (const s of toSkills) {
      const l = live.skills.find((x) => x.name === s.name);
      if (!l) {
        components.push(added("skill", s.name));
        continue;
      }
      const same = skillFilesDigest(l.manifest.files) === s.digest;
      if (same && l.suggestPinned !== s.pinned) suggest.set(l.id, s.pinned);
      components.push({
        kind: "skill",
        id: l.id,
        name: s.name,
        change: same ? "same" : direction(l.catalogVersion),
        from: l.catalogVersion,
        to: to.version,
        updatedOnOwn: l.updatedOnOwn,
        ownScope: l.ownScope,
        pinnedOrgs: [],
      });
    }
    for (const l of live.skills) {
      if (toSkills.some((s) => s.name === l.name)) continue;
      components.push({
        kind: "skill",
        id: l.id,
        name: l.name,
        change: "removed",
        from: l.catalogVersion,
        to: null,
        updatedOnOwn: l.updatedOnOwn,
        ownScope: l.ownScope,
        pinnedOrgs: [],
      });
    }

    // Agent templates (by name, canonical definition)
    const toAgents = contents.agents;
    for (const a of toAgents) {
      const l = live.agentTemplates.find((x) => x.name === a.template.name);
      if (!l) {
        components.push(added("agent_template", a.template.name));
        continue;
      }
      const same = canonicalJson(l.definition) === canonicalJson(a.template);
      components.push({
        kind: "agent_template",
        id: l.id,
        name: l.name,
        change: same ? "same" : direction(l.catalogVersion),
        from: l.catalogVersion,
        to: to.version,
        updatedOnOwn: l.updatedOnOwn,
        ownScope: l.ownScope,
        pinnedOrgs: [],
      });
    }
    for (const l of live.agentTemplates) {
      if (toAgents.some((a) => a.template.name === l.name)) continue;
      components.push({
        kind: "agent_template",
        id: l.id,
        name: l.name,
        change: "removed",
        from: l.catalogVersion,
        to: null,
        updatedOnOwn: l.updatedOnOwn,
        ownScope: l.ownScope,
        pinnedOrgs: [],
      });
    }

    // Connector templates (by id, canonical file) and the connectors made from them
    const toTemplates = contents.templates;
    const deps = this.installer.templateDeps();
    const connectors: ConnectorChange[] = [];
    for (const ct of toTemplates) {
      const l = live.templates.find((x) => x.name === ct.id);
      if (!l) {
        const problem = templatePluginProblem(deps, ct.file.template);
        if (problem !== undefined) throw new ApiError("catalog.not_deployed", problem);
        components.push(added("connector_template", ct.id));
        continue;
      }
      const same = canonicalJson(l.file) === canonicalJson(ct.file);
      components.push({
        kind: "connector_template",
        id: l.id,
        name: ct.id,
        change: same ? "same" : direction(l.version),
        from: l.version,
        to: to.version,
        updatedOnOwn: false,
        ownScope: l.ownScope,
        pinnedOrgs: [],
      });
      if (same) continue;
      const before = l.file.template;
      const after = ct.file.template;
      if (before.plugin !== after.plugin || before.connector !== after.connector) {
        throw targetInvalid(
          `Connector template ${ct.id} moves to another connector (${after.plugin} "${after.connector}"); remove the plugin and import the new version as a new plugin instead`,
          [
            {
              reason: "template_connector",
              template: ct.id,
              plugin: after.plugin,
              connector: after.connector,
            },
          ],
        );
      }
      const made = await db
        .selectFrom("connectors")
        .select(["id", "org_id", "name", "connector", "endpoint", "auth"])
        .where("platform_template_id", "=", l.id)
        .where("deleted_at", "is", null)
        .orderBy("org_id")
        .orderBy("id")
        .execute();
      if (made.length > 0) {
        const problem = templatePluginProblem(deps, after);
        if (problem !== undefined) throw new ApiError("catalog.not_deployed", problem);
      }
      for (const c of made) {
        connectors.push({
          orgId: c.org_id,
          id: c.id,
          name: c.name,
          connector: c.connector,
          endpoint: c.endpoint,
          templateId: ct.id,
          file: ct.file,
          credentialsReset:
            credentialKey(c.auth as ConnectorAuth) !==
            credentialKey(after.auth as unknown as ConnectorAuth),
        });
      }
    }
    for (const l of live.templates) {
      if (toTemplates.some((x) => x.id === l.name)) continue;
      components.push({
        kind: "connector_template",
        id: l.id,
        name: l.name,
        change: "removed",
        from: l.version,
        to: null,
        updatedOnOwn: false,
        ownScope: l.ownScope,
        pinnedOrgs: [],
      });
    }

    // The orgs where the plugin is on (a live install; builtin: every org)
    const onOrgs = await this.pluginOrgs(itemId, item.builtin);
    if (extension) extension = { ...extension, orgs: onOrgs };

    // Rule 10: an added skill must not take a name already used where the plugin is on
    const conflicts: { skill: string; orgId: string; conflicts: string[] }[] = [];
    for (const c of components) {
      if (c.kind !== "skill" || c.change !== "added") continue;
      for (const orgId of onOrgs) {
        const ids = [
          ...(await clashingOrgSkills(db, orgId, { id: "", itemId }, c.name)),
          ...(await clashingPlatformSkills(db, orgId, { id: "" }, c.name)).map((x) => x.id),
        ];
        if (ids.length > 0) conflicts.push({ skill: c.name, orgId, conflicts: ids.sort() });
      }
    }
    if (conflicts.length > 0) {
      throw new ApiError(
        "plugin.skill_conflict",
        `The update adds skills whose names organizations already use where the plugin is on (${[...new Set(conflicts.map((c) => c.skill))].join(", ")}); remove or rename those skills first`,
        conflicts,
      );
    }

    // Pinned copies (in orgs where the component is on) and removed components agents use
    for (const kind of ["skill", "agent_template"] as const) {
      const mine = components.filter((c) => c.kind === kind && c.id !== null);
      if (mine.length === 0) continue;
      const pins =
        kind === "skill"
          ? await db
              .selectFrom("skills")
              .select(["org_id", "platform_skill_id as platform_id"])
              .where(
                "platform_skill_id",
                "in",
                mine.map((c) => c.id as string),
              )
              .where("pinned_version", "is not", null)
              .where("deleted_at", "is", null)
              .execute()
          : await db
              .selectFrom("agent_templates")
              .select(["org_id", "platform_template_id as platform_id"])
              .where(
                "platform_template_id",
                "in",
                mine.map((c) => c.id as string),
              )
              .where("pinned_version", "is not", null)
              .where("deleted_at", "is", null)
              .execute();
      const facts = mine.map((c) => {
        const l = (kind === "skill" ? live.skills : live.agentTemplates).find((x) => x.id === c.id);
        return {
          id: c.id as string,
          itemId,
          scopeMode: l?.scopeMode ?? "follow",
          scope: l?.scope ?? "optional",
          disabled: l?.disabled ?? false,
        };
      });
      const st = await loadScopeState(db, kind, facts);
      for (const c of mine) {
        const f = facts.find((x) => x.id === c.id);
        if (!f) continue;
        const orgsPinned = [
          ...new Set(pins.filter((p) => p.platform_id === c.id).map((p) => p.org_id)),
        ];
        c.pinnedOrgs = orgsPinned
          .filter((orgId) =>
            componentOn(
              f,
              pluginFactsOf(st, itemId, orgId),
              listedIn(st, f.id, orgId),
              switchOf(st, f.id, orgId),
            ),
          )
          .sort();
        if (c.change !== "removed") continue;
        const kept: NonNullable<PlatformUpdateComponent["kept"]> = [];
        for (const orgId of await this.liveOrgs()) {
          const agents = await agentsUsing(db, orgId, kind, [c.id as string]);
          if (agents.length > 0) {
            kept.push({ orgId, agents: agents.map((a) => ({ id: a.id, name: a.name })) });
          }
        }
        if (kept.length > 0) c.kept = kept;
      }
    }

    // The org connectors: changed templates' connectors, added templates needing input
    const addedTemplates = components
      .filter((c) => c.kind === "connector_template" && c.change === "added")
      .map((c) => c.name);
    const byOrg = new Map<string, PlatformUpdateConnectorOrg>();
    const entry = (orgId: string) => {
      const e = byOrg.get(orgId) ?? { orgId, connectors: [], needsConfig: [] };
      byOrg.set(orgId, e);
      return e;
    };
    for (const c of connectors) {
      entry(c.orgId).connectors.push({
        id: c.id,
        name: c.name,
        templateId: c.templateId,
        credentialsReset: c.credentialsReset,
      });
    }
    if (addedTemplates.length > 0) {
      for (const orgId of onOrgs) {
        const on = await connectorTemplatesOn(db, orgId, itemId, addedTemplates);
        if (on.size > 0) entry(orgId).needsConfig.push(...[...on].sort());
      }
    }
    const connectorOrgs = [...byOrg.values()]
      .map((e) => ({
        ...e,
        connectors: e.connectors.sort((a, b) =>
          `${a.templateId}\0${a.id}`.localeCompare(`${b.templateId}\0${b.id}`),
        ),
      }))
      .sort((a, b) => a.orgId.localeCompare(b.orgId));

    components.sort(
      (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
    );
    const diffHash = sha256(
      canonicalJson({
        itemId,
        from,
        to: to.version,
        manifest: to.manifest,
        files: filesDigest(to),
        // `needsApproval` is shown only: it does not change what the confirm does
        extension: extension && {
          from: extension.from,
          to: extension.to,
          orgs: extension.orgs,
          sha256: extension.sha256,
        },
        components,
        connectors: connectors.map((c) => ({
          id: c.id,
          endpoint: c.endpoint,
          reset: c.credentialsReset,
        })),
        connectorOrgs,
      }),
    );
    return {
      itemId,
      name,
      from,
      to,
      components,
      extension,
      connectors,
      connectorOrgs,
      suggest,
      contents,
      dependencies,
      diffHash,
    };
  }

  /** The target's skill names, agent templates and connector templates, from object storage. */
  private async readContents(to: VersionRow): Promise<TargetContents> {
    return {
      skillNames: await catalogSkillNames(this.storage, to, to.manifest),
      agents: await readCatalogAgentTemplates(this.storage, to),
      templates: await readCatalogTemplates(this.storage, to),
    };
  }

  /**
   * Whether the target's extension package asks for permissions the approved snapshot does not
   * cover (no snapshot, or a blocking addition): it then loads only once approved (§7.4).
   */
  private async needsApproval(name: string, sha: string): Promise<boolean> {
    if (this.config.get().extensionPermissions.autoApprove) return false;
    const pkg = await readExtensionPackage(await this.blobs.get(sha), {
      maxBytes: this.config.get().packages.maxBytes,
      hostSdkVersion: SDK_VERSION,
    });
    const snap = await this.db
      .selectFrom("extension_permission_snapshots")
      .select("permissions")
      .where("plugin", "=", name)
      .executeTakeFirst();
    if (!snap) return true;
    const { added } = diffPermissions(
      snap.permissions as PermissionSet,
      permissionSetOfPackage(pkg),
    );
    return blockingKeys(added).length > 0;
  }

  /**
   * The deployment's extension step: none when the target carries the extension the deployment
   * runs; a version without the extension the deployment runs for the plugin is refused, except
   * for an owner update (`allowRemove`, ruling P3-12': removing code runs none), which removes an
   * installed one; a move of a config-declared extension is refused.
   */
  private async extensionTarget(
    name: string,
    from: VersionRow | undefined,
    to: VersionRow,
    allowRemove = false,
  ): Promise<Omit<ExtensionStep, "needsApproval" | "orgs"> | null> {
    const want = to.manifest.extension;
    const row = await this.db
      .selectFrom("extension_installs")
      .select(["sha256", "version"])
      .where("name", "=", name)
      .executeTakeFirst();
    // Only an extension declared in the startup config runs without an install record; one this
    // replica still has loaded after its uninstall (until its reconcile) does not count
    const declared = this.registry.declared().get(name) === "config";
    const loaded = declared ? this.registry.manifests().find((m) => m.name === name) : undefined;
    if (!want) {
      if (allowRemove && from?.manifest.extension && row && !declared) {
        return { from: row.version, to: null, sha256: null, previous: row.sha256 };
      }
      if (from?.manifest.extension && (row || declared)) {
        throw targetInvalid(
          `Version ${to.version} of plugin ${name} has no extension, but the deployment runs it; uninstall the extension first`,
          [{ reason: "extension_removed", version: to.version }],
        );
      }
      return null;
    }
    if (row) {
      if (row.sha256 === to.extension_sha256) return null;
    } else if (declared) {
      if (loaded?.version === want.manifest.version) return null;
      throw targetInvalid(
        `The extension of plugin ${name} is declared in the startup config at version ${loaded?.version ?? "(not loaded)"}; it cannot be moved to ${want.manifest.version} by an update`,
        [{ reason: "config_extension", deploymentVersion: loaded?.version ?? null }],
      );
    }
    if (to.extension_sha256 === null) {
      throw targetInvalid(`Version ${to.version} of plugin ${name} has no extension package`, [
        { reason: "extension_package", version: to.version },
      ]);
    }
    return {
      from: row?.version ?? null,
      to: want.manifest.version,
      sha256: to.extension_sha256,
      previous: row?.sha256 ?? null,
    };
  }

  /**
   * Other platform plugins depending on this one must accept the target (their platform version's
   * dependency range); returns the catalog items of the target's own dependencies (their scope
   * sync is enqueued after the update: rule 9).
   */
  private async checkDependents(name: string, to: VersionRow): Promise<string[]> {
    const rows = await this.db
      .selectFrom("catalog_items as i")
      .innerJoin("catalog_item_versions as v", (j) =>
        j
          .onRef("v.item_id", "=", "i.id")
          .on(
            sql<string>`v.version`,
            "=",
            sql<string>`coalesce(i.platform_synced_version, i.latest_version)`,
          ),
      )
      .select(["i.id", "i.name", "v.manifest"])
      .where("i.deleted_at", "is", null)
      .execute();
    for (const r of rows) {
      if (r.name === name) continue;
      const range = (r.manifest as PluginManifest).dependencies?.find(
        (d) => d.name === name,
      )?.version;
      if (range !== undefined && !satisfiesRange(to.version, range)) {
        throw targetInvalid(
          `Plugin ${r.name} depends on ${name}@${range}, which version ${to.version} does not satisfy`,
          [{ reason: "dependent_range", dependent: r.name, range, version: to.version }],
        );
      }
    }
    const wanted = new Set((to.manifest.dependencies ?? []).map((d) => d.name));
    return rows.filter((r) => wanted.has(r.name)).map((r) => r.id);
  }

  /** The plugin's live platform components with their current versions. */
  private async liveComponents(itemId: string) {
    const db = this.db;
    const skills = (
      await db
        .selectFrom("platform_skills as p")
        .innerJoin("platform_skill_versions as v", (j) =>
          j.onRef("v.skill_id", "=", "p.id").onRef("v.version", "=", "p.current_version"),
        )
        .select([
          "p.id",
          "p.name",
          "p.scope_mode",
          "p.scope",
          "p.disabled",
          "v.manifest",
          "v.catalog_version",
          "v.updated_on_own",
          "v.suggest_pinned",
        ])
        .where("p.catalog_item_id", "=", itemId)
        .where("p.deleted_at", "is", null)
        .execute()
    ).map((r) => ({
      id: r.id,
      name: r.name,
      scopeMode: r.scope_mode,
      scope: r.scope,
      disabled: r.disabled,
      manifest: r.manifest as SkillManifest,
      catalogVersion: r.catalog_version,
      updatedOnOwn: r.updated_on_own,
      ownScope: r.scope_mode === "own",
      suggestPinned: r.suggest_pinned,
    }));
    const agentTemplates = (
      await db
        .selectFrom("platform_agent_templates as p")
        .innerJoin("platform_agent_template_versions as v", (j) =>
          j.onRef("v.template_id", "=", "p.id").onRef("v.version", "=", "p.current_version"),
        )
        .select([
          "p.id",
          "p.name",
          "p.scope_mode",
          "p.scope",
          "p.disabled",
          "v.definition",
          "v.catalog_version",
          "v.updated_on_own",
        ])
        .where("p.catalog_item_id", "=", itemId)
        .where("p.deleted_at", "is", null)
        .execute()
    ).map((r) => ({
      id: r.id,
      name: r.name,
      scopeMode: r.scope_mode,
      scope: r.scope,
      disabled: r.disabled,
      definition: r.definition,
      catalogVersion: r.catalog_version,
      updatedOnOwn: r.updated_on_own,
      ownScope: r.scope_mode === "own",
    }));
    const templates = (
      await db
        .selectFrom("platform_connector_templates")
        .select(["id", "template_id", "current_version", "file", "scope_mode"])
        .where("catalog_item_id", "=", itemId)
        .where("deleted_at", "is", null)
        .execute()
    ).map((r) => ({
      id: r.id,
      name: r.template_id,
      version: r.current_version,
      file: r.file as ConnectorTemplateFile,
      ownScope: r.scope_mode === "own",
    }));
    return { skills, agentTemplates, templates };
  }

  /** The orgs where the plugin is on: a live install (builtin: every live org). */
  private async pluginOrgs(itemId: string, builtin: boolean): Promise<string[]> {
    if (builtin) return this.liveOrgs();
    const rows = await this.db
      .selectFrom("plugin_installs as a")
      .innerJoin("orgs as o", "o.id", "a.org_id")
      .select("a.org_id")
      .distinct()
      .where("a.item_id", "=", itemId)
      .where("a.status", "in", ["installing", "installed", "upgrading"])
      .where("o.deleted_at", "is", null)
      .orderBy("a.org_id")
      .execute();
    return rows.map((r) => r.org_id);
  }

  private async liveOrgs(): Promise<string[]> {
    const rows = await this.db
      .selectFrom("orgs")
      .select("id")
      .where("deleted_at", "is", null)
      .orderBy("id")
      .execute();
    return rows.map((r) => r.id);
  }
}

/** The preview of a diff. */
function previewOf(d: UpdateDiff): PlatformUpdatePreview {
  return {
    itemId: d.itemId,
    name: d.name,
    from: d.from,
    to: d.to.version,
    components: d.components,
    extension: extensionView(d.extension),
    connectorOrgs: d.connectorOrgs,
    diffHash: d.diffHash,
  };
}

/** The extension step as the preview and the result show it. */
function extensionView(e: ExtensionStep | null): PlatformUpdatePreview["extension"] {
  return e && { from: e.from, to: e.to, orgs: e.orgs, needsApproval: e.needsApproval };
}
