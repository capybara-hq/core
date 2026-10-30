import { Global, Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import type { FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { KernelLogger } from "../../log.js";
import { KERNEL_LOGGER, REDIS } from "../tokens.js";
import { CredentialThrottler } from "./credential-throttler.js";
import { NAMED_THROTTLERS, throttlerKey } from "./named-throttlers.js";
import { RedisThrottlerStorage } from "./redis-throttler-storage.js";
import { KernelThrottlerGuard, selectedThrottlers } from "./throttler.guard.js";

/**
 * Two limiters share the named-throttler table and the Redis storage, with opposite failure modes:
 * - `@Throttled` (`KernelThrottlerGuard`): plain per-route limits, counted before the handler,
 *   FAIL-OPEN on Redis errors (octok's rule: a Redis blip must not 5xx every limited route).
 * - `CredentialThrottler`: called inside a handler for credential checks, all-or-nothing across
 *   keys, FAIL-CLOSED on Redis errors (an attacker must not get unlimited guesses by making Redis
 *   fail).
 *
 * Global: `@nestjs/throttler` over the Redis storage with the kernel's named throttlers, and the
 * guard behind `@Throttled(...)`. The storage is injectable as `ThrottlerStorage`;
 * `CredentialThrottler` casts it to `RedisThrottlerStorage` for its multi-key `reserve` /
 * `succeeded`.
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
          getTracker: (req) => t.getTracker(req as FastifyRequest),
          generateKey: (_ctx, tracker, name) => throttlerKey(name, tracker),
          skipIf: (ctx) => !selectedThrottlers(ctx).includes(t.name),
        })),
      }),
    }),
  ],
  providers: [KernelThrottlerGuard, CredentialThrottler],
  exports: [KernelThrottlerGuard, CredentialThrottler],
})
export class KernelThrottlerModule {}
