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
 * 0095_devices_rename.sql (spec 2026-11-07-environments-design §15.2): every environment table,
 * column, index and constraint takes the device name; `source` 'device' becomes 'local', the
 * provider '@device' becomes '@local', and the log event 'environment_paths' becomes
 * 'device_paths'. Migrates to the migration before it, writes one row of each kind, then runs 0095.
 */
const FILE = "0095_devices_rename.sql";

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

const names = async () => {
  const tables = await sql<{ n: string }>`select table_name as n from information_schema.tables
    where table_schema = 'capybara' and table_name like '%environment%'`.execute(db);
  const columns = await sql<{ n: string }>`select table_name || '.' || column_name as n
    from information_schema.columns
    where table_schema = 'capybara' and column_name like '%environment%'`.execute(db);
  const indexes = await sql<{ n: string }>`select indexname as n from pg_indexes
    where schemaname = 'capybara' and indexname like '%environment%'`.execute(db);
  const constraints = await sql<{ n: string }>`select c.conname as n from pg_constraint c
    join pg_namespace s on s.oid = c.connamespace
    where s.nspname = 'capybara' and c.conname like '%environment%'`.execute(db);
  return [...tables.rows, ...columns.rows, ...indexes.rows, ...constraints.rows].map((r) => r.n);
};

