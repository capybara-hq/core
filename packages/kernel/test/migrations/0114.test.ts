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
 * 0114_network_asks.sql (network ask-to-allow spec §5.4, §6.1): approvals gain a kind, a detail
 * and the skipped status; device machines gain features and a policy summary. Migrates to the
 * migration before it, writes a pending tool approval, then runs 0114 (twice: idempotent).
 */
const FILE = "0114_network_asks.sql";

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
    await sql<{ data_type: string; is_nullable: string; column_default: string | null }>`select
      data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'capybara' and table_name = ${table} and column_name = ${name}`.execute(
      db,
    )
  ).rows;

const insertApproval = (id: string, attempt: number, kind?: string, status = "pending") =>
  kind === undefined
    ? sql`insert into capybara.approvals (id, org_id, conversation_id, run_id, call_id, tool_key,
        requested_for, status, expires_at, spec_hash, attempt)
      values (${id}, 'o1', 'c1', 'r1', 'call1', 'Bash', 'a1', ${status}, now() + interval '1 day',
        'h', ${attempt})`.execute(db)
    : sql`insert into capybara.approvals (id, org_id, conversation_id, run_id, call_id, tool_key,
        requested_for, status, expires_at, spec_hash, attempt, kind, detail)
      values (${id}, 'o1', 'c1', 'r1', 'call1', 'Bash', 'a1', ${status}, now() + interval '1 day',
        'h', ${attempt}, ${kind}, '{"hosts":[]}'::jsonb)`.execute(db);

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
    values ('r1', 'c1', 'waiting', 1, 'a1', 1)`.execute(db);
  await insertApproval("ap1", 1);
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

describe("0114_network_asks", () => {
  it("existing approvals read kind tool and no detail", async () => {
    const r = await sql<{ kind: string; detail: unknown }>`select kind, detail
      from capybara.approvals where id = 'ap1'`.execute(db);
    expect(r.rows).toEqual([{ kind: "tool", detail: null }]);
  });

  it("a network ask takes the next attempt of its call; kind and status are checked", async () => {
    await insertApproval("ap2", 2, "network", "skipped");
    await expect(insertApproval("ap3", 2, "network")).rejects.toThrow(
      /approvals_run_call_attempt_uniq/,
    );
    await expect(insertApproval("ap4", 3, "other")).rejects.toThrow(/approvals_kind_check/);
    await expect(insertApproval("ap5", 4, "network", "maybe")).rejects.toThrow(
      /approvals_status_check/,
    );
  });

  it("device machines gain features (default empty) and a nullable policy summary", async () => {
    expect(await column("device_machines", "features")).toEqual([
      { data_type: "ARRAY", is_nullable: "NO", column_default: "'{}'::text[]" },
    ]);
    expect(await column("device_machines", "local_policy")).toEqual([
      { data_type: "jsonb", is_nullable: "YES", column_default: null },
    ]);
  });
});
