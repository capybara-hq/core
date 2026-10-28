import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import type { INestApplicationContext } from "@nestjs/common";
import { Global, Inject, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SchedulerRegistry } from "@nestjs/schedule";
import type { Redis } from "ioredis";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { createDb } from "../../src/db/pool.js";
import { ConfigModule } from "../../src/infra/config/config.module.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { currentStore, TransactionHost } from "../../src/infra/database/transaction-host.js";
import { LockModule } from "../../src/infra/lock/lock.module.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { LoggingModule } from "../../src/infra/logging/logging.module.js";
import { RedisModule } from "../../src/infra/redis/redis.module.js";
import { scheduledTick } from "../../src/infra/schedule/cron-tick.js";
import { LockedCron } from "../../src/infra/schedule/locked-cron.decorator.js";
import {
  intervalTick,
  LockedInterval,
  LockedIntervalScheduler,
} from "../../src/infra/schedule/locked-interval.js";
import { KernelScheduleModule } from "../../src/infra/schedule/schedule.module.js";
import { KERNEL_LOGGER, KERNEL_POOL, REDIS } from "../../src/infra/tokens.js";
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

const redisOf = (r: { app: INestApplicationContext }) => r.app.get<Redis>(REDIS);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** State shared by every app instance of a test, so overlap across "replicas" is measured. */
const shared = {
  active: 0,
  inflight: 0,
  maxActive: 0,
  runs: 0,
  tx: [] as boolean[],
  perSecond: new Map<number, number>(),
};

/**
 * Outermost decorator of a job: counts the whole decorated call (tick marker, lock, body), so a
 * replica still before its tick marker counts as in flight. Copies the scheduler metadata over.
 */
function counted(_t: object, _k: string | symbol, d: PropertyDescriptor) {
  const inner = d.value as (...a: unknown[]) => Promise<unknown>;
  const wrapped = async function (this: unknown, ...a: unknown[]) {
    shared.inflight++;
    try {
      return await inner.apply(this, a);
    } finally {
      shared.inflight--;
    }
  };
  for (const k of Reflect.getMetadataKeys(inner))
    Reflect.defineMetadata(k, Reflect.getMetadata(k, inner), wrapped);
  d.value = wrapped;
}

@Injectable()
class Jobs {
  constructor(
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
    @Inject(KernelConfigService) readonly config: KernelConfigService,
  ) {}

  /** Interval job whose period comes from the config (`hooks.timeoutMs`, 1000 in these tests). */
  @counted
  @LockedInterval("test-interval", (c) => c.hooks.timeoutMs, {
    lockKey: "test-interval-lock",
    ttl: 5000,
  })
  async interval() {
    const sec = Math.floor(Date.now() / 1000);
    shared.perSecond.set(sec, (shared.perSecond.get(sec) ?? 0) + 1);
    shared.runs++;
  }

  /** Fast job, every second: runs per tick are counted. */
  @counted
  @LockedCron("* * * * * *", { name: "test-fast", lockKey: "test-cron-fast", ttl: 5000 })
  async fast() {
    const sec = Math.floor(Date.now() / 1000);
    shared.perSecond.set(sec, (shared.perSecond.get(sec) ?? 0) + 1);
    shared.runs++;
  }

  /** Slow job, every second: a run outlives the next tick. */
  @counted
  @LockedCron("* * * * * *", { name: "test-slow", lockKey: "test-cron-slow", ttl: 5000 })
  async slow() {
    await this.body(1500);
  }

  // Yearly jobs, never fired by schedule in a test; called by hand. One per test: the tick
  // marker is per job name, so a second call in the same tick is (correctly) skipped.
  @counted
  @LockedCron("0 0 1 1 *", { name: "test-m1", lockKey: "test-cron-m1", ttl: 5000 })
  async m1() {
    await this.body(400);
  }

  @counted
  @LockedCron("0 0 1 1 *", { name: "test-m2", lockKey: "test-cron-m2", ttl: 5000 })
  async m2() {
    throw new Error("job exploded");
  }

