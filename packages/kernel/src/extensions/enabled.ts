import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";

/**
 * Which extensions an organization has enabled. Two sources, and every reader goes through these
 * helpers so none of them misses one:
 * - `extension_org_configs.enabled` (the org's own switch);
 * - every always-on extension ({@link alwaysOnExtensionsQuery}): enabled in every org, existing and
 *   future, without an org config row, whatever such a row says. That is a required bootstrap
 *   plugin (`extension_installs.required`, package ecosystem spec §7) and an extension shipped in a
 *   builtin platform plugin (a live `catalog_items` row with `builtin`, recorded on its install or in
 *   `extension_catalog_sources`; a `builtin: true` bootstrap entry is builtin without being
 *   required). A builtin plugin is on in every org and its org switch is locked (`wantedOn`,
 *   `itemLocked`), so its extension must be on too: the scope sync leaves builtin items alone.
 * Neither checks that the extension is loaded on this replica or enabled on the deployment; callers
 * that need that check it themselves, as before. Plain SQL read on every call (no cache), so every
 * replica sees a change at once. `db` may be a transaction.
 */

/**
 * The names of the always-on extensions (a subquery with one column, `plugin`): required bootstrap
 * plugins and the extensions of live builtin platform plugins (see the file header).
 */
export function alwaysOnExtensionsQuery(db: KernelSchemaDb) {
  return db
    .selectFrom("extension_installs as ri")
    .select("ri.name as plugin")
    .where("ri.required", "=", true)
    .union(
      db
        .selectFrom("extension_installs as ei")
        .innerJoin("catalog_items as ci", "ci.id", "ei.catalog_item_id")
        .select("ei.name as plugin")
        .where("ci.builtin", "=", true)
        .where("ci.disabled", "=", false)
        .where("ci.deleted_at", "is", null)
        .where("ci.owner_org_id", "is", null),
    )
    .union(
      db
        .selectFrom("extension_catalog_sources as cs")
        .innerJoin("catalog_items as si", "si.id", "cs.item_id")
        .select("cs.plugin as plugin")
        .where("si.builtin", "=", true)
        .where("si.disabled", "=", false)
        .where("si.deleted_at", "is", null)
        .where("si.owner_org_id", "is", null),
    );
}

/** The names of the extensions enabled in `orgId` (a subquery with one column, `plugin`). */
export function enabledExtensionsQuery(db: KernelSchemaDb, orgId: string) {
  return db
    .selectFrom("extension_org_configs as eoc")
    .select("eoc.plugin as plugin")
    .where("eoc.org_id", "=", orgId)
    .where("eoc.enabled", "=", true)
    .union(db.selectFrom(alwaysOnExtensionsQuery(db).as("ao")).select("ao.plugin as plugin"));
}

/**
 * Every (org, extension) pair that is enabled, for queries that join it (columns `org_id`,
 * `plugin`): `.innerJoin(enabledExtensionsByOrg(db).as("en"), (j) => j.onRef("en.org_id", …)…)`.
 * Soft-deleted orgs are included, as their org config rows are; callers filter `orgs.deleted_at`.
 */
export function enabledExtensionsByOrg(db: KernelSchemaDb) {
  return db
    .selectFrom("extension_org_configs as eoc")
    .select(["eoc.org_id as org_id", "eoc.plugin as plugin"])
    .where("eoc.enabled", "=", true)
    .union(
      db
        .selectFrom("orgs as ro")
        .innerJoin(alwaysOnExtensionsQuery(db).as("ao"), (j) => j.onTrue())
        .select(["ro.id as org_id", "ao.plugin as plugin"]),
    );
}

/** Whether `plugin` is enabled in `orgId` (see the file header). */
export async function isExtensionEnabled(
  db: KernelSchemaDb,
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

/**
 * The names of the required bootstrap plugins (installed with `required`): the ones that refuse
 * `extension.required`. Whether an extension is on in every org is {@link alwaysOnExtensions}.
 */
export async function requiredExtensions(db: KernelSchemaDb): Promise<Set<string>> {
  const rows = await db
    .selectFrom("extension_installs")
    .select("name")
    .where("required", "=", true)
    .execute();
  return new Set(rows.map((r) => r.name));
}

/** The names of the always-on extensions ({@link alwaysOnExtensionsQuery}). */
export async function alwaysOnExtensions(db: KernelSchemaDb): Promise<Set<string>> {
  const rows = await alwaysOnExtensionsQuery(db).execute();
  return new Set(rows.map((r) => r.plugin));
}
