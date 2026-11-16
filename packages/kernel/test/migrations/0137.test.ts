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
 * 0137_plugin_install_status_no_upgrading.sql: an `upgrading` plugin install becomes `installed`,
 * every per-org upgrade journal is cleared, and the status CHECK no longer allows `upgrading`.
 * Migrates to the migration before it, seeds one install per status, then runs 0137 (and again by
 * hand: idempotent).
 */
const FILE = "0137_plugin_install_status_no_upgrading.sql";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ITEM = ID(1);
const JOURNAL = JSON.stringify({ id: "u1", from: "1.0.0", to: "1.1.0", startedAt: "x", done: [] });

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

const runFile = async () => {
  const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
  await sql.raw(`set search_path to capybara; ${text}`).execute(db);
};

const installs = async () =>
  (
    await sql<{ org_id: string; status: string; upgrade: unknown }>`
      select org_id, status, upgrade from capybara.plugin_installs order by org_id`.execute(db)
  ).rows;

const insertInstall = (n: number, org: string, status: string, upgrade: string | null = null) =>
  sql`insert into capybara.plugin_installs (id, org_id, item_id, version, status, installed_by, upgrade)
    values (${ID(100 + n)}, ${org}, ${ITEM}, '1.0.0', ${status}, 'a1', ${upgrade}::jsonb)`.execute(
    db,
  );

const SEEDS = [
  ["o1", "installing"],
  ["o2", "installed"],
  ["o3", "failed"],
  ["o4", "uninstalling"],
  ["o5", "upgrading"],
] as const;

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.catalog_items
    (id, name, package_name, publisher, description, latest_version, created_by)
    values (${ITEM}, 'item', '@x/item', 'x', 'd', '1.0.0', 'a1')`.execute(db);
  for (const [i, [org, status]] of SEEDS.entries()) {
    await sql`insert into capybara.orgs (id, slug, name) values (${org}, ${org}, ${org})`.execute(
      db,
    );
    // the upgrading row carries its journal; an installed one a leftover journal
    const journal = status === "upgrading" || status === "installed" ? JOURNAL : null;
    await insertInstall(i, org, status, journal);
  }
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0137 plugin install status without upgrading", () => {
  it("an upgrading install becomes installed; the other statuses stay; every journal is cleared", async () => {
    expect(await installs()).toEqual([
      { org_id: "o1", status: "installing", upgrade: null },
      { org_id: "o2", status: "installed", upgrade: null },
      { org_id: "o3", status: "failed", upgrade: null },
      { org_id: "o4", status: "uninstalling", upgrade: null },
      { org_id: "o5", status: "installed", upgrade: null },
    ]);
  });

  it("the status check refuses upgrading", async () => {
    await sql`insert into capybara.orgs (id, slug, name) values ('o6', 'o6', 'o6')`.execute(db);
    await expect(insertInstall(6, "o6", "upgrading")).rejects.toThrow(
      /plugin_installs_status_check/,
    );
    await insertInstall(7, "o6", "installed");
  });

  it("is idempotent", async () => {
    const before = await installs();
    await runFile();
    expect(await installs()).toEqual(before);
  });
});
