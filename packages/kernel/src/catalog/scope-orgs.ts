import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";
import { assertShareable, shareGate } from "./ownership.js";

/**
 * Adds one org to a `named` item's list in the caller's transaction (the caller holds the item row
 * `FOR UPDATE`): bumps `scope_version` and audits `catalog.scope_changed` the way a scope change
 * does (`from` / `to` with the sorted lists; `requestId` when a request asked for it). Nothing is
 * written when the item is not `named` (or builtin) or the org is listed already. Returns whether
 * the list changed; the caller enqueues the item's scope sync after the commit. Adding an org other
 * than its owner to an org-owned item that is not shareable -> 409 `catalog.not_shareable` (the
 * share gate, ruling P3-16, read on the caller's locked row).
 */
export async function addScopeOrg(
  db: KernelSchemaDb,
  actor: string | null,
  item: {
    id: string;
    name: string;
    scope: "all" | "optional" | "named";
    builtin: boolean;
    owner_org_id: string | null;
    shareable: boolean;
  },
  orgId: string,
  opts: { actorTokenId?: string; requestId?: string } = {},
): Promise<boolean> {
  if (item.builtin || item.scope !== "named") return false;
  if (!shareGate(item) && orgId !== item.owner_org_id) {
    const listed = await db
      .selectFrom("catalog_item_scope_orgs")
      .select("org_id")
      .where("item_id", "=", item.id)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (listed !== undefined) return false;
    assertShareable(item);
  }
  const added = await db
    .insertInto("catalog_item_scope_orgs")
    .values({ item_id: item.id, org_id: orgId })
    .onConflict((oc) => oc.doNothing())
    .returning("org_id")
    .executeTakeFirst();
  if (added === undefined) return false;
  await db
    .updateTable("catalog_items")
    .set({
      scope_version: sql<number>`scope_version + 1`,
      updated_at: sql<Date>`now()` as unknown as Date,
    })
    .where("id", "=", item.id)
    .execute();
  const rows = await db
    .selectFrom("catalog_item_scope_orgs")
    .select("org_id")
    .where("item_id", "=", item.id)
    .orderBy("org_id")
    .execute();
  const to = rows.map((r) => r.org_id);
  await audit(db, {
    ...(actor !== null && { actorAccountId: actor }),
    ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
    action: "catalog.scope_changed",
    target: item.id,
    detail: {
      name: item.name,
      from: { scope: "named", orgs: to.filter((o) => o !== orgId) },
      to: { scope: "named", orgs: to },
      ...(opts.requestId !== undefined && { requestId: opts.requestId }),
    },
  });
  return true;
}