const SNAPSHOT_EVENTS = (pathsType: string) => [
  { seq: 1, type: "run_started", payload: {}, runId: "r2", createdAt: "2026-11-09T00:00:00Z" },
  {
    seq: 2,
    type: pathsType,
    payload: { roots: {} },
    runId: "r2",
    createdAt: "2026-11-09T00:00:00Z",
  },
  { seq: 3, type: "run_completed", payload: {}, runId: "r2", createdAt: "2026-11-09T00:00:00Z" },
];

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 1)`.execute(db);
  await sql`insert into capybara.environments
    (id, org_id, owner_kind, owner_account_id, name, is_default, source, provider)
    values ('e-cloud', 'o1', 'personal', 'a1', null, true, 'cloud', 'sandbox-fake'),
      ('e-local', 'o1', 'personal', 'a1', 'Laptop', false, 'device', '@device')`.execute(db);
  await sql`insert into capybara.environment_instances (environment_id, org_id, provider, status)
    values ('e-cloud', 'o1', 'sandbox-fake', 'running')`.execute(db);
  await sql`insert into capybara.environment_instances
    (environment_id, org_id, provider, prev_provider, status)
    values ('e-local', 'o1', '@device', '@device', 'none')`.execute(db);
  await sql`insert into capybara.environment_defaults (org_id, account_id, environment_id)
    values ('o1', 'a1', 'e-cloud')`.execute(db);
  await sql`insert into capybara.environment_machines
    (org_id, environment_id, account_id, credential_hash, name, os, arch)
    values ('o1', 'e-local', 'a1', 'h1', 'laptop', 'darwin', 'arm64')`.execute(db);
  await sql`insert into capybara.conversations (id, org_id, agent_id, account_id, environment_id)
    values ('c1', 'o1', 'ag1', 'a1', 'e-cloud'), ('c2', 'o1', 'ag1', 'a1', 'e-local')`.execute(db);
  await sql`insert into capybara.background_tasks
    (id, org_id, conversation_id, sandbox_conversation_id, run_id, call_id, trigger_account_id,
     description, command, sid, output_path, status, deadline_at, sandbox_created_at,
     environment_id)
    values ('t1', 'o1', 'c1', 'c1', 'r1', 'k1', 'a1', 'd', 'sleep 100', '1', 'out', 'running',
      now() + interval '1 hour', now(), 'e-cloud'),
      ('t2', 'o1', 'c2', 'c2', 'r2', 'k2', 'a1', 'd', 'sleep 100', '2', 'out', 'running',
      now() + interval '1 hour', now(), 'e-local')`.execute(db);
  await sql`insert into capybara.conversation_events (conversation_id, seq, type, payload)
    values ('c2', 1, 'environment_paths', '{"paths":["/home/me"]}'::jsonb),
      ('c2', 2, 'user_message', '{}'::jsonb)`.execute(db);
  await sql`update capybara.conversation_events set idem_key = 'environment_paths:abc:0'
    where seq = 1`.execute(db);
  await sql`insert into capybara.eval_sets (id, org_id, agent_id, name, created_by)
    values ('00000000-0000-0000-0000-000000000001', 'o1', 'ag1', 's', 'a1')`.execute(db);
  await sql`insert into capybara.eval_cases
    (set_id, org_id, source_conversation_id, source_run_id, agent_version, title, snapshot,
     snapshot_bytes, plan_step, plan_run, added_by)
    values ('00000000-0000-0000-0000-000000000001', 'o1', 'c2', 'r2', 1, 't',
      ${JSON.stringify({ version: 1, events: SNAPSHOT_EVENTS("environment_paths") })}::jsonb,
      1, '{}'::jsonb, '{}'::jsonb, 'a1')`.execute(db);
  expect((await names()).length).toBeGreaterThan(0);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 120_000);

describe("0095_devices_rename", () => {
  it("0095 keeps every row and its links", async () => {
    const devices = await sql<{ id: string; source: string; provider: string | null }>`
      select id, source, provider from capybara.devices order by id`.execute(db);
    expect(devices.rows).toEqual([
      { id: "e-cloud", source: "cloud", provider: "sandbox-fake" },
      { id: "e-local", source: "local", provider: "@local" },
    ]);
    const instances = await sql<{
      device_id: string;
      provider: string | null;
      prev_provider: string | null;
    }>`select device_id, provider, prev_provider from capybara.device_instances
      order by device_id`.execute(db);
    expect(instances.rows).toEqual([
      { device_id: "e-cloud", provider: "sandbox-fake", prev_provider: null },
      { device_id: "e-local", provider: "@local", prev_provider: "@local" },
    ]);
    const defaults = await sql<{ device_id: string }>`
      select device_id from capybara.device_defaults`.execute(db);
    expect(defaults.rows).toEqual([{ device_id: "e-cloud" }]);
    const machines = await sql<{ device_id: string; credential_hash: string }>`
      select device_id, credential_hash from capybara.device_machines`.execute(db);
    expect(machines.rows).toEqual([{ device_id: "e-local", credential_hash: "h1" }]);
    const convs = await sql<{ id: string; device_id: string }>`
      select id, device_id from capybara.conversations order by id`.execute(db);
    expect(convs.rows).toEqual([
      { id: "c1", device_id: "e-cloud" },
      { id: "c2", device_id: "e-local" },
    ]);
    const tasks = await sql<{ id: string; device_id: string }>`
      select id, device_id from capybara.background_tasks order by id`.execute(db);
    expect(tasks.rows).toEqual([
      { id: "t1", device_id: "e-cloud" },
      { id: "t2", device_id: "e-local" },
    ]);
    const events = await sql<{ seq: string; type: string; idem_key: string | null }>`
      select seq::text, type, idem_key from capybara.conversation_events order by seq`.execute(db);
    expect(events.rows).toEqual([
      { seq: "1", type: "device_paths", idem_key: "device_paths:abc:0" },
      { seq: "2", type: "user_message", idem_key: null },
    ]);
    const cases = await sql<{ snapshot: { version: number; events: unknown[] } }>`
      select snapshot from capybara.eval_cases`.execute(db);
    expect(cases.rows).toEqual([
      { snapshot: { version: 1, events: SNAPSHOT_EVENTS("device_paths") } },
    ]);
  });

  it("no table, column, index or constraint keeps the environment name", async () => {
    expect(await names()).toEqual([]);
  });

  it("the renamed constraints and indexes still hold", async () => {
    const insertDevice = (id: string, source: string, isDefault = false) =>
      sql`insert into capybara.devices (id, org_id, owner_kind, owner_account_id, source, is_default)
        values (${id}, 'o1', 'personal', 'a1', ${source}, ${isDefault})`.execute(db);
    await insertDevice("d-local", "local");
    await expect(insertDevice("d-old", "device")).rejects.toThrow(/devices_source_check/);
    await expect(insertDevice("d-def", "cloud", true)).rejects.toThrow(/devices_default_uq/);
    await expect(
      sql`insert into capybara.device_machines
        (org_id, device_id, account_id, credential_hash, name, os, arch)
        values ('o1', 'e-local', 'a1', 'h2', 'laptop', 'darwin', 'arm64')`.execute(db),
    ).rejects.toThrow(/device_machines_active_uq/);
    const idx = await sql<{ indexdef: string }>`select indexdef from pg_indexes
      where schemaname = 'capybara' and indexname = 'conversation_events_device_paths_idx'`.execute(
      db,
    );
    expect(idx.rows[0]?.indexdef).toContain("'device_paths'::text");
    // the conversation still references its device
    await expect(
      sql`update capybara.conversations set device_id = 'missing' where id = 'c1'`.execute(db),
    ).rejects.toThrow(/conversations_device_id_fkey/);
  });

  it("a rerun of 0095 is a no-op", async () => {
    const before = await sql<{ id: string; source: string }>`
      select id, source from capybara.devices order by id`.execute(db);
    const body = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await db.transaction().execute(async (trx) => {
      await sql`set local search_path to capybara, public`.execute(trx);
      await sql.raw(body).execute(trx);
    });
    const after = await sql<{ id: string; source: string }>`
      select id, source from capybara.devices order by id`.execute(db);
    expect(after.rows).toEqual(before.rows);
    expect(await names()).toEqual([]);
    await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
  });
});
