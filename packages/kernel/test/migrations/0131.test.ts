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
 * 0131_device_mode.sql: a cloud device's narrowing mode switch (`devices.mode`), null by default
 * (follow the platform and the org) or `sandbox`; auto mode is never stored. The file is
 * idempotent (a second run changes nothing).
 */
const FILE = "0131_device_mode.sql";

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

const runFile = async () => {
  const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
  await sql.raw(`set search_path to capybara; ${text}`).execute(db);
};

beforeAll(async () => {
  pg = await startTestPostgres();
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  db = createDb(pg.url, 2);
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES ('a', 'A')`.execute(db);
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES ('o', 'o', 'O', 'a')`.execute(db);
  await sql`INSERT INTO capybara.devices (id, org_id, owner_kind, owner_account_id, source)
    VALUES ('d', 'o', 'personal', 'a', 'cloud')`.execute(db);
  await runFile();
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0131_device_mode", () => {
  it("a new cloud device follows the switches (mode null); 'sandbox' narrows it", async () => {
    const row = await sql<{ mode: string | null }>`SELECT mode FROM capybara.devices
      WHERE id = 'd'`.execute(db);
    expect(row.rows[0]?.mode).toBeNull();
    await sql`UPDATE capybara.devices SET mode = 'sandbox' WHERE id = 'd'`.execute(db);
    expect(
      (
        await sql<{
          mode: string | null;
        }>`SELECT mode FROM capybara.devices WHERE id = 'd'`.execute(db)
      ).rows[0]?.mode,
    ).toBe("sandbox");
  });

  it("auto mode is never stored", async () => {
    await expect(
      sql`UPDATE capybara.devices SET mode = 'auto' WHERE id = 'd'`.execute(db),
    ).rejects.toThrow();
    await runFile();
  });
});
