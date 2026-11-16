import { type PluginScope, visibleTo } from "../catalog/scope.js";
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

/**
 * Whether an org may see an extension with these live catalog items (`listed`: the items whose
 * `named` list has the org): one visible item is enough; without an item (config-declared, or its
 * items deleted) it is visible. A builtin item counts as `all`.
 */
export function itemsVisible(
  items: readonly ExtensionPluginItem[] | undefined,
  listed: ReadonlySet<string>,
): boolean {
  if (!items) return true;
  return items.some((i) => visibleTo({ scope: i.builtin ? "all" : i.scope }, listed.has(i.id)));
}

/**
 * Whether the org's extension list shows an extension (`OrgExtensionConfigs.list`, which the org
 * readiness reads for the model providers an org admin can fix): a required bootstrap plugin
 * always; else under its catalog items' scope, and, while it is off in the org, only when none of
 * its items is disabled (nothing can newly enable it then, Ruling M-5; one already on stays).
 */
export const offeredToOrg = (e: {
  required: boolean;
  enabled: boolean;
  items: readonly ExtensionPluginItem[] | undefined;
  listed: ReadonlySet<string>;
}): boolean =>
  e.required ||
  (itemsVisible(e.items, e.listed) && (e.enabled || !(e.items ?? []).some((i) => i.disabled)));

/** The ids of the catalog items whose `named` list has `orgId`. `db` may be a transaction. */
export async function scopeListedFor(db: KernelSchemaDb, orgId: string): Promise<Set<string>> {
  const rows = await db
    .selectFrom("catalog_item_scope_orgs")
    .select("item_id")
    .where("org_id", "=", orgId)
    .execute();
  return new Set(rows.map((r) => r.item_id));
}
