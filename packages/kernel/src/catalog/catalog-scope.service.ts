import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { EnterpriseAdminLock } from "../identity/enterprise-admin.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { type ActorOpts, type CatalogItemView, CatalogService } from "./catalog.service.js";
import { assertOrgsExist } from "./catalog-items.js";
import { type PluginConfirmResult, PluginImport } from "./plugin-import.js";
import { PluginInstaller } from "./plugin-install.js";
import { type PluginScope, wantedOn } from "./scope.js";
import { PluginScopeSync } from "./scope-sync.js";

/**
 * What a scope change or a deployment-level disable would take away (spec §5 rule 8): the orgs
 * that have the plugin on now (a live install) and would no longer want it, each with its agents
 * that use the plugin's skills, connectors or agent templates; and the orgs that would newly want
 * it but need inputs first (connector templates, a required org config), which the sync leaves as
 * `needs_config`. `scopeHash` is confirmed with the change.
 */
export interface ScopePreview {
  affected: { orgId: string; orgName: string; agents: { id: string; name: string }[] }[];
  needsConfig: string[];
  scopeHash: string;
}

/** A scope change (`orgs` only with `named`) or a disable. */
export type ScopeTarget = { scope: PluginScope; orgs?: string[] } | { disabled: true };

/** The state a preview is computed against. */
interface Target {
  scope: PluginScope;
  orgs: string[];
  disabled: boolean;
}

interface ItemRow {
  id: string;
  name: string;
  scope: PluginScope;
  builtin: boolean;
  disabled: boolean;
  latest_version: string;
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
      }),
    )
    .digest("hex");
}

/**
 * The enterprise admin's plugin scope and deployment-level disable (plugin and component management
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
    @Inject(EnterpriseAdminLock) private readonly adminLock: EnterpriseAdminLock,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(PluginImport) private readonly pluginImport: PluginImport,
    @Inject(PluginInstaller) private readonly installer: PluginInstaller,
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
    if ((await this.compute(item, t)).scopeHash !== hash) throw staleError();
    const from = await this.listed(itemId);
    if (item.scope === t.scope && from.join() === t.orgs.join()) return;
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
    if (disabled) {
      const p = await this.compute(item, await this.targetOf(item, { disabled: true }));
      if (p.scopeHash !== hash) throw staleError();
    }
    if (item.disabled === disabled) return;
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
      .select(["id", "name", "scope", "builtin", "disabled", "latest_version"])
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
      return { scope: item.scope, orgs: await this.listed(item.id), disabled: true };
    }
    if (target.orgs !== undefined && target.scope !== "named") {
      throw new ApiError("validation_failed", "orgs: only allowed with scope named", [
        { path: "orgs", message: "only allowed with scope named" },
      ]);
    }
    const orgs = [...new Set(target.orgs ?? [])].sort();
    await assertOrgsExist(this.db, orgs);
    return { scope: target.scope, orgs, disabled: item.disabled };
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
    for (const org of orgs) {
      const s = sw.get(org.id) ?? null;
      const wanted = wantedOn(after, listedAfter.has(org.id), s);
      const installId = live.get(org.id);
      if (installId !== undefined) {
        // A live install another one depends on stays (spec §5 rule 9, as the sync does)
        if (wanted || (await this.sync.dependedOn(org.id, installId))) continue;
        const p = await this.installer.previewUninstall(org.id, installId);
        affected.push({
          orgId: org.id,
          orgName: org.name,
          agents: p.agents.map((a) => ({ id: a.id, name: a.name })),
        });
        continue;
      }
      if (!wanted || wantedOn(item, listedNow.has(org.id), s)) continue;
      let needs = false;
      try {
        needs = await this.sync.needsInput(org.id, item.id, item.latest_version);
      } catch {
        // Not installable as it is (a dependency unresolved): the sync reports it
      }
      if (needs) needsConfig.push(org.id);
    }
    const p = { affected, needsConfig };
    return { ...p, scopeHash: scopeHash(target, p) };
  }
}
