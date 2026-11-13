import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/** 0086_org_layering.sql: org copies of overridable config and org tool switches (0085 -> 0086). */
const FILE = "0086_org_layering.sql";
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
const q = async <T>(text: string) => (await sql<T>`${sql.raw(text)}`.execute(db)).rows as T[];
const tables = () =>
  q<{ table_name: string }>(`select table_name from information_schema.tables
    where table_schema = 'capybara'
      and table_name in ('extension_org_overrides', 'org_tool_switches') order by table_name`);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0086 org layering", () => {
  it("creates both tables; a rerun of the file is a no-op", async () => {
    expect(await tables()).toEqual([]);
    const upTo = copyMigrations((f) => f <= FILE);
    await migrate(pg.url, { schema: "capybara", dir: upTo });
    expect(await tables()).toEqual([
      { table_name: "extension_org_overrides" },
      { table_name: "org_tool_switches" },
    ]);
    await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
    await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
    await sql`insert into capybara.extension_org_overrides (plugin, org_id, created_by)
      values ('p', 'o1', 'a1')`.execute(db);
    await sql`insert into capybara.org_tool_switches (org_id, plugin, tool, enabled)
      values ('o1', 'p', 't', false)`.execute(db);
    expect(await q("select plugin, org_id, config from capybara.extension_org_overrides")).toEqual([
      { plugin: "p", org_id: "o1", config: {} },
    ]);
    // the statements themselves are idempotent: running the file again changes nothing
    const text = (await import("node:fs")).readFileSync(join(upTo, FILE), "utf8");
    await sql`set search_path to capybara, public`.execute(db);
    await sql.raw(text).execute(db);
    expect(await q("select count(*)::int as n from capybara.org_tool_switches")).toEqual([
      { n: 1 },
    ]);
    // deleting an org removes its rows; deleting an account keeps them with a null actor
    await sql`delete from capybara.accounts where id = 'a1'`.execute(db);
    expect(await q("select created_by from capybara.extension_org_overrides")).toEqual([
      { created_by: null },
    ]);
    await sql`delete from capybara.orgs where id = 'o1'`.execute(db);
    expect(await q("select count(*)::int as n from capybara.extension_org_overrides")).toEqual([
      { n: 0 },
    ]);
    expect(await q("select count(*)::int as n from capybara.org_tool_switches")).toEqual([
      { n: 0 },
    ]);
  });
});
