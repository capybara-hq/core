import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";

// The connectors a plugin's connector templates made, switched off and on with the plugin (spec §5
// rule 8): an org's uninstall or switch-off (`ConnectorsService.disableWithPluginIn`), the super
// admin's delete of the plugin ({@link switchOffItemConnectors}) and an import of the same plugin
// again ({@link relinkDeletedItemConnectors}) share one meaning of the marker
// `connectors.disabled_by_plugin_id`.

/**
 * The update that switches a connector off with plugin `itemId`: status `disabled`, and the marker
 * set only on a connector that was active, so switching the plugin back on re-enables exactly what
 * this switched off; one an org admin disabled by hand keeps no marker and stays off. Endpoint and
 * credentials stay.
 */
export function pluginSwitchOff(itemId: string) {
  return {
    status: "disabled" as const,
    disabled_by_plugin_id: sql<
      string | null
    >`case when status = 'active' then ${itemId}::uuid else disabled_by_plugin_id end`,
    updated_at: sql<Date>`now()`,
  };
}

/**
 * Switches off, in the caller's transaction, every live connector in any org made from one of the
 * item's connector templates ({@link pluginSwitchOff}): the super admin's delete of the item
 * (`CatalogService.removeIn`). The caller holds the orgs' row locks where it can (the global lock
 * order puts them before the item). Returns how many connectors it touched.
 */
export async function switchOffItemConnectors(db: KernelSchemaDb, itemId: string): Promise<number> {
  // org-filter: the delete of a catalog item switches off its template connectors in every org
  // by design (spec §5 rule 8), keyed by the item's own template ids
  const rows = await db
    .updateTable("connectors")
    .set(pluginSwitchOff(itemId))
    .where("deleted_at", "is", null)
    .where("platform_template_id", "in", (q) =>
      q
        .selectFrom("platform_connector_templates")
        .select("id")
        .where("catalog_item_id", "=", itemId),
    )
    .returning("id")
    .execute();
  return rows.length;
}

/**
 * When a plugin is imported again after its delete (a new catalog item of the same name and
 * owner), the live connectors that the deleted items' connector template `templateId` made move to
 * the new item's template `newTemplateId`: their template, item and version links point at the new
 * item, and a marker of a deleted item's switch-off becomes the new item's, so the new item's
 * install takes them back and re-enables them exactly as switching the plugin back on does (one an
 * org admin disabled by hand stays off). In the caller's transaction, under the item lock.
 */
export async function relinkDeletedItemConnectors(
  db: KernelSchemaDb,
  to: {
    itemId: string;
    name: string;
    ownerOrgId: string | null;
    version: string;
    templateId: string;
    newTemplateId: string;
  },
): Promise<number> {
  // The deleted items of this plugin (its name, the same owner) and their template `templateId`
  const old = await db
    .selectFrom("platform_connector_templates as t")
    .innerJoin("catalog_items as i", "i.id", "t.catalog_item_id")
    .select(["t.id", "i.id as item_id"])
    .where("t.template_id", "=", to.templateId)
    .where("i.name", "=", to.name)
    .where("i.deleted_at", "is not", null)
    .$call((q) =>
      to.ownerOrgId === null
        ? q.where("i.owner_org_id", "is", null)
        : q.where("i.owner_org_id", "=", to.ownerOrgId),
    )
    .execute();
  if (old.length === 0) return 0;
  const oldItems = [...new Set(old.map((r) => r.item_id))];
  // org-filter: an import relinks the deleted plugin's template connectors in every org by
  // design, keyed by the deleted items' own template ids
  const rows = await db
    .updateTable("connectors")
    .set({
      platform_template_id: to.newTemplateId,
      catalog_item_id: to.itemId,
      catalog_version: to.version,
      disabled_by_plugin_id: sql<string | null>`case when disabled_by_plugin_id in (${sql.join(
        oldItems.map((id) => sql`${id}::uuid`),
      )}) then ${to.itemId}::uuid else disabled_by_plugin_id end`,
      updated_at: sql<Date>`now()`,
    })
    .where("deleted_at", "is", null)
    .where(
      "platform_template_id",
      "in",
      old.map((r) => r.id),
    )
    .returning("id")
    .execute();
  return rows.length;
}
