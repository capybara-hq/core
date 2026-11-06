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
 * 0080_rename_enterprise_admin.sql: the deployment-level role "enterprise admin" becomes "super
 * admin". The column accounts.is_enterprise_admin becomes is_super_admin with its values, the stored
 * deployment setting orgCreation "enterprise_admin" becomes "super_admin" (other settings untouched),
 * historical audit rows are not rewritten, and a second run is a no-op. Migrates to 0079 first,
 * writes rows under the old names, then migrates up to 0080.
 */
const FILE = "0080_rename_enterprise_admin.sql";

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

const columns = async () =>
  (
    await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_schema = 'capybara' and table_name = 'accounts'
        and column_name in ('is_enterprise_admin', 'is_super_admin')`.execute(db)
  ).rows.map((r) => r.column_name);

const admins = async () =>
  (
    await sql<{ id: string; is_super_admin: boolean }>`
      select id, is_super_admin from capybara.accounts order by id`.execute(db)
  ).rows;

const settings = async () =>
  (
    await sql<{ key: string; value: unknown }>`
      select key, value from capybara.deployment_settings order by key`.execute(db)
  ).rows;

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name, is_enterprise_admin)
    values ('a1', 'Admin', true), ('a2', 'Member', false)`.execute(db);
  await sql`insert into capybara.deployment_settings (key, value, updated_by)
    values ('orgCreation', '"enterprise_admin"', 'a1'), ('customSkills', '"deny"', 'a1')`.execute(
    db,
  );
  await sql`insert into capybara.audit_events (actor_account_id, action, target, detail)
    values ('a1', 'account.updated', 'a2', '{"isEnterpriseAdmin": true}')`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}, 120_000);

describe("0080 enterprise admin -> super admin", () => {
  it("renames the column and keeps its values and default", async () => {
    expect(await columns()).toEqual(["is_super_admin"]);
    expect(await admins()).toEqual([
      { id: "a1", is_super_admin: true },
      { id: "a2", is_super_admin: false },
    ]);
    await sql`insert into capybara.accounts (id, display_name) values ('a3', 'New')`.execute(db);
    expect((await admins()).find((r) => r.id === "a3")?.is_super_admin).toBe(false);
    await sql`delete from capybara.accounts where id = 'a3'`.execute(db);
  });

  it("rewrites the stored orgCreation value and leaves the other settings alone", async () => {
    expect(await settings()).toEqual([
      { key: "customSkills", value: "deny" },
      { key: "orgCreation", value: "super_admin" },
    ]);
  });

  it("does not rewrite historical audit rows", async () => {
    const rows = await sql<{ detail: unknown }>`
      select detail from capybara.audit_events where action = 'account.updated'`.execute(db);
    expect(rows.rows).toEqual([{ detail: { isEnterpriseAdmin: true } }]);
  });

  it("is a no-op when run a second time", async () => {
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await sql.raw(`set search_path to capybara, public; ${text}`).execute(db);
    expect(await columns()).toEqual(["is_super_admin"]);
    expect((await admins()).map((r) => r.is_super_admin)).toEqual([true, false]);
    expect((await settings()).find((r) => r.key === "orgCreation")?.value).toBe("super_admin");
  });
});
