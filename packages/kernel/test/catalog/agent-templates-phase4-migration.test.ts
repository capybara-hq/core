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
 * 0085_agent_templates_phase4.sql: agent provenance and `connector_setup` requests. Migrates to
 * 0084, seeds an agent and one catalog request of each existing kind, then migrates to 0085.
 */
const FILE = "0085_agent_templates_phase4.sql";
const ITEM = "00000000-0000-0000-0000-000000000001";
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

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 1)`.execute(db);
  await sql`insert into capybara.catalog_items (id, name, publisher, description, latest_version)
    values (${ITEM}, 'plug', 'p', 'd', '1.0.0')`.execute(db);
  await sql`insert into capybara.catalog_requests (id, org_id, item_id, kind, stage)
    values ('00000000-0000-0000-0000-0000000000b1', 'o1', ${ITEM}, 'access', 'deployment'),
           ('00000000-0000-0000-0000-0000000000b2', 'o1', ${ITEM}, 'enable', 'org')`.execute(db);
  await sql`insert into capybara.catalog_requests (id, org_id, kind, entry_name, stage)
    values ('00000000-0000-0000-0000-0000000000b3', 'o1', 'import', 'ent', 'deployment')`.execute(
    db,
  );
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 120_000);

const insertSetup = (id: string, agentId: string | null) =>
  sql`insert into capybara.catalog_requests (id, org_id, kind, agent_id, pending_keys, stage)
    values (${id}, 'o1', 'connector_setup', ${agentId}, '["gh"]'::jsonb, 'org')`.execute(db);

describe("0085 agent templates phase 4", () => {
  it("adds the columns and leaves existing rows untouched", async () => {
    expect(
      await q(`select created_from_template_id, created_from_template_version,
        created_from_template_name from capybara.agents`),
    ).toEqual([
      {
        created_from_template_id: null,
        created_from_template_version: null,
        created_from_template_name: null,
      },
    ]);
    expect(
      await q(`select kind, item_id, entry_name, agent_id, pending_keys from capybara.catalog_requests
        order by id`),
    ).toEqual([
      { kind: "access", item_id: ITEM, entry_name: null, agent_id: null, pending_keys: null },
      { kind: "enable", item_id: ITEM, entry_name: null, agent_id: null, pending_keys: null },
      { kind: "import", item_id: null, entry_name: "ent", agent_id: null, pending_keys: null },
    ]);
  });

  it("a connector_setup row needs an agent and no item", async () => {
    await insertSetup("00000000-0000-0000-0000-0000000000c1", "ag1");
    await expect(insertSetup("00000000-0000-0000-0000-0000000000c2", null)).rejects.toThrow();
  });

  it("a connector_setup row carries no item or entry", async () => {
    await expect(
      sql`insert into capybara.catalog_requests (id, org_id, kind, agent_id, item_id, stage)
        values (gen_random_uuid(), 'o1', 'connector_setup', 'ag1', ${ITEM}, 'org')`.execute(db),
    ).rejects.toThrow();
    await expect(
      sql`insert into capybara.catalog_requests (id, org_id, kind, agent_id, entry_name, stage)
        values (gen_random_uuid(), 'o1', 'connector_setup', 'ag1', 'e', 'org')`.execute(db),
    ).rejects.toThrow();
  });

  it("pending_keys must be an array", async () => {
    await expect(
      sql`insert into capybara.catalog_requests (id, org_id, kind, agent_id, pending_keys, stage)
        values (gen_random_uuid(), 'o1', 'connector_setup', 'ag1', '{"a":1}'::jsonb, 'org')`.execute(
        db,
      ),
    ).rejects.toThrow();
  });

  it("one pending setup request per agent", async () => {
    await expect(insertSetup("00000000-0000-0000-0000-0000000000c3", "ag1")).rejects.toThrow();
    await sql`update capybara.catalog_requests set status = 'cancelled'
      where id = '00000000-0000-0000-0000-0000000000c1'`.execute(db);
    await insertSetup("00000000-0000-0000-0000-0000000000c3", "ag1");
  });

  it("the other kinds keep their shape and unknown kinds fail", async () => {
    await expect(
      sql`insert into capybara.catalog_requests (id, org_id, kind, stage)
        values (gen_random_uuid(), 'o1', 'enable', 'org')`.execute(db),
    ).rejects.toThrow();
    await expect(
      sql`insert into capybara.catalog_requests (id, org_id, kind, item_id, stage)
        values (gen_random_uuid(), 'o1', 'bogus', ${ITEM}, 'org')`.execute(db),
    ).rejects.toThrow();
  });

  it("deleting the agent deletes its connector_setup requests", async () => {
    await sql`delete from capybara.agents where id = 'ag1'`.execute(db);
    expect(
      await q(`select id from capybara.catalog_requests where kind = 'connector_setup'`),
    ).toEqual([]);
  });

  it("re-running the file is a no-op", async () => {
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await sql`set search_path to capybara, public`.execute(db);
    await sql.raw(text).execute(db);
  });
});
