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
 * 0165_device_network_columns.sql (approval-only profiles design, "Migration"): a cloud device gets
 * its own sandbox network choice (`network_mode`, `network_hosts`), copied from the B1 snapshot's
 * outer network where that was an allowlist (never wider); an open or missing snapshot follows the
 * org (null). Migrates to the migration before it, seeds devices, runs 0165, then again by hand.
 */
const FILE = "0165_device_network_columns.sql";

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

/** Seeds: the outer network snapshot (null: not snapshotted) and the source. */
const SEEDS: Record<string, { source: "cloud" | "local"; outer: unknown }> = {
  d_allow: {
    source: "cloud",
    outer: { kind: "allowlist", hosts: ["github.com", "*.npmjs.org"] },
  },
  d_empty: { source: "cloud", outer: { kind: "allowlist", hosts: [] } },
  d_open: { source: "cloud", outer: { kind: "open-public", hosts: [] } },
  d_none: { source: "cloud", outer: null },
  d_badhosts: { source: "cloud", outer: { kind: "allowlist", hosts: "github.com" } },
  d_mixedhosts: { source: "cloud", outer: { kind: "allowlist", hosts: ["github.com", 7] } },
  d_local: { source: "local", outer: null },
};

const rowOf = async (id: string) =>
  (
    await sql<{
      network_mode: string | null;
      network_hosts: unknown;
    }>`select network_mode, network_hosts from capybara.devices where id = ${id}`.execute(db)
  ).rows[0];

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name, created_by) values ('o1', 'o1', 'O', 'a1')`.execute(
    db,
  );
  for (const [id, seed] of Object.entries(SEEDS)) {
    await sql`insert into capybara.devices (id, org_id, owner_kind, owner_account_id, source, outer_network)
      values (${id}, 'o1', 'personal', 'a1', ${seed.source},
        ${seed.outer === null ? null : JSON.stringify(seed.outer)}::jsonb)`.execute(db);
  }
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0165 device network columns", () => {
  it("copies an allowlist outer network with its hosts", async () => {
    expect(await rowOf("d_allow")).toEqual({
      network_mode: "allowlist",
      network_hosts: ["github.com", "*.npmjs.org"],
    });
    // an empty allowlist ran with the network closed
    expect(await rowOf("d_empty")).toEqual({ network_mode: "none", network_hosts: [] });
  });

  it("an allowlist whose hosts are unreadable becomes a closed network (never wider)", async () => {
    expect(await rowOf("d_badhosts")).toEqual({ network_mode: "none", network_hosts: [] });
    expect(await rowOf("d_mixedhosts")).toEqual({ network_mode: "none", network_hosts: [] });
  });

  it("an open, missing or local snapshot follows the org", async () => {
    for (const id of ["d_open", "d_none", "d_local"])
      expect(await rowOf(id)).toEqual({ network_mode: null, network_hosts: [] });
  });

  it("refuses an unknown mode or a non-array host list", async () => {
    await expect(
      sql`update capybara.devices set network_mode = 'wide' where id = 'd_none'`.execute(db),
    ).rejects.toThrow();
    await expect(
      sql`update capybara.devices set network_hosts = '"x"'::jsonb where id = 'd_none'`.execute(db),
    ).rejects.toThrow();
  });

  it("is idempotent and never overwrites a later choice", async () => {
    await sql`update capybara.devices set network_mode = 'open' where id = 'd_allow'`.execute(db);
    const before = await Promise.all(Object.keys(SEEDS).map(rowOf));
    await runFile();
    expect(await Promise.all(Object.keys(SEEDS).map(rowOf))).toEqual(before);
    expect((await rowOf("d_allow"))?.network_mode).toBe("open");
  });
});
