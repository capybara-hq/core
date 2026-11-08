import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/** 0089_model_kinds_usage.sql: the model disabled lists and model usage (0088 -> 0089). */
const FILE = "0089_model_kinds_usage.sql";
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
      and table_name in ('model_disabled', 'model_usage') order by table_name`);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 120_000);

describe("0089 model kinds and usage", () => {
  it("creates both tables; a rerun of the file is a no-op", async () => {
    expect(await tables()).toEqual([]);
    const upTo = copyMigrations((f) => f <= FILE);
    await migrate(pg.url, { schema: "capybara", dir: upTo });
    expect(await tables()).toEqual([
      { table_name: "model_disabled" },
      { table_name: "model_usage" },
    ]);
    await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
    await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
    await sql`insert into capybara.model_disabled (org_id, provider, model, disabled_by)
      values (null, 'p', 'm', 'a1'), ('o1', 'p', 'm', 'a1')`.execute(db);
    // one row per (scope, provider, model): the platform's null org is one scope
    await expect(
      sql`insert into capybara.model_disabled (org_id, provider, model)
        values (null, 'p', 'm')`.execute(db),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      sql`insert into capybara.model_disabled (org_id, provider, model)
        values ('o1', 'p', 'm')`.execute(db),
    ).rejects.toThrow(/duplicate key/);
    await sql`insert into capybara.model_usage
      (org_id, extension, purpose, provider, model, input_tokens)
      values ('o1', 'memory', 'memory_embed', 'p', 'e', 12)`.execute(db);
    expect(
      await q(
        "select org_id, input_tokens, reported_at, id is not null as has_id from capybara.model_usage",
      ),
    ).toEqual([{ org_id: "o1", input_tokens: 12, reported_at: null, has_id: true }]);
    expect(
      await q<{ indexname: string }>(`select indexname from pg_indexes
        where schemaname = 'capybara' and tablename in ('model_disabled', 'model_usage')
        order by indexname`),
    ).toEqual([
      { indexname: "model_disabled_scope_key" },
      { indexname: "model_usage_org_time" },
      { indexname: "model_usage_pkey" },
      { indexname: "model_usage_unreported" },
    ]);
    // the statements themselves are idempotent: running the file again changes nothing
    const text = readFileSync(join(upTo, FILE), "utf8");
    await sql`set search_path to capybara, public`.execute(db);
    await sql.raw(text).execute(db);
    expect(await q("select count(*)::int as n from capybara.model_disabled")).toEqual([{ n: 2 }]);
    expect(await q("select count(*)::int as n from capybara.model_usage")).toEqual([{ n: 1 }]);
    // deleting an account keeps the rows with a null actor; deleting an org removes its rows
    await sql`delete from capybara.accounts where id = 'a1'`.execute(db);
    expect(await q("select disabled_by from capybara.model_disabled")).toEqual([
      { disabled_by: null },
      { disabled_by: null },
    ]);
    await sql`delete from capybara.orgs where id = 'o1'`.execute(db);
    expect(await q("select org_id from capybara.model_disabled")).toEqual([{ org_id: null }]);
    expect(await q("select count(*)::int as n from capybara.model_usage")).toEqual([{ n: 0 }]);
  });
});
