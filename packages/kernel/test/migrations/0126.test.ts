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
 * 0126_git_gateway.sql: connectors gain `git_hosts` and `use_for_git`; the approvals kind CHECK
 * accepts 'git'. Migrates to the migration before it, then runs 0126 (twice: idempotent).
 */
const FILE = "0126_git_gateway.sql";

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

describe("0126_git_gateway", () => {
  it("connectors get git_hosts (nullable) and use_for_git (default false)", async () => {
    const r = await sql<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>`
      select column_name, is_nullable, column_default from information_schema.columns
      where table_schema = 'capybara' and table_name = 'connectors'
        and column_name in ('git_hosts', 'use_for_git') order by column_name`.execute(db);
    expect(r.rows).toEqual([
      { column_name: "git_hosts", is_nullable: "YES", column_default: null },
      { column_name: "use_for_git", is_nullable: "NO", column_default: "false" },
    ]);
  });

  it("the approvals kind CHECK accepts tool, network and git only", async () => {
    const r = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'approvals_kind_check' and conrelid = 'capybara.approvals'::regclass`.execute(
      db,
    );
    expect(r.rows).toHaveLength(1);
    const def = r.rows[0]?.def ?? "";
    for (const k of ["tool", "network", "git"]) expect(def).toContain(`'${k}'`);
    expect(def.match(/'[a-z]+'/g)).toHaveLength(3);
  });
});
