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
 * 0129_connector_plugin_disabled.sql: connectors gain `disabled_by_plugin_id` (nullable). Migrates
 * to the migration before it, then runs 0129 (twice: idempotent).
 */
const FILE = "0129_connector_plugin_disabled.sql";

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

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
  const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
  await sql.raw(`set search_path to capybara; ${text}`).execute(db);
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 120_000);

describe("0129_connector_plugin_disabled", () => {
  it("connectors get a nullable disabled_by_plugin_id", async () => {
    const r = await sql<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
      data_type: string;
    }>`
      select column_name, is_nullable, column_default, data_type from information_schema.columns
      where table_schema = 'capybara' and table_name = 'connectors'
        and column_name = 'disabled_by_plugin_id'`.execute(db);
    expect(r.rows).toEqual([
      {
        column_name: "disabled_by_plugin_id",
        is_nullable: "YES",
        column_default: null,
        data_type: "uuid",
      },
    ]);
  });
});
