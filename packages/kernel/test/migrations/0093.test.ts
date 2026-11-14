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
 * 0093_connected_environments.sql: `device` joins environments.source, and
 * environment_machines holds the connected machine of a device environment (one active per
 * environment). Migrates to the migration before it, writes a cloud environment, then runs 0093.
 */
const FILE = "0093_connected_environments.sql";

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

const insertEnv = (id: string, source: string) =>
  sql`insert into capybara.environments (id, org_id, owner_kind, owner_account_id, source)
    values (${id}, 'o1', 'personal', 'a1', ${source})`.execute(db);

const insertMachine = (environmentId: string, hash: string, revoked = false) =>
  sql`insert into capybara.environment_machines
    (org_id, environment_id, account_id, credential_hash, name, os, arch, revoked_at)
    values ('o1', ${environmentId}, 'a1', ${hash}, 'laptop', 'darwin', 'arm64',
      ${revoked ? new Date() : null})`.execute(db);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await insertEnv("e-cloud", "cloud");
  await expect(insertEnv("e-early", "device")).rejects.toThrow(/source/);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0093_connected_environments", () => {
  it("0093 adds device to environments.source", async () => {
    await insertEnv("e-dev", "device");
    await insertEnv("e-cloud-2", "cloud");
    await expect(insertEnv("e-x", "x")).rejects.toThrow(/environments_source_check/);
  });

  it("one active machine per environment", async () => {
    await insertEnv("e-m", "device");
    await insertMachine("e-m", "h-revoked", true);
    await insertMachine("e-m", "h1");
    await expect(insertMachine("e-m", "h2")).rejects.toThrow(/environment_machines_active_uq/);
    // a revoked machine next to the active one is fine
    await insertMachine("e-m", "h3", true);
    // credential hashes are unique across machines
    await insertEnv("e-m2", "device");
    await expect(insertMachine("e-m2", "h1")).rejects.toThrow(/duplicate key/);

    const { rows } = await sql<{
      id: string;
      session_isolation: boolean;
      mode: string | null;
    }>`select id, session_isolation, mode from capybara.environment_machines
      where credential_hash = 'h1'`.execute(db);
    expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0]?.session_isolation).toBe(false);
    expect(rows[0]?.mode).toBeNull();
    const idx = await sql<{ indexname: string }>`select indexname from pg_indexes
      where schemaname = 'capybara' and indexname = 'environment_machines_org_idx'`.execute(db);
    expect(idx.rows).toHaveLength(1);
    await expect(
      sql`update capybara.environment_machines set mode = 'vm' where credential_hash = 'h1'`.execute(
        db,
      ),
    ).rejects.toThrow(/mode/);
  });

  it("a rerun of the migrations is a no-op", async () => {
    await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
  });
});
