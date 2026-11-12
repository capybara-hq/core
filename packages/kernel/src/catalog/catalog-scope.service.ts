import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionAdminOps } from "../extensions/admin-ops.js";
import { ExtensionAdmin } from "../extensions/admin-view.js";
import { ExtensionLifecycle } from "../extensions/lifecycle.js";
import { PluginInstallLock } from "../extensions/locks.js";
import { audit } from "../identity/audit.js";
import { SuperAdminLock } from "../identity/super-admin.js";
import { addOrgNotice, itemDisplayName, notifyItemShared } from "../inbox/org-notices.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock } from "../orgs/org-lock.js";
import {
  assertNotPlatformDefault,
  type ThemeAfter,
  type ThemePreview,
  themesPreview,
} from "../themes/theme-usage.js";
import { type ActorOpts, type CatalogItemView, CatalogService } from "./catalog.service.js";
import { assertOrgsExist, markVersionApplied } from "./catalog-items.js";
import { nameConflictError } from "./component-scope.service.js";
import {
  agentsUsing,
  COMPONENT_KINDS,
  type ComponentKind,
  componentOffered,
  componentOn,
  listedIn,
  loadComponents,
  loadScopeState,
  pluginFactsOf,
  skillNameClashes,
  switchOf,
  themeIdClashes,
} from "./component-state.js";
import { oweOwnedPluginCleanup } from "./job-ids.js";
import {
  assertNotAwaiting,
  assertOwnerListed,
  assertShareable,
  assertShareableTarget,
  itemRemovedError,
  newlySharedWith,
  ownerOf,
  ownersOf,
  PLATFORM_OWNER,
  packageOwner,
  pendingDigest,
  releaseExtensionClaim,
} from "./ownership.js";
import { type PluginConfirmResult, PluginImport } from "./plugin-import.js";
import { PluginInstaller } from "./plugin-install.js";
import { PlatformPluginUpdater } from "./plugin-upgrade.js";
import { cancelPendingRequests } from "./request-rules.js";
import { type PluginScope, wantedOn } from "./scope.js";
import { addScopeOrg } from "./scope-orgs.js";
import { PluginScopeSync, reconcileWithin } from "./scope-sync.js";
import { narrowComponentOnUnshare, narrowItemOnUnshare } from "./unshare.js";

/**
 * What a scope change or a deployment-level disable would take away (spec §5 rule 8): the orgs
 * that have the plugin on now (a live install) and would no longer want it, each with its agents
 * that use the plugin's skills, connectors or agent templates and the number of connectors it
 * created there, which stay as the org's own; and the orgs that would newly want
 * it but need inputs first (connector templates, a required org config), which the sync leaves as
 * `needs_config`. `scopeHash` is confirmed with the change.
 */
export interface ScopePreview {
  affected: {
    orgId: string;
    orgName: string;
    agents: { id: string; name: string }[];
    /** The connectors the plugin's install created there: they stay as the org's own. */
    connectorsKept: number;
  }[];
  needsConfig: string[];
  /**
   * A scope change only: the plugin's components with their own scope, which the change replaces
   * (they follow the plugin again, spec §5 rule 2).
   */
  replaced: { kind: ComponentKind; id: string; name: string }[];
  /**
   * The orgs the change would newly offer a skill of the plugin whose own skills already use its
   * name, or turn a theme of the plugin on in where another theme with its id is on (rule 10,
   * themes spec §6; `kind: "theme"` with the clashing themes in `themes`, `skills` empty): the
   * change is refused while there are any.
   */
  conflicts: {
    orgId: string;
    orgName: string;
    name: string;
    skills: string[];
    plugins: string[];
    /** Set for a theme id clash; absent for a skill. */
    kind?: "theme";
    /** A theme id clash: the clashing themes on in the org. */
    themes?: string[];
  }[];
  /**
   * The plugin's themes the change takes away from some orgs (themes spec §6): the orgs among
   * them whose default each is and how many people picked it. Absent when no theme is taken away.
   */
  themes?: ThemePreview[];
  scopeHash: string;
}

/** A scope change (`orgs` only with `named`) or a disable. */
export type ScopeTarget = { scope: PluginScope; orgs?: string[] } | { disabled: true };

/** The state a preview is computed against. */
interface Target {
  scope: PluginScope;
  orgs: string[];
  disabled: boolean;
  /** A scope change: components with their own scope follow the plugin again (rule 2). */
  scopeChange: boolean;
}

interface ItemRow {
  id: string;
  name: string;
  awaiting_confirmation: boolean;
  scope: PluginScope;
  builtin: boolean;
  disabled: boolean;
  latest_version: string;
  owner_org_id: string | null;
  shareable: boolean;
}

/** How long the super admin's confirmation waits for this replica to load the extension. */
const CONFIRM_RECONCILE_WAIT_MS = 5_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = ["installing", "installed", "upgrading"] as const;
const notFound = () => new ApiError("catalog.item_not_found", "Catalog item not found");
const notPending = (name: string) =>
  new ApiError("extension.not_pending", `Plugin ${name} has no upload waiting for confirmation`);
const pendingStale = (name: string) =>
  new ApiError(
    "extension.approval_stale",
    `The pending upload of ${name} changed since it was reviewed; review it again`,
  );
const builtinError = () =>
  new ApiError(
    "plugin.builtin",
    "This plugin is built in: it is on in every organization and its scope cannot be changed or disabled",
  );
const staleError = () =>
  new ApiError(
    "plugin.scope_stale",
    "What this change affects has changed since the preview; preview it again and confirm the new hash",
  );

/** The hash of a preview: sha256 over its sorted JSON, the target included. */
function scopeHash(target: Target, p: Omit<ScopePreview, "scopeHash">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        target: { ...target, orgs: [...target.orgs].sort() },
        affected: [...p.affected]
          .sort((a, b) => a.orgId.localeCompare(b.orgId))
          .map((a) => ({
            ...a,
            agents: [...a.agents].sort((x, y) => x.id.localeCompare(y.id)),
          })),
        needsConfig: [...p.needsConfig].sort(),
        replaced: [...p.replaced].sort((a, b) => a.id.localeCompare(b.id)),
        conflicts: [...p.conflicts].sort((a, b) => a.orgId.localeCompare(b.orgId)),
        // only when present: a preview without themes keeps the hash it had before themes
        ...(p.themes !== undefined && { themes: p.themes }),
      }),
    )
    .digest("hex");
}

