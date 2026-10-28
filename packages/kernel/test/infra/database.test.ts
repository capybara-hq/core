import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { NestFactory } from "@nestjs/core";
import { type Kysely, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { ConfigModule } from "../../src/infra/config/config.module.js";
import { DatabaseModule } from "../../src/infra/database/database.module.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { LoggingModule } from "../../src/infra/logging/logging.module.js";
import { KERNEL_LOGGER, KERNEL_POOL } from "../../src/infra/tokens.js";
import { createLogger } from "../../src/log.js";

let pgc: TestContainer;
beforeAll(async () => {
  pgc = await startTestPostgres();
}, 120_000);
afterAll(async () => {
  await pgc?.stop();
}, 120_000);

describe("DatabaseModule", () => {
  it("provides the pool, TransactionHost and KernelDb, and closes the pool on shutdown", async () => {
    const config = resolveConfig(
      {
        db: { url: pgc.url },
        redis: { url: "redis://127.0.0.1:1" },
        masterKey: Buffer.alloc(32, 1).toString("base64"),
      },
      {},
    );
    class Root {}
    const app = await NestFactory.createApplicationContext(
      {
        module: Root,
        imports: [
          LoggingModule.forRoot(config, { logger: createLogger("error") }),
          ConfigModule.forRoot(config),
          DatabaseModule,
        ],
      },
      { logger: false },
    );
    const kdb = app.get(KernelDb);
    expect(app.get(KERNEL_LOGGER)).toBeDefined();
    expect(app.get(TransactionHost)).toBeDefined();
    const r = await sql<{ n: number }>`select 1 as n`.execute(kdb.pool);
    expect(r.rows[0]?.n).toBe(1);
    // the proxied query builders resolve against the kernel schema
    expect(kdb.selectFrom("agents").selectAll().compile().sql).toContain('"capybara"."agents"');
    const pool = app.get(KERNEL_POOL);
    await app.close();
    await expect(sql`select 1`.execute(pool)).rejects.toThrow();
  });
});

describe("DatabaseModule client errors", () => {
  it("a backend killed while its client is checked out is a warn log, not an uncaught error", async () => {
    const config = resolveConfig(
      {
        db: { url: pgc.url, poolMax: 2 },
        redis: { url: "redis://127.0.0.1:1" },
        masterKey: Buffer.alloc(32, 1).toString("base64"),
      },
      {},
    );
    const lines: string[] = [];
    const log = createLogger("warn", { write: (l: string) => void lines.push(l) });
    class Root {}
    const app = await NestFactory.createApplicationContext(
      {
        module: Root,
        imports: [
          LoggingModule.forRoot(config, { logger: log }),
          ConfigModule.forRoot(config),
          DatabaseModule,
        ],
      },
      { logger: false },
    );
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => void uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
      const pool: Kysely<any> = app.get(KERNEL_POOL);
      const killer = new pg.Client({ connectionString: pgc.url });
      await killer.connect();
      try {
        // hold a connection checked out, idle between statements, and kill its backend
        await pool.connection().execute(async (conn) => {
          const mine = await conn.executeQuery<{ pid: number }>(
            sql<{ pid: number }>`select pg_backend_pid() as pid`.compile(pool),
          );
          await killer.query("select pg_terminate_backend($1)", [mine.rows[0]?.pid]);
          await new Promise((r) => setTimeout(r, 500));
        });
      } finally {
        await killer.end();
      }
      expect(uncaught).toEqual([]);
      expect(lines.join("\n")).toContain("pg client error");
    } finally {
      process.off("uncaughtException", onUncaught);
      await app.close();
    }
  });
});
