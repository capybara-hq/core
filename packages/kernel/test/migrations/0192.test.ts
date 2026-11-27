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
 * 0192_automation_acceptance.sql (collaboration spec §4.4): the acceptance rules and work offers
 * with their `org_scope` policies, one live acceptance automation per (org, person, source,
 * agent), and a dispatch job owed again for each directed event the dispatcher left pending before.
 * Seeds a database migrated to the file before it with a pending directed event, a pending
 * undirected one and a settled directed one, then runs 0192.
 */
const FILE = "0192_automation_acceptance.sql";

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

const event = (id: string, state: string, audience: string | null) =>
  sql`insert into capybara.trigger_events (id, org_id, plugin, type, subject, summary, dedupe_key,
      audience, state)
    values (${id}, 'o1', 'tracker', 'item.assigned', '{"kind":"item","id":"1","title":"T"}', 'S',
      ${id}, ${audience}::jsonb, ${state})`.execute(db);

const automation = (id: string, origin: string, agent = "g1", deleted = false) =>
  sql`insert into capybara.automations (id, org_id, account_id, agent_id, name, prompt, trigger,
      mode, origin, status, deleted_at)
    values (${id}, 'o1', 'a1', ${agent}, 'N', 'P',
      '{"kind":"event","source":"tracker","types":["item.assigned"],"filter":[]}', 'subject',
      ${origin}, 'active', ${deleted ? sql`now()` : null})`.execute(db);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  const audience = JSON.stringify({ accountId: "a1", agentId: "g1" });
  await event("e-pending", "pending", audience);
  await event("e-plain", "pending", null);
  await event("e-done", "dispatched", audience);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0192_automation_acceptance", () => {
  it("owes a dispatch job again for each directed event left pending, and nothing else", async () => {
    const rows = (
      await sql<{
        queue: string;
        job_name: string;
        job_id: string;
        data: unknown;
        org_id: string;
      }>`select queue, job_name, job_id, data, org_id from capybara.outbox`.execute(db)
    ).rows;
    expect(rows).toEqual([
      {
        queue: "cap-kernel-maintenance",
        job_name: "trigger-dispatch",
        job_id: "trigger-dispatch-e-pending-acceptance",
        data: { orgId: "o1", eventId: "e-pending" },
        org_id: "o1",
      },
    ]);
  });

  it("stores one rule per (org, person, source) with a known mode", async () => {
    await sql`insert into capybara.automation_acceptance (org_id, account_id, source, mode)
      values ('o1', 'a1', 'tracker', 'confirm')`.execute(db);
    await expect(
      sql`insert into capybara.automation_acceptance (org_id, account_id, source, mode)
        values ('o1', 'a1', 'tracker', 'auto')`.execute(db),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      sql`insert into capybara.automation_acceptance (org_id, account_id, source, mode)
        values ('o1', 'a1', 'other', 'maybe')`.execute(db),
    ).rejects.toThrow(/check constraint/);
  });

  it("stores one offer per event, open by default, removed with its event", async () => {
    await sql`insert into capybara.automation_offers (id, org_id, account_id, event_id, source,
        agent_id) values ('f1', 'o1', 'a1', 'e-done', 'tracker', 'g1')`.execute(db);
    await expect(
      sql`insert into capybara.automation_offers (id, org_id, account_id, event_id, source,
          agent_id) values ('f2', 'o1', 'a1', 'e-done', 'tracker', 'g1')`.execute(db),
    ).rejects.toThrow(/duplicate key/);
    const state = (
      await sql<{ state: string }>`select state from capybara.automation_offers
        where id = 'f1'`.execute(db)
    ).rows[0]?.state;
    expect(state).toBe("open");
    await sql`delete from capybara.trigger_events where id = 'e-done'`.execute(db);
    const n = (
      await sql<{ n: number }>`select count(*)::int as n from capybara.automation_offers`.execute(
        db,
      )
    ).rows[0]?.n;
    expect(n).toBe(0);
  });

  it("allows one live acceptance automation per (org, person, source, agent)", async () => {
    await automation("t1", "acceptance");
    await expect(automation("t2", "acceptance")).rejects.toThrow(/duplicate key/);
    // another agent, a deleted one, or one a person made are not limited
    await automation("t3", "acceptance", "g2");
    await automation("t4", "acceptance", "g1", true);
    await automation("t5", "person");
    await automation("t6", "person");
  });

  it("carries the org_scope policies", async () => {
    const tables = (
      await sql<{ tablename: string }>`select tablename from pg_policies
        where schemaname = 'capybara' and policyname = 'org_scope'
          and tablename in ('automation_acceptance', 'automation_offers')
        order by tablename`.execute(db)
    ).rows.map((r) => r.tablename);
    expect(tables).toEqual(["automation_acceptance", "automation_offers"]);
  });
});
