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
 * 0190_inbox_items.sql (collaboration spec §4.9): the personal inbox items table with its
 * `org_scope` policy and partial dedupe index, and the push category `inbox`. Seeds a database
 * migrated to the file before it with an `automations` push preference, then runs 0190: the
 * stored preference stays and `inbox` is admitted.
 */
const FILE = "0190_inbox_items.sql";

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

const item = (id: string, over: { dedupe?: string | null; state?: string } = {}) =>
  sql`insert into capybara.inbox_items (id, org_id, account_id, source, plugin, kind, title,
      dedupe_key, state, expires_at)
    values (${id}, 'o1', 'a1', 'plugin', 'tracker', 'item.assigned', 'T',
      ${over.dedupe === undefined ? "k" : over.dedupe}, ${over.state ?? "open"},
      now() + interval '1 day')`.execute(db);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.push_preferences (account_id, category, enabled)
    values ('a1', 'automations', false)`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0190_inbox_items", () => {
  it("admits the push category inbox and keeps the stored preferences", async () => {
    await sql`insert into capybara.push_preferences (account_id, category, enabled)
      values ('a1', 'inbox', false)`.execute(db);
    const rows = (
      await sql<{ category: string }>`select category from capybara.push_preferences
        where account_id = 'a1' order by category`.execute(db)
    ).rows;
    expect(rows.map((r) => r.category)).toEqual(["automations", "inbox"]);
    await expect(
      sql`insert into capybara.push_preferences (account_id, category, enabled)
        values ('a1', 'other', true)`.execute(db),
    ).rejects.toThrow(/push_preferences_category_check/);
  });

  it("one open item per dedupe key; closed ones and keyless ones do not count", async () => {
    await item("i1");
    await expect(item("i2")).rejects.toThrow(/inbox_items_dedupe_uq/);
    await item("i3", { state: "resolved" });
    await item("i4", { dedupe: null });
    await item("i5", { dedupe: null });
  });

  it("a plugin item names its plugin and a kernel item none", async () => {
    await expect(
      sql`insert into capybara.inbox_items (id, org_id, account_id, source, plugin, kind, title,
          expires_at)
        values ('k1', 'o1', 'a1', 'kernel', 'tracker', 'x', 'T', now())`.execute(db),
    ).rejects.toThrow(/check/);
    await expect(
      sql`insert into capybara.inbox_items (id, org_id, account_id, source, kind, title, expires_at)
        values ('p1', 'o1', 'a1', 'plugin', 'x', 'T', now())`.execute(db),
    ).rejects.toThrow(/check/);
  });

  it("carries its org_scope policy", async () => {
    const n = (
      await sql<{ n: number }>`select count(*)::int as n from pg_policies
        where schemaname = 'capybara' and tablename = 'inbox_items'
          and policyname = 'org_scope'`.execute(db)
    ).rows[0]?.n;
    expect(n).toBe(1);
  });
});
