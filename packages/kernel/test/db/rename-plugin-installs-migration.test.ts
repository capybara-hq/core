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
 * 0043_rename_app_installs_to_plugin_installs.sql: app bundles become plugins. The tables
 * app_installs / app_install_components / app_import_staging become plugin_installs /
 * plugin_install_components / plugin_import_staging with their rows (plugin_installs is the name
 * 0041 freed; extension_installs is a different table and keeps its own rows), a component's kind
 * 'plugin' becomes 'extension' and the CHECK follows, FKs keep their behaviour, and a second run is
 * a no-op. Migrates to 0042 first and writes rows into the old tables, then migrates up to 0043
 * (only that file is run again for the no-op check: 0041 renames plugin_installs, which 0043
 * reuses).
 */
const RENAME = "0043_rename_app_installs_to_plugin_installs.sql";
const ITEM = "00000000-0000-4000-8000-000000000001";
const INSTALL = "00000000-0000-4000-8000-000000000002";
const STAGED = "00000000-0000-4000-8000-000000000003";
const SHA = "a".repeat(64);

const RENAMES: [string, string, number][] = [
  ["app_installs", "plugin_installs", 1],
  ["app_install_components", "plugin_install_components", 3],
  ["app_import_staging", "plugin_import_staging", 1],
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

const kinds = async () =>
  (
    await sql<{
      kind: string;
      ref: string;
    }>`select kind, ref from capybara.plugin_install_components order by kind`.execute(db)
  ).rows;

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
  await sql`insert into capybara.catalog_items
    (id, kind, name, package_name, publisher, description, latest_version, created_by)
    values (${ITEM}, 'app', 'suite', '@x/suite', 'x', 'Suite', '1.0.0', 'a1')`.execute(db);
  await sql`insert into capybara.extension_packages
    (sha256, name, package_name, version, size, section, blob_store, source, source_ref, uploaded_by)
    values (${SHA}, 'alpha', '@x/alpha', '0.1.0', 10, '{}', 'pg', 'catalog', ${`${ITEM}@1.0.0`}, 'a1')`.execute(
    db,
  );
  await sql`insert into capybara.extension_installs
    (name, sha256, version, source, desired_state, installed_by, catalog_item_id)
    values ('alpha', ${SHA}, '0.1.0', 'catalog', 'enabled', 'a1', ${ITEM})`.execute(db);
  await sql`insert into capybara.app_installs (id, org_id, item_id, version, status, installed_by)
    values (${INSTALL}, 'o1', ${ITEM}, '1.0.0', 'installed', 'a1')`.execute(db);
  await sql`insert into capybara.app_install_components (install_id, kind, ref, created)
    values (${INSTALL}, 'plugin', 'alpha', true),
      (${INSTALL}, 'connector', 'c1', true),
      (${INSTALL}, 'skill', 's1', false)`.execute(db);
  await sql`insert into capybara.app_import_staging (id, review, bundle, source, created_by, expires_at)
    values (${STAGED}, '{}', '{}', '{"kind":"file","ref":"upload"}', 'a1', now() + interval '1 day')`.execute(
    db,
  );
  await migrate(pg.url, { schema: "capybara", dir: upTo });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const dir of [before, upTo]) if (dir) rmSync(dir, { recursive: true, force: true });
}, 120_000);

describe("0043 app installs -> plugin installs", () => {
  it("renames the three tables and keeps their rows", async () => {
    for (const [from, to, n] of RENAMES) {
      expect(await reg(`capybara.${from}`), from).toBeNull();
      expect(await count(to), to).toBe(n);
    }
    const install = await sql<{
      id: string;
      org_id: string;
      item_id: string;
      status: string;
    }>`select id, org_id, item_id, status from capybara.plugin_installs`.execute(db);
    expect(install.rows).toEqual([
      { id: INSTALL, org_id: "o1", item_id: ITEM, status: "installed" },
    ]);
    const staged = await sql<{
      id: string;
      source: unknown;
    }>`select id, source from capybara.plugin_import_staging`.execute(db);
    expect(staged.rows).toEqual([{ id: STAGED, source: { kind: "file", ref: "upload" } }]);
  });

  it("plugin_installs is not the extension table: extension_installs keeps its own rows", async () => {
    const ext = await sql<{
      name: string;
      catalog_item_id: string;
    }>`select name, catalog_item_id from capybara.extension_installs`.execute(db);
    expect(ext.rows).toEqual([{ name: "alpha", catalog_item_id: ITEM }]);
  });

  it("a component's kind 'plugin' becomes 'extension' and the CHECK follows", async () => {
    expect(await kinds()).toEqual([
      { kind: "connector", ref: "c1" },
      { kind: "extension", ref: "alpha" },
      { kind: "skill", ref: "s1" },
    ]);
    await expect(
      sql`insert into capybara.plugin_install_components (install_id, kind, ref, created)
        values (${INSTALL}, 'plugin', 'beta', true)`.execute(db),
    ).rejects.toThrow(/check/);
    await sql`insert into capybara.plugin_install_components (install_id, kind, ref, created)
      values (${INSTALL}, 'extension', 'beta', true)`.execute(db);
    await sql`delete from capybara.plugin_install_components where ref = 'beta'`.execute(db);
  });

  it("FKs and the live-install unique index follow the renamed tables", async () => {
    await expect(
      sql`insert into capybara.plugin_install_components (install_id, kind, ref, created)
        values ('00000000-0000-4000-8000-000000000009', 'skill', 's2', true)`.execute(db),
    ).rejects.toThrow(/foreign key/);
    await expect(
      sql`insert into capybara.plugin_installs (id, org_id, item_id, version, status)
        values ('00000000-0000-4000-8000-000000000008', 'o1',
          '00000000-0000-4000-8000-000000000009', '1.0.0', 'installed')`.execute(db),
    ).rejects.toThrow(/foreign key/);
    await expect(
      sql`insert into capybara.plugin_installs (id, org_id, item_id, version, status)
        values ('00000000-0000-4000-8000-000000000008', 'o1', ${ITEM}, '1.0.0', 'installing')`.execute(
        db,
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("is a no-op when run a second time", async () => {
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, RENAME), "utf8");
    await sql.raw(`set search_path to capybara, public; ${text}`).execute(db);
    for (const [from, to, n] of RENAMES) {
      expect(await reg(`capybara.${from}`), from).toBeNull();
      expect(await count(to), to).toBe(n);
    }
    expect((await kinds()).map((r) => r.kind)).toEqual(["connector", "extension", "skill"]);
    expect(await count("extension_installs")).toBe(1);
  });

  // Last: deletes the rows the other cases read.
  it("deleting an install cascades to its components", async () => {
    await sql`delete from capybara.plugin_installs where id = ${INSTALL}`.execute(db);
    expect(await count("plugin_install_components")).toBe(0);
    expect(await count("extension_installs")).toBe(1);
  });
});
