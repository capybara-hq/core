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
 * 0167_device_network_backfill.sql: the device sandbox stops reading a cloud device's B1 snapshot
 * network, so 0165's copy runs again for devices snapshotted after 0165 (still following their
 * org, `network_mode` NULL): an allowlist snapshot becomes the device's own allowlist, never
 * wider; a device that chose since keeps its choice.
 */
const FILE = "0167_device_network_backfill.sql";

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

/** Seeds written after 0165 ran: the snapshot and the device's own choice (null: follows). */
const SEEDS: Record<string, { source: "cloud" | "local"; outer: unknown; mode: string | null }> = {
  d_allow: {
    source: "cloud",
    outer: { kind: "allowlist", hosts: ["github.com"] },
    mode: null,
  },
  d_bad: { source: "cloud", outer: { kind: "allowlist", hosts: [1] }, mode: null },
  d_open: { source: "cloud", outer: { kind: "open-public", hosts: [] }, mode: null },
  d_chose: { source: "cloud", outer: { kind: "allowlist", hosts: ["a.test"] }, mode: "open" },
  d_local: { source: "local", outer: { kind: "allowlist", hosts: ["a.test"] }, mode: null },
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
    await sql`insert into capybara.devices (id, org_id, owner_kind, owner_account_id, source, outer_network, network_mode)
      values (${id}, 'o1', 'personal', 'a1', ${seed.source}, ${JSON.stringify(seed.outer)}::jsonb,
        ${seed.mode})`.execute(db);
  }
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0167 device network backfill", () => {
  it("copies an allowlist snapshot taken after 0165, never wider", async () => {
    expect(await rowOf("d_allow")).toEqual({
      network_mode: "allowlist",
      network_hosts: ["github.com"],
    });
    expect(await rowOf("d_bad")).toEqual({ network_mode: "none", network_hosts: [] });
  });

  it("an open snapshot, a later choice and a local device are left alone", async () => {
    expect(await rowOf("d_open")).toEqual({ network_mode: null, network_hosts: [] });
    expect(await rowOf("d_chose")).toEqual({ network_mode: "open", network_hosts: [] });
    expect(await rowOf("d_local")).toEqual({ network_mode: null, network_hosts: [] });
  });

  it("is idempotent", async () => {
    const before = await Promise.all(Object.keys(SEEDS).map(rowOf));
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await sql.raw(`set search_path to capybara; ${text}`).execute(db);
    expect(await Promise.all(Object.keys(SEEDS).map(rowOf))).toEqual(before);
  });
});
