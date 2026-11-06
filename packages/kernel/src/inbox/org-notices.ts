// Org notices (`org_notices`, plugin scope phase 3, spec §14, ruling P3-22): what an org's admins
// are told about shared items and uploads, until one of them dismisses it. The writers run in the
// caller's transaction, so a notice exists exactly when its change does.
import { randomUUID } from "node:crypto";
import { type OwnedRef, type Owner, orgsUsing, ownerOf, ownersOf } from "../catalog/ownership.js";
import type { KernelSchemaDb, OrgNoticeKind } from "../db/kernel-schema.js";

export type { OrgNoticeKind };

/** The `detail` of each notice kind except `skill_renamed` (written by the platform migration). */
export interface OrgNoticeDetails {
  /** An org was added to the item's list, or its scope widened (`all_orgs`). */
  item_shared: { ref: OwnedRef; name: string; org: { id: string; name: string } | "all_orgs" };
  /** A shared org-owned item changed version, for the orgs it is on in. */
  shared_item_updated: { ref: OwnedRef; name: string; from: string; to: string; owner: Owner };
  upload_confirmed: { itemId: string; name: string; version: string };
  upload_rejected: { itemId: string; name: string; version: string; reason: string | null };
}

/** Writes an org notice in the caller's transaction. */
export async function addOrgNotice<K extends keyof OrgNoticeDetails>(
  db: KernelSchemaDb,
  orgId: string,
  kind: K,
  detail: OrgNoticeDetails[K],
): Promise<void> {
  await db
    .insertInto("org_notices")
    .values({ id: randomUUID(), org_id: orgId, kind, detail: JSON.stringify(detail) })
    .execute();
}

const OWNER_TABLE = {
  plugin: "catalog_items",
  skill: "platform_skills",
  agent_template: "platform_agent_templates",
} as const;

/**
 * Tells the owner org that its item was shared (`item_shared`): with each org of `orgs` (the owner
 * itself is skipped), or with `all_orgs`. A platform-owned item writes nothing.
 */
export async function notifyItemShared(
  db: KernelSchemaDb,
  ownerOrgId: string | null,
  ref: OwnedRef,
  name: string,
  orgs: readonly string[] | "all_orgs",
): Promise<void> {
  if (ownerOrgId === null) return;
  if (orgs === "all_orgs") {
    await addOrgNotice(db, ownerOrgId, "item_shared", { ref, name, org: "all_orgs" });
    return;
  }
  const targets = [...new Set(orgs)].filter((o) => o !== ownerOrgId);
  if (targets.length === 0) return;
  const rows = await db
    .selectFrom("orgs")
    .select(["id", "name"])
    .where("id", "in", targets)
    .execute();
  const names = new Map(rows.map((r) => [r.id, r.name]));
  for (const id of targets) {
    await addOrgNotice(db, ownerOrgId, "item_shared", {
      ref,
      name,
      org: { id, name: names.get(id) ?? id },
    });
  }
}

/**
 * Tells every live org the org-owned item is on in, except its owner (P3-18, {@link orgsUsing}),
 * that it changed version (`shared_item_updated`); returns how many orgs were told. A platform-owned
 * or missing item tells nobody.
 */
export async function notifySharedUpdate(
  db: KernelSchemaDb,
  ref: OwnedRef,
  change: { name: string; from: string; to: string },
): Promise<number> {
  const row = await db
    .selectFrom(OWNER_TABLE[ref.kind] as "catalog_items")
    .select("owner_org_id")
    .where("id", "=", ref.id)
    .executeTakeFirst();
  if (!row || row.owner_org_id === null) return 0;
  const owner = ownerOf(row.owner_org_id, await ownersOf(db, [row.owner_org_id]));
  const using = await orgsUsing(db, ref, { except: row.owner_org_id });
  for (const o of using) {
    await addOrgNotice(db, o.id, "shared_item_updated", {
      ref,
      name: change.name,
      from: change.from,
      to: change.to,
      owner,
    });
  }
  return using.length;
}
