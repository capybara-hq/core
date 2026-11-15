import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { parseOrgSettings } from "../../src/orgs/settings.service.js";

/**
 * 0134_org_cloud_network_delta.sql: an org's stored cloudNetwork list (`allowHosts`) becomes
 * `base: none` with the list as its extras (kept exactly, never wider); anything that is not an
 * object with an array list is left alone. Migrates to the migration before it, seeds old-shape
 * values, then runs 0134 (and again by hand: idempotent).
 */
const FILE = "0134_org_cloud_network_delta.sql";

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

const settingsOf = async (id: string) =>
  (
    await sql<{ settings: Record<string, unknown> }>`select settings from capybara.orgs
      where id = ${id}`.execute(db)
  ).rows[0]?.settings;

const SEEDS: Record<string, unknown> = {
  o_list: {
    cloudNetwork: {
      mode: "allowlist",
      allowHosts: ["registry.npmjs.org", "pypi.org", "github.com"],
    },
    toolSearch: "off",
  },
  // duplicates or a non-string element: the old reader read these as the empty allowlist, so
  // converting them would widen them
  o_dupes: { cloudNetwork: { mode: "open", allowHosts: ["a.example.com", "a.example.com"] } },
  o_mixed: { cloudNetwork: { mode: "allowlist", allowHosts: ["a.example.com", 7] } },
  o_empty: { cloudNetwork: { mode: "allowlist", allowHosts: [] } },
  o_open: { cloudNetwork: { mode: "open", allowHosts: ["files.slack.com"] } },
  o_bad: { cloudNetwork: { mode: "allowlist", allowHosts: "github.com" } },
  o_scalar: { cloudNetwork: "allowlist" },
  o_nohosts: { cloudNetwork: { mode: "allowlist" } },
  o_plain: { toolSearch: "on" },
};

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  for (const [id, settings] of Object.entries(SEEDS)) {
    await sql`insert into capybara.orgs (id, slug, name, settings)
      values (${id}, ${id.replace("_", "-")}, ${id}, ${JSON.stringify(settings)}::jsonb)`.execute(
      db,
    );
  }
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0134 org cloud network delta", () => {
  it("a stored list becomes base none with its hosts as extras, in order", async () => {
    expect(await settingsOf("o_list")).toEqual({
      cloudNetwork: {
        mode: "allowlist",
        base: "none",
        extraHosts: ["registry.npmjs.org", "pypi.org", "github.com"],
      },
      toolSearch: "off",
    });
    // the new reader accepts it as it is
    expect(parseOrgSettings(await settingsOf("o_list")).cloudNetwork).toEqual({
      mode: "allowlist",
      base: "none",
      extraHosts: ["registry.npmjs.org", "pypi.org", "github.com"],
    });
  });

  it("an empty list (0130's egress none) becomes base none with no extras", async () => {
    expect(await settingsOf("o_empty")).toEqual({
      cloudNetwork: { mode: "allowlist", base: "none" },
    });
  });

  it("keeps the mode of an open network", async () => {
    expect(await settingsOf("o_open")).toEqual({
      cloudNetwork: { mode: "open", base: "none", extraHosts: ["files.slack.com"] },
    });
  });

  it("leaves anything else alone", async () => {
    for (const id of ["o_bad", "o_scalar", "o_nohosts", "o_plain", "o_dupes", "o_mixed"]) {
      expect(await settingsOf(id)).toEqual(SEEDS[id]);
    }
  });

  it("is idempotent", async () => {
    const before = await Promise.all(Object.keys(SEEDS).map(settingsOf));
    await runFile();
    expect(await Promise.all(Object.keys(SEEDS).map(settingsOf))).toEqual(before);
  });
});
