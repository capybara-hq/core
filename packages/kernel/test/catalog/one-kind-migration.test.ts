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
 * 0044_catalog_one_kind.sql: the catalog holds one kind (plugin). Every catalog row before it is in a
 * pre-0.1.0 format, so the migration removes the catalog content (items, versions, org plugin
 * installs and their components, requests, grants, extension catalog sources, staging, cached
 * marketplace entries), keeps org skills and connectors (their catalog link set to NULL) and the
 * deployment's extension installs, and reshapes the tables (no `kind`, `manifest` on versions and
 * staging, `extension_sha256`, marketplace entries keyed by `(source_id, name, version)`). Migrates to
 * 0043 first and writes one row of each old kind, then migrates up to 0044; a second run of the file
 * is a no-op (rows written in the new shape survive it).
 */
const FILE = "0044_catalog_one_kind.sql";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SHA = "a".repeat(64);
const KINDS = ["plugin", "connector-template", "skill", "app"] as const;

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;
let before: string;
let upTo: string;

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
    await sql<{ column_name: string }>`select column_name from information_schema.columns
      where table_schema = 'capybara' and table_name = ${table} order by column_name`.execute(db)
  ).rows.map((r) => r.column_name);

const copyMigrations = (pred: (f: string) => boolean) => {
  const dir = mkdtempSync(join(tmpdir(), "cap-mig-"));
  for (const f of readdirSync(KERNEL_MIGRATIONS_DIR)) {
    if (f.endsWith(".sql") && pred(f)) copyFileSync(join(KERNEL_MIGRATIONS_DIR, f), join(dir, f));
  }
  return dir;
};

const CATALOG_TABLES = [
  "plugin_install_components",
  "plugin_installs",
  "catalog_requests",
  "catalog_org_grants",
  "extension_catalog_sources",
  "plugin_import_staging",
  "catalog_item_versions",
  "catalog_items",
  "marketplace_entries",
];

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  before = copyMigrations((f) => f < FILE);
  upTo = copyMigrations((f) => f <= FILE);
  await migrate(pg.url, { schema: "capybara", dir: before });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  for (const [i, kind] of KINDS.entries()) {
    await sql`insert into capybara.catalog_items
      (id, kind, name, package_name, publisher, description, latest_version, created_by)
      values (${ID(i + 1)}, ${kind}, ${`item-${i}`}, ${`@x/item-${i}`}, 'x', 'd', '1.0.0', 'a1')`.execute(
      db,
    );
    await sql`insert into capybara.catalog_item_versions (item_id, version, section, source, source_ref, size)
      values (${ID(i + 1)}, '1.0.0', ${JSON.stringify({ kind })}, 'file', 'upload', 1)`.execute(db);
  }
  const app = ID(4);
  await sql`insert into capybara.extension_packages
    (sha256, name, package_name, version, size, section, blob_store, source, source_ref, uploaded_by)
    values (${SHA}, 'alpha', '@x/alpha', '0.1.0', 10, '{}', 'pg', 'catalog', ${`${ID(1)}@1.0.0`}, 'a1')`.execute(
    db,
  );
  await sql`update capybara.catalog_item_versions set plugin_sha256 = ${SHA} where item_id = ${ID(1)}`.execute(
    db,
  );
  await sql`insert into capybara.extension_installs
    (name, sha256, version, source, desired_state, installed_by, catalog_item_id)
    values ('alpha', ${SHA}, '0.1.0', 'catalog', 'enabled', 'a1', ${ID(1)})`.execute(db);
  await sql`insert into capybara.extension_catalog_sources (plugin, item_id) values ('alpha', ${ID(1)})`.execute(
    db,
  );
  await sql`insert into capybara.plugin_installs (id, org_id, item_id, version, status, installed_by)
    values (${ID(10)}, 'o1', ${app}, '1.0.0', 'installed', 'a1')`.execute(db);
  await sql`insert into capybara.plugin_install_components (install_id, kind, ref, created)
    values (${ID(10)}, 'extension', 'alpha', true), (${ID(10)}, 'skill', 'sk1', true)`.execute(db);
  await sql`insert into capybara.catalog_requests (id, org_id, item_id, stage, requested_by)
    values (${ID(11)}, 'o1', ${ID(3)}, 'org', 'a1')`.execute(db);
  await sql`insert into capybara.catalog_org_grants (item_id, org_id, granted_by)
    values (${ID(2)}, 'o1', 'a1')`.execute(db);
  await sql`insert into capybara.plugin_import_staging (id, review, bundle, source, created_by, expires_at)
    values (${ID(12)}, '{}', '{}', '{"kind":"file","ref":"upload"}', 'a1', now() + interval '1 day')`.execute(
    db,
  );
  await sql`insert into capybara.marketplaces (id, name, url, etag, last_status, last_refreshed_at)
    values ('m1', 'M', 'https://m.example/index.json', '"old"', 'ok', now())`.execute(db);
  await sql`insert into capybara.marketplace_entries (source_id, kind, name, npm, entry)
    values ('m1', 'plugin', 'cat-a', '@x/cat-a', '{}')`.execute(db);
  // An org skill (with a version) and a connector created from catalog items.
  await sql`insert into capybara.skills
    (id, org_id, scope, name, description, current_version, created_by, catalog_item_id, catalog_version)
    values ('sk1', 'o1', 'org', 'pdf-tools', 'PDF', 1, 'a1', ${ID(3)}, '1.0.0')`.execute(db);
  await sql`insert into capybara.skill_versions
    (skill_id, version, manifest, object_prefix, created_by, catalog_item_id, catalog_version)
    values ('sk1', 1, '{}', 'p/', 'a1', ${ID(3)}, '1.0.0')`.execute(db);
  await sql`insert into capybara.connectors
    (id, org_id, slug, name, connector, created_by, catalog_item_id, catalog_version)
    values ('c1', 'o1', 'gh', 'GitHub', 'mcp', 'a1', ${ID(2)}, '1.0.0')`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: upTo });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const dir of [before, upTo]) if (dir) rmSync(dir, { recursive: true, force: true });
}, 120_000);

