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
 * 0191_trigger_cause_handles.sql (collaboration spec §4.2, §4.7): the cause handle table with its
 * `org_scope` policy, the settled trigger event index rebuilt with the sweep's `IN` predicate, and
 * the inbox retention indexes. Seeds a database migrated to the file before it with a settled
 * event, then runs 0191.
 */
const FILE = "0191_trigger_cause_handles.sql";

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

const indexDef = async (name: string) =>
  (
    await sql<{ indexdef: string }>`select indexdef from pg_indexes
      where schemaname = 'capybara' and indexname = ${name}`.execute(db)
  ).rows[0]?.indexdef;

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.trigger_events (id, org_id, plugin, type, subject, summary,
      dedupe_key, state)
    values ('e1', 'o1', 'tracker', 'item.created', '{"kind":"item","id":"1","title":"T"}', 'S',
      'k1', 'dispatched')`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0191_trigger_cause_handles", () => {
  it("stores a handle bound to an org, a plugin and a run, removed with its org", async () => {
    await sql`insert into capybara.trigger_cause_handles (id, org_id, plugin, run_id, expires_at)
      values ('h1', 'o1', 'tracker', 'r1', now() + interval '1 day')`.execute(db);
    await expect(
      sql`insert into capybara.trigger_cause_handles (id, org_id, plugin, run_id, expires_at)
        values ('h2', 'nope', 'tracker', 'r1', now())`.execute(db),
    ).rejects.toThrow(/foreign key/);
    await sql`insert into capybara.orgs (id, slug, name) values ('o2', 'o2', 'O2')`.execute(db);
    await sql`insert into capybara.trigger_cause_handles (id, org_id, plugin, run_id, expires_at)
      values ('h3', 'o2', 'tracker', 'r1', now())`.execute(db);
    await sql`delete from capybara.orgs where id = 'o2'`.execute(db);
    const ids = (
      await sql<{ id: string }>`select id from capybara.trigger_cause_handles order by id`.execute(
        db,
      )
    ).rows.map((r) => r.id);
    expect(ids).toEqual(["h1"]);
  });

  it("carries its org_scope policy", async () => {
    const n = (
      await sql<{ n: number }>`select count(*)::int as n from pg_policies
        where schemaname = 'capybara' and tablename = 'trigger_cause_handles'
          and policyname = 'org_scope'`.execute(db)
    ).rows[0]?.n;
    expect(n).toBe(1);
  });

  it("rebuilds the settled event index with the sweep's predicate and keeps the events", async () => {
    const def = await indexDef("trigger_events_settled_idx");
    expect(def).toContain("dispatched");
    expect(def).toContain("undelivered");
    expect(def).toContain("depth_stopped");
    expect(def).not.toContain("<>");
    const n = (
      await sql<{ n: number }>`select count(*)::int as n from capybara.trigger_events`.execute(db)
    ).rows[0]?.n;
    expect(n).toBe(1);
  });

  it("adds the retention indexes", async () => {
    expect(await indexDef("trigger_cause_handles_expires_idx")).toBeDefined();
    expect(await indexDef("inbox_items_resolved_idx")).toBeDefined();
    expect(await indexDef("inbox_items_expires_idx")).toBeDefined();
  });
});
