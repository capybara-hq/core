import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Global, Inject, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SchedulerRegistry } from "@nestjs/schedule";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { createDb } from "../../src/db/pool.js";
import { ConfigModule } from "../../src/infra/config/config.module.js";
import { currentStore, TransactionHost } from "../../src/infra/database/transaction-host.js";
import { LockModule } from "../../src/infra/lock/lock.module.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { LoggingModule } from "../../src/infra/logging/logging.module.js";
import { RedisModule } from "../../src/infra/redis/redis.module.js";
import { LockedCron } from "../../src/infra/schedule/locked-cron.decorator.js";
import { KernelScheduleModule } from "../../src/infra/schedule/schedule.module.js";
import { KERNEL_LOGGER, KERNEL_POOL } from "../../src/infra/tokens.js";
import { createLogger, type KernelLogger } from "../../src/log.js";

let rd: TestContainer;
let pgc: TestContainer;
// biome-ignore lint/suspicious/noExplicitAny: the pool has no schema types
let pool: Kysely<any>;
beforeAll(async () => {
  [rd, pgc] = await Promise.all([startTestRedis(), startTestPostgres()]);
  pool = createDb(pgc.url, 5);
}, 120_000);
afterAll(async () => {
  await pool?.destroy();
  await Promise.all([rd?.stop(), pgc?.stop()]);
}, 120_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** State shared by every app instance of a test, so overlap across "replicas" is measured. */
const shared = {
  active: 0,
  maxActive: 0,
  runs: 0,
  tx: [] as boolean[],
  mode: "ok" as "ok" | "throw",
};

@Injectable()
class Jobs {
  constructor(
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  /** Fires every second on every instance. */
  @LockedCron("* * * * * *", { name: "test-every-second", lockKey: "test-cron-tick", ttl: 5000 })
  async tick() {
    await this.body(300);
  }

  /** Never fires by schedule within the test; called by hand. */
  @LockedCron("0 0 1 1 *", { name: "test-manual", lockKey: "test-cron-manual", ttl: 5000 })
  async manual() {
    if (shared.mode === "throw") throw new Error("job exploded");
    await this.body(400);
  }

  private async body(ms: number) {
    shared.runs++;
    shared.tx.push(currentStore() !== undefined);
    shared.active++;
    shared.maxActive = Math.max(shared.maxActive, shared.active);
    await sleep(ms);
    shared.active--;
  }
}

async function boot(withTick: boolean) {
  const config = resolveConfig(
    {
      db: { url: pgc.url },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 1).toString("base64"),
    },
    {},
  );
  const logger = createLogger("error") as KernelLogger;
  const info = vi.spyOn(logger, "info");
  const error = vi.spyOn(logger, "error");
  @Global()
  @Module({
    providers: [{ provide: KERNEL_POOL, useValue: pool }, TransactionHost],
    exports: [KERNEL_POOL, TransactionHost],
  })
  class TxModule {}
  @Module({ providers: [Jobs], exports: [Jobs] })
  class JobsModule {}
  class Root {}
  const app = await NestFactory.createApplicationContext(
    {
      module: Root,
      imports: [
        LoggingModule.forRoot(config, { logger }),
        ConfigModule.forRoot(config),
        RedisModule,
        LockModule,
        TxModule,
        KernelScheduleModule,
        JobsModule,
      ],
    },
    { logger: false, abortOnError: false },
  );
  await app.init();
  if (!withTick) app.get(SchedulerRegistry).deleteCronJob("test-every-second");
  return { app, jobs: app.get(Jobs), info, error, logger };
}

describe("@LockedCron", () => {
  it("registers the cron job under its name", async () => {
    const { app } = await boot(true);
    try {
      expect(app.get(SchedulerRegistry).getCronJob("test-every-second")).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("two instances calling at once: one runs, the other logs INFO and skips", async () => {
    Object.assign(shared, { active: 0, maxActive: 0, runs: 0, tx: [], mode: "ok" });
    const a = await boot(false);
    const b = await boot(false);
    try {
      await Promise.all([a.jobs.manual(), b.jobs.manual()]);
      expect(shared.runs).toBe(1);
      const skipped = [a, b].filter((x) =>
        x.info.mock.calls.some((c) => String(c[0]).includes("cron skipped")),
      );
      expect(skipped).toHaveLength(1);
      expect(a.error).not.toHaveBeenCalled();
      expect(b.error).not.toHaveBeenCalled();
      // the lock is released after the run
      await a.jobs.manual();
      expect(shared.runs).toBe(2);
    } finally {
      await a.app.close();
      await b.app.close();
    }
  });

  it("the real scheduler on two instances never overlaps runs, and runs at least once", async () => {
    Object.assign(shared, { active: 0, maxActive: 0, runs: 0, tx: [], mode: "ok" });
    const a = await boot(true);
    const b = await boot(true);
    try {
      await vi.waitFor(() => expect(shared.runs).toBeGreaterThanOrEqual(2), { timeout: 8000 });
      expect(shared.maxActive).toBe(1);
      // each tick has one winner: runs never exceed the number of elapsed seconds plus one
      expect(a.error).not.toHaveBeenCalled();
      expect(b.error).not.toHaveBeenCalled();
    } finally {
      await a.app.close();
      await b.app.close();
    }
    // closing the apps stops the scheduler: no further runs
    const after = shared.runs;
    await sleep(1300);
    expect(shared.runs).toBe(after);
  });

  it("an error in the job is logged, not thrown, and the lock is released", async () => {
    Object.assign(shared, { active: 0, maxActive: 0, runs: 0, tx: [], mode: "throw" });
    const a = await boot(false);
    try {
      await expect(a.jobs.manual()).resolves.toBeUndefined();
      expect(a.error).toHaveBeenCalledWith(
        "cron job failed",
        expect.objectContaining({ cron: "test-manual" }),
      );
      shared.mode = "ok";
      await a.jobs.manual(); // would be skipped if the lock leaked
      expect(shared.runs).toBe(1);
    } finally {
      await a.app.close();
    }
  });

  it("a transaction open where the job is invoked is not visible inside it", async () => {
    Object.assign(shared, { active: 0, maxActive: 0, runs: 0, tx: [], mode: "ok" });
    const a = await boot(false);
    try {
      await a.app.get(TransactionHost).run(async () => {
        expect(currentStore()).toBeDefined();
        await a.jobs.manual();
      });
      expect(shared.tx).toEqual([false]);
    } finally {
      await a.app.close();
    }
  });

  it("fails loudly without lockService / log", async () => {
    class Bad {
      @LockedCron("0 0 1 1 *", { name: "bad-cron" })
      async m() {}
    }
    await expect(new Bad().m()).rejects.toThrow(/lockService/);
  });
});
