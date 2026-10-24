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
 * 0042_rename_directory_to_catalog.sql: catalog sources become marketplaces, then the enterprise
 * directory becomes the catalog. Tables keep their rows, the `directory_item_id` /
 * `directory_version` / `catalog_source_id` columns become `catalog_item_id` / `catalog_version` /
 * `marketplace_id`, FKs keep their behaviour, a version's `source` 'catalog' becomes 'marketplace'
 * (also in staged app bundles), `directory_exclusions` (directory sync) is untouched, and a second
 * run is a no-op. Migrates to
 * 0041 first and writes rows into the old tables, then migrates up to 0042 (only that file is run
 * again for the no-op check: 0041 renames plugin_installs, a name a later migration reuses).
 */
const RENAME = "0042_rename_directory_to_catalog.sql";
const ITEM = "00000000-0000-4000-8000-000000000001";
const REQUEST = "00000000-0000-4000-8000-000000000002";
const STAGED = "00000000-0000-4000-8000-000000000003";
const STAGED_FILE = "00000000-0000-4000-8000-000000000004";
const SHA = "a".repeat(64);

const RENAMES: [string, string][] = [
  ["catalog_sources", "marketplaces"],
  ["catalog_entries", "marketplace_entries"],
  ["directory_items", "catalog_items"],
  ["directory_item_versions", "catalog_item_versions"],
  ["directory_requests", "catalog_requests"],
  ["directory_org_grants", "catalog_org_grants"],
];

const COLUMNS: [string, string, string][] = [
  ["connectors", "directory_item_id", "catalog_item_id"],
  ["connectors", "directory_version", "catalog_version"],
  ["skills", "directory_item_id", "catalog_item_id"],
  ["skills", "directory_version", "catalog_version"],
  ["skill_versions", "directory_item_id", "catalog_item_id"],
  ["skill_versions", "directory_version", "catalog_version"],
  ["extension_installs", "directory_item_id", "catalog_item_id"],
  ["catalog_items", "catalog_source_id", "marketplace_id"],
];

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;
let before: string;
let upTo: string;

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

const columns = async (table: string) =>
  (
    await sql<{ c: string }>`select column_name as c from information_schema.columns
      where table_schema = 'capybara' and table_name = ${table}`.execute(db)
  ).rows.map((r) => r.c);

