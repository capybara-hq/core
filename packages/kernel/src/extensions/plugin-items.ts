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
 * The live catalog items of each extension in `names`, the one recorded on its install
 * (`extension_installs.catalog_item_id`) first, then its other `extension_catalog_sources` by id.
 * An extension without a live item (declared in the startup config, or its items deleted) is absent.
 * `db` may be a transaction.
 */
export async function pluginItemsOf(
  db: KernelSchemaDb,
  names: readonly string[],
): Promise<Map<string, ExtensionPluginItem[]>> {
  const out = new Map<string, ExtensionPluginItem[]>();
  if (names.length === 0) return out;
  const add = (plugin: string, item: ExtensionPluginItem) => {
    const list = out.get(plugin) ?? [];
    if (!list.some((i) => i.id === item.id)) list.push(item);
    out.set(plugin, list);
  };
  const own = await db
    .selectFrom("extension_installs as e")
    .innerJoin("catalog_items as i", "i.id", "e.catalog_item_id")
    .select(["e.name as plugin", "i.id", "i.scope", "i.builtin", "i.disabled"])
    .where("e.name", "in", [...names])
    .where("i.deleted_at", "is", null)
    .execute();
  for (const r of own) add(r.plugin, r);
  const sources = await db
    .selectFrom("extension_catalog_sources as s")
    .innerJoin("catalog_items as i", "i.id", "s.item_id")
    .select(["s.plugin", "i.id", "i.scope", "i.builtin", "i.disabled"])
    .where("s.plugin", "in", [...names])
    .where("i.deleted_at", "is", null)
    .orderBy("i.id")
    .execute();
  for (const r of sources) add(r.plugin, r);
  return out;
}

/**
 * Whether an item keeps its plugin on in every org (builtin only: an org may switch off an `all`
 * one, layering spec §4): its switch cannot go off.
 */
export const itemLocked = (i: ExtensionPluginItem): boolean => i.builtin;
