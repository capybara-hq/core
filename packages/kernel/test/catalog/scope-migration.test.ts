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
 * 0075_plugin_scope.sql: catalog policy, grants, installs and the required flag become a scope, a
 * builtin and a disabled flag, an org list and per-org switches; pending requests are withdrawn.
 * Migrates to 0073, seeds one item per old situation, then migrates up to 0075. 0078 then gives
 * the granted orgs that never installed a `needs_approval` item a switch row `off`, and 0079 switches
 * on the installs that were `installing` / `upgrading` when 0075 ran.
 */
const FILE = "0075_plugin_scope.sql";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SHA = "a".repeat(64);
const [ALLOW, APPROVAL, DISABLED, REQUIRED] = [ID(1), ID(2), ID(3), ID(4)];
// items installed mid-flight when 0075 ran: an upgrade (allow) and an install (needs_approval)
const [UPGRADING, INSTALLING] = [ID(5), ID(6)];
const [A, B, C] = ["oa", "ob", "oc"];

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

const item = async (id: string) =>
  (
    await sql<{ scope: string; builtin: boolean; disabled: boolean }>`
      select scope, builtin, disabled from capybara.catalog_items where id = ${id}`.execute(db)
  ).rows[0];
const switches = async (id: string) =>
  (
    await sql<{ org: string; enabled: boolean }>`
      select org_id as org, enabled from capybara.catalog_item_org_switches
      where item_id = ${id} order by org_id`.execute(db)
  ).rows;
const scopeOrgs = async (id: string) =>
  (
    await sql<{ org_id: string }>`
      select org_id from capybara.catalog_item_scope_orgs where item_id = ${id}`.execute(db)
  ).rows.map((r) => r.org_id);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  for (const o of [A, B, C])
    await sql`insert into capybara.orgs (id, slug, name) values (${o}, ${o}, ${o})`.execute(db);
  const policies = [
    [ALLOW, "allow"],
    [APPROVAL, "needs_approval"],
    [DISABLED, "disabled"],
    [REQUIRED, "allow"],
    [UPGRADING, "allow"],
    [INSTALLING, "needs_approval"],
  ] as const;
  for (const [id, policy] of policies) {
    await sql`insert into capybara.catalog_items
      (id, name, package_name, publisher, description, policy, latest_version, created_by)
      values (${id}, ${`item-${id}`}, ${`@x/item-${id}`}, 'x', 'd', ${policy}, '1.0.0', 'a1')`.execute(
      db,
    );
  }
  const install = (n: number, org: string, id: string, status = "installed") =>
    sql`insert into capybara.plugin_installs (id, org_id, item_id, version, status, installed_by)
      values (${ID(100 + n)}, ${org}, ${id}, '1.0.0', ${status}, 'a1')`.execute(db);
  await install(1, A, ALLOW);
  await install(2, C, APPROVAL);
  await install(3, B, UPGRADING, "upgrading");
  // installing without a grant (e.g. as a dependency): 0075 put no org on its named list
  await install(4, A, INSTALLING, "installing");
  await install(5, B, INSTALLING, "failed");

  // B was granted and never installed; C was granted and installed it
  await sql`insert into capybara.catalog_org_grants (item_id, org_id, granted_by)
    values (${APPROVAL}, ${B}, 'a1'), (${APPROVAL}, ${C}, 'a1')`.execute(db);
  await sql`insert into capybara.catalog_requests (id, org_id, item_id, stage, requested_by, status)
    values (${ID(200)}, ${A}, ${DISABLED}, 'org', 'a1', 'pending'),
           (${ID(201)}, ${B}, ${DISABLED}, 'deployment', 'a1', 'approved')`.execute(db);
  await sql`insert into capybara.extension_packages
    (sha256, name, package_name, version, size, section, blob_store, source, source_ref, uploaded_by)
    values (${SHA}, 'req', '@x/req', '0.1.0', 10, '{}', 'pg', 'bootstrap', 'x', 'a1')`.execute(db);
  await sql`insert into capybara.extension_installs
    (name, sha256, version, source, desired_state, installed_by, catalog_item_id, required)
    values ('req', ${SHA}, '0.1.0', 'bootstrap', 'enabled', 'a1', ${REQUIRED}, true)`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 120_000);

