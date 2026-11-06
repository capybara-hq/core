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
 * 0083_org_owned_items.sql: owners, sharing, pending uploads and platform notices. Migrates to
 * 0082, seeds a catalog item, a platform skill, an org skill and an org notice, then migrates to
 * 0083.
 */
const FILE = "0083_org_owned_items.sql";
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
const q = async <T>(text: string) => (await sql<T>`${sql.raw(text)}`.execute(db)).rows as T[];

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.orgs (id, slug, name) values ('org-a', 'org-a', 'a')`.execute(db);
  await sql`insert into capybara.catalog_items (id, name, publisher, description, latest_version)
    values ('00000000-0000-0000-0000-000000000001', 'plug', 'p', 'd', '1.0.0')`.execute(db);
  await sql`insert into capybara.platform_skills (id, name, description, current_version)
    values ('ps1', 'report', 'd', 1)`.execute(db);
  await sql`insert into capybara.skills (id, org_id, scope, name, description, current_version)
    values ('s1', 'org-a', 'org', 'sk', 'd', 1)`.execute(db);
  await sql`insert into capybara.org_notices (id, org_id, kind, detail)
    values ('00000000-0000-0000-0000-0000000000a1', 'org-a', 'skill_renamed', '{}'::jsonb)`.execute(
    db,
  );
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 120_000);

describe("0083 org owned items", () => {
  it("existing rows stay platform-owned and unshared", async () => {
    expect(
      await q(`select owner_org_id, shareable, awaiting_confirmation, pending_version
        from capybara.catalog_items`),
    ).toSatisfy((rows: unknown[]) =>
      rows.every(
        (r) =>
          JSON.stringify(r) ===
          JSON.stringify({
            owner_org_id: null,
            shareable: false,
            awaiting_confirmation: false,
            pending_version: null,
          }),
      ),
    );
    expect(
      await q(`select owner_org_id, origin_org_id, shareable from capybara.platform_skills`),
    ).toEqual([{ owner_org_id: null, origin_org_id: null, shareable: false }]);
    expect(await q(`select shareable from capybara.skills where id = 's1'`)).toEqual([
      { shareable: false },
    ]);
    expect(
      await q(`select column_name from information_schema.columns where table_schema = 'capybara'
        and table_name in ('agent_templates', 'platform_agent_templates', 'platform_connector_templates',
        'plugin_import_staging') and column_name in ('shareable', 'owner_org_id', 'org_id', 'origin_org_id')
        order by table_name, column_name`),
    ).toHaveLength(8);
  });

  it("the live name is unique per origin org", async () => {
    const ins = (id: string, origin: string | null) =>
      sql`insert into capybara.platform_skills (id, name, description, current_version, origin_org_id)
        values (${id}, 'report', 'd', 1, ${origin})`.execute(db);
    await ins("ps2", "org-a");
    await expect(ins("ps3", "org-a")).rejects.toThrow();
    await expect(ins("ps4", null)).rejects.toThrow();
  });

  it("org_notices accepts the new kinds only", async () => {
    const ins = (kind: string) =>
      sql`insert into capybara.org_notices (id, org_id, kind, detail)
        values (gen_random_uuid(), 'org-a', ${kind}, '{}'::jsonb)`.execute(db);
    for (const k of ["item_shared", "shared_item_updated", "upload_confirmed", "upload_rejected"]) {
      await ins(k);
    }
    await expect(ins("bogus")).rejects.toThrow();
  });

  it("platform_notices exists with its check", async () => {
    await sql`insert into capybara.platform_notices (id, kind, detail)
      values (gen_random_uuid(), 'ownership_transferred', '{}'::jsonb)`.execute(db);
    await expect(
      sql`insert into capybara.platform_notices (id, kind, detail)
        values (gen_random_uuid(), 'bogus', '{}'::jsonb)`.execute(db),
    ).rejects.toThrow();
  });

  it("re-running the file is a no-op", async () => {
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await sql`set search_path to capybara, public`.execute(db);
    await sql.raw(text).execute(db);
  });
});
