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
 * 0074_subagent_tree.sql (agent map spec §6): `conversations.subagent_depth`, `runs.budget_run_id`,
 * `subagent_dispatches.budget_run_id` (backfilled with the dispatching run) and `for_skill`
 * (backfilled for fork dispatches), with
 * an index on both budget columns; stored org overrides of `subagentLimitOverrides` get
 * `maxConcurrentPerConversation` in place of `maxConcurrentPerRun`. Migrates to 0073 first and writes a phase C tree, then runs
 * 0074, then runs the file a second time.
 */
const FILE = "0074_subagent_tree.sql";

const OVERRIDES_BEFORE = {
  o1: { maxConcurrentPerRun: 2, maxDispatchesPerRun: 9, maxTokensPerRun: 20_000 },
  o2: { maxTokensPerRun: 30_000 },
};
const OVERRIDES_AFTER = {
  o1: { maxConcurrentPerConversation: 2, maxDispatchesPerRun: 9, maxTokensPerRun: 20_000 },
  o2: { maxTokensPerRun: 30_000 },
};
const SANDBOX = { o1: { cpu: 2 } };

const setting = async (key: string) =>
  (
    await sql<{ value: unknown }>`
      select value from capybara.deployment_settings where key = ${key}`.execute(db)
  ).rows[0]?.value;

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;
let before: string;
let upTo: string;

const copyMigrations = (pred: (f: string) => boolean) => {
  const dir = mkdtempSync(join(tmpdir(), "cap-mig-"));
  for (const f of readdirSync(KERNEL_MIGRATIONS_DIR)) {
    if (f.endsWith(".sql") && pred(f)) copyFileSync(join(KERNEL_MIGRATIONS_DIR, f), join(dir, f));
  }
  return dir;
};

/** Runs the file a second time the way the migrator does (one transaction, schema search path). */
async function rerun(): Promise<void> {
  const content = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
  await db.transaction().execute(async (t) => {
    await sql`set local search_path to capybara, public`.execute(t);
    await sql.raw(content).execute(t);
  });
}

const column = async (table: string, name: string) =>
  (
    await sql<{ data_type: string; is_nullable: string; column_default: string | null }>`
      select data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'capybara' and table_name = ${table} and column_name = ${name}`.execute(
      db,
    )
  ).rows[0];

