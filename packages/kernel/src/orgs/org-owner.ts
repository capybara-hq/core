import type { KernelSchemaDb } from "../db/kernel-schema.js";

/**
 * The org's first owner (earliest membership): the account a kernel-side call acts as where an
 * account id is required but no person acted, such as a connector the kernel created (its
 * `created_by` is null, ruling R17) when its org credential lists tools. Undefined: no owner.
 */
export async function firstOrgOwner(
  db: KernelSchemaDb,
  orgId: string,
): Promise<string | undefined> {
  const row = await db
    .selectFrom("memberships")
    .select("account_id")
    .where("org_id", "=", orgId)
    .where("role", "=", "owner")
    .orderBy("created_at")
    .orderBy("account_id")
    .executeTakeFirst();
  return row?.account_id;
}
