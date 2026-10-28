import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { Redis } from "ioredis";
import { type BusSubscriber, createBus, createBusSubscriber } from "../../ctx/bus.js";
import type { KernelLogger } from "../../log.js";
import { closeWithin } from "../close-within.js";
import { KernelConfigService } from "../config/kernel-config.service.js";
import { KERNEL_BUS, KERNEL_LOGGER, REDIS, REDIS_SUBSCRIBER } from "../tokens.js";

/**
 * Closes the bus subscriber, then the main connection, at shutdown. A ready main connection is
 * closed with QUIT, so commands still in flight (a lock release, an after-commit publish) complete;
 * it is dropped when QUIT does not finish in time or the connection is not ready.
 */
@Injectable()
export class RedisLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(REDIS_SUBSCRIBER)
    private readonly subscriber: BusSubscriber & { close(): Promise<void> },
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await closeWithin("bus", this.subscriber.close(), this.log);
    if (
      this.redis.status === "ready" &&
      (await closeWithin("redis", this.redis.quit(), this.log))
    ) {
      return;
    }
    this.redis.disconnect();
  }
}

/** Global: the main Redis connection, the bus subscriber connection and the kernel bus. */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [KernelConfigService, KERNEL_LOGGER],
      useFactory: (config: KernelConfigService, log: KernelLogger) => {
        const redis = new Redis(config.get().redis.url, { lazyConnect: true });
        redis.on("error", (err: Error) => log.error("redis connection error", { err }));
        return redis;
      },
    },
    {
      provide: REDIS_SUBSCRIBER,
      inject: [KernelConfigService, KERNEL_LOGGER],
      useFactory: (config: KernelConfigService, log: KernelLogger) =>
        createBusSubscriber(() => new Redis(config.get().redis.url), log),
    },
    {
      provide: KERNEL_BUS,
      inject: [REDIS, REDIS_SUBSCRIBER, KERNEL_LOGGER],
      useFactory: (redis: Redis, sub: BusSubscriber, log: KernelLogger) =>
        createBus(redis, sub, "kernel", log),
    },
    RedisLifecycle,
  ],
  exports: [REDIS, REDIS_SUBSCRIBER, KERNEL_BUS],
})
export class RedisModule {}
