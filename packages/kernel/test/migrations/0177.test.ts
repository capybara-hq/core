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
 * 0177_dial_in_contract.sql: local device semantics leave the kernel (device provider phase 2).
 * A dial-in device's machine keeps only its credential and program facts; the former local
 * provider's columns, its instance bindings and boot history, and the device's `source` go.
 */
const FILE = "0177_dial_in_contract.sql";

/** What `device_machines` keeps: the generic dial-in machine. */
const MACHINE_COLUMNS = [
  "account_id",
  "arch",
  "boot_id",
  "created_at",
  "credential_hash",
  "device_id",
  "id",
  "last_seen_at",
  "name",
  "org_id",
  "os",
  "program_version",
  "revoked_at",
];

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

const columnsOf = async (table: string) =>
  (
    await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_schema = 'capybara' and table_name = ${table}
      order by column_name`.execute(db)
  ).rows.map((r) => r.column_name);

const tableExists = async (table: string) =>
  (
    await sql<{ n: number }>`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'capybara' and table_name = ${table}`.execute(db)
  ).rows[0]?.n === 1;

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  // a local device and its machine as the former local provider wrote them
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name, created_by) values ('o1', 'o1', 'O', 'a1')`.execute(
    db,
  );
  await sql`insert into capybara.devices (id, org_id, owner_kind, owner_account_id, source, provider)
    values ('d1', 'o1', 'personal', 'a1', 'local', 'device-local')`.execute(db);
  await sql`insert into capybara.device_machines
      (org_id, device_id, account_id, credential_hash, name, os, arch, program_version, mode, home)
    values ('o1', 'd1', 'a1', 'h', 'box', 'linux', 'x64', '0.1.0', 'os', '/home/a')`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0177 dial-in contract", () => {
  it("after 0177 device_machines has only the generic columns", async () => {
    expect(await columnsOf("device_machines")).toEqual(MACHINE_COLUMNS);
  });

  it("drops the bindings and boot tables and the devices' source", async () => {
    expect(await tableExists("device_instance_bindings")).toBe(false);
    expect(await tableExists("device_machine_boots")).toBe(false);
    expect(await columnsOf("devices")).not.toContain("source");
  });

  it("keeps the device and its machine", async () => {
    const rows = await sql<{ provider: string; name: string; program_version: string }>`
      select d.provider, m.name, m.program_version
      from capybara.devices d join capybara.device_machines m on m.device_id = d.id`.execute(db);
    expect(rows.rows).toEqual([
      { provider: "device-local", name: "box", program_version: "0.1.0" },
    ]);
  });

  it("0177 is idempotent", async () => {
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await sql.raw(`set search_path to capybara; ${text}`).execute(db);
    expect(await columnsOf("device_machines")).toEqual(MACHINE_COLUMNS);
  });
});
