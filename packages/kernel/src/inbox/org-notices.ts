// Org notices (`org_notices`, plugin scope phase 3, spec §14, ruling P3-22): what an org's admins
// are told about shared items and uploads, until one of them dismisses it. The writers run in the
// caller's transaction, so a notice exists exactly when its change does.
import { randomUUID } from "node:crypto";
import { type OwnedRef, type Owner, orgsUsing, ownerOf, ownersOf } from "../catalog/ownership.js";
import type { KernelSchemaDb, OrgNoticeKind } from "../db/kernel-schema.js";

export type { OrgNoticeKind };

/** The `detail` of each notice kind. */
export interface OrgNoticeDetails {
  /** An org was added to the item's list, or its scope widened (`all_orgs`). */
  /** `displayName`: a plugin's display name, which the inbox names it by (null otherwise). */
  item_shared: {
    ref: OwnedRef;
    name: string;
    displayName: LocalizedName;
    org: { id: string; name: string } | "all_orgs";
  };
  /** A shared org-owned item changed version, for the orgs it is on in. */
  shared_item_updated: {
    ref: OwnedRef;
    name: string;
    displayName: LocalizedName;
    from: string;
    to: string;
    owner: Owner;
  };
  /** `displayName`: the plugin's display name, which the inbox names it by (null without one). */
  upload_confirmed: { itemId: string; name: string; displayName: LocalizedName; version: string };
  upload_rejected: {
    itemId: string;
    name: string;
    displayName: LocalizedName;
    version: string;
    reason: string | null;
  };
}

type LocalizedName = { zh: string; en: string } | null;

/** An owned ref's display name: a plugin's (skills and agent templates have none). */
const refDisplayName = (db: KernelSchemaDb, ref: OwnedRef): Promise<LocalizedName> =>
  ref.kind === "plugin" ? itemDisplayName(db, ref.id) : Promise.resolve(null);

/** A catalog item's display name for an upload notice (null without one, or for an unknown id). */
export async function itemDisplayName(db: KernelSchemaDb, itemId: string): Promise<LocalizedName> {
  const row = await db
    .selectFrom("catalog_items")
    .select("display_name")
    .where("id", "=", itemId)
    .executeTakeFirst();
  return row?.display_name ?? null;
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
  const displayName = await refDisplayName(db, ref);
  if (orgs === "all_orgs") {
    await addOrgNotice(db, ownerOrgId, "item_shared", {
      ref,
      name,
      displayName,
      org: "all_orgs",
    });
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
      displayName,
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
  const displayName = await refDisplayName(db, ref);
  for (const o of using) {
    await addOrgNotice(db, o.id, "shared_item_updated", {
      ref,
      name: change.name,
      displayName,
      from: change.from,
      to: change.to,
      owner,
    });
  }
  return using.length;
}
