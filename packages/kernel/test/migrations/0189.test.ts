import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/**
 * 0189_event_automations.sql (collaboration spec §4.1, §4.5, §4.6): the event automation tables
 * and columns. Seeds a database migrated to the file before it with an automation and a time run,
 * then runs 0189: the run's `trigger_key` is its tick as `Date.toISOString()` text, the run key is
 * `(automation_id, trigger_key)` outside trials, the widened CHECKs admit the new values, and the
 * three new tables carry their `org_scope` policies.
 */
const FILE = "0189_event_automations.sql";

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

const col = async (table: string, name: string) =>
  (
    await sql<{ is_nullable: string }>`select is_nullable from information_schema.columns
      where table_schema = 'capybara' and table_name = ${table} and column_name = ${name}`.execute(
      db,
    )
  ).rows[0]?.is_nullable;

const indexExists = async (name: string) =>
  (
    await sql<{ n: number }>`select count(*)::int as n from pg_indexes
      where schemaname = 'capybara' and indexname = ${name}`.execute(db)
  ).rows[0]?.n === 1;

const policyExists = async (table: string) =>
  (
    await sql<{ n: number }>`select count(*)::int as n from pg_policies
      where schemaname = 'capybara' and tablename = ${table} and policyname = 'org_scope'`.execute(
      db,
    )
  ).rows[0]?.n === 1;

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.automations (id, org_id, account_id, agent_id, name, prompt,
      trigger, mode, next_run_at)
    values ('t1', 'o1', 'a1', 'ag1', 'T', 'P',
      '{"kind":"cron","expr":"0 9 * * *","timeZone":"UTC"}'::jsonb, 'new', now())`.execute(db);
  await sql`insert into capybara.automation_runs (id, automation_id, org_id, scheduled_for)
    values ('tr1', 't1', 'o1', '2026-11-11T09:00:00Z'),
      ('tr2', 't1', 'o1', '2026-11-12T09:00:00.123+08:00')`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0189_event_automations", () => {
  it("backfills trigger_key of time runs with the tick as Date.toISOString() text", async () => {
    const rows = (
      await sql<{ id: string; trigger_key: string }>`select id, trigger_key
        from capybara.automation_runs order by id`.execute(db)
    ).rows;
    expect(rows).toEqual([
      { id: "tr1", trigger_key: new Date("2026-11-11T09:00:00Z").toISOString() },
      { id: "tr2", trigger_key: new Date("2026-11-12T09:00:00.123+08:00").toISOString() },
    ]);
    expect(await col("automation_runs", "trigger_key")).toBe("NO");
    expect(await col("automation_runs", "scheduled_for")).toBe("YES");
    expect(await col("automation_runs", "created_at")).toBe("NO");
  });

  it("keys runs by (automation_id, trigger_key) outside trials", async () => {
    expect(await indexExists("automation_runs_tick_uq")).toBe(false);
    expect(await indexExists("automation_runs_trigger_uq")).toBe(true);
    expect(await indexExists("automation_event_deliveries_run_idx")).toBe(true);
    await sql`insert into capybara.automation_runs (id, automation_id, org_id, trigger_key)
      values ('er1', 't1', 'o1', 'ev1')`.execute(db);
    await expect(
      sql`insert into capybara.automation_runs (id, automation_id, org_id, trigger_key)
        values ('er2', 't1', 'o1', 'ev1')`.execute(db),
    ).rejects.toMatchObject({ code: "23505" });
    // trial runs are free of the key
    await sql`insert into capybara.automation_runs (id, automation_id, org_id, trigger_key, trial)
      values ('er3', 't1', 'o1', 'ev1', true), ('er4', 't1', 'o1', 'ev1', true)`.execute(db);
  });

  it("widens the mode and skip reason CHECKs and adds the automation columns", async () => {
    await sql`insert into capybara.automations (id, org_id, account_id, agent_id, name, prompt,
        trigger, mode, origin, principal, unattended_ask)
      values ('t2', 'o1', 'a1', 'ag1', 'E', 'P',
        '{"kind":"event","source":"collab","types":["task.assigned"],"filter":[]}'::jsonb,
        'subject', 'acceptance', '{"kind":"member","accountId":"a1"}'::jsonb, 'wait')`.execute(db);
    const t1 = (
      await sql<{ origin: string; principal: unknown; unattended_ask: string | null }>`select
        origin, principal, unattended_ask from capybara.automations where id = 't1'`.execute(db)
    ).rows[0];
    expect(t1).toEqual({ origin: "person", principal: null, unattended_ask: null });
    await expect(
      sql`update capybara.automations set origin = 'other' where id = 't1'`.execute(db),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      sql`update capybara.automations set unattended_ask = 'maybe' where id = 't1'`.execute(db),
    ).rejects.toMatchObject({ code: "23514" });
    // visibility filters at dispatch and records no run: no such skip reason
    await expect(
      sql`update capybara.automation_runs set status = 'skipped', skip_reason = 'not_visible'
        where id = 'er1'`.execute(db),
    ).rejects.toMatchObject({ code: "23514" });
    await sql`update capybara.automation_runs set status = 'skipped', skip_reason = 'subject_rate'
      where id = 'er3'`.execute(db);
    await expect(
      sql`update capybara.automation_runs set skip_reason = 'bogus' where id = 'er4'`.execute(db),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("creates the event tables and link columns with their keys", async () => {
    await sql`insert into capybara.trigger_events (id, org_id, plugin, type, subject, facts,
        summary, dedupe_key)
      values ('e1', 'o1', 'collab', 'task.assigned', '{"kind":"task","id":"k1","title":"K"}'::jsonb,
        '{}'::jsonb, 'S', 'd1')`.execute(db);
    const e1 = (
      await sql<{ state: string; depth: number }>`select state, depth from capybara.trigger_events
        where id = 'e1'`.execute(db)
    ).rows[0];
    expect(e1).toEqual({ state: "pending", depth: 0 });
    await expect(
      sql`insert into capybara.trigger_events (id, org_id, plugin, type, subject, facts, summary,
          dedupe_key)
        values ('e2', 'o1', 'collab', 'task.assigned', '{}'::jsonb, '{}'::jsonb, 'S', 'd1')`.execute(
        db,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      sql`update capybara.trigger_events set state = 'lost' where id = 'e1'`.execute(db),
    ).rejects.toMatchObject({ code: "23514" });

    await sql`insert into capybara.automation_event_deliveries (org_id, automation_id, event_id,
        subject_key) values ('o1', 't2', 'e1', 'task:k1')`.execute(db);
    await expect(
      sql`insert into capybara.automation_event_deliveries (org_id, automation_id, event_id,
          subject_key) values ('o1', 't2', 'e1', 'task:k1')`.execute(db),
    ).rejects.toMatchObject({ code: "23505" });
    expect(await indexExists("automation_event_deliveries_pending_idx")).toBe(true);

    await sql`insert into capybara.automation_conversations (org_id, automation_id, subject_kind,
        subject_id, conversation_id) values ('o1', 't2', 'task', 'k1', 'c1')`.execute(db);
    await expect(
      sql`insert into capybara.automation_conversations (org_id, automation_id, subject_kind,
          subject_id, conversation_id) values ('o1', 't2', 'task', 'k1', 'c2')`.execute(db),
    ).rejects.toMatchObject({ code: "23505" });

    expect(await col("conversations", "subject")).toBe("YES");
    expect(await col("runs", "trigger_event_id")).toBe("YES");
    expect(await col("conversation_queue", "automation_event")).toBe("YES");
  });

  it("ships the org_scope policies of the new tables", async () => {
    expect(await policyExists("trigger_events")).toBe(true);
    expect(await policyExists("automation_event_deliveries")).toBe(true);
    expect(await policyExists("automation_conversations")).toBe(true);
  });
});
