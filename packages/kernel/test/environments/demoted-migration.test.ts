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
 * 0094_environment_demoted_default.sql: the demotion marker, and the backfill of defaults demoted
 * before it (named `Personal (<provider>)`, ` 2`, … when taken). Migrates to the migration before
 * it, seeds rows, then runs 0094 (twice: it is idempotent).
 */
const FILE = "0094_environment_demoted_default.sql";

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
    (id, org_id, owner_kind, owner_account_id, name, is_default, source, provider, deleted_at)
    values (${id}, 'o1', 'personal', 'a1', ${name}, ${isDefault}, 'cloud', 'sandbox-e2b',
      ${deleted ? new Date() : null})`.execute(db);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await insertEnv("live", null, true);
  await insertEnv("old1", "Personal (sandbox-docker)", false);
  await insertEnv("old2", "Personal (sandbox-docker) 2", false);
  await insertEnv("gone", "Personal (sandbox-docker) 3", false, true);
  await insertEnv("mine", "Build box", false);
  await insertEnv("almost", "Personal (sandbox-docker) copy", false);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 120_000);

describe("0094_environment_demoted_default", () => {
  it("marks the defaults demoted under the old naming and drops their generated names", async () => {
    const rows = async () =>
      (
        await sql<{ id: string; name: string | null; demoted_from_provider: string | null }>`
          select id, name, demoted_from_provider from capybara.environments order by id`.execute(db)
      ).rows;
    const expected = [
      { id: "almost", name: "Personal (sandbox-docker) copy", demoted_from_provider: null },
      { id: "gone", name: "Personal (sandbox-docker) 3", demoted_from_provider: null },
      { id: "live", name: null, demoted_from_provider: null },
      { id: "mine", name: "Build box", demoted_from_provider: null },
      { id: "old1", name: null, demoted_from_provider: "sandbox-docker" },
      { id: "old2", name: null, demoted_from_provider: "sandbox-docker" },
    ];
    expect(await rows()).toEqual(expected);

    // running the file again changes nothing
    await sql
      .raw(
        `set search_path to capybara, public; ${readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8")}`,
      )
      .execute(db);
    expect(await rows()).toEqual(expected);
  });
});
