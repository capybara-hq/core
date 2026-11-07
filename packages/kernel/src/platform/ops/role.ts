import type { KernelSchemaDb } from "../../db/kernel-schema.js";
import type { OrgRole } from "../../orgs/roles.js";

/** The account's role in the org, read now; null when it is not a member. */
export async function roleOf(
  db: KernelSchemaDb,
  orgId: string,
  accountId: string,
): Promise<OrgRole | null> {
  const m = await db
    .selectFrom("memberships")
    .select("role")
    .where("org_id", "=", orgId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return m?.role ?? null;
}
