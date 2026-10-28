import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { NestFactory } from "@nestjs/core";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { ConfigModule } from "../../src/infra/config/config.module.js";
import { LoggingModule } from "../../src/infra/logging/logging.module.js";
import { RedisModule } from "../../src/infra/redis/redis.module.js";
import { KERNEL_BUS, REDIS, REDIS_SUBSCRIBER } from "../../src/infra/tokens.js";
import { createLogger } from "../../src/log.js";

let rd: TestContainer;
beforeAll(async () => {
  rd = await startTestRedis();
}, 120_000);
afterAll(async () => {
  await rd?.stop();
}, 120_000);

describe("RedisModule", () => {
  it("provides REDIS, REDIS_SUBSCRIBER and KERNEL_BUS; the bus delivers; shutdown closes both", async () => {
    const config = resolveConfig(
      {
        db: { url: "postgres://x/y" },
        redis: { url: rd.url },
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
          RedisModule,
        ],
      },
      { logger: false },
    );
    const redis = app.get<Redis>(REDIS);
    expect(app.get(REDIS_SUBSCRIBER)).toBeDefined();
    const bus = app.get(KERNEL_BUS);
    const got = new Promise<unknown>((resolve) => {
      void bus.subscribe("t", resolve);
    });
    await new Promise((r) => setTimeout(r, 200));
    await bus.publish("t", { a: 1 });
    expect(await got).toEqual({ a: 1 });
    await app.close();
    await vi.waitFor(() => expect(["end", "close"]).toContain(redis.status));
  });
});
