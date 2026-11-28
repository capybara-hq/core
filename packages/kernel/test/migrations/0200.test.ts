import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/**
 * 0200_runs_idle_mode.sql (compaction model spec §6.1): `runs.idle_mode` is the mode of an idle
 * compact run ('cache' | 'compaction_model'), null on every other run. Nullable text with a check
 * constraint, and running the file again changes nothing.
 */
const FILE = "0200_runs_idle_mode.sql";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;

const runFile = async () => {
  const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
  await sql.raw(`set search_path to capybara; ${text}`).execute(db);
};

let runN = 0;
const insertRun = (mode: string | null) => {
  runN += 1;
  return sql`insert into capybara.runs
    (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq, compact,
     idle_mode)
    values (${`r${runN}`}, 'c1', 'completed', 1, 'a1', 0, ${mode !== null}, ${mode})`.execute(db);
};

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 2);
  await migrate(pg.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 1)`.execute(db);
  await sql`insert into capybara.conversations (id, org_id, agent_id, account_id)
    values ('c1', 'o1', 'ag1', 'a1')`.execute(db);
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
});

describe("0200_runs_idle_mode", () => {
  it("adds a nullable text column", async () => {
    const r = await sql<{ data_type: string; is_nullable: string }>`select data_type, is_nullable
      from information_schema.columns
      where table_schema = 'capybara' and table_name = 'runs' and column_name = 'idle_mode'`.execute(
      db,
    );
    expect(r.rows[0]).toEqual({ data_type: "text", is_nullable: "YES" });
  });

  it("accepts only 'cache', 'compaction_model' or null", async () => {
    await insertRun(null);
    await insertRun("cache");
    await insertRun("compaction_model");
    await expect(insertRun("other")).rejects.toThrow(/runs_idle_mode_check/);
  });

  it("is idempotent", async () => {
    await runFile();
    await migrate(pg.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
    const r = await sql<{ idle_mode: string | null }>`select idle_mode from capybara.runs
      order by id`.execute(db);
    expect(r.rows.map((x) => x.idle_mode)).toEqual([null, "cache", "compaction_model"]);
    await expect(insertRun("other")).rejects.toThrow(/runs_idle_mode_check/);
  });
});
