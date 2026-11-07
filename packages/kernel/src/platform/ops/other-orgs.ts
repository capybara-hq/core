import { ToolError } from "@capybara-hq/plugin-sdk";
import type { KernelSchemaDb } from "../../db/kernel-schema.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OTHER_ORG = "This plugin belongs to another org; use the admin console.";

/**
 * Refuses a super-admin operation on a catalog item another org owns (spec §6.1, §14.5 item 1):
 * its results would describe that org's private plugin in this org's log. Platform items and the
 * conversation org's own pass; an id that is no uuid passes too (the service answers not found).
 */
export async function assertNotOtherOrgs(
  db: KernelSchemaDb,
  itemId: string,
  orgId: string,
): Promise<void> {
  if (!UUID_RE.test(itemId)) return;
  const row = await db
    .selectFrom("catalog_items")
    .select("owner_org_id")
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (row?.owner_org_id != null && row.owner_org_id !== orgId) throw new ToolError(OTHER_ORG);
}

/** How many live catalog items other orgs own (left out of the platform lists). */
export async function otherOrgItems(db: KernelSchemaDb, orgId: string): Promise<number> {
  const r = await db
    .selectFrom("catalog_items")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("deleted_at", "is", null)
    .where("owner_org_id", "is not", null)
    .where("owner_org_id", "!=", orgId)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

/**
 * The extensions (by name) that only other orgs' own plugins bring: an org upload's extension the
 * super admin confirmed is installed on the deployment, but it is that org's private plugin
 * (spec §14.5 item 1): counted, never described or changed through this org's agent. An extension
 * that a platform plugin or the conversation org's own plugin also brings is not one of them.
 */
export async function otherOrgExtensions(
  db: KernelSchemaDb,
  orgId: string,
  names?: readonly string[],
): Promise<Set<string>> {
  if (names !== undefined && names.length === 0) return new Set();
  let sources = db
    .selectFrom("extension_catalog_sources as s")
    .innerJoin("catalog_items as i", "i.id", "s.item_id")
    .select(["s.plugin as plugin", "i.owner_org_id as owner"]);
  let installs = db
    .selectFrom("extension_installs as e")
    .innerJoin("catalog_items as i", "i.id", "e.catalog_item_id")
    .select(["e.name as plugin", "i.owner_org_id as owner"]);
  if (names !== undefined) {
    sources = sources.where("s.plugin", "in", names);
    installs = installs.where("e.name", "in", names);
  }
  const rows = await sources.unionAll(installs).execute();
  const theirs = new Set<string>();
  const ours = new Set<string>();
  for (const r of rows) {
    if (r.owner === null || r.owner === orgId) ours.add(r.plugin);
    else theirs.add(r.plugin);
  }
  for (const n of ours) theirs.delete(n);
  return theirs;
}

/** Refuses an extension only other orgs' own plugins bring ({@link otherOrgExtensions}). */
export async function assertExtensionNotOtherOrgs(
  db: KernelSchemaDb,
  name: string,
  orgId: string,
): Promise<void> {
  if ((await otherOrgExtensions(db, orgId, [name])).has(name)) throw new ToolError(OTHER_ORG);
}
