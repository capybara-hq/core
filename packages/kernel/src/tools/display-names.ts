import type { LocalizedName } from "@capybara-hq/plugin-sdk";
import type { KernelSchemaDb } from "../db/kernel-schema.js";

/**
 * The display names of plugins, for naming their extensions' tools (`<display name> [<tool>]`,
 * tool naming spec §7): the live catalog item's `displayName`, else the plugin name in both
 * languages (a bootstrap or uploaded plugin without a catalog item, or one without a display name).
 * Display only.
 */
export async function pluginDisplayNames(
  db: KernelSchemaDb,
  names: readonly string[],
): Promise<Map<string, LocalizedName>> {
  const unique = [...new Set(names)];
  const out = new Map<string, LocalizedName>(unique.map((n) => [n, { zh: n, en: n }]));
  if (unique.length === 0) return out;
  const rows = await db
    .selectFrom("catalog_items")
    .select(["name", "display_name"])
    .where("name", "in", unique)
    .where("deleted_at", "is", null)
    .execute();
  for (const r of rows) {
    const d = r.display_name;
    if (d && typeof d.zh === "string" && typeof d.en === "string" && d.zh !== "" && d.en !== "")
      out.set(r.name, { zh: d.zh, en: d.en });
  }
  return out;
}
