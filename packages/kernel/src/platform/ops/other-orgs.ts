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
