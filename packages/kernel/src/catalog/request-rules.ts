import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { isUsable, itemPendingError } from "./ownership.js";
import { visibleTo } from "./scope.js";

/**
 * The catalog's database-level rules shared by the installers, the import confirm and the request
 * service (kept apart from `CatalogRequestsService` so the services that depend on them do not
 * import it): whether an item may be newly installed in an org, and the request rows an install,
 * an import confirm or a deletion resolves.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const itemDisabled = () =>
  new ApiError(
    "catalog.item_disabled",
    "This catalog item is disabled by the super admin and cannot be newly installed",
  );

/** Reads the item in the caller's transaction (FOR SHARE: exclusive with the admin disabling or deleting it). Missing or deleted -> undefined. */
async function lockItem(t: KernelSchemaDb, itemId: string) {
  if (!UUID_RE.test(itemId)) return undefined;
  return t
    .selectFrom("catalog_items")
    .select(["id", "name", "disabled", "scope", "builtin", "deleted_at", "awaiting_confirmation"])
    .where("id", "=", itemId)
    .forShare()
    .executeTakeFirst();
}

/**
 * Before an org creates a component from the catalog (enabling an extension, creating a connector
 * from a template, importing a skill), re-checks in the caller's transaction that the item is live
 * and not disabled by the super admin (`catalog.item_disabled`). A dependency's components
 * pass `approvedBy`, the item the org is installing: the dependency's own item must still be live
 * and not disabled, and the installed item is judged too. Scope is decided by the org switch, not
 * here.
 */
export async function assertItemInstallable(
  t: KernelSchemaDb,
  orgId: string,
  itemId: string,
  approvedBy: string = itemId,
): Promise<void> {
  if (approvedBy !== itemId) assertUsable(await lockItem(t, itemId));
  const item = await lockItem(t, approvedBy);
  assertUsable(item);
  if (!(await offeredTo(t, orgId, item))) throw notOffered();
}

/**
 * The item is usable ({@link isUsable}): gone or disabled -> `catalog.item_disabled`; an org
 * upload still waiting for the super admin -> 409 `catalog.item_pending` (ruling P3-9).
 */
function assertUsable<
  T extends {
    name: string;
    disabled: boolean;
    deleted_at: Date | null;
    awaiting_confirmation: boolean;
  },
>(item: T | undefined): asserts item is T {
  if (item && isUsable(item)) return;
  if (item && item.deleted_at === null && !item.disabled) throw itemPendingError(item.name);
  throw itemDisabled();
}

const notOffered = () =>
  new ApiError(
    "catalog.approval_required",
    "This catalog item is not offered to this organization (plugin scope)",
  );

/** Scope rule: a `named` item is offered only to the orgs on its list (builtin implies `all`). */
async function offeredTo(
  t: KernelSchemaDb,
  orgId: string,
  item: { id: string; scope: "all" | "optional" | "named"; builtin: boolean },
): Promise<boolean> {
  const scope = item.builtin ? "all" : item.scope;
  if (scope !== "named") return true;
  const listed = await t
    .selectFrom("catalog_item_scope_orgs")
    .select("item_id")
    .where("item_id", "=", item.id)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  return visibleTo({ scope }, listed !== undefined);
}

/**
 * The extensions among `plugins` whose own catalog item (the non-deleted item with the same name) is
 * disabled (FOR SHARE: exclusive with the admin changing it). A disabled item is a master switch: no
 * path (direct enabling, its item, another plugin) can newly enable its extension (Ruling M-5).
 */
export async function disabledPluginItems(
  db: KernelSchemaDb,
  plugins: readonly string[],
): Promise<string[]> {
  if (plugins.length === 0) return [];
  const rows = await db
    .selectFrom("catalog_items")
    .select("name")
    .where("name", "in", [...plugins])
    .where("disabled", "=", true)
    .where("deleted_at", "is", null)
    .orderBy("name")
    .forShare()
    .execute();
  return [...new Set(rows.map((r) => r.name))];
}

/**
 * Throws `catalog.item_disabled` when a plugin's own catalog item is disabled (the message names
 * the plugin).
 */
export function pluginItemDisabled(names: readonly string[]): ApiError {
  return new ApiError(
    "catalog.item_disabled",
    `The super admin disabled the catalog item of extension ${names.join(", ")}; it cannot be newly enabled, not even through a plugin that bundles it`,
  );
}

/**
 * When an org enables an extension directly (not by installing from an item, e.g.
 * `PUT /orgs/:orgId/extensions/:extension`), every catalog item that brought it into the deployment
 * (`extension_catalog_sources`) is consulted: any source disabled -> `catalog.item_disabled`. Deleted
 * items no longer count as sources. No source (not installed through the catalog) -> not bound.
 */