describe("0075 plugin scope", () => {
  it("allow becomes optional, with a switch on for the org that installed it", async () => {
    expect(await item(ALLOW)).toMatchObject({ scope: "optional", disabled: false, builtin: false });
    expect(await switches(ALLOW)).toEqual([{ org: A, enabled: true }]);
  });

  it("needs_approval becomes named: granted and installed orgs, installed ones switched on", async () => {
    expect((await item(APPROVAL))?.scope).toBe("named");
    expect((await scopeOrgs(APPROVAL)).sort()).toEqual([B, C].sort());
    expect(await switches(APPROVAL)).toEqual([{ org: C, enabled: true }]);
  });

  it("disabled policy becomes the disabled flag", async () => {
    expect(await item(DISABLED)).toMatchObject({ scope: "optional", disabled: true });
  });

  it("a required bootstrap plugin becomes builtin with scope all", async () => {
    expect(await item(REQUIRED)).toMatchObject({ scope: "all", builtin: true });
  });

  it("withdraws pending requests and leaves decided ones", async () => {
    const rows = await sql<{ status: string; n: string }>`
      select status, count(*)::text as n from capybara.catalog_requests group by status
      order by status`.execute(db);
    expect(rows.rows).toEqual([
      { status: "approved", n: "1" },
      { status: "cancelled", n: "1" },
    ]);
  });

  it("rejects an unknown scope", async () => {
    await expect(
      sql`update capybara.catalog_items set scope = 'bogus' where id = ${ALLOW}`.execute(db),
    ).rejects.toThrow(/catalog_items_scope_check/);
  });
});

describe("0078 granted but never installed", () => {
  beforeAll(async () => {
    await migrate(pg.url, {
      schema: "capybara",
      dir: copyMigrations((f) => f <= "0078_scope_grant_switches.sql"),
    });
  }, 120_000);

  it("a granted org without a live install gets a switch off; an installed one keeps its switch on", async () => {
    expect((await scopeOrgs(APPROVAL)).sort()).toEqual([B, C].sort());
    expect(await switches(APPROVAL)).toEqual([
      { org: B, enabled: false },
      { org: C, enabled: true },
    ]);
    // the other items are untouched
    expect(await switches(ALLOW)).toEqual([{ org: A, enabled: true }]);
    expect(await switches(DISABLED)).toEqual([]);
  });

  it("is idempotent: running its statement again changes nothing", async () => {
    const body = readFileSync(join(KERNEL_MIGRATIONS_DIR, "0078_scope_grant_switches.sql"), "utf8");
    await db.connection().execute(async (c) => {
      await sql`set search_path to capybara`.execute(c);
      await sql.raw(body).execute(c);
      await sql`reset search_path`.execute(c);
    });
    expect(await switches(APPROVAL)).toEqual([
      { org: B, enabled: false },
      { org: C, enabled: true },
    ]);
  });
});

describe("0079 installs mid-flight at the scope migration", () => {
  beforeAll(async () => {
    await migrate(pg.url, {
      schema: "capybara",
      dir: copyMigrations((f) => f <= "0079_scope_live_install_switches.sql"),
    });
  }, 120_000);

  it("an upgrading install of an optional item gets a switch on", async () => {
    expect((await item(UPGRADING))?.scope).toBe("optional");
    expect(await switches(UPGRADING)).toEqual([{ org: B, enabled: true }]);
  });

  it("an installing install of a named item is listed and switched on; a failed one is not", async () => {
    expect((await item(INSTALLING))?.scope).toBe("named");
    expect(await scopeOrgs(INSTALLING)).toEqual([A]);
    expect(await switches(INSTALLING)).toEqual([{ org: A, enabled: true }]);
  });

  it("leaves the other items as 0075 and 0078 left them", async () => {
    expect(await switches(ALLOW)).toEqual([{ org: A, enabled: true }]);
    expect(await switches(APPROVAL)).toEqual([
      { org: B, enabled: false },
      { org: C, enabled: true },
    ]);
    expect(await switches(REQUIRED)).toEqual([]);
  });
});
