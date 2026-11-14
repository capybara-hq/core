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
 * 0113_scheduled_tasks.sql (scheduled tasks spec §4): three new tables and three nullable columns
 * on existing ones. Migrates to the migration before it, writes a run, a conversation and a queued
 * message, then runs 0113: the existing rows read null in the new columns.
 */
const FILE = "0113_scheduled_tasks.sql";

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

const column = async (table: string, name: string) =>
  (
    await sql<{ data_type: string; is_nullable: string }>`select data_type, is_nullable
      from information_schema.columns
      where table_schema = 'capybara' and table_name = ${table} and column_name = ${name}`.execute(
      db,
    )
  ).rows;

const insertTask = (id: string) =>
  sql`insert into capybara.scheduled_tasks (id, org_id, account_id, agent_id, name, prompt, trigger,
      mode, next_run_at)
    values (${id}, 'o1', 'a1', 'ag1', 'T', 'P',
      '{"kind":"cron","expr":"0 9 * * *","timeZone":"UTC"}'::jsonb, 'new', now())`.execute(db);

const insertRun = (id: string, trial: boolean) =>
  sql`insert into capybara.scheduled_task_runs (id, task_id, org_id, scheduled_for, trial)
    values (${id}, 't1', 'o1', '2026-11-11T09:00:00Z', ${trial})`.execute(db);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 1)`.execute(db);
  await sql`insert into capybara.conversations (id, org_id, agent_id, account_id)
    values ('c1', 'o1', 'ag1', 'a1')`.execute(db);
  await sql`insert into capybara.runs (id, conversation_id, status, agent_version, trigger_account_id,
      trigger_seq)
    values ('r1', 'c1', 'completed', 1, 'a1', 1)`.execute(db);
  await sql`insert into capybara.conversation_queue (id, conversation_id, account_id, position, text,
      content, client_message_id)
    values ('q1', 'c1', 'a1', 1, 'hi', '[]'::jsonb, 'cm1')`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0113_scheduled_tasks", () => {
  it("adds the nullable link columns; existing rows read null", async () => {
    expect(await column("runs", "scheduled_task_run_id")).toEqual([
      { data_type: "text", is_nullable: "YES" },
    ]);
    expect(await column("conversations", "scheduled_task_id")).toEqual([
      { data_type: "text", is_nullable: "YES" },
    ]);
    expect(await column("conversation_queue", "schedule")).toEqual([
      { data_type: "jsonb", is_nullable: "YES" },
    ]);
    const r = await sql<{ a: unknown; b: unknown; c: unknown }>`select
      (select scheduled_task_run_id from capybara.runs where id = 'r1') as a,
      (select scheduled_task_id from capybara.conversations where id = 'c1') as b,
      (select schedule from capybara.conversation_queue where id = 'q1') as c`.execute(db);
    expect(r.rows).toEqual([{ a: null, b: null, c: null }]);
  });

  it("creates the task tables with their defaults and checks", async () => {
    await insertTask("t1");
    const t = await sql<
      Record<string, unknown>
    >`select status, jitter_seconds, consecutive_failures,
      pause_reason, deleted_at from capybara.scheduled_tasks where id = 't1'`.execute(db);
    expect(t.rows).toEqual([
      {
        status: "active",
        jitter_seconds: 0,
        consecutive_failures: 0,
        pause_reason: null,
        deleted_at: null,
      },
    ]);
    await expect(
      sql`update capybara.scheduled_tasks set mode = 'cron' where id = 't1'`.execute(db),
    ).rejects.toThrow(/check/);
  });

  it("allows one non-trial run per tick and any number of trial runs", async () => {
    await insertRun("run-a", false);
    await expect(insertRun("run-b", false)).rejects.toThrow(/scheduled_task_runs_tick_uq/);
    await insertRun("run-c", true);
    await insertRun("run-d", true);
    const n = await sql<{
      n: string;
    }>`select count(*) as n from capybara.scheduled_task_runs`.execute(db);
    expect(Number(n.rows[0]?.n)).toBe(3);
  });

  it("is idempotent: running its statements again changes nothing and fails nothing", async () => {
    const body = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await sql
      .raw(`set search_path to capybara, public; ${body}; set search_path to default`)
      .execute(db);
    await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
  });
});
