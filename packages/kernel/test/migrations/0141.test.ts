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
 * 0141_install_ledger_promoted_rows.sql (no compatibility before 0.1.0): a plugin install's ledger
 * rows for org skills and agent templates without plugin provenance (promoted already, or the org's
 * own rows P3-46 would let it promote) go; rows of plugin-provenance org rows and other kinds stay. Migrates to the migration
 * before it, seeds the rows, runs 0141, then runs it again (idempotent).
 */
const FILE = "0141_install_ledger_promoted_rows.sql";
const ITEM = "00000000-0000-0000-0000-000000000001";
const INSTALL = "00000000-0000-0000-0000-000000000101";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;
const dirs: string[] = [];

const copyMigrations = (pred: (f: string) => boolean) => {
  const dir = mkdtempSync(join(tmpdir(), "cap-mig-"));
  dirs.push(dir);
  for (const f of readdirSync(KERNEL_MIGRATIONS_DIR)) {
    if (f.endsWith(".sql") && pred(f)) copyFileSync(join(KERNEL_MIGRATIONS_DIR, f), join(dir, f));
  }
  return dir;
};

const ledger = async () =>
  (
    await sql<{
      kind: string;
      ref: string;
    }>`select kind, ref from capybara.plugin_install_components
      order by kind, ref`.execute(db)
  ).rows;

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name)
    values ('o1', 'o1', 'O1'), ('o2', 'o2', 'O2')`.execute(db);
  await sql`insert into capybara.catalog_items
    (id, name, package_name, publisher, description, latest_version, created_by)
    values (${ITEM}, 'item', '@x/item', 'x', 'd', '1.0.0', 'a1')`.execute(db);
  await sql`insert into capybara.plugin_installs (id, org_id, item_id, version, status, installed_by)
    values (${INSTALL}, 'o1', ${ITEM}, '1.0.0', 'installed', 'a1')`.execute(db);
  // platform rows: promoted by o1, from the plugin
  await sql`insert into capybara.platform_skills
    (id, name, description, current_version, owner_org_id, catalog_item_id) values
    ('ps-own', 'own', 'd', 1, 'o1', null),
    ('ps-plugin', 'plug', 'd', 1, null, ${ITEM})`.execute(db);
  await sql`insert into capybara.skills
    (id, org_id, scope, name, description, current_version, platform_skill_id, catalog_item_id)
    values
    ('s-promoted', 'o1', 'org', 'own', 'd', 1, 'ps-own', null),
    ('s-own', 'o1', 'org', 'own2', 'd', 1, null, null),
    ('s-plugin', 'o1', 'org', 'plug', 'd', 1, 'ps-plugin', ${ITEM}),
    ('s-copy', 'o1', 'org', 'copy', 'd', 1, null, ${ITEM})`.execute(db);
  await sql`insert into capybara.platform_agent_templates
    (id, plugin_name, name, current_version, owner_org_id, catalog_item_id) values
    ('pt-own', null, 'own', 1, 'o1', null)`.execute(db);
  await sql`insert into capybara.agent_templates
    (id, org_id, name, plugin_name, current_version, platform_template_id) values
    ('t-promoted', 'o1', 'own', null, 1, 'pt-own'),
    ('t-plain', 'o1', 'plain', null, 1, null),
    ('t-plugin', 'o1', 'tpl', 'pl', 1, null)`.execute(db);
  await sql`insert into capybara.plugin_install_components
    (install_id, kind, ref, created, skill_version) values
    (${INSTALL}, 'skill', 's-promoted', true, null),
    (${INSTALL}, 'skill', 's-own', false, 2),
    (${INSTALL}, 'skill', 's-plugin', true, null),
    (${INSTALL}, 'skill', 's-copy', true, null),
    (${INSTALL}, 'agent_template', 't-promoted', false, 1),
    (${INSTALL}, 'agent_template', 't-plain', true, null),
    (${INSTALL}, 'agent_template', 't-plugin', true, null),
    (${INSTALL}, 'extension', 'ext', true, null)`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const expected = [
  { kind: "agent_template", ref: "t-plugin" },
  { kind: "extension", ref: "ext" },
  { kind: "skill", ref: "s-copy" },
  { kind: "skill", ref: "s-plugin" },
];

describe("0141_install_ledger_promoted_rows", () => {
  it("keeps only the ledger rows of org rows with plugin provenance (and other kinds)", async () => {
    expect(await ledger()).toEqual(expected);
  });

  it("is idempotent", async () => {
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await sql.raw(`set search_path to capybara; ${text}`).execute(db);
    expect(await ledger()).toEqual(expected);
  });
});