/**
 * The refusal of a preview's conflicts: skill ones as `plugin.skill_conflict`, theme ones as
 * `theme.id_taken`; both at once as `plugin.skill_conflict` listing every clash (the skill details
 * first, then the theme ones `{ theme, orgId, themes, plugins }`), so none waits for a retry.
 */
export function conflictsError(conflicts: ScopePreview["conflicts"]): ApiError {
  const skills = conflicts.filter((c) => c.kind !== "theme");
  const themes = conflicts.filter((c) => c.kind === "theme").map(({ kind: _k, ...c }) => c);
  if (themes.length === 0) return nameConflictError(skills);
  const t = nameConflictError(themes, "theme");
  if (skills.length === 0) return t;
  const s = nameConflictError(skills);
  return new ApiError(s.code, `${s.message}\n${t.message}`, [
    ...(s.details ?? []),
    ...(t.details ?? []),
  ]);
}

/**
 * The super admin's plugin scope and deployment-level disable (plugin and component management
 * spec §4.1, §5 rules 2-4 and 8), and the import confirm that owes the scope sync of the item it
 * wrote. A change is previewed, then confirmed with the preview's `scopeHash`, recomputed under the
 * item row lock (a difference -> 409 `plugin.scope_stale`); it bumps `scope_version`, audits
 * `catalog.scope_changed` and owes the item's scope sync in the same transaction, which installs or
 * uninstalls in every org. Disabling keeps the scope, its org list and the org switches, so
 * re-enabling (no hash needed) reinstalls where it was on. Builtin items -> 409 `plugin.builtin`.
 * Stateless, shared by every replica.
 */
