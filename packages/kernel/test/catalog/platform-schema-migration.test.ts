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
 * 0081_platform_components.sql: tables for platform skills, agent templates and connector
 * templates, their scope tables, and the nullable links on the org copies. Migrates to 0080, seeds
 * an org skill and an org template, then migrates to 0081.
 */
const FILE = "0081_platform_components.sql";
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
  await sql`insert into capybara.orgs (id, slug, name) values ('oa', 'oa', 'oa')`.execute(db);
  await sql`insert into capybara.skills (id, org_id, scope, name, description, current_version)
    values ('s1', 'oa', 'org', 'sk', 'd', 1)`.execute(db);
  await sql`insert into capybara.agent_templates (id, org_id, name, plugin_name, current_version)
    values ('t1', 'oa', 'tpl', 'plug', 1)`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0081 platform components", () => {
  it("creates the tables", async () => {
    const rows = await q<{ t: string }>(`select table_name as t from information_schema.tables
      where table_schema = 'capybara' and (table_name like 'platform\\_%' or table_name like 'component\\_%')
      order by 1`);
    expect(rows.map((r) => r.t)).toEqual([
      "component_org_switches",
      "component_scope_orgs",
      "platform_agent_template_versions",
      "platform_agent_templates",
      "platform_connector_templates",
      "platform_skill_versions",
      "platform_skills",
    ]);
  });

  it("leaves the links of existing copies null", async () => {
    expect(
      await q(`select platform_skill_id, pinned_version from capybara.skills where id = 's1'`),
    ).toEqual([{ platform_skill_id: null, pinned_version: null }]);
    expect(
      await q(
        `select platform_template_id, pinned_version from capybara.agent_templates where id = 't1'`,
      ),
    ).toEqual([{ platform_template_id: null, pinned_version: null }]);
    expect(
      await q(
        `select column_name from information_schema.columns where table_schema = 'capybara'
         and table_name = 'connectors' and column_name = 'platform_template_id'`,
      ),
    ).toHaveLength(1);
  });

  it("makes agent_templates.plugin_name nullable and keeps the live name unique", async () => {
    const [c] = await q<{ is_nullable: string }>(`select is_nullable from information_schema.columns
      where table_schema = 'capybara' and table_name = 'agent_templates' and column_name = 'plugin_name'`);
    expect(c?.is_nullable).toBe("YES");
    const ins = (id: string) =>
      sql`insert into capybara.agent_templates (id, org_id, name, plugin_name, current_version)
        values (${id}, 'oa', 'bare', null, 1)`.execute(db);
    await ins("t2");
    await expect(ins("t3")).rejects.toThrow();
  });

  it("platform rows enforce defaults, checks and the live unique name", async () => {
    await sql`insert into capybara.platform_skills (id, name, description, current_version)
      values ('p1', 'x', 'd', 1)`.execute(db);
    const [r] = await q(`select scope_mode, scope, disabled, shown_to_others, scope_version
      from capybara.platform_skills where id = 'p1'`);
    expect(r).toEqual({
      scope_mode: "follow",
      scope: "optional",
      disabled: false,
      shown_to_others: true,
      scope_version: 0,
    });
    await expect(
      sql`insert into capybara.platform_skills (id, name, description, current_version)
        values ('p2', 'x', 'd', 1)`.execute(db),
    ).rejects.toThrow();
    await expect(
      sql`insert into capybara.component_scope_orgs (kind, component_id, org_id)
        values ('bogus', 'p1', 'oa')`.execute(db),
    ).rejects.toThrow();
  });

  it("re-running the file is a no-op", async () => {
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await sql`set search_path to capybara, public`.execute(db);
    await sql.raw(text).execute(db);
  });
});
