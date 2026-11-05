import type { PluginScope } from "../catalog/scope.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";

/** The catalog item (the plugin) an extension ships in. */
export interface ExtensionPluginItem {
  id: string;
  scope: PluginScope;
  builtin: boolean;
  disabled: boolean;
}

/**
 * The live catalog item of each extension in `names`: the item recorded on its install
 * (`extension_installs.catalog_item_id`), else the first of its `extension_catalog_sources`. An
 * extension without a live item (declared in the startup config, or its item deleted) is absent.
 * `db` may be a transaction.
 */
export async function pluginItemsOf(
  db: KernelSchemaDb,
  names: readonly string[],
): Promise<Map<string, ExtensionPluginItem>> {
  const out = new Map<string, ExtensionPluginItem>();
  if (names.length === 0) return out;
  const own = await db
    .selectFrom("extension_installs as e")
    .innerJoin("catalog_items as i", "i.id", "e.catalog_item_id")
    .select(["e.name as plugin", "i.id", "i.scope", "i.builtin", "i.disabled"])
    .where("e.name", "in", [...names])
    .where("i.deleted_at", "is", null)
    .execute();
  for (const r of own) out.set(r.plugin, r);
  const sources = await db
    .selectFrom("extension_catalog_sources as s")
    .innerJoin("catalog_items as i", "i.id", "s.item_id")
    .select(["s.plugin", "i.id", "i.scope", "i.builtin", "i.disabled"])
    .where("s.plugin", "in", [...names])
    .where("i.deleted_at", "is", null)
    .orderBy("i.id")
    .execute();
  for (const r of sources) if (!out.has(r.plugin)) out.set(r.plugin, r);
  return out;
}
