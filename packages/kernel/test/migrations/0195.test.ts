import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/**
 * 0195_idle_compaction.sql (idle compaction spec §5.7, §6.3): `runs.compact_origin` marks which
 * compact runs the idle job started ('manual' | 'idle' | null), `accounts.idle_compaction` holds
 * the person's opt-out ('off' | null). Both columns are nullable text with a check constraint, and
 * running the file again changes nothing.
 */
const FILE = "0195_idle_compaction.sql";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;

const column = async (table: string, name: string) =>
  (
    await sql<{ data_type: string; is_nullable: string }>`select data_type, is_nullable
      from information_schema.columns
      where table_schema = 'capybara' and table_name = ${table} and column_name = ${name}`.execute(
      db,
    )
  ).rows[0];

const runFile = async () => {
  const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
  await sql.raw(`set search_path to capybara; ${text}`).execute(db);
};

let runN = 0;
const insertRun = (origin: string | null) => {
  runN += 1;
  return sql`insert into capybara.runs
    (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq, compact,
     compact_origin)
    values (${`r${runN}`}, 'c1', 'completed', 1, 'a1', 0, ${origin !== null}, ${origin})`.execute(
    db,
  );
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

describe("0195_idle_compaction", () => {
  it("adds two nullable text columns", async () => {
    expect(await column("runs", "compact_origin")).toEqual({
      data_type: "text",
      is_nullable: "YES",
    });
    expect(await column("accounts", "idle_compaction")).toEqual({
      data_type: "text",
      is_nullable: "YES",
    });
  });

  it("accepts only 'manual', 'idle' or null as a run's compact origin", async () => {
    await insertRun(null);
    await insertRun("manual");
    await insertRun("idle");
    await expect(insertRun("other")).rejects.toThrow(/runs_compact_origin_check/);
  });

  it("accepts only 'off' or null as the person's preference", async () => {
    await sql`update capybara.accounts set idle_compaction = 'off' where id = 'a1'`.execute(db);
    await sql`update capybara.accounts set idle_compaction = null where id = 'a1'`.execute(db);
    await expect(
      sql`update capybara.accounts set idle_compaction = 'on' where id = 'a1'`.execute(db),
    ).rejects.toThrow(/accounts_idle_compaction_check/);
  });

  it("is idempotent", async () => {
    await sql`update capybara.accounts set idle_compaction = 'off' where id = 'a1'`.execute(db);
    await runFile();
    await migrate(pg.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
    const r = await sql<{ compact_origin: string | null }>`select compact_origin from capybara.runs
      order by id`.execute(db);
    expect(r.rows.map((x) => x.compact_origin)).toEqual([null, "manual", "idle"]);
    const a = await sql<{ idle_compaction: string | null }>`select idle_compaction
      from capybara.accounts where id = 'a1'`.execute(db);
    expect(a.rows[0]?.idle_compaction).toBe("off");
    await expect(insertRun("other")).rejects.toThrow(/runs_compact_origin_check/);
  });
});
