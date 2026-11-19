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
 * 0163_read_attachments.sql: the attachments purpose check gains 'read'. Migrates up to the file
 * (where 'read' is refused), applies it, then runs it again (idempotent).
 */
const FILE = "0163_read_attachments.sql";

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

const insert = (id: string, purpose: string) =>
  sql`insert into capybara.attachments
    (id, org_id, account_id, name, content_type, size, object_key, status, purpose)
    values (${id}, 'o1', 'a1', 'x.png', 'image/png', 1, ${`k/${id}`}, 'ready', ${purpose})`.execute(
    db,
  );

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0163_read_attachments", () => {
  it("refuses 'read' before the file and accepts it after", async () => {
    await expect(insert("r0", "read")).rejects.toThrow(/attachments_purpose_check/);
    await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
    await insert("r1", "read");
    for (const p of ["chat", "skill-package", "agent-avatar"]) await insert(`p-${p}`, p);
    await expect(insert("bad", "other")).rejects.toThrow(/attachments_purpose_check/);
  });

  it("is idempotent", async () => {
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await sql.raw(`set search_path to capybara; ${text}`).execute(db);
    await insert("r2", "read");
    const n = await sql<{ n: string }>`select count(*) as n from capybara.attachments
      where purpose = 'read'`.execute(db);
    expect(Number(n.rows[0]?.n)).toBe(2);
  });
});
