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
 * 0145_org_network_allowances.sql: the per-org table of internal endpoints. Migrates through it,
 * checks the unique (org, entry) pair and the cascade on an org's deletion, then runs the file
 * again (`IF NOT EXISTS`, idempotent).
 */
const FILE = "0145_org_network_allowances.sql";

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

const entries = async () =>
  (
    await sql<{
      org_id: string;
      entry: string;
    }>`select org_id, entry from capybara.org_network_allowances order by org_id, entry`.execute(db)
  ).rows;

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name)
    values ('o1', 'o1', 'O1'), ('o2', 'o2', 'O2')`.execute(db);
  await sql`insert into capybara.org_network_allowances (id, org_id, entry, created_by) values
    (gen_random_uuid(), 'o1', 'mcp.internal', 'a1'),
    (gen_random_uuid(), 'o1', 'http://mcp.internal:8080', null),
    (gen_random_uuid(), 'o2', 'mcp.internal', 'a1')`.execute(db);
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0145_org_network_allowances", () => {
  it("refuses the same entry twice in one org", async () => {
    await expect(
      sql`insert into capybara.org_network_allowances (id, org_id, entry)
        values (gen_random_uuid(), 'o1', 'mcp.internal')`.execute(db),
    ).rejects.toThrow(/unique/i);
  });

  it("is idempotent", async () => {
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await sql.raw(`set search_path to capybara; ${text}`).execute(db);
    expect(await entries()).toHaveLength(3);
  });

  it("drops an org's entries with the org and keeps the creator optional", async () => {
    await sql`delete from capybara.accounts where id = 'a1'`.execute(db);
    await sql`delete from capybara.orgs where id = 'o1'`.execute(db);
    expect(await entries()).toEqual([{ org_id: "o2", entry: "mcp.internal" }]);
  });
});