@Injectable()
export class CatalogScopeService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(SuperAdminLock) private readonly adminLock: SuperAdminLock,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(PluginImport) private readonly pluginImport: PluginImport,
    @Inject(PluginInstaller) private readonly installer: PluginInstaller,
    @Inject(ExtensionAdmin) private readonly extensions: ExtensionAdmin,
    @Inject(ExtensionAdminOps) private readonly ops: ExtensionAdminOps,
    @Inject(PluginScopeSync) private readonly sync: PluginScopeSync,
    @Inject(PlatformPluginUpdater) private readonly updater: PlatformPluginUpdater,
    /** The owner org's lock: an org admin withdrawing its pending upload (ruling P3-10). */
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    /** The per-name install lock a reject / withdraw releases the name claim under (M1). */
    @Inject(PluginInstallLock) private readonly installLock: PluginInstallLock,
    /** This replica's reconcile once a confirmed extension is enabled (before the scope sync). */
    @Inject(ExtensionLifecycle) private readonly lifecycle: ExtensionLifecycle,
    /** Owes the scope syncs and the removed org plugin's cleanup (P3-21, pre-flight F9). */
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * Confirms a staged import ({@link PluginImport.confirm}: installs and enables the extension,
   * writes the new item's scope), then owes the item's scope sync when its scope turns it on
   * by itself (`all` or `named`; an `optional` item is on only where an org admin switches it on).
   */
  async confirmImport(
    actor: string,
    stagingId: string,
    input: Parameters<PluginImport["confirm"]>[2],
    opts: ActorOpts = {},
  ): Promise<PluginConfirmResult> {
    const r = await this.pluginImport.confirm(actor, stagingId, input, opts);
    if (r.item.scope !== "optional") await this.oweSync(r.item.id);
    return r;
  }

  /**
   * Confirms the permissions of an item's extension (the admin's 待确认): approves the current
   * permission set with snapshot source `web` (`permissionsHash` is the item view's, the extension
   * review digest; a changed set -> 409 `extension.approval_stale`); an extension that was never
   * deployed (no install record) is installed and enabled first (the package is in the package
   * store from the import). Nothing waiting (a covered snapshot a person approved already, an item
   * without an extension) -> 409 `extension.not_pending`. Enqueues the item's scope sync after.
   *
   * An org-owned item is confirmed only while an upload of it waits (ruling P3-10, see
   * {@link confirmOrgUpload}); otherwise -> 409 `extension.not_pending`.
   */
  async confirmPermissions(
    actor: string,
    itemId: string,
    permissionsHash: string,
    opts: ActorOpts = {},
  ): Promise<CatalogItemView> {
    if (!UUID_RE.test(itemId)) throw notFound();
    const item = await this.db
      .selectFrom("catalog_items")
      .select([
        "id",
        "name",
        "latest_version",
        "builtin",
        "owner_org_id",
        "awaiting_confirmation",
        "pending_version",
        "scope",
      ])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!item) throw notFound();
    if (item.owner_org_id !== null) {
      return this.confirmOrgUpload(actor, { id: item.id, name: item.name }, permissionsHash, opts);
    }
    const version = await this.db
      .selectFrom("catalog_item_versions")
      .select("extension_sha256")
      .where("item_id", "=", itemId)
      .where("version", "=", item.latest_version)
      .executeTakeFirst();
    const sha256 = version?.extension_sha256 ?? null;
    if (sha256 === null) {
      throw new ApiError(
        "extension.not_pending",
        `Plugin ${item.name} has no extension to confirm`,
      );
    }
    const stale = () =>
      new ApiError(
        "extension.approval_stale",
        `The permissions of ${item.name} changed since they were reviewed; review them again`,
      );
    const installed = await this.extensions
      .get(item.name, { allowUnreadable: true })
      .then(() => true)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.code === "extension.not_found") return false;
        throw e;
      });
    if (!installed) {
      if ((await this.extensions.packageReviewHash(sha256)) !== permissionsHash) throw stale();
      await this.ops.install(item.name, sha256, actor, opts.actorTokenId, {
        catalogItemId: itemId,
      });
    }
    const current = await this.extensions.get(item.name);
    // A disabled install is what an earlier confirm that stopped before the enable left behind
    const disabled = current.desired?.state === "disabled";
    try {
      await this.extensions.approve(
        actor,
        item.name,
        { sha256: current.sha256, reviewHash: permissionsHash },
        { ...opts, confirmBootstrap: item.builtin },
      );
    } catch (e) {
      // Already approved but not enabled yet: carry on to the enable; else nothing to confirm
      if (!disabled || !(e instanceof ApiError && e.code === "extension.not_pending")) throw e;
    }
    // The permissions are confirmed (a stale hash refused above): the backstop before the enable
    // (ruling R24), so a crash before the post-deploy add below still converges the orgs; only
    // when the item's scope turns it on by itself, as the import's commit
    if (item.scope !== "optional") await this.oweBackstop(itemId);
    // An occupied single-provider point leaves it installed disabled (the admin view says why)
    if (disabled) await this.ops.enableUnlessOccupied(item.name, actor, opts.actorTokenId);
    await this.oweSync(itemId);
    return (await this.catalog.get(itemId)).item;
  }

  /**
   * The super admin's confirmation of an org upload's pending version (rulings P3-10, P3-11,
   * P3-21): `permissionsHash` must be the digest of that version's package ({@link pendingDigest};
   * another -> 409 `extension.approval_stale`, also for a version a later upload replaced); no
   * pending version (withdrawn, rejected, replaced by one without an extension) -> 409
   * `extension.not_pending`.
   *
   * A first version: its extension installed, its permissions approved, enabled, then (one
   * transaction) the item stops waiting and the owner is told (`upload_confirmed`); after the
   * commit its platform components are written and the scope sync owed. Each step re-reads
   * the item under its row lock: removed meanwhile -> 409 `catalog.item_removed`, the pending
   * version replaced -> `extension.approval_stale`; the extension this confirmation installed is
   * then taken out again. A new version: the platform update to it
   * ({@link PlatformPluginUpdater.updateToPending}, which installs or upgrades the extension,
   * clears the pending state, tells the owner and the orgs using a shared plugin), then its
   * permissions approved.
   */
  private async confirmOrgUpload(
    actor: string,
    item: { id: string; name: string },
    permissionsHash: string,
    opts: ActorOpts,
  ): Promise<CatalogItemView> {
    // Every step under the item's update lock (ruling P3-35): a second confirmation waits its
    // turn out as 409 plugin.install_in_progress and never undoes the first one's install
    const first = await this.updater.withItemLock(item.id, () =>
      this.confirmLocked(actor, item.id, item.name, permissionsHash, opts),
    );
    if (first !== null) {
      // Loaded here before the scope sync plans its install, waited for at most a few seconds
      // (the enable does not wait for the reconcile); a sync on a replica that has not loaded it
      // yet defers and retries (ruling P3-38)
      await reconcileWithin(
        this.lifecycle,
        `confirmed:${item.name}`,
        CONFIRM_RECONCILE_WAIT_MS,
        this.log,
      );
      await this.pluginImport.writePlatformComponents(item.id, first);
      await this.oweSync(item.id);
    }
    return (await this.catalog.get(item.id)).item;
  }

  /**
   * {@link confirmOrgUpload} under the item lock; returns the confirmed first version (its
   * platform components and scope sync follow after), null for a new version.
   */
  private async confirmLocked(
    actor: string,
    itemId: string,
    name: string,
    permissionsHash: string,
    opts: ActorOpts,
  ): Promise<string | null> {
    // Read again under the lock (the caller's read was outside it)
    const item = await this.db
      .selectFrom("catalog_items")
      .select([
        "deleted_at",
        "owner_org_id",
        "awaiting_confirmation",
        "pending_version",
        "pending_by",
        "pending_at",
        "package_name",
        "platform_synced_version",
      ])
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (!item || item.deleted_at !== null || item.owner_org_id === null) {
      throw itemRemovedError(name);
    }
    const version = item.pending_version;
    if (version === null) throw notPending(name);
    const row = await this.db
      .selectFrom("catalog_item_versions")
      .select("extension_sha256")
      .where("item_id", "=", itemId)
      .where("version", "=", version)
      .executeTakeFirst();
    const sha = row?.extension_sha256 ?? null;
    if (sha === null) throw notPending(name);
    const reviewHash = await this.extensions.packageReviewHash(sha);
    if (reviewHash === null || pendingDigest(sha, reviewHash) !== permissionsHash) {
      throw pendingStale(name);
    }
    // An install of this name that is not this item's (left by an earlier item, of another
    // package or of the same package name under another owner): the org's code never inherits its
    // deployment config, secrets or data (rulings P3-36, P3-51). This item's own install, or one
    // its owner's removed item of the same package left, is upgraded in place.
    const install = await this.db
      .selectFrom("extension_installs as x")
      .innerJoin("extension_packages as p", "p.sha256", "x.sha256")
      .leftJoin("catalog_items as ci", "ci.id", "x.catalog_item_id")
      .select(["x.sha256", "x.catalog_item_id", "p.package_name", "ci.owner_org_id"])
      .where("x.name", "=", name)
      .executeTakeFirst();
    const own =
      install === undefined ||
      (install.package_name === item.package_name &&
        (install.catalog_item_id === itemId ||
          (install.catalog_item_id !== null && install.owner_org_id === item.owner_org_id)));
    if (install !== undefined && !own) {
      // who holds it: the install's own item's owner, else the package's (none: the platform)
      const holderOrg = install.catalog_item_id === null ? null : install.owner_org_id;
      const holder =
        install.catalog_item_id !== null
          ? ownerOf(holderOrg, await ownersOf(this.db, holderOrg === null ? [] : [holderOrg]))
          : install.package_name !== item.package_name
            ? await packageOwner(this.db, install.package_name, name)
            : PLATFORM_OWNER;
      throw new ApiError(
        "extension.name_conflict",
        install.package_name !== item.package_name
          ? `Extension ${name} is installed from package ${install.package_name}; the upload's package ${item.package_name ?? "(none)"} cannot take it over`
          : `Extension ${name} is installed for another plugin of package ${install.package_name}; this upload cannot take it over`,
        [{ owner: holder }],
      );
    }
    if (!item.awaiting_confirmation) {
      const pending = {
        version,
        by: item.pending_by,
        at: item.pending_at,
      };
      // A new version: applied (unless an earlier confirmation applied it and stopped before the
      // approval), then its permissions approved; an approval that fails puts the pending state
      // back, so the version shows in 待确认 again (ruling P3-37)
      try {
        if (item.platform_synced_version !== version) {
          await this.updater.updateToPendingLocked(actor, itemId, version, opts);
        } else {
          await this.clearPending(itemId, version);
        }
        try {
          await this.approvePackage(actor, name, sha, reviewHash, opts);
        } catch (e) {
          await this.restorePending(itemId, pending);
          throw e;
        }
      } catch (e) {
        throw await this.removalOr(e, itemId, name);
      }
      return null;
    }
    await this.stillPending(itemId, name, version);
    let installedHere = false;
    try {
      if (install?.sha256 !== sha) {
        await this.ops.install(name, sha, actor, opts.actorTokenId, {
          catalogItemId: itemId,
          liveItem: true,
        });
        installedHere = install === undefined;
      }
      await this.stillPending(itemId, name, version);
      await this.approvePackage(actor, name, sha, reviewHash, opts);
      await this.stillPending(itemId, name, version);
      // An occupied single-provider point leaves it installed disabled (the admin view says why)
      await this.ops.enableUnlessOccupied(name, actor, opts.actorTokenId);
      await this.finishFirstVersion(actor, itemId, version, opts);
    } catch (e) {
      // Taken out only when this confirmation did not win: the item gone or still waiting
      if (installedHere && !(await this.confirmed(itemId))) {
        await this.takeOut(itemId, name, actor, opts);
      }
      throw await this.removalOr(e, itemId, name);
    }
    return version;
  }

  /** The item is live and its first version confirmed (no longer awaiting). */
  private async confirmed(itemId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("catalog_items")
      .select(["deleted_at", "awaiting_confirmation"])
      .where("id", "=", itemId)
      .executeTakeFirst();
    return row !== undefined && row.deleted_at === null && !row.awaiting_confirmation;
  }

  /**
   * The error a failed confirmation step answers with: 409 `catalog.item_removed` when the item is
   * gone or soft-deleted by now, whichever step failed (the removal's cleanup job may take the
   * extension out under the confirmation, so a step answers `extension.not_found`), the original
   * error logged; else (or when the item cannot be read) the original error.
   */
  private async removalOr(e: unknown, itemId: string, name: string): Promise<unknown> {
    if (e instanceof ApiError && e.code === "catalog.item_removed") return e;
    let removed: boolean;
    try {
      const row = await this.db
        .selectFrom("catalog_items")
        .select("deleted_at")
        .where("id", "=", itemId)
        .executeTakeFirst();
      removed = row === undefined || row.deleted_at !== null;
    } catch (err) {
      this.log.warn("cannot read the item of a failed confirmation", { itemId, err });
      return e;
    }
    if (!removed) return e;
    if (e instanceof ApiError) {
      this.log.info("a confirmation step failed after its item was removed", {
        itemId,
        name,
        code: e.code,
      });
    } else {
      this.log.warn("a confirmation step failed after its item was removed", {
        itemId,
        name,
        err: e,
      });
    }
    return itemRemovedError(name);
  }

  /** Clears the pending state of a version an earlier confirmation applied already. */
  @Transactional()
  private async clearPending(itemId: string, version: string): Promise<void> {
    await this.db
      .updateTable("catalog_items")
      .set({ pending_version: null, pending_by: null, pending_at: null })
      .where("id", "=", itemId)
      .where("pending_version", "=", version)
      .execute();
  }

  /**
   * Puts a confirmed new version's pending state back after its approval failed (ruling P3-37):
   * the version applied, its permissions still waiting, 待确认 shows it again. Not when another
   * upload is pending meanwhile.
   */
  @Transactional()
  private async restorePending(
    itemId: string,
    p: { version: string; by: string | null; at: Date | string | null },
  ): Promise<void> {
    await this.db
      .updateTable("catalog_items")
      .set({ pending_version: p.version, pending_by: p.by, pending_at: p.at })
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .where("pending_version", "is", null)
      .execute();
  }

  /** Approves the permissions of the installed package `sha` (already covered: nothing to do). */
  private async approvePackage(
    actor: string,
    name: string,
    sha: string,
    reviewHash: string,
    opts: ActorOpts,
  ): Promise<void> {
    try {
      await this.extensions.approve(actor, name, { sha256: sha, reviewHash }, opts);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "extension.not_pending")) throw e;
    }
  }

  /**
   * An extension a confirmation installed whose item was removed or replaced meanwhile is taken
   * out again (disabled, uninstalled; P3-21), and the name claim released when the item is gone
   * (ruling P3-37), in one transaction ({@link takeOutIn}). Inline (a failure is logged): when the
   * take-out fails, a removed item's cleanup job (`owned-plugin-cleanup-<itemId>`, idempotent) is
   * owed instead, so the job retries it (pre-flight F9). That owe is the last resort: when it
   * fails too (PG unavailable) nothing retries the take-out, and it is logged as an error.
   */
  private async takeOut(
    itemId: string,
    name: string,
    actor: string,
    opts: ActorOpts,
  ): Promise<void> {
    try {
      await this.takeOutIn(itemId, name, actor, opts);
      return;
    } catch (err) {
      this.log.error("taking out the extension of a removed org upload failed", { name, err });
    }
    try {
      await this.oweCleanupIfGone(itemId);
    } catch (err) {
      this.log.error("owing the owned plugin cleanup failed; the take-out is not retried", {
        itemId,
        err,
      });
    }
  }

  /**
   * {@link takeOut}'s transaction, in the global lock order (ruling P3-50): the super admin lock,
   * the item row, then the extension's install lock (taken by the disable): disabled,
   * uninstalled, and the name claim released when the item is gone.
   */
  @Transactional()
  private async takeOutIn(
    itemId: string,
    name: string,
    actor: string,
    opts: ActorOpts,
  ): Promise<void> {
    await this.adminLock.lockAndAuthorize(actor);
    const row = await this.db
      .selectFrom("catalog_items")
      .select(["deleted_at", "package_name"])
      .where("id", "=", itemId)
      .forUpdate()
      .executeTakeFirst();
    await this.ops.disable(name, actor, opts.actorTokenId);
    await this.ops.uninstall(name, actor, opts.actorTokenId);
    if (row === undefined || row.deleted_at !== null) {
      await releaseExtensionClaim(this.db, name, row?.package_name ?? null);
    }
  }

  /**
   * Owes the cleanup of a removed item; a live item owes nothing (a removal committing later owes
   * its own).
   */
  @Transactional()
  private async oweCleanupIfGone(itemId: string): Promise<void> {
    const gone = await this.db
      .selectFrom("catalog_items")
      .select("id")
      .where("id", "=", itemId)
      .where("deleted_at", "is not", null)
      .executeTakeFirst();
    if (gone !== undefined) await oweOwnedPluginCleanup(this.outbox, itemId);
  }

  /** The item is still live and pending with `version` (row lock), else 409 (P3-21). */
  @Transactional()
  private async stillPending(itemId: string, name: string, version: string): Promise<void> {
    await this.pendingRow(itemId, name, version);
  }

  /** {@link stillPending} in the caller's transaction; returns the owner org. */
  private async pendingRow(itemId: string, name: string, version: string): Promise<string> {
    const row = await this.db
      .selectFrom("catalog_items")
      .select(["deleted_at", "pending_version", "owner_org_id"])
      .where("id", "=", itemId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.deleted_at !== null || row.owner_org_id === null) {
      throw itemRemovedError(name);
    }
    if (row.pending_version !== version) throw pendingStale(name);
    return row.owner_org_id;
  }

  /** A confirmed first version: the item stops waiting, the owner is told (`upload_confirmed`). */
  @Transactional()
  private async finishFirstVersion(
    actor: string,
    itemId: string,
    version: string,
    opts: ActorOpts,
  ): Promise<void> {
    await this.adminLock.lockAndAuthorize(actor);
    const named = await this.db
      .selectFrom("catalog_items")
      .select("name")
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    const owner = await this.pendingRow(itemId, named.name, version);
    await this.db
      .updateTable("catalog_items")
      .set({
        awaiting_confirmation: false,
        pending_version: null,
        pending_by: null,
        pending_at: null,
        // the confirmed version is the item's latest (ruling P3-34)
        latest_version: version,
        updated_at: sql<Date>`now()` as unknown as Date,
      })
      .where("id", "=", itemId)
      .execute();
    await markVersionApplied(this.db, itemId, version);
    await addOrgNotice(this.db, owner, "upload_confirmed", {
      itemId,
      name: named.name,
      displayName: await itemDisplayName(this.db, itemId),
      version,
    });
    await audit(this.db, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      action: "catalog.upload_confirmed",
      target: itemId,
      detail: { name: named.name, version, ownerOrgId: owner },
    });
    // The confirmation's commit owes the sync's backstop (ruling R24); the immediate sync follows
    // the platform components
    await this.sync.enqueueBackstop(itemId);
  }

  /**
   * The super admin rejects an org upload's pending version (ruling P3-10, `reason` shown to the
   * owner in `upload_rejected`): a first version is removed (soft delete, its requests
   * cancelled), a new version's pending state cleared (the version stays imported, never applied);
   * the extension name claim is released when nothing is installed under it (pre-flight F10).
   * Nothing pending, or a platform-owned item (pre-flight F11) -> 409 `extension.not_pending`.
   */
  async reject(
    actor: string,
    itemId: string,
    reason: string | null,
    opts: ActorOpts = {},
  ): Promise<void> {
    if (!UUID_RE.test(itemId)) throw notFound();
    await this.dropPending(actor, itemId, { kind: "reject", reason }, opts);
  }

  /**
   * The owner org withdraws its pending upload (ruling P3-10): as {@link reject}, without a
   * notice. Another org's or a platform item -> 404; nothing pending -> 409
   * `extension.not_pending`.
   */
  async withdraw(
    orgId: string,
    actor: string,
    itemId: string,
    opts: ActorOpts = {},
  ): Promise<void> {
    if (!UUID_RE.test(itemId)) throw notFound();
    await this.dropPending(actor, itemId, { kind: "withdraw", orgId }, opts);
  }

  @Transactional()
  private async dropPending(
    actor: string,
    itemId: string,
    how: { kind: "reject"; reason: string | null } | { kind: "withdraw"; orgId: string },
    opts: ActorOpts,
  ): Promise<void> {
    if (how.kind === "reject") await this.adminLock.lockAndAuthorize(actor);
    else await this.orgLock.lockAndAuthorize(how.orgId, actor, "catalog.upload");
    const t = this.db;
    const item = await t
      .selectFrom("catalog_items")
      .select([
        "id",
        "name",
        "owner_org_id",
        "awaiting_confirmation",
        "pending_version",
        "package_name",
      ])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!item) throw notFound();
    if (how.kind === "withdraw" && item.owner_org_id !== how.orgId) throw notFound();
    if (item.owner_org_id === null || item.pending_version === null) throw notPending(item.name);
    const now = sql<Date>`now()` as unknown as Date;
    await t
      .updateTable("catalog_items")
      .set({
        pending_version: null,
        pending_by: null,
        pending_at: null,
        updated_at: now,
        // A first version is removed: the name is free again (P3-10)
        ...(item.awaiting_confirmation && { deleted_at: now }),
      })
      .where("id", "=", itemId)
      .execute();
    if (item.awaiting_confirmation) {
      await cancelPendingRequests(t, { itemId }, actor, "item_removed", opts);
    }
    if (how.kind === "reject") {
      // never usable afterwards, whoever owns the item later (ruling P3-52)
      await t
        .updateTable("catalog_item_versions")
        .set({ rejected_at: now })
        .where("item_id", "=", itemId)
        .where("version", "=", item.pending_version)
        .execute();
    }
    // Under the per-name install lock, as CatalogService.removeIn: a confirm's install still
    // committing is seen, so its claim is never released under it
    await this.installLock.lock(item.name);
    await releaseExtensionClaim(t, item.name, item.package_name);
    if (how.kind === "reject") {
      await addOrgNotice(t, item.owner_org_id, "upload_rejected", {
        itemId,
        name: item.name,
        displayName: await itemDisplayName(t, itemId),
        version: item.pending_version,
        reason: how.reason,
      });
    }
    await audit(t, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      action: how.kind === "reject" ? "catalog.upload_rejected" : "catalog.upload_withdrawn",
      target: itemId,
      detail: {
        name: item.name,
        version: item.pending_version,
        ownerOrgId: item.owner_org_id,
        removed: item.awaiting_confirmation,
        ...(how.kind === "reject" && { reason: how.reason }),
        ...opts.auditDetail,
      },
    });
  }

  /** The preview of a scope change or a disable (nothing written). */
  async preview(itemId: string, target: ScopeTarget): Promise<ScopePreview> {
    const item = await this.item(itemId, false);
    return this.compute(item, await this.targetOf(item, target));
  }

  /** Changes the scope after its preview (`scopeHash`); returns the item. */
  async setScope(
    actor: string,
    itemId: string,
    body: { scope: PluginScope; orgs?: string[]; scopeHash: string },
    opts: ActorOpts = {},
  ): Promise<CatalogItemView> {
    if (!UUID_RE.test(itemId)) throw notFound();
    const target = { scope: body.scope, ...(body.orgs !== undefined && { orgs: body.orgs }) };
    await this.writeScope(actor, itemId, target, body.scopeHash, opts);
    return (await this.catalog.get(itemId)).item;
  }

  /**
   * Disables the plugin on the whole deployment (after its preview, `scopeHash` required) or
   * enables it again (no hash); returns the item.
   */
  async setDisabled(
    actor: string,
    itemId: string,
    body: { disabled: boolean; scopeHash?: string },
    opts: ActorOpts = {},
  ): Promise<CatalogItemView> {
    if (!UUID_RE.test(itemId)) throw notFound();
    if (body.disabled && body.scopeHash === undefined) {
      throw new ApiError(
        "validation_failed",
        "scopeHash: required when disabling (from POST scope/preview with disabled: true)",
        [{ path: "scopeHash", message: "required when disabling" }],
      );
    }
    await this.writeDisabled(actor, itemId, body.disabled, body.scopeHash, opts);
    return (await this.catalog.get(itemId)).item;
  }

  /** Shows or hides the item to orgs outside its `named` list; returns the item. */
  async setShown(
    actor: string,
    itemId: string,
    shown: boolean,
    opts: ActorOpts = {},
  ): Promise<CatalogItemView> {
    if (!UUID_RE.test(itemId)) throw notFound();
    await this.writeShown(actor, itemId, shown, opts);
    return (await this.catalog.get(itemId)).item;
  }

  @Transactional()
  private async writeShown(
    actor: string,
    itemId: string,
    shown: boolean,
    opts: ActorOpts,
  ): Promise<void> {
    await this.adminLock.lockAndAuthorize(actor);
    // A builtin item is `all`: the flag is irrelevant there but harmless, so it is not refused
    const item = await this.db
      .selectFrom("catalog_items")
      .select(["name", "shown_to_others", "owner_org_id", "shareable", "awaiting_confirmation"])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!item) throw notFound();
    // A first version waiting for the super admin is nobody's to show yet (P3-9)
    assertNotAwaiting(item);
    // Showing goes through the share gate (P3-16); hiding is always allowed
    if (shown) assertShareable(item);
    if (item.shown_to_others === shown) return;
    await this.db
      .updateTable("catalog_items")
      .set({ shown_to_others: shown, updated_at: sql<Date>`now()` as unknown as Date })
      .where("id", "=", itemId)
      .execute();
    await audit(this.db, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      action: "catalog.shown_changed",
      target: itemId,
      detail: { name: item.name, from: item.shown_to_others, to: shown, ...opts.auditDetail },
    });
  }

  @Transactional()
  private async writeScope(
    actor: string,
    itemId: string,
    target: { scope: PluginScope; orgs?: string[] },
    hash: string,
    opts: ActorOpts,
  ): Promise<void> {
    await this.adminLock.lockAndAuthorize(actor);
    const item = await this.item(itemId, true);
    assertNotAwaiting(item);
    const t = await this.targetOf(item, target);
    const from = await this.listed(itemId);
    // The owner stays listed (P3-17); widening goes through the share gate (P3-16)
    assertOwnerListed(item, t);
    assertShareableTarget(item, { scope: item.scope, orgs: from }, t);
    // A scope change sends every theme back to following the plugin (rule 2): each is `all` after
    // only when the plugin is (themes spec §7)
    await this.assertKeepsPlatformDefault(item.id, (c) =>
      c.disabled || item.disabled ? "gone" : t.scope === "all" ? "all" : "narrower",
    );
    const p = await this.compute(item, t);
    if (p.scopeHash !== hash) throw staleError();
    if (p.conflicts.length > 0) throw conflictsError(p.conflicts);
    if (item.scope === t.scope && from.join() === t.orgs.join() && p.replaced.length === 0) return;
    await this.followAgain(actor, itemId, p.replaced, opts);
    await this.db
      .updateTable("catalog_items")
      .set({
        scope: t.scope,
        scope_version: sql<number>`scope_version + 1`,
        updated_at: sql<Date>`now()` as unknown as Date,
      })
      .where("id", "=", itemId)
      .execute();
    await this.db.deleteFrom("catalog_item_scope_orgs").where("item_id", "=", itemId).execute();
    if (t.orgs.length > 0) {
      await this.db
        .insertInto("catalog_item_scope_orgs")
        .values(t.orgs.map((org_id) => ({ item_id: itemId, org_id })))
        .execute();
    }
    const shared = newlySharedWith({ scope: item.scope, orgs: from }, t);
    if (shared === "all_orgs" || shared.length > 0) {
      await notifyItemShared(
        this.db,
        item.owner_org_id,
        { kind: "plugin", id: itemId },
        item.name,
        shared,
      );
    }
    await audit(this.db, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      action: "catalog.scope_changed",
      target: itemId,
      detail: {
        name: item.name,
        from: { scope: item.scope, orgs: from },
        to: { scope: t.scope, orgs: t.orgs },
        ...opts.auditDetail,
      },
    });
    await this.enqueue(itemId);
  }

  @Transactional()
  private async writeDisabled(
    actor: string,
    itemId: string,
    disabled: boolean,
    hash: string | undefined,
    opts: ActorOpts,
  ): Promise<void> {
    await this.adminLock.lockAndAuthorize(actor);
    const item = await this.item(itemId, true);
    if (item.disabled === disabled) return;
    if (disabled) await this.assertKeepsPlatformDefault(item.id, () => "gone");
    const p = await this.compute(
      item,
      disabled
        ? await this.targetOf(item, { disabled: true })
        : { scope: item.scope, orgs: await this.listed(itemId), disabled, scopeChange: false },
    );
    if (disabled && p.scopeHash !== hash) throw staleError();
    if (p.conflicts.length > 0) throw conflictsError(p.conflicts);
    await this.db
      .updateTable("catalog_items")
      .set({
        disabled,
        scope_version: sql<number>`scope_version + 1`,
        updated_at: sql<Date>`now()` as unknown as Date,
      })
      .where("id", "=", itemId)
      .execute();
    await audit(this.db, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      action: "catalog.scope_changed",
      target: itemId,
      detail: {
        name: item.name,
        disabled: { from: item.disabled, to: disabled },
        ...opts.auditDetail,
      },
    });
    await this.enqueue(itemId);
  }

  /**
   * Writes an org-owned plugin's 可共享 flag and copies it to its component rows (ruling P3-2).
   * Turning it off narrows an `optional` / `all` plugin, and each component with its own such
   * scope, to the owner plus the orgs where it is on now (ruling P3-25), and owes the item's
   * scope sync with it. The caller authorizes (the owner org's admin, Task 7). A platform
   * item (no owner) or a missing one -> 404.
   */
  @Transactional()
  async setShareable(itemId: string, shareable: boolean, actor: string | null = null) {
    if (!UUID_RE.test(itemId)) throw notFound();
    const item = await this.db
      .selectFrom("catalog_items")
      .select(["id", "name", "scope", "builtin", "owner_org_id", "shareable"])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!item || item.owner_org_id === null) throw notFound();
    await this.db
      .updateTable("catalog_items")
      .set({ shareable })
      .where("id", "=", itemId)
      .execute();
    for (const table of [
      "platform_skills",
      "platform_agent_templates",
      "platform_connector_templates",
      "platform_themes",
    ] as const) {
      await this.db
        .updateTable(table as "platform_skills")
        .set({ shareable })
        .where("catalog_item_id", "=", itemId)
        .where("deleted_at", "is", null)
        .execute();
    }
    if (shareable) return;
    const narrowed = await narrowItemOnUnshare(this.db, actor, item);
    for (const kind of COMPONENT_KINDS) {
      for (const c of await loadComponents(this.db, kind, { itemId, forUpdate: true })) {
        await narrowComponentOnUnshare(this.db, actor, c);
      }
    }
    if (narrowed) await this.enqueue(itemId);
  }

  /**
   * Adds one org to a `named` item's list in the caller's transaction (an approved `access`
   * request, spec §5.1 rule 2): nobody loses access, so no preview. The item row is locked; it
   * must be live and not builtin (404 / `plugin.builtin`). Bumps `scope_version`, audits
   * `catalog.scope_changed` and owes the item's scope sync in that transaction. Returns whether
   * the list changed (false: not `named`, or listed already).
   */
  @Transactional({ propagation: "mandatory" })
  async addOrg(
    actor: string,
    itemId: string,
    orgId: string,
    opts: ActorOpts & { requestId?: string } = {},
  ): Promise<boolean> {
    const item = await this.item(itemId, true);
    assertNotAwaiting(item);
    const changed = await addScopeOrg(this.db, actor, item, orgId, opts);
    if (changed) await this.enqueue(itemId);
    return changed;
  }

  /**
   * Owes the item's scope sync in the caller's transaction (an ownership transfer, an org upload's
   * confirm in `OrgPluginUploads`).
   */
  @Transactional({ propagation: "mandatory" })
  async enqueueSync(itemId: string): Promise<void> {
    await this.enqueue(itemId);
  }

  /** Owes the item's scope sync in the transaction that changes its scope (outbox spec §8.1). */
  @Transactional({ propagation: "mandatory" })
  private async enqueue(itemId: string): Promise<void> {
    await this.sync.enqueueItem(itemId);
  }

  /**
   * Owes the item's scope sync in a transaction of its own, after a confirmation whose last write
   * (the extension's deploy, or the platform components) committed outside the scope service: the
   * sync must not run before the extension it installs is enabled.
   */
  @Transactional()
  private async oweSync(itemId: string): Promise<void> {
    await this.enqueue(itemId);
  }

  /**
   * Owes the delayed backstop of the item's sync in a transaction of its own (ruling R24): a
   * permissions confirm writes nothing of the scope service's before its enable.
   */
  @Transactional()
  private async oweBackstop(itemId: string): Promise<void> {
    await this.sync.enqueueBackstop(itemId);
  }

  /**
   * 409 `theme.platform_default` when a live theme of the item is the platform default and `after`
   * says the change leaves it narrower than `all` or gone (themes spec §7). In the caller's
   * transaction, before anything is written.
   */
  private async assertKeepsPlatformDefault(
    itemId: string,
    after: (c: { disabled: boolean }) => ThemeAfter,
  ): Promise<void> {
    const themes = await loadComponents(this.db, "theme", { itemId });
    await assertNotPlatformDefault(
      this.db,
      themes.map((c) => c.id),
      (id) => after(themes.find((c) => c.id === id) ?? { disabled: false }),
    );
  }

  /** The live item (row locked with `forUpdate`); missing -> 404, builtin -> `plugin.builtin`. */
  private async item(itemId: string, forUpdate: boolean): Promise<ItemRow> {
    if (!UUID_RE.test(itemId)) throw notFound();
    let q = this.db
      .selectFrom("catalog_items")
      .select([
        "id",
        "name",
        "scope",
        "builtin",
        "disabled",
        "latest_version",
        "owner_org_id",
        "shareable",
        "awaiting_confirmation",
      ])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null);
    if (forUpdate) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    if (!row) throw notFound();
    if (row.builtin) throw builtinError();
    return row;
  }

  /** The `named` list of the item, sorted. */
  private async listed(itemId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("catalog_item_scope_orgs")
      .select("org_id")
      .where("item_id", "=", itemId)
      .orderBy("org_id")
      .execute();
    return rows.map((r) => r.org_id);
  }

  /** The state after the change: `orgs` only with `named`, each a live org. */
  private async targetOf(item: ItemRow, target: ScopeTarget): Promise<Target> {
    if ("disabled" in target) {
      return {
        scope: item.scope,
        orgs: await this.listed(item.id),
        disabled: true,
        scopeChange: false,
      };
    }
    if (target.orgs !== undefined && target.scope !== "named") {
      throw new ApiError("validation_failed", "orgs: only allowed with scope named", [
        { path: "orgs", message: "only allowed with scope named" },
      ]);
    }
    const orgs = [...new Set(target.orgs ?? [])].sort();
    await assertOrgsExist(this.db, orgs);
    return { scope: target.scope, orgs, disabled: item.disabled, scopeChange: true };
  }

  /** The preview of moving `item` to `target` (read through the current context). */
  private async compute(item: ItemRow, target: Target): Promise<ScopePreview> {
    const db = this.db;
    // one after the other: `db` may be a transaction's single connection
    const orgs = await db
      .selectFrom("orgs")
      .select(["id", "name"])
      .where("deleted_at", "is", null)
      .orderBy("id")
      .execute();
    const listedNow = new Set(await this.listed(item.id));
    const switches = await db
      .selectFrom("catalog_item_org_switches")
      .select(["org_id", "enabled"])
      .where("item_id", "=", item.id)
      .execute();
    const installs = await db
      .selectFrom("plugin_installs")
      .select(["id", "org_id"])
      .where("item_id", "=", item.id)
      .where("status", "in", [...LIVE])
      .execute();
    const sw = new Map(switches.map((s) => [s.org_id, s.enabled]));
    const live = new Map(installs.map((a) => [a.org_id, a.id]));
    const listedAfter = new Set(target.orgs);
    const after = { scope: target.scope, disabled: target.disabled, builtin: false };
    const affected: ScopePreview["affected"] = [];
    const needsConfig: string[] = [];
    /** The orgs the plugin will be on in after the change (a live install kept or made). */
    const onAfter = new Set<string>();
    for (const org of orgs) {
      const s = sw.get(org.id) ?? null;
      const wanted = wantedOn(after, listedAfter.has(org.id), s);
      const installId = live.get(org.id);
      if (installId !== undefined) {
        // A live install another one depends on stays (spec §5 rule 9, as the sync does)
        if (wanted || (await this.sync.dependedOn(org.id, installId))) {
          onAfter.add(org.id);
          continue;
        }
        const p = await this.installer.previewUninstall(org.id, installId);
        affected.push({
          orgId: org.id,
          orgName: org.name,
          agents: p.agents.map((a) => ({ id: a.id, name: a.name })),
          // The sync's uninstall keeps the connectors the install created as the org's own
          connectorsKept: p.components.filter((c) => c.kind === "connector" && c.created).length,
        });
        continue;
      }
      if (!wanted || wantedOn(item, listedNow.has(org.id), s)) continue;
      let needs = false;
      try {
        needs = await this.sync.needsInput(org.id, item.id, item.latest_version);
      } catch (e) {
        // Not installable as it is (a dependency unresolved): the sync reports it. Anything else
        // (a database error) propagates: inside the write's transaction it is not recoverable
        if (!(e instanceof ApiError)) throw e;
      }
      if (needs) needsConfig.push(org.id);
      else onAfter.add(org.id);
    }
    const { replaced, conflicts, themesLost } = await this.componentChanges(
      item,
      target,
      orgs,
      onAfter,
      affected,
    );
    const themes = await themesPreview(db, themesLost);
    const p = {
      affected,
      needsConfig,
      replaced,
      conflicts,
      ...(themes !== undefined && { themes }),
    };
    return { ...p, scopeHash: scopeHash(target, p) };
  }

  /**
   * The component side of a plugin scope change or disable (spec §5 rules 2, 8, 10): the
   * components with their own scope a scope change replaces; the orgs where a skill or agent
   * template is on now and would be off after (agents merged into `affected`: a component with its
   * own scope that goes back to following the plugin, or one cut by the disable); and the orgs a
   * skill would newly be offered to whose own skills use its name, or a theme would come on in
   * where another theme with its id is on; and per theme the orgs it would go off in
   * (`themesLost`). `onAfter`: the orgs the plugin is on in after the change.
   */
  private async componentChanges(
    item: ItemRow,
    target: Target,
    orgs: { id: string; name: string }[],
    onAfter: Set<string>,
    affected: ScopePreview["affected"],
  ): Promise<
    Pick<ScopePreview, "replaced" | "conflicts"> & { themesLost: Map<string, Set<string>> }
  > {
    const db = this.db;
    const replaced: ScopePreview["replaced"] = [];
    const conflicts: ScopePreview["conflicts"] = [];
    const themesLost = new Map<string, Set<string>>();
    const lose = new Map<string, Map<string, string>>();
    for (const kind of COMPONENT_KINDS) {
      const comps = await loadComponents(db, kind, { itemId: item.id });
      if (comps.length === 0) continue;
      if (target.scopeChange) {
        for (const c of comps) {
          if (c.scopeMode === "own") replaced.push({ kind, id: c.id, name: c.name });
        }
      }
      if (kind === "connector_template") continue;
      const st = await loadScopeState(db, kind, comps);
      for (const c of comps) {
        const cAfter = target.scopeChange ? { ...c, scopeMode: "follow" as const } : c;
        for (const org of orgs) {
          const pNow = pluginFactsOf(st, c.itemId, org.id);
          const pAfter = pNow && {
            ...pNow,
            scope: target.scope,
            disabled: target.disabled,
            listed: target.orgs.includes(org.id),
            installed: onAfter.has(org.id),
          };
          const listed = listedIn(st, c.id, org.id);
          const s = switchOf(st, c.id, org.id);
          const onNow = componentOn(c, pNow, listed, s);
          const onAfterChange = componentOn(cAfter, pAfter, listed, s);
          if (kind === "theme") {
            if (onNow && !onAfterChange) {
              const set = themesLost.get(c.id) ?? new Set<string>();
              set.add(org.id);
              themesLost.set(c.id, set);
            }
            if (onAfterChange && !onNow) {
              const clash = await themeIdClashes(db, org.id, c, c.name);
              if (clash.length > 0) {
                conflicts.push({
                  orgId: org.id,
                  orgName: org.name,
                  name: c.name,
                  skills: [],
                  themes: clash.map((x) => x.id),
                  plugins: clash.map((x) => x.plugin ?? "platform"),
                  kind: "theme",
                });
              }
            }
            continue;
          }
          if (onNow && !onAfterChange) {
            for (const a of await agentsUsing(db, org.id, kind, [c.id])) {
              const m = lose.get(org.id) ?? new Map<string, string>();
              m.set(a.id, a.name);
              lose.set(org.id, m);
            }
            if (!lose.has(org.id)) lose.set(org.id, new Map());
          }
          if (
            kind === "skill" &&
            componentOffered(cAfter, pAfter, listed) &&
            !componentOffered(c, pNow, listed)
          ) {
            const clash = await skillNameClashes(db, org.id, c, c.name);
            if (clash.skills.length > 0) {
              conflicts.push({ orgId: org.id, orgName: org.name, name: c.name, ...clash });
            }
          }
        }
      }
    }
    for (const org of orgs) {
      const m = lose.get(org.id);
      if (!m) continue;
      let e = affected.find((a) => a.orgId === org.id);
      if (!e) {
        e = { orgId: org.id, orgName: org.name, agents: [], connectorsKept: 0 };
        affected.push(e);
      }
      for (const [id, name] of m) {
        if (!e.agents.some((a) => a.id === id)) e.agents.push({ id, name });
      }
    }
    return { replaced, conflicts, themesLost };
  }

  /**
   * Sends the components of the item with their own scope back to following it (a plugin scope
   * change, spec §5 rule 2): `scope_mode = follow`, their own lists dropped, `scope_version`
   * bumped, one `component.scope_changed` audit each. In the caller's transaction.
   */
  private async followAgain(
    actor: string,
    itemId: string,
    replaced: ScopePreview["replaced"],
    opts: ActorOpts,
  ): Promise<void> {
    for (const r of replaced) {
      const table =
        r.kind === "skill"
          ? "platform_skills"
          : r.kind === "agent_template"
            ? "platform_agent_templates"
            : r.kind === "theme"
              ? "platform_themes"
              : "platform_connector_templates";
      await this.db
        .updateTable(table as "platform_skills")
        .set({
          scope_mode: "follow",
          scope_version: sql<number>`scope_version + 1`,
          updated_at: sql<Date>`now()` as unknown as Date,
        })
        .where("id", "=", r.id)
        .where("scope_mode", "=", "own")
        .execute();
      await this.db
        .deleteFrom("component_scope_orgs")
        .where("kind", "=", r.kind)
        .where("component_id", "=", r.id)
        .execute();
      await audit(this.db, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "component.scope_changed",
        target: r.id,
        detail: { kind: r.kind, name: r.name, itemId, to: { scopeMode: "follow" }, via: "plugin" },
      });
    }
  }
}
