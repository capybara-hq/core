import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/**
 * 0102_themes.sql: the theme component kind (themes spec §6, §7). Migrates to 0101, seeds an org,
 * an account and an agent template switch, then migrates to 0102.
 */
const FILE = "0102_themes.sql";
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
  await sql`insert into capybara.accounts (id, display_name) values ('acc1', 'A')`.execute(db);
  await sql`insert into capybara.component_org_switches (kind, component_id, org_id, enabled)
    values ('agent_template', 't1', 'oa', true)`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0102 themes", () => {
  it("accepts the theme kind in the scope, switch and install component tables", async () => {
    const k = kernelDb(db);
    await k
      .insertInto("component_org_switches")
      .values({ kind: "theme", component_id: "th1", org_id: "oa", enabled: true })
      .execute();
    await k
      .insertInto("component_scope_orgs")
      .values({ kind: "theme", component_id: "th1", org_id: "oa" })
      .execute();
    expect(
      await q(`select kind, component_id from capybara.component_org_switches order by kind`),
    ).toEqual([
      { kind: "agent_template", component_id: "t1" },
      { kind: "theme", component_id: "th1" },
    ]);
    const checks = await q<{ def: string }>(`select pg_get_constraintdef(oid) as def
      from pg_constraint where conname = 'plugin_install_components_kind_check'`);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.def).toContain("'theme'");
    await expect(
      q(`insert into capybara.component_org_switches (kind, component_id, org_id, enabled)
        values ('nope', 'x', 'oa', true)`),
    ).rejects.toThrow(/check/);
  });

  it("adds accounts.theme, null for existing accounts", async () => {
    const k = kernelDb(db);
    expect(await k.selectFrom("accounts").select(["id", "theme"]).execute()).toEqual([
      { id: "acc1", theme: null },
    ]);
    await k.updateTable("accounts").set({ theme: "acme" }).where("id", "=", "acc1").execute();
    expect(
      await k.selectFrom("accounts").select("theme").where("id", "=", "acc1").executeTakeFirst(),
    ).toEqual({ theme: "acme" });
  });

  it("stores themes and versions, with live names unique per plugin and origin org", async () => {
    const k = kernelDb(db);
    await k
      .insertInto("platform_themes")
      .values({ id: "th1", plugin_name: "brand", name: "acme", current_version: 1 })
      .execute();
    await k
      .insertInto("platform_theme_versions")
      .values({
        theme_id: "th1",
        version: 1,
        definition: JSON.stringify({ id: "acme" }),
        object_prefix: "platform/themes/th1/1-1.0.0/",
        catalog_version: "1.0.0",
      })
      .execute();
    const row = await k
      .selectFrom("platform_themes as t")
      .innerJoin("platform_theme_versions as v", (j) =>
        j.onRef("v.theme_id", "=", "t.id").onRef("v.version", "=", "t.current_version"),
      )
      .select([
        "t.scope_mode",
        "t.scope",
        "t.disabled",
        "t.shown_to_others",
        "t.scope_version",
        "t.owner_org_id",
        "t.origin_org_id",
        "t.shareable",
        "t.deleted_at",
        "v.definition",
        "v.updated_on_own",
        "v.created_by",
      ])
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      scope_mode: "follow",
      scope: "optional",
      disabled: false,
      shown_to_others: true,
      scope_version: 0,
      owner_org_id: null,
      origin_org_id: null,
      shareable: false,
      deleted_at: null,
      definition: { id: "acme" },
      updated_on_own: false,
      created_by: null,
    });
    await expect(
      k
        .insertInto("platform_themes")
        .values({ id: "th2", plugin_name: "brand", name: "acme", current_version: 1 })
        .execute(),
    ).rejects.toThrow(/platform_themes_live_name_origin_uq/);
    // Another origin org may reuse the name.
    await k
      .insertInto("platform_themes")
      .values({
        id: "th3",
        plugin_name: "brand",
        name: "acme",
        current_version: 1,
        owner_org_id: "oa",
        origin_org_id: "oa",
      })
      .execute();
  });

  it("re-running the file is a no-op", async () => {
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await db.transaction().execute(async (trx) => {
      await sql`set local search_path to capybara, public`.execute(trx);
      await sql`${sql.raw(text)}`.execute(trx);
    });
    expect(await q(`select count(*)::int as n from capybara.platform_themes`)).toEqual([{ n: 2 }]);
  });
});
