import { Global, Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import type { FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { KernelLogger } from "../../log.js";
import { KERNEL_LOGGER, REDIS } from "../tokens.js";
import { NAMED_THROTTLERS, throttlerKey } from "./named-throttlers.js";
import { RedisThrottlerStorage } from "./redis-throttler-storage.js";
import { KernelThrottlerGuard, selectedThrottlers } from "./throttler.guard.js";

/**
 * Global: `@nestjs/throttler` over the Redis storage with the kernel's named throttlers, and the
 * guard behind `@Throttled(...)`. The storage is injectable as `ThrottlerStorage` (cast to
 * `RedisThrottlerStorage` for `reset` / `refund` on success paths).
 */
@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [REDIS, KERNEL_LOGGER],
      useFactory: (redis: Redis, log: KernelLogger) => ({
        storage: new RedisThrottlerStorage(redis, log),
        setHeaders: false,
        throttlers: NAMED_THROTTLERS.map((t) => ({
          name: t.name,
          limit: t.limit,
          ttl: t.ttl,
          getTracker: (req, ctx) => t.getTracker(req as FastifyRequest, ctx),
          generateKey: (_ctx, tracker, name) => throttlerKey(name, tracker),
          skipIf: (ctx) => !selectedThrottlers(ctx).includes(t.name),
        })),
      }),
    }),
  ],
  providers: [KernelThrottlerGuard],
  exports: [KernelThrottlerGuard],
})
export class KernelThrottlerModule {}
