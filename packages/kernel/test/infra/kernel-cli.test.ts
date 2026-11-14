import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import type { Queue } from "bullmq";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsModule, AccountsService } from "../../src/identity/accounts.js";
import { KERNEL_MIGRATIONS_DIR, KERNEL_SCHEMA, migrate } from "../../src/index.js";
import { openKernelCli, openKernelCliOverPool } from "../../src/infra/cli/kernel-cli.module.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { QueueModule } from "../../src/infra/queue/queue.module.js";
import { KERNEL_BUS, KERNEL_POOL, REDIS } from "../../src/infra/tokens.js";
import { createLogger } from "../../src/log.js";

const quiet = createLogger("error", { write: () => {} });

let pgc: TestContainer;
beforeAll(async () => {
  pgc = await startTestPostgres();
  await migrate(pgc.url, { schema: KERNEL_SCHEMA, dir: KERNEL_MIGRATIONS_DIR });
});
afterAll(async () => {
  await pgc?.stop();
});

const configOf = () =>
  resolveConfig(
    {
      db: { url: pgc.url },
      // unreachable: a context without Redis never connects, and one with it connects lazily
      redis: { url: "redis://127.0.0.1:1" },
      masterKey: Buffer.alloc(32, 1).toString("base64"),
    },
    {},
  );

describe("openKernelCli", () => {
  it("redis: false leaves Redis, the bus and LockService out; AccountsModule needs none of them", async () => {
    const app = await openKernelCli(configOf(), {
      logger: quiet,
      modules: [AccountsModule],
      redis: false,
    });
    try {
      for (const token of [REDIS, KERNEL_BUS, LockService]) {
        expect(() => app.get(token), String(token)).toThrow();
      }
      expect(await app.get(AccountsService).countSuperAdmins()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("by default has the CLI's Redis and LockService (lazy: nothing connects)", async () => {
    const app = await openKernelCli(configOf(), { logger: quiet, modules: [] });
    try {
      expect(app.get(REDIS)).toBeDefined();
      expect(app.get(LockService)).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("closes the pool it opened", async () => {
    const app = await openKernelCli(configOf(), { logger: quiet, modules: [], redis: false });
    const pool = app.get(KERNEL_POOL);
    await sql`select 1`.execute(pool);
    await app.close();
    await expect(sql`select 1`.execute(pool)).rejects.toThrow();
  });
});

describe("openKernelCli queues", () => {
  it("a queue a command's module registers uses the configured Redis, not BullMQ's default", async () => {
    @Module({ imports: [QueueModule.registerQueue("cli-probe")] })
    class ProbeModule {}
    const rd = await startTestRedis();
    const app = await openKernelCli(
      resolveConfig(
        {
          db: { url: pgc.url },
          redis: { url: rd.url },
          masterKey: Buffer.alloc(32, 1).toString("base64"),
        },
        {},
      ),
      { logger: quiet, modules: [ProbeModule] },
    );
    try {
      const queue = app.get<Queue>(getQueueToken("cli-probe"));
      const want = new URL(rd.url);
      expect(queue.opts.connection).toMatchObject({
        host: want.hostname,
        port: Number(want.port),
      });
      await queue.add("probe", {});
      expect(await queue.count()).toBe(1);
    } finally {
      await app.close();
      await rd.stop();
    }
  });
});

describe("openKernelCliOverPool", () => {
  it("runs the given modules over the caller's pool and leaves it open when closed", async () => {
    const pool = createDb(pgc.url, 2);
    try {
      const app = await openKernelCliOverPool(pool, { logger: quiet, modules: [AccountsModule] });
      expect(app.get(KERNEL_POOL)).toBe(pool);
      const account = await app.get(AccountsService).createLocal({
        login: "over-pool",
        password: "correct horse battery",
        displayName: "Over Pool",
      });
      await app.close();
      const r = await sql<{
        id: string;
      }>`select id from capybara.accounts where id = ${account.id}`.execute(pool);
      expect(r.rows[0]?.id).toBe(account.id);
    } finally {
      await pool.destroy();
    }
  });
});