describe("0044 catalog with one kind", () => {
  it("removes every pre-0.1.0 catalog row", async () => {
    for (const t of CATALOG_TABLES) expect(await count(t), t).toBe(0);
  });

  it("clears each marketplace's ETag and status, so the next refresh fetches the entries again", async () => {
    const m = await sql<{
      etag: string | null;
      last_status: string;
    }>`select etag, last_status from capybara.marketplaces where id = 'm1'`.execute(db);
    expect(m.rows).toEqual([{ etag: null, last_status: "never" }]);
  });

  it("keeps org skills and connectors, with their catalog link cleared", async () => {
    const skill = await sql<{
      id: string;
      catalog_item_id: string | null;
      catalog_version: string | null;
    }>`select id, catalog_item_id, catalog_version from capybara.skills`.execute(db);
    expect(skill.rows).toEqual([{ id: "sk1", catalog_item_id: null, catalog_version: null }]);
    const version = await sql<{
      catalog_item_id: string | null;
      catalog_version: string | null;
    }>`select catalog_item_id, catalog_version from capybara.skill_versions`.execute(db);
    expect(version.rows).toEqual([{ catalog_item_id: null, catalog_version: null }]);
    const connector = await sql<{
      id: string;
      catalog_item_id: string | null;
      catalog_version: string | null;
    }>`select id, catalog_item_id, catalog_version from capybara.connectors`.execute(db);
    expect(connector.rows).toEqual([{ id: "c1", catalog_item_id: null, catalog_version: null }]);
  });

  it("keeps the deployment's extension installs and packages, unlinked from the catalog", async () => {
    const ext = await sql<{
      name: string;
      desired_state: string;
      catalog_item_id: string | null;
    }>`select name, desired_state, catalog_item_id from capybara.extension_installs`.execute(db);
    expect(ext.rows).toEqual([{ name: "alpha", desired_state: "enabled", catalog_item_id: null }]);
    expect(await count("extension_packages")).toBe(1);
  });

  it("reshapes the tables: no kind, manifest columns, extension_sha256, entry version", async () => {
    const items = await columns("catalog_items");
    expect(items).not.toContain("kind");
    const versions = await columns("catalog_item_versions");
    expect(versions).toEqual(expect.arrayContaining(["manifest", "extension_sha256"]));
    for (const gone of ["section", "resolved", "plugin_sha256"])
      expect(versions).not.toContain(gone);
    const staging = await columns("plugin_import_staging");
    expect(staging).toContain("manifest");
    expect(staging).not.toContain("bundle");
    const entries = await columns("marketplace_entries");
    expect(entries).toContain("version");
    expect(entries).not.toContain("kind");
  });

  it("one live item per name; one marketplace entry per (source, name, version)", async () => {
    const insertItem = (id: string, deleted: boolean) =>
      sql`insert into capybara.catalog_items
        (id, name, package_name, publisher, description, latest_version, deleted_at)
        values (${id}, 'todo', '@x/todo', 'x', 'd', '1.0.0', ${deleted ? new Date() : null})`.execute(
        db,
      );
    await insertItem(ID(20), false);
    await insertItem(ID(21), true);
    await expect(insertItem(ID(22), false)).rejects.toThrow(/duplicate key/);
    await sql`insert into capybara.catalog_item_versions
      (item_id, version, manifest, source, source_ref, size, extension_sha256)
      values (${ID(20)}, '1.0.0', '{"name":"todo"}', 'file', 'upload', 1, ${SHA})`.execute(db);
    await sql`insert into capybara.marketplace_entries (source_id, name, version, npm, entry)
      values ('m1', 'todo', '1.0.0', '@x/todo', '{}'), ('m1', 'todo', '', null, '{}')`.execute(db);
    await expect(
      sql`insert into capybara.marketplace_entries (source_id, name, version, entry)
        values ('m1', 'todo', '1.0.0', '{}')`.execute(db),
    ).rejects.toThrow(/duplicate key/);
    await sql`insert into capybara.plugin_import_staging
      (id, review, manifest, source, created_by, expires_at)
      values (${ID(23)}, '{}', '{}', '{}', 'a1', now() + interval '1 day')`.execute(db);
  });

  it("is a no-op when run a second time (rows in the new shape survive)", async () => {
    await sql`update capybara.marketplaces set etag = '"new"', last_status = 'ok' where id = 'm1'`.execute(
      db,
    );
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await sql.raw(`set search_path to capybara, public; ${text}`).execute(db);
    expect(await count("catalog_items")).toBe(2);
    expect(await count("catalog_item_versions")).toBe(1);
    expect(await count("marketplace_entries")).toBe(2);
    expect(await count("plugin_import_staging")).toBe(1);
    expect(await count("skills")).toBe(1);
    expect(await count("extension_installs")).toBe(1);
    const m = await sql<{
      etag: string | null;
      last_status: string;
    }>`select etag, last_status from capybara.marketplaces where id = 'm1'`.execute(db);
    expect(m.rows).toEqual([{ etag: '"new"', last_status: "ok" }]);
  });
});