  @counted
  @LockedCron("0 0 1 1 *", { name: "test-m3", lockKey: "test-cron-m3", ttl: 5000 })
  async m3() {
    await this.body(0);
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

/** Boots one "replica"; only the cron jobs named in `keep` stay scheduled. */
async function boot(keep: string[] = []) {
  const config = resolveConfig(
    {
      db: { url: pgc.url },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 1).toString("base64"),
      hooks: { timeoutMs: 1000 },
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
  const reg = app.get(SchedulerRegistry);
  for (const name of [...reg.getCronJobs().keys()])
    if (!keep.includes(name)) reg.deleteCronJob(name);
  const intervals = app.get(LockedIntervalScheduler);
  for (const name of intervals.names()) if (!keep.includes(name)) intervals.stop(name);
  return { app, jobs: app.get(Jobs), info, error, logger, reg, intervals };
}

/** Stops the schedulers of the given replicas and waits until no decorated call is in flight, then closes them. */
async function shutDown(...replicas: Awaited<ReturnType<typeof boot>>[]) {
  for (const r of replicas) {
    for (const j of r.reg.getCronJobs().values()) void j.stop();
    for (const name of r.intervals.names()) r.intervals.stop(name);
  }
  await vi.waitFor(() => expect(shared.inflight).toBe(0), { timeout: 5000 });
  for (const r of replicas) await r.app.close();
}

describe("scheduledTick", () => {
  it("is the latest scheduled time at or before now, whatever the ms offset", () => {
    const t = Date.UTC(2026, 9, 29, 12, 0, 5);
    for (const off of [0, 3, 400, 900]) {
      expect(scheduledTick("* * * * * *", t + off)).toEqual({ tick: t, periodMs: 1000 });
    }
    // a callback that fires a hair early still belongs to the tick it was scheduled for
    expect(scheduledTick("* * * * * *", t - 2).tick).toBe(t);
    const daily = scheduledTick("0 0 3 * * *", Date.UTC(2026, 9, 29, 12, 0, 0), "UTC");
    expect(daily).toEqual({ tick: Date.UTC(2026, 9, 29, 3, 0, 0), periodMs: 86_400_000 });
  });
});

describe("@LockedCron", () => {
  it("registers the cron job under its name", async () => {
    const r = await boot(["test-fast"]);
    try {
      expect(r.reg.getCronJob("test-fast")).toBeDefined();
    } finally {
      await shutDown(r);
    }
  });

  it("two instances calling at once: one runs, the other logs INFO and skips", async () => {
    Object.assign(shared, {
      active: 0,
      inflight: 0,
      maxActive: 0,
      runs: 0,
      tx: [],
      perSecond: new Map(),
    });
    const a = await boot();
    const b = await boot();
    try {
      await Promise.all([a.jobs.m1(), b.jobs.m1()]);
      expect(shared.runs).toBe(1);
      const skipped = [a, b].filter((x) =>
        x.info.mock.calls.some((c) => String(c[0]).includes("cron skipped")),
      );
      expect(skipped).toHaveLength(1);
      expect(a.error).not.toHaveBeenCalled();
      expect(b.error).not.toHaveBeenCalled();
      // the run lock is released after the run; the tick marker stays for its tick
      expect(await redisOf(a).exists("lock:test-cron-m1")).toBe(0);
      expect(await redisOf(a).keys("cron:test-m1:*")).toHaveLength(1);
    } finally {
      await shutDown(a, b);
    }
  });

  it("two instances on the real scheduler run a fast job exactly once per tick", async () => {
    Object.assign(shared, {
      active: 0,
      inflight: 0,
      maxActive: 0,
      runs: 0,
      tx: [],
      perSecond: new Map(),
    });
    const a = await boot(["test-fast"]);
    const b = await boot(["test-fast"]);
    // Replica b's callback lands ~40 ms after a's (clock skew): a's fast job is long finished and
    // its run lock released by then, so only the per-tick marker keeps b from running the tick.
    const ls = b.jobs.lockService;
    const [lease, acquire] = [ls.lease.bind(ls), ls.acquire.bind(ls)];
    ls.lease = async (...args) => {
      await sleep(40);
      return lease(...args);
    };
    ls.acquire = async (...args) => {
      await sleep(40);
      return acquire(...args);
    };
    try {
      await vi.waitFor(() => expect(shared.perSecond.size).toBeGreaterThanOrEqual(4), {
        timeout: 10_000,
      });
    } finally {
      await shutDown(a, b);
    }
    expect([...shared.perSecond.values()].every((n) => n === 1)).toBe(true);
    expect(a.error).not.toHaveBeenCalled();
    expect(b.error).not.toHaveBeenCalled();
    // stopped schedulers fire no more
    const after = shared.runs;
    await sleep(1300);
    expect(shared.runs).toBe(after);
  }, 30_000);

  it("a run that outlives the next tick is never overlapped; the next tick logs INFO and skips", async () => {
    Object.assign(shared, {
      active: 0,
      inflight: 0,
      maxActive: 0,
      runs: 0,
      tx: [],
      perSecond: new Map(),
    });
    const a = await boot(["test-slow"]);
    const b = await boot(["test-slow"]);
    try {
      await vi.waitFor(
        () =>
          expect(
            [a, b].some((x) =>
              x.info.mock.calls.some((c) => String(c[0]).includes("previous run still holds")),
            ),
          ).toBe(true),
        { timeout: 10_000 },
      );
    } finally {
      await shutDown(a, b);
    }
    expect(shared.maxActive).toBe(1);
    expect(a.error).not.toHaveBeenCalled();
    expect(b.error).not.toHaveBeenCalled();
  });

  it("an error in the job is logged, not thrown, and the run lock is released", async () => {
    Object.assign(shared, {
      active: 0,
      inflight: 0,
      maxActive: 0,
      runs: 0,
      tx: [],
      perSecond: new Map(),
    });
    const a = await boot();
    try {
      await expect(a.jobs.m2()).resolves.toBeUndefined();
      expect(a.error).toHaveBeenCalledWith(
        "cron job failed",
        expect.objectContaining({ cron: "test-m2" }),
      );
      expect(await redisOf(a).exists("lock:test-cron-m2")).toBe(0);
    } finally {
      await shutDown(a);
    }
  });

  it("a transaction open where the job is invoked is not visible inside it", async () => {
    Object.assign(shared, {
      active: 0,
      inflight: 0,
      maxActive: 0,
      runs: 0,
      tx: [],
      perSecond: new Map(),
    });
    const a = await boot();
    try {
      await a.app.get(TransactionHost).run(async () => {
        expect(currentStore()).toBeDefined();
        await a.jobs.m3();
      });
      expect(shared.tx).toEqual([false]);
    } finally {
      await shutDown(a);
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

describe("@LockedInterval", () => {
  it("intervalTick is the latest multiple of the period at or before now (early fires included)", () => {
    expect(intervalTick(60_000, 120_000)).toEqual({ tick: 120_000, periodMs: 60_000 });
    expect(intervalTick(60_000, 179_900)).toEqual({ tick: 120_000, periodMs: 60_000 });
    expect(intervalTick(60_000, 179_980).tick).toBe(180_000);
    expect(intervalTick(2_000, 4_001).tick).toBe(4_000);
  });

  it("is scheduled under its name with the period from the config", async () => {
    const r = await boot(["test-interval"]);
    try {
      expect(r.intervals.names()).toEqual(["test-interval"]);
    } finally {
      await shutDown(r);
    }
  });

  it("two instances on the real timers run the job exactly once per tick", async () => {
    Object.assign(shared, {
      active: 0,
      inflight: 0,
      maxActive: 0,
      runs: 0,
      tx: [],
      perSecond: new Map(),
    });
    const a = await boot(["test-interval"]);
    const b = await boot(["test-interval"]);
    // b lands ~40 ms after a: only the per-tick marker keeps it from running the tick again
    const ls = b.jobs.lockService;
    const [lease, acquire] = [ls.lease.bind(ls), ls.acquire.bind(ls)];
    ls.lease = async (...args) => {
      await sleep(40);
      return lease(...args);
    };
    ls.acquire = async (...args) => {
      await sleep(40);
      return acquire(...args);
    };
    try {
      await vi.waitFor(() => expect(shared.perSecond.size).toBeGreaterThanOrEqual(4), {
        timeout: 10_000,
      });
    } finally {
      await shutDown(a, b);
    }
    expect([...shared.perSecond.values()].every((n) => n === 1)).toBe(true);
    expect(
      [a, b].some((x) =>
        x.info.mock.calls.some((c) => String(c[0]).includes("tick already taken")),
      ),
    ).toBe(true);
    expect(a.error).not.toHaveBeenCalled();
    expect(b.error).not.toHaveBeenCalled();
    const after = shared.runs;
    await sleep(1300);
    expect(shared.runs).toBe(after);
  }, 30_000);

  it("fails loudly without lockService / log / config", async () => {
    class Bad {
      @LockedInterval("bad-interval", () => 1000)
      async m() {}
    }
    await expect(new Bad().m()).rejects.toThrow(/lockService/);
    class NoConfig {
      readonly lockService = { lease: async () => true } as unknown as LockService;
      readonly log = createLogger("error") as KernelLogger;
      @LockedInterval("bad-interval-2", () => 1000)
      async m() {}
    }
    const bad = new NoConfig();
    const spy = vi.spyOn(bad.log, "error");
    await bad.m();
    expect(spy).toHaveBeenCalledWith("cron tick marker failed", expect.anything());
    const fields = spy.mock.calls[0]?.[1] as { err: Error } | undefined;
    expect(fields?.err.message).toMatch(/config/);
  });
});
