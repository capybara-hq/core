import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionAdminOps } from "../extensions/admin-ops.js";
import { ExtensionAdmin } from "../extensions/admin-view.js";
import { audit } from "../identity/audit.js";
import { SuperAdminLock } from "../identity/super-admin.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { type ActorOpts, type CatalogItemView, CatalogService } from "./catalog.service.js";
import { assertOrgsExist } from "./catalog-items.js";
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
} from "./component-state.js";
import { assertOwnerListed, assertShareable, assertShareableTarget } from "./ownership.js";
import { type PluginConfirmResult, PluginImport } from "./plugin-import.js";
import { PluginInstaller } from "./plugin-install.js";
import { type PluginScope, wantedOn } from "./scope.js";
import { addScopeOrg } from "./scope-orgs.js";
import { PluginScopeSync } from "./scope-sync.js";
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
   * name (rule 10): the change is refused while there are any.
   */
  conflicts: {
    orgId: string;
    orgName: string;
    name: string;
    skills: string[];
    plugins: string[];
  }[];
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
  scope: PluginScope;
  builtin: boolean;
  disabled: boolean;
  latest_version: string;
  owner_org_id: string | null;
  shareable: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = ["installing", "installed", "upgrading"] as const;
const notFound = () => new ApiError("catalog.item_not_found", "Catalog item not found");
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
      }),
    )
    .digest("hex");
}

/**
 * The super admin's plugin scope and deployment-level disable (plugin and component management
 * spec §4.1, §5 rules 2-4 and 8), and the import confirm that enqueues the scope sync of the item it
 * wrote. A change is previewed, then confirmed with the preview's `scopeHash`, recomputed under the
 * item row lock (a difference -> 409 `plugin.scope_stale`); it bumps `scope_version`, audits
 * `catalog.scope_changed` and, after the commit, enqueues the item's scope sync, which installs or
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
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * Confirms a staged import ({@link PluginImport.confirm}: installs and enables the extension,
   * writes the new item's scope), then enqueues the item's scope sync when its scope turns it on
   * by itself (`all` or `named`; an `optional` item is on only where an org admin switches it on).
   */
  async confirmImport(
    actor: string,
    stagingId: string,
    input: Parameters<PluginImport["confirm"]>[2],
    opts: ActorOpts = {},
  ): Promise<PluginConfirmResult> {
    const r = await this.pluginImport.confirm(actor, stagingId, input, opts);
    if (r.item.scope !== "optional") await this.enqueue(r.item.id);
    return r;
  }

  /**
   * Confirms the permissions of an item's extension (the admin's 待确认): approves the current
   * permission set with snapshot source `web` (`permissionsHash` is the item view's, the extension
   * review digest; a changed set -> 409 `extension.approval_stale`); an extension that was never
   * deployed (no install record) is installed and enabled first (the package is in the package
   * store from the import). Nothing waiting (a covered snapshot a person approved already, an item
   * without an extension) -> 409 `extension.not_pending`. Enqueues the item's scope sync after.
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
      .select(["id", "name", "latest_version", "builtin"])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!item) throw notFound();
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
    if (disabled) await this.ops.enable(item.name, actor, opts.actorTokenId);
    await this.enqueue(itemId);
    return (await this.catalog.get(itemId)).item;
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
      .select(["name", "shown_to_others", "owner_org_id", "shareable"])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!item) throw notFound();
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
      detail: { name: item.name, from: item.shown_to_others, to: shown },
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
    const t = await this.targetOf(item, target);
    const from = await this.listed(itemId);
    // The owner stays listed (P3-17); widening goes through the share gate (P3-16)
    assertOwnerListed(item, t);
    assertShareableTarget(item, { scope: item.scope, orgs: from }, t);
    const p = await this.compute(item, t);
    if (p.scopeHash !== hash) throw staleError();
    if (p.conflicts.length > 0) throw nameConflictError(p.conflicts);
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
    await audit(this.db, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      action: "catalog.scope_changed",
      target: itemId,
      detail: {
        name: item.name,
        from: { scope: item.scope, orgs: from },
        to: { scope: t.scope, orgs: t.orgs },
      },
    });
    afterCommit(() => this.enqueue(itemId));
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
    const p = await this.compute(
      item,
      disabled
        ? await this.targetOf(item, { disabled: true })
        : { scope: item.scope, orgs: await this.listed(itemId), disabled, scopeChange: false },
    );
    if (disabled && p.scopeHash !== hash) throw staleError();
    if (p.conflicts.length > 0) throw nameConflictError(p.conflicts);
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
      detail: { name: item.name, disabled: { from: item.disabled, to: disabled } },
    });
    afterCommit(() => this.enqueue(itemId));
  }

  /**
   * Writes an org-owned plugin's 可共享 flag and copies it to its component rows (ruling P3-2).
   * Turning it off narrows an `optional` / `all` plugin, and each component with its own such
   * scope, to the owner plus the orgs where it is on now (ruling P3-25), and enqueues the item's
   * scope sync after the commit. The caller authorizes (the owner org's admin, Task 7). A platform
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
    if (narrowed) afterCommit(() => this.enqueue(itemId));
  }

  /**
   * Adds one org to a `named` item's list in the caller's transaction (an approved `access`
   * request, spec §5.1 rule 2): nobody loses access, so no preview. The item row is locked; it
   * must be live and not builtin (404 / `plugin.builtin`). Bumps `scope_version`, audits
   * `catalog.scope_changed` and enqueues the item's scope sync after the commit. Returns whether
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
    const changed = await addScopeOrg(this.db, actor, item, orgId, opts);
    if (changed) afterCommit(() => this.enqueue(itemId));
    return changed;
  }

  /** Enqueues the item's scope sync; a failure only warns (the next change or org sync converges). */
  private async enqueue(itemId: string): Promise<void> {
    try {
      await this.sync.enqueueItem(itemId);
    } catch (err) {
      this.log.warn("enqueueing the plugin scope sync failed", { itemId, err });
    }
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
    const { replaced, conflicts } = await this.componentChanges(
      item,
      target,
      orgs,
      onAfter,
      affected,
    );
    const p = { affected, needsConfig, replaced, conflicts };
    return { ...p, scopeHash: scopeHash(target, p) };
  }

  /**
   * The component side of a plugin scope change or disable (spec §5 rules 2, 8, 10): the
   * components with their own scope a scope change replaces; the orgs where a skill or agent
   * template is on now and would be off after (agents merged into `affected`: a component with its
   * own scope that goes back to following the plugin, or one cut by the disable); and the orgs a
   * skill would newly be offered to whose own skills use its name. `onAfter`: the orgs the plugin
   * is on in after the change.
   */
  private async componentChanges(
    item: ItemRow,
    target: Target,
    orgs: { id: string; name: string }[],
    onAfter: Set<string>,
    affected: ScopePreview["affected"],
  ): Promise<Pick<ScopePreview, "replaced" | "conflicts">> {
    const db = this.db;
    const replaced: ScopePreview["replaced"] = [];
    const conflicts: ScopePreview["conflicts"] = [];
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
          if (componentOn(c, pNow, listed, s) && !componentOn(cAfter, pAfter, listed, s)) {
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
    return { replaced, conflicts };
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