const indexDef = async (table: string) =>
  (
    await sql<{ indexdef: string }>`
      select indexdef from pg_indexes where schemaname = 'capybara' and tablename = ${table}`.execute(
      db,
    )
  ).rows.map((r) => r.indexdef);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  before = copyMigrations((f) => f < FILE);
  upTo = copyMigrations((f) => f <= FILE);
  await migrate(pg.url, { schema: "capybara", dir: before });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 1)`.execute(db);
  await sql`insert into capybara.conversations (id, org_id, agent_id, account_id)
    values ('p1', 'o1', 'ag1', 'a1')`.execute(db);
  await sql`insert into capybara.conversations
    (id, org_id, agent_id, account_id, kind, parent_conversation_id, subagent_type)
    values ('s1', 'o1', 'ag1', 'a1', 'subagent', 'p1', 'general-purpose'),
      ('s2', 'o1', 'ag1', 'a1', 'subagent', 'p1', 'general-purpose')`.execute(db);
  await sql`insert into capybara.runs (id, conversation_id, status, agent_version, trigger_account_id)
    values ('rp', 'p1', 'completed', 1, 'a1'), ('rs', 's1', 'completed', 1, 'a1'),
      ('rf', 's2', 'completed', 1, 'a1')`.execute(db);
  await sql`insert into capybara.subagent_dispatches
    (parent_run_id, parent_call_id, parent_conversation_id, step, child_conversation_id, child_run_id)
    values ('rp', 'call-1', 'p1', 0, 's1', 'rs'), ('rp', 'skill-7', 'p1', 0, 's2', 'rf')`.execute(
    db,
  );
  await sql`insert into capybara.deployment_settings (key, value) values
    ('subagentLimitOverrides', ${JSON.stringify(OVERRIDES_BEFORE)}::jsonb),
    ('sandboxLimitOverrides', ${JSON.stringify(SANDBOX)}::jsonb)`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: upTo });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const dir of [before, upTo]) if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("0074_subagent_tree", () => {
  it("adds the columns with their types and defaults", async () => {
    expect(await column("conversations", "subagent_depth")).toEqual({
      data_type: "smallint",
      is_nullable: "NO",
      column_default: "0",
    });
    expect(await column("runs", "budget_run_id")).toEqual({
      data_type: "text",
      is_nullable: "YES",
      column_default: null,
    });
    expect(await column("subagent_dispatches", "budget_run_id")).toEqual({
      data_type: "text",
      is_nullable: "NO",
      column_default: null,
    });
    expect(await column("subagent_dispatches", "for_skill")).toEqual({
      data_type: "boolean",
      is_nullable: "NO",
      column_default: "false",
    });
  });

  it("indexes budget_run_id on runs and subagent_dispatches", async () => {
    expect((await indexDef("runs")).some((d) => /\(budget_run_id\)/.test(d))).toBe(true);
    expect((await indexDef("subagent_dispatches")).some((d) => /\(budget_run_id\)/.test(d))).toBe(
      true,
    );
  });

  it("existing rows: depth 0, no budget run, the dispatching run as the budget run, not for a skill", async () => {
    const convs = await sql<{ id: string; subagent_depth: number }>`
      select id, subagent_depth from capybara.conversations order by id`.execute(db);
    expect(convs.rows).toEqual([
      { id: "p1", subagent_depth: 0 },
      { id: "s1", subagent_depth: 0 },
      { id: "s2", subagent_depth: 0 },
    ]);
    const runs = await sql<{ id: string; budget_run_id: string | null }>`
      select id, budget_run_id from capybara.runs order by id`.execute(db);
    expect(runs.rows).toEqual([
      { id: "rf", budget_run_id: null },
      { id: "rp", budget_run_id: null },
      { id: "rs", budget_run_id: null },
    ]);
    // a fork dispatch (`skill-<seq>` at step 0) is marked; an `Agent` call's is not
    const dispatches = await sql<{
      parent_call_id: string;
      budget_run_id: string;
      for_skill: boolean;
    }>`
      select parent_call_id, budget_run_id, for_skill from capybara.subagent_dispatches
      order by parent_call_id`.execute(db);
    expect(dispatches.rows).toEqual([
      { parent_call_id: "call-1", budget_run_id: "rp", for_skill: false },
      { parent_call_id: "skill-7", budget_run_id: "rp", for_skill: true },
    ]);
  });

  it("stored org overrides carry maxConcurrentPerConversation, other keys and settings intact", async () => {
    expect(await setting("subagentLimitOverrides")).toEqual(OVERRIDES_AFTER);
    expect(await setting("sandboxLimitOverrides")).toEqual(SANDBOX);
  });

  it("applies a second time without error or change", async () => {
    await rerun();
    expect(await setting("subagentLimitOverrides")).toEqual(OVERRIDES_AFTER);
    const dispatches = await sql<{ budget_run_id: string; for_skill: boolean }>`
      select budget_run_id, for_skill from capybara.subagent_dispatches
      order by parent_call_id`.execute(db);
    expect(dispatches.rows).toEqual([
      { budget_run_id: "rp", for_skill: false },
      { budget_run_id: "rp", for_skill: true },
    ]);
    // a new dispatch must name its budget run
    await expect(
      sql`insert into capybara.subagent_dispatches
        (parent_run_id, parent_call_id, parent_conversation_id, step, child_conversation_id, child_run_id)
        values ('rp', 'call-2', 'p1', 1, 's1', 'rs')`.execute(db),
    ).rejects.toThrow(/budget_run_id/);
  });
});
