import { createDb, createLogger } from "@capybara-hq/kernel";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryServerVersion, runMigrate } from "../src/commands/migrate.js";

// Every test gets its own fresh database, so none depends on what another one migrated.
const started: TestContainer[] = [];
async function freshPg(): Promise<TestContainer> {
  const pg = await startTestPostgres();
  started.push(pg);
  return pg;
}
afterEach(async () => {
  await Promise.all(started.splice(0).map((pg) => pg.stop()));
});

function testEnv(dbUrl: string): NodeJS.ProcessEnv {
  return {
    CAPYBARA_DB__URL: dbUrl,
    CAPYBARA_REDIS__URL: "redis://127.0.0.1:1",
    CAPYBARA_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
}

function captureLog() {
  const lines: string[] = [];
  const log = createLogger("info", { write: (line) => lines.push(line) });
  return { log, lines };
}

/** Whether the kernel schema exists in the database. */
async function kernelSchemaExists(url: string): Promise<boolean> {
  const db = createDb(url, 1);
  try {
    const row = await db
      .selectNoFrom((eb) => eb.fn<string | null>("to_regnamespace", [eb.val("capybara")]).as("ns"))
      .executeTakeFirstOrThrow();
    return row.ns !== null;
  } finally {
    await db.destroy();
  }
}

describe("capybara migrate: PostgreSQL version check", () => {
  it("refuses PostgreSQL older than 15 before running any migration", async () => {
    const pg = await freshPg();
    const { log, lines } = captureLog();
    const serverVersion = vi.fn(async () => ({ num: 140_013, text: "14.13" }));
    const code = await runMigrate(log, testEnv(pg.url), { serverVersion });
    expect(code).toBe(1);
    expect(serverVersion).toHaveBeenCalledOnce();
    expect(lines.join("\n")).toContain("PostgreSQL 15 or newer is required (found 14.13)");
    expect(await kernelSchemaExists(pg.url)).toBe(false);
  }, 120_000);

  it("migrates on PostgreSQL 15 or newer", async () => {
    const pg = await freshPg();
    const { log } = captureLog();
    const serverVersion = vi.fn(async () => ({ num: 150_000, text: "15.0" }));
    expect(await kernelSchemaExists(pg.url)).toBe(false);
    const code = await runMigrate(log, testEnv(pg.url), { serverVersion });
    expect(code).toBe(0);
    expect(await kernelSchemaExists(pg.url)).toBe(true);
  }, 120_000);

  it("reads the real server version", async () => {
    const pg = await freshPg();
    const v = await queryServerVersion(pg.url, 5000);
    expect(v.num).toBeGreaterThanOrEqual(150_000);
    expect(v.text).toMatch(/^\d+/);
  }, 120_000);
});
