import { readFile } from "node:fs/promises";
import { parseBootstrapManifest } from "@capybara-hq/plugin-sdk";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { BOOTSTRAP_MANIFEST_FILE } from "../extensions/bootstrap-manifest.js";

/** The plugin names of the bootstrap manifest shipped with the kernel (an unreadable or invalid one: none). */
async function bootstrapNames(): Promise<string[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(BOOTSTRAP_MANIFEST_FILE, "utf8"));
  } catch {
    return [];
  }
  const parsed = parseBootstrapManifest(raw);
  return "errors" in parsed ? [] : parsed.plugins.map((p) => p.name);
}

/**
 * 409 `plugin.name_reserved` when an org upload names a plugin (and so its extension: one name
 * space) of the bundled bootstrap manifest or of an entry of any marketplace the deployment has
 * read, official or custom (ruling P3-28): an org cannot take a name a later bootstrap pin or a
 * platform import of a public plugin needs, since the name would then belong to the org (P3-14).
 */
export async function assertNameNotReserved(db: KernelSchemaDb, name: string): Promise<void> {
  const where = (await bootstrapNames()).includes(name)
    ? "a bootstrap plugin of this deployment"
    : (await db
          .selectFrom("marketplace_entries")
          .select("name")
          .where("name", "=", name)
          .executeTakeFirst()) !== undefined
      ? "a plugin listed by a marketplace of this deployment"
      : undefined;
  if (where === undefined) return;
  throw new ApiError(
    "plugin.name_reserved",
    `Plugin name ${name} is reserved for ${where}; rename the plugin (plugin.json name) and upload it again`,
  );
}