export async function assertPluginSourcesInstallable(
  t: KernelSchemaDb,
  orgId: string,
  plugin: string,
): Promise<void> {
  const rows = await t
    .selectFrom("extension_catalog_sources as s")
    .innerJoin("catalog_items as i", "i.id", "s.item_id")
    .select(["i.id", "i.disabled", "i.scope", "i.builtin"])
    .where("s.plugin", "=", plugin)
    .where("i.deleted_at", "is", null)
    .orderBy("i.id")
    .forShare("i")
    .execute();
  if (rows.some((r) => r.disabled)) throw itemDisabled();
  for (const r of rows) if (!(await offeredTo(t, orgId, r))) throw notOffered();
}

/** The PAT recorded in the audit (when a personal access token made the call). */
export interface RequestActorOpts {
  actorTokenId?: string;
}

/**
 * Cancels catalog requests still pending in the caller's transaction (`db` is its handle; when the
 * item or the org is deleted), status `cancelled` (the decider is the actor). Each one audits
 * `catalog.request_cancelled` (with the reason). Returns how many were cancelled.
 */
export async function cancelPendingRequests(
  db: KernelSchemaDb,
  where: { itemId: string } | { orgId: string },
  actor: string | null,
  reason: "item_removed" | "org_deleted",
  opts: RequestActorOpts = {},
): Promise<number> {
  let q = db
    .updateTable("catalog_requests")
    .set({ status: "cancelled", decided_by: actor, decided_at: sql<Date>`now()` })
    .where("status", "=", "pending");
  q =
    "itemId" in where ? q.where("item_id", "=", where.itemId) : q.where("org_id", "=", where.orgId);
  const rows = await q.returning(["id", "org_id", "item_id", "kind"]).execute();
  for (const r of rows) {
    await audit(db, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      orgId: r.org_id,
      action: "catalog.request_cancelled",
      target: r.id,
      detail: { itemId: r.item_id, kind: r.kind, reason },
    });
  }
  return rows.length;
}

/**
 * After an install (or an upgrade) of the item in the org, in the caller's transaction: the org's
 * pending requests for the item (a member's `enable`, an `access` the scope has since granted) are
 * approved with the installer as the decider (null for the scope sync). Audits
 * `catalog.request_decided` with `installed: true`.
 */
export async function resolveRequestsByInstall(
  db: KernelSchemaDb,
  orgId: string,
  itemId: string,
  actor: string | null,
  opts: RequestActorOpts = {},
): Promise<void> {
  const rows = await db
    .updateTable("catalog_requests")
    .set({ status: "approved", decided_by: actor, decided_at: sql<Date>`now()` })
    .where("org_id", "=", orgId)
    .where("item_id", "=", itemId)
    .where("status", "=", "pending")
    .returning(["id", "kind"])
    .execute();
  for (const r of rows) {
    await audit(db, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      orgId,
      action: "catalog.request_decided",
      target: r.id,
      detail: { itemId, kind: r.kind, decision: "approve", installed: true },
    });
  }
}

/** The pending `import` request linked to a staged import (its approval prepared it), if any. */
export async function importRequestOf(
  db: KernelSchemaDb,
  stagingId: string,
): Promise<{ id: string; orgId: string } | undefined> {
  const r = await db
    .selectFrom("catalog_requests")
    .select(["id", "org_id"])
    .where("staging_id", "=", stagingId)
    .where("kind", "=", "import")
    .where("status", "=", "pending")
    .executeTakeFirst();
  return r && { id: r.id, orgId: r.org_id };
}

/** Whether pending `import` requests are linked to the staging (its confirm resolves them). */
export async function hasImportRequests(db: KernelSchemaDb, stagingId: string): Promise<boolean> {
  const r = await db
    .selectFrom("catalog_requests")
    .select("id")
    .where("staging_id", "=", stagingId)
    .where("kind", "=", "import")
    .where("status", "=", "pending")
    .executeTakeFirst();
  return r !== undefined;
}

/**
 * The confirm of a staged import, in its transaction: the pending `import` requests linked to the
 * staging are approved (decider: the confirming admin) and point at the item. Audits
 * `catalog.request_decided`. Returns the requests' orgs.
 */
export async function resolveImportRequests(
  db: KernelSchemaDb,
  stagingId: string,
  itemId: string,
  actor: string | null,
  opts: RequestActorOpts = {},
): Promise<string[]> {
  const rows = await db
    .updateTable("catalog_requests")
    .set({
      status: "approved",
      item_id: itemId,
      decided_by: actor,
      decided_at: sql<Date>`now()`,
    })
    .where("staging_id", "=", stagingId)
    .where("kind", "=", "import")
    .where("status", "=", "pending")
    .returning(["id", "org_id"])
    .execute();
  for (const r of rows) {
    await audit(db, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      orgId: r.org_id,
      action: "catalog.request_decided",
      target: r.id,
      detail: { itemId, kind: "import", decision: "approve", stagingId },
    });
  }
  return rows.map((r) => r.org_id);
}