const copyMigrations = (pred: (f: string) => boolean) => {
  const dir = mkdtempSync(join(tmpdir(), "cap-mig-"));
  for (const f of readdirSync(KERNEL_MIGRATIONS_DIR)) {
    if (f.endsWith(".sql") && pred(f)) copyFileSync(join(KERNEL_MIGRATIONS_DIR, f), join(dir, f));
  }
  return dir;
};

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  before = copyMigrations((f) => f < RENAME);
  upTo = copyMigrations((f) => f <= RENAME);
  await migrate(pg.url, { schema: "capybara", dir: before });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.catalog_sources (id, name, url, created_by)
    values ('m1', 'Market', 'https://example.com/index.json', 'a1')`.execute(db);
  await sql`insert into capybara.catalog_entries (source_id, kind, name, npm, entry)
    values ('m1', 'plugin', 'alpha', '@x/alpha', '{}')`.execute(db);
  await sql`insert into capybara.directory_items
    (id, kind, name, package_name, publisher, description, latest_version, created_by, catalog_source_id)
    values (${ITEM}, 'plugin', 'alpha', '@x/alpha', 'x', 'Alpha', '0.1.0', 'a1', 'm1')`.execute(db);
  await sql`insert into capybara.extension_packages
    (sha256, name, package_name, version, size, section, blob_store, source, source_ref, uploaded_by)
    values (${SHA}, 'alpha', '@x/alpha', '0.1.0', 10, '{}', 'pg', 'catalog', ${`${ITEM}@0.1.0`}, 'a1')`.execute(
    db,
  );
  await sql`insert into capybara.directory_item_versions
    (item_id, version, section, source, source_ref, integrity, plugin_sha256, size, imported_by)
    values (${ITEM}, '0.1.0', '{}', 'catalog', 'm1:@x/alpha@0.1.0', 'sha512-x', ${SHA}, 10, 'a1')`.execute(
    db,
  );
  await sql`insert into capybara.directory_requests (id, org_id, item_id, stage, requested_by)
    values (${REQUEST}, 'o1', ${ITEM}, 'org', 'a1')`.execute(db);
  await sql`insert into capybara.directory_org_grants (item_id, org_id, granted_by)
    values (${ITEM}, 'o1', 'a1')`.execute(db);
  await sql`insert into capybara.connectors
    (id, org_id, slug, name, connector, created_by, directory_item_id, directory_version)
    values ('c1', 'o1', 'docs', 'Docs', 'mcp', 'a1', ${ITEM}, '0.1.0')`.execute(db);
  await sql`insert into capybara.skills
    (id, org_id, scope, name, description, current_version, created_by, directory_item_id, directory_version)
    values ('s1', 'o1', 'org', 'alpha', 'Alpha', 1, 'a1', ${ITEM}, '0.1.0')`.execute(db);
  await sql`insert into capybara.skill_versions
    (skill_id, version, manifest, object_prefix, created_by, directory_item_id, directory_version)
    values ('s1', 1, '{}', 'skills/s1/1/', 'a1', ${ITEM}, '0.1.0')`.execute(db);
  await sql`insert into capybara.extension_installs
    (name, sha256, version, source, desired_state, installed_by, directory_item_id)
    values ('alpha', ${SHA}, '0.1.0', 'catalog', 'enabled', 'a1', ${ITEM})`.execute(db);
  await sql`insert into capybara.extension_catalog_sources (plugin, item_id)
    values ('alpha', ${ITEM})`.execute(db);
  await sql`insert into capybara.app_import_staging (id, review, bundle, source, created_by, expires_at)
    values (${STAGED}, '{}', '{}', ${JSON.stringify({
      kind: "catalog",
      ref: "m1:@x/app@1.0.0",
      integrity: "sha512-x",
      catalogSourceId: "m1",
    })}, 'a1', now() + interval '1 day'),
    (${STAGED_FILE}, '{}', '{}', '{"kind":"file","ref":"upload"}', 'a1', now() + interval '1 day')`.execute(
    db,
  );
  await migrate(pg.url, { schema: "capybara", dir: upTo });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const dir of [before, upTo]) if (dir) rmSync(dir, { recursive: true, force: true });
}, 120_000);

describe("0042 directory -> catalog, catalog sources -> marketplaces", () => {
  it("renames the six tables and keeps their rows", async () => {
    for (const [from, to] of RENAMES) {
      expect(await reg(`capybara.${from}`), from).toBeNull();
      expect(await count(to), to).toBe(1);
    }
    expect(await reg("capybara.directory_exclusions")).toBe("capybara.directory_exclusions");
    expect(await columns("directory_exclusions")).not.toContain("catalog_item_id");
  });

  it("renames the columns and keeps their values", async () => {
    for (const [table, from, to] of COLUMNS) {
      const cols = await columns(table);
      expect(cols, `${table}.${from}`).not.toContain(from);
      expect(cols, `${table}.${to}`).toContain(to);
    }
    const item = await sql<{
      marketplace_id: string;
    }>`select marketplace_id from capybara.catalog_items`.execute(db);
    expect(item.rows).toEqual([{ marketplace_id: "m1" }]);
    for (const table of ["connectors", "skills", "skill_versions"]) {
      const r = await sql<{
        catalog_item_id: string;
        catalog_version: string;
      }>`select catalog_item_id, catalog_version from ${sql.table(`capybara.${table}`)}`.execute(
        db,
      );
      expect(r.rows, table).toEqual([{ catalog_item_id: ITEM, catalog_version: "0.1.0" }]);
    }
    const install = await sql<{
      catalog_item_id: string;
    }>`select catalog_item_id from capybara.extension_installs`.execute(db);
    expect(install.rows).toEqual([{ catalog_item_id: ITEM }]);
    const entry = await sql<{
      source_id: string;
    }>`select source_id from capybara.marketplace_entries`.execute(db);
    expect(entry.rows).toEqual([{ source_id: "m1" }]);
  });

  it("a version's source 'catalog' becomes 'marketplace' and the CHECK follows", async () => {
    const v = await sql<{
      source: string;
    }>`select source from capybara.catalog_item_versions`.execute(db);
    expect(v.rows).toEqual([{ source: "marketplace" }]);
    await expect(
      sql`insert into capybara.catalog_item_versions (item_id, version, section, source, source_ref, size)
        values (${ITEM}, '0.2.0', '{}', 'catalog', 'r', 10)`.execute(db),
    ).rejects.toThrow(/check/);
    for (const source of ["file", "npm", "marketplace"]) {
      await sql`insert into capybara.catalog_item_versions (item_id, version, section, source, source_ref, size)
        values (${ITEM}, '0.2.0', '{}', ${source}, 'r', 10)`.execute(db);
      await sql`delete from capybara.catalog_item_versions where version = '0.2.0'`.execute(db);
    }
  });

  it("staged app bundles from a marketplace take the new source kind and key", async () => {
    const rows = await sql<{
      id: string;
      source: unknown;
    }>`select id, source from capybara.app_import_staging order by id`.execute(db);
    expect(rows.rows).toEqual([
      {
        id: STAGED,
        source: {
          kind: "marketplace",
          ref: "m1:@x/app@1.0.0",
          integrity: "sha512-x",
          marketplaceId: "m1",
        },
      },
      { id: STAGED_FILE, source: { kind: "file", ref: "upload" } },
    ]);
  });

  it("FKs follow the renamed tables", async () => {
    await expect(
      sql`insert into capybara.catalog_item_versions (item_id, version, section, source, source_ref, size)
        values ('00000000-0000-4000-8000-000000000009', '0.1.0', '{}', 'npm', 'r', 10)`.execute(db),
    ).rejects.toThrow(/foreign key/);
    await expect(
      sql`insert into capybara.marketplace_entries (source_id, kind, name, npm, entry)
        values ('nope', 'plugin', 'beta', '@x/beta', '{}')`.execute(db),
    ).rejects.toThrow(/foreign key/);
    await expect(
      sql`update capybara.connectors set catalog_item_id = '00000000-0000-4000-8000-000000000009'`.execute(
        db,
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("is a no-op when run a second time", async () => {
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, RENAME), "utf8");
    await sql.raw(`set search_path to capybara, public; ${text}`).execute(db);
    for (const [, to] of RENAMES) expect(await count(to), to).toBe(1);
    const v = await sql<{
      source: string;
    }>`select source from capybara.catalog_item_versions`.execute(db);
    expect(v.rows).toEqual([{ source: "marketplace" }]);
    const item = await sql<{
      marketplace_id: string;
    }>`select marketplace_id from capybara.catalog_items`.execute(db);
    expect(item.rows).toEqual([{ marketplace_id: "m1" }]);
    const staged = await sql<{
      source: unknown;
    }>`select source from capybara.app_import_staging where id = ${STAGED}`.execute(db);
    expect(staged.rows[0]?.source).toMatchObject({ kind: "marketplace", marketplaceId: "m1" });
  });

  // Last: deletes the rows the other cases read.
  it("deletes cascade and set null exactly as before", async () => {
    // Deleting a marketplace drops its entries and clears the item's marketplace_id.
    await sql`delete from capybara.marketplaces where id = 'm1'`.execute(db);
    expect(await count("marketplace_entries")).toBe(0);
    const item = await sql<{
      marketplace_id: string | null;
    }>`select marketplace_id from capybara.catalog_items`.execute(db);
    expect(item.rows).toEqual([{ marketplace_id: null }]);
    // Deleting the item cascades to versions, requests, grants and extension sources and clears
    // the source item of connectors, skills, skill versions and extension installs.
    await sql`delete from capybara.catalog_items where id = ${ITEM}`.execute(db);
    for (const t of [
      "catalog_item_versions",
      "catalog_requests",
      "catalog_org_grants",
      "extension_catalog_sources",
    ]) {
      expect(await count(t), t).toBe(0);
    }
    for (const t of ["connectors", "skills", "skill_versions", "extension_installs"]) {
      const r = await sql<{
        catalog_item_id: string | null;
      }>`select catalog_item_id from ${sql.table(`capybara.${t}`)}`.execute(db);
      expect(r.rows, t).toEqual([{ catalog_item_id: null }]);
    }
  });
});
