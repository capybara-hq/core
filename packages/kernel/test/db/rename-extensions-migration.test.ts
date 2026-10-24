import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/**
 * 0041_rename_plugins_to_extensions.sql: the nine plugin_* tables become extension_* with their
 * rows; the `source` CHECK on packages and installs takes 'catalog' instead of 'directory'; index,
 * FK and PK names stay; a second run is a no-op. Migrates to 0040 first, writes rows into the old
 * tables, then runs the whole directory.
 */
const RENAME = "0041_rename_plugins_to_extensions.sql";
const SHA = "a".repeat(64);
const ITEM = "00000000-0000-4000-8000-000000000001";

const RENAMES: [string, string][] = [
  ["plugin_installs", "extension_installs"],
  ["plugin_packages", "extension_packages"],
  ["plugin_blobs", "extension_blobs"],
  ["plugin_name_owners", "extension_name_owners"],
  ["plugin_replica_status", "extension_replica_status"],
  ["plugin_permission_snapshots", "extension_permission_snapshots"],
  ["plugin_org_configs", "extension_org_configs"],
  ["plugin_deployment_configs", "extension_deployment_configs"],
  ["plugin_directory_sources", "extension_catalog_sources"],
];

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;
let before: string;

const reg = async (t: string) =>
  (await sql<{ x: string | null }>`select to_regclass(${t})::text as x`.execute(db)).rows[0]?.x ??
  null;

const count = async (table: string) =>
  Number(
    (
      await sql<{
        n: string;
      }>`select count(*)::text as n from ${sql.table(`capybara.${table}`)}`.execute(db)
    ).rows[0]?.n,
  );

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  before = mkdtempSync(join(tmpdir(), "cap-mig-"));
  for (const f of readdirSync(KERNEL_MIGRATIONS_DIR)) {
    if (f.endsWith(".sql") && f < RENAME) {
      copyFileSync(join(KERNEL_MIGRATIONS_DIR, f), join(before, f));
    }
  }
  await migrate(pg.url, { schema: "capybara", dir: before });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.directory_items
    (id, kind, name, package_name, publisher, description, latest_version, created_by)
    values (${ITEM}, 'plugin', 'alpha', '@x/alpha', 'x', 'Alpha', '0.1.0', 'a1')`.execute(db);
  await sql`insert into capybara.plugin_packages
    (sha256, name, package_name, version, size, section, blob_store, source, source_ref, uploaded_by)
    values (${SHA}, 'alpha', '@x/alpha', '0.1.0', 10, '{}', 'pg', 'directory', ${`${ITEM}@0.1.0`}, 'a1')`.execute(
    db,
  );
  await sql`insert into capybara.plugin_blobs (sha256, bytes) values (${SHA}, '\\x00')`.execute(db);
  await sql`insert into capybara.plugin_installs
    (name, sha256, version, source, desired_state, installed_by, directory_item_id)
    values ('alpha', ${SHA}, '0.1.0', 'directory', 'enabled', 'a1', ${ITEM})`.execute(db);
  await sql`insert into capybara.plugin_name_owners (name, package_name)
    values ('alpha', '@x/alpha')`.execute(db);
  await sql`insert into capybara.plugin_replica_status (replica_id, plugin, version, sha256, source, state)
    values ('r1', 'alpha', '0.1.0', ${SHA}, 'install', 'loaded')`.execute(db);
  await sql`insert into capybara.plugin_permission_snapshots (plugin, version, permissions, source)
    values ('alpha', '0.1.0', '{}', 'web')`.execute(db);
  await sql`insert into capybara.plugin_org_configs (plugin, org_id, enabled, config)
    values ('alpha', 'o1', true, '{}')`.execute(db);
  await sql`insert into capybara.plugin_deployment_configs (plugin, config)
    values ('alpha', '{"k":1}')`.execute(db);
  await sql`insert into capybara.plugin_directory_sources (plugin, item_id)
    values ('alpha', ${ITEM})`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  if (before) rmSync(before, { recursive: true, force: true });
}, 120_000);

describe("0041 plugins -> extensions", () => {
  it("renames the nine tables and keeps their rows", async () => {
    for (const [from, to] of RENAMES) {
      expect(await reg(`capybara.${from}`), from).toBeNull();
      expect(await count(to), to).toBe(1);
    }
    const install = await sql<{
      name: string;
      source: string;
      directory_item_id: string;
    }>`select name, source, directory_item_id from capybara.extension_installs`.execute(db);
    expect(install.rows).toEqual([{ name: "alpha", source: "catalog", directory_item_id: ITEM }]);
    const pkg = await sql<{
      source: string;
    }>`select source from capybara.extension_packages`.execute(db);
    expect(pkg.rows).toEqual([{ source: "catalog" }]);
    const src = await sql<{
      plugin: string;
      item_id: string;
    }>`select plugin, item_id from capybara.extension_catalog_sources`.execute(db);
    expect(src.rows).toEqual([{ plugin: "alpha", item_id: ITEM }]);
  });

  it("the source CHECK accepts 'catalog' and rejects 'directory'", async () => {
    const other = "b".repeat(64);
    await expect(
      sql`insert into capybara.extension_packages
        (sha256, name, package_name, version, size, section, blob_store, source, source_ref)
        values (${other}, 'beta', '@x/beta', '0.1.0', 10, '{}', 'pg', 'directory', 'r')`.execute(
        db,
      ),
    ).rejects.toThrow(/check/);
    await sql`insert into capybara.extension_packages
      (sha256, name, package_name, version, size, section, blob_store, source, source_ref)
      values (${other}, 'beta', '@x/beta', '0.1.0', 10, '{}', 'pg', 'catalog', 'r')`.execute(db);
    await expect(
      sql`insert into capybara.extension_installs (name, sha256, version, source)
        values ('beta', ${other}, '0.1.0', 'directory')`.execute(db),
    ).rejects.toThrow(/check/);
    await sql`insert into capybara.extension_installs (name, sha256, version, source)
      values ('beta', ${other}, '0.1.0', 'catalog')`.execute(db);
    await sql`delete from capybara.extension_installs where name = 'beta'`.execute(db);
    await sql`delete from capybara.extension_packages where sha256 = ${other}`.execute(db);
  });

  it("FKs follow the renamed tables", async () => {
    // extension_installs.sha256 -> extension_packages; directory_item_versions.plugin_sha256 too.
    await expect(
      sql`delete from capybara.extension_packages where sha256 = ${SHA}`.execute(db),
    ).rejects.toThrow(/foreign key/);
    await expect(
      sql`insert into capybara.extension_installs (name, sha256, version, source)
        values ('gamma', ${"c".repeat(64)}, '0.1.0', 'npm')`.execute(db),
    ).rejects.toThrow(/foreign key/);
    await expect(
      sql`insert into capybara.extension_catalog_sources (plugin, item_id)
        values ('gamma', '00000000-0000-4000-8000-000000000009')`.execute(db),
    ).rejects.toThrow(/foreign key/);
  });

  it("is a no-op when run a second time", async () => {
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, RENAME), "utf8");
    await sql.raw(`set search_path to capybara, public; ${text}`).execute(db);
    for (const [, to] of RENAMES) expect(await count(to), to).toBe(1);
    const pkg = await sql<{
      source: string;
    }>`select source from capybara.extension_packages`.execute(db);
    expect(pkg.rows).toEqual([{ source: "catalog" }]);
  });
});
