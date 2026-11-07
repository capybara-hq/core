import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { requestable, visibleTo, wantedOn } from "./scope.js";

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

/**
 * A scope sync uninstall (`via: "scope"`) found, under the org row lock, that the item is wanted
 * in the org again (a person switched it on, or the scope changed, after the sync's decision), or
 * that another live install of the org depends on it: nothing was written; the sync treats it as
 * converged.
 */
export class ScopeStillWanted extends Error {
  constructor(
    readonly orgId: string,
    readonly itemId: string,
  ) {
    super(`Plugin ${itemId} is still wanted in org ${orgId}`);
    this.name = "ScopeStillWanted";
  }
}

/**
 * The items among `itemIds` (live ones) the org can see in its catalog: offered to it (`all`,
 * `optional`, builtin, or `named` with the org listed) or requestable (`named`, shown to other
 * orgs, through the share gate). A hidden `named` item outside its list is left out, so nothing
 * reveals it to the org.
 */
export async function itemsSeenBy(
  db: KernelSchemaDb,
  orgId: string,
  itemIds: readonly string[],
): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set();
  const items = await db
    .selectFrom("catalog_items")
    .select(["id", "scope", "builtin", "shown_to_others", "owner_org_id", "shareable"])
    .where("id", "in", [...itemIds])
    .where("deleted_at", "is", null)
    .execute();
  const listed = new Set(
    (
      await db
        .selectFrom("catalog_item_scope_orgs")
        .select("item_id")
        .where("org_id", "=", orgId)
        .where("item_id", "in", [...itemIds])
        .execute()
    ).map((r) => r.item_id),
  );
  return new Set(
    items
      .filter(
        (i) =>
          visibleTo({ scope: i.builtin ? "all" : i.scope }, listed.has(i.id)) ||
          requestable(i, listed.has(i.id)),
      )
      .map((i) => i.id),
  );
}
