import { sql } from "kysely";
import type { KernelDb } from "../db/kernel-schema.js";

/**
 * Which extensions an organization has enabled. Two sources, and every reader goes through these
 * helpers so none of them misses one:
 * - `extension_org_configs.enabled` (the org's own switch);
 * - every required bootstrap plugin (`extension_installs.required`, package ecosystem spec §7):
 *   enabled in every org, existing and future, without an org config row, whatever such a row says.
 * Neither checks that the extension is loaded on this replica or enabled on the deployment; callers
 * that need that check it themselves, as before. `db` may be a transaction.
 */

/** The names of the extensions enabled in `orgId` (a subquery with one column, `plugin`). */
export function enabledExtensionsQuery(db: KernelDb, orgId: string) {
  return db
    .selectFrom("extension_org_configs as eoc")
    .select("eoc.plugin as plugin")
    .where("eoc.org_id", "=", orgId)
    .where("eoc.enabled", "=", true)
    .union(
      db
        .selectFrom("extension_installs as ri")
        .select("ri.name as plugin")
        .where("ri.required", "=", true),
    );
}

/**
 * Every (org, extension) pair that is enabled, for queries that join it (columns `org_id`,
 * `plugin`): `.innerJoin(enabledExtensionsByOrg(db).as("en"), (j) => j.onRef("en.org_id", …)…)`.
 * Soft-deleted orgs are included, as their org config rows are; callers filter `orgs.deleted_at`.
 */
export function enabledExtensionsByOrg(db: KernelDb) {
  return db
    .selectFrom("extension_org_configs as eoc")
    .select(["eoc.org_id as org_id", "eoc.plugin as plugin"])
    .where("eoc.enabled", "=", true)
    .union(
      db
        .selectFrom("orgs as ro")
        .innerJoin("extension_installs as ri", (j) => j.on("ri.required", "=", true))
        .select(["ro.id as org_id", "ri.name as plugin"]),
    );
}

/** Whether `plugin` is enabled in `orgId` (see the file header). */
export async function isExtensionEnabled(
  db: KernelDb,
  orgId: string,
  plugin: string,
): Promise<boolean> {
  const row = await db
    .selectFrom(enabledExtensionsQuery(db, orgId).as("en"))
    .select(sql<number>`1`.as("one"))
    .where("en.plugin", "=", plugin)
    .executeTakeFirst();
  return row !== undefined;
}

/** The names of the required bootstrap plugins (installed with `required`). */
export async function requiredExtensions(db: KernelDb): Promise<Set<string>> {
  const rows = await db
    .selectFrom("extension_installs")
    .select("name")
    .where("required", "=", true)
    .execute();
  return new Set(rows.map((r) => r.name));
}
