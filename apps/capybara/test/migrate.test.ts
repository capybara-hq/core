import { createLogger } from "@capybara-hq/kernel";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { queryServerVersion, runMigrate } from "../src/commands/migrate.js";

let pg: TestContainer;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 120_000);
afterAll(async () => {
  await pg?.stop();
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

describe("capybara migrate: PostgreSQL version check", () => {
  it("refuses PostgreSQL older than 15 before running any migration", async () => {
    const { log, lines } = captureLog();
    const serverVersion = vi.fn(async () => ({ num: 140_013, text: "14.13" }));
    const code = await runMigrate(log, testEnv(pg.url), { serverVersion });
    expect(code).toBe(1);
    expect(serverVersion).toHaveBeenCalledOnce();
    const out = lines.join("\n");
    expect(out).toContain("PostgreSQL 15 or newer is required (found 14.13)");
    // Nothing was migrated: the kernel schema does not exist.
    expect(out).not.toContain("migrations applied");
  });

  it("migrates on PostgreSQL 15 or newer", async () => {
    const { log, lines } = captureLog();
    const serverVersion = vi.fn(async () => ({ num: 150_000, text: "15.0" }));
    const code = await runMigrate(log, testEnv(pg.url), { serverVersion });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("migrate finished");
  });

  it("reads the real server version", async () => {
    const v = await queryServerVersion(pg.url, 5000);
    expect(v.num).toBeGreaterThanOrEqual(150_000);
    expect(v.text).toMatch(/^\d+/);
  });
});
