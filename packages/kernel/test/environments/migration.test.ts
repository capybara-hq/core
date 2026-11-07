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
 * 0086_environments.sql: the environment tables and constraints, the new conversation and
 * background-task columns, and `running` background tasks becoming `lost`. Migrates to 0085 first
 * and writes a running task, then runs 0086.
 */
const FILE = "0086_environments.sql";

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

const insertEnv = (id: string, name: string | null, isDefault: boolean, deleted = false) =>
  sql`insert into capybara.environments
    (id, org_id, owner_kind, owner_account_id, name, is_default, source, deleted_at)
    values (${id}, 'o1', 'personal', 'a1', ${name}, ${isDefault}, 'cloud',
      ${deleted ? new Date() : null})`.execute(db);

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
  await sql`insert into capybara.background_tasks
    (id, org_id, conversation_id, sandbox_conversation_id, run_id, call_id, trigger_account_id,
     description, command, sid, output_path, status, deadline_at, sandbox_created_at)
    values ('t1', 'o1', 'c1', 'c1', 'r1', 'k1', 'a1', 'd', 'sleep 100', '1', 'out', 'running',
      now() + interval '1 hour', now()),
      ('t2', 'o1', 'c1', 'c1', 'r1', 'k2', 'a1', 'd', 'true', '2', 'out2', 'completed',
      now() + interval '1 hour', now())`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 120_000);

describe("0086_environments", () => {
  it("migration creates the environment tables and constraints", async () => {
    await insertEnv("e1", null, true);
    await expect(insertEnv("e2", null, true)).rejects.toThrow(/environments_default_uq/);

    await insertEnv("e3", "Repo", false);
    await expect(insertEnv("e4", "repo", false)).rejects.toThrow(/environments_name_uq/);

    // a deleted default plus a live default is allowed; so is reusing a deleted name
    await sql`update capybara.environments set deleted_at = now() where id = 'e1'`.execute(db);
    await insertEnv("e5", null, true);
    await sql`update capybara.environments set deleted_at = now() where id = 'e3'`.execute(db);
    await insertEnv("e6", "REPO", false);

    await expect(
      sql`insert into capybara.environments (id, org_id, owner_kind, owner_account_id, source)
        values ('bad', 'o1', 'org', 'a1', 'cloud')`.execute(db),
    ).rejects.toThrow(/owner_kind/);
  });

  it("gives an instance row its defaults and cascades with the environment", async () => {
    await sql`insert into capybara.environment_instances (environment_id, org_id)
      values ('e5', 'o1')`.execute(db);
    const row = (
      await sql<{ status: string; fs_status: string; generation: number; had_instance: boolean }>`
        select status, fs_status, generation, had_instance
        from capybara.environment_instances where environment_id = 'e5'`.execute(db)
    ).rows[0];
    expect(row).toEqual({ status: "none", fs_status: "none", generation: 0, had_instance: false });
    await sql`insert into capybara.environment_defaults (org_id, account_id, environment_id)
      values ('o1', 'a1', 'e5')`.execute(db);
    await sql`update capybara.conversations set environment_id = 'e5' where id = 'c1'`.execute(db);
  });

  it("sets running background tasks to lost and leaves finished ones", async () => {
    const rows = (
      await sql<{ id: string; status: string; environment_id: string | null }>`
        select id, status, environment_id from capybara.background_tasks order by id`.execute(db)
    ).rows;
    expect(rows).toEqual([
      { id: "t1", status: "lost", environment_id: null },
      { id: "t2", status: "completed", environment_id: null },
    ]);
  });
});
