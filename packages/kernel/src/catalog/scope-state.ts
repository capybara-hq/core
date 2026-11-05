import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { wantedOn } from "./scope.js";

/**
 * Whether the item's own scope wants it on in the org (`wantedOn` over the item's scope, builtin
 * and disabled flags, the org's list membership and its switch), read through `db` (the caller's
 * transaction under the org row lock, or the pool). A deleted or missing item is not wanted.
 */
export async function wantedByScope(
  db: KernelSchemaDb,
  orgId: string,
  itemId: string,
): Promise<boolean> {
  const item = await db
    .selectFrom("catalog_items")
    .select(["scope", "builtin", "disabled"])
    .where("id", "=", itemId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!item) return false;
  // one after the other: `db` may be a transaction's single connection
  const listed = await db
    .selectFrom("catalog_item_scope_orgs")
    .select("item_id")
    .where("item_id", "=", itemId)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  const sw = await db
    .selectFrom("catalog_item_org_switches")
    .select("enabled")
    .where("item_id", "=", itemId)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  return wantedOn(item, listed !== undefined, sw?.enabled ?? null);
}

/**
 * A scope sync install (`via: "scope"`) found, under the org row lock, that the item is no longer
 * wanted in the org (a person switched it off, or the scope changed, after the sync's decision):
 * nothing was written; the sync treats it as converged.
 */
export class ScopeNoLongerWanted extends Error {
  constructor(
    readonly orgId: string,
    readonly itemId: string,
  ) {
    super(`Plugin ${itemId} is no longer wanted in org ${orgId} by its scope`);
    this.name = "ScopeNoLongerWanted";
  }
}
