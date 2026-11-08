// Catalog display files in PG (`catalog_files`, migration 0098): a plugin's icon, its connector
// templates' icons and its setup guide files. They are small (64 KiB each at most, by the plugin
// format) and must be readable without object storage: a bootstrap plugin is imported before any
// object-store extension runs, and the object-store plugin's own icon can never wait for itself.
// Skills, connector templates and agent templates stay in object storage under the version's
// `object_prefix` (they are copied into platform components there).
import { createHash } from "node:crypto";
import type { PluginManifest } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { packagePath } from "../packages/tgz.js";

type Db = Pick<KernelSchemaDb, "selectFrom" | "insertInto" | "deleteFrom">;

/** A stored file as a version row lists it. */
interface FileMeta {
  path: string;
  size: number;
  sha256: string;
}

/**
 * The display file paths of a plugin (package paths): the plugin icon, the connector templates'
 * icons (given by the caller, which parsed the templates) and the setup guide files.
 */
export function displayFilePaths(m: PluginManifest, templateIcons: string[] = []): Set<string> {
  const out = new Set<string>();
  if (m.icon !== undefined) out.add(packagePath(m.icon));
  for (const icon of templateIcons) out.add(packagePath(icon));
  for (const g of m.setupGuides ?? []) for (const f of g.files ?? []) out.add(packagePath(f.path));
  return out;
}

/**
 * Stores display files (one row per sha256; a file already there gets its `touched_at` renewed, so
 * the sweep never removes the bytes of an import in progress). Runs in the caller's transaction
 * when there is one: the staging row that lists the files commits with them.
 */
export async function putDisplayFiles(
  db: Db,
  files: { sha256: string; data: Uint8Array }[],
): Promise<void> {
  const unique = new Map(files.map((f) => [f.sha256, f.data]));
  // sorted: two imports storing overlapping sets lock the rows in the same order
  for (const sha256 of [...unique.keys()].sort()) {
    const data = unique.get(sha256) as Uint8Array;
    await db
      .insertInto("catalog_files")
      .values({ sha256, data: Buffer.from(data) })
      .onConflict((oc) => oc.column("sha256").doUpdateSet({ touched_at: sql`now()` }))
      .execute();
  }
}

/**
 * The display files of `files` found in PG, by path, each checked against its recorded sha256 (a
 * mismatch is tampering: `internal`). Files not in PG are absent from the result.
 */
export async function readDisplayFiles(
  db: Db,
  files: FileMeta[],
): Promise<Map<string, { path: string; size: number; sha256: string; data: Uint8Array }>> {
  const out = new Map<string, { path: string; size: number; sha256: string; data: Uint8Array }>();
  if (files.length === 0) return out;
  const rows = await db
    .selectFrom("catalog_files")
    .select(["sha256", "data"])
    .where("sha256", "in", [...new Set(files.map((f) => f.sha256))])
    .execute();
  const bySha = new Map(rows.map((r) => [r.sha256, new Uint8Array(r.data)]));
  for (const f of files) {
    const data = bySha.get(f.sha256);
    if (data === undefined) continue;
    if (createHash("sha256").update(data).digest("hex") !== f.sha256) {
      throw new ApiError("internal", `Catalog file ${f.path} does not match its recorded hash`);
    }
    out.set(f.path, { path: f.path, size: data.byteLength, sha256: f.sha256, data });
  }
  return out;
}

/**
 * Removes display files no catalog version and no import staging lists, last stored more than
 * `olderThanMs` ago (the staging cleanup passes the staging TTL: an import storing a file renews
 * it, and a concurrent renewal makes the row fail the age check when the delete re-reads it).
 * Returns the rows removed.
 */
export async function sweepDisplayFiles(db: Db, olderThanMs: number): Promise<number> {
  const r = await db
    .deleteFrom("catalog_files as f")
    .where("f.touched_at", "<", sql<Date>`now() - make_interval(secs => ${olderThanMs / 1000})`)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("catalog_item_versions as v")
            .select(sql`1`.as("x"))
            .where(
              sql<boolean>`v.files @> jsonb_build_array(jsonb_build_object('sha256', f.sha256))`,
            ),
        ),
      ),
    )
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("plugin_import_staging as s")
            .select(sql`1`.as("x"))
            .where(
              sql<boolean>`s.manifest->'files' @> jsonb_build_array(jsonb_build_object('sha256', f.sha256))`,
            ),
        ),
      ),
    )
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}
