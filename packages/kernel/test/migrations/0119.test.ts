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
 * 0119_outbox.sql (transactional outbox spec §4): the outbox table, one pending row per
 * (queue, job_id), and a partial index over the rows still owed. Migrates up to and including 0119,
 * then runs the file again (idempotent).
 */
const FILE = "0119_outbox.sql";

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
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
  // idempotent: the file's statements run again without error
  const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
  await sql.raw(`set search_path to capybara; ${text}`).execute(db);
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 120_000);

const insertJob = (jobId: string) =>
  sql`insert into capybara.outbox (queue, job_name, job_id, data)
    values ('cap-q', 'run', ${jobId}, '{}'::jsonb)`.execute(db);

describe("0119_outbox", () => {
  it("0119 creates outbox with a unique (queue, job_id) and a partial due index", async () => {
    const cols = await sql<{ column_name: string; data_type: string; is_nullable: string }>`
      select column_name, data_type, is_nullable from information_schema.columns
      where table_schema = 'capybara' and table_name = 'outbox' order by ordinal_position`.execute(
      db,
    );
    expect(cols.rows).toEqual([
      { column_name: "id", data_type: "bigint", is_nullable: "NO" },
      { column_name: "queue", data_type: "text", is_nullable: "NO" },
      { column_name: "job_name", data_type: "text", is_nullable: "NO" },
      { column_name: "job_id", data_type: "text", is_nullable: "NO" },
      { column_name: "data", data_type: "jsonb", is_nullable: "NO" },
      { column_name: "run_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "org_id", data_type: "text", is_nullable: "YES" },
      { column_name: "attempts", data_type: "integer", is_nullable: "NO" },
      { column_name: "next_attempt_at", data_type: "timestamp with time zone", is_nullable: "NO" },
      { column_name: "last_error", data_type: "text", is_nullable: "YES" },
      { column_name: "dead_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
    ]);

    await insertJob("j1");
    await expect(insertJob("j1")).rejects.toMatchObject({ code: "23505" });
    const row = await sql<{ attempts: number; dead_at: Date | null }>`
      select attempts, dead_at from capybara.outbox where job_id = 'j1'`.execute(db);
    expect(row.rows).toEqual([{ attempts: 0, dead_at: null }]);

    const idx = await sql<{ indexname: string; indexdef: string }>`
      select indexname, indexdef from pg_indexes
      where schemaname = 'capybara' and tablename = 'outbox' order by indexname`.execute(db);
    const due = idx.rows.find((r) => r.indexname === "outbox_due");
    expect(due?.indexdef).toContain("(next_attempt_at)");
    expect(due?.indexdef).toContain("WHERE (dead_at IS NULL)");
    const uniq = idx.rows.find((r) => r.indexname === "outbox_job_uniq");
    expect(uniq?.indexdef).toContain("UNIQUE INDEX");
    expect(uniq?.indexdef).toContain("(queue, job_id)");
  });
});
