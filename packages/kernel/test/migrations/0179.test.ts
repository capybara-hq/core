import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { storedReport } from "../../src/sandbox/device-reports.js";

/**
 * 0179_device_report_limit_text.sql: a stored device report's string limit values become text
 * (`{ en }`), so reports written before `DeviceReportLimit.value` became `DeviceText` still pass.
 */
const FILE = "0179_device_report_limit_text.sql";

const SUPPORT = { outsideSandbox: false, network: { perOperationHosts: false } };

/** d1: string values written before; d2: already text; d3: no limits; d4: no report. */
const OLD = {
  revision: "r1",
  description: { en: "Local machine", zh: "本机" },
  home: "/home/a",
  limits: [
    { label: { en: "Projects", zh: "项目" }, value: "/a, +2 more" },
    { label: { en: "Network" }, value: { en: "github.com", zh: "github.com" } },
    { label: { en: "CPU" }, value: "2" },
  ],
  reset: false,
  support: SUPPORT,
};
const TEXT = {
  revision: "r2",
  description: { en: "Docker" },
  home: null,
  limits: [{ label: { en: "CPU" }, value: { en: "2 cores", zh: "2 核" } }],
  reset: true,
  support: null,
};
const EMPTY = { ...TEXT, revision: "r3", limits: [] };

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

const reportOf = async (id: string) =>
  (await sql<{ report: unknown }>`select report from capybara.devices where id = ${id}`.execute(db))
    .rows[0]?.report;

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name, created_by) values ('o1', 'o1', 'O', 'a1')`.execute(
    db,
  );
  const rows: [string, unknown][] = [
    ["d1", OLD],
    ["d2", TEXT],
    ["d3", EMPTY],
    ["d4", null],
  ];
  for (const [id, report] of rows) {
    await sql`insert into capybara.devices (id, org_id, owner_kind, owner_account_id, provider, report)
      values (${id}, 'o1', 'personal', 'a1', 'device-fake',
        ${report === null ? null : JSON.stringify(report)}::jsonb)`.execute(db);
  }
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0179 device report limit text", () => {
  it("turns string limit values into { en }, in order, keeping every other key", async () => {
    const after = await reportOf("d1");
    expect(after).toEqual({
      ...OLD,
      limits: [
        { label: { en: "Projects", zh: "项目" }, value: { en: "/a, +2 more" } },
        { label: { en: "Network" }, value: { en: "github.com", zh: "github.com" } },
        { label: { en: "CPU" }, value: { en: "2" } },
      ],
    });
    // the stored report passes the parser again (the device shows it and keeps its home)
    expect(storedReport(after)?.home).toBe("/home/a");
    expect(storedReport(OLD)).toBeNull();
  });

  it("leaves reports without string values and devices without a report alone", async () => {
    expect(await reportOf("d2")).toEqual(TEXT);
    expect(await reportOf("d3")).toEqual(EMPTY);
    expect(await reportOf("d4")).toBeNull();
  });

  it("0179 is idempotent", async () => {
    const before = await reportOf("d1");
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await sql.raw(`set search_path to capybara; ${text}`).execute(db);
    expect(await reportOf("d1")).toEqual(before);
  });
});
