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
 * 0121_drop_platform_migration_runs.sql (transactional outbox Task 15): the removed platform
 * components migration job's runs table goes, and with it the org notices of the kind only that job
 * wrote (`skill_renamed`), which the kind check no longer allows. Migrates up to 0120, seeds a run
 * and notices, migrates 0121, then runs the file again (idempotent).
 */
const FILE = "0121_drop_platform_migration_runs.sql";

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

const notice = (id: string, kind: string) =>
  sql`insert into capybara.org_notices (id, org_id, kind, detail)
    values (${id}::uuid, 'org-a', ${kind}, '{}'::jsonb)`.execute(db);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.orgs (id, slug, name) values ('org-a', 'org-a', 'a')`.execute(db);
  await sql`insert into capybara.platform_migration_runs (id) values (gen_random_uuid())`.execute(
    db,
  );
  await notice("00000000-0000-0000-0000-0000000000a1", "skill_renamed");
  await notice("00000000-0000-0000-0000-0000000000a2", "upload_confirmed");
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

describe("0121_drop_platform_migration_runs", () => {
  it("drops the runs table", async () => {
    const r = await sql<{ n: string }>`select count(*) as n from information_schema.tables
      where table_schema = 'capybara' and table_name = 'platform_migration_runs'`.execute(db);
    expect(Number(r.rows[0]?.n)).toBe(0);
  });

  it("deletes the skill_renamed notices, keeps the others, and refuses the kind", async () => {
    const r = await sql<{ kind: string }>`select kind from capybara.org_notices`.execute(db);
    expect(r.rows).toEqual([{ kind: "upload_confirmed" }]);
    await expect(notice("00000000-0000-0000-0000-0000000000a3", "skill_renamed")).rejects.toThrow(
      /org_notices_kind_check/,
    );
    await notice("00000000-0000-0000-0000-0000000000a4", "item_shared");
  });
});
