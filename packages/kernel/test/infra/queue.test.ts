import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Global, Inject, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { type Job, type Queue, UnrecoverableError } from "bullmq";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { ConfigModule } from "../../src/infra/config/config.module.js";
import { currentStore, TransactionHost } from "../../src/infra/database/transaction-host.js";
import { LoggingModule } from "../../src/infra/logging/logging.module.js";
import { logJobFailure } from "../../src/infra/queue/job-failure.js";
import { QUEUE_JOB_DEFAULTS, QueueModule } from "../../src/infra/queue/queue.module.js";
import { bullConnectionOptions } from "../../src/infra/queue/redis-connection.js";
import { runJob } from "../../src/infra/queue/run-job.js";
import { RedisModule } from "../../src/infra/redis/redis.module.js";
import { KERNEL_POOL } from "../../src/infra/tokens.js";
import { createLogger, type KernelLogger } from "../../src/log.js";
import { type LogContext, logContext } from "../../src/log-context.js";

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

const QUEUE = "cap-test-consume";

interface Seen {
  data: unknown;
  inTransaction: boolean;
  ctx: LogContext | undefined;
  attempts: number | undefined;
}
const seen: Seen[] = [];

@Processor(QUEUE)
class TestProcessor extends WorkerHost {
  process(job: Job): Promise<void> {
    return runJob(QUEUE, job, async () => {
      seen.push({
        data: job.data,
        inTransaction: currentStore() !== undefined,
        ctx: logContext(),
        attempts: job.opts.attempts,
      });
    });
  }
}

@Injectable()
class Producer {
  constructor(
    @InjectQueue(QUEUE) readonly queue: Queue,
    @Inject(TransactionHost) readonly host: TransactionHost,
  ) {}
}

/** A feature module owning a queue: registerQueue + a processor. */
@Module({
  imports: [QueueModule.registerQueue(QUEUE)],
  providers: [TestProcessor, Producer],
  exports: [Producer, TestProcessor],
})
class FeatureModule {}

async function boot() {
  const config = resolveConfig(
    {
      db: { url: pgc.url },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 1).toString("base64"),
    },
    {},
  );
  class Root {}
  @Global()
  @Module({
    providers: [{ provide: KERNEL_POOL, useValue: pool }, TransactionHost],
    exports: [KERNEL_POOL, TransactionHost],
  })
  class TxModule {}
  return NestFactory.createApplicationContext(
    {
      module: Root,
      imports: [
        LoggingModule.forRoot(config, { logger: createLogger("error") }),
        ConfigModule.forRoot(config),
        RedisModule,
        QueueModule.forRoot(),
        TxModule,
        FeatureModule,
      ],
    },
    { logger: false, abortOnError: false },
  );
}

describe("QueueModule", () => {
  it("a processor of a feature module consumes jobs, with the kernel defaults and a job log context", async () => {
    const app = await boot();
    try {
      const { queue } = app.get(Producer);
      await queue.add("work", { runId: "r1", n: 1 });
      await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
      const s = seen[0] as Seen;
      expect(s.data).toEqual({ runId: "r1", n: 1 });
      expect(s.attempts).toBe(QUEUE_JOB_DEFAULTS.attempts);
      expect(s.ctx).toMatchObject({ queue: QUEUE, runId: "r1" });
      expect(s.ctx?.jobId).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("a transaction open at enqueue time is not visible inside the processor", async () => {
    seen.length = 0;
    const app = await boot();
    try {
      const { queue, host } = app.get(Producer);
      await host.run(async () => {
        expect(currentStore()).toBeDefined();
        await queue.add("in-tx", { n: 2 });
        await vi.waitFor(
          () => expect(seen.some((s) => (s.data as { n: number }).n === 2)).toBe(true),
          {
            timeout: 5000,
          },
        );
      });
      expect(seen.find((s) => (s.data as { n: number }).n === 2)?.inTransaction).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("runJob started from inside a transaction (in-process call) starts a fresh context", async () => {
    seen.length = 0;
    const app = await boot();
    try {
      const { host } = app.get(Producer);
      const processor = app.get(TestProcessor);
      await host.run(async () => {
        await processor.process({ id: "direct", data: { n: 3 }, opts: {} } as unknown as Job);
        expect(currentStore()).toBeDefined(); // the caller's transaction is untouched
      });
      expect(seen[0]?.inTransaction).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("registerQueue refuses a name containing a colon", () => {
    expect(() => QueueModule.registerQueue("bad:name")).toThrow(/must not contain/);
  });
});

describe("bullConnectionOptions", () => {
  it("parses host, port, credentials and db, and sets maxRetriesPerRequest null", () => {
    expect(bullConnectionOptions("redis://u:p%40ss@cache.local:6380/2")).toEqual({
      host: "cache.local",
      port: 6380,
      username: "u",
      password: "p@ss",
      db: 2,
      maxRetriesPerRequest: null,
    });
    expect(bullConnectionOptions("rediss://h")).toMatchObject({ host: "h", port: 6379, tls: {} });
  });
});

describe("logJobFailure", () => {
  const mk = (attemptsMade: number, attempts = 3) =>
    ({ queueName: "q", id: "7", attemptsMade, opts: { attempts } }) as unknown as Job;
  function logger() {
    const log = createLogger("error") as KernelLogger;
    return { log, warn: vi.spyOn(log, "warn"), error: vi.spyOn(log, "error") };
  }

  it("warns while retries remain and errors on the final attempt", () => {
    const l = logger();
    logJobFailure(l.log, mk(1), new Error("x"));
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(l.error).not.toHaveBeenCalled();
    logJobFailure(l.log, mk(3), new Error("x"));
    expect(l.error).toHaveBeenCalledTimes(1);
  });

  it("final overrides the attempt count (UnrecoverableError)", () => {
    const l = logger();
    logJobFailure(l.log, mk(1), new UnrecoverableError("no"), { final: true });
    expect(l.error).toHaveBeenCalledTimes(1);
  });

  it("skips business errors", () => {
    const l = logger();
    logJobFailure(l.log, mk(3), new ApiError("validation_failed", "bad", []));
    expect(l.warn).not.toHaveBeenCalled();
    expect(l.error).not.toHaveBeenCalled();
  });
});
